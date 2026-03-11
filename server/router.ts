import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import * as db from "./db.js";
import { renderMosaicOnServer, type TileData } from "./mosaicExport.js";
import Stripe from "stripe";

// ---- Constants ----
const TILE_TARGET = 100_000;
const CRON_INTERVAL_MS = 60 * 60 * 1000;

// ---- Color helpers for Smart Import ----

// Subject/Motiv categories for 3D matrix
const SUBJECTS = ['landscape', 'portrait', 'city', 'nature', 'abstract', 'animal'] as const;
type Subject = typeof SUBJECTS[number];

// Subject-specific search term modifiers
const SUBJECT_MODIFIERS: Record<Subject, string[]> = {
  landscape: ['landscape', 'scenery', 'vista', 'panorama', 'outdoor scene'],
  portrait:  ['portrait', 'face close up', 'person', 'human', 'people'],
  city:      ['city', 'urban', 'street', 'architecture', 'building'],
  nature:    ['nature', 'forest', 'flower', 'plant', 'botanical'],
  abstract:  ['abstract', 'texture', 'pattern', 'bokeh', 'gradient'],
  animal:    ['animal', 'wildlife', 'bird', 'pet', 'creature'],
};

// Color × brightness base keywords (combined with subject modifiers for 3D queries)
const COLOR_BRIGHTNESS_KEYWORDS: Record<string, Record<string, string[]>> = {
  red: {
    dark: ["dark red", "deep crimson", "burgundy wine", "dark rose", "maroon"],
    mid:  ["red flowers", "red autumn leaves", "red fabric", "cherry blossom", "red berries"],
    bright: ["bright red", "red sunset", "red poppy", "scarlet", "red tulip"],
  },
  orange: {
    dark: ["dark orange", "burnt sienna", "rust metal", "dark amber", "terracotta"],
    mid:  ["orange sunset", "autumn leaves orange", "orange fruit", "pumpkin", "copper"],
    bright: ["bright orange", "orange flower", "orange sky", "tangerine", "marigold"],
  },
  yellow: {
    dark: ["dark yellow", "mustard", "dark gold", "ochre", "dark honey"],
    mid:  ["yellow sunflower", "yellow leaves", "golden wheat", "yellow tulip", "sand dunes"],
    bright: ["bright yellow", "lemon yellow", "yellow dandelion", "sunshine", "yellow rose"],
  },
  green: {
    dark: ["dark forest", "dark green leaves", "pine forest", "deep jungle", "dark moss"],
    mid:  ["green nature", "green grass", "green leaves", "fern", "meadow"],
    bright: ["bright green", "lime green", "spring leaves", "fresh grass", "green apple"],
  },
  blue: {
    dark: ["dark blue ocean", "midnight blue", "deep sea", "dark navy", "night sky"],
    mid:  ["blue sky", "blue ocean", "blue water", "blue lake", "cornflower"],
    bright: ["bright blue sky", "turquoise water", "light blue", "azure sky", "cyan sea"],
  },
  purple: {
    dark: ["dark purple", "deep violet", "dark plum", "dark lavender", "eggplant", "purple night", "violet shadow", "amethyst dark", "purple abstract dark", "indigo dark"],
    mid:  ["purple flower", "lavender field", "violet", "purple sunset", "lilac", "wisteria", "purple iris", "violet abstract", "purple bokeh", "amethyst crystal"],
    bright: ["bright purple", "bright violet", "purple orchid", "magenta flower", "fuchsia", "purple neon", "violet light", "purple gradient", "bright lavender", "purple sky"],
  },
  pink: {
    dark: ["dark pink", "deep rose", "dark coral", "dark salmon", "mauve", "dark magenta", "dark fuchsia", "deep pink abstract", "rose dark", "pink shadow"],
    mid:  ["pink flower", "pink blossom", "rose pink", "pink peony", "flamingo", "pink abstract", "pink bokeh", "pink texture", "rose petal", "pink gradient"],
    bright: ["bright pink", "hot pink", "pink tulip", "pink sakura", "light pink", "neon pink", "pink neon light", "bright rose", "pink sky", "pink sunset"],
  },
  cyan: {
    dark: ["dark teal", "deep teal", "dark turquoise", "teal shadow", "dark cyan", "deep aqua", "dark seafoam", "teal abstract dark", "dark emerald water", "deep teal texture"],
    mid:  ["teal color", "turquoise water", "cyan abstract", "teal texture", "aqua color", "teal bokeh", "cyan gradient", "teal nature", "turquoise sea", "teal pattern"],
    bright: ["bright teal", "bright turquoise", "bright cyan", "neon teal", "bright aqua", "cyan neon", "turquoise bright", "teal neon light", "bright seafoam", "cyan sky"],
  },
  brown: {
    dark: ["dark wood", "dark soil", "dark bark", "dark coffee", "dark chocolate"],
    mid:  ["wood texture", "brown earth", "autumn brown", "coffee beans", "leather"],
    bright: ["light wood", "sandy brown", "caramel", "light bark", "wheat field"],
  },
  black: {
    dark: ["black night", "black shadow", "dark silhouette", "black coal", "dark abstract"],
    mid:  ["black and white portrait", "dark grey", "charcoal", "dark stone", "black cat"],
    bright: ["black texture", "dark marble", "black feather", "dark pattern", "black fabric"],
  },
  white: {
    dark: ["white grey", "light grey", "silver", "pale grey", "white fog"],
    mid:  ["white flower", "white cloud", "white snow", "white marble", "white fabric"],
    bright: ["bright white", "white light", "snow bright", "white daisy", "white sky"],
  },
  neutral: {
    dark: ["dark grey urban", "dark concrete", "dark stone wall", "dark asphalt", "dark minimal"],
    mid:  ["grey stone", "grey sky", "grey concrete", "silver metal", "grey texture"],
    bright: ["light grey", "white grey", "pale stone", "light concrete", "bright minimal"],
  },
};

// Subject diversity keywords for variety (portraits, nature, architecture, etc.)
const SUBJECT_KEYWORDS = [
  // Portraits & People
  "portrait face close up", "smiling person", "child portrait", "elderly person", "diverse faces",
  "couple portrait", "group people", "woman portrait", "man portrait", "baby face",
  // Nature & Landscapes
  "mountain landscape", "ocean waves", "forest path", "flower macro", "waterfall",
  "sunrise landscape", "desert sand", "tropical beach", "snow mountain", "green valley",
  // Architecture & Urban
  "city skyline", "building facade", "bridge architecture", "street photography", "interior design",
  "old building", "modern architecture", "window light", "door colorful", "roof tiles",
  // Abstract & Texture
  "colorful abstract", "texture background", "bokeh lights", "paint splash", "geometric pattern",
  "fabric texture", "wood grain", "stone texture", "water reflection", "glass reflection",
  // Food & Objects
  "colorful food", "fruit arrangement", "flowers bouquet", "candles warm light", "coffee art",
];

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

// Analyse the full database and return prioritized import tasks
// Uses 3D matrix: Color × Brightness × Subject (Motiv)
async function analyzeDbGaps(targetPerBucket = 200): Promise<Array<{query: string; priority: number; deficit: number; label: string; subject: string}>> {
  const pool = db.getPool();
  // Count by color × brightness × subject bucket
  const res = await pool.query(`
    SELECT
      CASE
        WHEN avg_l < 25 THEN 'black'
        WHEN avg_l > 80 THEN 'white'
        WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 'neutral'
        WHEN avg_a > 20 THEN 'red'
        WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
        WHEN avg_b > 20 THEN 'yellow'
        WHEN avg_a < -10 AND avg_b < -5 THEN 'cyan'
        WHEN avg_a < -10 THEN 'green'
        WHEN avg_b < -15 THEN 'blue'
        WHEN avg_a > 10 AND avg_b < 0 THEN 'purple'
        WHEN avg_a > 10 THEN 'pink'
        ELSE 'neutral'
      END as color_cat,
      CASE
        WHEN avg_l < 35 THEN 'dark'
        WHEN avg_l > 65 THEN 'bright'
        ELSE 'mid'
      END as brightness_cat,
      COALESCE(subject, 'general') as subject_cat,
      COUNT(*) as cnt
    FROM mosaic_images
    GROUP BY color_cat, brightness_cat, subject_cat
    ORDER BY cnt ASC
  `);

  // Build a set of existing buckets
  const existing = new Map<string, number>();
  for (const row of res.rows) {
    existing.set(`${row.color_cat}|${row.brightness_cat}|${row.subject_cat}`, Number(row.cnt));
  }

  const tasks: Array<{query: string; priority: number; deficit: number; label: string; subject: string}> = [];
  const colors = Object.keys(COLOR_BRIGHTNESS_KEYWORDS);
  const brightnesses = ['dark', 'mid', 'bright'];

  for (const color of colors) {
    for (const brightness of brightnesses) {
      const baseKws = COLOR_BRIGHTNESS_KEYWORDS[color]?.[brightness] ?? [];
      if (baseKws.length === 0) continue;

      for (const subject of SUBJECTS) {
        const bucketKey = `${color}|${brightness}|${subject}`;
        const cnt = existing.get(bucketKey) ?? 0;
        const deficit = Math.max(0, targetPerBucket - cnt);
        if (deficit <= 0) continue;

        const priority = deficit / targetPerBucket;
        const subjectMods = SUBJECT_MODIFIERS[subject];

        // Generate combined queries: colorKeyword + subjectModifier
        for (const baseKw of baseKws.slice(0, 3)) { // top 3 color keywords
          for (const subMod of subjectMods.slice(0, 2)) { // top 2 subject modifiers
            tasks.push({
              query: `${baseKw} ${subMod}`,
              priority,
              deficit,
              label: `${color}/${brightness}/${subject}`,
              subject,
            });
          }
        }
      }

      // Also add pure color queries (subject='general') for overall coverage
      const generalKey = `${color}|${brightness}|general`;
      const generalCnt = existing.get(generalKey) ?? 0;
      const generalDeficit = Math.max(0, targetPerBucket - generalCnt);
      if (generalDeficit > 0) {
        const priority = generalDeficit / targetPerBucket;
        for (const kw of baseKws) {
          tasks.push({ query: kw, priority: priority * 0.8, deficit: generalDeficit, label: `${color}/${brightness}/general`, subject: 'general' });
        }
      }
    }
  }

  // Sort by priority descending (most needed first)
  tasks.sort((a, b) => b.priority - a.priority);
  return tasks;
}

// Legacy function kept for backward compatibility
async function getUnderrepresentedColors(targetPerColor = 500): Promise<string[]> {
  const tasks = await analyzeDbGaps(targetPerColor);
  return tasks.slice(0, 30).map(t => t.query);
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

  // Admin: Tile stats (total + labIndexed)
  getTileStats: publicProcedure.query(async () => {
    try {
      const pool = db.getPool();
      const totalRes = await pool.query("SELECT COUNT(*) FROM mosaic_images");
      const labRes = await pool.query("SELECT COUNT(*) FROM mosaic_images WHERE avg_l IS NOT NULL");
      const total = Number(totalRes.rows[0].count);
      const labIndexed = Number(labRes.rows[0].count);
      return { total, labIndexed, notIndexed: total - labIndexed };
    } catch {
      return { total: 0, labIndexed: 0, notIndexed: 0 };
    }
  }),

  // Admin: API key status
  getApiKeyStatus: publicProcedure.query(() => {
    return {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      unsplash: !!process.env.UNSPLASH_ACCESS_KEY,
      pexels: !!process.env.PEXELS_API_KEY,
    };
  }),

  // Admin: DB stats (detailed)
  getDbStats: publicProcedure.query(async () => {
    try {
      const pool = db.getPool();
      // Total count
      const countRes = await pool.query("SELECT COUNT(*) as cnt FROM mosaic_images");
      const total = Number(countRes.rows[0]?.cnt ?? 0);
      // LAB indexed (not default 50/0/0)
      const labRes = await pool.query("SELECT COUNT(*) as cnt FROM mosaic_images WHERE NOT (avg_l = 50 AND avg_a = 0 AND avg_b = 0)");
      const labIndexed = Number(labRes.rows[0]?.cnt ?? 0);
      // By source (detect from source_url)
      const srcRes = await pool.query(`
        SELECT
          CASE
            WHEN source_url LIKE '%picsum%' THEN 'picsum'
            WHEN source_url LIKE '%unsplash%' THEN 'unsplash'
            WHEN source_url LIKE '%pexels%' THEN 'pexels'
            ELSE 'other'
          END as src,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY src
      `);
      const bySource: Record<string, number> = {};
      for (const row of srcRes.rows) bySource[row.src] = Number(row.cnt);
      // By color (LAB hue classification)
      const colorRes = await pool.query(`
        SELECT
          CASE
            WHEN avg_l < 25 THEN 'schwarz'
            WHEN avg_l > 80 THEN 'weiss'
            WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 'grau'
            WHEN avg_a > 20 THEN 'rot'
            WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
            WHEN avg_b > 20 THEN 'gelb'
            WHEN avg_a < -10 AND avg_b < -5 THEN 'cyan'
            WHEN avg_a < -10 THEN 'gruen'
            WHEN avg_b < -15 THEN 'blau'
            WHEN avg_a > 10 AND avg_b < 0 THEN 'violett'
            WHEN avg_a > 10 THEN 'pink'
            ELSE 'grau'
          END as color,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY color
      `);
      const byColor: Record<string, number> = {};
      for (const row of colorRes.rows) byColor[row.color] = Number(row.cnt);
      // By brightness
      const brightRes = await pool.query(`
        SELECT
          CASE
            WHEN avg_l < 35 THEN 'dunkel'
            WHEN avg_l > 65 THEN 'hell'
            ELSE 'mittel'
          END as brightness,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY brightness
      `);
      const byBrightness: Record<string, number> = {};
      for (const row of brightRes.rows) byBrightness[row.brightness] = Number(row.cnt);
      // By subject (motiv)
      const subjectRes = await pool.query(`
        SELECT COALESCE(subject, 'general') as subject, COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY subject
        ORDER BY cnt DESC
      `);
      const bySubject: Record<string, number> = {};
      for (const row of subjectRes.rows) bySubject[row.subject] = Number(row.cnt);
      // 3D matrix gaps analysis
      const gapTasks = await analyzeDbGaps(200);
      const topGaps = gapTasks.slice(0, 20).map(t => ({ label: t.label, deficit: t.deficit, query: t.query }));
      return { total, labIndexed, bySource, byColor, byBrightness, bySubject, topGaps, count: total, target: TILE_TARGET };
    } catch (e) {
      console.error('[getDbStats error]', e);
      return { total: 0, labIndexed: 0, bySource: {}, byColor: {}, byBrightness: {}, bySubject: {}, topGaps: [], count: 0, target: TILE_TARGET };
    }
  }),

  // Admin: Cron status
  getCronStatus: publicProcedure.query(async () => {
    try {
      const current = await db.getMosaicImageCount();
      return { enabled: current < TILE_TARGET, current, target: TILE_TARGET, remaining: Math.max(0, TILE_TARGET - current), intervalHours: 1, nextRunIn: CRON_INTERVAL_MS };
    } catch {
      return { enabled: false, current: 0, target: TILE_TARGET, remaining: TILE_TARGET, intervalHours: 1, nextRunIn: CRON_INTERVAL_MS };
    }
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

  // Admin: Smart Import (DB-gap analysis → fills most needed color×brightness buckets first)
  smartImport: publicProcedure
    .input(z.object({
      sourceId: z.enum(["unsplash", "pexels"]).default("pexels"),
      count: z.number().min(1).max(5000).default(500),
      targetPerBucket: z.number().min(100).max(2000).default(400),
    }))
    .mutation(async ({ input }) => {
      const jobKey = `smart_${input.sourceId}`;
      if (smartImportJobs[jobKey]?.running) return { started: false };
      smartImportJobs[jobKey] = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, imported: 0, total: input.count };
      const log = (msg: string) => { smartImportJobs[jobKey].log.push(msg); if (smartImportJobs[jobKey].log.length > 500) smartImportJobs[jobKey].log = smartImportJobs[jobKey].log.slice(-500); };
      (async () => {
        try {
          const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY : process.env.UNSPLASH_ACCESS_KEY;
          if (!apiKey) { smartImportJobs[jobKey].error = "API key missing"; return; }

          // Analyse DB gaps: get prioritized list of (query, deficit, label)
          const tasks = await analyzeDbGaps(input.targetPerBucket);
          log(`🔍 DB-Analyse: ${tasks.length} Import-Tasks gefunden (Ziel: ${input.targetPerBucket} pro Bucket)`);
          log(`Top-Prioritäten: ${tasks.slice(0, 5).map(t => `${t.label}(${t.deficit})`).join(", ")}`);

          let imported = 0;
          const CONCURRENCY = 3; // parallel LAB computation
          const perPage = input.sourceId === "pexels" ? 30 : 20;

          for (const task of tasks) {
            if (imported >= input.count) break;
            try {
              let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
              if (input.sourceId === "pexels") {
                const res = await fetch(
                  `https://api.pexels.com/v1/search?query=${encodeURIComponent(task.query)}&per_page=${perPage}&orientation=square`,
                  { headers: { Authorization: apiKey } }
                );
                if (!res.ok) { log(`⚠️ Pexels API error ${res.status} for "${task.query}"`); continue; }
                const data = await res.json() as any;
                photos = (data.photos ?? []).map((p: any) => ({
                  sourceUrl: p.src.large,
                  tile128Url: p.src.small,
                }));
              } else {
                const res = await fetch(
                  `https://api.unsplash.com/search/photos?query=${encodeURIComponent(task.query)}&per_page=${perPage}&orientation=squarish`,
                  { headers: { Authorization: `Client-ID ${apiKey}` } }
                );
                if (!res.ok) { log(`⚠️ Unsplash API error ${res.status} for "${task.query}"`); continue; }
                const data = await res.json() as any;
                photos = (data.results ?? []).map((p: any) => ({
                  sourceUrl: p.urls.regular,
                  tile128Url: p.urls.thumb,
                }));
              }

              // Process in parallel batches for speed
              let batchImported = 0;
              for (let i = 0; i < photos.length; i += CONCURRENCY) {
                const batch = photos.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (photo) => {
                  try {
                    const lab = await computeLabForUrl(photo.tile128Url ?? photo.sourceUrl);
                    await db.insertMosaicImage({ ...photo, avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0, subject: task.subject ?? 'general' });
                    imported++;
                    batchImported++;
                    smartImportJobs[jobKey].imported = imported;
                  } catch { /* skip duplicates / errors */ }
                }));
              }
              if (batchImported > 0) {
                log(`✓ [${task.label}] "${task.query}": +${batchImported} (deficit was ${task.deficit})`);
              }
            } catch (e) { log(`✗ "${task.query}" error: ${e}`); }
          }
          log(`✅ Smart Import fertig: ${imported} neue Bilder importiert`);
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
    .input(z.object({
      page: z.number().default(1),
      pageSize: z.number().default(50),
      limit: z.number().optional(),       // alias for pageSize (client sends 'limit')
      brightnessFilter: z.string().optional(),
      colorFilter: z.string().optional(),
      sourceId: z.string().optional(),    // filter by source: 'pexels' | 'unsplash' | 'picsum'
    }))
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
