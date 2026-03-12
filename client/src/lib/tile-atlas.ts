/**
 * Tile Atlas Loader – Memory-Efficient Version
 *
 * Instead of pre-extracting all tiles as individual HTMLImageElement objects
 * (which crashes on mobile due to RAM usage), this version stores the atlas
 * image and map, and provides a drawTile() function for direct rendering.
 *
 * The tile position map is loaded from /api/tile-atlas-map (separate JSON
 * endpoint) because HTTP headers have an ~8KB limit which caused truncation.
 */

export interface TileAtlasResult {
  /** Draw a tile directly onto a canvas context – no pre-extraction needed */
  drawTile: (ctx: CanvasRenderingContext2D, tileId: number, dx: number, dy: number, dw: number, dh: number) => boolean;
  /** Get a tile as HTMLImageElement (lazy, cached per tile) */
  getTileImg: (tileId: number) => HTMLImageElement | null;
  /** Pre-extract only the needed tile IDs (small subset) */
  preExtract: (neededIds: Set<number>) => Promise<Map<number, HTMLImageElement>>;
  atlasImage: HTMLImageElement;
  map: Record<number, [number, number]>; // tileId -> [col, row]
  tileSize: number;
  cols: number;
  rows: number;
  tileCount: number;
  /** Compatibility: tileImgMap populated after preExtract */
  tileImgMap: Map<number, HTMLImageElement>;
}

// In-memory cache: key = `${theme}|${tileSize}|${maxTiles}`
const atlasCache = new Map<string, TileAtlasResult>();

/**
 * Load the texture atlas from the server.
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

    // Fetch atlas JPEG + map JSON in parallel
    const [atlasResp, mapResp] = await Promise.all([
      fetch(`/api/tile-atlas?${params}`, { cache: 'force-cache' }),
      fetch(`/api/tile-atlas-map?${params}`, { cache: 'force-cache' }),
    ]);

    if (atlasResp.status === 202 || mapResp.status === 202) {
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

    // Parse tile position map from separate JSON endpoint
    const map: Record<number, [number, number]> = await mapResp.json();

    if (!map || Object.keys(map).length === 0) {
      console.warn('[atlas] Empty tile map received');
      return null;
    }

    onProgress?.(50);

    // Load atlas image (one single image, no per-tile extraction)
    const blob = await atlasResp.blob();
    const objectUrl = URL.createObjectURL(blob);

    const atlasImage = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = objectUrl;
    });

    URL.revokeObjectURL(objectUrl);
    onProgress?.(80);

    const tileIds = Object.keys(map).map(Number);
    const tileImgMap = new Map<number, HTMLImageElement>();

    // Lazy per-tile cache (only extracted when needed)
    const lazyTileCache = new Map<number, HTMLImageElement>();
    const extractCanvas = document.createElement('canvas');
    extractCanvas.width = atlasTileSize;
    extractCanvas.height = atlasTileSize;
    const extractCtx = extractCanvas.getContext('2d')!;

    /** Draw tile directly onto target canvas – most memory-efficient path */
    const drawTile = (ctx: CanvasRenderingContext2D, tileId: number, dx: number, dy: number, dw: number, dh: number): boolean => {
      const pos = map[tileId];
      if (!pos) return false;
      const [col, row] = pos;
      ctx.drawImage(
        atlasImage,
        col * atlasTileSize, row * atlasTileSize, atlasTileSize, atlasTileSize,
        dx, dy, dw, dh,
      );
      return true;
    };

    /** Get tile as HTMLImageElement (lazy, cached) */
    const getTileImg = (tileId: number): HTMLImageElement | null => {
      const cached = lazyTileCache.get(tileId);
      if (cached) return cached;
      const pos = map[tileId];
      if (!pos) return null;
      const [col, row] = pos;
      extractCtx.clearRect(0, 0, atlasTileSize, atlasTileSize);
      extractCtx.drawImage(
        atlasImage,
        col * atlasTileSize, row * atlasTileSize, atlasTileSize, atlasTileSize,
        0, 0, atlasTileSize, atlasTileSize,
      );
      const dataUrl = extractCanvas.toDataURL('image/jpeg', 0.85);
      const img = new Image(atlasTileSize, atlasTileSize);
      img.src = dataUrl;
      img.dataset.originalSrc = `/api/tile/${tileId}?size=64`;
      lazyTileCache.set(tileId, img);
      return img;
    };

    /**
     * Pre-extract only a specific subset of tiles (e.g. the ones actually used
     * in the current mosaic assignment). Much less RAM than extracting all tiles.
     */
    const preExtract = async (neededIds: Set<number>): Promise<Map<number, HTMLImageElement>> => {
      const result = new Map<number, HTMLImageElement>();
      let i = 0;
      for (const tileId of neededIds) {
        const img = getTileImg(tileId);
        if (img) {
          result.set(tileId, img);
          tileImgMap.set(tileId, img); // also populate the compat map
        }
        i++;
        // Yield every 200 tiles to avoid blocking the main thread
        if (i % 200 === 0) await new Promise(r => setTimeout(r, 0));
      }
      return result;
    };

    onProgress?.(100);

    const result: TileAtlasResult = {
      drawTile,
      getTileImg,
      preExtract,
      atlasImage,
      map,
      tileSize: atlasTileSize,
      cols,
      rows: atlasRows,
      tileCount: tileIds.length,
      tileImgMap,
    };

    atlasCache.set(cacheKey, result);
    console.log(`[atlas] Loaded: ${tileIds.length} tiles (lazy extraction, no pre-decode RAM spike)`);
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
