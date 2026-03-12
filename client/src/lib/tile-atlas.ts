/**
 * Tile Atlas Loader
 *
 * Loads a single sprite-sheet JPEG from /api/tile-atlas and extracts
 * individual tile images as HTMLImageElement objects via Canvas.
 *
 * The tile position map is loaded separately from /api/tile-atlas-map
 * (JSON endpoint) because the map can be 100KB+ for 3000+ tiles and
 * HTTP headers have a ~8KB limit which caused the map to be truncated.
 *
 * This replaces thousands of individual /api/tile/:id requests with TWO
 * HTTP requests (image + map), dramatically improving load time.
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

    // Step 1: Fetch atlas JPEG (triggers build if not cached on server)
    const [atlasResp, mapResp] = await Promise.all([
      fetch(`/api/tile-atlas?${params}`, { cache: 'force-cache' }),
      fetch(`/api/tile-atlas-map?${params}`, { cache: 'force-cache' }),
    ]);

    if (atlasResp.status === 202 || mapResp.status === 202) {
      // Atlas is being built on server, retry later
      console.log('[atlas] Server is building atlas, retry later');
      return null;
    }

    if (!atlasResp.ok) {
      console.warn('[atlas] Failed to load atlas image:', atlasResp.status);
      return null;
    }
    if (!mapResp.ok) {
      console.warn('[atlas] Failed to load atlas map:', mapResp.status);
      return null;
    }

    onProgress?.(30);

    // Parse grid dimensions from atlas response headers
    const cols = Number(atlasResp.headers.get('X-Atlas-Cols') ?? 1);
    const atlasRows = Number(atlasResp.headers.get('X-Atlas-Rows') ?? 1);
    const atlasTileSize = Number(atlasResp.headers.get('X-Atlas-TileSize') ?? tileSize);

    // Parse tile position map from separate JSON endpoint (no header size limit)
    const map: Record<number, [number, number]> = await mapResp.json();

    if (!map || Object.keys(map).length === 0) {
      console.warn('[atlas] Empty tile map received');
      return null;
    }

    onProgress?.(50);

    // Load atlas image
    const blob = await atlasResp.blob();
    const objectUrl = URL.createObjectURL(blob);

    const atlasImage = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = objectUrl;
    });

    URL.revokeObjectURL(objectUrl);
    onProgress?.(70);

    // Extract individual tile images from atlas using Canvas
    const tileImgMap = new Map<number, HTMLImageElement>();
    const tileIds = Object.keys(map).map(Number);

    // Use a single canvas for fast extraction (reuse across tiles)
    const offscreen = document.createElement('canvas');
    offscreen.width = atlasTileSize;
    offscreen.height = atlasTileSize;
    const offCtx = offscreen.getContext('2d')!;

    let processed = 0;
    for (const tileId of tileIds) {
      const pos = map[tileId];
      if (!pos) continue;
      const [col, row] = pos;
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
    console.log(`[atlas] Loaded: ${tileIds.length} tiles from sprite-sheet (map via separate endpoint)`);
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
