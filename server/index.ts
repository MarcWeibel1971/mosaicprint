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
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";
import * as db from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));

// ---- REST endpoints expected by Studio.tsx ----

// GET /api/trpc/getTilePool?limit=2000&labOnly=true
// Returns a STRATIFIED random sample across all color×brightness buckets
// Ensures color diversity: not just the oldest/most common images
app.get("/api/trpc/getTilePool", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 5000), 50000);
    const labOnly = req.query.labOnly === "true";
    const pool = db.getPool();

    // Stratified sampling: pick up to perBucket images from each color×brightness bucket
    // 11 color categories × 3 brightness levels = 33 buckets max
    // perBucket = ceil(limit / 33) ensures we fill the limit with diverse images
    const perBucket = Math.ceil(limit / 33);
    const result = await pool.query(`
      WITH ranked AS (
        SELECT id, avg_l, avg_a, avg_b,
          ROW_NUMBER() OVER (
            PARTITION BY
              CASE
                WHEN avg_l < 25 THEN 'black'
                WHEN avg_l > 80 THEN 'white'
                WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 'neutral'
                WHEN avg_a > 20 THEN 'red'
                WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
                WHEN avg_b > 20 THEN 'yellow'
                WHEN avg_a < -10 THEN 'green'
                WHEN avg_b < -15 THEN 'blue'
                WHEN avg_a > 10 AND avg_b < 0 THEN 'purple'
                WHEN avg_a > 10 THEN 'pink'
                ELSE 'neutral'
              END,
              CASE WHEN avg_l < 35 THEN 'dark' WHEN avg_l > 65 THEN 'bright' ELSE 'mid' END
            ORDER BY RANDOM()
          ) as rn
        FROM mosaic_images
        WHERE avg_l IS NOT NULL
      )
      SELECT id, avg_l as "avgL", avg_a as "avgA", avg_b as "avgB"
      FROM ranked
      WHERE rn <= $1
      ORDER BY RANDOM()
      LIMIT $2
    `, [perBucket, limit]);

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

// GET /api/tile/:id?size=64  – redirect to tile128_url or source_url
app.get("/api/tile/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const size = Number(req.query.size ?? 128);
    const pool = await db.getPool();
    const result = await pool.query(
      "SELECT source_url, tile128_url FROM mosaic_images WHERE id = $1",
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    const row = result.rows[0];
    const url = size <= 128 && row.tile128_url ? row.tile128_url : row.source_url;
    // If it's a data URL (uploaded tile), serve it directly
    if (url.startsWith("data:")) {
      const [header, b64] = url.split(",");
      const mimeType = header.split(":")[1].split(";")[0];
      const buf = Buffer.from(b64, "base64");
      res.set("Content-Type", mimeType);
      res.set("Cache-Control", "public, max-age=86400");
      return res.send(buf);
    }
    // Otherwise redirect to the external URL
    res.set("Cache-Control", "public, max-age=86400");
    res.redirect(302, url);
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
