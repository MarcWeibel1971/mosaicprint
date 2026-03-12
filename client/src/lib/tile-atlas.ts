/**
 * Tile Atlas Loader
 *
 * Loads a single sprite-sheet JPEG from /api/tile-atlas and extracts
 * individual tile images as HTMLImageElement objects via OffscreenCanvas.
 *
 * This replaces thousands of individual /api/tile/:id requests with ONE
 * HTTP request, dramatically improving load time.
 *
 * Usage:
 *   const atlas = await loadTileAtlas('sunset', 64, 3000);
 *   if (atlas) {
 *     const tileImgMap = atlas.tileImgMap; // Map<tileId, HTMLImageElement>
 *   }
 */

export interface TileAtlasResult {
  tileImgMap: Map<number, HTMLImageElement>;
  atlasImage: HTMLImageElement;
  map: Record<number, [number, number]>; // tileId -> [col, row]
  tileSize: number;
  cols: number;
  rows: number;
  tileCount: number;
}

// In-memory cache: key = `${theme}|${tileSize}|${maxTiles}`
const atlasCache = new Map<string, TileAtlasResult>();

/**
 * Load the texture atlas from the server and extract individual tile images.
 * Returns null if the atlas is not available (server building it, retry later).
 */
export async function loadTileAtlas(
  theme: string,
  tileSize: number = 64,
  maxTiles: number = 5000,
  onProgress?: (pct: number) => void,
): Promise<TileAtlasResult | null> {
  const cacheKey = `${theme}|${tileSize}|${maxTiles}`;

  // Return cached result if available
  const cached = atlasCache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    if (theme) params.set('theme', theme);
    params.set('tileSize', tileSize.toString());
    params.set('maxTiles', maxTiles.toString());

    onProgress?.(5);

    // Fetch atlas JPEG + metadata headers
    const resp = await fetch(`/api/tile-atlas?${params}`, {
      cache: 'force-cache',
    });

    if (resp.status === 202) {
      // Atlas is being built on server, retry after a few seconds
      console.log('[atlas] Server is building atlas, retry later');
      return null;
    }

    if (!resp.ok) {
      console.warn('[atlas] Failed to load atlas:', resp.status);
      return null;
    }

    onProgress?.(30);

    // Parse metadata from headers
    const mapHeader = resp.headers.get('X-Atlas-Map');
    const cols = Number(resp.headers.get('X-Atlas-Cols') ?? 1);
    const atlasRows = Number(resp.headers.get('X-Atlas-Rows') ?? 1);
    const atlasTileSize = Number(resp.headers.get('X-Atlas-TileSize') ?? tileSize);

    if (!mapHeader) {
      console.warn('[atlas] Missing X-Atlas-Map header');
      return null;
    }

    const map: Record<number, [number, number]> = JSON.parse(mapHeader);

    onProgress?.(50);

    // Load atlas image
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);

    const atlasImage = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = objectUrl;
    });

    URL.revokeObjectURL(objectUrl);
    onProgress?.(70);

    // Extract individual tile images from atlas using OffscreenCanvas
    const tileImgMap = new Map<number, HTMLImageElement>();
    const tileIds = Object.keys(map).map(Number);

    // Use OffscreenCanvas for fast extraction (no DOM needed)
    const offscreen = document.createElement('canvas');
    offscreen.width = atlasTileSize;
    offscreen.height = atlasTileSize;
    const offCtx = offscreen.getContext('2d')!;

    let processed = 0;
    for (const tileId of tileIds) {
      const [col, row] = map[tileId];
      offCtx.clearRect(0, 0, atlasTileSize, atlasTileSize);
      offCtx.drawImage(
        atlasImage,
        col * atlasTileSize, row * atlasTileSize, atlasTileSize, atlasTileSize,
        0, 0, atlasTileSize, atlasTileSize,
      );

      // Convert to HTMLImageElement via data URL
      const dataUrl = offscreen.toDataURL('image/jpeg', 0.90);
      const tileImg = new Image(atlasTileSize, atlasTileSize);
      tileImg.src = dataUrl;
      tileImg.dataset.originalSrc = `/api/tile/${tileId}?size=64`;
      tileImgMap.set(tileId, tileImg);

      processed++;
      if (processed % 500 === 0) {
        const pct = 70 + Math.round((processed / tileIds.length) * 28);
        onProgress?.(Math.min(pct, 98));
        // Yield to browser
        await new Promise(r => setTimeout(r, 0));
      }
    }

    onProgress?.(100);

    const result: TileAtlasResult = {
      tileImgMap,
      atlasImage,
      map,
      tileSize: atlasTileSize,
      cols,
      rows: atlasRows,
      tileCount: tileIds.length,
    };

    atlasCache.set(cacheKey, result);
    console.log(`[atlas] Loaded: ${tileIds.length} tiles from sprite-sheet`);
    return result;
  } catch (e) {
    console.warn('[atlas] Error loading atlas:', e);
    return null;
  }
}

/** Clear the in-memory atlas cache (e.g., after new tiles are imported) */
export function clearAtlasCache() {
  atlasCache.clear();
}
