/**
 * MosaicPrint Service Worker
 * Caches mosaic tile images (picsum.photos, images.unsplash.com) using a
 * Cache-First strategy with a 7-day TTL.
 */

const CACHE_NAME = "mosaicprint-tiles-v1";
const TILE_ORIGINS = [
  "picsum.photos",
  "fastly.picsum.photos",
  "images.unsplash.com",
];
const MAX_CACHE_SIZE = 1500; // max entries in the cache
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isTile = TILE_ORIGINS.some((o) => url.hostname.includes(o));
  if (!isTile) return; // Let non-tile requests pass through normally

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Check cache first
      const cached = await cache.match(event.request);
      if (cached) {
        // Check TTL via Date header
        const dateHeader = cached.headers.get("sw-cached-at");
        if (dateHeader) {
          const age = Date.now() - parseInt(dateHeader, 10);
          if (age < CACHE_TTL_MS) return cached;
        } else {
          return cached; // No timestamp → assume fresh
        }
      }

      // Fetch from network
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          // Clone and add cache timestamp header
          const headers = new Headers(response.headers);
          headers.set("sw-cached-at", String(Date.now()));
          const body = await response.arrayBuffer();
          const cachedResponse = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
          cache.put(event.request, cachedResponse.clone());
          // Trim cache size asynchronously
          trimCache(cache).catch(() => {});
          return cachedResponse;
        }
        return response;
      } catch {
        // Network failed – return cached version even if stale
        if (cached) return cached;
        return new Response("", { status: 503 });
      }
    }),
  );
});

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE_SIZE) {
    const toDelete = keys.slice(0, keys.length - MAX_CACHE_SIZE);
    await Promise.all(toDelete.map((k) => cache.delete(k)));
  }
}
