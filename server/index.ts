import "dotenv/config";
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

// GET /api/trpc/getTilePool?limit=500&labOnly=true
// Returns array of {id, l, a, b} or full tile objects
app.get("/api/trpc/getTilePool", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 5000), 50000);
    const labOnly = req.query.labOnly === "true";
    const pool = await db.getMosaicImagesForMatching();
    const sliced = pool.slice(0, limit);
    if (labOnly) {
      res.json(sliced.map(t => ({ id: t.id, l: t.avgL, a: t.avgA, b: t.avgB })));
    } else {
      res.json(sliced);
    }
  } catch (e) {
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
app.listen(PORT, () => {
  console.log(`[MosaicPrint] Server running on port ${PORT}`);
  console.log(`[MosaicPrint] Static files from: ${distPath}`);
  console.log(`[MosaicPrint] DB URL set: ${!!process.env.DATABASE_URL}`);
});

// Initialize DB schema in background (non-blocking)
db.ensureSchema()
  .then(() => {
    console.log("[MosaicPrint] DB schema initialized successfully");
  })
  .catch((e) => {
    console.error("[MosaicPrint] DB init failed (non-fatal):", e.message);
  });
