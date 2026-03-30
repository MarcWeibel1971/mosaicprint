// Load dotenv for local development only
// Railway injects env vars directly into process.env
// Check multiple Railway-specific env vars to detect Railway environment
const isRailway = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_DEPLOYMENT_ID
);
if (!isRailway) {
  try {
    const { config } = await import("dotenv");
    config();
    console.log("[MosaicPrint] Loaded .env file (local dev mode)");
  } catch (e) {
    console.log("[MosaicPrint] No .env file found (OK in production)");
  }
}

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";
import * as db from "./db.js";
// Sharp for fast image processing (native libvips, 10-50x faster than Jimp)
import sharp from "sharp";
import { downloadAndUploadToR2, isR2Configured, uploadToR2 } from "./r2.js";

// ── Performance: Server-side in-memory caches ─────────────────────────────────
// 1. Tile-Lab-Index cache: avoids DB query on every request (26k rows)
//    Cache is invalidated after 5 minutes or when tiles are imported
interface IndexCache {
  buf: Buffer;
  tileCount: number;
  builtAt: number;
  theme: string;
}
const indexCacheMap = new Map<string, IndexCache>(); // key = theme ('' = all)
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateIndexCache() {
  indexCacheMap.clear();
  console.log('[cache] Tile-Lab-Index cache invalidated');
}

// 2. Tile proxy cache: avoids DB query + upstream fetch for repeated tile requests
//    LRU-style: evict oldest when over limit
const TILE_CACHE_MAX = 15000; // max tiles in memory (~300 MB at 20 KB/tile) – Pro plan has 32 GB
const tileCacheMap = new Map<string, { buf: Buffer; contentType: string; ts: number }>();

function evictTileCache() {
  if (tileCacheMap.size <= TILE_CACHE_MAX) return;
  // Evict oldest 500 entries
  const entries = [...tileCacheMap.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < 500; i++) tileCacheMap.delete(entries[i][0]);
}

/**
 * Shared tile loading: used by /api/tile/:id AND print render.
 * Loads a tile image at the requested size, with 3-tier caching:
 *   1. In-memory tileCacheMap (exact size, then resize from nearby sizes)
 *   2. URL resolution from tileUrlCache or DB
 *   3. Upstream fetch (R2 CDN, source_url)
 * Returns a JPEG buffer resized to exactly `size x size`, or null on failure.
 */
async function loadTileBuffer(id: number, size: number): Promise<Buffer | null> {
  const cacheKey = `${id}-${size}`;

  // 1. Check exact cache hit
  const cached = tileCacheMap.get(cacheKey);
  if (cached) return cached.buf;

  // 1b. Check nearby sizes and resize
  // IMPORTANT: Only use cached smaller sizes if the size difference is small (max 2x upscale).
  // Never upscale 128px → 400px (3x) as it produces blurry print output.
  // For print sizes (>= 256px), only allow downscaling or ≤ 2x upscale from nearby cache.
  const MAX_UPSCALE_RATIO = size >= 256 ? 1.5 : 3.0; // strict for print, lenient for thumbnails
  for (const trySize of [256, 400, 128, 64]) {
    if (trySize === size) continue;
    const nearby = tileCacheMap.get(`${id}-${trySize}`);
    if (nearby) {
      // Skip if upscaling too aggressively (would produce blurry output)
      const ratio = size / trySize;
      if (ratio > MAX_UPSCALE_RATIO) {
        console.log(`[tile] Skip cache resize ${trySize}→${size} (ratio ${ratio.toFixed(1)}x > ${MAX_UPSCALE_RATIO}x limit)`);
        continue;
      }
      try {
        const resized = await sharp(nearby.buf)
          .resize(size, size, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 92 })
          .toBuffer();
        if (resized) {
          tileCacheMap.set(cacheKey, { buf: resized, contentType: 'image/jpeg', ts: Date.now() });
          return resized;
        }
      } catch { /* fall through */ }
    }
  }

  // 2. Resolve URL from cache or DB
  let tileUrls = tileUrlCache.get(id);
  if (!tileUrls || (Date.now() - tileUrls.ts) > TILE_URL_CACHE_TTL_MS) {
    try {
      const pool = db.getPool();
      const result = await pool.query(
        "SELECT source_url, tile128_url, r2_url, tile256_url FROM mosaic_images WHERE id = $1",
        [id]
      );
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      const effectiveTile128 = row.r2_url || row.tile128_url || '';
      // For source_url: skip custom protocols (lhq://, etc.) that aren't fetchable URLs.
      // Fall back to tile256_url or r2_url for higher resolution.
      // If none available (LHQ tiles without r2_url), fall back to tile128_url so size>128 still works.
      const rawSource = row.source_url || '';
      const isValidHttpUrl = rawSource.startsWith('http://') || rawSource.startsWith('https://') || rawSource.startsWith('data:');
      const effectiveSource = isValidHttpUrl ? rawSource : (row.tile256_url || row.r2_url || row.tile128_url || rawSource);
      tileUrls = { tile128Url: effectiveTile128, sourceUrl: effectiveSource, ts: Date.now() };
      tileUrlCache.set(id, tileUrls);
    } catch { return null; }
  }

  // URL selection strategy:
  // - size <= 128: use R2/tile128 (fast CDN, already 128px)
  // - size > 128 (zoom/print): ALWAYS use source_url first for full resolution
  //   Never fall back to tile128 for large sizes (would cause 128→400 upscale = blurry)
  //   EXCEPTION: R2 tiles (tiles.mosaicprint.ch) are max 128px — return them at native
  //   size rather than upscaling, since upscaling produces blurry results.
  const isR2Tile = (tileUrls.tile128Url || '').includes('tiles.mosaicprint.ch') ||
                   (tileUrls.sourceUrl || '').includes('tiles.mosaicprint.ch');
  let url: string;
  if (size <= 128) {
    url = tileUrls.tile128Url || tileUrls.sourceUrl;
  } else if (isR2Tile) {
    // R2 tiles are 128px max — serve at native 128px, no upscaling
    url = tileUrls.tile128Url || tileUrls.sourceUrl;
  } else {
    url = tileUrls.sourceUrl || tileUrls.tile128Url;
  }
  if (!url) return null;
  // For R2 tiles requested at size > 128: serve at native 128px (no upscaling)
  const effectiveSize = (isR2Tile && size > 128) ? 128 : size;

  // 3. Handle data URLs
  if (url.startsWith('data:')) {
    try {
      const rawBuf = Buffer.from(url.split(',')[1], 'base64');
      const resized = await sharp(rawBuf)
        .resize(effectiveSize, effectiveSize, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 92 })
        .toBuffer();
      tileCacheMap.set(cacheKey, { buf: resized, contentType: 'image/jpeg', ts: Date.now() });
      evictTileCache();
      return resized;
    } catch { return null; }
  }

  // 4. Fetch from upstream (R2 CDN, Unsplash, Pexels, etc.)
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MosaicPrint/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const resized = await sharp(buf)
      .resize(effectiveSize, effectiveSize, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 92 })
      .toBuffer();
    // Cache with effectiveSize key so future requests at the same size hit cache
    const effectiveCacheKey = effectiveSize !== size ? `${id}-${effectiveSize}` : cacheKey;
    tileCacheMap.set(effectiveCacheKey, { buf: resized, contentType: 'image/jpeg', ts: Date.now() });
    if (effectiveSize !== size) tileCacheMap.set(cacheKey, { buf: resized, contentType: 'image/jpeg', ts: Date.now() });
    evictTileCache();
    return resized;
  } catch {
    return null;
  }
}

// 3. Tile URL cache: maps tile id → {tile128_url, source_url} to avoid DB per request
const tileUrlCache = new Map<number, { tile128Url: string; sourceUrl: string; ts: number }>();
const TILE_URL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TILE_URL_CACHE_MAX = 30000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const app = express();

// CORS: allow production domain, local dev, and Railway preview URLs
const ALLOWED_ORIGINS = [
  "https://www.mosaicprint.ch",
  "https://mosaicprint.ch",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Allow Railway preview URLs (*.up.railway.app)
    if (origin.endsWith(".up.railway.app") || origin.endsWith(".railway.app")) {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    // In development, allow all origins
    if (process.env.NODE_ENV !== "production") {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Auth endpoints: 10 requests per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Zu viele Anfragen. Bitte warte 15 Minuten." },
  skip: () => process.env.NODE_ENV !== "production",
});
// Import/AI endpoints: 20 requests per hour per IP
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Import-Limit erreicht. Bitte warte eine Stunde." },
  skip: () => process.env.NODE_ENV !== "production",
});


// Request logging middleware
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[REQ] ${req.method} ${req.path} from ${req.ip} origin=${req.headers.origin || '-'}`);
  }
  next();
});

// Graceful error handling to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED]', reason);
});

// ---- REST endpoints expected by Studio.tsx ----

// GET /api/tile-lab-index
// Returns ALL tile feature vectors as a compact binary Float32Array
// Format: [id, L, a, b, tl_a, tl_b, tr_a, tr_b, bl_a, bl_b, br_a, br_b, edge, brightness, isSkinFriendly] per tile = 15 floats = 60 bytes
// ~1.4 MB for 23,000 tiles - loaded once, used for fast multi-dimensional pre-filter
// This enables 2-stage matching: 15D k-NN (LAB+quadrant colors+edge+skin) over ALL tiles, then SSD on Top-80
// Quadrant a/b values encode color distribution (warm/cool, green/magenta) per quadrant
// edge = variance of L across quadrants (proxy for Sobel edge energy)
// brightness = avg_l normalized 0-1
// isSkinFriendly = 1.0 if tile is suitable for skin/portrait regions (low chroma, mid brightness)
app.get("/api/tile-lab-index", async (req, res) => {
  try {
    const pool = db.getPool();
    // Optional theme filter: filter by subject column
    const theme = (req.query.theme as string ?? '').toLowerCase().trim();
    // Check server-side cache first
    const cached = indexCacheMap.get(theme);
    if (cached && (Date.now() - cached.builtAt) < INDEX_CACHE_TTL_MS) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', cached.buf.length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Tile-Count', cached.tileCount.toString());
      res.setHeader('X-Floats-Per-Tile', '18');
      res.setHeader('X-Cache', 'HIT');
      return res.send(cached.buf);
    }
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space','bokeh_gradient','pure_sky','water_surface','sand_earth','fog_mist','autumn_carpet','snow_ice','calm_nature','calm_monochrome','skin_tone','texture','architecture'];
    const themeFilter = (theme && VALID_THEMES.includes(theme))
      ? `AND subject = $1`
      : ``;
    const queryParams = (theme && VALID_THEMES.includes(theme)) ? [theme] : [];
    // Also fetch quadrant data + is_skin_friendly + edge_energy + AI scores for richer feature vector
    const result = await pool.query(
      `SELECT id, avg_l, avg_a, avg_b,
              tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
              bl_l, bl_a, bl_b, br_l, br_a, br_b,
              COALESCE(is_skin_friendly, (SQRT(avg_a * avg_a + avg_b * avg_b) < 25 AND avg_l >= 35 AND avg_l <= 80)) as is_skin_friendly,
              COALESCE(tile_type, 'medium') as tile_type,
              edge_energy,
              blur_score,
              ai_is_calm,
              ai_suitability,
              ai_calm_score,
              ai_mosaic_score,
              ai_fill_uniformity
       FROM mosaic_images
       WHERE avg_l IS NOT NULL
         AND COALESCE(quality_status, 'pending') != 'rejected'
         AND COALESCE(ai_suitability, 'good') != 'reject'
         AND (r2_url IS NOT NULL OR COALESCE(source_provider, '') != 'pixabay')
         ${themeFilter} ORDER BY id ASC`,
      queryParams
    );
    const rows = result.rows;
    // Pack as Float32Array: [id, L, a, b, tl_a, tl_b, tr_a, tr_b, bl_a, bl_b, br_a, br_b, edge, brightness, isSkinFriendly, tileComplexity, mosaicScore, blurNorm] = 18 floats
    // Quadrant a/b values encode color distribution per quadrant (TL, TR, BL, BR)
    // edge: echter Sobel-Kantenwert aus DB (edge_energy, 64x64 Sobel), Fallback: L-Varianz-Proxy
    // brightness: avg_l / 100
    // isSkinFriendly: 1.0 = skin-friendly tile, 0.0 = not skin-friendly
    // tileComplexity: 0.0=calm, 0.5=medium, 1.0=busy (from tile_type column)
    // mosaicScore: ai_mosaic_score / 100 (0.0-1.0, Tiebreaker: höher = besser)
    // blurNorm: blur_score / 80 clamped 0-1 (0=blurry/unscharf, 1=sharp/scharf)
    const FLOATS_PER_TILE = 18;
    const buf = Buffer.allocUnsafe(rows.length * FLOATS_PER_TILE * 4);
    let offset = 0;
    for (const row of rows) {
      const L = Number(row.avg_l);
      const a = Number(row.avg_a);
      const b = Number(row.avg_b);
      // Quadrant LAB values (fallback to global if null)
      const tlL = Number(row.tl_l ?? L), tlA = Number(row.tl_a ?? a), tlB = Number(row.tl_b ?? b);
      const trL = Number(row.tr_l ?? L), trA = Number(row.tr_a ?? a), trB = Number(row.tr_b ?? b);
      const blL = Number(row.bl_l ?? L), blA = Number(row.bl_a ?? a), blB = Number(row.bl_b ?? b);
      const brL = Number(row.br_l ?? L), brA = Number(row.br_a ?? a), brB = Number(row.br_b ?? b);
      // Edge-Energie: echter Sobel-Wert aus DB (berechnet in computeLabFull beim Import)
      // Fallback: L-Varianz-Proxy für ältere Tiles ohne edge_energy-Wert
      let edgeProxy: number;
      if (row.edge_energy != null) {
        edgeProxy = Math.min(1, Number(row.edge_energy)); // echter Sobel-Wert
      } else {
        // Legacy-Fallback: L-Varianz-Proxy (für Tiles vor dem edge_energy-Backfill)
        const quadMeanL = (tlL + trL + blL + brL) / 4;
        const quadVarL = ((tlL-quadMeanL)**2 + (trL-quadMeanL)**2 + (blL-quadMeanL)**2 + (brL-quadMeanL)**2) / 4;
        edgeProxy = Math.min(1, Math.sqrt(quadVarL) / 30);
      }
      const brightness = L / 100;
      const isSkinFriendly = row.is_skin_friendly ? 1.0 : 0.0;
      buf.writeFloatLE(Number(row.id), offset);   offset += 4;  // [0]  id
      buf.writeFloatLE(L, offset);                offset += 4;  // [1]  avg L
      buf.writeFloatLE(a, offset);                offset += 4;  // [2]  avg a
      buf.writeFloatLE(b, offset);                offset += 4;  // [3]  avg b
      buf.writeFloatLE(tlA, offset);              offset += 4;  // [4]  TL a
      buf.writeFloatLE(tlB, offset);              offset += 4;  // [5]  TL b
      buf.writeFloatLE(trA, offset);              offset += 4;  // [6]  TR a
      buf.writeFloatLE(trB, offset);              offset += 4;  // [7]  TR b
      buf.writeFloatLE(blA, offset);              offset += 4;  // [8]  BL a
      buf.writeFloatLE(blB, offset);              offset += 4;  // [9]  BL b
      buf.writeFloatLE(brA, offset);              offset += 4;  // [10] BR a
      buf.writeFloatLE(brB, offset);              offset += 4;  // [11] BR b
      buf.writeFloatLE(edgeProxy, offset);        offset += 4;  // [12] edge
      buf.writeFloatLE(brightness, offset);       offset += 4;  // [13] brightness
      // tileComplexity: Priorität: ai_calm_score (0-100, v7) > ai_is_calm (bool, v6) > tile_type (LAB)
      // ai_calm_score=100 → 0.0 (völlig ruhig), ai_calm_score=0 → 1.0 (chaotisch)

      let tileComplexity: number;
      if (row.ai_calm_score !== null && row.ai_calm_score !== undefined) {
        tileComplexity = 1.0 - (Number(row.ai_calm_score) / 100); // 0.0=calm, 1.0=busy
      } else if (row.ai_is_calm !== null && row.ai_is_calm !== undefined) {
        tileComplexity = row.ai_is_calm ? 0.0 : 0.7; // KI-basiert: calm oder leicht busy

      } else {
        const tileTypeDb = row.tile_type as string ?? 'medium';
        tileComplexity = tileTypeDb === 'calm' ? 0.0 : tileTypeDb === 'busy' ? 1.0 : 0.5;
      }
      buf.writeFloatLE(isSkinFriendly, offset);   offset += 4;  // [14] isSkinFriendly
      buf.writeFloatLE(tileComplexity, offset);   offset += 4;  // [15] tileComplexity (0=calm, 0.5=medium, 1=busy)
      // [16] mosaicScore: ai_mosaic_score / 100 (Tiebreaker: höher = besser)
      // Fallback: 0.68 (Durchschnitt des Pools) für Tiles ohne AI-Score
      const mosaicScore = row.ai_mosaic_score != null ? Number(row.ai_mosaic_score) / 100 : 0.68;
      buf.writeFloatLE(mosaicScore, offset);      offset += 4;  // [16] mosaicScore (0=poor, 1=excellent)
      // [17] blurNorm: blur_score normalized 0-1 (0=blurry, 1=sharp)
      // blur_score is Laplacian variance: 0=blurry, ~80=sharp. Normalize to 0-1.
      // Fallback: 0.625 (≈50/80, typical mid-quality tile) for tiles not yet reindexed
      const blurNorm = row.blur_score != null ? Math.min(1, Number(row.blur_score) / 80) : 0.625;
      buf.writeFloatLE(blurNorm, offset);          offset += 4;  // [17] blurNorm (0=blurry, 1=sharp)
    }
    // Cache the result
    indexCacheMap.set(theme, { buf, tileCount: rows.length, builtAt: Date.now(), theme });
    console.log(`[cache] Tile-Lab-Index built: ${rows.length} tiles, ${(buf.length/1024).toFixed(0)} KB`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour browser cache
    res.setHeader('X-Tile-Count', rows.length.toString());
    res.setHeader('X-Floats-Per-Tile', FLOATS_PER_TILE.toString());
    res.setHeader('X-Cache', 'MISS');
    res.send(buf);
  } catch (e) {
    console.error('[tile-lab-index] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/trpc/getTilePool?limit=2000&labOnly=true
// Legacy endpoint kept for backward compatibility
// For new code, use /api/tile-lab-index instead
app.get("/api/trpc/getTilePool", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 5000), 50000);
    const labOnly = req.query.labOnly === "true";
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT id, avg_l as "avgL", avg_a as "avgA", avg_b as "avgB"
       FROM mosaic_images WHERE avg_l IS NOT NULL ORDER BY id ASC LIMIT $1`,
      [limit]
    );
    const rows = result.rows;
    if (labOnly) {
      res.json(rows.map((t: any) => ({ id: t.id, l: Number(t.avgL), a: Number(t.avgA), b: Number(t.avgB) })));
    } else {
      res.json(rows);
    }
  } catch (e) {
    console.error('[getTilePool] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tile/:id?size=64  – proxy tile image with in-memory caching
app.get("/api/tile/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const size = Number(req.query.size ?? 128);
    const buf = await loadTileBuffer(id, size);
    if (!buf) return res.status(404).json({ error: "Not found" });
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tile-urls?ids=1,2,3  – returns direct tile128_url for hi-res rendering
// Client can use these URLs directly (no proxy needed) for faster hi-res zoom
// With ?hires=1: returns source_url (original high-res) for print quality
app.get("/api/tile-urls", async (req, res) => {
  try {
    const idsParam = req.query.ids as string;
    const wantHiRes = req.query.hires === '1';
    if (!idsParam) return res.status(400).json({ error: "Missing ids" });
    const ids = idsParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
    if (ids.length === 0 || ids.length > 2000) return res.status(400).json({ error: "Invalid ids" });
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT id, tile128_url, source_url, r2_url FROM mosaic_images WHERE id = ANY($1)`,
      [ids]
    );
    const isHttp = (url: string | null) => !!url && (url.startsWith('https://') || url.startsWith('http://'));
    const urlMap: Record<number, string> = {};
    for (const row of result.rows) {
      if (wantHiRes) {
        // For hi-res zoom: prefer source_url (full ~940px from Pexels/Unsplash)
        // SKIP non-HTTP protocols (lhq://, etc.) – browser can't load them.
        // Fall back to r2_url (128px but loadable) or tile128_url.
        // If nothing is loadable, omit entry → client uses /api/tile/:id proxy.
        if (isHttp(row.source_url)) {
          urlMap[row.id] = row.source_url;
        } else if (isHttp(row.r2_url)) {
          urlMap[row.id] = row.r2_url;
        } else if (isHttp(row.tile128_url)) {
          urlMap[row.id] = row.tile128_url;
        }
        // else: omit – client falls back to /api/tile/:id which handles lhq:// via server-side proxy
      } else if (row.r2_url) {
        // For screen preview: R2 URL is permanent and fast (128px thumbnail)
        urlMap[row.id] = row.r2_url;
      } else {
        // Fallback: tile128_url or source_url
        urlMap[row.id] = row.tile128_url || row.source_url || '';
      }
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.json(urlMap);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tile-url-index  – returns compact JSON map of tileId → R2/CDN URL
// Used by Studio.tsx to load tiles directly from R2/CDN (tiles.mosaicprint.ch) without Railway proxy
// Format: { urls: { "123": "https://tiles.mosaicprint.ch/tiles/123.jpg", ... }, r2BaseUrl: "...", count: N, r2Count: N, proxyCount: N }
// Tiles without r2_url fall back to tile128_url (Railway proxy) for backward compatibility
// Cache: 5 minutes server-side, 1 hour browser-side
const tileUrlIndexCache = new Map<string, { json: string; builtAt: number }>();
const TILE_URL_INDEX_TTL_MS = 5 * 60 * 1000; // 5 minutes
app.get("/api/tile-url-index", async (req, res) => {
  try {
    const theme = (req.query.theme as string ?? '').toLowerCase().trim();
    const cacheKey = theme || '__all__';
    const cached = tileUrlIndexCache.get(cacheKey);
    if (cached && (Date.now() - cached.builtAt) < TILE_URL_INDEX_TTL_MS) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Cache', 'HIT');
      return res.send(cached.json);
    }
    const pool = db.getPool();
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space','bokeh_gradient','pure_sky','water_surface','sand_earth','fog_mist','autumn_carpet','snow_ice','calm_nature','calm_monochrome','skin_tone','texture','architecture'];
    const themeFilter = (theme && VALID_THEMES.includes(theme)) ? `AND subject = $1` : ``;
    const queryParams = (theme && VALID_THEMES.includes(theme)) ? [theme] : [];
    const result = await pool.query(
      `SELECT id, tile128_url, r2_url FROM mosaic_images
       WHERE avg_l IS NOT NULL
         AND (r2_url IS NOT NULL OR COALESCE(source_provider, '') != 'pixabay')
         ${themeFilter} ORDER BY id ASC`,
      queryParams
    );
    const rows = result.rows;
    // Build compact URL map: prefer r2_url (CDN), fallback to tile128_url (proxy)
    const r2BaseUrl = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '');
    const urls: Record<string, string> = {};
    let r2Count = 0;
    let proxyCount = 0;
    for (const row of rows) {
      if (row.r2_url) {
        urls[String(row.id)] = row.r2_url;
        r2Count++;
      } else if (row.tile128_url) {
        urls[String(row.id)] = row.tile128_url;
        proxyCount++;
      }
      // Skip tiles with no URL at all
    }
    const payload = { urls, r2BaseUrl, count: rows.length, r2Count, proxyCount, builtAt: Date.now() };
    const json = JSON.stringify(payload);
    tileUrlIndexCache.set(cacheKey, { json, builtAt: Date.now() });
    console.log(`[tile-url-index] Built: ${rows.length} tiles, ${r2Count} R2, ${proxyCount} proxy, ${(json.length/1024).toFixed(0)} KB`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-R2-Count', r2Count.toString());
    res.setHeader('X-Proxy-Count', proxyCount.toString());
    res.send(json);
  } catch (e) {
    console.error('[tile-url-index] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/admin/import-report/:source  – download last import report as JSON
app.get('/api/admin/import-report/:source', (req, res) => {
  try {
    const { source } = req.params;
    const isAnalysis = req.query.analysis === 'true';
    // Access the smartImportJobs map via the router module (dynamic import)
    // The report is stored in-memory on the router module
    // We expose it via the tRPC getLastImportReport procedure instead
    // This endpoint just redirects to the tRPC JSON response for download
    res.status(200).json({ message: 'Use tRPC getLastImportReport procedure', source, isAnalysis });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Image proxy endpoint - proxies external images to avoid CORS issues
// Used by image-cache.ts for picsum, unsplash, cloudfront, and pexels images
app.get("/api/proxy/portrait", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  try {
    const parsed = new URL(url);
    const allowedDomains = [
      "picsum.photos", "fastly.picsum.photos",
      "images.unsplash.com",
      "cloudfront.net",
      "images.pexels.com"
    ];
    const isAllowed = allowedDomains.some(d => parsed.hostname.endsWith(d));
    if (!isAllowed) return res.status(403).json({ error: "Domain not allowed" });
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: "Upstream error" });
    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Debug: Test color filter SQL directly
app.get("/api/debug-color-filter", async (req, res) => {
  const color = (req.query.color as string) ?? 'cyan';
  const pool = db.getPool();
  try {
    let condition = '1=1';
    if (color === 'cyan') condition = "avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a < -10 AND avg_b < -5";
    else if (color === 'grau') condition = "ABS(avg_a) < 8 AND ABS(avg_b) < 8 AND avg_l >= 25 AND avg_l <= 80";
    else if (color === 'rot') condition = "avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 20";
    const r = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images WHERE ${condition}`);
    const sample = await pool.query(`SELECT id, avg_l::float, avg_a::float, avg_b::float FROM mosaic_images WHERE ${condition} LIMIT 3`);
    res.json({ color, condition, count: Number(r.rows[0]?.cnt), sample: sample.rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Debug endpoint - shows which env vars are set (not their values)
// Useful for diagnosing Railway environment variable issues
app.get("/api/debug-env", (_req, res) => {
  const relevantKeys = [
    'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID',
    'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
    'PEXELS_API_KEY', 'UNSPLASH_ACCESS_KEY', 'STRIPE_SECRET_KEY',
    'PORT', 'NODE_ENV'
  ];
  const envStatus: Record<string, string> = {};
  for (const key of relevantKeys) {
    const val = process.env[key];
    if (val) {
      // Show first 8 chars for debugging without exposing full secret
      envStatus[key] = `SET (${val.substring(0, 8)}...)`;
    } else {
      envStatus[key] = 'NOT SET';
    }
  }
  // Also check for any DATABASE-related vars
  const allDbVars = Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('PG'));
  res.json({ 
    envStatus,
    allDbVars,
    isRailway,
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    totalEnvVars: Object.keys(process.env).length
  });
});

// Health check - always responds, even if DB is not ready
app.get("/api/health", async (_req, res) => {
  try {
    const count = await db.getMosaicImageCount();
    res.json({ ok: true, tiles: count, db: "connected" });
  } catch (e) {
    // Still return 200 so Railway healthcheck passes even if DB is temporarily unavailable
    res.json({ ok: true, tiles: 0, db: "unavailable", error: String(e) });
  }
});

// ── Admin: Deduplicate tiles by source_url ──────────────────────────────────
// POST /api/admin/dedup-tiles  →  removes duplicate rows, keeps lowest id per source_url
// POST /api/admin/add-unique-constraint  →  adds UNIQUE constraint on source_url
app.post("/api/admin/dedup-tiles", async (_req, res) => {
  try {
    const pool = db.getPool();
    // Count before
    const beforeRes = await pool.query(`SELECT COUNT(*) as total FROM mosaic_images`);
    const before = beforeRes.rows[0];

    // Step 1: Delete exact source_url duplicates (keep lowest id)
    const step1 = await pool.query(`
      DELETE FROM mosaic_images
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM mosaic_images
        GROUP BY source_url
      )
    `);

    // Step 2: Delete Pexels photo-ID duplicates
    // Pexels URLs contain the photo ID: /photos/1234567/pexels-photo-1234567.jpeg
    // Extract the numeric photo ID and deduplicate on it
    const step2 = await pool.query(`
      DELETE FROM mosaic_images
      WHERE source_url LIKE '%pexels%'
        AND id NOT IN (
          SELECT MIN(id)
          FROM mosaic_images
          WHERE source_url LIKE '%pexels%'
          GROUP BY
            CASE
              WHEN source_url ~ '/photos/([0-9]+)/' THEN
                (regexp_match(source_url, '/photos/([0-9]+)/'))[1]
              ELSE source_url
            END
        )
    `);

    // Step 3: Delete Unsplash photo-ID duplicates
    // Unsplash URLs: /photos/AbCdEfGh or ?photo=AbCdEfGh
    const step3 = await pool.query(`
      DELETE FROM mosaic_images
      WHERE source_url LIKE '%unsplash%'
        AND id NOT IN (
          SELECT MIN(id)
          FROM mosaic_images
          WHERE source_url LIKE '%unsplash%'
          GROUP BY
            CASE
              WHEN source_url ~ 'photo-([A-Za-z0-9_-]+)-' THEN
                (regexp_match(source_url, 'photo-([A-Za-z0-9_-]+)-'))[1]
              WHEN source_url ~ '/photos/([A-Za-z0-9_-]+)' THEN
                (regexp_match(source_url, '/photos/([A-Za-z0-9_-]+)'))[1]
              ELSE source_url
            END
        )
    `);

    const deleted = (step1.rowCount ?? 0) + (step2.rowCount ?? 0) + (step3.rowCount ?? 0);

    // Count after
    const afterRes = await pool.query(`SELECT COUNT(*) as total FROM mosaic_images`);
    const after = afterRes.rows[0];

    res.json({
      ok: true,
      before: { total: parseInt(before.total) },
      deleted,
      after: { total: parseInt(after.total) },
      message: `${deleted} Duplikate entfernt. DB hat jetzt ${after.total} eindeutige Bilder.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/admin/add-unique-constraint", async (_req, res) => {
  try {
    const pool = db.getPool();
    // Add unique constraint if not exists
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'mosaic_images_source_url_unique'
        ) THEN
          ALTER TABLE mosaic_images ADD CONSTRAINT mosaic_images_source_url_unique UNIQUE (source_url);
        END IF;
      END $$;
    `);
    res.json({ ok: true, message: "UNIQUE constraint auf mosaic_images.source_url gesetzt (oder war bereits vorhanden)." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /api/admin/cleanup-gray  →  removes excess gray/neutral tiles to reduce gray dominance
// Keeps the most diverse gray tiles (spread across brightness levels), removes redundant ones
// from overrepresented LAB cubes. Target: reduce gray/neutral to ~30% of pool.
app.post("/api/admin/cleanup-gray", async (req, res) => {
  try {
    const pool = db.getPool();
    const targetPct = Number(req.body?.targetPct) || 0.35; // default: keep 35% gray

    // Count total and gray tiles
    const totalRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images`);
    const total = Number(totalRes.rows[0].cnt);
    const grayRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images
      WHERE ABS(avg_a) < 8 AND ABS(avg_b) < 8
    `);
    const grayCount = Number(grayRes.rows[0].cnt);
    const grayPct = grayCount / Math.max(1, total);

    if (grayPct <= targetPct) {
      return res.json({
        ok: true, deleted: 0, before: grayCount, after: grayCount,
        message: `Grau-Anteil ist bereits bei ${Math.round(grayPct * 100)}% (Ziel: ${Math.round(targetPct * 100)}%). Keine Bereinigung nötig.`,
      });
    }

    // Calculate how many gray tiles to remove
    const targetGrayCount = Math.round(total * targetPct);
    const toRemove = grayCount - targetGrayCount;

    // Remove gray tiles from the most overrepresented LAB regions first.
    // We quantize LAB values into cubes (L/10, a/10, b/10) and delete
    // tiles from cubes that have the most tiles, keeping at least 5 per cube.
    const deleteResult = await pool.query(`
      WITH gray_tiles AS (
        SELECT id, avg_l, avg_a, avg_b,
          FLOOR(avg_l / 10) as l_bucket,
          FLOOR(avg_a / 10) as a_bucket,
          FLOOR(avg_b / 10) as b_bucket
        FROM mosaic_images
        WHERE ABS(avg_a) < 8 AND ABS(avg_b) < 8
      ),
      bucket_ranks AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY l_bucket, a_bucket, b_bucket
            ORDER BY id DESC
          ) as rn,
          COUNT(*) OVER (
            PARTITION BY l_bucket, a_bucket, b_bucket
          ) as bucket_size
        FROM gray_tiles
      ),
      to_delete AS (
        SELECT id FROM bucket_ranks
        WHERE rn > 5 AND bucket_size > 5
        ORDER BY bucket_size DESC, rn DESC
        LIMIT $1
      )
      DELETE FROM mosaic_images WHERE id IN (SELECT id FROM to_delete)
    `, [toRemove]);

    const deleted = deleteResult.rowCount ?? 0;
    const afterRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images
      WHERE ABS(avg_a) < 8 AND ABS(avg_b) < 8
    `);
    const afterGray = Number(afterRes.rows[0].cnt);
    const afterTotalRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images`);
    const afterTotal = Number(afterTotalRes.rows[0].cnt);
    const afterPct = Math.round(afterGray / Math.max(1, afterTotal) * 100);

    res.json({
      ok: true,
      deleted,
      before: grayCount,
      after: afterGray,
      totalBefore: total,
      totalAfter: afterTotal,
      message: `${deleted.toLocaleString()} redundante Grau-Tiles entfernt. Grau-Anteil: ${Math.round(grayPct * 100)}% → ${afterPct}%.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /api/admin/remove-shutterstock  →  removes all Shutterstock watermarked images
app.post("/api/admin/remove-shutterstock", async (_req, res) => {
  try {
    const pool = db.getPool();
    const beforeRes = await pool.query(`SELECT COUNT(*) as total FROM mosaic_images`);
    const before = parseInt(beforeRes.rows[0].total);
    // Delete all images with shutterstock in source_url or tile128_url
    const result = await pool.query(`
      DELETE FROM mosaic_images
      WHERE LOWER(source_url) LIKE '%shutterstock%'
         OR LOWER(COALESCE(tile128_url, '')) LIKE '%shutterstock%'
    `);
    const deleted = result.rowCount ?? 0;
    const afterRes = await pool.query(`SELECT COUNT(*) as total FROM mosaic_images`);
    const after = parseInt(afterRes.rows[0].total);
    // Invalidate index cache since DB changed
    invalidateIndexCache();
    res.json({
      ok: true,
      before,
      deleted,
      after,
      message: `${deleted} Shutterstock-Bilder entfernt. DB hat jetzt ${after} Bilder.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /api/admin/delete-broken-pixabay  →  removes Pixabay tiles without R2 URL (hotlink-protected)
app.post("/api/admin/delete-broken-pixabay", async (_req, res) => {
  try {
    const pool = db.getPool();
    const beforeRes = await pool.query(`SELECT COUNT(*) as total FROM mosaic_images`);
    const before = parseInt(beforeRes.rows[0].total);
    // Count broken Pixabay tiles first
    const countRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images
      WHERE COALESCE(source_provider, '') = 'pixabay'
        AND r2_url IS NULL
    `);
    const toDelete = parseInt(countRes.rows[0].cnt);
    // Delete all Pixabay tiles without R2 URL (expired hotlink-protected URLs)
    const result = await pool.query(`
      DELETE FROM mosaic_images
      WHERE COALESCE(source_provider, '') = 'pixabay'
        AND r2_url IS NULL
    `);
    const deleted = result.rowCount ?? 0;
    const afterRes = await pool.query(`SELECT COUNT(*) as total FROM mosaic_images`);
    const after = parseInt(afterRes.rows[0].total);
    // Invalidate index cache since DB changed
    invalidateIndexCache();
    res.json({
      ok: true,
      before,
      toDelete,
      deleted,
      after,
      message: `${deleted} kaputte Pixabay-Tiles gelöscht. DB hat jetzt ${after} Bilder.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /api/admin/migrate-r2-urls  →  updates all r2_url from old pub-*.r2.dev to new custom domain
// Run once after setting R2_PUBLIC_URL to tiles.mosaicprint.ch
app.post("/api/admin/migrate-r2-urls", async (_req, res) => {
  try {
    const pool = db.getPool();
    const newBase = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '');
    if (!newBase || newBase.includes('r2.dev')) {
      return res.status(400).json({ ok: false, error: 'R2_PUBLIC_URL must be set to custom domain (not r2.dev)' });
    }
    // Count tiles with old r2.dev URL
    const countRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images
      WHERE r2_url LIKE '%r2.dev%'
    `);
    const toUpdate = parseInt(countRes.rows[0].cnt);
    // Update: replace the r2.dev base URL with the new custom domain
    // Old format: https://pub-XXXX.r2.dev/tiles/123.jpg
    // New format: https://tiles.mosaicprint.ch/tiles/123.jpg
    const result = await pool.query(`
      UPDATE mosaic_images
      SET r2_url = REGEXP_REPLACE(r2_url, 'https://[^/]+\.r2\.dev', $1)
      WHERE r2_url LIKE '%r2.dev%'
    `, [newBase]);
    const updated = result.rowCount ?? 0;
    // Invalidate caches
    invalidateIndexCache();
    tileUrlIndexCache.clear();
    tileUrlCache.clear();
    console.log(`[migrate-r2-urls] Updated ${updated} URLs to ${newBase}`);
    res.json({
      ok: true,
      toUpdate,
      updated,
      newBase,
      message: `${updated} R2-URLs auf ${newBase} migriert.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Gemini 2.5 Flash Image Analysis (replaces fal.ai Florence-2) ─────────────
// POST /api/analyze-image-fal
// Body: { imageBase64: string, mimeType?: string } OR { imageUrl: string }
// Returns: { description, sceneType, attributes, keywordSuggestions, hasFace, faceCount }
app.post('/api/analyze-image-fal', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not configured' });

    const { imageBase64, imageUrl: directUrl, mimeType = 'image/jpeg' } = req.body ?? {};
    if (!imageBase64 && !directUrl) return res.status(400).json({ error: 'imageBase64 or imageUrl required' });

    // Build Gemini request parts
    const prompt = `Analyze this image for photo mosaic creation. Return ONLY valid JSON with exactly these fields:
{
  "sceneType": "portrait|landscape|abstract|architecture|nature|food|animal|night_skyline|colorful",
  "description": "one sentence description",
  "hasFace": true|false,
  "faceCount": 0-10,
  "attributes": {
    "hasBeard": true|false,
    "hasGlasses": true|false,
    "hasWhiteHair": true|false,
    "isNight": true|false,
    "isNature": true|false,
    "isColorful": true|false,
    "isArchitecture": true|false,
    "skinTone": "light|medium|dark|none",
    "hairColor": "blonde|brown|black|gray|white|red|none"
  },
  "regions": {
    "face": { "pct": 0, "dominantColor": "hex", "tileComplexityMax": 0.20, "preferCalm": true, "notes": "" },
    "hair": { "pct": 0, "dominantColor": "hex", "tileComplexityMax": 0.50, "preferCalm": false, "notes": "" },
    "clothing": { "pct": 0, "dominantColor": "hex", "tileComplexityMax": 0.35, "preferCalm": false, "notes": "" },
    "background": { "pct": 0, "dominantColor": "hex", "tileComplexityMax": 0.15, "preferCalm": true, "notes": "" },
    "other": { "pct": 0, "dominantColor": "hex", "tileComplexityMax": 0.30, "preferCalm": false, "notes": "" }
  },
  "algoRecommendations": {
    "neighborPenalty": 400,
    "neighborRadius": 6,
    "tileComplexityThreshold": 0.25,
    "preferCalmGlobally": true,
    "recommendedProfile": "portrait|landscape|abstract|colorful|night_skyline",
    "reasoning": "one sentence why"
  },
  "dynamicSettings": {
    "baseTiles": 120,
    "tilePx": 7,
    "maxReuse": 8,
    "rotation": false,
    "neighborRadius": 6,
    "neighborPenalty": 200,
    "contrastBoost": 1.35,
    "histogramBlend": 0.09,
    "baseOverlay": 0.22,
    "edgeBoost": 0.28,
    "overlayMode": "softlight|none",
    "labWeight": 0.15,
    "brightnessWeight": 0.55,
    "textureWeight": 0.10,
    "edgeWeight": 0.20,
    "saturationWeight": 0.35,
    "portraitMode": true|false,
    "reasoning": "one sentence explaining the parameter choices"
  },
  "importKeywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "keywordSuggestions": [
    {"keyword": "search term", "reason": "why needed for mosaic", "priority": "high|medium|low"}
  ]
}
CRITICAL – dynamicSettings must be tailored to THIS specific image. Guidelines:
- Portrait with faces: baseTiles=120, tilePx=7, portraitMode=true, overlayMode=softlight, baseOverlay=0.20-0.25, edgeBoost=0.25-0.30, brightnessWeight=0.50-0.60, labWeight=0.12-0.20, saturationWeight=0.30-0.40, contrastBoost=1.30-1.40, neighborPenalty=180-250, neighborRadius=5-7, histogramBlend=0.07-0.10, rotation=false
- Portrait with white/gray hair: brightnessWeight=0.65-0.75, contrastBoost=1.40-1.50, saturationWeight=0.15-0.25, baseOverlay=0.25-0.30, histogramBlend=0.05-0.08
- Portrait with dark skin: labWeight=0.30-0.40, contrastBoost=1.10-1.20, brightnessWeight=0.40-0.50
- Landscape/nature: baseTiles=60-80, tilePx=10-16, portraitMode=false, overlayMode=none, baseOverlay=0, labWeight=0.35-0.45, brightnessWeight=0.25-0.35, textureWeight=0.15-0.25, contrastBoost=1.35-1.50, rotation=true, neighborPenalty=100-180, neighborRadius=3-5
- Night/skyline: baseTiles=80-100, tilePx=8-10, contrastBoost=1.55-1.70, textureWeight=0.25-0.35, overlayMode=softlight, baseOverlay=0.05, edgeBoost=0.12-0.18
- Colorful/abstract: baseTiles=80-110, tilePx=8-12, labWeight=0.40-0.55, contrastBoost=1.35-1.45, rotation=true, neighborPenalty=150-220
- High detail: baseTiles=130-160, tilePx=5-7, contrastBoost=1.10-1.20
- Minimalistic/calm: baseTiles=120-150, tilePx=6-8, contrastBoost=1.05-1.15, labWeight=0.35-0.45, rotation=false
Adjust values within ranges based on the specific image content – do NOT use generic defaults.
For portraits: set face.pct to actual face area percentage, face.tileComplexityMax=0.18 (very smooth tiles for skin), hair.tileComplexityMax=0.55 (texture ok), background.tileComplexityMax=0.12 (very calm).
For landscapes: face.pct=0, background.pct=60-80, set algoRecommendations.preferCalmGlobally=false.
All region pct values must sum to 100. dominantColor must be a hex color like #f5c5a3.
No explanation, only JSON.`;

    let imagePart: any;
    if (directUrl) {
      imagePart = { file_data: { mime_type: mimeType, file_uri: directUrl } };
    } else {
      imagePart = { inline_data: { mime_type: mimeType, data: imageBase64 } };
    }

    const geminiResp = await fetch(
     `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, imagePart] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      throw new Error(`Gemini API failed: ${geminiResp.status} – ${errText.substring(0, 200)}`);
    }

    const geminiData = await geminiResp.json() as any;
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    let parsed: any = {};
    try { parsed = JSON.parse(rawText); } catch { parsed = {}; }

    const sceneType = parsed.sceneType ?? 'unknown';
    const hasFace = parsed.hasFace ?? false;
    const faceCount = parsed.faceCount ?? 0;
    const description = parsed.description ?? '';
    const attributes = {
      hasBeard: parsed.attributes?.hasBeard ?? false,
      hasGlasses: parsed.attributes?.hasGlasses ?? false,
      hasWhiteHair: parsed.attributes?.hasWhiteHair ?? false,
      isNight: parsed.attributes?.isNight ?? false,
      isNature: parsed.attributes?.isNature ?? false,
      isColorful: parsed.attributes?.isColorful ?? false,
      isArchitecture: parsed.attributes?.isArchitecture ?? false,
      skinTone: parsed.attributes?.skinTone ?? 'none',
      hairColor: parsed.attributes?.hairColor ?? 'none',
    };

    // Build keywordSuggestions if not provided by Gemini
    let keywordSuggestions = parsed.keywordSuggestions ?? [];
    if (keywordSuggestions.length === 0) {
      if (hasFace) {
        const skinMap: Record<string, string> = { light: 'fair skin light complexion', medium: 'medium skin tone warm', dark: 'dark skin tone brown' };
        keywordSuggestions.push({ keyword: skinMap[attributes.skinTone] ?? 'portrait face skin tone', reason: 'Gesicht erkannt – Hautton-Tiles benötigt', priority: 'high' });
        if (attributes.hasBeard) keywordSuggestions.push({ keyword: 'beard stubble dark texture', reason: 'Bart erkannt', priority: 'medium' });
        if (attributes.hasGlasses) keywordSuggestions.push({ keyword: 'glasses reflection lens', reason: 'Brille erkannt', priority: 'medium' });
        if (attributes.hasWhiteHair || attributes.hairColor === 'gray' || attributes.hairColor === 'white') {
          keywordSuggestions.push({ keyword: 'white gray silver texture light', reason: 'Weißes/graues Haar erkannt', priority: 'high' });
        }
      }
      if (attributes.isNight) keywordSuggestions.push({ keyword: 'night city lights dark blue', reason: 'Nacht-Szene erkannt', priority: 'high' });
      if (attributes.isNature) keywordSuggestions.push({ keyword: 'nature green forest landscape', reason: 'Natur-Szene erkannt', priority: 'medium' });
    }

    const importKeywords: string[] = parsed.importKeywords ?? keywordSuggestions.slice(0, 5).map((k: any) => k.keyword);

    // Extract region analysis (new)
    const regions = parsed.regions ?? {
      face: { pct: hasFace ? 30 : 0, dominantColor: '#f5c5a3', tileComplexityMax: 0.18, preferCalm: true, notes: '' },
      hair: { pct: hasFace ? 15 : 0, dominantColor: '#4a3728', tileComplexityMax: 0.50, preferCalm: false, notes: '' },
      clothing: { pct: hasFace ? 20 : 0, dominantColor: '#888888', tileComplexityMax: 0.35, preferCalm: false, notes: '' },
      background: { pct: hasFace ? 35 : 80, dominantColor: '#cccccc', tileComplexityMax: 0.15, preferCalm: true, notes: '' },
      other: { pct: 0, dominantColor: '#aaaaaa', tileComplexityMax: 0.30, preferCalm: false, notes: '' },
    };

    // Extract algo recommendations (new)
    const algoRecommendations = parsed.algoRecommendations ?? {
      neighborPenalty: hasFace ? 420 : 280,
      neighborRadius: hasFace ? 6 : 4,
      tileComplexityThreshold: hasFace ? 0.22 : 0.35,
      preferCalmGlobally: hasFace,
      recommendedProfile: sceneType === 'portrait' ? 'portrait' : sceneType === 'night_skyline' ? 'night_skyline' : sceneType === 'colorful' ? 'colorful' : 'landscape',
      reasoning: `Automatisch generiert für sceneType=${sceneType}`,
    };

    // Extract dynamic settings – Gemini returns image-specific algo parameters
    // Fallback: generate sensible defaults based on sceneType/hasFace
    const dynamicSettings = parsed.dynamicSettings ?? (() => {
      if (hasFace && (attributes.hasWhiteHair || attributes.hairColor === 'white' || attributes.hairColor === 'gray')) {
        return { baseTiles: 100, tilePx: 9, maxReuse: 12, rotation: false, neighborRadius: 5, neighborPenalty: 160, contrastBoost: 1.45, histogramBlend: 0.07, baseOverlay: 0.28, edgeBoost: 0.15, overlayMode: 'softlight', labWeight: 0.30, brightnessWeight: 0.70, textureWeight: 0.05, edgeWeight: 0.05, saturationWeight: 0.20, portraitMode: true, reasoning: 'Fallback: Portrait mit hellem Haar' };
      } else if (hasFace && attributes.skinTone === 'dark') {
        return { baseTiles: 120, tilePx: 8, maxReuse: 8, rotation: false, neighborRadius: 6, neighborPenalty: 200, contrastBoost: 1.15, histogramBlend: 0.09, baseOverlay: 0.18, edgeBoost: 0.20, overlayMode: 'softlight', labWeight: 0.35, brightnessWeight: 0.45, textureWeight: 0.10, edgeWeight: 0.10, saturationWeight: 0.30, portraitMode: true, reasoning: 'Fallback: Portrait mit dunklem Hautton' };
      } else if (hasFace) {
        return { baseTiles: 120, tilePx: 7, maxReuse: 8, rotation: false, neighborRadius: 6, neighborPenalty: 200, contrastBoost: 1.35, histogramBlend: 0.09, baseOverlay: 0.22, edgeBoost: 0.28, overlayMode: 'softlight', labWeight: 0.15, brightnessWeight: 0.55, textureWeight: 0.10, edgeWeight: 0.20, saturationWeight: 0.35, portraitMode: true, reasoning: 'Fallback: Standard-Portrait' };
      } else if (sceneType === 'night_skyline') {
        return { baseTiles: 90, tilePx: 9, maxReuse: 10, rotation: true, neighborRadius: 6, neighborPenalty: 200, contrastBoost: 1.65, histogramBlend: 0.05, baseOverlay: 0.05, edgeBoost: 0.15, overlayMode: 'softlight', labWeight: 0.25, brightnessWeight: 0.35, textureWeight: 0.30, edgeWeight: 0.10, saturationWeight: 0.30, portraitMode: false, reasoning: 'Fallback: Nacht/Skyline' };
      } else if (sceneType === 'landscape' || sceneType === 'nature') {
        return { baseTiles: 80, tilePx: 10, maxReuse: 10, rotation: true, neighborRadius: 8, neighborPenalty: 150, contrastBoost: 1.45, histogramBlend: 0.12, baseOverlay: 0.0, edgeBoost: 0.0, overlayMode: 'none', labWeight: 0.40, brightnessWeight: 0.28, textureWeight: 0.20, edgeWeight: 0.12, saturationWeight: 0.25, portraitMode: false, reasoning: 'Fallback: Landschaft/Natur' };
      } else if (sceneType === 'colorful') {
        return { baseTiles: 100, tilePx: 8, maxReuse: 10, rotation: true, neighborRadius: 6, neighborPenalty: 200, contrastBoost: 1.40, histogramBlend: 0.13, baseOverlay: 0.0, edgeBoost: 0.0, overlayMode: 'none', labWeight: 0.45, brightnessWeight: 0.25, textureWeight: 0.15, edgeWeight: 0.15, saturationWeight: 0.30, portraitMode: false, reasoning: 'Fallback: Farbenreich' };
      } else {
        return { baseTiles: 70, tilePx: 14, maxReuse: 10, rotation: true, neighborRadius: 4, neighborPenalty: 160, contrastBoost: 1.20, histogramBlend: 0.05, baseOverlay: 0.12, edgeBoost: 0.18, overlayMode: 'none', labWeight: 0.18, brightnessWeight: 0.38, textureWeight: 0.10, edgeWeight: 0.20, saturationWeight: 0.30, portraitMode: false, reasoning: 'Fallback: Allgemein/Abstrakt' };
      }
    })();

    console.log(`[Gemini] Analysis: sceneType=${sceneType} hasFace=${hasFace} skinTone=${attributes.skinTone} hairColor=${attributes.hairColor}`);
    console.log(`[Gemini] Description: ${description}`);
    console.log(`[Gemini] Keywords: ${importKeywords.join(', ')}`);
    console.log(`[Gemini] Regions: face=${regions.face?.pct}% bg=${regions.background?.pct}% profile=${algoRecommendations.recommendedProfile}`);
    console.log(`[Gemini] DynamicSettings: baseTiles=${dynamicSettings.baseTiles} tilePx=${dynamicSettings.tilePx} brightnessW=${dynamicSettings.brightnessWeight} labW=${dynamicSettings.labWeight} portrait=${dynamicSettings.portraitMode} reasoning=${dynamicSettings.reasoning}`);

    return res.json({
      ok: true,
      description,
      sceneType,
      hasFace,
      faceCount,
      attributes,
      regions,
      algoRecommendations,
      dynamicSettings,
      keywordSuggestions,
      importKeywords,
      imageUrl: directUrl ?? '(uploaded file)',
    });
  } catch (e: any) {
    console.error('[Gemini analyze] Error:', e);
    return res.status(500).json({ ok: false, error: e.message ?? String(e) });
  }
});

// ── Texture Atlas ──────────────────────────────────────────────────────────────
// GET /api/tile-atlas?theme=&tileSize=64&maxTiles=3000
// Returns a single sprite-sheet JPEG containing all tiles (or a subset).
// X-Atlas-Map header is OMITTED (too large for HTTP headers with 3000+ tiles).
// Instead, use GET /api/tile-atlas-map?theme=&tileSize=64&maxTiles=3000 for the JSON map.
// This replaces thousands of individual /api/tile/:id requests with ONE request.
//
// Cache: in-memory per (theme, tileSize, maxTiles), TTL 30 minutes
// First build: ~10-30s (downloads all tiles), subsequent: instant

// POST /api/tile-atlas-targeted - builds a sprite-sheet for a specific list of tile IDs
// Body: { ids: number[], tileSize?: number }
// Returns: JPEG sprite-sheet with X-Atlas-Cols, X-Atlas-Rows, X-Atlas-TileSize headers
// Map is returned as JSON in /api/tile-atlas-map-targeted (same body)
app.post('/api/tile-atlas-targeted', async (req, res) => {
  try {
    const ids: number[] = (req.body?.ids ?? []).slice(0, 5000);
    const tileSize = Math.min(Math.max(Number(req.body?.tileSize ?? 64), 32), 128);
    if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    const cacheKey = `targeted|${ids.slice().sort((a,b)=>a-b).join(',')}|${tileSize}`;
    const cached = atlasCacheMap.get(cacheKey);
    if (cached && (Date.now() - cached.builtAt) < ATLAS_CACHE_TTL_MS) {
      // Use multipart response: JSON header + JPEG body to avoid HTTP header size limits
      const mapJson = Buffer.from(JSON.stringify({ map: cached.map, cols: cached.cols, rows: cached.rows, tileSize: cached.tileSize }));
      const mapLenBuf = Buffer.allocUnsafe(4);
      mapLenBuf.writeUInt32LE(mapJson.length, 0);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Atlas-Format', 'multipart-v2');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      return res.send(Buffer.concat([mapLenBuf, mapJson, cached.jpeg]));
    }

    const pool = db.getPool();
    const placeholders = ids.map((_,i) => `$${i+1}`).join(',');
    const result = await pool.query(
      `SELECT id, tile128_url, source_url, r2_url, source_provider FROM mosaic_images WHERE id IN (${placeholders}) ORDER BY id ASC`,
      ids
    );
    const rows = result.rows;
    const n = rows.length;
    if (n === 0) return res.status(404).json({ error: 'No tiles found' });

    const cols = Math.ceil(Math.sqrt(n));
    const rows2 = Math.ceil(n / cols);
    const atlasW = cols * tileSize;
    const atlasH = rows2 * tileSize;

    const CONCURRENCY = 100; // Pro plan: higher concurrency for faster atlas builds
    const UPSTREAM_TIMEOUT = 15000; // 15s per tile fetch
    const tileBuffers = new Map<number, Buffer>();
    for (let i = 0; i < n; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row: any) => {
        // Prefer R2 URL (permanent), skip Pixabay tiles without R2 URL (hotlink-protected)
        let url: string;
        if (row.r2_url) {
          url = row.r2_url;
        } else if (row.source_provider === 'pixabay') {
          return; // Pixabay URLs are hotlink-protected, skip until migrated to R2
        } else {
          url = row.tile128_url || row.source_url || '';
        }
        if (!url) return;
        // Check in-memory tile cache first (avoids upstream fetch)
        const cacheKeyTile = `${row.id}-${tileSize}`;
        const cachedTile = tileCacheMap.get(cacheKeyTile);
        if (cachedTile) {
          tileBuffers.set(Number(row.id), cachedTile.buf);
          return;
        }
        try {
          let imgBuf: Buffer | null = null;
          if (url.startsWith('data:')) { imgBuf = Buffer.from(url.split(',')[1], 'base64'); }
          else {
            const resp = await fetch(url, { headers: { 'User-Agent': 'MosaicPrint/1.0' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) });
            if (resp.ok) imgBuf = Buffer.from(await resp.arrayBuffer());
          }
          if (!imgBuf) return;
          const resized = await resizeTileJimp(imgBuf, tileSize);
          if (resized) {
            tileBuffers.set(Number(row.id), resized);
            // Store in tile cache for future requests
            tileCacheMap.set(cacheKeyTile, { buf: resized, contentType: 'image/jpeg', ts: Date.now() });
            evictTileCache();
          }
        } catch { /* skip */ }
      }));
    }
    // Build atlas using Jimp helper
    const orderedIds = rows.map((r: any) => Number(r.id)).filter((id: number) => tileBuffers.has(id));
    const atlasResult = await buildAtlasJimp(tileBuffers, orderedIds, tileSize);
    const atlasData: AtlasCache = { jpeg: atlasResult.jpeg, map: atlasResult.map, tileSize, cols: atlasResult.cols, rows: atlasResult.rows, builtAt: Date.now() };
    atlasCacheMap.set(cacheKey, atlasData);
    console.log(`[atlas-targeted] Built: ${orderedIds.length} tiles, ${atlasResult.cols}x${atlasResult.rows} grid, ${(atlasResult.jpeg.length/1024).toFixed(0)} KB`);
    // Use multipart response: 4-byte LE length prefix + JSON map + JPEG bytes
    // This avoids HTTP header size limits (X-Atlas-Map was up to 270 KB for large mosaics)
    const mapJson = Buffer.from(JSON.stringify({ map: atlasResult.map, cols: atlasResult.cols, rows: atlasResult.rows, tileSize }));
    const mapLenBuf = Buffer.allocUnsafe(4);
    mapLenBuf.writeUInt32LE(mapJson.length, 0);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Atlas-Format', 'multipart-v2');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.send(Buffer.concat([mapLenBuf, mapJson, atlasResult.jpeg]));
  } catch (err: any) {
    console.error('[atlas-targeted] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});
// GET /api/tile-atlas-mapp - returns the tile position map as JSON (separate from the JPEG)
app.get('/api/tile-atlas-map', async (req, res) => {
  const theme = ((req.query.theme as string) ?? '').toLowerCase().trim();
  const tileSize = Math.min(Math.max(Number(req.query.tileSize ?? 64), 32), 128);
  const maxTiles = Math.min(Number(req.query.maxTiles ?? 5000), 30000);
  const cacheKey = `${theme}|${tileSize}|${maxTiles}`;
  const cached = atlasCacheMap.get(cacheKey);
  if (cached && (Date.now() - cached.builtAt) < ATLAS_CACHE_TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.setHeader('X-Atlas-Cols', cached.cols.toString());
    res.setHeader('X-Atlas-Rows', cached.rows.toString());
    res.setHeader('X-Atlas-TileSize', cached.tileSize.toString());
    return res.json(cached.map);
  }
  // Atlas not built yet
  return res.status(202).json({ building: true });
});

interface AtlasCache {
  jpeg: Buffer;
  map: Record<number, [number, number]>; // tileId → [col, row]
  tileSize: number;
  cols: number;
  rows: number;
  builtAt: number;
}

// Helper: resize image buffer to tileSize×tileSize using Sharp (cover mode, 10-50x faster than Jimp)
async function resizeTileJimp(imgBuf: Buffer, tileSize: number): Promise<Buffer | null> {
  try {
    return await sharp(imgBuf)
      .resize(tileSize, tileSize, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch { return null; }
}

// Helper: build atlas JPEG from tile buffers using Sharp composite
async function buildAtlasJimp(
  tileBuffers: Map<number, Buffer>,
  tileIds: number[],
  tileSize: number
): Promise<{ jpeg: Buffer; map: Record<number, [number, number]>; cols: number; rows: number }> {
  const n = tileIds.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const atlasW = cols * tileSize;
  const atlasH = rows * tileSize;
  const map: Record<number, [number, number]> = {};
  // Build composite input array for Sharp
  const compositeInputs: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < tileIds.length; i++) {
    const id = tileIds[i];
    const buf = tileBuffers.get(id);
    if (!buf) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    compositeInputs.push({ input: buf, left: col * tileSize, top: row * tileSize });
    map[id] = [col, row];
  }
  // Create atlas canvas and composite all tiles in one Sharp call
  const jpeg = await sharp({
    create: { width: atlasW, height: atlasH, channels: 3, background: { r: 128, g: 128, b: 128 } }
  })
    .composite(compositeInputs)
    .jpeg({ quality: 85 })
    .toBuffer();
  return { jpeg, map, cols, rows };
}
const atlasCacheMap = new Map<string, AtlasCache>();
const ATLAS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours – Pro plan: longer cache TTL
let atlasBuildInProgress = new Set<string>();

app.get('/api/tile-atlas', async (req, res) => {
  try {
    const theme = ((req.query.theme as string) ?? '').toLowerCase().trim();
    const tileSize = Math.min(Math.max(Number(req.query.tileSize ?? 64), 32), 128);
    const maxTiles = Math.min(Number(req.query.maxTiles ?? 5000), 30000);
    const cacheKey = `${theme}|${tileSize}|${maxTiles}`;

    // Serve from cache if fresh
    const cached = atlasCacheMap.get(cacheKey);
    if (cached && (Date.now() - cached.builtAt) < ATLAS_CACHE_TTL_MS) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', cached.jpeg.length);
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.setHeader('X-Atlas-Cols', cached.cols.toString());
      res.setHeader('X-Atlas-Rows', cached.rows.toString());
      res.setHeader('X-Atlas-TileSize', cached.tileSize.toString());
      res.setHeader('X-Cache', 'HIT');
      return res.send(cached.jpeg);
    }

    // If build already in progress, return 202 Accepted
    if (atlasBuildInProgress.has(cacheKey)) {
      return res.status(202).json({ building: true, message: 'Atlas is being built, retry in a few seconds' });
    }

    atlasBuildInProgress.add(cacheKey);
    console.log(`[atlas] Building atlas: theme=${theme || 'all'}, tileSize=${tileSize}, maxTiles=${maxTiles}`);

    const pool = db.getPool();
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space','bokeh_gradient','pure_sky','water_surface','sand_earth','fog_mist','autumn_carpet','snow_ice','calm_nature','calm_monochrome','skin_tone','texture','architecture'];
    const themeFilter = (theme && VALID_THEMES.includes(theme)) ? `AND subject = $1` : ``;
    const queryParams = (theme && VALID_THEMES.includes(theme)) ? [theme] : [];

    // Fetch tile IDs and URLs - prefer R2 URLs, exclude Pixabay tiles without R2
    const result = await pool.query(
      `SELECT id, tile128_url, source_url, r2_url, source_provider FROM mosaic_images
       WHERE (r2_url IS NOT NULL OR COALESCE(source_provider, '') != 'pixabay')
       ${themeFilter} ORDER BY id ASC LIMIT $${queryParams.length + 1}`,
      [...queryParams, maxTiles]
    );
    const rows = result.rows;
    const n = rows.length;
    if (n === 0) {
      atlasBuildInProgress.delete(cacheKey);
      return res.status(404).json({ error: 'No tiles found' });
    }

    // Layout: square-ish grid
    const cols = Math.ceil(Math.sqrt(n));
    const rows2 = Math.ceil(n / cols);
    const atlasW = cols * tileSize;
    const atlasH = rows2 * tileSize;

    // Build atlas using Jimp (pure JS, no native binaries)
    const CONCURRENCY = 50; // Pro plan: higher concurrency
    const tileBuffers2 = new Map<number, Buffer>();
    for (let i = 0; i < n; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row: any) => {
        // Prefer R2 URL (permanent), skip Pixabay tiles without R2 URL (hotlink-protected)
        let url: string;
        if (row.r2_url) {
          url = row.r2_url;
        } else if (row.source_provider === 'pixabay') {
          return; // Skip Pixabay tiles without R2 URL
        } else {
          url = row.tile128_url || row.source_url || '';
        }
        if (!url) return;
        try {
          let imgBuf: Buffer | null = null;
          if (url.startsWith('data:')) {
            imgBuf = Buffer.from(url.split(',')[1], 'base64');
          } else {
            const resp = await fetch(url, { headers: { 'User-Agent': 'MosaicPrint/1.0' }, signal: AbortSignal.timeout(8000) });
            if (resp.ok) imgBuf = Buffer.from(await resp.arrayBuffer());
          }
          if (!imgBuf) return;
          const resized = await resizeTileJimp(imgBuf, tileSize);
          if (resized) tileBuffers2.set(Number(row.id), resized);
        } catch { /* skip */ }
      }));
      if (i % 500 === 0) console.log(`[atlas] Processing tiles ${i}/${n}...`);
    }
    // Build atlas using Jimp helper
    const orderedIds2 = rows.map((r: any) => Number(r.id)).filter((id: number) => tileBuffers2.has(id));
    const atlasResult2 = await buildAtlasJimp(tileBuffers2, orderedIds2, tileSize);
    const atlasData: AtlasCache = {
      jpeg: atlasResult2.jpeg,
      map: atlasResult2.map,
      tileSize,
      cols: atlasResult2.cols,
      rows: atlasResult2.rows,
      builtAt: Date.now(),
    };
    atlasCacheMap.set(cacheKey, atlasData);
    atlasBuildInProgress.delete(cacheKey);
    console.log(`[atlas] Built: ${orderedIds2.length} tiles, ${atlasResult2.cols}x${atlasResult2.rows} grid, ${(atlasResult2.jpeg.length/1024/1024).toFixed(1)} MB JPEG`);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', atlasResult2.jpeg.length);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.setHeader('X-Atlas-Cols', atlasResult2.cols.toString());
    res.setHeader('X-Atlas-Rows', atlasResult2.rows.toString());
    res.setHeader('X-Atlas-TileSize', tileSize.toString());
    res.setHeader('X-Cache', 'MISS');
    res.send(atlasResult2.jpeg);
  } catch (e) {
    atlasBuildInProgress.clear();
    console.error('[atlas] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Server-side Print Render ──────────────────────────────────────────────────
// POST /api/print-render
// Body: { tileIds, assignment, cols, rows, tilePx?, format?, jobId? }
// Returns: { token, filename, size, width, height }
// Uses source_url (original hi-res images) for print quality.
// Disk cache at /tmp/mosaicprint-hires/ to avoid re-downloading.
// Progress updates via GET /api/print-progress/:jobId (SSE).
const HIRES_CACHE_DIR = '/tmp/mosaicprint-hires';
if (!fs.existsSync(HIRES_CACHE_DIR)) fs.mkdirSync(HIRES_CACHE_DIR, { recursive: true });

// In-memory progress tracking for SSE
const printJobs = new Map<string, { progress: number; message: string; done: boolean; eta?: number; error?: string; result?: Record<string, unknown> }>();

// SSE endpoint for real-time progress
app.get('/api/print-progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx/Railway proxy buffering
  });
  // Send initial message immediately (don't wait for first interval)
  const initialJob = printJobs.get(jobId);
  res.write(`data: ${JSON.stringify(initialJob || { progress: 0, message: 'Warte...' })}\n\n`);

  const interval = setInterval(() => {
    const job = printJobs.get(jobId);
    if (!job) { res.write(`data: ${JSON.stringify({ progress: 0, message: 'Warte...' })}\n\n`); return; }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.done || job.error) {
      clearInterval(interval);
      // Send result one more time to ensure delivery, then close
      setTimeout(() => {
        try { res.write(`data: ${JSON.stringify(job)}\n\n`); } catch { /* ignore */ }
        setTimeout(() => { try { res.end(); } catch { /* ignore */ } }, 500);
      }, 300);
      setTimeout(() => printJobs.delete(jobId), 120000); // keep 2 min for polling fallback
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});

// Polling fallback: GET /api/print-job/:jobId — returns job status as JSON
// Used when SSE doesn't work (proxy buffering, connection issues)
app.get('/api/print-job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = printJobs.get(jobId);
  if (!job) return res.json({ progress: 0, message: 'Warte...', done: false });
  res.json(job);
});

// Helper: LAB color transfer (matches client-side renderMosaicClientSide)
// Applies per-tile LAB brightness scaling + AB color shift + contrast boost
function applyLabColorTransfer(
  pixelBuf: Buffer,
  width: number, height: number,
  tilePx: number,
  cols: number, rows: number,
  stripRowStart: number,
  targetColors: number[],
  edgeMap: number[],
  faceMask: boolean[],
  colorEnhance: number,  // 0-100
): void {
  if (!targetColors?.length || colorEnhance <= 0) return;

  const labToRgb = (L: number, a: number, b: number): [number, number, number] => {
    let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
    x = (x**3 > 0.008856 ? x**3 : (x - 16/116)/7.787) * 0.95047;
    y = (y**3 > 0.008856 ? y**3 : (y - 16/116)/7.787) * 1.00000;
    z = (z**3 > 0.008856 ? z**3 : (z - 16/116)/7.787) * 1.08883;
    const r = x * 3.2406 + y * -1.5372 + z * -0.4986;
    const g = x * -0.9689 + y * 1.8758 + z * 0.0415;
    const bv = x * 0.0557 + y * -0.2040 + z * 1.0570;
    const toSrgb = (c: number) => c > 0.0031308 ? 1.055 * c**(1/2.4) - 0.055 : 12.92 * c;
    return [Math.round(Math.max(0,Math.min(255,toSrgb(r)*255))), Math.round(Math.max(0,Math.min(255,toSrgb(g)*255))), Math.round(Math.max(0,Math.min(255,toSrgb(bv)*255)))];
  };
  const rgbToLab = (r: number, g: number, b: number): [number, number, number] => {
    const toLinear = (c: number) => { const s = c/255; return s > 0.04045 ? ((s+0.055)/1.055)**2.4 : s/12.92; };
    const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);
    const x = (rl*0.4124 + gl*0.3576 + bl*0.1805)/0.95047;
    const y = (rl*0.2126 + gl*0.7152 + bl*0.0722)/1.00000;
    const z = (rl*0.0193 + gl*0.1192 + bl*0.9505)/1.08883;
    const f = (t: number) => t > 0.008856 ? t**(1/3) : 7.787*t + 16/116;
    return [116*f(y)-16, 500*(f(x)-f(y)), 200*(f(y)-f(z))];
  };

  const colorEnhanceVal = colorEnhance / 100;
  const AB_BLEND = 0.12 * colorEnhanceVal;
  const L_BLEND = 0.40;
  const MAX_COLOR_SHIFT = 15;
  const MAX_BLUE_SHIFT = 5;
  const cBoost = 1.30;
  const satBoost = 0.90 + cBoost * 0.15;
  const REF_SAMPLES = 64;

  const stripRows = Math.ceil(height / tilePx);
  for (let lr = 0; lr < stripRows; lr++) {
    const row = stripRowStart + lr;
    if (row >= rows) break;
    for (let col = 0; col < cols; col++) {
      const ci = row * cols + col;
      const tci = ci * 3;
      const tR = targetColors[tci] ?? 128;
      const tG = targetColors[tci+1] ?? 128;
      const tBv = targetColors[tci+2] ?? 128;
      const [tL, tA, tBlab] = rgbToLab(tR, tG, tBv);
      const isShadowZone = tL < 40;
      const shadowBoost = isShadowZone ? Math.max(0, (40-tL)/40) : 0;
      const effectiveL_BLEND = Math.min(0.98, L_BLEND + shadowBoost * 0.50);

      const py0 = lr * tilePx, px0 = col * tilePx;
      const py1 = Math.min(py0 + tilePx, height), px1 = Math.min(px0 + tilePx, width);
      const totalPx = (px1-px0) * (py1-py0);
      const step = Math.max(1, Math.floor(totalPx / REF_SAMPLES));
      let sumL = 0, sampleCount = 0;
      for (let si = 0; si < totalPx; si += step) {
        const lx = px0 + (si % (px1-px0));
        const ly = py0 + Math.floor(si / (px1-px0));
        const pi = (ly * width + lx) * 3;
        sumL += rgbToLab(pixelBuf[pi], pixelBuf[pi+1], pixelBuf[pi+2])[0];
        sampleCount++;
      }
      const avgL = sampleCount > 0 ? sumL / sampleCount : 50;
      const rawLumScale = avgL > 1 ? tL / avgL : 1;
      const clampedLumScale = Math.max(0.05, Math.min(4.0, isShadowZone ? Math.min(1.0, rawLumScale) : rawLumScale));
      const lumScale = 1 + (clampedLumScale - 1) * effectiveL_BLEND;

      for (let py = py0; py < py1; py++) {
        for (let px = px0; px < px1; px++) {
          const pi = (py * width + px) * 3;
          const [pl, pa, pb] = rgbToLab(pixelBuf[pi], pixelBuf[pi+1], pixelBuf[pi+2]);
          let newL = Math.max(0, Math.min(100, pl * lumScale));
          if (isShadowZone && shadowBoost > 0.05) {
            const dev = pl - avgL;
            newL = Math.max(0, Math.min(100, newL + dev * shadowBoost * 0.4));
          }
          if (isShadowZone && newL > tL + 25) newL = tL + 25 + (newL - tL - 25) * 0.2;
          const clampedDA = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, (tA - pa) * AB_BLEND));
          const rawDB = (tBlab - pb) * AB_BLEND;
          const clampedDB = rawDB < 0 ? Math.max(-MAX_BLUE_SHIFT, rawDB) : Math.min(MAX_COLOR_SHIFT, rawDB);
          const newA = Math.max(-128, Math.min(127, pa + clampedDA));
          const newBv2 = Math.max(-128, Math.min(127, pb + clampedDB));
          const contrastL = Math.max(0, Math.min(100, 50 + (newL-50)*cBoost));
          const bSatBoost = newBv2 < 0 ? Math.min(satBoost, 1.0) : satBoost;
          const [nr, ng, nb] = labToRgb(contrastL, Math.max(-128,Math.min(127,newA*satBoost)), Math.max(-128,Math.min(127,newBv2*bSatBoost)));
          pixelBuf[pi] = nr; pixelBuf[pi+1] = ng; pixelBuf[pi+2] = nb;
        }
      }
    }
  }
}

// Helper: Apply overlay blending to a raw RGB pixel buffer (matches client-side Step 6)
// Blends the original target photo over the mosaic tiles for better visual coherence.
function applyOverlay(
  pixelBuf: Buffer,           // raw RGB buffer (width × height × 3)
  width: number, height: number,
  tilePx: number,
  cols: number, rows: number,
  stripRowStart: number,      // first tile row in this buffer (for strip-based processing)
  mode: 'softlight' | 'alphablend',
  baseOverlayVal: number,     // e.g. 0.15
  edgeBoostVal: number,       // e.g. 0.20
  targetColors: number[],     // flat [r,g,b,...] per cell
  edgeMap: number[],          // edge strength 0-1 per cell
  faceMask: boolean[],        // face region flag per cell
): void {
  const softLight = (base: number, blend: number): number => {
    const b = blend / 255, s = base / 255;
    const result = b < 0.5
      ? s - (1 - 2 * b) * s * (1 - s)
      : s + (2 * b - 1) * (Math.sqrt(s) - s);
    return Math.round(Math.max(0, Math.min(255, result * 255)));
  };

  // Scale overlay strength by tile size.
  // At small tile sizes (8px preview), the overlay is applied at full strength.
  // At larger print sizes (128-256px), we keep the overlay strong enough to
  // make the mosaic motif clearly visible — do NOT reduce too much.
  // Formula: at 8px → 1.0, at 64px → 1.0, at 128px → 0.85, at 256px → 0.70
  const REFERENCE_TILE_PX = 64;
  const strengthScale = tilePx <= REFERENCE_TILE_PX ? 1.0 : Math.min(1.0, Math.pow(REFERENCE_TILE_PX / tilePx, 0.25));

  const stripRows = Math.ceil(height / tilePx);
  for (let lr = 0; lr < stripRows; lr++) {
    const row = stripRowStart + lr;
    if (row >= rows) break;
    for (let col = 0; col < cols; col++) {
      const ci = row * cols + col;
      const tr = targetColors[ci * 3];
      const tg = targetColors[ci * 3 + 1];
      const tb = targetColors[ci * 3 + 2];
      if (tr === undefined) continue; // no target data for this cell
      const edge = edgeMap[ci] ?? 0;
      const faceBoost = faceMask[ci] ? 0.25 : 0;
      const strength = Math.min(0.85, baseOverlayVal + edge * edgeBoostVal + faceBoost) * strengthScale;

      const pyStart = lr * tilePx;
      const pyEnd = Math.min((lr + 1) * tilePx, height);
      const pxStart = col * tilePx;
      const pxEnd = Math.min((col + 1) * tilePx, width);

      for (let py = pyStart; py < pyEnd; py++) {
        for (let px = pxStart; px < pxEnd; px++) {
          const pi = (py * width + px) * 3;
          if (mode === 'softlight') {
            const slR = softLight(pixelBuf[pi], tr);
            const slG = softLight(pixelBuf[pi + 1], tg);
            const slB = softLight(pixelBuf[pi + 2], tb);
            pixelBuf[pi]     = Math.round(pixelBuf[pi]     * (1 - strength) + slR * strength);
            pixelBuf[pi + 1] = Math.round(pixelBuf[pi + 1] * (1 - strength) + slG * strength);
            pixelBuf[pi + 2] = Math.round(pixelBuf[pi + 2] * (1 - strength) + slB * strength);
          } else {
            pixelBuf[pi]     = Math.round(pixelBuf[pi]     * (1 - strength) + tr * strength);
            pixelBuf[pi + 1] = Math.round(pixelBuf[pi + 1] * (1 - strength) + tg * strength);
            pixelBuf[pi + 2] = Math.round(pixelBuf[pi + 2] * (1 - strength) + tb * strength);
          }
        }
      }
    }
  }
}

app.post('/api/print-render', express.json({ limit: '20mb' }), async (req, res) => {
  const { tileIds, assignment, cols, rows, tilePx = 200, format = 'jpg', jobId,
    overlayMode, baseOverlay, edgeBoost, targetColors, edgeMap: clientEdgeMap, faceMask: clientFaceMask,
    colorEnhance: clientColorEnhance = 0
  } = req.body as {
    tileIds: number[];
    assignment: number[];
    cols: number;
    rows: number;
    tilePx?: number;
    format?: 'jpg' | 'png';
    jobId?: string;
    overlayMode?: 'softlight' | 'alphablend' | 'none';
    baseOverlay?: number;
    edgeBoost?: number;
    targetColors?: number[];
    edgeMap?: number[];
    faceMask?: boolean[];
    colorEnhance?: number;
  };

  if (!tileIds?.length || !assignment?.length || !cols || !rows) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Respond immediately — render runs in background.
  // Client gets result via SSE /api/print-progress/:jobId (result field when done=true).
  const effectiveJobId = jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  printJobs.set(effectiveJobId, { progress: 1, message: 'Render gestartet...', done: false });
  res.json({ accepted: true, jobId: effectiveJobId });

  // Background render (not awaited by the request handler)
  (async () => {
  try {

    // Helper to update progress with ETA (SSE + console)
    const startTime = Date.now();
    const updateProgress = (progress: number, message: string) => {
      const elapsed = (Date.now() - startTime) / 1000;
      let eta: number | undefined;
      if (progress > 5 && progress < 100) {
        const remaining = (elapsed / progress) * (100 - progress);
        eta = Math.round(remaining);
      }
      printJobs.set(effectiveJobId, { progress, message, done: false, eta });
      const etaStr = eta !== undefined ? ` (~${eta}s remaining)` : '';
      console.log(`[print-render] [${progress}%] ${message}${etaStr}`);
    };

    // Clamp tile size: min 32px, max 256px
    // Safety cap: max 16000px per output dimension (practical limit for downloads)
    // 16000px at 300 DPI = 135cm — sufficient for any print size
    let TILE_PX = Math.min(Math.max(tilePx, 32), 256);
    const MAX_DIM = 16000;
    if (cols * TILE_PX > MAX_DIM || rows * TILE_PX > MAX_DIM) {
      TILE_PX = Math.min(Math.floor(MAX_DIM / cols), Math.floor(MAX_DIM / rows), TILE_PX);
      TILE_PX = Math.max(32, TILE_PX);
    }
    const outW = cols * TILE_PX;
    const outH = rows * TILE_PX;
    updateProgress(5, `Start: ${cols}x${rows} tiles @ ${TILE_PX}px → ${outW}x${outH}px`);
    const pool = db.getPool();

    // Fetch unique tile IDs needed
    const uniqueIds = [...new Set(assignment.map(idx => tileIds[idx]).filter(Boolean))];
    updateProgress(10, `${uniqueIds.length} unique Tiles werden geladen...`);

    // Load tiles using shared loadTileBuffer() — same logic as /api/tile/:id
    // Benefits: shared cache (tileCacheMap), robust URL resolution, R2 CDN fallback
    const tileBuffers: Record<number, Buffer> = {};
    const CONCURRENCY = 25;
    let loadedCount = 0;
    for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
      const batch = uniqueIds.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (id) => {
        const buf = await loadTileBuffer(id, TILE_PX);
        if (buf) {
          tileBuffers[id] = buf;
          loadedCount++;
        }
      }));
      const pct = Math.round(10 + (loadedCount / uniqueIds.length) * 40);
      updateProgress(pct, `Tiles laden: ${loadedCount}/${uniqueIds.length}`);
    }
    console.log(`[print-render] Tiles loaded: ${loadedCount}/${uniqueIds.length}`);

    const missingTiles = uniqueIds.filter(id => !tileBuffers[id]);
    if (missingTiles.length > 0) {
      console.log(`[print-render] WARNING: ${missingTiles.length}/${uniqueIds.length} tiles missing. First 10: ${missingTiles.slice(0, 10).join(',')}`);
    }

    // Strip-based compositing to control memory
    // Target: keep strip RAM under ~250 MB (width * stripHeight * 4 bytes RGBA)
    const MAX_STRIP_BYTES = 250 * 1024 * 1024; // 250 MB
    const maxStripHeight = Math.floor(MAX_STRIP_BYTES / (outW * 4));
    const STRIP_ROWS = Math.max(1, Math.min(Math.floor(maxStripHeight / TILE_PX), Math.floor(3000 / TILE_PX)));
    const totalStrips = Math.ceil(rows / STRIP_ROWS);
    updateProgress(55, `Compositing: ${totalStrips} Strips @ ${outW}px breit`);

    const tmpDir = '/tmp/mosaicprint-downloads';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // For small images (< ~50M pixels), composite in memory
    // For larger, composite strip by strip to disk
    const totalPixels = outW * outH;
    const useJpeg = format === 'jpg';

    if (totalPixels <= 50_000_000) {
      // Small enough: single-pass composite in memory
      const compositeInputs: Array<{ input: Buffer; top: number; left: number }> = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ci = r * cols + c;
          const tileId = tileIds[assignment[ci]];
          const buf = tileBuffers[tileId];
          if (!buf) continue;
          compositeInputs.push({ input: buf, top: r * TILE_PX, left: c * TILE_PX });
        }
      }
      updateProgress(70, `Compositing ${compositeInputs.length} tiles...`);

      // Composite tiles into raw RGB buffer for overlay processing
      const hasOverlay = overlayMode && overlayMode !== 'none' && targetColors?.length;
      let outputBuf: Buffer;

      if (hasOverlay) {
        // Get raw pixels so we can apply per-pixel overlay blending
        // IMPORTANT: .flatten() before .raw() ensures we get 3-channel RGB (not 4-channel RGBA)
        // Without .flatten(), sharp returns RGBA (4 bytes/pixel) but applyOverlay expects RGB (3 bytes/pixel)
        // causing completely wrong pixel indexing and the "grid/mosaic" artifact in downloads.
        const rawBuf = await sharp({
          create: { width: outW, height: outH, channels: 3, background: { r: 180, g: 180, b: 180 } },
          limitInputPixels: false,
        }).composite(compositeInputs).flatten({ background: { r: 180, g: 180, b: 180 } }).raw().toBuffer();
        updateProgress(80, 'Farbkorrektur + Overlay anwenden...');
        // Apply LAB color transfer first (brightness + color shift per tile)
        if (clientColorEnhance > 0 && targetColors?.length) {
          applyLabColorTransfer(rawBuf, outW, outH, TILE_PX, cols, rows, 0,
            targetColors, clientEdgeMap ?? [], clientFaceMask ?? [], clientColorEnhance);
        }
        applyOverlay(rawBuf, outW, outH, TILE_PX, cols, rows, 0,
          overlayMode as 'softlight' | 'alphablend',
          baseOverlay ?? 0.15, edgeBoost ?? 0.20,
          targetColors!, clientEdgeMap ?? [], clientFaceMask ?? []);
        // Encode from raw pixels
        const encoded = sharp(rawBuf, { raw: { width: outW, height: outH, channels: 3 }, limitInputPixels: false });
        outputBuf = useJpeg
          ? await encoded.jpeg({ quality: 95 }).toBuffer()
          : await encoded.png({ compressionLevel: 6 }).toBuffer();
      } else {
        // No overlay: direct encode
        const pipeline = sharp({
          create: { width: outW, height: outH, channels: 3, background: { r: 180, g: 180, b: 180 } },
          limitInputPixels: false,
        }).composite(compositeInputs);
        outputBuf = useJpeg
          ? await pipeline.jpeg({ quality: 95 }).toBuffer()
          : await pipeline.png({ compressionLevel: 6 }).toBuffer();
      }
      updateProgress(90, `Speichere ${(outputBuf.length / 1024 / 1024).toFixed(1)} MB...`);

      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = useJpeg ? 'jpg' : 'png';
      const tmpFile = path.join(tmpDir, `${token}.${ext}`);
      fs.writeFileSync(tmpFile, outputBuf);
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 10 * 60 * 1000);

      const filename = `mosaicprint-${outW}x${outH}-druckbereit.${ext}`;
      const resultData = { token, filename, size: outputBuf.length, width: outW, height: outH };
      printJobs.set(effectiveJobId, { progress: 100, message: 'Fertig!', done: true, result: resultData });
      console.log(`[print-render] Done (small): ${outW}x${outH}px, ${(outputBuf.length / 1024 / 1024).toFixed(1)} MB (${ext})`);
      return; // response already sent above
    }

    // Large image: strip-based compositing
    const stripFiles: string[] = [];
    for (let stripStart = 0; stripStart < rows; stripStart += STRIP_ROWS) {
      const stripEnd = Math.min(stripStart + STRIP_ROWS, rows);
      const stripH = (stripEnd - stripStart) * TILE_PX;
      const compositeInputs: Array<{ input: Buffer; top: number; left: number }> = [];

      for (let r = stripStart; r < stripEnd; r++) {
        for (let c = 0; c < cols; c++) {
          const ci = r * cols + c;
          const tileId = tileIds[assignment[ci]];
          const buf = tileBuffers[tileId];
          if (!buf) continue;
          compositeInputs.push({ input: buf, top: (r - stripStart) * TILE_PX, left: c * TILE_PX });
        }
      }

      const stripFile = path.join(tmpDir, `strip-${Date.now()}-${stripStart}.png`);
      const hasStripOverlay = overlayMode && overlayMode !== 'none' && targetColors?.length;
      if (hasStripOverlay) {
        // Get raw pixels for overlay processing
        // IMPORTANT: .flatten() before .raw() ensures 3-channel RGB output (not 4-channel RGBA)
        const rawStrip = await sharp({
          create: { width: outW, height: stripH, channels: 3, background: { r: 180, g: 180, b: 180 } },
          limitInputPixels: false,
        }).composite(compositeInputs).flatten({ background: { r: 180, g: 180, b: 180 } }).raw().toBuffer();
        // Apply LAB color transfer first (brightness + color shift per tile)
        if (clientColorEnhance > 0 && targetColors?.length) {
          applyLabColorTransfer(rawStrip, outW, stripH, TILE_PX, cols, rows, stripStart,
            targetColors, clientEdgeMap ?? [], clientFaceMask ?? [], clientColorEnhance);
        }
        applyOverlay(rawStrip, outW, stripH, TILE_PX, cols, rows, stripStart,
          overlayMode as 'softlight' | 'alphablend',
          baseOverlay ?? 0.15, edgeBoost ?? 0.20,
          targetColors!, clientEdgeMap ?? [], clientFaceMask ?? []);
        await sharp(rawStrip, { raw: { width: outW, height: stripH, channels: 3 }, limitInputPixels: false })
          .png({ compressionLevel: 2 }).toFile(stripFile);
      } else {
        await sharp({
          create: { width: outW, height: stripH, channels: 3, background: { r: 180, g: 180, b: 180 } },
          limitInputPixels: false,
        })
          .composite(compositeInputs)
          .png({ compressionLevel: 2 })
          .toFile(stripFile);
      }
      stripFiles.push(stripFile);

      const stripIdx = Math.floor(stripStart / STRIP_ROWS) + 1;
      const stripPct = Math.round(55 + (stripIdx / totalStrips) * 30);
      updateProgress(stripPct, `Strip ${stripIdx}/${totalStrips} fertig`);
    }

    // Join strips vertically
    updateProgress(88, 'Strips zusammenfuegen...');
    let yOff = 0;
    const compositeStrips = [];
    for (const sf of stripFiles) {
      const meta = await sharp(sf).metadata();
      compositeStrips.push({ input: sf, top: yOff, left: 0 });
      yOff += meta.height ?? 0;
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = useJpeg ? 'jpg' : 'png';
    const tmpFile = path.join(tmpDir, `${token}.${ext}`);

    const finalPipeline = sharp({
      create: { width: outW, height: outH, channels: 3, background: { r: 180, g: 180, b: 180 } },
      limitInputPixels: false,
    }).composite(compositeStrips);

    if (useJpeg) {
      await finalPipeline.jpeg({ quality: 95 }).toFile(tmpFile);
    } else {
      await finalPipeline.png({ compressionLevel: 6 }).toFile(tmpFile);
    }

    // Clean up strip files
    for (const sf of stripFiles) { try { fs.unlinkSync(sf); } catch {} }

    const stat = fs.statSync(tmpFile);
    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 10 * 60 * 1000);

    const filename = `mosaicprint-${outW}x${outH}-druckbereit.${ext}`;
    updateProgress(95, `Fertig: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    const resultData = { token, filename, size: stat.size, width: outW, height: outH };
    printJobs.set(effectiveJobId, { progress: 100, message: 'Fertig!', done: true, result: resultData });
    console.log(`[print-render] Done: ${outW}x${outH}px, ${(stat.size / 1024 / 1024).toFixed(1)} MB (${ext})`);
  } catch (e) {
    console.error('[print-render] Error:', e);
    printJobs.set(effectiveJobId, { progress: 0, message: String(e), done: false, error: String(e) });
  }
  })(); // end background async IIFE
});

// GET /api/print-download/:token – serve the pre-rendered PNG file
// Client opens this URL directly to force a binary download (PNG avoids Adobe Acrobat interception)
app.get('/api/print-download/:token', (req, res) => {
  const { token } = req.params;
  // Validate token: only alphanumeric, dash, dot
  if (!/^[\w.-]+$/.test(token)) return res.status(400).send('Invalid token');
  // Check for PNG first (new format), fallback to JPG (legacy)
  let tmpFile = path.join('/tmp/mosaicprint-downloads', `${token}.png`);
  let contentType = 'image/png';
  if (!fs.existsSync(tmpFile)) {
    tmpFile = path.join('/tmp/mosaicprint-downloads', `${token}.jpg`);
    contentType = 'image/jpeg';
    if (!fs.existsSync(tmpFile)) return res.status(404).send('File not found or expired');
  }
  const filename = req.query.filename as string || 'mosaicprint-druckbereit.png';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const stream = fs.createReadStream(tmpFile);
  stream.pipe(res);
});

// POST /api/temp-blob – receive a client-rendered image blob, store it temporarily, return a download token
// Client uploads the rendered canvas blob here, then opens /api/print-download/:token to force a real download
// This completely bypasses Chrome's blob: URL handling and Adobe Acrobat extension interception
app.post('/api/temp-blob', express.raw({ type: ['image/jpeg', 'image/png'], limit: '500mb' }), (req, res) => {
  try {
    const contentType = req.headers['content-type'] || 'image/jpeg';
    const ext = contentType === 'image/png' ? 'png' : 'jpg';
    const token = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpDir = '/tmp/mosaicprint-downloads';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${token}.${ext}`);
    fs.writeFileSync(tmpFile, req.body as Buffer);
    // Auto-delete after 10 minutes
    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 10 * 60 * 1000);
    res.json({ token });
  } catch (err) {
    console.error('[temp-blob] Error:', err);
    res.status(500).json({ error: 'Failed to store blob' });
  }
});

// ── Debug Endpoint ──────────────────────────────────────────────────────────

// POST /api/debug/print-render-test – render a tiny 2x2 mosaic and return debug info
// This endpoint renders 4 real tiles from the DB at the given tilePx and returns
// a JPEG + JSON with all parameters so we can diagnose the gray-image bug.
app.post('/api/debug/print-render-test', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const {
      tilePx = 128,
      overlayMode = 'softlight',
      baseOverlay = 0.15,
      edgeBoost = 0.20,
      targetColors,
    } = req.body as {
      tilePx?: number;
      overlayMode?: string;
      baseOverlay?: number;
      edgeBoost?: number;
      targetColors?: number[];
    };

    const pool = db.getPool();
    // Get 4 random colorful tiles from DB
    const result = await pool.query(
      `SELECT id, tile128_url, tile256_url, r2_url, source_url FROM mosaic_images 
       WHERE r2_url IS NOT NULL AND r2_url != '' 
       ORDER BY RANDOM() LIMIT 4`
    );
    const tiles = result.rows;
    if (tiles.length < 4) {
      return res.status(500).json({ error: 'Not enough tiles in DB', count: tiles.length });
    }

    const debugInfo: Record<string, unknown> = {
      tilePx,
      overlayMode,
      baseOverlay,
      edgeBoost,
      targetColorsLength: targetColors?.length ?? 0,
      targetColorsProvided: !!(targetColors?.length),
      tiles: tiles.map(t => ({ id: t.id, r2_url: t.r2_url?.substring(0, 60), tile256_url: t.tile256_url?.substring(0, 60) })),
    };

    // Load tile images
    const tileBuffers: Buffer[] = [];
    for (const tile of tiles) {
      const url = tile.r2_url || tile.tile256_url || tile.tile128_url || tile.source_url;
      const resp = await fetch(url, { headers: { 'User-Agent': 'MosaicPrint/1.0' }, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`Failed to load tile ${tile.id}: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const resized = await sharp(buf).resize(tilePx, tilePx, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
      tileBuffers.push(resized);
    }
    debugInfo.tilesLoaded = tileBuffers.length;

    // Composite 2x2
    const outW = tilePx * 2;
    const outH = tilePx * 2;
    const compositeInputs = [
      { input: tileBuffers[0], top: 0, left: 0 },
      { input: tileBuffers[1], top: 0, left: tilePx },
      { input: tileBuffers[2], top: tilePx, left: 0 },
      { input: tileBuffers[3], top: tilePx, left: tilePx },
    ];

    // Use target colors if provided, otherwise use bright test colors
    const testTargetColors = targetColors?.length === 12
      ? targetColors
      : [255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 0]; // R, G, B, Y
    debugInfo.testTargetColorsUsed = !targetColors?.length;

    const hasOverlay = overlayMode && overlayMode !== 'none';
    let outputBuf: Buffer;

    if (hasOverlay) {
      const rawBuf = await sharp({
        create: { width: outW, height: outH, channels: 3, background: { r: 128, g: 128, b: 128 } },
        limitInputPixels: false,
      }).composite(compositeInputs).raw().toBuffer();

      // Apply overlay manually (same as applyOverlay function)
      const REFERENCE_TILE_PX = 64;
      const strengthScale = tilePx <= REFERENCE_TILE_PX ? 1.0 : Math.min(1.0, Math.pow(REFERENCE_TILE_PX / tilePx, 0.25));
      debugInfo.strengthScale = strengthScale;
      debugInfo.effectiveBaseOverlay = baseOverlay * strengthScale;

      const softLight = (base: number, blend: number): number => {
        const b = blend / 255, s = base / 255;
        const result = b < 0.5 ? s - (1 - 2 * b) * s * (1 - s) : s + (2 * b - 1) * (Math.sqrt(s) - s);
        return Math.round(Math.max(0, Math.min(255, result * 255)));
      };

      for (let ci = 0; ci < 4; ci++) {
        const row = Math.floor(ci / 2);
        const col = ci % 2;
        const tr = testTargetColors[ci * 3];
        const tg = testTargetColors[ci * 3 + 1];
        const tb = testTargetColors[ci * 3 + 2];
        const strength = Math.min(0.85, baseOverlay) * strengthScale;
        for (let py = row * tilePx; py < (row + 1) * tilePx; py++) {
          for (let px = col * tilePx; px < (col + 1) * tilePx; px++) {
            const pi = (py * outW + px) * 3;
            if (overlayMode === 'softlight') {
              rawBuf[pi]     = Math.round(rawBuf[pi]     * (1 - strength) + softLight(rawBuf[pi], tr) * strength);
              rawBuf[pi + 1] = Math.round(rawBuf[pi + 1] * (1 - strength) + softLight(rawBuf[pi + 1], tg) * strength);
              rawBuf[pi + 2] = Math.round(rawBuf[pi + 2] * (1 - strength) + softLight(rawBuf[pi + 2], tb) * strength);
            } else {
              rawBuf[pi]     = Math.round(rawBuf[pi]     * (1 - strength) + tr * strength);
              rawBuf[pi + 1] = Math.round(rawBuf[pi + 1] * (1 - strength) + tg * strength);
              rawBuf[pi + 2] = Math.round(rawBuf[pi + 2] * (1 - strength) + tb * strength);
            }
          }
        }
      }
      outputBuf = await sharp(rawBuf, { raw: { width: outW, height: outH, channels: 3 }, limitInputPixels: false })
        .jpeg({ quality: 90 }).toBuffer();
    } else {
      outputBuf = await sharp({
        create: { width: outW, height: outH, channels: 3, background: { r: 128, g: 128, b: 128 } },
        limitInputPixels: false,
      }).composite(compositeInputs).jpeg({ quality: 90 }).toBuffer();
      debugInfo.strengthScale = 'N/A (no overlay)';
    }

    debugInfo.outputSizeBytes = outputBuf.length;
    debugInfo.outputSizeKB = Math.round(outputBuf.length / 1024);

    // Return as multipart: JSON header + JPEG image
    // For simplicity, return JSON with base64 image
    res.json({
      ...debugInfo,
      imageBase64: outputBuf.toString('base64'),
      imageDataUrl: 'data:image/jpeg;base64,' + outputBuf.toString('base64'),
    });
  } catch (e) {
    console.error('[debug/print-render-test] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Customer Order Endpoints ──────────────────────────────────────────────

// POST /api/orders/printolino – create a Printolino print order
app.post('/api/orders/printolino', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { formatLabel, materialLabel, priceChf, customerEmail, userId, projectId, renderParams, photoUrl, mosaicPreviewUrl } = req.body;
    if (!formatLabel || !materialLabel) {
      return res.status(400).json({ error: 'Missing format or material' });
    }
    const orderId = await db.createPrintolinoOrder({
      userId: userId ?? null,
      projectId: projectId ?? null,
      formatLabel,
      materialLabel,
      priceChf: priceChf ?? 0,
      customerEmail: customerEmail ?? null,
      renderParams: renderParams ?? {},
      photoUrl: photoUrl ?? null,
      mosaicPreviewUrl: mosaicPreviewUrl ?? null,
    });
    console.log(`[orders] Created Printolino order #${orderId}: ${formatLabel} / ${materialLabel}`);
    res.json({ ok: true, orderId });
  } catch (e) {
    console.error('[orders] Create failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/orders/upload-user-tile – upload a user tile (base64 JPEG) to R2 for server-side rendering
// Called during order creation when tileIds contain negative IDs (user-uploaded photos)
app.post('/api/orders/upload-user-tile', express.json({ limit: '8mb' }), async (req, res) => {
  try {
    const { imageDataUrl, orderId, tileIndex } = req.body;
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
      return res.status(400).json({ error: 'imageDataUrl required' });
    }
    // Decode base64 data URL
    const matches = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid data URL format' });
    const contentType = matches[1];
    const base64Data = matches[2];
    const imageBuffer = Buffer.from(base64Data, 'base64');
    // Resize to 128px for tile storage
    const resizedBuffer = await sharp(imageBuffer)
      .resize(128, 128, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 90 })
      .toBuffer();
    // Upload to R2 under user-tiles/ prefix
    const key = `user-tiles/order-${orderId ?? 'tmp'}-tile${tileIndex ?? Date.now()}-${Date.now()}.jpg`;
    let r2Url: string | null = null;
    if (isR2Configured()) {
      r2Url = await uploadToR2(key, resizedBuffer, 'image/jpeg', 'public, max-age=31536000, immutable');
    }
    if (!r2Url) {
      // Fallback: return data URL if R2 not configured
      const fallbackDataUrl = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
      return res.json({ ok: true, url: fallbackDataUrl, r2: false });
    }
    res.json({ ok: true, url: r2Url, r2: true });
  } catch (e) {
    console.error('[upload-user-tile] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/admin/orders/:id/render – server-side render print file for an order
app.post('/api/admin/orders/:id/render', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const pool = db.getPool();
    const result = await pool.query('SELECT * FROM mosaic_orders WHERE id = $1', [orderId]);
    const order = result.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const rp = order.render_params || {};
    if (!rp.assignment || !rp.tileIds) {
      return res.status(400).json({ error: 'Order has no render_params (assignment/tileIds missing). Cannot render server-side.' });
    }
    // Mark as rendering
    await pool.query("UPDATE mosaic_orders SET status = 'rendering' WHERE id = $1", [orderId]);
    // Trigger async render
    (async () => {
      try {
        const { cols, rows, format = 'jpg', userOverlay = 0, colorEnhance = 0 } = rp;
        // Color correction data from client (required for quality)
        const targetColors: number[] = rp.targetColors ?? [];
        const edgeMap: number[] = rp.edgeMap ?? [];
        const faceMask: boolean[] = rp.faceMask ?? [];
        // Use 128px tiles (max available from R2 without upscaling)
        // 128px tiles at 400 DPI = 0.81 cm/tile (very close to 1 cm/tile @ 315 DPI)
        // For best quality: use 128px which matches R2 tile resolution exactly
        const tilePx = 128;
        const assignment: number[] = rp.assignment;
        const tileIds: number[] = rp.tileIds;
        // userTileUrls: mapping from negative tileId (as string) to R2 URL
        // e.g. { "-1": "https://tiles.mosaicprint.ch/user-tiles/...", "-2": "..." }
        const userTileUrls: Record<string, string> = rp.userTileUrls ?? {};
        const outW = cols * tilePx;
        const outH = rows * tilePx;
        console.log(`[admin-render] Order #${orderId}: ${cols}x${rows} tiles, ${outW}x${outH}px`);
        // Helper: update progress in DB so admin UI can poll it
        const setProgress = async (pct: number, msg: string) => {
          await pool.query("UPDATE mosaic_orders SET admin_notes = $1 WHERE id = $2", [`${pct}%|${msg}`, orderId]);
        };
        await setProgress(5, 'Tiles werden geladen...');
        // Load all unique tile images
        // assignment[i] = index into tileIds array; tileIds[idx] = actual DB tile ID
        const usedTileIds: number[] = assignment.map((idx: number) => tileIds[idx]);
        // Separate positive DB tile IDs from negative user-uploaded tile IDs
        const uniquePositiveIds = [...new Set(usedTileIds.filter((id: number) => id > 0))];
        const uniqueNegativeIds = [...new Set(usedTileIds.filter((id: number) => id < 0))];
        // Check if user tiles are available via userTileUrls
        const missingUserTiles = uniqueNegativeIds.filter(id => !userTileUrls[String(id)]);
        if (uniquePositiveIds.length === 0 && uniqueNegativeIds.length === 0) {
          throw new Error('No valid tile IDs found in assignment.');
        }
        if (missingUserTiles.length > 0) {
          console.warn(`[admin-render] Order #${orderId}: ${missingUserTiles.length} user tiles have no R2 URL: ${missingUserTiles.slice(0, 5).join(',')}`);
        }
        const tileBuffers = new Map<number, Buffer>();
        // Load DB tiles in batches of 50
        const LOAD_BATCH = 50;
        for (let lb = 0; lb < uniquePositiveIds.length; lb += LOAD_BATCH) {
          const batch = uniquePositiveIds.slice(lb, lb + LOAD_BATCH);
          await Promise.all(batch.map(async (id: number) => {
            const buf = await loadTileBuffer(id, tilePx);
            if (buf) tileBuffers.set(id, buf);
          }));
          if (lb % 500 === 0) {
            const pct = Math.round(5 + (tileBuffers.size / Math.max(uniquePositiveIds.length, 1)) * 40);
            await setProgress(pct, `Tiles laden: ${tileBuffers.size}/${uniquePositiveIds.length}`);
            console.log(`[admin-render] Loaded ${tileBuffers.size}/${uniquePositiveIds.length} DB tiles...`);
          }
        }
        await setProgress(45, `${tileBuffers.size} Tiles geladen`);
        console.log(`[admin-render] Loaded ${tileBuffers.size}/${uniquePositiveIds.length} DB tiles`);
        // Load user tiles from R2 URLs
        if (uniqueNegativeIds.length > 0) {
          console.log(`[admin-render] Loading ${uniqueNegativeIds.length} user tiles from R2...`);
          await Promise.all(uniqueNegativeIds.map(async (id: number) => {
            const url = userTileUrls[String(id)];
            if (!url) return;
            try {
              let buf: Buffer;
              if (url.startsWith('data:')) {
                // Fallback: inline data URL (R2 not configured)
                const base64 = url.split(',')[1];
                buf = Buffer.from(base64, 'base64');
              } else {
                const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) { console.warn(`[admin-render] User tile ${id} fetch failed: ${resp.status}`); return; }
                buf = Buffer.from(await resp.arrayBuffer());
              }
              // Resize to tilePx
              const resized = await sharp(buf)
                .resize(tilePx, tilePx, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 90 })
                .toBuffer();
              tileBuffers.set(id, resized);
            } catch (err) {
              console.warn(`[admin-render] User tile ${id} load error:`, err);
            }
          }));
          console.log(`[admin-render] User tiles loaded: ${uniqueNegativeIds.filter(id => tileBuffers.has(id)).length}/${uniqueNegativeIds.length}`);
        }
        await setProgress(50, 'Mosaik wird zusammengesetzt...');
        // STRIP-BASED COMPOSITING: Process image in horizontal strips to avoid OOM
        // Each strip = STRIP_ROWS tile rows. This keeps memory usage manageable (~60 MB/strip)
        // and avoids repeated JPEG compression artifacts from batch compositing.
        const STRIP_ROWS = 8; // rows of tiles per strip
        const stripCount = Math.ceil(rows / STRIP_ROWS);

        // LAB color transfer helper functions (same as client renderMosaicClientSide)
        const labToRgbAdmin = (L: number, a: number, b: number): [number, number, number] => {
          let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
          x = (x**3 > 0.008856 ? x**3 : (x - 16/116)/7.787) * 0.95047;
          y = (y**3 > 0.008856 ? y**3 : (y - 16/116)/7.787) * 1.00000;
          z = (z**3 > 0.008856 ? z**3 : (z - 16/116)/7.787) * 1.08883;
          const r = x * 3.2406 + y * -1.5372 + z * -0.4986;
          const g = x * -0.9689 + y * 1.8758 + z * 0.0415;
          const bv = x * 0.0557 + y * -0.2040 + z * 1.0570;
          const toSrgb = (c: number) => c > 0.0031308 ? 1.055 * c**(1/2.4) - 0.055 : 12.92 * c;
          return [Math.round(Math.max(0,Math.min(255,toSrgb(r)*255))), Math.round(Math.max(0,Math.min(255,toSrgb(g)*255))), Math.round(Math.max(0,Math.min(255,toSrgb(bv)*255)))];
        };
        const rgbToLabAdmin = (r: number, g: number, b: number): [number, number, number] => {
          const toLinear = (c: number) => { const s = c/255; return s > 0.04045 ? ((s+0.055)/1.055)**2.4 : s/12.92; };
          const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);
          const x = (rl*0.4124 + gl*0.3576 + bl*0.1805)/0.95047;
          const y = (rl*0.2126 + gl*0.7152 + bl*0.0722)/1.00000;
          const z = (rl*0.0193 + gl*0.1192 + bl*0.9505)/1.08883;
          const f = (t: number) => t > 0.008856 ? t**(1/3) : 7.787*t + 16/116;
          return [116*f(y)-16, 500*(f(x)-f(y)), 200*(f(y)-f(z))];
        };
        const softLightAdmin = (base: number, blend: number): number => {
          const bv = blend/255, s = base/255;
          return Math.round(Math.max(0,Math.min(255, (bv<0.5?s-(1-2*bv)*s*(1-s):s+(2*bv-1)*(Math.sqrt(s)-s))*255)));
        };

        // Color correction parameters (matching client renderMosaicClientSide)
        const colorEnhanceVal = colorEnhance / 100;
        const AB_BLEND_BASE = 0.12;
        const AB_BLEND = AB_BLEND_BASE * colorEnhanceVal;
        const L_BLEND = 0.40;
        const MAX_COLOR_SHIFT = 15;
        const MAX_BLUE_SHIFT = 5;
        const cBoost = 1.30;
        const satBoost = 0.90 + cBoost * 0.15;
        const BASE_OL = 0.15;
        const EDGE_B = 0.20;
        const hasColorCorrection = colorEnhance > 0 || targetColors.length > 0;

        // Process each strip
        const stripBuffers: Buffer[] = [];
        for (let s = 0; s < stripCount; s++) {
          const stripRowStart = s * STRIP_ROWS;
          const stripRowEnd = Math.min(stripRowStart + STRIP_ROWS, rows);
          const stripH = (stripRowEnd - stripRowStart) * tilePx;
          // Collect composite ops for this strip
          const stripOps: sharp.OverlayOptions[] = [];
          for (let r2 = stripRowStart; r2 < stripRowEnd; r2++) {
            for (let c2 = 0; c2 < cols; c2++) {
              const ci = r2 * cols + c2;
              const tileId = usedTileIds[ci];
              const buf = tileBuffers.get(tileId);
              if (!buf) continue;
              stripOps.push({ input: buf, left: c2 * tilePx, top: (r2 - stripRowStart) * tilePx });
            }
          }

          // Composite strip (lossless raw)
          const stripRaw = await sharp({
            create: { width: outW, height: stripH, channels: 3, background: { r: 128, g: 128, b: 128 } },
            limitInputPixels: false,
          }).composite(stripOps).raw().toBuffer();

          // Apply LAB color correction per tile cell in this strip
          if (hasColorCorrection) {
            const nCh = 3;
            for (let r2 = stripRowStart; r2 < stripRowEnd; r2++) {
              for (let c2 = 0; c2 < cols; c2++) {
                const ci = r2 * cols + c2;
                const tci = ci * 3;
                const tR = targetColors[tci] ?? 128;
                const tG = targetColors[tci+1] ?? 128;
                const tBv = targetColors[tci+2] ?? 128;
                const [tL, tA, tBlab] = rgbToLabAdmin(tR, tG, tBv);
                const isShadowZone = tL < 40;
                const shadowBoost = isShadowZone ? Math.max(0, (40-tL)/40) : 0;
                const effectiveL_BLEND = Math.min(0.98, L_BLEND + shadowBoost * 0.50);
                const edge = edgeMap[ci] ?? 0;
                const faceBoost = (faceMask[ci] ? 0.04 : 0);
                const str = Math.min(0.30, BASE_OL + edge*EDGE_B + faceBoost);
                const applyOl = str > 0.01 && targetColors.length > 0;

                // Sample tile pixels for avgL
                const px0 = c2 * tilePx, py0 = (r2 - stripRowStart) * tilePx;
                const px1 = Math.min(px0 + tilePx, outW), py1 = Math.min(py0 + tilePx, stripH);
                const totalPx = (px1-px0) * (py1-py0);
                const step = Math.max(1, Math.floor(totalPx / 64));
                let sumL = 0, sampleCount = 0;
                for (let si = 0; si < totalPx; si += step) {
                  const lx = px0 + (si % (px1-px0));
                  const ly = py0 + Math.floor(si / (px1-px0));
                  const pi = (ly * outW + lx) * nCh;
                  sumL += rgbToLabAdmin(stripRaw[pi], stripRaw[pi+1], stripRaw[pi+2])[0];
                  sampleCount++;
                }
                const avgL = sampleCount > 0 ? sumL / sampleCount : 50;
                const rawLumScale = avgL > 1 ? tL / avgL : 1;
                const clampedLumScale = Math.max(0.05, Math.min(4.0, isShadowZone ? Math.min(1.0, rawLumScale) : rawLumScale));
                const lumScale = 1 + (clampedLumScale - 1) * effectiveL_BLEND;

                // Apply per-pixel LAB transfer + overlay
                for (let py = py0; py < py1; py++) {
                  for (let px = px0; px < px1; px++) {
                    const pi = (py * outW + px) * nCh;
                    const [pl, pa, pb] = rgbToLabAdmin(stripRaw[pi], stripRaw[pi+1], stripRaw[pi+2]);
                    let newL = Math.max(0, Math.min(100, pl * lumScale));
                    if (isShadowZone && shadowBoost > 0.05) {
                      const dev = pl - avgL;
                      newL = Math.max(0, Math.min(100, newL + dev * (1.0 + shadowBoost*0.4 - 1.0)));
                    }
                    if (isShadowZone && newL > tL + 25) newL = tL + 25 + (newL - tL - 25) * 0.2;
                    const rawDeltaA = (tA - pa) * AB_BLEND;
                    const rawDeltaB = (tBlab - pb) * AB_BLEND;
                    const clampedDA = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, rawDeltaA));
                    const clampedDB = rawDeltaB < 0 ? Math.max(-MAX_BLUE_SHIFT, rawDeltaB) : Math.min(MAX_COLOR_SHIFT, rawDeltaB);
                    const newA = Math.max(-128, Math.min(127, pa + clampedDA));
                    const newBv2 = Math.max(-128, Math.min(127, pb + clampedDB));
                    const contrastL = Math.max(0, Math.min(100, 50 + (newL-50)*cBoost));
                    const bSatBoost = newBv2 < 0 ? Math.min(satBoost, 1.0) : satBoost;
                    let [nr, ng, nb] = labToRgbAdmin(contrastL, Math.max(-128,Math.min(127,newA*satBoost)), Math.max(-128,Math.min(127,newBv2*bSatBoost)));
                    if (applyOl) {
                      nr = Math.round(nr*(1-str) + softLightAdmin(nr,tR)*str);
                      ng = Math.round(ng*(1-str) + softLightAdmin(ng,tG)*str);
                      nb = Math.round(nb*(1-str) + softLightAdmin(nb,tBv)*str);
                    }
                    stripRaw[pi] = nr; stripRaw[pi+1] = ng; stripRaw[pi+2] = nb;
                  }
                }
              }
            }
          }

          // Encode strip as JPEG for final assembly
          const stripJpeg = await sharp(stripRaw, {
            raw: { width: outW, height: stripH, channels: 3 },
            limitInputPixels: false,
          }).jpeg({ quality: 92 }).toBuffer();
          stripBuffers.push(stripJpeg);

          const pct = Math.round(50 + ((s + 1) / stripCount) * 40);
          await setProgress(pct, `Rendering: Strip ${s + 1}/${stripCount}`);
          console.log(`[admin-render] Strip ${s+1}/${stripCount} done (rows ${stripRowStart}-${stripRowEnd})`);
        }

        // Assemble all strips into final image
        await setProgress(90, 'Strips werden zusammengesetzt...');
        const stripCompositeOps: sharp.OverlayOptions[] = stripBuffers.map((buf, i) => ({
          input: buf,
          top: i * STRIP_ROWS * tilePx,
          left: 0,
        }));
        let baseBuf = await sharp({
          create: { width: outW, height: outH, channels: 3, background: { r: 128, g: 128, b: 128 } },
          limitInputPixels: false,
        }).composite(stripCompositeOps).jpeg({ quality: 92 }).toBuffer();
        console.log(`[admin-render] All ${stripCount} strips assembled`);
        await setProgress(92, 'Bild wird auf R2 hochgeladen...');
        // Upload to R2
        const filename = `orders/order-${orderId}-${Date.now()}.jpg`;
        const r2Url = await (async () => {
          if (!isR2Configured()) return null;
          const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
          const s3 = new S3Client({
            region: 'auto',
            endpoint: process.env.R2_ENDPOINT,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
          });
          await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: filename,
            Body: baseBuf,
            ContentType: 'image/jpeg',
          }));
          return `${process.env.R2_PUBLIC_URL}/${filename}`;
        })();
        if (r2Url) {
          await pool.query("UPDATE mosaic_orders SET status = 'ready', download_token = $1 WHERE id = $2", [r2Url, orderId]);
          console.log(`[admin-render] Order #${orderId} ready: ${r2Url}`);
        } else {
          await pool.query("UPDATE mosaic_orders SET status = 'render_error', admin_notes = 'R2 not configured' WHERE id = $1", [orderId]);
        }
      } catch (renderErr) {
        console.error(`[admin-render] Order #${orderId} failed:`, renderErr);
        await pool.query("UPDATE mosaic_orders SET status = 'render_error', admin_notes = $1 WHERE id = $2", [String(renderErr), orderId]);
      }
    })();
    res.json({ ok: true, message: 'Rendering started', orderId });
  } catch (e) {
    console.error('[admin-render] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/admin/orders – list all orders for admin
app.get('/api/admin/orders', async (_req, res) => {
  try {
    const orders = await db.getMosaicOrders();
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/admin/orders/:id/download – proxy R2 file as attachment (avoids CORS issues)
app.get('/api/admin/orders/:id/download', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const pool = db.getPool();
    const result = await pool.query('SELECT download_token FROM mosaic_orders WHERE id = $1', [orderId]);
    const order = result.rows[0];
    if (!order || !order.download_token || !order.download_token.startsWith('http')) {
      return res.status(404).json({ error: 'Kein Download-Link für diese Bestellung' });
    }
    const url = order.download_token as string;
    const ext = url.toLowerCase().includes('.png') ? 'png' : 'jpg';
    const filename = `mosaicprint-bestellung-${orderId}.${ext}`;
    // Fetch from R2 and stream to client as attachment
    const r2Res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!r2Res.ok) return res.status(502).json({ error: `R2 Fehler: ${r2Res.status}` });
    const contentType = r2Res.headers.get('content-type') || (ext === 'png' ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const contentLength = r2Res.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    // Stream response body
    if (r2Res.body) {
      const reader = r2Res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
  } catch (e) {
    console.error('[download-proxy]', e);
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});

// POST /api/admin/orders/:id/status – update order status
app.post('/api/admin/orders/:id/status', express.json(), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { status, downloadToken } = req.body;
    if (!status) return res.status(400).json({ error: 'Missing status' });
    if (downloadToken) {
      // Update status AND store the R2 download URL in download_token
      const pool = db.getPool();
      await pool.query(
        'UPDATE mosaic_orders SET status = $1, download_token = $2 WHERE id = $3',
        [status, downloadToken, orderId]
      );
    } else {
      await db.updateOrderStatus(orderId, status);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/admin/orders/:id/notes – update admin notes
app.post('/api/admin/orders/:id/notes', express.json(), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { notes } = req.body;
    await db.updateOrderNotes(orderId, notes ?? '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/admin/orders/:id/preview-url – update mosaic_preview_url (after admin adjusts overlay in Studio)
app.post('/api/admin/orders/:id/preview-url', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { previewDataUrl } = req.body;
    if (!previewDataUrl) return res.status(400).json({ error: 'Missing previewDataUrl' });

    let finalUrl = previewDataUrl;

    // If R2 is configured, upload the preview image to R2
    if (isR2Configured()) {
      try {
        // Convert data URL to buffer
        const base64 = previewDataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        // Resize to max 1200px for preview
        const resized = await sharp(buf).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        const key = `order-previews/order-${orderId}-preview-${Date.now()}.jpg`;
        finalUrl = await uploadToR2(key, resized, 'image/jpeg', 'public, max-age=86400');
      } catch (e) {
        console.warn('[preview-url] R2 upload failed, storing data URL:', e);
        // Fall back to storing data URL directly (not ideal but functional)
      }
    }

    await db.updateOrderPreviewUrl(orderId, finalUrl);
    res.json({ ok: true, url: finalUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/admin/migrate-to-r2 – migrate existing tiles to R2 storage
// Runs in background, returns job status via GET /api/admin/migrate-to-r2/status
const r2MigrationStatus = {
  running: false, done: 0, total: 0, errors: 0,
  skippedHotlink: 0, skippedNoUrl: 0, retried: 0,
  startedAt: null as string | null, finishedAt: null as string | null,
  lastError: '' as string,
};

// Helper: is this URL a hotlink-protected URL that cannot be downloaded server-side?
function isHotlinkProtected(url: string): boolean {
  if (!url) return false;
  // Pixabay hotlink-protected download URLs
  if (url.includes('pixabay.com/get/') || url.includes('pixabay.com/download/')) return true;
  // Pexels download URLs with auth tokens
  if (url.includes('pexels.com/photo/') && url.includes('?auto=compress')) return false; // CDN ok
  if (url.includes('images.pexels.com') && url.includes('cs=tinysrgb')) return false; // CDN ok
  return false;
}

// Helper: download with retry on rate-limit (429) or transient errors
async function downloadWithRetry(tileId: number, url: string, maxRetries = 2): Promise<string | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MosaicPrint/1.0)',
          'Accept': 'image/webp,image/jpeg,image/*,*/*',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (resp.status === 429 || resp.status === 503) {
        // Rate limited – wait and retry
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          r2MigrationStatus.retried++;
          continue;
        }
        return null;
      }
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 500) return null; // too small = error page
      const { uploadTileToR2 } = await import('./r2.js');
      return await uploadTileToR2(tileId, buf);
    } catch {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

app.post('/api/admin/migrate-to-r2', async (_req, res) => {
  if (!isR2Configured()) return res.status(400).json({ error: 'R2 not configured' });
  if (r2MigrationStatus.running) return res.json({ started: false, message: 'Already running', status: r2MigrationStatus });
  r2MigrationStatus.running = true;
  r2MigrationStatus.done = 0;
  r2MigrationStatus.errors = 0;
  r2MigrationStatus.skippedHotlink = 0;
  r2MigrationStatus.skippedNoUrl = 0;
  r2MigrationStatus.retried = 0;
  r2MigrationStatus.lastError = '';
  r2MigrationStatus.startedAt = new Date().toISOString();
  r2MigrationStatus.finishedAt = null;
  res.json({ started: true, message: 'Migration started in background' });
  // Run migration in background
  (async () => {
    try {
      const pool = db.getPool();
      // Get all tiles without R2 URL
      const result = await pool.query(
        `SELECT id, source_url, tile128_url, source_provider FROM mosaic_images WHERE r2_url IS NULL ORDER BY id ASC`
      );
      r2MigrationStatus.total = result.rows.length;
      console.log(`[R2 Migration] Starting migration of ${result.rows.length} tiles`);
      // Reduced concurrency to avoid rate limiting
      const CONCURRENCY = 5;
      for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
        const batch = result.rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (row: { id: number; source_url: string; tile128_url: string; source_provider: string }) => {
          try {
            // Try tile128_url first (smaller, faster), then source_url as fallback
            // If tile128_url is hotlink-protected (e.g. Pixabay), try source_url instead
            let url = row.tile128_url || '';
            if (!url || url.startsWith('data:') || isHotlinkProtected(url)) {
              url = row.source_url || '';
            }
            if (!url || url.startsWith('data:')) {
              r2MigrationStatus.skippedNoUrl++;
              r2MigrationStatus.done++;
              return;
            }
            if (isHotlinkProtected(url)) {
              // Both tile128_url and source_url are hotlink-protected → skip
              r2MigrationStatus.skippedHotlink++;
              r2MigrationStatus.done++;
              return;
            }
            const r2Url = await downloadWithRetry(row.id, url);
            if (r2Url) {
              await pool.query('UPDATE mosaic_images SET r2_url = $1 WHERE id = $2', [r2Url, row.id]);
              tileUrlCache.delete(row.id);
            } else {
              r2MigrationStatus.errors++;
              r2MigrationStatus.lastError = `Tile ${row.id}: ${url.substring(0, 80)}`;
            }
            r2MigrationStatus.done++;
          } catch (e) {
            r2MigrationStatus.errors++;
            r2MigrationStatus.lastError = String(e).substring(0, 120);
            r2MigrationStatus.done++;
          }
        }));
        // Small delay between batches to avoid rate limiting
        if (i % 100 === 0 && i > 0) {
          await new Promise(r => setTimeout(r, 200));
          console.log(`[R2 Migration] Progress: ${r2MigrationStatus.done}/${r2MigrationStatus.total} (errors: ${r2MigrationStatus.errors}, hotlinks: ${r2MigrationStatus.skippedHotlink})`);
        }
      }
    } catch (e) {
      console.error('[R2 Migration] Error:', e);
      r2MigrationStatus.lastError = String(e).substring(0, 200);
    } finally {
      r2MigrationStatus.running = false;
      r2MigrationStatus.finishedAt = new Date().toISOString();
      console.log(`[R2 Migration] Done: ${r2MigrationStatus.done} tiles, ${r2MigrationStatus.errors} errors, ${r2MigrationStatus.skippedHotlink} hotlinks skipped`);
    }
  })();
});
app.get('/api/admin/migrate-to-r2/status', (_req, res) => {
  res.json(r2MigrationStatus);
});

// GET /api/admin/r2-diagnosis – Analysiert wie viele Tiles wirklich auf R2 sind
app.get('/api/admin/r2-diagnosis', async (_req, res) => {
  try {
    const pool = db.getPool();
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN r2_url IS NOT NULL THEN 1 ELSE 0 END) as on_r2,
        SUM(CASE WHEN r2_url IS NULL AND (tile128_url LIKE '%pixabay.com/get/%' OR tile128_url LIKE '%pixabay.com/download/%') THEN 1 ELSE 0 END) as pixabay_hotlink,
        SUM(CASE WHEN r2_url IS NULL AND tile128_url IS NULL AND source_url IS NULL THEN 1 ELSE 0 END) as no_url,
        SUM(CASE WHEN r2_url IS NULL AND tile128_url IS NOT NULL AND tile128_url NOT LIKE '%pixabay.com/get/%' THEN 1 ELSE 0 END) as migratable,
        SUM(CASE WHEN r2_url IS NULL THEN 1 ELSE 0 END) as missing_r2
      FROM mosaic_images
    `);
    const providerStats = await pool.query(`
      SELECT source_provider, COUNT(*) as total,
        SUM(CASE WHEN r2_url IS NOT NULL THEN 1 ELSE 0 END) as on_r2,
        SUM(CASE WHEN r2_url IS NULL THEN 1 ELSE 0 END) as missing
      FROM mosaic_images
      GROUP BY source_provider
      ORDER BY total DESC
    `);
    res.json({ ok: true, stats: stats.rows[0], byProvider: providerStats.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Debug: Test first R2 URL ──────────────────────────────────────────────────────────────
app.get('/api/admin/ai-debug', async (_req, res) => {
  try {
    const pool = db.getPool();
    const r = await pool.query(`SELECT id, r2_url, tile128_url FROM mosaic_images WHERE r2_url IS NOT NULL LIMIT 1`);
    if (!r.rows.length) return res.json({ ok: false, error: 'No tiles with r2_url' });
    const tile = r.rows[0];
    const url = tile.r2_url;
    // Test if URL is reachable
    let downloadOk = false;
    let downloadError = '';
    let contentType = '';
    let size = 0;
    try {
      const imgRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
      downloadOk = imgRes.ok;
      contentType = imgRes.headers.get('content-type') ?? '';
      const buf = await imgRes.arrayBuffer();
      size = buf.byteLength;
      if (!imgRes.ok) downloadError = `HTTP ${imgRes.status}`;
    } catch (e) { downloadError = String(e); }
    // Test Gemini call
    let geminiOk = false;
    let geminiError = '';
    let geminiResponse = '';
    if (downloadOk && size > 0) {
      try {
        const GEMINI_KEY = process.env.GEMINI_API_KEY;
        if (!GEMINI_KEY) { geminiError = 'GEMINI_API_KEY not set'; }
        else {
          // Re-download for base64
          const imgRes2 = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const imgBuf2 = await imgRes2.arrayBuffer();
          const base64 = Buffer.from(imgBuf2).toString('base64');
          const gRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [
                  { text: 'Describe this image in 5 words.' },
                  { inline_data: { mime_type: 'image/jpeg', data: base64 } }
                ]}],
                generationConfig: { maxOutputTokens: 50 },
              }),
              signal: AbortSignal.timeout(20000),
            }
          );
          geminiOk = gRes.ok;
          const gData = await gRes.json() as any;
          if (gRes.ok) {
            geminiResponse = gData.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(gData).substring(0, 200);
          } else {
            geminiError = JSON.stringify(gData).substring(0, 300);
          }
        }
      } catch (e) { geminiError = String(e); }
    }
    // Also list available models
    let availableModels: string[] = [];
    try {
      const GEMINI_KEY2 = process.env.GEMINI_API_KEY;
      if (GEMINI_KEY2) {
        const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY2}`, { signal: AbortSignal.timeout(10000) });
        const listData = await listRes.json() as any;
        availableModels = (listData.models ?? []).filter((m: any) => m.supportedGenerationMethods?.includes('generateContent')).map((m: any) => m.name);
      }
    } catch (e) { availableModels = [`error: ${e}`]; }
    res.json({ ok: true, tile: { id: tile.id, r2_url: url?.substring(0, 100) }, download: { ok: downloadOk, contentType, size, error: downloadError }, gemini: { ok: geminiOk, response: geminiResponse, error: geminiError }, availableModels });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── Gemini Vision Batch-Analyse (Background-Job, kein HTTP-Timeout) ──────────────────────
// Background job state
const aiJobState = {
  running: false,
  processed: 0,
  total: 0,
  rejected: 0,
  errors: 0,
  startedAt: null as Date | null,
  finishedAt: null as Date | null,
  lastError: null as string | null,
  batchSize: 0,
};

async function runGeminiAnalysisJob(batchSize: number, forceReanalyze: boolean, GEMINI_KEY: string) {
  const pool = db.getPool();
  // v7 re-analysis: always re-analyze all tiles since prompt changed significantly
  // Include tiles with r2_url OR tile128_url (covers LHQ tiles that have no r2_url)
  // IMPORTANT: In PostgreSQL, NULL != 'rejected' evaluates to NULL (not TRUE)!
  // So we must use COALESCE or explicit NULL check to include tiles with quality_status IS NULL.
  const whereClause = forceReanalyze
    ? `(r2_url IS NOT NULL OR tile128_url IS NOT NULL) AND (quality_status IS NULL OR quality_status != 'rejected')`
    : `(r2_url IS NOT NULL OR tile128_url IS NOT NULL) AND (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND (quality_status IS NULL OR quality_status != 'rejected')`;
  const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images WHERE ${whereClause}`);
  const total = Number(countRes.rows[0]?.cnt ?? 0);
  aiJobState.total = total;
  aiJobState.processed = 0;
  aiJobState.rejected = 0;
  aiJobState.errors = 0;

  const CONCURRENCY = 15;           // Erhöht auf 15 für ~5000/h Durchsatz
  const RATE_LIMIT_DELAY_MS = 200;  // 200ms zwischen Chunks = ~75 req/s gesamt

  const PROMPT = `You are a strict quality evaluator for photo mosaic tiles. Each tile is a 128x128px image used as one pixel in a large portrait mosaic (like the "redhead" mosaic style where thousands of photos form a face).

The IDEAL tile for a portrait mosaic:
- Is monochromatic or at most two-toned (e.g. blue sky, orange sunset, beige sand, green meadow)
- Has NO dominant single object (no single animal, single flower, single person, single building)
- Fills the entire frame with color/texture (landscape, sky, water, bokeh, abstract gradient, sand, fog)
- Is visually calm and smooth – the color is the message, not the subject
- Examples of EXCELLENT tiles: clear blue sky, orange sunset horizon, sandy beach, foggy mountain, bokeh lights, smooth water surface, autumn leaves carpet, snow field, desert sand dunes
- Examples of POOR tiles: a single elephant, a single flower, a single bird, a single building, a logo, a face

Return ONLY valid JSON with these exact fields:
{
  "mosaic_score": 0-100,
  "calm_score": 0-100,
  "color_richness": 0-100,
  "fill_uniformity": 0-100,
  "has_face": true|false,
  "face_area_pct": 0-100,
  "has_text": true|false,
  "reject": true|false,
  "reject_reason": "watermark|face_closeup|blurry|logo|text_overlay|single_object|low_quality|null",
  "theme": "sky_blue|sky_cloudy|sunset_orange|sunset_red|sunset_pink|water_ocean|water_lake|water_river|sand_desert|sand_beach|snow_field|fog_mist|forest_green|meadow_grass|autumn_leaves|bokeh_warm|bokeh_cool|bokeh_neutral|abstract_gradient|abstract_texture|rock_stone|urban_texture|portrait_skin_light|portrait_skin_medium|portrait_skin_dark|other",
  "content_tags": ["tag1", "tag2", "tag3"]
}

Scoring rules (BE STRICT – only 20-30% of tiles should score ≥80):
- mosaic_score (0-100): Suitability as mosaic tile for portrait creation.
  * 85-100: EXCELLENT – monochrome/two-tone, no dominant object, fills frame with pure color/texture (sky, sunset, water, sand, bokeh, snow, fog, gradient)
  * 65-84: GOOD – mostly one color zone, minimal objects, landscape with clear horizon
  * 40-64: ACCEPTABLE – some texture variety, small objects in background
  * 0-39: POOR – dominant single object (animal, flower, building, person), busy pattern, logo, text
  STRONG PENALTIES: single animal visible (-45), single flower/plant as main subject (-40), single building/architecture as main subject (-35), person/face visible (-30), logo/brand (-50), watermark (-80), text overlay (-40), heavy noise/blur (-30), multiple unrelated objects (-25)
  BONUSES: pure sky +15, smooth water +15, bokeh background +15, sand/desert +10, snow field +10, fog/mist +10, smooth gradient +10
- calm_score (0-100): Visual smoothness and uniformity.
  * 85-100: Solid color, very smooth gradient, pure sky, calm water surface
  * 60-84: Gentle texture (grass, sand, bokeh), soft clouds
  * 30-59: Moderate detail, some texture variation
  * 0-29: Chaotic, busy, many details, animals, crowds
- color_richness (0-100): Number of distinct color zones. 0-20=monochrome, 21-50=two-tone, 51-80=moderate, 81-100=many colors
- fill_uniformity (0-100): Does the image fill the entire frame with one coherent scene? 90-100=yes, perfectly. 50-89=mostly. 0-49=fragmented or subject isolated on background.
- reject=true ONLY if: visible watermark, face fills >50% of tile, severely blurry/noisy, explicit logo/brand overlay.
Return ONLY the JSON object, no explanation, no markdown.`;

  const themeMap: Record<string, string> = {
    // New precise themes
    'sky_blue': 'nature_sky', 'sky_cloudy': 'nature_sky',
    'sunset_orange': 'nature_sunset', 'sunset_red': 'nature_sunset', 'sunset_pink': 'nature_sunset',
    'water_ocean': 'nature_ocean', 'water_lake': 'nature_ocean', 'water_river': 'nature_ocean',
    'sand_desert': 'nature_desert', 'sand_beach': 'nature_beach',
    'snow_field': 'nature_snow', 'fog_mist': 'nature_fog',
    'forest_green': 'nature_forest', 'meadow_grass': 'nature_meadow',
    'autumn_leaves': 'nature_autumn',
    'bokeh_warm': 'abstract_bokeh', 'bokeh_cool': 'abstract_bokeh', 'bokeh_neutral': 'abstract_bokeh',
    'abstract_gradient': 'abstract_gradient', 'abstract_texture': 'abstract_texture',
    'rock_stone': 'nature_rock', 'urban_texture': 'city_texture',
    'portrait_skin_light': 'portrait_light_skin', 'portrait_skin_medium': 'portrait_medium_skin', 'portrait_skin_dark': 'portrait_dark_skin',
    // Legacy themes (backward compat)
    'portrait_face': 'portrait_medium_skin', 'portrait_skin': 'portrait_medium_skin',
    'nature_forest': 'nature_forest', 'nature_mountain': 'nature_mountain',
    'nature_ocean': 'nature_ocean', 'nature_sunset': 'nature_sunset',
    'nature_snow': 'nature_snow', 'city_night': 'city_night',
    'city_architecture': 'city_architecture', 'animal': 'animal_colorful',
    'abstract_colorful': 'abstract_colorful', 'abstract_dark': 'city_night',
    'abstract_light': 'nature_snow', 'food': 'nature_sunset', 'other': 'nature_mountain',
  };

  // Process in chunks of batchSize
  let offset = 0;
  while (aiJobState.running) {
    const idsRes = await pool.query(
      `SELECT id, r2_url, tile128_url FROM mosaic_images WHERE ${whereClause} ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [Math.min(batchSize, 500), offset]
    );
    const tiles = idsRes.rows;
    if (tiles.length === 0) break;

    for (let i = 0; i < tiles.length; i += CONCURRENCY) {
      if (!aiJobState.running) break;
      const chunk = tiles.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (tile: any) => {
        const imageUrl = tile.r2_url || tile.tile128_url;
        try {
          let imageBase64: string;
          let mimeType = 'image/jpeg';
          try {
            const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
            if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
            const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
            mimeType = contentType.split(';')[0].trim() || 'image/jpeg';
            const imgBuf = await imgRes.arrayBuffer();
            imageBase64 = Buffer.from(imgBuf).toString('base64');
          } catch (downloadErr) {
            aiJobState.errors++;
            return;
          }

          const geminiResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [
                  { text: PROMPT },
                  { inline_data: { mime_type: mimeType, data: imageBase64 } }
                ]}],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 256 },
              }),
              signal: AbortSignal.timeout(30000),
            }
          );

          let aiResult: any = {};
          if (geminiResp.ok) {
            const geminiData = await geminiResp.json() as any;
            const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
            try { aiResult = JSON.parse(rawText); } catch { aiResult = {}; }
          } else if (geminiResp.status === 429 || geminiResp.status === 503) {
            // Rate limit (429) or overload (503): exponential backoff, retry up to 3x
            const baseDelay = geminiResp.status === 429 ? 30000 : 5000;
            let retrySuccess = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              const waitMs = baseDelay * attempt;
              console.warn(`[ai-job] HTTP ${geminiResp.status} for tile ${tile.id}, attempt ${attempt}/3, waiting ${waitMs}ms...`);
              await new Promise(r => setTimeout(r, waitMs));
              const retryResp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }]}],
                    generationConfig: { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 256 },
                  }),
                  signal: AbortSignal.timeout(30000),
                }
              );
              if (retryResp.ok) {
                const retryData = await retryResp.json() as any;
                const rawText = retryData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
                try { aiResult = JSON.parse(rawText); } catch { aiResult = {}; }
                retrySuccess = true;
                break;
              } else if (retryResp.status !== 429 && retryResp.status !== 503) {
                break; // Non-retryable error
              }
            }
            if (!retrySuccess) {
              console.warn(`[ai-job] All retries failed for tile ${tile.id}`);
              aiJobState.errors++;
              aiJobState.lastError = `Tile ${tile.id}: HTTP ${geminiResp.status} (all retries failed)`;
              return;
            }
          } else {
            const errText = await geminiResp.text();
            console.warn(`[ai-job] Gemini error for tile ${tile.id}: ${geminiResp.status} ${errText.substring(0, 100)}`);
            aiJobState.errors++;
            aiJobState.lastError = `Tile ${tile.id}: HTTP ${geminiResp.status}`;
            return;
          }

          const mappedTheme = themeMap[aiResult.theme] ?? 'nature_mountain';

          // Derive suitability from mosaic_score for backward compat
          const mosaicScore = Math.max(0, Math.min(100, Number(aiResult.mosaic_score ?? 70)));
          const calmScore   = Math.max(0, Math.min(100, Number(aiResult.calm_score ?? 50)));
          const colorRich   = Math.max(0, Math.min(100, Number(aiResult.color_richness ?? 50)));
          const fillUnif    = Math.max(0, Math.min(100, Number(aiResult.fill_uniformity ?? 70)));
          const isReject    = aiResult.reject === true || mosaicScore < 20;
          const suitability = isReject ? 'reject' : mosaicScore >= 80 ? 'excellent' : mosaicScore >= 55 ? 'good' : 'poor';
          const isCalm      = calmScore >= 60; // calm_score >= 60 → calm tile

          // Also update quality_status: 'rejected' for rejects, 'ok' for accepted tiles
          const newQualityStatus = isReject ? 'rejected' : 'ok';
          await pool.query(
            `UPDATE mosaic_images SET
               ai_suitability = $1, ai_reject_reason = $2, ai_theme = $3,
               ai_has_face = $4, ai_face_pct = $5, ai_is_calm = $6,
               ai_content_tags = $7, ai_analyzed_at = NOW(), semantic_theme = $3,
               ai_mosaic_score = $9, ai_calm_score = $10,
               ai_color_richness = $11, ai_fill_uniformity = $12, ai_has_text = $13,
               quality_status = $14
             WHERE id = $8`,
            [
              suitability,
              aiResult.reject_reason === 'null' ? null : (aiResult.reject_reason ?? null),
              mappedTheme, aiResult.has_face ?? false, aiResult.face_area_pct ?? 0,
              isCalm, JSON.stringify(aiResult.content_tags ?? []), tile.id,
              mosaicScore, calmScore, colorRich, fillUnif, aiResult.has_text ?? false,
              newQualityStatus,
            ]
          );

          if (isReject) aiJobState.rejected++;
          aiJobState.processed++;
        } catch (err) {
          aiJobState.errors++;
          aiJobState.lastError = String(err).substring(0, 200);
        }
      }));
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
    offset += tiles.length;
    if (tiles.length < Math.min(batchSize, 500)) break; // last chunk
  }

  invalidateIndexCache();
  aiJobState.running = false;
  aiJobState.finishedAt = new Date();
  console.log(`[ai-job] Done: ${aiJobState.processed} processed, ${aiJobState.rejected} rejected, ${aiJobState.errors} errors`);
}

// POST /api/admin/ai-analyze-batch
// Body: { batchSize?: number, forceReanalyze?: boolean }
// Starts background job, returns immediately with job status
app.post('/api/admin/ai-analyze-batch', express.json(), async (req, res) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not configured' });

  if (aiJobState.running) {
    return res.json({ ok: true, started: false, message: 'Job läuft bereits', state: aiJobState });
  }

  const batchSize = Math.min(Number(req.body?.batchSize ?? 500), 30000);
  const forceReanalyze = req.body?.forceReanalyze === true;

  aiJobState.running = true;
  aiJobState.startedAt = new Date();
  aiJobState.finishedAt = null;
  aiJobState.lastError = null;
  aiJobState.batchSize = batchSize;

  // Start job in background (don't await)
  runGeminiAnalysisJob(batchSize, forceReanalyze, GEMINI_KEY).catch(err => {
    console.error('[ai-job] Unhandled error:', err);
    aiJobState.running = false;
    aiJobState.lastError = String(err);
  });

  res.json({ ok: true, started: true, message: `Background-Job gestartet für bis zu ${batchSize} Tiles`, state: aiJobState });
});

// POST /api/admin/ai-analyze-stop
// Stops the running background job
app.post('/api/admin/ai-analyze-stop', (_req, res) => {
  if (!aiJobState.running) return res.json({ ok: true, message: 'Kein Job läuft' });
  aiJobState.running = false;
  res.json({ ok: true, message: 'Job wird gestoppt...' });
});

// GET /api/admin/ai-analyze-job-status
// Returns current job state
app.get('/api/admin/ai-analyze-job-status', (_req, res) => {
  res.json({ ok: true, state: aiJobState });
});

// GET /api/admin/ai-analyze-stats
// Returns statistics about AI analysis progress
app.get('/api/admin/ai-analyze-stats', async (_req, res) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(ai_analyzed_at) as analyzed,
        COUNT(*) FILTER (WHERE ai_mosaic_score IS NOT NULL) as analyzed_v7,
        COUNT(*) FILTER (WHERE (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND r2_url IS NOT NULL AND (quality_status IS NULL OR quality_status != 'rejected')) as pending_with_r2,
        COUNT(*) FILTER (WHERE (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND tile128_url IS NOT NULL AND r2_url IS NULL AND (quality_status IS NULL OR quality_status != 'rejected')) as pending_lhq_only,
        COUNT(*) FILTER (WHERE (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND (r2_url IS NOT NULL OR tile128_url IS NOT NULL) AND (quality_status IS NULL OR quality_status != 'rejected')) as pending_total,
        COUNT(*) FILTER (WHERE ai_suitability = 'excellent') as excellent,
        COUNT(*) FILTER (WHERE ai_suitability = 'good') as good,
        COUNT(*) FILTER (WHERE ai_suitability = 'poor') as poor,
        COUNT(*) FILTER (WHERE ai_suitability = 'reject') as rejected_ai,
        COUNT(*) FILTER (WHERE ai_has_face = true) as has_face,
        COUNT(*) FILTER (WHERE ai_has_text = true) as has_text,
        COUNT(*) FILTER (WHERE ai_reject_reason = 'watermark') as watermark,
        COUNT(*) FILTER (WHERE ai_reject_reason = 'face_closeup') as face_closeup,
        ROUND(AVG(ai_mosaic_score)) as avg_mosaic_score,
        ROUND(AVG(ai_calm_score)) as avg_calm_score,
        ROUND(AVG(ai_color_richness)) as avg_color_richness,
        ROUND(AVG(ai_fill_uniformity)) as avg_fill_uniformity
      FROM mosaic_images
    `);
    res.json({ ok: true, stats: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── AI Pending Diagnose ──────────────────────────────────────────────────────
app.get('/api/admin/ai-pending-debug', async (_req, res) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE (r2_url IS NOT NULL OR tile128_url IS NOT NULL) AND (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND (quality_status IS NULL OR quality_status != 'rejected')) as whereClause_count,
        COUNT(*) FILTER (WHERE tile128_url IS NOT NULL AND r2_url IS NULL) as lhq_only_count,
        COUNT(*) FILTER (WHERE tile128_url IS NOT NULL AND r2_url IS NULL AND ai_mosaic_score IS NULL) as lhq_not_analyzed,
        COUNT(*) FILTER (WHERE tile128_url IS NOT NULL AND r2_url IS NULL AND ai_analyzed_at IS NULL) as lhq_no_analyzed_at,
        COUNT(*) FILTER (WHERE tile128_url IS NOT NULL AND r2_url IS NULL AND quality_status = 'pending') as lhq_pending_status,
        COUNT(*) FILTER (WHERE tile128_url IS NOT NULL AND r2_url IS NULL AND quality_status = 'rejected') as lhq_rejected_status,
        COUNT(*) FILTER (WHERE tile128_url IS NOT NULL AND r2_url IS NULL AND quality_status IS NULL) as lhq_null_status,
        -- Pending images breakdown
        COUNT(*) FILTER (WHERE quality_status = 'pending') as total_pending,
        COUNT(*) FILTER (WHERE quality_status = 'pending' AND r2_url IS NOT NULL) as pending_has_r2,
        COUNT(*) FILTER (WHERE quality_status = 'pending' AND tile128_url IS NOT NULL) as pending_has_tile128,
        COUNT(*) FILTER (WHERE quality_status = 'pending' AND source_url IS NOT NULL) as pending_has_source,
        COUNT(*) FILTER (WHERE quality_status = 'pending' AND r2_url IS NULL AND tile128_url IS NULL AND source_url IS NULL) as pending_no_url,
        COUNT(*) FILTER (WHERE quality_status = 'pending' AND r2_url IS NULL AND tile128_url IS NULL AND source_url IS NOT NULL) as pending_source_only
      FROM mosaic_images
    `);
    // Also get a sample of NULL-status images
    const sample = await pool.query(`
      SELECT id, source_url, tile128_url, r2_url, quality_status, ai_analyzed_at, ai_mosaic_score, ai_suitability
      FROM mosaic_images
      WHERE quality_status IS NULL
      LIMIT 5
    `);
    // Count NULL-status by ai_suitability
    const nullBreakdown = await pool.query(`
      SELECT
        COALESCE(ai_suitability, 'NULL') as suitability,
        COUNT(*) as cnt,
        COUNT(ai_mosaic_score) as has_score,
        COUNT(ai_analyzed_at) as has_analyzed_at
      FROM mosaic_images
      WHERE quality_status IS NULL
      GROUP BY ai_suitability
      ORDER BY cnt DESC
    `);
    res.json({ ok: true, debug: result.rows[0], sample: sample.rows, nullBreakdown: nullBreakdown.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── AI Cleanup: Rejects und Poor-Tiles entfernen ─────────────────────────────
app.post('/api/admin/ai-cleanup-rejects', async (req, res) => {
  try {
    const pool = db.getPool();
    const { deletePoor = false, mosaicScoreThreshold = 30 } = req.body || {};

    // 1. Rejects löschen (ai_suitability = 'reject')
    const rejectResult = await pool.query(`
      DELETE FROM mosaic_images
      WHERE ai_suitability = 'reject'
      RETURNING id
    `);
    const deletedRejects = rejectResult.rowCount ?? 0;

    // 2. Tiles mit sehr niedrigem mosaic_score löschen (< threshold)
    const lowScoreResult = await pool.query(`
      DELETE FROM mosaic_images
      WHERE ai_mosaic_score IS NOT NULL AND ai_mosaic_score < $1
      RETURNING id
    `, [mosaicScoreThreshold]);
    const deletedLowScore = lowScoreResult.rowCount ?? 0;

    // 3. Optional: Poor-Tiles löschen (ai_suitability = 'poor')
    let deletedPoor = 0;
    if (deletePoor) {
      const poorResult = await pool.query(`
        DELETE FROM mosaic_images
        WHERE ai_suitability = 'poor'
        RETURNING id
      `);
      deletedPoor = poorResult.rowCount ?? 0;
    }

    // Verbleibende Stats
    const statsResult = await pool.query(`
      SELECT COUNT(*) as remaining FROM mosaic_images
    `);

    res.json({
      ok: true,
      deleted: {
        rejects: deletedRejects,
        lowScore: deletedLowScore,
        poor: deletedPoor,
        total: deletedRejects + deletedLowScore + deletedPoor
      },
      remaining: parseInt(statsResult.rows[0].remaining)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── Fix quality_status for already-analyzed tiles ───────────────────────────
// One-time migration: set quality_status='ok' for all tiles that have ai_analyzed_at
// but still have quality_status='pending' (AI job previously didn't update this field)
app.post('/api/admin/fix-quality-status', async (_req, res) => {
  try {
    const pool = db.getPool();
    // Set 'ok' for analyzed tiles that are not rejected
    // Also covers tiles with ai_mosaic_score but missing ai_analyzed_at (imported with score but no timestamp)
    const okResult = await pool.query(`
      UPDATE mosaic_images
      SET quality_status = 'ok'
      WHERE (ai_analyzed_at IS NOT NULL OR ai_mosaic_score IS NOT NULL)
        AND (ai_suitability IS NULL OR ai_suitability != 'reject')
        AND (quality_status = 'pending' OR quality_status IS NULL)
    `);
    const updatedOk = okResult.rowCount ?? 0;

    // Set 'rejected' for tiles with ai_suitability='reject'
    const rejResult = await pool.query(`
      UPDATE mosaic_images
      SET quality_status = 'rejected'
      WHERE ai_suitability = 'reject'
        AND quality_status != 'rejected'
    `);
    const updatedRej = rejResult.rowCount ?? 0;

    // Count remaining pending (only those without any analysis)
    const pendingRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images
      WHERE (quality_status = 'pending' OR quality_status IS NULL)
        AND ai_analyzed_at IS NULL AND ai_mosaic_score IS NULL
    `);
    // Also count NULL status separately
    const nullStatusRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images WHERE quality_status IS NULL
    `);
    const pendingStatusRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images WHERE quality_status = 'pending'
    `);

    res.json({
      ok: true,
      updatedToOk: updatedOk,
      updatedToRejected: updatedRej,
      remainingPending: parseInt(pendingRes.rows[0].cnt),
      nullStatusCount: parseInt(nullStatusRes.rows[0].cnt),
      pendingStatusCount: parseInt(pendingStatusRes.rows[0].cnt)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── AI Pool-Statistik: Score-Verteilung ──────────────────────────────────────
app.get('/api/admin/ai-pool-quality', async (_req, res) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE ai_mosaic_score >= 80) as excellent_count,
        COUNT(*) FILTER (WHERE ai_mosaic_score >= 60 AND ai_mosaic_score < 80) as good_count,
        COUNT(*) FILTER (WHERE ai_mosaic_score >= 40 AND ai_mosaic_score < 60) as fair_count,
        COUNT(*) FILTER (WHERE ai_mosaic_score < 40 AND ai_mosaic_score IS NOT NULL) as poor_count,
        COUNT(*) FILTER (WHERE ai_suitability = 'reject') as rejected_count,
        COUNT(*) FILTER (WHERE ai_mosaic_score IS NULL) as not_analyzed,
        ROUND(AVG(ai_mosaic_score)) as avg_mosaic,
        ROUND(AVG(ai_calm_score)) as avg_calm,
        ROUND(AVG(ai_color_richness)) as avg_color,
        ROUND(AVG(ai_fill_uniformity)) as avg_fill,
        ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ai_mosaic_score)) as p25_mosaic,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ai_mosaic_score)) as p50_mosaic,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ai_mosaic_score)) as p75_mosaic
      FROM mosaic_images
    `);
    res.json({ ok: true, quality: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// tRPC API (for Admin panel)
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

// Serve static frontend build
// When running via tsx (dev): __dirname = .../server -> ../client/dist
// When running via node dist/server/index.js (prod): __dirname = .../dist/server -> ../../client/dist
const isCompiledBuild = __dirname.includes("/dist/server") || __dirname.includes("\\dist\\server");
// ── Debug: Test Flickr URL reachability ────────────────────────────────────────────────────
app.get('/api/admin/test-flickr', async (_req, res) => {
  const testUrl = 'https://live.staticflickr.com/7277/7616838636_5b2164f5a4.jpg';
  try {
    const resp = await fetch(testUrl, { signal: AbortSignal.timeout(8000) });
    const buf = Buffer.from(await resp.arrayBuffer());
    res.json({ ok: resp.ok, status: resp.status, size: buf.length, contentType: resp.headers.get('content-type') });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// ── Debug: Test Flickr import manually ─────────────────────────────────────────────────────
app.get('/api/admin/test-flickr-import', async (_req, res) => {
  const apiKey = process.env.FLICKR_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'FLICKR_API_KEY not set' });
  try {
    const resp = await fetch(
      `https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key=${encodeURIComponent(apiKey)}&text=sand&per_page=5&page=1&format=json&nojsoncallback=1&license=1,2,4,5,7,9,10&sort=relevance&content_type=1&safe_search=1&extras=url_m,url_l,url_z`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) return res.json({ ok: false, status: resp.status });
    const data = await resp.json() as any;
    const photos = (data.photos?.photo ?? []).slice(0, 3).map((p: any) => ({
      id: p.id, url_m: p.url_m, url_l: p.url_l, url_z: p.url_z,
      keys: Object.keys(p),
    }));
    res.json({ ok: true, total: data.photos?.total, pages: data.photos?.pages, perpage: data.photos?.perpage, stat: data.stat, message: data.message, code: data.code, rawSample: (data.photos?.photo ?? []).slice(0,1), photos, apiKeySet: !!apiKey, apiKeyLen: apiKey?.length });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// ── Authentication API ──────────────────────────────────────────────────────
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET environment variable is not set in production. Refusing to start.");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || "mosaicprint-dev-secret-change-in-production";
const JWT_EXPIRES_IN = "30d";

interface AuthUser { id: number; email: string; display_name: string | null }

function extractUser(req: express.Request): AuthUser | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
    return { id: payload.id, email: payload.email, display_name: payload.display_name };
  } catch { return null; }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = extractUser(req);
  if (!user) return res.status(401).json({ ok: false, error: "Nicht eingeloggt" });
  (req as any).user = user;
  next();
}
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = extractUser(req);
  if (!user) return res.status(401).json({ ok: false, error: "Nicht eingeloggt" });
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "marc.weibel@weibel-mueller.ch").toLowerCase().trim();
  if (user.email.toLowerCase().trim() !== ADMIN_EMAIL) {
    return res.status(403).json({ ok: false, error: "Kein Admin-Zugriff" });
  }
  (req as any).user = user;
  next();
}


// Register
app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const pool = db.getPool();
    const { email, password, displayName } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: "E-Mail und Passwort erforderlich" });
    if (password.length < 6) return res.status(400).json({ ok: false, error: "Passwort muss mindestens 6 Zeichen lang sein" });
    // Check if email exists
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) return res.status(409).json({ ok: false, error: "E-Mail bereits registriert" });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at",
      [email.toLowerCase().trim(), passwordHash, displayName || null]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, display_name: user.display_name }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ ok: true, user: { id: user.id, email: user.email, displayName: user.display_name }, token });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Login
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const pool = db.getPool();
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: "E-Mail und Passwort erforderlich" });
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return res.status(401).json({ ok: false, error: "Ungueltige Anmeldedaten" });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: "Ungueltige Anmeldedaten" });
    const token = jwt.sign({ id: user.id, email: user.email, display_name: user.display_name }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ ok: true, user: { id: user.id, email: user.email, displayName: user.display_name }, token });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get current user
app.get("/api/auth/me", (req, res) => {
  const user = extractUser(req);
  if (!user) return res.status(401).json({ ok: false, error: "Nicht eingeloggt" });
  res.json({ ok: true, user: { id: user.id, email: user.email, displayName: user.display_name } });
});

// ── Projects API (auth required) ───────────────────────────────────────────

// Save project
app.post("/api/projects", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    const { name, data, thumbnailUrl, tileSourceMode, projectType, userTiles } = req.body;
    if (!data) return res.status(400).json({ ok: false, error: "Projektdaten fehlen" });
    const result = await pool.query(
      "INSERT INTO projects (user_id, name, data, thumbnail_url, tile_source_mode, project_type, user_tiles) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, thumbnail_url, tile_source_mode, project_type, created_at",
      [user.id, name || "Mein Mosaik", data, thumbnailUrl || null, tileSourceMode || 'pool', projectType || 'mosaic', userTiles ? JSON.stringify(userTiles) : null]
    );
    res.json({ ok: true, project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// List user's projects
app.get("/api/projects", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    const result = await pool.query(
      "SELECT id, name, thumbnail_url, tile_source_mode, project_type, created_at, updated_at, print_url FROM projects WHERE user_id = $1 ORDER BY updated_at DESC",
      [user.id]
    );
    res.json({ ok: true, projects: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get single project
app.get("/api/projects/:id", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    const result = await pool.query(
      "SELECT * FROM projects WHERE id = $1 AND user_id = $2",
      [req.params.id, user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Projekt nicht gefunden" });
    res.json({ ok: true, project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Update project
app.put("/api/projects/:id", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    const { name, data, thumbnailUrl, tileSourceMode, userTiles } = req.body;
    const result = await pool.query(
      `UPDATE projects SET name = COALESCE($1, name), data = COALESCE($2, data), thumbnail_url = COALESCE($3, thumbnail_url),
       tile_source_mode = COALESCE($4, tile_source_mode), user_tiles = COALESCE($5, user_tiles),
       updated_at = NOW() WHERE id = $6 AND user_id = $7 RETURNING id, name, thumbnail_url, tile_source_mode, updated_at`,
      [name, data, thumbnailUrl, tileSourceMode, userTiles ? JSON.stringify(userTiles) : null, req.params.id, user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Projekt nicht gefunden" });
    res.json({ ok: true, project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Update project user tiles only (for photo management)
app.put("/api/projects/:id/tiles", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    const { userTiles } = req.body;
    if (!userTiles || !Array.isArray(userTiles)) return res.status(400).json({ ok: false, error: "userTiles array required" });
    const result = await pool.query(
      "UPDATE projects SET user_tiles = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, name, updated_at",
      [JSON.stringify(userTiles), req.params.id, user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Projekt nicht gefunden" });
    res.json({ ok: true, project: result.rows[0], tileCount: userTiles.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Delete project
app.delete("/api/projects/:id", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    await pool.query("DELETE FROM projects WHERE id = $1 AND user_id = $2", [req.params.id, user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Upload print file to R2 and save URL in project
app.post("/api/projects/:id/print-url", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    // Ensure print_url column exists (lazy migration)
    try {
      await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS print_url TEXT");
    } catch { /* column may already exist */ }
    // Expect multipart/form-data with 'file' field (JPEG blob)
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve, reject) => { req.on('end', resolve); req.on('error', reject); });
    const fileBuffer = Buffer.concat(chunks);
    if (!fileBuffer.length) return res.status(400).json({ ok: false, error: 'No file data received' });
    // Check project ownership
    const projRes = await pool.query("SELECT id FROM projects WHERE id = $1 AND user_id = $2", [req.params.id, user.id]);
    if (projRes.rows.length === 0) return res.status(404).json({ ok: false, error: 'Projekt nicht gefunden' });
    // Upload to R2 under prints/ prefix, or fall back to local disk storage
    let printUrl: string | null = null;
    if (isR2Configured()) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
        region: 'auto',
      });
      const key = `prints/project-${req.params.id}-${Date.now()}.jpg`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME ?? 'mosaicprint-tiles',
        Key: key,
        Body: fileBuffer,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=86400',
      }));
      const r2PublicUrl = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '');
      printUrl = `${r2PublicUrl}/${key}`;
    } else {
      // Fallback: store print file on local disk and serve via /prints/ static route
      const printsDir = path.join(__dirname, isCompiledBuild ? '../../prints' : '../prints');
      await fs.promises.mkdir(printsDir, { recursive: true });
      const filename = `project-${req.params.id}-${Date.now()}.jpg`;
      await fs.promises.writeFile(path.join(printsDir, filename), fileBuffer);
      printUrl = `/prints/${filename}`;
      console.log(`[PrintUrl] R2 not configured – saved locally: ${printUrl}`);
    }
    // Save URL in project
    await pool.query("UPDATE projects SET print_url = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3", [printUrl, req.params.id, user.id]);
    res.json({ ok: true, printUrl });
  } catch (e) {
    console.error('[PrintUrl] Upload failed:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Order Confirmation Email ───────────────────────────────────────────────
// POST /api/projects/:id/send-confirmation
// Sends a confirmation email with download link to the logged-in user
app.post("/api/projects/:id/send-confirmation", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    // Get project details
    const projRes = await pool.query(
      "SELECT id, name, print_url FROM projects WHERE id = $1 AND user_id = $2",
      [req.params.id, user.id]
    );
    if (projRes.rows.length === 0) return res.status(404).json({ ok: false, error: 'Projekt nicht gefunden' });
    const project = projRes.rows[0];
    const printUrl = req.body?.printUrl || project.print_url;
    if (!printUrl) return res.status(400).json({ ok: false, error: 'Keine Druckdatei-URL vorhanden' });
    // Check SMTP config
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || smtpUser;
    if (!smtpHost || !smtpUser || !smtpPass) {
      console.warn('[ConfirmEmail] SMTP not configured – skipping confirmation email');
      return res.json({ ok: false, skipped: true, reason: 'SMTP nicht konfiguriert' });
    }
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass },
    });
    // Build absolute download URL (handle relative /prints/ paths)
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const absolutePrintUrl = printUrl.startsWith('http') ? printUrl : `${proto}://${host}${printUrl}`;
    const projectName = project.name || 'Mein Mosaik';
    const displayName = user.display_name || user.email.split('@')[0];
    await transporter.sendMail({
      from: `MosaicPrint <${smtpFrom}>`,
      to: user.email,
      subject: `Deine Druckdatei ist bereit: "${projectName}"`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #e05c3a; font-size: 28px; margin: 0;">MosaicPrint</h1>
            <p style="color: #888; font-size: 13px; margin: 4px 0 0;">Dein Foto als Kunstwerk</p>
          </div>
          <h2 style="color: #1a1a1a; font-size: 22px;">Hallo ${displayName}!</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Deine Druckdatei f&uuml;r das Projekt <strong>"${projectName}"</strong> wurde erfolgreich erstellt und ist jetzt zum Download bereit.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${absolutePrintUrl}" style="background: #e05c3a; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; display: inline-block;">Druckdatei herunterladen</a>
          </div>
          <p style="color: #555; font-size: 14px; line-height: 1.6;">
            Du kannst deine Druckdatei auch jederzeit unter <strong>Projekte</strong> in deinem Konto herunterladen.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
          <p style="color: #999; font-size: 12px; text-align: center;">
            Erstellt mit MosaicPrint &mdash; Dein Foto als Kunstwerk &bull; <a href="https://mosaicprint.ch" style="color: #e05c3a;">mosaicprint.ch</a>
          </p>
        </div>
      `,
    });
    console.log(`[ConfirmEmail] Sent to ${user.email} for project ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[ConfirmEmail] Failed:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── QR Code API ────────────────────────────────────────────────────────────

app.get("/api/events/:slug/qr", async (req, res) => {
  try {
    const pool = db.getPool();
    const eventRes = await pool.query("SELECT id, slug, name FROM mosaic_events WHERE slug = $1", [req.params.slug]);
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    // Build full URL: use X-Forwarded-Host or Host header
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
    const eventUrl = `${proto}://${host}/event/${req.params.slug}`;
    const format = req.query.format === "svg" ? "svg" : "png";
    if (format === "svg") {
      const svg = await QRCode.toString(eventUrl, { type: "svg", width: 400, margin: 2 });
      res.setHeader("Content-Type", "image/svg+xml");
      res.send(svg);
    } else {
      const pngBuf = await QRCode.toBuffer(eventUrl, { width: 400, margin: 2, type: "png" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="qr-${req.params.slug}.png"`);
      res.send(pngBuf);
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// QR code as data URL (for inline display)
app.get("/api/events/:slug/qr-data", async (req, res) => {
  try {
    const pool = db.getPool();
    const eventRes = await pool.query("SELECT id, slug FROM mosaic_events WHERE slug = $1", [req.params.slug]);
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
    const eventUrl = `${proto}://${host}/event/${req.params.slug}`;
    const dataUrl = await QRCode.toDataURL(eventUrl, { width: 400, margin: 2 });
    res.json({ ok: true, qrDataUrl: dataUrl, eventUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Event Mosaic API ────────────────────────────────────────────────────────

// Create event (admin or authenticated user)
app.post("/api/events", requireAdmin, async (req, res) => {
  const user = (req as any).user as AuthUser; // admin only
  try {
    const pool = db.getPool();
    const { name, targetImageBase64, maxPhotos } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "Name required" });
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30) + '-' + Math.random().toString(36).slice(2, 6);
    let targetImageUrl: string | null = null;
    if (targetImageBase64) {
      targetImageUrl = `data:image/jpeg;base64,${targetImageBase64}`;
    }
    const result = await pool.query(
      `INSERT INTO mosaic_events (slug, name, target_image_url, max_photos, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [slug, name, targetImageUrl, maxPhotos ?? 500, user?.id ?? null]
    );
    res.json({ ok: true, event: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// List events (admin)
app.get("/api/events", async (_req, res) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(`
      SELECT e.*, (SELECT COUNT(*) FROM event_photos WHERE event_id = e.id) as photo_count
      FROM mosaic_events e ORDER BY e.created_at DESC
    `);
    res.json({ ok: true, events: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get current user's events (for Projects page)
app.get("/api/my-events", requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const user = (req as any).user as AuthUser;
    const result = await pool.query(`
      SELECT e.*, (SELECT COUNT(*) FROM event_photos WHERE event_id = e.id) as photo_count
      FROM mosaic_events e WHERE e.user_id = $1 ORDER BY e.created_at DESC
    `, [user.id]);
    res.json({ ok: true, events: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get event by slug (public)
app.get("/api/events/:slug", async (req, res) => {
  try {
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT e.*, (SELECT COUNT(*) FROM event_photos WHERE event_id = e.id) as photo_count
       FROM mosaic_events e WHERE e.slug = $1`, [req.params.slug]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    res.json({ ok: true, event: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Upload photo to event (guest)
app.post("/api/events/:slug/photos", async (req, res) => {
  try {
    const pool = db.getPool();
    const { base64, guestName } = req.body;
    if (!base64) return res.status(400).json({ ok: false, error: "Photo required" });
    if (!guestName || !guestName.trim()) return res.status(400).json({ ok: false, error: "Name is required" });
    // Get event
    const eventRes = await pool.query(`SELECT * FROM mosaic_events WHERE slug = $1 AND status = 'active'`, [req.params.slug]);
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event not found or inactive" });
    const event = eventRes.rows[0];
    // Check photo limit
    const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM event_photos WHERE event_id = $1`, [event.id]);
    if (Number(countRes.rows[0].cnt) >= event.max_photos) {
      return res.status(400).json({ ok: false, error: "Maximum number of photos reached" });
    }
    // Process image: create thumbnail (256px cover crop) and preview (800px)
    const { Jimp } = await import("jimp");
    const buf = Buffer.from(base64, 'base64');
    const img = await Jimp.fromBuffer(buf);
    // Create larger preview (max 800px, maintain aspect ratio)
    const previewImg = img.clone();
    const pw = previewImg.width, ph = previewImg.height;
    if (pw > 800 || ph > 800) {
      if (pw > ph) { previewImg.resize({ w: 800 }); } else { previewImg.resize({ h: 800 }); }
    }
    const previewBuf = await previewImg.getBuffer("image/jpeg", { quality: 85 });
    const photoUrl = `data:image/jpeg;base64,${previewBuf.toString('base64')}`;
    // Create square thumbnail using cover (crop, no distortion)
    img.cover({ w: 256, h: 256 });
    const thumbBuf = await img.getBuffer("image/jpeg", { quality: 80 });
    const thumbnailUrl = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
    // Compute average LAB from pixels
    const pixels = img.bitmap;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      rSum += pixels.data[i]; gSum += pixels.data[i+1]; bSum += pixels.data[i+2]; count++;
    }
    const avgR = rSum / count, avgG = gSum / count, avgB_ = bSum / count;
    // Simple RGB to LAB approximation
    const labL = 0.2126 * avgR + 0.7152 * avgG + 0.0722 * avgB_; // luminance approx
    const labA = (avgR - avgG) * 0.5;
    const labB_ = (avgG - avgB_) * 0.5;
    await pool.query(
      `INSERT INTO event_photos (event_id, photo_url, thumbnail_url, guest_name, avg_l, avg_a, avg_b) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, photoUrl, thumbnailUrl, guestName || null, labL, labA, labB_]
    );
    const newCount = Number(countRes.rows[0].cnt) + 1;
    res.json({ ok: true, photoCount: newCount, maxPhotos: event.max_photos });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get event photos (for live mosaic)
app.get("/api/events/:slug/photos", async (req, res) => {
  try {
    const pool = db.getPool();
    const eventRes = await pool.query(`SELECT id FROM mosaic_events WHERE slug = $1`, [req.params.slug]);
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    const photos = await pool.query(
      `SELECT id, photo_url, thumbnail_url, guest_name, avg_l, avg_a, avg_b, created_at
       FROM event_photos WHERE event_id = $1 ORDER BY created_at ASC`,
      [eventRes.rows[0].id]
    );
    res.json({ ok: true, photos: photos.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Delete individual photo (event creator/admin)
app.delete("/api/events/:slug/photos/:photoId", async (req, res) => {
  try {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ ok: false, error: "Authentication required" });
    const pool = db.getPool();
    // Verify event exists and user is the creator
    const eventRes = await pool.query(`SELECT * FROM mosaic_events WHERE slug = $1`, [req.params.slug]);
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    const event = eventRes.rows[0];
    if (event.user_id !== user.id) return res.status(403).json({ ok: false, error: "Not authorized" });
    // Delete photo
    const result = await pool.query(
      `DELETE FROM event_photos WHERE id = $1 AND event_id = $2 RETURNING id`,
      [req.params.photoId, event.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Photo not found" });
    const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM event_photos WHERE event_id = $1`, [event.id]);
    res.json({ ok: true, photoCount: Number(countRes.rows[0].cnt) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Delete event (admin)
app.delete("/api/events/:slug", requireAdmin, async (req, res) => {
  try {
    const pool = db.getPool();
    await pool.query(`DELETE FROM mosaic_events WHERE slug = $1`, [req.params.slug]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Event participants (mosaic opt-in) ─────────────────────────────────────
app.post("/api/events/:slug/participants", async (req, res) => {
  try {
    const pool = db.getPool();
    const { name, email } = req.body;
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ ok: false, error: "Name und E-Mail sind erforderlich" });
    }
    const eventRes = await pool.query(`SELECT id FROM mosaic_events WHERE slug = $1`, [req.params.slug]);
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Event nicht gefunden" });
    }
    await pool.query(
      `INSERT INTO event_participants (event_id, name, email) VALUES ($1, $2, $3) ON CONFLICT (event_id, email) DO UPDATE SET name = $2`,
      [eventRes.rows[0].id, name.trim(), email.trim().toLowerCase()]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/events/:slug/participants", requireAdmin, async (req, res) => {
  try {
    const pool = db.getPool();
    const eventRes = await pool.query(`SELECT id FROM mosaic_events WHERE slug = $1`, [req.params.slug]);
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Event nicht gefunden" });
    }
    const result = await pool.query(
      `SELECT id, name, email, created_at FROM event_participants WHERE event_id = $1 ORDER BY created_at`,
      [eventRes.rows[0].id]
    );
    res.json({ ok: true, participants: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Update event target image ──────────────────────────────────────────────
app.put("/api/events/:slug/target-image", requireAdmin, express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const pool = db.getPool();
    const { targetImageBase64 } = req.body;
    if (!targetImageBase64) {
      return res.status(400).json({ ok: false, error: "Kein Bild angegeben" });
    }
    const targetImageUrl = `data:image/jpeg;base64,${targetImageBase64}`;
    const result = await pool.query(
      `UPDATE mosaic_events SET target_image_url = $1, updated_at = NOW() WHERE slug = $2 RETURNING *`,
      [targetImageUrl, req.params.slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Event nicht gefunden" });
    }
    res.json({ ok: true, event: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Event mosaic matching endpoint ─────────────────────────────────────────
// Matches event photos to target image cells using CIEDE2000 color distance.
// mode=match: one photo per cell max (no reuse)
// mode=finalize: fill all remaining cells by reusing photos (multi-use)
app.post("/api/events/:slug/match", async (req, res) => {
  try {
    const user = extractUser(req);
    const pool = db.getPool();
    const { mode } = req.body; // 'match' (default) or 'finalize'

    // Get event
    const eventRes = await pool.query(
      `SELECT e.*, (SELECT COUNT(*) FROM event_photos WHERE event_id = e.id) as photo_count FROM mosaic_events e WHERE e.slug = $1`,
      [req.params.slug]
    );
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event nicht gefunden" });
    const event = eventRes.rows[0];

    // Only event owner can trigger matching
    if (!user || event.user_id !== user.id) {
      return res.status(403).json({ ok: false, error: "Nur der Event-Ersteller kann das Matching starten" });
    }

    if (!event.target_image_url?.startsWith('data:')) {
      return res.status(400).json({ ok: false, error: "Kein Zielbild vorhanden" });
    }

    // Get photos with LAB colors
    const photosRes = await pool.query(
      `SELECT id, thumbnail_url, photo_url, avg_l, avg_a, avg_b, guest_name FROM event_photos WHERE event_id = $1 ORDER BY created_at`,
      [event.id]
    );
    if (photosRes.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Keine Fotos vorhanden" });
    }
    const photos = photosRes.rows as Array<{ id: number; thumbnail_url: string; photo_url: string; avg_l: number; avg_a: number; avg_b: number; guest_name: string | null }>;

    // Determine grid dimensions from target image aspect ratio
    const targetBase64 = event.target_image_url.split(',')[1];
    const targetBuffer = Buffer.from(targetBase64, 'base64');
    const targetMeta = await sharp(targetBuffer).metadata();
    const targetW = targetMeta.width || 1;
    const targetH = targetMeta.height || 1;
    const aspect = targetW / targetH;

    // Calculate grid: aim for roughly photoCount cells in match mode, or fill fully in finalize
    const photoCount = photos.length;
    const totalTarget = mode === 'finalize' ? Math.max(photoCount * 2, 200) : photoCount;
    const cols = Math.max(4, Math.round(Math.sqrt(totalTarget * aspect)));
    const rows = Math.max(4, Math.round(cols / aspect));
    const totalCells = cols * rows;

    // Extract target image region colors
    const { rgbToLab, deltaE2000 } = await import("./colorUtils.js");
    const targetResized = await sharp(targetBuffer)
      .resize(cols, rows, { fit: 'fill' })
      .raw()
      .toBuffer();

    // Build LAB color per cell from target image
    const cellColors: Array<{ l: number; a: number; b: number; col: number; row: number }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = (r * cols + c) * 3;
        const [l, a, b] = rgbToLab(targetResized[idx], targetResized[idx + 1], targetResized[idx + 2]);
        cellColors.push({ l, a, b, col: c, row: r });
      }
    }

    // ── Optimized matching with warm-color awareness ──────────────────────
    const usageCount = new Map<number, number>(); // photoIndex → times used

    // Compute global average LAB once (was O(n²) before)
    const avgL = cellColors.reduce((s, c) => s + c.l, 0) / cellColors.length;
    const avgA = cellColors.reduce((s, c) => s + c.a, 0) / cellColors.length;
    const avgB = cellColors.reduce((s, c) => s + c.b, 0) / cellColors.length;

    // Compute chroma for each cell – high chroma = saturated (warm orange/beer, vivid blues etc.)
    const cellChroma = cellColors.map(c => Math.sqrt(c.a * c.a + c.b * c.b));

    // Compute photo chroma histogram to detect underrepresented color ranges
    const photoChroma = photos.map(p => Math.sqrt(p.avg_a * p.avg_a + p.avg_b * p.avg_b));
    const photoHue = photos.map((p, i) => photoChroma[i] > 5 ? (Math.atan2(p.avg_b, p.avg_a) * 180 / Math.PI + 360) % 360 : -1);

    // Count photos in warm hue range (15°-75° covers orange/amber/beer tones)
    const warmPhotoCount = photoHue.filter(h => h >= 15 && h <= 75).length;
    const warmPhotoRatio = photos.length > 0 ? warmPhotoCount / photos.length : 0;

    // Saliency: color distance from average + chroma boost for saturated cells
    // Warm saturated cells (orange/beer) get extra priority when warm photos are scarce
    const cellsWithSaliency = cellColors.map((cell, idx) => {
      const baseSaliency = deltaE2000(cell.l, cell.a, cell.b, avgL, avgA, avgB);
      const chroma = cellChroma[idx];
      // Boost saturated cells: chroma > 30 is vivid, scale proportionally
      const chromaBoost = Math.max(0, (chroma - 20) * 0.3);
      // Extra boost for warm hues (orange/amber 15°-75°) when warm photos are scarce
      const hue = chroma > 5 ? (Math.atan2(cell.b, cell.a) * 180 / Math.PI + 360) % 360 : -1;
      const isWarm = hue >= 15 && hue <= 75;
      const warmBoost = isWarm && warmPhotoRatio < 0.3 ? chroma * 0.2 : 0;
      return { ...cell, idx, saliency: baseSaliency + chromaBoost + warmBoost };
    }).sort((a, b) => b.saliency - a.saliency);

    const cellAssignment = new Array<{ photoId: number; photoIndex: number; thumbnailUrl: string; guestName: string | null } | null>(totalCells).fill(null);
    // Track which photo was assigned to each cell index (for refinement)
    const cellPhotoIdx = new Int32Array(totalCells).fill(-1);

    const isFinalize = mode === 'finalize';

    // Phase 1: Greedy assignment with adaptive reuse penalty
    for (const cell of cellsWithSaliency) {
      let bestIdx = -1;
      let bestDist = Infinity;
      const cellChr = cellChroma[cell.idx];

      for (let i = 0; i < photos.length; i++) {
        const uses = usageCount.get(i) || 0;
        if (!isFinalize && uses >= 1) continue;
        const p = photos[i];
        const dist = deltaE2000(cell.l, cell.a, cell.b, p.avg_l, p.avg_a, p.avg_b);
        // Adaptive reuse penalty: higher for saturated/distinctive colors
        // so rare warm-toned photos spread more carefully
        const basePenalty = 15;
        const chromaFactor = 1 + Math.max(0, (cellChr - 20) * 0.03);
        const reusePenalty = uses * basePenalty * chromaFactor;
        if (dist + reusePenalty < bestDist) {
          bestDist = dist + reusePenalty;
          bestIdx = i;
        }
      }

      const cellIndex = cell.row * cols + cell.col;
      if (bestIdx >= 0) {
        usageCount.set(bestIdx, (usageCount.get(bestIdx) || 0) + 1);
        cellPhotoIdx[cellIndex] = bestIdx;
        cellAssignment[cellIndex] = {
          photoId: photos[bestIdx].id,
          photoIndex: bestIdx,
          thumbnailUrl: photos[bestIdx].thumbnail_url,
          guestName: photos[bestIdx].guest_name,
        };
      }
    }

    // Phase 2: Refinement – pairwise swap pass to reduce total error
    // Especially helps warm color regions where greedy order may be suboptimal
    let improved = true;
    let passes = 0;
    const maxPasses = 3;
    while (improved && passes < maxPasses) {
      improved = false;
      passes++;
      for (let i = 0; i < totalCells; i++) {
        if (cellPhotoIdx[i] < 0) continue;
        const ci = cellColors[i];
        const pi = photos[cellPhotoIdx[i]];
        const distI = deltaE2000(ci.l, ci.a, ci.b, pi.avg_l, pi.avg_a, pi.avg_b);

        for (let j = i + 1; j < totalCells; j++) {
          if (cellPhotoIdx[j] < 0) continue;
          if (cellPhotoIdx[i] === cellPhotoIdx[j]) continue; // same photo, skip
          const cj = cellColors[j];
          const pj = photos[cellPhotoIdx[j]];
          const distJ = deltaE2000(cj.l, cj.a, cj.b, pj.avg_l, pj.avg_a, pj.avg_b);
          const currentTotal = distI + distJ;

          // Try swapping
          const swapDistI = deltaE2000(ci.l, ci.a, ci.b, pj.avg_l, pj.avg_a, pj.avg_b);
          const swapDistJ = deltaE2000(cj.l, cj.a, cj.b, pi.avg_l, pi.avg_a, pi.avg_b);
          const swapTotal = swapDistI + swapDistJ;

          if (swapTotal < currentTotal - 0.5) { // threshold to avoid trivial swaps
            // Perform swap
            const tmpIdx = cellPhotoIdx[i];
            cellPhotoIdx[i] = cellPhotoIdx[j];
            cellPhotoIdx[j] = tmpIdx;
            const tmpAssign = cellAssignment[i];
            cellAssignment[i] = cellAssignment[j];
            cellAssignment[j] = tmpAssign;
            improved = true;
          }
        }
      }
    }

    // Build response: grid dimensions + cell assignments
    const cells = cellAssignment.map((a, idx) => ({
      col: idx % cols,
      row: Math.floor(idx / cols),
      photoId: a?.photoId ?? null,
      thumbnailUrl: a?.thumbnailUrl ?? null,
      guestName: a?.guestName ?? null,
    }));

    const filledCount = cells.filter(c => c.photoId !== null).length;

    res.json({
      ok: true,
      cols,
      rows,
      totalCells,
      filledCount,
      photoCount: photos.length,
      cells,
      targetAspect: aspect,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Render event mosaic as image ─────────────────────────────────────────
app.post("/api/events/:slug/render", async (req, res) => {
  try {
    const user = extractUser(req);
    const pool = db.getPool();
    const { cells, cols, rows, overlayAlpha = 0.15 } = req.body;

    // Get event
    const eventRes = await pool.query(
      `SELECT * FROM mosaic_events e WHERE e.slug = $1`, [req.params.slug]
    );
    if (eventRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Event nicht gefunden" });
    const event = eventRes.rows[0];

    if (!user || event.user_id !== user.id) {
      return res.status(403).json({ ok: false, error: "Nicht autorisiert" });
    }

    if (!cells || !cols || !rows) {
      return res.status(400).json({ ok: false, error: "cells, cols, rows required" });
    }

    // Build tiles array from cells
    const tiles = (cells as Array<{ col: number; row: number; thumbnailUrl: string | null }>)
      .filter(c => c.thumbnailUrl)
      .map(c => ({ url: c.thumbnailUrl!, col: c.col, row: c.row }));

    const tilePx = 128;
    const hasTarget = event.target_image_url?.startsWith('data:');

    const { renderMosaicOnServer } = await import("./mosaicExport.js");
    const mosaicBuffer = await renderMosaicOnServer({
      tiles,
      cols,
      rows,
      tilePx,
      overlayBase64: hasTarget ? event.target_image_url.split(',')[1] : undefined,
      overlayAlpha: hasTarget ? overlayAlpha : 0,
      sharpen: true,
    });

    // Return as base64 data URL for preview
    const base64 = mosaicBuffer.toString('base64');
    res.json({ ok: true, imageDataUrl: `data:image/png;base64,${base64}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── Send mosaic to all participants ────────────────────────────────────────
app.post("/api/events/:slug/send-mosaic", requireAdmin, async (req, res) => {
  try {
    const pool = db.getPool();

    // Get event
    const eventRes = await pool.query(
      `SELECT e.*, (SELECT COUNT(*) FROM event_photos WHERE event_id = e.id) as photo_count FROM mosaic_events e WHERE e.slug = $1`,
      [req.params.slug]
    );
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Event nicht gefunden" });
    }
    const event = eventRes.rows[0];

    // Get participants
    const partRes = await pool.query(
      `SELECT name, email FROM event_participants WHERE event_id = $1`, [event.id]
    );
    if (partRes.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Keine Teilnehmer registriert" });
    }

    // Get photos with LAB colors
    const photosRes = await pool.query(
      `SELECT thumbnail_url, avg_l, avg_a, avg_b FROM event_photos WHERE event_id = $1 ORDER BY created_at`, [event.id]
    );
    if (photosRes.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Keine Fotos vorhanden" });
    }

    const photos = photosRes.rows as Array<{ thumbnail_url: string; avg_l: number; avg_a: number; avg_b: number }>;
    const cols = Math.ceil(Math.sqrt(photos.length * 1.5));
    const rows = Math.ceil(photos.length / cols);
    const totalCells = cols * rows;
    const tilePx = 128;

    // Smart matching: if target image exists, match photos to target regions by LAB color
    let tiles: Array<{ url: string; col: number; row: number }>;
    const { rgbToLab, deltaE2000 } = await import("./colorUtils.js");

    const hasTarget = event.target_image_url?.startsWith('data:');
    if (hasTarget) {
      // Extract target image region colors using sharp
      const targetBase64 = event.target_image_url.split(',')[1];
      const targetBuffer = Buffer.from(targetBase64, 'base64');
      const targetResized = await sharp(targetBuffer)
        .resize(cols, rows, { fit: 'fill' })
        .raw()
        .toBuffer();

      // Build LAB color per cell from target image
      const cellColors: Array<{ l: number; a: number; b: number; col: number; row: number }> = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = (r * cols + c) * 3;
          const [l, a, b] = rgbToLab(targetResized[idx], targetResized[idx + 1], targetResized[idx + 2]);
          cellColors.push({ l, a, b, col: c, row: r });
        }
      }

      // Optimized matching with warm-color awareness (CIEDE2000)
      const usageCnt = new Map<number, number>();
      const assigned: Array<{ url: string; col: number; row: number }> = new Array(totalCells);

      // Compute global averages once
      const smAvgL = cellColors.reduce((s, c) => s + c.l, 0) / cellColors.length;
      const smAvgA = cellColors.reduce((s, c) => s + c.a, 0) / cellColors.length;
      const smAvgB = cellColors.reduce((s, c) => s + c.b, 0) / cellColors.length;

      // Sort by saliency with chroma boost for saturated warm colors
      const smSorted = cellColors.map((cell, idx) => {
        const baseSal = deltaE2000(cell.l, cell.a, cell.b, smAvgL, smAvgA, smAvgB);
        const chroma = Math.sqrt(cell.a * cell.a + cell.b * cell.b);
        const chromaBoost = Math.max(0, (chroma - 20) * 0.3);
        return { ...cell, idx, saliency: baseSal + chromaBoost };
      }).sort((a, b) => b.saliency - a.saliency);

      for (const cell of smSorted) {
        let bestIdx = 0;
        let bestDist = Infinity;
        const cellChr = Math.sqrt(cell.a * cell.a + cell.b * cell.b);
        for (let i = 0; i < photos.length; i++) {
          const uses = usageCnt.get(i) || 0;
          if (uses >= 1 && photos.length >= totalCells) continue;
          const p = photos[i];
          const dist = deltaE2000(cell.l, cell.a, cell.b, p.avg_l, p.avg_a, p.avg_b);
          const chromaFactor = 1 + Math.max(0, (cellChr - 20) * 0.03);
          const reusePenalty = uses * 20 * chromaFactor;
          if (dist + reusePenalty < bestDist) {
            bestDist = dist + reusePenalty;
            bestIdx = i;
          }
        }
        usageCnt.set(bestIdx, (usageCnt.get(bestIdx) || 0) + 1);
        assigned[cell.row * cols + cell.col] = { url: photos[bestIdx].thumbnail_url, col: cell.col, row: cell.row };
      }
      tiles = assigned.filter(Boolean);
    } else {
      // No target image: simple grid layout
      tiles = photos.slice(0, totalCells).map((p, i) => ({
        url: p.thumbnail_url,
        col: i % cols,
        row: Math.floor(i / cols),
      }));
    }

    // Render mosaic
    const { renderMosaicOnServer } = await import("./mosaicExport.js");
    const mosaicBuffer = await renderMosaicOnServer({
      tiles, cols, rows, tilePx,
      overlayBase64: hasTarget ? event.target_image_url.split(',')[1] : undefined,
      overlayAlpha: hasTarget ? 0.15 : 0,
      sharpen: true,
    });

    // Check SMTP config
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass) {
      return res.status(500).json({ ok: false, error: "SMTP nicht konfiguriert. Bitte SMTP_HOST, SMTP_USER, SMTP_PASS setzen." });
    }

    // Create transporter
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass },
    });

    // Send to all participants
    const results: { email: string; ok: boolean; error?: string }[] = [];
    for (const participant of partRes.rows) {
      try {
        await transporter.sendMail({
          from: `MosaicPrint <${smtpFrom}>`,
          to: participant.email,
          subject: `Dein Mosaik von "${event.name}" ist fertig!`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #1a1a1a; font-size: 24px;">Hallo ${participant.name}!</h1>
              <p style="color: #555; font-size: 16px; line-height: 1.6;">
                Das Mosaik vom Event <strong>"${event.name}"</strong> ist fertig!
                Es wurde aus <strong>${photos.length} Fotos</strong> aller Gäste zusammengesetzt.
              </p>
              <p style="color: #555; font-size: 16px; line-height: 1.6;">
                Das fertige Mosaik findest du im Anhang.
              </p>
              <p style="color: #999; font-size: 12px; margin-top: 30px;">
                Erstellt mit MosaicPrint — Dein Foto als Kunstwerk
              </p>
            </div>
          `,
          attachments: [{
            filename: `mosaik-${event.slug}.png`,
            content: mosaicBuffer,
            contentType: 'image/png',
          }],
        });
        results.push({ email: participant.email, ok: true });
      } catch (err) {
        results.push({ email: participant.email, ok: false, error: String(err) });
      }
    }

    const sent = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    res.json({ ok: true, sent, failed, total: results.length, details: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const distPath = isCompiledBuild
  ? path.join(__dirname, "../../client/dist")
  : path.join(__dirname, "../client/dist");
// Serve locally stored print files (fallback when R2 is not configured)
const printsPath = isCompiledBuild
  ? path.join(__dirname, "../../prints")
  : path.join(__dirname, "../prints");
app.use("/prints", express.static(printsPath, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// Start server immediately (Railway healthcheck needs the port open quickly)
const server = app.listen(PORT, "0.0.0.0", () => {
  // Allow long-running print renders (Ultra HD can take 10+ minutes)
  server.timeout = 15 * 60 * 1000;        // 15 min socket timeout
  server.keepAliveTimeout = 15 * 60 * 1000; // 15 min keep-alive
  server.headersTimeout = 15 * 60 * 1000 + 1000;
  console.log(`[MosaicPrint] Server running on port ${PORT}`);
  console.log(`[MosaicPrint] Static files from: ${distPath}`);
  console.log(`[MosaicPrint] isRailway: ${isRailway}`);
  console.log(`[MosaicPrint] DB URL set: ${!!process.env.DATABASE_URL}`);
  // Log all DATABASE-related env vars for debugging
  const dbVars = Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('POSTGRES'));
  console.log(`[MosaicPrint] DB-related env vars: ${dbVars.join(', ') || 'none'}`);
});

// Initialize DB schema in background (non-blocking)
db.ensureSchema()
  .then(() => {
    console.log("[MosaicPrint] DB schema initialized successfully");
  })
  .catch((e) => {
    console.error("[MosaicPrint] DB init failed (non-fatal):", e.message);
  });

// Auto-import cron removed – imports are triggered manually via Admin panel
