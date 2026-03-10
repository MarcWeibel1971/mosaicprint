import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import * as db from "./db.js";
import { renderMosaicOnServer, type TileData } from "./mosaicExport.js";
import Stripe from "stripe";

// ---- Constants ----
const TILE_TARGET = 100_000;
const CRON_INTERVAL_MS = 60 * 60 * 1000;

// ---- Color helpers for Smart Import ----
const COLOR_KEYWORDS: Record<string, string[]> = {
  red: ["red","rose","crimson","scarlet","ruby","cherry","fire","sunset","autumn","warm"],
  orange: ["orange","amber","copper","bronze","rust","terracotta","peach","apricot"],
  yellow: ["yellow","gold","lemon","sunflower","honey","mustard","cream","sand","wheat"],
  green: ["green","forest","emerald","lime","mint","sage","olive","moss","jungle","nature"],
  blue: ["blue","ocean","sky","navy","cobalt","azure","teal","cyan","sea","water","ice"],
  purple: ["purple","violet","lavender","lilac","plum","mauve","indigo","magenta"],
  pink: ["pink","rose","blush","coral","salmon","fuchsia","hot pink","flamingo"],
  brown: ["brown","wood","earth","chocolate","coffee","caramel","walnut","bark","soil"],
  black: ["black","dark","night","shadow","coal","ebony","onyx","charcoal","midnight"],
  white: ["white","snow","bright","light","pale","ivory","cream","pearl","cloud","fog"],
  neutral: ["gray","grey","stone","concrete","urban","minimal","monochrome","silver"],
};

function getColorCategory(avgL: number, avgA: number, avgB: number): string {
  if (avgL < 25) return "black";
  if (avgL > 80) return "white";
  if (Math.abs(avgA) < 8 && Math.abs(avgB) < 8) return "neutral";
  if (avgA > 20) return "red";
  if (avgA > 10 && avgB > 10) return "orange";
  if (avgB > 20) return "yellow";
  if (avgA < -10) return "green";
  if (avgB < -15) return "blue";
  if (avgA > 10 && avgB < 0) return "purple";
  if (avgA > 10) return "pink";
  return "neutral";
}

function getBrightnessCategory(avgL: number): string {
  if (avgL < 35) return "dark";
  if (avgL > 65) return "bright";
  return "mid";
}

async function getUnderrepresentedColors(targetPerColor = 500): Promise<string[]> {
  const pool = db.getPool();
  const res = await pool.query(`
    SELECT
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
      END as color_cat,
      COUNT(*) as cnt
    FROM mosaic_images GROUP BY color_cat ORDER BY cnt ASC
  `);
  const underrep: string[] = [];
  for (const row of res.rows) {
    if (Number(row.cnt) < targetPerColor) {
      const keywords = COLOR_KEYWORDS[row.color_cat] ?? [];
      underrep.push(...keywords.slice(0, 3));
    }
  }
  return underrep.length > 0 ? underrep : ["nature", "city", "people", "abstract", "architecture"];
}

// ---- Job state ----
type JobStatus = { running: boolean; log: string[]; startedAt: string | null; finishedAt: string | null; error: string | null; imported: number; total: number };
const importJobStatuses: Record<string, JobStatus> = {};
const smartImportJobs: Record<string, JobStatus> = {};
let rebuildJobStatus = { running: false, log: [] as string[], startedAt: null as string | null, finishedAt: null as string | null, error: null as string | null };

function getImportStatus(sourceId: string): JobStatus {
  if (!importJobStatuses[sourceId]) {
    importJobStatuses[sourceId] = { running: false, log: [], startedAt: null, finishedAt: null, error: null, imported: 0, total: 0 };
  }
  return importJobStatuses[sourceId];
}

async function computeLabForUrl(url: string): Promise<{ L: number; a: number; b: number } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const { data: px, info } = await sharp(buf).resize(8, 8, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = info.width * info.height;
    let rSum = 0, gSum = 0, bSum = 0;
    for (let j = 0; j < px.length; j += 3) { rSum += px[j]; gSum += px[j + 1]; bSum += px[j + 2]; }
    const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const rl = toLinear(rSum / pixels), gl = toLinear(gSum / pixels), bl2 = toLinear(bSum / pixels);
    const X = rl * 0.4124564 + gl * 0.3575761 + bl2 * 0.1804375;
    const Y = rl * 0.2126729 + gl * 0.7151522 + bl2 * 0.0721750;
    const Z = rl * 0.0193339 + gl * 0.1191920 + bl2 * 0.9503041;
    const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const L = 116 * f(Y / 1.0) - 16;
    const a = 500 * (f(X / 0.95047) - f(Y / 1.0));
    const b = 200 * (f(Y / 1.0) - f(Z / 1.08883));
    return { L, a, b };
  } catch {
    return null;
  }
}

// ---- Router ----
export const appRouter = router({
  // Tile pool for mosaic generator
  getTilePool: publicProcedure.query(async () => {
    return db.getMosaicImagesForMatching();
  }),

  // Admin: DB stats
  getDbStats: publicProcedure.query(async () => {
    const count = await db.getMosaicImageCount();
    return { count, target: TILE_TARGET };
  }),

  // Admin: Cron status
  getCronStatus: publicProcedure.query(async () => {
    const current = await db.getMosaicImageCount();
    return { enabled: current < TILE_TARGET, current, target: TILE_TARGET, remaining: Math.max(0, TILE_TARGET - current), intervalHours: 1, nextRunIn: CRON_INTERVAL_MS };
  }),

  // Admin: Import from source (Pexels/Unsplash)
  importFromSource: publicProcedure
    .input(z.object({ source: z.enum(["pexels", "unsplash"]), count: z.number().min(1).max(5000).default(500) }))
    .mutation(async ({ input }) => {
      const status = getImportStatus(input.source);
      if (status.running) return { started: false, message: "Import läuft bereits" };
      status.running = true; status.startedAt = new Date().toISOString(); status.log = []; status.imported = 0; status.total = input.count; status.error = null;
      const log = (msg: string) => { status.log.push(msg); if (status.log.length > 200) status.log = status.log.slice(-200); };
      (async () => {
        try {
          const apiKey = input.source === "pexels" ? process.env.PEXELS_API_KEY : process.env.UNSPLASH_ACCESS_KEY;
          if (!apiKey) { status.error = `${input.source} API key missing`; return; }
          let imported = 0;
          const perPage = 80;
          const pages = Math.ceil(input.count / perPage);
          for (let page = 1; page <= pages && imported < input.count; page++) {
            try {
              let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
              if (input.source === "pexels") {
                const res = await fetch(`https://api.pexels.com/v1/curated?per_page=${perPage}&page=${page}`, { headers: { Authorization: apiKey } });
                const data = await res.json() as any;
                photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.medium, tile128Url: p.src.small }));
              } else {
                const res = await fetch(`https://api.unsplash.com/photos?per_page=${perPage}&page=${page}&order_by=popular`, { headers: { Authorization: `Client-ID ${apiKey}` } });
                const data = await res.json() as any;
                photos = (data ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb }));
              }
              for (const photo of photos) {
                const lab = await computeLabForUrl(photo.tile128Url ?? photo.sourceUrl);
                await db.insertMosaicImage({ ...photo, avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0 });
                imported++;
                status.imported = imported;
              }
              log(`Page ${page}: +${photos.length} (total: ${imported})`);
            } catch (e) { log(`Page ${page} error: ${e}`); }
          }
          log(`✅ Import fertig: ${imported} Bilder`);
          status.finishedAt = new Date().toISOString();
        } catch (e: unknown) {
          status.error = e instanceof Error ? e.message : String(e);
        } finally {
          status.running = false;
        }
      })();
      return { started: true };
    }),

  // Admin: Import status
  getImportStatus: publicProcedure
    .input(z.object({ source: z.enum(["pexels", "unsplash"]).default("pexels") }))
    .query(({ input }) => getImportStatus(input.source)),

  // Admin: Smart Import (fills underrepresented colors)
  smartImport: publicProcedure
    .input(z.object({ sourceId: z.enum(["unsplash", "pexels"]).default("pexels"), count: z.number().min(1).max(2000).default(200) }))
    .mutation(async ({ input }) => {
      const jobKey = `smart_${input.sourceId}`;
      if (smartImportJobs[jobKey]?.running) return { started: false };
      smartImportJobs[jobKey] = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, imported: 0, total: input.count };
      const log = (msg: string) => { smartImportJobs[jobKey].log.push(msg); if (smartImportJobs[jobKey].log.length > 200) smartImportJobs[jobKey].log = smartImportJobs[jobKey].log.slice(-200); };
      (async () => {
        try {
          const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY : process.env.UNSPLASH_ACCESS_KEY;
          if (!apiKey) { smartImportJobs[jobKey].error = "API key missing"; return; }
          const keywords = await getUnderrepresentedColors(500);
          log(`Smart Import: ${keywords.length} Keywords: ${keywords.slice(0, 5).join(", ")}...`);
          let imported = 0;
          for (const kw of keywords) {
            if (imported >= input.count) break;
            try {
              let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
              if (input.sourceId === "pexels") {
                const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(kw)}&per_page=20`, { headers: { Authorization: apiKey } });
                const data = await res.json() as any;
                photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.medium, tile128Url: p.src.small }));
              } else {
                const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(kw)}&per_page=20`, { headers: { Authorization: `Client-ID ${apiKey}` } });
                const data = await res.json() as any;
                photos = (data.results ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb }));
              }
              for (const photo of photos) {
                const lab = await computeLabForUrl(photo.tile128Url ?? photo.sourceUrl);
                await db.insertMosaicImage({ ...photo, avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0 });
                imported++;
                smartImportJobs[jobKey].imported = imported;
              }
              log(`"${kw}": +${photos.length}`);
            } catch (e) { log(`"${kw}" error: ${e}`); }
          }
          log(`✅ Smart Import fertig: ${imported} Bilder`);
          smartImportJobs[jobKey].finishedAt = new Date().toISOString();
        } catch (e: unknown) {
          smartImportJobs[jobKey].error = e instanceof Error ? e.message : String(e);
        } finally {
          smartImportJobs[jobKey].running = false;
        }
      })();
      return { started: true, jobKey };
    }),

  // Admin: Smart Import status
  getSmartImportStatus: publicProcedure
    .input(z.object({ sourceId: z.enum(["unsplash", "pexels"]).default("pexels") }))
    .query(({ input }) => {
      const jobKey = `smart_${input.sourceId}`;
      return smartImportJobs[jobKey] ?? { running: false, log: [], startedAt: null, finishedAt: null, error: null, imported: 0, total: 0 };
    }),

  // Admin: Rebuild tile index (LAB reindex)
  rebuildTileIndex: publicProcedure.mutation(async () => {
    if (rebuildJobStatus.running) return { started: false, message: "Rebuild läuft bereits" };
    rebuildJobStatus = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    const log = (msg: string) => { rebuildJobStatus.log.push(msg); if (rebuildJobStatus.log.length > 300) rebuildJobStatus.log = rebuildJobStatus.log.slice(-300); };
    (async () => {
      try {
        const pool = db.getPool();
        const res = await pool.query("SELECT id, tile128_url FROM mosaic_images WHERE tile128_url IS NOT NULL");
        log(`Indexiere ${res.rows.length} Bilder...`);
        let indexed = 0;
        const CONCURRENCY = 8;
        for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
          const batch = res.rows.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (row: any) => {
            const lab = await computeLabForUrl(row.tile128_url);
            if (lab) {
              await pool.query("UPDATE mosaic_images SET avg_l=$1, avg_a=$2, avg_b=$3 WHERE id=$4", [lab.L, lab.a, lab.b, row.id]);
              indexed++;
            }
          }));
          if (i % 100 === 0) log(`${indexed}/${res.rows.length} indexiert...`);
        }
        log(`✅ Fertig: ${indexed} Bilder reindexiert`);
        rebuildJobStatus.finishedAt = new Date().toISOString();
      } catch (e: unknown) {
        rebuildJobStatus.error = e instanceof Error ? e.message : String(e);
        rebuildJobStatus.finishedAt = new Date().toISOString();
      } finally {
        rebuildJobStatus.running = false;
      }
    })();
    return { started: true };
  }),

  // Admin: Rebuild status
  getRebuildStatus: publicProcedure.query(() => rebuildJobStatus),

  // Admin: Get images with filters
  getAdminImages: publicProcedure
    .input(z.object({ page: z.number().default(1), pageSize: z.number().default(50), brightnessFilter: z.string().optional(), colorFilter: z.string().optional() }))
    .query(async ({ input }) => db.getAdminImages(input)),

  // Admin: Delete image
  deleteMosaicImage: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => db.deleteMosaicImage(input.id)),

  // Admin: Get color distribution
  getColorDistribution: publicProcedure.query(async () => {
    const pool = db.getPool();
    const res = await pool.query(`
      SELECT
        CASE
          WHEN avg_l < 25 THEN 'black' WHEN avg_l > 80 THEN 'white'
          WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 'neutral'
          WHEN avg_a > 20 THEN 'red' WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
          WHEN avg_b > 20 THEN 'yellow' WHEN avg_a < -10 THEN 'green'
          WHEN avg_b < -15 THEN 'blue' WHEN avg_a > 10 AND avg_b < 0 THEN 'purple'
          WHEN avg_a > 10 THEN 'pink' ELSE 'neutral'
        END as color_cat,
        COUNT(*) as cnt
      FROM mosaic_images GROUP BY color_cat ORDER BY cnt DESC
    `);
    return res.rows.map((r: any) => ({ color: r.color_cat, count: Number(r.cnt) }));
  }),

  // Admin: Export seed data
  exportSeed: publicProcedure.mutation(async () => {
    const pool = db.getPool();
    const res = await pool.query("SELECT source_url, tile128_url, avg_l, avg_a, avg_b FROM mosaic_images ORDER BY id");
    return { exported: res.rows.length, tiles: res.rows.map((r: any) => ({ sourceUrl: r.source_url, tile128Url: r.tile128_url, avgL: r.avg_l, avgA: r.avg_a, avgB: r.avg_b })) };
  }),

  // Admin: Orders
  orders: publicProcedure.query(async () => db.getMosaicOrders()),

  // Stripe checkout
  createCheckout: publicProcedure
    .input(z.object({ formatLabel: z.string(), materialLabel: z.string(), priceChf: z.number(), cols: z.number(), rows: z.number(), tilePx: z.number(), overlayAlpha: z.number().optional() }))
    .mutation(async ({ input }) => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) return { url: null, error: "Stripe not configured" };
      const stripe = new Stripe(stripeKey);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{ price_data: { currency: "chf", product_data: { name: `MosaicPrint – ${input.formatLabel} auf ${input.materialLabel}` }, unit_amount: Math.round(input.priceChf * 100) }, quantity: 1 }],
        mode: "payment",
        success_url: `${process.env.BASE_URL ?? "http://localhost:3000"}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.BASE_URL ?? "http://localhost:3000"}/studio`,
        metadata: { formatLabel: input.formatLabel, materialLabel: input.materialLabel, cols: String(input.cols), rows: String(input.rows), tilePx: String(input.tilePx), overlayAlpha: String(input.overlayAlpha ?? 0.18) },
      });
      await db.createMosaicOrder({ stripeSessionId: session.id, formatLabel: input.formatLabel, materialLabel: input.materialLabel, priceChf: input.priceChf });
      return { url: session.url };
    }),

  // Stripe webhook
  webhook: publicProcedure
    .input(z.object({ payload: z.string(), signature: z.string() }))
    .mutation(async ({ input }) => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripeKey || !webhookSecret) return { ok: false };
      const stripe = new Stripe(stripeKey);
      const event = stripe.webhooks.constructEvent(input.payload, input.signature, webhookSecret);
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        await db.markMosaicOrderPaid(session.id);
      }
      return { ok: true };
    }),

  // Server-side mosaic export
  serverExport: publicProcedure
    .input(z.object({ tiles: z.array(z.object({ url: z.string(), col: z.number(), row: z.number() })), cols: z.number(), rows: z.number(), tilePx: z.number(), overlayBase64: z.string().optional(), overlayAlpha: z.number().optional(), formatLabel: z.string() }))
    .mutation(async ({ input }) => {
      const buf = await renderMosaicOnServer({ tiles: input.tiles as TileData[], cols: input.cols, rows: input.rows, tilePx: input.tilePx, overlayBase64: input.overlayBase64, overlayAlpha: input.overlayAlpha });
      const base64 = buf.toString("base64");
      return { base64, mimeType: "image/png" };
    }),

  // Upload tile image
  uploadTileImage: publicProcedure
    .input(z.object({ base64: z.string(), mimeType: z.string().default("image/jpeg") }))
    .mutation(async ({ input }) => {
      const sharp = (await import("sharp")).default;
      const buf = Buffer.from(input.base64, "base64");
      const thumb = await sharp(buf).resize(128, 128, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
      const lab = await computeLabForUrl("data:" + input.mimeType + ";base64," + thumb.toString("base64")).catch(() => null);
      // Store as data URL (no S3 in standalone mode unless configured)
      const tile128Url = "data:image/jpeg;base64," + thumb.toString("base64");
      await db.insertMosaicImage({ sourceUrl: tile128Url, tile128Url, avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0 });
      return { ok: true };
    }),
});

export type AppRouter = typeof appRouter;
