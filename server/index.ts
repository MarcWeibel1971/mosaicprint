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
    // Also fetch quadrant data + is_skin_friendly + edge_energy + AI scores for richer feature vector
    const result = await pool.query(
      `SELECT id, avg_l, avg_a, avg_b,
              tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
              bl_l, bl_a, bl_b, br_l, br_a, br_b,
              COALESCE(is_skin_friendly, (SQRT(avg_a * avg_a + avg_b * avg_b) < 25 AND avg_l >= 35 AND avg_l <= 80)) as is_skin_friendly,
              COALESCE(tile_type, 'medium') as tile_type,
              edge_energy,
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
    // Pack as Float32Array: [id, L, a, b, tl_a, tl_b, tr_a, tr_b, bl_a, bl_b, br_a, br_b, edge, brightness, isSkinFriendly, tileComplexity] = 16 floats
    // Quadrant a/b values encode color distribution per quadrant (TL, TR, BL, BR)
    // edge: echter Sobel-Kantenwert aus DB (edge_energy), Fallback: L-Varianz-Proxy für ältere Tiles
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
      // For tile128 (≤128px): prefer R2 URL (permanent, fast CDN)
      const effectiveTile128 = row.r2_url || row.tile128_url || '';
      // For hi-res (>128px): prefer original source_url (full resolution from Pexels/Unsplash)
      // R2 only stores 128px thumbnails, so source_url gives much better quality at zoom
      const effectiveSource = row.source_url || row.r2_url || '';
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
      `SELECT id, tile128_url, source_url, r2_url FROM mosaic_images WHERE id = ANY($1)`,
      [ids]
    );
    const urlMap: Record<number, string> = {};
    for (const row of result.rows) {
      if (wantHiRes) {
        // For hi-res/print: prefer original source_url (full resolution from Pexels/Unsplash ~940px)
        // R2 only stores 128px thumbnails - source_url gives much better zoom quality
        urlMap[row.id] = row.source_url || row.r2_url || row.tile128_url || '';
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
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space'];
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
  "importKeywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "keywordSuggestions": [
    {"keyword": "search term", "reason": "why needed for mosaic", "priority": "high|medium|low"}
  ]
}
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
     `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY2}`,
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

    console.log(`[Gemini] Analysis: sceneType=${sceneType} hasFace=${hasFace} skinTone=${attributes.skinTone} hairColor=${attributes.hairColor}`);
    console.log(`[Gemini] Description: ${description}`);
    console.log(`[Gemini] Keywords: ${importKeywords.join(', ')}`);
    console.log(`[Gemini] Regions: face=${regions.face?.pct}% bg=${regions.background?.pct}% profile=${algoRecommendations.recommendedProfile}`);

    return res.json({
      ok: true,
      description,
      sceneType,
      hasFace,
      faceCount,
      attributes,
      regions,
      algoRecommendations,
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
    const VALID_THEMES = ['sunset','ocean','nature','winter','urban','portrait','abstract','food','travel','general','animals','flowers','space'];
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

    // Fetch unique tile IDs needed – prefer r2_url (permanent), then source_url for hi-res
    const uniqueIds = [...new Set(assignment.map(idx => tileIds[idx]).filter(Boolean))];
    const result = await pool.query(
      `SELECT id, tile128_url, source_url, r2_url, source_provider FROM mosaic_images WHERE id = ANY($1)`,
      [uniqueIds]
    );
    const urlMap: Record<number, { hiRes: string; fallback: string }> = {};
    for (const row of result.rows) {
      if (row.r2_url) {
        urlMap[row.id] = { hiRes: row.r2_url, fallback: row.r2_url };
      } else if (row.source_provider === 'pixabay') {
        // Skip Pixabay tiles without R2 URL (hotlink-protected)
        continue;
      } else {
        urlMap[row.id] = {
          hiRes: row.source_url || '',
          fallback: row.tile128_url || row.source_url || ''
        };
      }
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
            // Prefer tile128_url (smaller, faster), fall back to source_url
            const url = row.tile128_url || row.source_url;
            if (!url || url.startsWith('data:')) {
              r2MigrationStatus.skippedNoUrl++;
              r2MigrationStatus.done++;
              return;
            }
            // Skip hotlink-protected URLs (Pixabay direct downloads)
            if (isHotlinkProtected(url)) {
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
  const whereClause = forceReanalyze
    ? `r2_url IS NOT NULL AND quality_status != 'rejected'`
    : `r2_url IS NOT NULL AND (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND quality_status != 'rejected'`;
  const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images WHERE ${whereClause}`);
  const total = Number(countRes.rows[0]?.cnt ?? 0);
  aiJobState.total = total;
  aiJobState.processed = 0;
  aiJobState.rejected = 0;
  aiJobState.errors = 0;

  const CONCURRENCY = 8;           // Reduziert von 20 auf 8 um 429-Fehler zu vermeiden
  const RATE_LIMIT_DELAY_MS = 500;  // 500ms zwischen Chunks = ~16 req/s gesamt

  const PROMPT = `You are evaluating a 128x128 pixel image tile for use in a large photo mosaic (heart shape, Times Square display).
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
  "reject_reason": "watermark|face_closeup|blurry|logo|text_overlay|low_quality|null",
  "theme": "portrait_face|portrait_skin|nature_forest|nature_mountain|nature_ocean|nature_sunset|nature_snow|city_night|city_architecture|animal|abstract_colorful|abstract_dark|abstract_light|food|other",
  "content_tags": ["tag1", "tag2", "tag3"]
}
Scoring rules:
- mosaic_score (0-100): Overall suitability as mosaic tile. 90-100=excellent natural scene/texture, 70-89=good, 40-69=acceptable, 0-39=poor. Penalize: faces >20% area (-30), text/logo (-40), watermarks (-80), heavy noise/blur (-50), pure white/black (-20).
- calm_score (0-100): Visual uniformity. 90-100=solid color or very smooth gradient (sky, water, wall). 60-89=gentle texture (grass, sand, bokeh). 30-59=moderate detail. 0-29=chaotic/busy (crowd, busy pattern, noise).
- color_richness (0-100): Color variety. 90-100=many distinct colors. 50-89=moderate variety. 10-49=limited palette. 0-9=near monochrome.
- fill_uniformity (0-100): How well the image fills the tile as a single coherent scene. 90-100=one clear subject fills entire tile. 50-89=mostly one scene. 0-49=fragmented, collage, or multiple unrelated elements.
- reject=true ONLY if: visible watermark, face fills >50% of tile, severely blurry/noisy, explicit logo/brand overlay.
Return ONLY the JSON object, no explanation, no markdown.`;

  const themeMap: Record<string, string> = {
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
          } else if (geminiResp.status === 429) {
            // Rate limit: wait 60s and retry once
            console.warn(`[ai-job] Rate limit (429) for tile ${tile.id}, waiting 60s...`);
            await new Promise(r => setTimeout(r, 60000));
            const retryResp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }]}],
                  generationConfig: { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 300 },
                }),
                signal: AbortSignal.timeout(30000),
              }
            );
            if (retryResp.ok) {
              const retryData = await retryResp.json() as any;
              const rawText = retryData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
              try { aiResult = JSON.parse(rawText); } catch { aiResult = {}; }
            } else {
              console.warn(`[ai-job] Retry also failed for tile ${tile.id}: ${retryResp.status}`);
              aiJobState.errors++;
              aiJobState.lastError = `Tile ${tile.id}: HTTP ${retryResp.status} (retry)`;
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

          await pool.query(
            `UPDATE mosaic_images SET
               ai_suitability = $1, ai_reject_reason = $2, ai_theme = $3,
               ai_has_face = $4, ai_face_pct = $5, ai_is_calm = $6,
               ai_content_tags = $7, ai_analyzed_at = NOW(), semantic_theme = $3,
               ai_mosaic_score = $9, ai_calm_score = $10,
               ai_color_richness = $11, ai_fill_uniformity = $12, ai_has_text = $13
             WHERE id = $8`,
            [
              suitability,
              aiResult.reject_reason === 'null' ? null : (aiResult.reject_reason ?? null),
              mappedTheme, aiResult.has_face ?? false, aiResult.face_area_pct ?? 0,
              isCalm, JSON.stringify(aiResult.content_tags ?? []), tile.id,
              mosaicScore, calmScore, colorRich, fillUnif, aiResult.has_text ?? false,
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
        COUNT(*) FILTER (WHERE (ai_analyzed_at IS NULL OR ai_mosaic_score IS NULL) AND r2_url IS NOT NULL AND quality_status != 'rejected') as pending_with_r2,
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
