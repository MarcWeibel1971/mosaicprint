/**
 * image-cache.ts
 * Three-layer image caching system for the mosaic tile engine:
 *   1. In-Memory cache  – instant within the same session
 *   2. IndexedDB cache  – persists across page reloads (blobs, ~500 MB budget)
 *   3. HTTP cache       – handled by the Service Worker (sw.ts)
 */

// ── Layer 1: In-Memory cache ──────────────────────────────────────────────────
const memoryCache = new Map<string, HTMLImageElement>();

export function getMemoryCached(url: string): HTMLImageElement | undefined {
  return memoryCache.get(url);
}

export function setMemoryCached(url: string, img: HTMLImageElement): void {
  memoryCache.set(url, img);
}

export function getMemoryCacheSize(): number {
  return memoryCache.size;
}

export function clearMemoryCache(): void {
  memoryCache.clear();
}

// ── Layer 2: IndexedDB cache ──────────────────────────────────────────────────
const DB_NAME = "mosaicprint-image-cache";
const DB_VERSION = 1;
const STORE_NAME = "images";
const MAX_CACHE_ENTRIES = 2000;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  url: string;
  blob: Blob;
  timestamp: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "url" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function getFromIDB(url: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(url);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        if (!entry) { resolve(null); return; }
        // Expire old entries
        if (Date.now() - entry.timestamp > MAX_CACHE_AGE_MS) { resolve(null); return; }
        resolve(entry.blob);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setInIDB(url: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ url, blob, timestamp: Date.now() } as CacheEntry);
    // Evict oldest entries if over limit (fire-and-forget)
    evictOldEntries(db).catch(() => {});
  } catch {
    // Ignore write errors (e.g., storage quota exceeded)
  }
}

async function evictOldEntries(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count <= MAX_CACHE_ENTRIES) { resolve(); return; }
      // Delete oldest entries
      const toDelete = count - MAX_CACHE_ENTRIES;
      const idx = store.index("timestamp");
      const cursorReq = idx.openCursor();
      let deleted = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || deleted >= toDelete) { resolve(); return; }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
  });
}

export async function getIDBCacheSize(): Promise<number> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

export async function clearIDBCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
  } catch {
    // ignore
  }
}

// ── Combined loader ───────────────────────────────────────────────────────────
/**
 * Load an image with three-layer caching:
 * 1. Check in-memory cache (instant)
 * 2. Check IndexedDB cache (fast, persisted)
 * 3. Fetch from network and store in both caches
 */
export async function loadImageCached(
  url: string,
  timeoutMs = 10000,
): Promise<HTMLImageElement | null> {
  // Layer 1: memory
  const mem = getMemoryCached(url);
  if (mem) return mem;

  // Layer 2: IndexedDB
  const blob = await getFromIDB(url);
  if (blob) {
    const objectUrl = URL.createObjectURL(blob);
    const img = await loadImageFromSrc(objectUrl, timeoutMs);
    URL.revokeObjectURL(objectUrl);
    if (img) {
      // Re-tag with original URL for reference
      img.dataset.originalSrc = url;
      setMemoryCached(url, img);
      return img;
    }
  }

  // Layer 3: Network
  const img = await loadImageFromSrc(url, timeoutMs);
  if (img) {
    // Tag with original URL so Hi-Res overlay can reconstruct the high-res version
    img.dataset.originalSrc = url;
    setMemoryCached(url, img);
    // Store in IndexedDB asynchronously (fire-and-forget)
    fetchAndStoreBlob(url).catch(() => {});
    return img;
  }

  return null;
}

/**
 * Route external image URLs through the server proxy to avoid CORS issues.
 * Only applies to known external domains (picsum, unsplash).
 */
function toProxiedUrl(src: string): string {
  try {
    const url = new URL(src);
    const external = ["picsum.photos", "fastly.picsum.photos", "images.unsplash.com"];
    if (external.some(h => url.hostname.endsWith(h))) {
      // Build absolute proxy URL using window.location.origin so it works
      // regardless of the app's base path (e.g. /)
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      return `${origin}/api/proxy/portrait?url=${encodeURIComponent(src)}`;
    }
  } catch { /* not a valid URL, use as-is */ }
  return src;
}

function loadImageFromSrc(src: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  const proxied = toProxiedUrl(src);
  return new Promise((resolve) => {
    const img = new Image();
    // Only set crossOrigin for proxied URLs (same-origin proxy)
    if (proxied !== src) {
      // proxied = same-origin, no crossOrigin needed
    } else {
      img.crossOrigin = "anonymous";
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => {
      clearTimeout(timer);
      // If proxied URL failed, try direct as fallback
      if (proxied !== src) {
        const fallback = new Image();
        fallback.crossOrigin = "anonymous";
        const t2 = setTimeout(() => resolve(null), timeoutMs);
        fallback.onload = () => { clearTimeout(t2); resolve(fallback); };
        fallback.onerror = () => { clearTimeout(t2); resolve(null); };
        fallback.src = src;
      } else {
        resolve(null);
      }
    };
    img.src = proxied;
  });
}

async function fetchAndStoreBlob(url: string): Promise<void> {
  try {
    const fetchUrl = toProxiedUrl(url);
    const resp = await fetch(fetchUrl, { cache: "force-cache" });
    if (!resp.ok) return;
    const blob = await resp.blob();
    await setInIDB(url, blob);
  } catch {
    // Ignore network errors
  }
}

// ── Warm-up helper ────────────────────────────────────────────────────────────
/**
 * Pre-warm the cache by loading a list of URLs in the background.
 * Useful to start loading while the user is still on the upload screen.
 */
export async function warmUpCache(
  urls: string[],
  concurrency = 8,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  let loaded = 0;
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      await loadImageCached(url, 8000);
      loaded++;
      onProgress?.(loaded, urls.length);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
}
