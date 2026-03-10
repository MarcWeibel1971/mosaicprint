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

// Health check
app.get("/api/health", async (_req, res) => {
  const count = await db.getMosaicImageCount().catch(() => 0);
  res.json({ ok: true, tiles: count });
});

// tRPC API (for Admin panel)
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

// Serve static frontend build
const distPath = path.join(__dirname, "../client/dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// Initialize DB schema on startup
db.ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[MosaicPrint] Server running on port ${PORT}`);
      console.log(`[MosaicPrint] DB: ${process.env.DATABASE_URL ? "PostgreSQL connected" : "No DB URL set"}`);
    });
  })
  .catch((e) => {
    console.error("[MosaicPrint] DB init failed:", e);
    process.exit(1);
  });
