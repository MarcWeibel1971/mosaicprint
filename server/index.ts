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
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";
import * as db from "./db.js";
import sharp from "sharp";

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
const TILE_CACHE_MAX = 3000; // max tiles in memory (~60 MB at 20 KB/tile)
const tileCacheMap = new Map<string, { buf: Buffer; contentType: string; ts: number }>();

function evictTileCache() {
  if (tileCacheMap.size <= TILE_CACHE_MAX) return;
  // Evict oldest 500 entries
  const entries = [...tileCacheMap.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < 500; i++) tileCacheMap.delete(entries[i][0]);
  console.log(`[cache] Evicted 500 tile cache entries, size now: ${tileCacheMap.size}`);
}

// 3. Tile URL cache: maps tile id → {tile128_url, source_url} to avoid DB per request
const tileUrlCache = new Map<number, { tile128Url: string; sourceUrl: string; ts: number }>();
const TILE_URL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TILE_URL_CACHE_MAX = 30000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));

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
      res.setHeader('X-Floats-Per-Tile', '15');
      res.setHeader('X-Cache', 'HIT');
      return res.send(cached.buf);
    }
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space'];
    const themeFilter = (theme && VALID_THEMES.includes(theme))
      ? `AND subject = $1`
      : ``;
    const queryParams = (theme && VALID_THEMES.includes(theme)) ? [theme] : [];
    // Also fetch quadrant data + is_skin_friendly for richer feature vector
    const result = await pool.query(
      `SELECT id, avg_l, avg_a, avg_b,
              tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
              bl_l, bl_a, bl_b, br_l, br_a, br_b,
              COALESCE(is_skin_friendly, (SQRT(avg_a * avg_a + avg_b * avg_b) < 25 AND avg_l >= 35 AND avg_l <= 80)) as is_skin_friendly
       FROM mosaic_images
       WHERE avg_l IS NOT NULL ${themeFilter} ORDER BY id ASC`,
      queryParams
    );
    const rows = result.rows;
    // Pack as Float32Array: [id, L, a, b, tl_a, tl_b, tr_a, tr_b, bl_a, bl_b, br_a, br_b, edge, brightness, isSkinFriendly] = 15 floats
    // Quadrant a/b values encode color distribution per quadrant (TL, TR, BL, BR)
    // edge: variance of L across quadrants (high variance = high edge energy)
    // brightness: avg_l / 100
    // isSkinFriendly: 1.0 = skin-friendly tile, 0.0 = not skin-friendly
    const FLOATS_PER_TILE = 15;
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
      // Compute edge proxy: variance of L across quadrants
      const quadMeanL = (tlL + trL + blL + brL) / 4;
      const quadVarL = ((tlL-quadMeanL)**2 + (trL-quadMeanL)**2 + (blL-quadMeanL)**2 + (brL-quadMeanL)**2) / 4;
      const edgeProxy = Math.min(1, Math.sqrt(quadVarL) / 30);
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
      buf.writeFloatLE(isSkinFriendly, offset);   offset += 4;  // [14] isSkinFriendly
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
    const cacheKey = `${id}-${size}`;

    // Check in-memory tile cache first
    const cached = tileCacheMap.get(cacheKey);
    if (cached) {
      res.set("Content-Type", cached.contentType);
      res.set("Cache-Control", "public, max-age=86400");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("X-Cache", "HIT");
      return res.send(cached.buf);
    }

    // Check tile URL cache (avoids DB query)
    let tileUrls = tileUrlCache.get(id);
    if (!tileUrls || (Date.now() - tileUrls.ts) > TILE_URL_CACHE_TTL_MS) {
      const pool = db.getPool();
      const result = await pool.query(
        "SELECT source_url, tile128_url FROM mosaic_images WHERE id = $1",
        [id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
      const row = result.rows[0];
      tileUrls = { tile128Url: row.tile128_url || '', sourceUrl: row.source_url || '', ts: Date.now() };
      tileUrlCache.set(id, tileUrls);
      // Evict if too large
      if (tileUrlCache.size > TILE_URL_CACHE_MAX) {
        const oldest = [...tileUrlCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
        tileUrlCache.delete(oldest[0]);
      }
    }

    const url = size <= 128 && tileUrls.tile128Url ? tileUrls.tile128Url : tileUrls.sourceUrl;
    if (!url) return res.status(404).json({ error: "No URL" });

    // If it's a data URL (uploaded tile), serve it directly
    if (url.startsWith("data:")) {
      const [header, b64] = url.split(",");
      const mimeType = header.split(":")[1].split(";")[0];
      const buf = Buffer.from(b64, "base64");
      res.set("Content-Type", mimeType);
      res.set("Cache-Control", "public, max-age=86400");
      return res.send(buf);
    }
    // Proxy the image directly to avoid CORS issues (Pixabay, Pexels, Unsplash)
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    const upstream = await fetch(url, { headers: { 'User-Agent': 'MosaicPrint/1.0' } });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "Upstream error" });
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());
    // Store in tile cache
    tileCacheMap.set(cacheKey, { buf, contentType, ts: Date.now() });
    evictTileCache();
    res.set("Content-Type", contentType);
    res.set("X-Cache", "MISS");
    return res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tile-urls?ids=1,2,3  – returns direct tile128_url for hi-res rendering
// Client can use these URLs directly (no proxy needed) for faster hi-res zoom
app.get("/api/tile-urls", async (req, res) => {
  try {
    const idsParam = req.query.ids as string;
    if (!idsParam) return res.status(400).json({ error: "Missing ids" });
    const ids = idsParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
    if (ids.length === 0 || ids.length > 2000) return res.status(400).json({ error: "Invalid ids" });
    const pool = db.getPool();
    const result = await pool.query(
      `SELECT id, tile128_url, source_url FROM mosaic_images WHERE id = ANY($1)`,
      [ids]
    );
    const urlMap: Record<number, string> = {};
    for (const row of result.rows) {
      urlMap[row.id] = row.tile128_url || row.source_url || '';
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.json(urlMap);
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

// ── Texture Atlas ──────────────────────────────────────────────────────────────
// GET /api/tile-atlas?theme=&tileSize=64&maxTiles=3000
// Returns a single sprite-sheet JPEG containing all tiles (or a subset).
// X-Atlas-Map header is OMITTED (too large for HTTP headers with 3000+ tiles).
// Instead, use GET /api/tile-atlas-map?theme=&tileSize=64&maxTiles=3000 for the JSON map.
// This replaces thousands of individual /api/tile/:id requests with ONE request.
//
// Cache: in-memory per (theme, tileSize, maxTiles), TTL 30 minutes
// First build: ~10-30s (downloads all tiles), subsequent: instant

// GET /api/tile-atlas-map - returns the tile position map as JSON (separate from the JPEG)
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
const atlasCacheMap = new Map<string, AtlasCache>();
const ATLAS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
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
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space'];
    const themeFilter = (theme && VALID_THEMES.includes(theme)) ? `WHERE subject = $1` : ``;
    const queryParams = (theme && VALID_THEMES.includes(theme)) ? [theme] : [];

    // Fetch tile IDs and URLs
    const result = await pool.query(
      `SELECT id, tile128_url, source_url FROM mosaic_images
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

    // Build atlas using sharp composite
    const CONCURRENCY = 20;
    const compositeInputs: sharp.OverlayOptions[] = [];
    const tileMap: Record<number, [number, number]> = {};

    for (let i = 0; i < n; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row: any, bi: number) => {
        const idx = i + bi;
        const col = idx % cols;
        const rowIdx = Math.floor(idx / cols);
        const url = row.tile128_url || row.source_url || '';
        if (!url) return;

        try {
          // Check in-memory tile cache first
          const cacheKeyTile = `${row.id}-128`;
          let imgBuf: Buffer | null = null;
          const tileCached = tileCacheMap.get(cacheKeyTile);
          if (tileCached) {
            imgBuf = tileCached.buf;
          } else if (url.startsWith('data:')) {
            imgBuf = Buffer.from(url.split(',')[1], 'base64');
          } else {
            const resp = await fetch(url, { headers: { 'User-Agent': 'MosaicPrint/1.0' }, signal: AbortSignal.timeout(8000) });
            if (resp.ok) imgBuf = Buffer.from(await resp.arrayBuffer());
          }
          if (!imgBuf) return;

          // Resize to tileSize×tileSize
          const resized = await sharp(imgBuf).resize(tileSize, tileSize, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
          compositeInputs[idx] = { input: resized, top: rowIdx * tileSize, left: col * tileSize };
          tileMap[Number(row.id)] = [col, rowIdx];
        } catch {
          // Skip failed tiles
        }
      }));
      if (i % 500 === 0) console.log(`[atlas] Processing tiles ${i}/${n}...`);
    }

    // Create blank canvas and composite all tiles
    const validInputs = compositeInputs.filter(Boolean);
    const atlasJpeg = await sharp({
      create: { width: atlasW, height: atlasH, channels: 3, background: { r: 128, g: 128, b: 128 } }
    }).composite(validInputs).jpeg({ quality: 82 }).toBuffer();

    const atlasData: AtlasCache = {
      jpeg: atlasJpeg,
      map: tileMap,
      tileSize,
      cols,
      rows: rows2,
      builtAt: Date.now(),
    };
    atlasCacheMap.set(cacheKey, atlasData);
    atlasBuildInProgress.delete(cacheKey);
    console.log(`[atlas] Built: ${n} tiles, ${cols}×${rows2} grid, ${(atlasJpeg.length/1024/1024).toFixed(1)} MB JPEG`);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', atlasJpeg.length);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.setHeader('X-Atlas-Cols', cols.toString());
    res.setHeader('X-Atlas-Rows', rows2.toString());
    res.setHeader('X-Atlas-TileSize', tileSize.toString());
    res.setHeader('X-Cache', 'MISS');
    res.send(atlasJpeg);
  } catch (e) {
    atlasBuildInProgress.clear();
    console.error('[atlas] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Server-side Print Render ──────────────────────────────────────────────────
// POST /api/print-render
// Body: { tileIds: number[], assignment: number[], cols: number, rows: number, tilePx?: number }
// Returns: JPEG of the full-resolution mosaic (no watermark)
// Uses source_url (original high-res images) for print quality.
// Disk cache at /tmp/mosaicprint-hires/ to avoid re-downloading.
const HIRES_CACHE_DIR = '/tmp/mosaicprint-hires';
if (!fs.existsSync(HIRES_CACHE_DIR)) fs.mkdirSync(HIRES_CACHE_DIR, { recursive: true });

app.post('/api/print-render', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { tileIds, assignment, cols, rows, tilePx = 400 } = req.body as {
      tileIds: number[];
      assignment: number[];
      cols: number;
      rows: number;
      tilePx?: number;
    };

    if (!tileIds?.length || !assignment?.length || !cols || !rows) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // PRINT_TILE_PX: 400px per tile → 50×50 tiles = 20000×20000px (200 DPI at 100×100cm)
    // Clamp between 256 (minimum for visible detail) and 600 (max reasonable)
    const TILE_PX = Math.min(Math.max(tilePx, 256), 600);
    const outW = cols * TILE_PX;
    const outH = rows * TILE_PX;
    const pool = db.getPool();

    // Fetch unique tile IDs needed – prefer source_url for hi-res, fallback to tile128_url
    const uniqueIds = [...new Set(assignment.map(idx => tileIds[idx]).filter(Boolean))];
    const result = await pool.query(
      `SELECT id, tile128_url, source_url FROM mosaic_images WHERE id = ANY($1)`,
      [uniqueIds]
    );
    const urlMap: Record<number, { hiRes: string; fallback: string }> = {};
    for (const row of result.rows) {
      urlMap[row.id] = {
        hiRes: row.source_url || '',
        fallback: row.tile128_url || row.source_url || ''
      };
    }

    // Load tile images in parallel batches with disk cache
    const tileBuffers: Record<number, Buffer> = {};
    const CONCURRENCY = 10; // lower concurrency for large images
    for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
      const batch = uniqueIds.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (id) => {
        const urls = urlMap[id];
        if (!urls) return;
        // Check disk cache first (keyed by tile id)
        const cacheFile = path.join(HIRES_CACHE_DIR, `${id}.jpg`);
        if (fs.existsSync(cacheFile)) {
          try {
            tileBuffers[id] = fs.readFileSync(cacheFile);
            return;
          } catch { /* fall through to download */ }
        }
        // Try source_url (hi-res original), fallback to tile128_url
        const urlsToTry = [urls.hiRes, urls.fallback].filter(Boolean);
        for (const url of urlsToTry) {
          try {
            if (url.startsWith('data:')) {
              tileBuffers[id] = Buffer.from(url.split(',')[1], 'base64');
              break;
            }
            const resp = await fetch(url, {
              headers: { 'User-Agent': 'MosaicPrint/1.0' },
              signal: AbortSignal.timeout(15000)
            });
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              // Resize to TILE_PX and cache to disk
              const resized = await sharp(buf)
                .resize(TILE_PX, TILE_PX, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 92, mozjpeg: true })
                .toBuffer();
              tileBuffers[id] = resized;
              // Save to disk cache (async, don't await)
              fs.writeFile(cacheFile, resized, () => {});
              break;
            }
          } catch { /* try next url */ }
        }
      }));
    }

    // Build composite inputs for sharp
    const compositeInputs: sharp.OverlayOptions[] = [];
    for (let ci = 0; ci < cols * rows; ci++) {
      const tileId = tileIds[assignment[ci]];
      const buf = tileBuffers[tileId];
      if (!buf) continue;
      const col = ci % cols;
      const row = Math.floor(ci / cols);
      try {
        // Ensure correct size (may already be resized from cache)
        const resized = await sharp(buf).resize(TILE_PX, TILE_PX, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
        compositeInputs.push({ input: resized, top: row * TILE_PX, left: col * TILE_PX });
      } catch { /* skip */ }
    }

    // Render final mosaic – large canvas, use sharp streaming
    console.log(`[print-render] Compositing ${compositeInputs.length} tiles at ${TILE_PX}px → ${outW}×${outH}px`);
    const mosaicJpeg = await sharp({
      create: { width: outW, height: outH, channels: 3, background: { r: 200, g: 200, b: 200 } }
    }).composite(compositeInputs).jpeg({ quality: 93, mozjpeg: true }).toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="mosaicprint-${outW}x${outH}-druckbereit.jpg"`);
    res.setHeader('Content-Length', mosaicJpeg.length);
    res.send(mosaicJpeg);
  } catch (e) {
    console.error('[print-render] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// tRPC API (for Admin panel)
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

// Serve static frontend build
// When running via tsx (dev): __dirname = .../server -> ../client/dist
// When running via node dist/server/index.js (prod): __dirname = .../dist/server -> ../../client/dist
const isCompiledBuild = __dirname.includes("/dist/server") || __dirname.includes("\\dist\\server");
const distPath = isCompiledBuild
  ? path.join(__dirname, "../../client/dist")
  : path.join(__dirname, "../client/dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// Start server immediately (Railway healthcheck needs the port open quickly)
app.listen(PORT, "0.0.0.0", () => {
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
