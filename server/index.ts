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
import { cronState } from "./cron-state.js";
// Sharp for fast image processing (native libvips, 10-50x faster than Jimp)
import sharp from "sharp";
import { downloadAndUploadToR2, isR2Configured } from "./r2.js";

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
      res.setHeader('X-Floats-Per-Tile', '16');
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
              COALESCE(is_skin_friendly, (SQRT(avg_a * avg_a + avg_b * avg_b) < 25 AND avg_l >= 35 AND avg_l <= 80)) as is_skin_friendly,
              COALESCE(tile_type, 'medium') as tile_type
       FROM mosaic_images
       WHERE avg_l IS NOT NULL ${themeFilter} ORDER BY id ASC`,
      queryParams
    );
    const rows = result.rows;
    // Pack as Float32Array: [id, L, a, b, tl_a, tl_b, tr_a, tr_b, bl_a, bl_b, br_a, br_b, edge, brightness, isSkinFriendly, tileComplexity] = 16 floats
    // Quadrant a/b values encode color distribution per quadrant (TL, TR, BL, BR)
    // edge: variance of L across quadrants (high variance = high edge energy)
    // brightness: avg_l / 100
    // isSkinFriendly: 1.0 = skin-friendly tile, 0.0 = not skin-friendly
    // tileComplexity: 0.0=calm, 0.5=medium, 1.0=busy (from tile_type column)
    const FLOATS_PER_TILE = 16;
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
      const tileComplexity = row.tile_type === 'calm' ? 0.0 : row.tile_type === 'busy' ? 1.0 : 0.5;
      buf.writeFloatLE(isSkinFriendly, offset);   offset += 4;  // [14] isSkinFriendly
      buf.writeFloatLE(tileComplexity, offset);   offset += 4;  // [15] tileComplexity (0=calm, 0.5=medium, 1=busy)
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
        "SELECT source_url, tile128_url, r2_url FROM mosaic_images WHERE id = $1",
        [id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
      const row = result.rows[0];
      // Prefer R2 URL (permanent) over CDN URLs (may expire)
      const effectiveTile128 = row.r2_url || row.tile128_url || '';
      const effectiveSource = row.r2_url || row.source_url || '';
      tileUrls = { tile128Url: effectiveTile128, sourceUrl: effectiveSource, ts: Date.now() };
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
      `SELECT id, tile128_url, source_url FROM mosaic_images WHERE id = ANY($1)`,
      [ids]
    );
    const urlMap: Record<number, string> = {};
    for (const row of result.rows) {
      if (wantHiRes) {
        // For print: prefer source_url (original hi-res from Unsplash/Pexels), fallback to tile128_url
        urlMap[row.id] = row.source_url || row.tile128_url || '';
      } else {
        // For screen zoom: tile128_url is fast and sufficient
        urlMap[row.id] = row.tile128_url || row.source_url || '';
      }
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

// ── fal.ai Image Analysis ────────────────────────────────────────────────────
// POST /api/analyze-image-fal
// Body: { imageBase64: string, mimeType?: string }
// Returns: { description, sceneType, attributes, keywordSuggestions, hasFace, faceCount }
app.post('/api/analyze-image-fal', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const FAL_KEY = process.env.FAL_AI_KEY || '3895037d-8203-4913-bb33-8be7665771e4:29c49fc075b096e60783b291fc7467c9';
    const { imageBase64, imageUrl: directUrl, mimeType = 'image/jpeg' } = req.body ?? {};
    if (!imageBase64 && !directUrl) return res.status(400).json({ error: 'imageBase64 or imageUrl required' });

    let file_url: string;

    if (directUrl) {
      // Use URL directly for Florence-2
      file_url = directUrl;
    } else {
      // Step 1: Upload image to fal.ai storage
      const imgBuf = Buffer.from(imageBase64, 'base64');
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
        method: 'POST',
        headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: `analysis.${ext}`, content_type: mimeType }),
      });
      if (!initResp.ok) throw new Error(`fal.ai storage initiate failed: ${initResp.status}`);
      const { file_url: furl, upload_url } = await initResp.json() as { file_url: string; upload_url: string };
      file_url = furl;

      // Step 2: Upload the actual image bytes
      const uploadResp = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: imgBuf,
      });
      if (!uploadResp.ok) throw new Error(`fal.ai storage upload failed: ${uploadResp.status}`);
    }

    // Step 3: Run Florence-2 for detailed caption
    const captionResp = await fetch('https://fal.run/fal-ai/florence-2-large/more-detailed-caption', {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: file_url }),
      signal: AbortSignal.timeout(30000),
    });
    if (!captionResp.ok) throw new Error(`Florence-2 failed: ${captionResp.status}`);
    const captionData = await captionResp.json() as { results?: string };
    const description = captionData.results ?? '';

    // Step 4: Parse description into structured attributes
    const lower = description.toLowerCase();
    const hasFace = /\bface\b|\bperson\b|\bman\b|\bwoman\b|\bportrait\b|\bgirl\b|\bboy\b|\bchild\b|\bpeople\b/.test(lower);
    const hasBeard = /\bbeard\b|\bstubble\b|\bmustache\b/.test(lower);
    const hasGlasses = /\bglasses\b|\bspectacles\b|\beyeglasses\b|\bsunglasses\b|\bshades\b/.test(lower);
    const hasWhiteHair = /\bwhite hair\b|\bgray hair\b|\bgrey hair\b|\bsilver hair\b/.test(lower);
    const isNight = /\bnight\b|\bdark sky\b|\bskyline\b|\bneon\b|\bcity lights\b/.test(lower);
    const isNature = /\bforest\b|\btrees\b|\bmountain\b|\bocean\b|\bsea\b|\bbeach\b|\briver\b|\blandscape\b/.test(lower);
    const isColorful = /\bcolorful\b|\bvibrant\b|\bbright colors\b|\brainbow\b/.test(lower);
    const isArchitecture = /\bbuilding\b|\barchitecture\b|\bbridge\b|\bstreet\b|\bcity\b/.test(lower);

    // Determine scene type
    let sceneType = 'unknown';
    if (hasFace && hasWhiteHair) sceneType = 'portrait_white_hair';
    else if (hasFace) sceneType = 'portrait';
    else if (isNight) sceneType = 'night_skyline';
    else if (isNature) sceneType = 'nature';
    else if (isArchitecture) sceneType = 'architecture';
    else if (isColorful) sceneType = 'colorful';

    // Generate keyword suggestions for tile import
    const keywordSuggestions: Array<{keyword: string; reason: string; priority: string}> = [];
    if (hasFace) {
      keywordSuggestions.push({ keyword: 'portrait face skin tone warm', reason: 'Gesicht erkannt – Hautton-Tiles benötigt', priority: 'high' });
      if (hasBeard) keywordSuggestions.push({ keyword: 'beard stubble dark texture', reason: 'Bart erkannt', priority: 'medium' });
      if (hasGlasses) keywordSuggestions.push({ keyword: 'glasses reflection lens', reason: 'Brille erkannt', priority: 'medium' });
      if (hasWhiteHair) keywordSuggestions.push({ keyword: 'white gray silver texture light', reason: 'Weißes/graues Haar erkannt', priority: 'high' });
    }
    if (isNight) keywordSuggestions.push({ keyword: 'night city lights dark blue', reason: 'Nacht-Szene erkannt', priority: 'high' });
    if (isNature) keywordSuggestions.push({ keyword: 'nature green forest landscape', reason: 'Natur-Szene erkannt', priority: 'medium' });
    if (isColorful) keywordSuggestions.push({ keyword: 'colorful vibrant abstract', reason: 'Farbige Szene erkannt', priority: 'medium' });

    console.log(`[fal.ai] Analysis: sceneType=${sceneType} hasFace=${hasFace} beard=${hasBeard} glasses=${hasGlasses}`);
    console.log(`[fal.ai] Description: ${description.substring(0, 100)}...`);

    return res.json({
      ok: true,
      description,
      sceneType,
      hasFace,
      faceCount: hasFace ? 1 : 0,
      attributes: { hasBeard, hasGlasses, hasWhiteHair, isNight, isNature, isColorful, isArchitecture },
      keywordSuggestions,
      imageUrl: file_url,
    });
  } catch (e: any) {
    console.error('[fal.ai analyze] Error:', e);
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
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', cached.jpeg.length);
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.setHeader('X-Atlas-Cols', cached.cols.toString());
      res.setHeader('X-Atlas-Rows', cached.rows.toString());
      res.setHeader('X-Atlas-TileSize', cached.tileSize.toString());
      res.setHeader('X-Atlas-Map', JSON.stringify(cached.map));
      return res.send(cached.jpeg);
    }

    const pool = db.getPool();
    const placeholders = ids.map((_,i) => `$${i+1}`).join(',');
    const result = await pool.query(
      `SELECT id, tile128_url, source_url FROM mosaic_images WHERE id IN (${placeholders}) ORDER BY id ASC`,
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
        const url = row.tile128_url || row.source_url || '';
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
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', atlasResult.jpeg.length);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.setHeader('X-Atlas-Cols', atlasResult.cols.toString());
    res.setHeader('X-Atlas-Rows', atlasResult.rows.toString());
    res.setHeader('X-Atlas-TileSize', tileSize.toString());
    res.setHeader('X-Atlas-Map', JSON.stringify(atlasResult.map));
    return res.send(atlasResult.jpeg);
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

    // Build atlas using Jimp (pure JS, no native binaries)
    const CONCURRENCY = 50; // Pro plan: higher concurrency
    const tileBuffers2 = new Map<number, Buffer>();
    for (let i = 0; i < n; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row: any) => {
        const url = row.tile128_url || row.source_url || '';
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

    // PRINT_TILE_PX: client sends outW/cols (= target tile size at 300 DPI)
    // Clamp between 64 (minimum for visible detail) and 400 (memory limit)
    // At 128px: 100 cols × 128px = 12800px wide (fine for 30cm @ 300 DPI)
    // At 300px: 50 cols × 300px = 15000px wide (excellent for 50cm @ 300 DPI)
    const TILE_PX = Math.min(Math.max(tilePx, 64), 400);
    const outW = cols * TILE_PX;
    const outH = rows * TILE_PX;
    console.log(`[print-render] Request: cols=${cols} rows=${rows} tilePx=${tilePx} → clamped=${TILE_PX} output=${outW}×${outH}px`);
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
    const CONCURRENCY = 20; // Pro plan: higher concurrency for print rendering
    for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
      const batch = uniqueIds.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (id) => {
        const urls = urlMap[id];
        if (!urls) return;
        // Check disk cache first (keyed by tile id + size to avoid stale smaller tiles)
        const cacheFile = path.join(HIRES_CACHE_DIR, `${id}-${TILE_PX}.jpg`);
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
              const resized = await resizeTileJimp(buf, TILE_PX);
              if (resized) {
                tileBuffers[id] = resized;
                // Save to disk cache (async, don't await)
                fs.writeFile(cacheFile, resized, () => {});
              }
              break;
            }
          } catch { /* try next url */ }
        }
      }));
    }

    // Build composite inputs for Jimp strip rendering
    // For large images (>8000px), render in row-strips to avoid OOM
    // Each strip = STRIP_ROWS rows, composited separately, then joined vertically
    const STRIP_ROWS = Math.max(1, Math.floor(4000 / TILE_PX)); // ~4000px per strip
    const totalCells = cols * rows;
    console.log(`[print-render] Building ${totalCells} tile composites at ${TILE_PX}px → ${outW}×${outH}px (${Math.ceil(rows/STRIP_ROWS)} strips)`);

    // Pre-resize all unique tile buffers to TILE_PX (they may already be cached at this size)
    const resizedBuffers: Record<number, Buffer> = {};
    for (const [id, buf] of Object.entries(tileBuffers)) {
      try {
        const rBuf = await resizeTileJimp(buf, TILE_PX);
        if (rBuf) resizedBuffers[Number(id)] = rBuf;
      } catch { /* skip bad tiles */ }
    }

    // Render strips and collect them
    const stripBuffers: Buffer[] = [];
    for (let stripStart = 0; stripStart < rows; stripStart += STRIP_ROWS) {
      const stripEnd = Math.min(stripStart + STRIP_ROWS, rows);
      const stripH = (stripEnd - stripStart) * TILE_PX;
      const compositeInputs: Array<{ buf: Buffer; top: number; left: number }> = [];

      for (let r = stripStart; r < stripEnd; r++) {
        for (let c = 0; c < cols; c++) {
          const ci = r * cols + c;
          const tileId = tileIds[assignment[ci]];
          const buf = resizedBuffers[tileId];
          if (!buf) continue;
          compositeInputs.push({
            buf,
            top: (r - stripStart) * TILE_PX,
            left: c * TILE_PX,
          });
        }
      }

      // Build strip using Sharp composite
      const sharpCompositeInputs = compositeInputs.map(ci => ({
        input: ci.buf,
        top: ci.top,
        left: ci.left,
      }));
      const stripJpeg = await sharp({
        create: { width: outW, height: stripH, channels: 3, background: { r: 180, g: 180, b: 180 } }
      })
        .composite(sharpCompositeInputs)
        .jpeg({ quality: 92 })
        .toBuffer();
      stripBuffers.push(stripJpeg);
      console.log(`[print-render] Strip ${Math.floor(stripStart/STRIP_ROWS)+1}/${Math.ceil(rows/STRIP_ROWS)} done (${compositeInputs.length} tiles)`);
    }
    // Join strips vertically using Sharp
    let mosaicJpeg: Buffer;
    if (stripBuffers.length === 1) {
      mosaicJpeg = stripBuffers[0];
    } else {
      const stripImages = await Promise.all(stripBuffers.map(async (buf, i) => {
        const meta = await sharp(buf).metadata();
        return { input: buf, top: i * (meta.height ?? 0), left: 0 };
      }));
      // Calculate cumulative offsets
      let yOff = 0;
      const compositeStrips = [];
      for (const buf of stripBuffers) {
        const meta = await sharp(buf).metadata();
        compositeStrips.push({ input: buf, top: yOff, left: 0 });
        yOff += meta.height ?? 0;
      }
      mosaicJpeg = await sharp({
        create: { width: outW, height: outH, channels: 3, background: { r: 180, g: 180, b: 180 } }
      })
        .composite(compositeStrips)
        .jpeg({ quality: 92 })
        .toBuffer();
    }
    console.log(`[print-render] Done: ${(mosaicJpeg.length / 1024 / 1024).toFixed(1)} MB`);

    // Save to temp file and return a download token.
    // This allows the client to open a direct HTTP URL (window.location.href = url)
    // which forces Edge/Chrome to treat it as a binary file download,
    // bypassing Adobe Acrobat's file association that intercepts Blob downloads.
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpDir = '/tmp/mosaicprint-downloads';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${token}.jpg`);
    fs.writeFileSync(tmpFile, mosaicJpeg);
    // Auto-delete after 10 minutes
    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 10 * 60 * 1000);

    const filename = `mosaicprint-${outW}x${outH}-druckbereit.jpg`;
    res.json({ token, filename, size: mosaicJpeg.length, width: outW, height: outH });
  } catch (e) {
    console.error('[print-render] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/print-download/:token – serve the pre-rendered JPEG file
// Client opens this URL directly (window.location.href) to force a binary download
app.get('/api/print-download/:token', (req, res) => {
  const { token } = req.params;
  // Validate token: only alphanumeric, dash, dot
  if (!/^[\w.-]+$/.test(token)) return res.status(400).send('Invalid token');
  const tmpFile = path.join('/tmp/mosaicprint-downloads', `${token}.jpg`);
  if (!fs.existsSync(tmpFile)) return res.status(404).send('File not found or expired');
  const filename = req.query.filename as string || 'mosaicprint-druckbereit.jpg';
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const stream = fs.createReadStream(tmpFile);
  stream.pipe(res);
});

// POST /api/admin/migrate-to-r2 – migrate existing tiles to R2 storage
// Runs in background, returns job status via GET /api/admin/migrate-to-r2/status
const r2MigrationStatus = { running: false, done: 0, total: 0, errors: 0, startedAt: null as string | null, finishedAt: null as string | null };
app.post('/api/admin/migrate-to-r2', async (_req, res) => {
  if (!isR2Configured()) return res.status(400).json({ error: 'R2 not configured' });
  if (r2MigrationStatus.running) return res.json({ started: false, message: 'Already running', status: r2MigrationStatus });
  r2MigrationStatus.running = true;
  r2MigrationStatus.done = 0;
  r2MigrationStatus.errors = 0;
  r2MigrationStatus.startedAt = new Date().toISOString();
  r2MigrationStatus.finishedAt = null;
  res.json({ started: true, message: 'Migration started in background' });
  // Run migration in background
  (async () => {
    try {
      const pool = db.getPool();
      // Get all tiles without R2 URL (or with expired CDN URLs)
      const result = await pool.query(
        `SELECT id, source_url, tile128_url FROM mosaic_images WHERE r2_url IS NULL ORDER BY id ASC`
      );
      r2MigrationStatus.total = result.rows.length;
      console.log(`[R2 Migration] Starting migration of ${result.rows.length} tiles`);
      const CONCURRENCY = 20;
      for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
        const batch = result.rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (row: { id: number; source_url: string; tile128_url: string }) => {
          try {
            const url = row.tile128_url || row.source_url;
            if (!url || url.startsWith('data:')) { r2MigrationStatus.done++; return; }
            const r2Url = await downloadAndUploadToR2(row.id, url);
            if (r2Url) {
              await pool.query('UPDATE mosaic_images SET r2_url = $1 WHERE id = $2', [r2Url, row.id]);
              // Invalidate tile URL cache
              tileUrlCache.delete(row.id);
            } else {
              r2MigrationStatus.errors++;
            }
            r2MigrationStatus.done++;
          } catch {
            r2MigrationStatus.errors++;
            r2MigrationStatus.done++;
          }
        }));
        if (i % 500 === 0) console.log(`[R2 Migration] Progress: ${r2MigrationStatus.done}/${r2MigrationStatus.total}`);
      }
    } catch (e) {
      console.error('[R2 Migration] Error:', e);
    } finally {
      r2MigrationStatus.running = false;
      r2MigrationStatus.finishedAt = new Date().toISOString();
      console.log(`[R2 Migration] Done: ${r2MigrationStatus.done} tiles, ${r2MigrationStatus.errors} errors`);
    }
  })();
});
app.get('/api/admin/migrate-to-r2/status', (_req, res) => {
  res.json(r2MigrationStatus);
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

// ── Hourly Auto-Import Cron-Job ────────────────────────────────────────────────
// Runs every hour, uses gap-based analysis to fill most-needed color buckets first
// Uses Pexels as primary source (25k req/month), Pixabay as fallback
const CRON_TILE_TARGET = 100_000;
const CRON_IMPORT_PER_RUN = 300;  // max tiles per hourly run
const CRON_INTERVAL_MS_LOCAL = 60 * 60 * 1000; // 1 hour

async function runAutoImportCron() {
  if (cronState.running) {
    console.log('[cron] Auto-import already running, skipping');
    return;
  }
  try {
    const pool = db.getPool();
    const countRes = await pool.query('SELECT COUNT(*) FROM mosaic_images');
    const current = Number(countRes.rows[0].count);
    if (current >= CRON_TILE_TARGET) {
      console.log(`[cron] Target reached (${current}/${CRON_TILE_TARGET}), skipping auto-import`);
      cronState.lastResult = `Ziel erreicht: ${current.toLocaleString()}/${CRON_TILE_TARGET.toLocaleString()} Bilder`;
      return;
    }
    cronState.running = true;
    cronState.lastRun = new Date().toISOString();
    console.log(`[cron] Auto-import starting: ${current}/${CRON_TILE_TARGET} tiles, importing ${CRON_IMPORT_PER_RUN}`);

    // Gap analysis: find most-needed color buckets
    const { analyzeDbGapsForCron } = await import('./router.js');
    const gapTasks = await analyzeDbGapsForCron(200);
    const keywords = gapTasks.slice(0, 20).map((t: any) => t.query);
    console.log(`[cron] Top gaps: ${keywords.slice(0, 5).join(', ')}...`);

    // Try Pexels first, Pixabay as fallback
    const sources = [
      { name: 'pexels', key: process.env.PEXELS_API_KEY, perPage: 80, baseUrl: 'https://api.pexels.com/v1/search' },
      { name: 'pixabay', key: process.env.PIXABAY_API_KEY, perPage: 100, baseUrl: 'https://pixabay.com/api/' },
    ];

    let totalImported = 0;
    for (const source of sources) {
      if (totalImported >= CRON_IMPORT_PER_RUN) break;
      if (!source.key) { console.log(`[cron] ${source.name} API key missing, skipping`); continue; }

      for (const keyword of keywords) {
        if (totalImported >= CRON_IMPORT_PER_RUN) break;
        try {
          const page = Math.floor(Math.random() * 5) + 1;
          let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];

          if (source.name === 'pexels') {
            const res = await fetch(
              `${source.baseUrl}?query=${encodeURIComponent(keyword)}&per_page=${source.perPage}&page=${page}&orientation=square`,
              { headers: { Authorization: source.key } }
            );
            if (!res.ok) { console.log(`[cron] Pexels ${res.status} for "${keyword}"`); continue; }
            const data = await res.json() as any;
            photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
          } else if (source.name === 'pixabay') {
            const res = await fetch(
              `${source.baseUrl}?key=${encodeURIComponent(source.key)}&q=${encodeURIComponent(keyword)}&per_page=${source.perPage}&page=${page}&image_type=photo&safesearch=true`,
              { headers: { 'Accept': 'application/json' } }
            );
            if (!res.ok) { console.log(`[cron] Pixabay ${res.status} for "${keyword}"`); continue; }
            const data = await res.json() as any;
            photos = (data.hits ?? []).map((p: any) => ({
              sourceUrl: p.largeImageURL || p.webformatURL || '',
              tile128Url: p.webformatURL || p.previewURL || '',
            })).filter((p: any) => p.tile128Url);
          }

          // Insert new photos (dedup by source_url)
          let batchNew = 0;
          for (const photo of photos) {
            if (totalImported >= CRON_IMPORT_PER_RUN) break;
            if (!photo.tile128Url) continue;
            try {
              // Fetch and process the tile image
              const imgRes = await fetch(photo.tile128Url);
              if (!imgRes.ok) continue;
              const imgBuf = Buffer.from(await imgRes.arrayBuffer());
              // Resize to 128px and compute LAB
              const resized = await sharp(imgBuf).resize(128, 128, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
              const { data: px, info } = resized;
              const pixelCount = info.width * info.height;
              // Compute average LAB
              let rSum = 0, gSum = 0, bSum2 = 0;
              for (let j = 0; j < px.length; j += 3) { rSum += px[j]; gSum += px[j + 1]; bSum2 += px[j + 2]; }
              const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
              const rl = toLinear(rSum / pixelCount), gl = toLinear(gSum / pixelCount), bl2 = toLinear(bSum2 / pixelCount);
              const X = rl * 0.4124564 + gl * 0.3575761 + bl2 * 0.1804375;
              const Y = rl * 0.2126729 + gl * 0.7151522 + bl2 * 0.0721750;
              const Z = rl * 0.0193339 + gl * 0.1191920 + bl2 * 0.9503041;
              const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
              const avgL = 116 * f(Y / 1.0) - 16;
              const avgA = 500 * (f(X / 0.95047) - f(Y / 1.0));
              const avgB = 200 * (f(Y / 1.0) - f(Z / 1.08883));
              // Insert into DB (ignore duplicates)
              const result = await pool.query(
                `INSERT INTO mosaic_images (tile128_url, source_url, avg_l, avg_a, avg_b, source_name)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (source_url) DO NOTHING
                 RETURNING id`,
                [photo.tile128Url, photo.sourceUrl || photo.tile128Url, avgL, avgA, avgB, source.name]
              );
              if (result.rows.length > 0) { totalImported++; batchNew++; }
            } catch { /* skip failed tiles */ }
          }
          if (batchNew > 0) console.log(`[cron] "${keyword}" (${source.name}): +${batchNew}`);
        } catch (e) { console.log(`[cron] Error for "${keyword}": ${e}`); }
      }
    }

    cronState.lastResult = `+${totalImported} Bilder importiert (${new Date().toLocaleTimeString('de-CH')})`;
    console.log(`[cron] Auto-import done: +${totalImported} tiles (total: ${current + totalImported}/${CRON_TILE_TARGET})`);
    // Invalidate tile index cache after import
    if (totalImported > 0) invalidateIndexCache();
  } catch (e) {
    console.error('[cron] Auto-import error:', e);
    cronState.lastResult = `Fehler: ${e}`;
  } finally {
    cronState.running = false;
  }
}

// Start cron after 2 minute delay (let server stabilize first)
setTimeout(() => {
  console.log('[cron] Auto-import cron-job initialized (runs every hour)');
  runAutoImportCron(); // First run immediately after startup delay
  setInterval(runAutoImportCron, CRON_INTERVAL_MS_LOCAL);
}, 2 * 60 * 1000);
