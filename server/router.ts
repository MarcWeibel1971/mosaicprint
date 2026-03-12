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
    dark: ["dark forest", "dark green leaves", "pine forest", "deep jungle", "dark moss", "dark emerald", "deep green abstract", "dark olive", "forest shadow", "dark fern"],
    mid:  ["green nature", "green grass", "green leaves", "fern", "meadow", "emerald green", "sage green", "mint green", "olive green", "green bokeh", "green abstract", "jade green"],
    bright: ["bright green", "lime green", "spring leaves", "fresh grass", "green apple", "vivid green", "neon green", "bright emerald", "electric green", "bright lime"],
  },
  blue: {
    dark: ["dark blue ocean", "midnight blue", "deep sea", "dark navy", "night sky", "deep blue abstract", "dark indigo", "navy blue texture", "dark cobalt", "deep ocean blue"],
    mid:  ["blue sky", "blue ocean", "blue water", "blue lake", "cornflower", "cobalt blue", "sapphire blue", "blue abstract", "blue bokeh", "royal blue", "periwinkle", "blue gradient"],
    bright: ["bright blue sky", "turquoise water", "light blue", "azure sky", "cyan sea", "vivid blue", "electric blue", "bright cobalt", "sky blue clear", "bright azure", "neon blue"],
  },
  purple: {
    dark: ["dark purple", "deep violet", "dark plum", "dark lavender", "eggplant", "purple night", "violet shadow", "amethyst dark", "purple abstract dark", "indigo dark", "dark indigo texture", "deep violet abstract"],
    mid:  ["purple flower", "lavender field", "violet", "purple sunset", "lilac", "wisteria", "purple iris", "violet abstract", "purple bokeh", "amethyst crystal", "violet bokeh", "purple nature", "indigo blue", "violet gradient"],
    bright: ["bright purple", "bright violet", "purple orchid", "magenta flower", "fuchsia", "purple neon", "violet light", "purple gradient", "bright lavender", "purple sky", "vivid violet", "electric purple", "bright magenta"],
  },
  pink: {
    dark: ["dark pink", "deep rose", "dark coral", "dark salmon", "mauve", "dark magenta", "dark fuchsia", "deep pink abstract", "rose dark", "pink shadow"],
    mid:  ["pink flower", "pink blossom", "rose pink", "pink peony", "flamingo", "pink abstract", "pink bokeh", "pink texture", "rose petal", "pink gradient"],
    bright: ["bright pink", "hot pink", "pink tulip", "pink sakura", "light pink", "neon pink", "pink neon light", "bright rose", "pink sky", "pink sunset"],
  },
  cyan: {
    dark: ["dark teal", "deep teal", "dark turquoise", "teal shadow", "dark cyan", "deep aqua", "dark seafoam", "teal abstract dark", "dark emerald water", "deep teal texture", "dark teal wall", "deep cyan ocean"],
    mid:  ["teal color", "turquoise water", "cyan abstract", "teal texture", "aqua color", "teal bokeh", "cyan gradient", "teal nature", "turquoise sea", "teal pattern", "cyan blue water", "teal green nature", "aquamarine", "seafoam green"],
    bright: ["bright teal", "bright turquoise", "bright cyan", "neon teal", "bright aqua", "cyan neon", "turquoise bright", "teal neon light", "bright seafoam", "cyan sky", "tropical turquoise water", "bright aqua pool", "vivid cyan"],
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

// ── Score-based keyword lists ────────────────────────────────────────────────
// These lists are used when the DB proportion is BELOW the target.
// Targets (from the Portrait-Quality-Score UI):
//   low-sat (sqrt(a²+b²) < 20):  target 30% → import MEDIUM-sat images to reduce low-sat share
//   mid-sat (20–42):             target 40%
//   high-sat (>42):              target 30%
//   cool (avg_b < -5):           target 20%
//   extreme-dark (avg_l < 20):   target 10%
//   extreme-bright (avg_l > 85): target 10%

// MEDIUM_SAT_KEYWORDS: Images with moderate saturation (sat 20-42) – reduces low-sat share
// Use these when low-sat > 40% (currently 67%!)
const MEDIUM_SAT_KEYWORDS = [
  // Warm mid-sat: skin tones, wood, earth
  "autumn leaves warm", "wooden texture warm", "terracotta pottery", "warm brick wall",
  "brown leather texture", "copper metal surface", "warm stone wall", "rustic wood grain",
  "warm sand dunes", "golden wheat field", "honey jar closeup", "caramel dessert",
  // Cool mid-sat: sky, water, stone
  "overcast sky blue", "grey blue ocean", "misty mountain blue", "blue grey stone",
  "slate texture cool", "blue grey concrete", "cool morning fog", "blue grey abstract",
  // Neutral mid-sat: portraits, fabric
  "portrait natural light", "linen fabric texture", "cotton fabric closeup", "denim texture",
  "muted green plant", "sage green wall", "dusty rose fabric", "muted blue fabric",
];

// COOL_KEYWORDS: Blue/teal/cool-toned images – currently only 14% (target 20%)
const COOL_KEYWORDS = [
  "blue ocean waves", "teal water surface", "cool blue sky", "icy blue abstract",
  "blue grey pebbles", "cool morning mist", "blue steel texture", "arctic ice blue",
  "cool blue bokeh", "blue winter landscape", "teal green water", "cool shadow blue",
  "blue grey fog", "cool blue gradient", "midnight blue texture", "blue stone surface",
  "cool blue portrait", "blue hour photography", "teal abstract art", "cool cyan water",
];

// EXTREME_DARK_KEYWORDS: Very dark images (avg_l < 20) – currently only 2% (target 10%)
const EXTREME_DARK_KEYWORDS = [
  "pure black background", "black velvet texture", "dark night sky stars", "black coal texture",
  "black ink abstract", "dark shadow minimal", "black marble texture", "night photography dark",
  "black fur closeup", "dark forest night", "black metal texture", "very dark abstract",
  "black leather texture", "dark void abstract", "black stone texture", "deep shadow portrait",
];

// EXTREME_BRIGHT_KEYWORDS: Very bright images (avg_l > 85) – currently only 1% (target 10%)
const EXTREME_BRIGHT_KEYWORDS = [
  "pure white background", "bright white snow", "overexposed white light", "white marble texture",
  "bright white clouds", "white foam ocean", "white paper texture bright", "white flower macro bright",
  "bright sunlight reflection", "white sand beach bright", "white fabric bright", "white wall bright",
  "bright white abstract", "white bokeh bright", "overexposed portrait", "white studio background",
];

// LOW_SAT_KEYWORDS: Neutral/gray/skin-tone tiles – critical for portrait quality
// These are imported with DOUBLED priority in smartImport because portrait matching
// suffers most from a lack of neutral/skin-friendly tiles in the pool.
const LOW_SAT_KEYWORDS = [
  // Pure neutrals & grays
  "gray texture abstract", "concrete wall closeup", "beige minimal background",
  "light gray smooth surface", "dark gray stone texture", "silver metal surface",
  "white paper texture", "pale linen fabric", "off-white wall texture",
  // Skin-tone neutrals (FIX C: expanded for better portrait matching)
  "skin tone neutral background", "warm beige bokeh", "soft peach background",
  "nude color minimal", "warm ivory texture", "blush pink neutral",
  "human skin texture closeup", "skin pore closeup macro", "warm tan skin",
  "peach cream background soft", "warm caramel texture", "light brown smooth",
  "sand beach closeup warm", "warm wood grain light", "honey golden texture",
  "terracotta clay texture", "rose gold minimal", "warm amber bokeh",
  // Portrait-specific warm tones
  "portrait studio warm light", "golden hour skin glow", "warm sunset portrait",
  "soft focus portrait warm", "natural skin glow", "warm candlelight face",
  // High-key / low-key
  "high key portrait background", "pure black background abstract",
  "bright white overexposed", "deep shadow abstract minimal",
  "soft gray gradient background", "neutral studio backdrop",
  // Desaturated nature
  "black white bokeh", "monochrome fog landscape", "grayscale water reflection",
  "desaturated autumn leaves", "muted earth tones", "warm sepia texture",
];

// HIGH_SAT_KEYWORDS: Vivid, saturated images – critical for colorful mosaics
// Score shows only 4% high-sat (target 30%) – these fill the gap
const HIGH_SAT_KEYWORDS = [
  // Vivid nature
  "vivid rainbow colors", "colorful tropical fish", "bright coral reef", "vivid butterfly",
  "colorful parrot", "vivid flowers macro", "bright tropical bird", "rainbow abstract",
  // Vivid food & objects
  "colorful macarons", "vivid fruit market", "bright candy colors", "colorful vegetables",
  "vivid paint splatter", "bright neon lights", "colorful umbrellas", "vivid balloons",
  // Vivid abstract
  "vibrant abstract art", "colorful gradient vivid", "neon abstract bright", "vivid color explosion",
  "saturated color texture", "bright vivid bokeh", "colorful smoke abstract", "rainbow gradient",
  // Cool vivid
  "vivid blue turquoise", "bright teal ocean", "electric blue abstract", "vivid cyan water",
  "bright indigo purple", "vivid violet abstract", "electric green nature", "bright lime abstract",
];

// EXTREME_BRIGHTNESS_KEYWORDS: Very dark and very bright tiles for eyes, hair, highlights
const EXTREME_BRIGHTNESS_KEYWORDS = [
  // Very dark (for dark hair, pupils, deep shadows)
  "black hair closeup", "dark eye closeup", "black cat fur", "dark night minimal",
  "deep shadow portrait", "black velvet texture", "dark ink abstract",
  // Very bright (for highlights, teeth, white backgrounds)
  "bright white light bokeh", "white snow closeup", "bright highlight abstract",
  "white foam water", "overexposed sky white", "bright sunlight reflection",
  "white flower macro", "bright eye highlight",
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
// NEW: Uses REAL DB proportions (score metrics) to set priorities, not just bucket counts
async function analyzeDbGaps(targetPerBucket = 200): Promise<Array<{query: string; priority: number; deficit: number; label: string; subject: string}>> {
  const pool = db.getPool();

  // ── Step 1: Measure real DB proportions (same metrics as Portrait-Quality-Score) ──
  const statsRes = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE SQRT(avg_a * avg_a + avg_b * avg_b) < 20) as low_sat,
      COUNT(*) FILTER (WHERE SQRT(avg_a * avg_a + avg_b * avg_b) BETWEEN 20 AND 42) as mid_sat,
      COUNT(*) FILTER (WHERE SQRT(avg_a * avg_a + avg_b * avg_b) > 42) as high_sat,
      COUNT(*) FILTER (WHERE avg_b < -5) as cool,
      COUNT(*) FILTER (WHERE avg_l < 20) as extreme_dark,
      COUNT(*) FILTER (WHERE avg_l > 85) as extreme_bright
    FROM mosaic_images
  `);
  const s = statsRes.rows[0];
  const total = Math.max(1, Number(s.total));
  const lowSatPct  = Number(s.low_sat)  / total;  // target: 0.30
  const midSatPct  = Number(s.mid_sat)  / total;  // target: 0.40
  const highSatPct = Number(s.high_sat) / total;  // target: 0.30
  const coolPct    = Number(s.cool)     / total;  // target: 0.20
  const exDarkPct  = Number(s.extreme_dark)  / total; // target: 0.10
  const exBrightPct = Number(s.extreme_bright) / total; // target: 0.10

  // Priority = how far below target we are (0 = at target, 1 = completely missing)
  // If ABOVE target, priority is 0 (no import needed)
  const highSatPriority  = Math.max(0, (0.30 - highSatPct)  / 0.30) * 3.0;  // max 3.0
  const midSatPriority   = Math.max(0, (0.40 - midSatPct)   / 0.40) * 2.5;  // max 2.5
  const coolPriority     = Math.max(0, (0.20 - coolPct)     / 0.20) * 2.0;  // max 2.0
  const exDarkPriority   = Math.max(0, (0.10 - exDarkPct)   / 0.10) * 2.5;  // max 2.5
  const exBrightPriority = Math.max(0, (0.10 - exBrightPct) / 0.10) * 2.5;  // max 2.5
  // LOW_SAT is penalized if already above target (67% vs 30% target)
  const lowSatPriority   = Math.max(0, (0.30 - lowSatPct)   / 0.30) * 1.5;  // 0 if >30%

  const tasks: Array<{query: string; priority: number; deficit: number; label: string; subject: string}> = [];

  // ── Step 2: Score-metric based tasks (highest priority) ──

  // HIGH_SAT: currently 6%, target 30% → priority ~2.4
  if (highSatPriority > 0.1) {
    const deficit = Math.round((0.30 - highSatPct) * total);
    for (const kw of HIGH_SAT_KEYWORDS) {
      tasks.push({ query: kw, priority: highSatPriority, deficit, label: `ἰ8 Hoch-Sättigung (${Math.round(highSatPct*100)}% → Ziel 30%)`, subject: 'general' });
    }
  }

  // EXTREME_DARK: currently 2%, target 10% → priority ~2.0
  if (exDarkPriority > 0.1) {
    const deficit = Math.round((0.10 - exDarkPct) * total);
    for (const kw of EXTREME_DARK_KEYWORDS) {
      tasks.push({ query: kw, priority: exDarkPriority, deficit, label: `⚫ Extrem-Dunkel (${Math.round(exDarkPct*100)}% → Ziel 10%)`, subject: 'general' });
    }
  }

  // EXTREME_BRIGHT: currently 1%, target 10% → priority ~2.25
  if (exBrightPriority > 0.1) {
    const deficit = Math.round((0.10 - exBrightPct) * total);
    for (const kw of EXTREME_BRIGHT_KEYWORDS) {
      tasks.push({ query: kw, priority: exBrightPriority, deficit, label: `⚪ Extrem-Hell (${Math.round(exBrightPct*100)}% → Ziel 10%)`, subject: 'general' });
    }
  }

  // COOL: currently 14%, target 20% → priority ~0.6
  if (coolPriority > 0.1) {
    const deficit = Math.round((0.20 - coolPct) * total);
    for (const kw of COOL_KEYWORDS) {
      tasks.push({ query: kw, priority: coolPriority, deficit, label: `❄️ Kühl-Töne (${Math.round(coolPct*100)}% → Ziel 20%)`, subject: 'general' });
    }
  }

  // MID_SAT: currently 27%, target 40% → priority ~0.8
  if (midSatPriority > 0.1) {
    const deficit = Math.round((0.40 - midSatPct) * total);
    for (const kw of MEDIUM_SAT_KEYWORDS) {
      tasks.push({ query: kw, priority: midSatPriority, deficit, label: `🌈 Mittel-Sättigung (${Math.round(midSatPct*100)}% → Ziel 40%)`, subject: 'general' });
    }
  }

  // LOW_SAT: only import if BELOW 30% target (currently 67% → priority = 0, skip!)
  if (lowSatPriority > 0.1) {
    const deficit = Math.round((0.30 - lowSatPct) * total);
    for (const kw of LOW_SAT_KEYWORDS) {
      tasks.push({ query: kw, priority: lowSatPriority, deficit, label: `🧖 Niedrig-Sättigung (${Math.round(lowSatPct*100)}% → Ziel 30%)`, subject: 'portrait' });
    }
  }

  // ── Step 3: Color bucket gaps (lower priority, fills color diversity) ──
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
  const existing = new Map<string, number>();
  for (const row of res.rows) {
    existing.set(`${row.color_cat}|${row.brightness_cat}|${row.subject_cat}`, Number(row.cnt));
  }

  const colors = Object.keys(COLOR_BRIGHTNESS_KEYWORDS);
  const brightnesses = ['dark', 'mid', 'bright'];
  for (const color of colors) {
    for (const brightness of brightnesses) {
      const baseKws = COLOR_BRIGHTNESS_KEYWORDS[color]?.[brightness] ?? [];
      if (baseKws.length === 0) continue;
      // Skip neutral/mid – already over-represented (low-sat)
      if (color === 'neutral' && lowSatPct > 0.35) continue;
      const generalKey = `${color}|${brightness}|general`;
      const generalCnt = existing.get(generalKey) ?? 0;
      const generalDeficit = Math.max(0, targetPerBucket - generalCnt);
      if (generalDeficit > 0) {
        // Cap color bucket priority at 0.8 (below score-metric tasks)
        const priority = Math.min(0.8, generalDeficit / targetPerBucket * 0.8);
        for (const kw of baseKws.slice(0, 2)) {
          tasks.push({ query: kw, priority, deficit: generalDeficit, label: `${color}/${brightness}`, subject: 'general' });
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

// Compute LAB from raw RGB pixels (3 bytes per pixel)
function rgbPixelsToLab(px: Buffer, pixelCount: number): { L: number; a: number; b: number } {
  let rSum = 0, gSum = 0, bSum = 0;
  for (let j = 0; j < px.length; j += 3) { rSum += px[j]; gSum += px[j + 1]; bSum += px[j + 2]; }
  const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const rl = toLinear(rSum / pixelCount), gl = toLinear(gSum / pixelCount), bl2 = toLinear(bSum / pixelCount);
  const X = rl * 0.4124564 + gl * 0.3575761 + bl2 * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bl2 * 0.0721750;
  const Z = rl * 0.0193339 + gl * 0.1191920 + bl2 * 0.9503041;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return {
    L: 116 * f(Y / 1.0) - 16,
    a: 500 * (f(X / 0.95047) - f(Y / 1.0)),
    b: 200 * (f(Y / 1.0) - f(Z / 1.08883)),
  };
}

// Compute global LAB + 4-quadrant LAB from a URL (fetches image once, resizes to 8x8)
// Returns global + TL/TR/BL/BR quadrant LAB values
async function computeLabFull(url: string): Promise<{
  L: number; a: number; b: number;
  tlL: number; tlA: number; tlB: number;
  trL: number; trA: number; trB: number;
  blL: number; blA: number; blB: number;
  brL: number; brA: number; brB: number;
} | null> {
  try {
    const sharp = (await import("sharp")).default;
    let buf: Buffer;
    if (url.startsWith("data:")) {
      // data URL: decode base64 directly
      const b64 = url.split(",")[1];
      buf = Buffer.from(b64, "base64");
    } else {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      buf = Buffer.from(await resp.arrayBuffer());
    }
    // Resize to 8x8 for global + quadrant extraction
    // 8x8 = 64 pixels, quadrants = 4x4 each (TL, TR, BL, BR)
    const { data: px } = await sharp(buf).resize(8, 8, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Global LAB (all 64 pixels)
    const global = rgbPixelsToLab(px, 64);
    // Extract quadrant pixels: 8x8 image, each quadrant is 4x4 = 16 pixels
    // Row-major: pixel(x,y) = px[(y*8 + x) * 3]
    const extractQuadrant = (startX: number, startY: number): Buffer => {
      const qpx = Buffer.allocUnsafe(16 * 3);
      let qi = 0;
      for (let y = startY; y < startY + 4; y++) {
        for (let x = startX; x < startX + 4; x++) {
          const src = (y * 8 + x) * 3;
          qpx[qi++] = px[src]; qpx[qi++] = px[src + 1]; qpx[qi++] = px[src + 2];
        }
      }
      return qpx;
    };
    const tl = rgbPixelsToLab(extractQuadrant(0, 0), 16); // top-left
    const tr = rgbPixelsToLab(extractQuadrant(4, 0), 16); // top-right
    const bl = rgbPixelsToLab(extractQuadrant(0, 4), 16); // bottom-left
    const br = rgbPixelsToLab(extractQuadrant(4, 4), 16); // bottom-right
    return {
      L: global.L, a: global.a, b: global.b,
      tlL: tl.L, tlA: tl.a, tlB: tl.b,
      trL: tr.L, trA: tr.a, trB: tr.b,
      blL: bl.L, blA: bl.a, blB: bl.b,
      brL: br.L, brA: br.a, brB: br.b,
    };
  } catch {
    return null;
  }
}

// Legacy: compute only global LAB (used where quadrant data is not needed)
async function computeLabForUrl(url: string): Promise<{ L: number; a: number; b: number } | null> {
  const full = await computeLabFull(url);
  return full ? { L: full.L, a: full.a, b: full.b } : null;
}

// ---- Router ----
export const appRouter = router({
  // Tile pool for mosaic generator
  getTilePool: publicProcedure.query(async () => {
    return db.getMosaicImagesForMatching();
  }),

  // Admin: Tile stats (total + labIndexed + quadrantIndexed)
  getTileStats: publicProcedure.query(async () => {
    try {
      const pool = db.getPool();
      const totalRes = await pool.query("SELECT COUNT(*) FROM mosaic_images");
      const labRes = await pool.query("SELECT COUNT(*) FROM mosaic_images WHERE avg_l IS NOT NULL");
      // Count tiles with real quadrant data (not just default zeros)
      const quadRes = await pool.query(
        "SELECT COUNT(*) FROM mosaic_images WHERE NOT (tl_a = 0 AND tl_b = 0 AND tr_a = 0 AND tr_b = 0)"
      );
      const total = Number(totalRes.rows[0].count);
      const labIndexed = Number(labRes.rows[0].count);
      const quadrantIndexed = Number(quadRes.rows[0].count);
      return { total, labIndexed, notIndexed: total - labIndexed, quadrantIndexed, quadrantMissing: total - quadrantIndexed };
    } catch {
      return { total: 0, labIndexed: 0, notIndexed: 0, quadrantIndexed: 0, quadrantMissing: 0 };
    }
  }),

  // Admin: API key status
  getApiKeyStatus: publicProcedure.query(() => {
    return {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      unsplash: !!process.env.UNSPLASH_ACCESS_KEY,
      pexels: !!process.env.PEXELS_API_KEY,
      pixabay: !!process.env.PIXABAY_API_KEY,
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
      // Warm vs. Cool distribution (hue angle: a>0 = warm/red side, b<0 = cool/blue side)
      const warmCoolRes = await pool.query(`
        SELECT
          CASE
            WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 'neutral'
            WHEN avg_a > 0 AND avg_b >= 0 THEN 'warm'
            WHEN avg_a > 0 AND avg_b < 0 THEN 'warm'
            WHEN avg_b < -8 THEN 'kuehl'
            WHEN avg_a < -8 THEN 'kuehl'
            ELSE 'neutral'
          END as temp,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY temp
      `);
      const byWarmCool: Record<string, number> = {};
      for (const row of warmCoolRes.rows) byWarmCool[row.temp] = Number(row.cnt);

      // Extended brightness: extreme dark (<10), dark (10-35), mid (35-65), bright (65-90), extreme bright (>90)
      const extBrightRes = await pool.query(`
        SELECT
          CASE
            WHEN avg_l < 10 THEN 'extrem_dunkel'
            WHEN avg_l < 35 THEN 'dunkel'
            WHEN avg_l < 65 THEN 'mittel'
            WHEN avg_l < 90 THEN 'hell'
            ELSE 'extrem_hell'
          END as brightness5,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY brightness5
      `);
      const byBrightness5: Record<string, number> = {};
      for (const row of extBrightRes.rows) byBrightness5[row.brightness5] = Number(row.cnt);

      // Saturation buckets: low (<30%), mid (30-70%), high (>70%) – chroma = sqrt(a²+b²)
      const satRes = await pool.query(`
        SELECT
          CASE
            WHEN SQRT(avg_a * avg_a + avg_b * avg_b) < 18 THEN 'niedrig'
            WHEN SQRT(avg_a * avg_a + avg_b * avg_b) < 42 THEN 'mittel'
            ELSE 'hoch'
          END as sat,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY sat
      `);
      const bySaturation: Record<string, number> = {};
      for (const row of satRes.rows) bySaturation[row.sat] = Number(row.cnt);

      // Gray/neutral ratio: chroma < 10 = near-gray
      const grayRes = await pool.query(`
        SELECT COUNT(*) as cnt FROM mosaic_images
        WHERE SQRT(avg_a * avg_a + avg_b * avg_b) < 10
      `);
      const grayCount = Number(grayRes.rows[0]?.cnt ?? 0);

      // 3D matrix gaps analysis
      const gapTasks = await analyzeDbGaps(200);
      const topGaps = gapTasks.slice(0, 20).map(t => ({ label: t.label, deficit: t.deficit, query: t.query }));
      return { total, labIndexed, bySource, byColor, byBrightness, bySubject, topGaps, count: total, target: TILE_TARGET,
        byWarmCool, byBrightness5, bySaturation, grayCount };
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

  // Admin: Import from source (Pexels/Unsplash/Pixabay)
  importFromSource: publicProcedure
    .input(z.object({ source: z.enum(["pexels", "unsplash", "pixabay"]), count: z.number().min(1).max(5000).default(500) }))
    .mutation(async ({ input }) => {
      const status = getImportStatus(input.source);
      if (status.running) return { started: false, message: "Import läuft bereits" };
      status.running = true; status.startedAt = new Date().toISOString(); status.log = []; status.imported = 0; status.total = input.count; status.error = null;
      const log = (msg: string) => { status.log.push(msg); if (status.log.length > 200) status.log = status.log.slice(-200); };
      (async () => {
        try {
          const apiKey = input.source === "pexels" ? process.env.PEXELS_API_KEY
            : input.source === "unsplash" ? process.env.UNSPLASH_ACCESS_KEY
            : process.env.PIXABAY_API_KEY;
          if (!apiKey) { status.error = `${input.source} API key missing`; return; }
          let imported = 0;
          // Use gap-based keyword ordering: fill most-needed color buckets first
          // Falls back to random shuffle from all keywords for variety
          const gapTasks = await analyzeDbGaps(200);
          const gapKeywords = gapTasks.map(t => t.query);
          const allKeywords = [...SUBJECT_KEYWORDS, ...Object.values(COLOR_BRIGHTNESS_KEYWORDS).flatMap(b => Object.values(b).flat())];
          const extraKeywords = allKeywords.filter(k => !gapKeywords.includes(k)).sort(() => Math.random() - 0.5);
          const orderedKeywords = [...gapKeywords, ...extraKeywords];
          const perPage = input.source === "pexels" ? 80 : input.source === "pixabay" ? 200 : 30;
          const CONCURRENCY = 5;
          let kwIdx = 0;
          while (imported < input.count && kwIdx < orderedKeywords.length) {
            const keyword = orderedKeywords[kwIdx++];
            // Random page offset (1-5) to avoid always getting the same first results
            const page = Math.floor(Math.random() * 5) + 1;
            try {
              let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
              if (input.source === "pexels") {
                const res = await fetch(
                  `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&orientation=square`,
                  { headers: { Authorization: apiKey } }
                );
                if (!res.ok) { log(`⚠️ Pexels ${res.status} for "${keyword}"`); continue; }
                const data = await res.json() as any;
                photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
              } else if (input.source === "pixabay") {
                const res = await fetch(
                  `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&image_type=photo&safesearch=true&orientation=horizontal`,
                  { headers: { 'Accept': 'application/json' } }
                );
                if (!res.ok) { log(`⚠️ Pixabay ${res.status} for "${keyword}"`); continue; }
                const data = await res.json() as any;
                photos = (data.hits ?? []).map((p: any) => ({
                  // Use stable previewURL (cdn.pixabay.com) as sourceUrl for deduplication
                  sourceUrl: p.previewURL ?? '',
                  tile128Url: p.previewURL ?? '',
                })).filter((p: any) => p.sourceUrl);
              } else {
                const res = await fetch(
                  `https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&orientation=squarish`,
                  { headers: { Authorization: `Client-ID ${apiKey}` } }
                );
                if (!res.ok) { log(`⚠️ Unsplash ${res.status} for "${keyword}"`); continue; }
                const data = await res.json() as any;
                photos = (data.results ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb }));
              }
              // Process in parallel for speed
              let batchNew = 0;
              for (let i = 0; i < photos.length; i += CONCURRENCY) {
                const batch = photos.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (photo) => {
                  try {
                    const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                    await db.insertMosaicImage({ ...photo,
                      avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                      tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                      trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                      blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                      brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                    });
                    imported++; batchNew++;
                    status.imported = imported;
                  } catch { /* duplicate or error – skip */ }
                }));
              }
              if (batchNew > 0) log(`"${keyword}" p${page}: +${batchNew} neu (${imported}/${input.count})`);
            } catch (e) { log(`"${keyword}" error: ${e}`); }
          }
          log(`✅ Import fertig: ${imported} neue Bilder`);
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
    .input(z.object({ source: z.enum(["pexels", "unsplash", "pixabay"]).default("pexels") }))
    .query(({ input }) => getImportStatus(input.source)),

  // Admin: Smart Import (DB-gap analysis → fills most needed color×brightness buckets first)
  smartImport: publicProcedure
    .input(z.object({
      sourceId: z.enum(["unsplash", "pexels", "pixabay"]).default("pexels"),
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
          const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY
            : input.sourceId === "pixabay" ? process.env.PIXABAY_API_KEY
            : process.env.UNSPLASH_ACCESS_KEY;
          if (!apiKey) { smartImportJobs[jobKey].error = "API key missing"; return; }

          // Analyse DB gaps: get prioritized list of (query, deficit, label)
          const tasks = await analyzeDbGaps(input.targetPerBucket);
          log(`🔍 DB-Analyse: ${tasks.length} Import-Tasks gefunden (Ziel: ${input.targetPerBucket} pro Bucket)`);
          log(`Top-Prioritäten: ${tasks.slice(0, 5).map(t => `${t.label}(${t.deficit})`).join(", ")}`);

          let imported = 0;
          const CONCURRENCY = 3; // parallel LAB computation
          const perPage = input.sourceId === "pexels" ? 30 : input.sourceId === "pixabay" ? 200 : 20;

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
              } else if (input.sourceId === "pixabay") {
                const res = await fetch(
                  `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(task.query)}&per_page=${perPage}&image_type=photo&safesearch=true&orientation=horizontal`,
                  { headers: { 'Accept': 'application/json' } }
                );
                if (!res.ok) { log(`⚠️ Pixabay API error ${res.status} for "${task.query}"`); continue; }
                const data = await res.json() as any;
                photos = (data.hits ?? []).map((p: any) => ({
                   // Use stable previewURL (cdn.pixabay.com) as sourceUrl for deduplication
                  // webformatURL uses rotating tokens and cannot be used for dedup
                  sourceUrl: p.previewURL ?? '',
                  tile128Url: p.previewURL ?? '',
                })).filter((p: any) => p.sourceUrl);
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
                    const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                    await db.insertMosaicImage({ ...photo,
                      avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                      tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                      trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                      blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                      brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                      subject: task.subject ?? 'general',
                    });
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
    .input(z.object({ sourceId: z.enum(["unsplash", "pexels", "pixabay"]).default("pexels") }))
    .query(({ input }) => {
      const jobKey = `smart_${input.sourceId}`;
      return smartImportJobs[jobKey] ?? { running: false, log: [], startedAt: null, finishedAt: null, error: null, imported: 0, total: 0 };
    }),

  // Admin: Get import recommendations from analyzeDbGaps
  // Returns the top-N tasks sorted by priority for display in the UI
  getImportRecommendations: publicProcedure
    .input(z.object({ limit: z.number().min(5).max(50).default(20) }))
    .query(async ({ input }) => {
      const tasks = await analyzeDbGaps(200);
      // Group by label and pick top tasks
      const seen = new Set<string>();
      const topTasks = tasks
        .filter(t => { const key = t.label; if (seen.has(key)) return false; seen.add(key); return true; })
        .slice(0, input.limit)
        .map(t => ({
          query: t.query,
          label: t.subject === 'portrait'
            ? (t.label.startsWith('low-sat') ? `🧑 Haut-Ton / Neutral` : t.label.startsWith('extreme') ? `🖤 Extrem-Helligkeit (Haare/Highlights)` : `🧑 Portrait: ${t.label}`)
            : t.label,
          priority: Math.round(t.priority * 100) / 100,
          deficit: t.deficit,
          subject: t.subject,
        }));
      return { tasks: topTasks, total: tasks.length };
    }),

  // Admin: Import All Sources simultaneously (Pexels + Unsplash in parallel)
  // This starts both importFromSource jobs at the same time for maximum throughput
  importAll: publicProcedure
    .input(z.object({ count: z.number().min(50).max(5000).default(500) }))
    .mutation(async ({ input }) => {
      const results: Record<string, boolean> = {};
      const sources: Array<'pexels' | 'unsplash' | 'pixabay'> = [];
      if (process.env.PEXELS_API_KEY) sources.push('pexels');
      if (process.env.UNSPLASH_ACCESS_KEY) sources.push('unsplash');
      if (process.env.PIXABAY_API_KEY) sources.push('pixabay');
      if (sources.length === 0) return { started: false, error: 'Keine API-Keys konfiguriert' };
      // Start each source as a separate background job
      for (const source of sources) {
        const status = getImportStatus(source);
        if (status.running) { results[source] = false; continue; }
        status.running = true;
        status.startedAt = new Date().toISOString();
        status.log = [];
        status.imported = 0;
        status.total = input.count;
        status.error = null;
        const log = (msg: string) => { status.log.push(msg); if (status.log.length > 200) status.log = status.log.slice(-200); };
        results[source] = true;
        // Fire-and-forget background job (same logic as importFromSource)
        (async (src: 'pexels' | 'unsplash' | 'pixabay') => {
          try {
            const apiKey = src === 'pexels' ? process.env.PEXELS_API_KEY!
              : src === 'pixabay' ? process.env.PIXABAY_API_KEY!
              : process.env.UNSPLASH_ACCESS_KEY!;
            let imported = 0;
            const allKeywords = [...SUBJECT_KEYWORDS, ...Object.values(COLOR_BRIGHTNESS_KEYWORDS).flatMap(b => Object.values(b).flat())];
            const shuffled = allKeywords.sort(() => Math.random() - 0.5);
            const perPage = src === 'pexels' ? 80 : src === 'pixabay' ? 200 : 30;
            const CONCURRENCY = 5;
            let kwIdx = 0;
            while (imported < input.count && kwIdx < shuffled.length) {
              const keyword = shuffled[kwIdx++];
              const page = Math.floor(Math.random() * 5) + 1;
              try {
                let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
                if (src === 'pexels') {
                  const res = await fetch(
                    `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&orientation=square`,
                    { headers: { Authorization: apiKey } }
                  );
                  if (!res.ok) continue;
                  const data = await res.json() as any;
                  photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
                } else if (src === 'pixabay') {
                  const res = await fetch(
                    `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&image_type=photo&safesearch=true&orientation=horizontal`,
                    { headers: { 'Accept': 'application/json' } }
                  );
                  if (!res.ok) continue;
                  const data = await res.json() as any;
                  photos = (data.hits ?? []).map((p: any) => ({
                    // Use stable previewURL (cdn.pixabay.com) as sourceUrl for deduplication
                    sourceUrl: p.previewURL ?? '',
                    tile128Url: p.previewURL ?? '',
                  })).filter((p: any) => p.sourceUrl);
                } else {
                  const res = await fetch(
                    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&orientation=squarish`,
                    { headers: { Authorization: `Client-ID ${apiKey}` } }
                  );
                  if (!res.ok) continue;
                  const data = await res.json() as any;
                  photos = (data.results ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb }));
                }
                let batchNew = 0;
                for (let i = 0; i < photos.length; i += CONCURRENCY) {
                  const batch = photos.slice(i, i + CONCURRENCY);
                  await Promise.all(batch.map(async (photo) => {
                    try {
                      const lab = await computeLabForUrl(photo.tile128Url ?? photo.sourceUrl);
                      await db.insertMosaicImage({ ...photo, avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0 });
                      imported++; batchNew++;
                      status.imported = imported;
                    } catch { /* duplicate – skip */ }
                  }));
                }
                if (batchNew > 0) log(`[${src}] "${keyword}" p${page}: +${batchNew} (${imported}/${input.count})`);
              } catch { /* skip keyword */ }
            }
            log(`✅ [${src}] Fertig: ${imported} neue Bilder`);
            status.finishedAt = new Date().toISOString();
          } catch (e: unknown) {
            status.error = e instanceof Error ? e.message : String(e);
          } finally {
            status.running = false;
          }
        })(source);
      }
      return { started: true, sources, results };
    }),

  // Admin: Rebuild tile index (LAB reindex) – now also computes quadrant LAB
  rebuildTileIndex: publicProcedure.mutation(async () => {
    if (rebuildJobStatus.running) return { started: false, message: "Rebuild läuft bereits" };
    rebuildJobStatus = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    const log = (msg: string) => { rebuildJobStatus.log.push(msg); if (rebuildJobStatus.log.length > 300) rebuildJobStatus.log = rebuildJobStatus.log.slice(-300); };
    (async () => {
      try {
        const pool = db.getPool();
        const res = await pool.query("SELECT id, tile128_url FROM mosaic_images WHERE tile128_url IS NOT NULL");
        log(`Indexiere ${res.rows.length} Bilder (global + Quadrant-LAB)...`);
        let indexed = 0;
        const CONCURRENCY = 6;
        for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
          const batch = res.rows.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (row: any) => {
            const lab = await computeLabFull(row.tile128_url);
            if (lab) {
              await pool.query(
                `UPDATE mosaic_images SET
                  avg_l=$1, avg_a=$2, avg_b=$3,
                  tl_l=$4, tl_a=$5, tl_b=$6,
                  tr_l=$7, tr_a=$8, tr_b=$9,
                  bl_l=$10, bl_a=$11, bl_b=$12,
                  br_l=$13, br_a=$14, br_b=$15
                WHERE id=$16`,
                [lab.L, lab.a, lab.b,
                 lab.tlL, lab.tlA, lab.tlB,
                 lab.trL, lab.trA, lab.trB,
                 lab.blL, lab.blA, lab.blB,
                 lab.brL, lab.brA, lab.brB,
                 row.id]
              );
              indexed++;
            }
          }));
          if (i % 200 === 0) log(`${indexed}/${res.rows.length} indexiert...`);
        }
        log(`✅ Fertig: ${indexed} Bilder reindexiert (inkl. Quadrant-LAB)`);
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

  // Admin: indexLabColors – alias for rebuildTileIndex (called by Admin panel "LAB indexieren" button)
  // Backfills quadrant LAB for ALL tiles (critical for 15D matching quality)
  indexLabColors: publicProcedure.mutation(async () => {
    if (rebuildJobStatus.running) return { started: false, indexed: 0, message: "Backfill läuft bereits" };
    rebuildJobStatus = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    const log = (msg: string) => { rebuildJobStatus.log.push(msg); if (rebuildJobStatus.log.length > 300) rebuildJobStatus.log = rebuildJobStatus.log.slice(-300); };
    let totalIndexed = 0;
    (async () => {
      try {
        const pool = db.getPool();
        // Backfill only tiles where quadrant values are still at default (tl_a=0 AND tl_b=0)
        // This avoids re-processing tiles that already have real quadrant data
        const res = await pool.query(
          `SELECT id, tile128_url FROM mosaic_images
           WHERE tile128_url IS NOT NULL
           AND (tl_a = 0 AND tl_b = 0 AND tr_a = 0 AND tr_b = 0)`
        );
        log(`Backfill Quadrant-LAB: ${res.rows.length} Tiles ohne Quadrant-Daten gefunden`);
        const CONCURRENCY = 8;
        for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
          const batch = res.rows.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (row: any) => {
            const lab = await computeLabFull(row.tile128_url);
            if (lab) {
              await pool.query(
                `UPDATE mosaic_images SET
                  avg_l=$1, avg_a=$2, avg_b=$3,
                  tl_l=$4, tl_a=$5, tl_b=$6,
                  tr_l=$7, tr_a=$8, tr_b=$9,
                  bl_l=$10, bl_a=$11, bl_b=$12,
                  br_l=$13, br_a=$14, br_b=$15
                WHERE id=$16`,
                [lab.L, lab.a, lab.b,
                 lab.tlL, lab.tlA, lab.tlB,
                 lab.trL, lab.trA, lab.trB,
                 lab.blL, lab.blA, lab.blB,
                 lab.brL, lab.brA, lab.brB,
                 row.id]
              );
              totalIndexed++;
            }
          }));
          if (i % 500 === 0) log(`${totalIndexed}/${res.rows.length} Quadrant-LAB berechnet...`);
        }
        log(`✅ Backfill fertig: ${totalIndexed} Tiles mit Quadrant-LAB aktualisiert`);
        rebuildJobStatus.finishedAt = new Date().toISOString();
      } catch (e: unknown) {
        rebuildJobStatus.error = e instanceof Error ? e.message : String(e);
        rebuildJobStatus.finishedAt = new Date().toISOString();
      } finally {
        rebuildJobStatus.running = false;
      }
    })();
    return { started: true, indexed: totalIndexed };
  }),

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
    .query(async ({ input }) => {
      console.log('[getAdminImages] input received:', JSON.stringify(input));
      const result = await db.getAdminImages(input);
      console.log('[getAdminImages] returning total:', result.total);
      return result;
    }),

  // Admin: Get ALL tiles for PDF export (no pagination limit)
  // Returns only id + sourceUrl + colorCategory + brightnessCategory + LAB for PDF rendering
  getAllTilesForPdf: publicProcedure
    .input(z.object({
      brightnessFilter: z.string().optional(),
      colorFilter: z.string().optional(),
      sourceId: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const pool = db.getPool();
      const conditions: string[] = [];
      if (input.sourceId === 'pexels') conditions.push("source_url LIKE '%pexels%'");
      else if (input.sourceId === 'unsplash') conditions.push("source_url LIKE '%unsplash%'");
      else if (input.sourceId === 'picsum') conditions.push("(source_url LIKE '%picsum%' OR source_url LIKE '%lorempixel%')");
      else if (input.sourceId === 'pixabay') conditions.push("source_url LIKE '%pixabay%'");
      if (input.brightnessFilter === "dunkel") conditions.push("avg_l < 35");
      else if (input.brightnessFilter === "mittel") conditions.push("avg_l >= 35 AND avg_l <= 65");
      else if (input.brightnessFilter === "hell") conditions.push("avg_l > 65");
      if (input.colorFilter === "schwarz") conditions.push("avg_l < 25");
      else if (input.colorFilter === "weiss") conditions.push("avg_l > 80");
      else if (input.colorFilter === "grau") conditions.push("ABS(avg_a) < 8 AND ABS(avg_b) < 8 AND avg_l >= 25 AND avg_l <= 80");
      else if (input.colorFilter === "rot") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 20");
      else if (input.colorFilter === "orange") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 10 AND avg_b > 10 AND avg_a <= 20");
      else if (input.colorFilter === "gelb") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_b > 20 AND avg_a <= 10");
      else if (input.colorFilter === "gruen") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a < -10 AND avg_b >= -5");
      else if (input.colorFilter === "blau") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_b < -15 AND avg_a >= -10");
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const res = await pool.query(
        `SELECT id, source_url as "sourceUrl", tile128_url as "tile128Url",
           avg_l::float as "avgL", avg_a::float as "avgA", avg_b::float as "avgB",
           CASE WHEN avg_l < 25 THEN 'schwarz' WHEN avg_l > 80 THEN 'weiss'
             WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 AND avg_l >= 25 AND avg_l <= 80 THEN 'grau'
             WHEN avg_a > 20 THEN 'rot' WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
             WHEN avg_b > 20 THEN 'gelb' WHEN avg_a < -10 THEN 'gruen'
             WHEN avg_b < -15 THEN 'blau' ELSE 'grau' END as "colorCategory",
           CASE WHEN avg_l < 35 THEN 'Dunkel' WHEN avg_l > 65 THEN 'Hell' ELSE 'Mittel' END as "brightnessCategory"
         FROM mosaic_images ${where} ORDER BY id`
      );
      return { images: res.rows, total: res.rows.length };
    }),

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

  // Targeted import: import images for a specific search query
  targetedImport: publicProcedure
    .input(z.object({
      sourceId: z.enum(["unsplash", "pexels", "pixabay"]).default("pexels"),
      query: z.string().min(1).max(200),
      count: z.number().min(10).max(500).default(100),
    }))
    .mutation(async ({ input }) => {
      const jobKey = `targeted_${input.sourceId}_${Date.now()}`;
      const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY
        : input.sourceId === "pixabay" ? process.env.PIXABAY_API_KEY
        : process.env.UNSPLASH_ACCESS_KEY;
      if (!apiKey) return { started: false, error: "API key missing" };
      // Run in background
      (async () => {
        try {
          const perPage = Math.min(input.count, input.sourceId === "pexels" ? 80 : input.sourceId === "pixabay" ? 200 : 30);
          let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
          if (input.sourceId === "pexels") {
            const res = await fetch(
              `https://api.pexels.com/v1/search?query=${encodeURIComponent(input.query)}&per_page=${perPage}&orientation=square`,
              { headers: { Authorization: apiKey } }
            );
            if (res.ok) {
              const data = await res.json() as any;
              photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
            }
          } else if (input.sourceId === "pixabay") {
            const res = await fetch(
              `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(input.query)}&per_page=${perPage}&image_type=photo&safesearch=true&orientation=horizontal`,
              { headers: { Accept: 'application/json' } }
            );
            if (res.ok) {
              const data = await res.json() as any;
              photos = (data.hits ?? []).map((p: any) => ({
                sourceUrl: p.previewURL ?? '',
                tile128Url: p.previewURL ?? '',
              })).filter((p: any) => p.sourceUrl);
            }
          } else {
            const res = await fetch(
              `https://api.unsplash.com/search/photos?query=${encodeURIComponent(input.query)}&per_page=${perPage}&orientation=squarish`,
              { headers: { Authorization: `Client-ID ${apiKey}` } }
            );
            if (res.ok) {
              const data = await res.json() as any;
              photos = (data.results ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb }));
            }
          }
          // Process photos (same pattern as smartImport)
          const CONCURRENCY = 3;
          for (let i = 0; i < photos.length; i += CONCURRENCY) {
            const batch = photos.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (photo) => {
              try {
                const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                await db.insertMosaicImage({ ...photo,
                  avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                  tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                  trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                  blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                  brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                });
              } catch { /* skip duplicates / errors */ }
            }));
          }
        } catch (e) {
          console.error('[targetedImport error]', e);
        }
      })();
      return { started: true, query: input.query };
    }),

  // Upload tile image
  uploadTileImage: publicProcedure
    .input(z.object({ base64: z.string(), mimeType: z.string().default("image/jpeg") }))
    .mutation(async ({ input }) => {
      const sharp = (await import("sharp")).default;
      const buf = Buffer.from(input.base64, "base64");
      const thumb = await sharp(buf).resize(128, 128, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
      const tile128Url = "data:image/jpeg;base64," + thumb.toString("base64");
      const lab = await computeLabFull(tile128Url).catch(() => null);
      await db.insertMosaicImage({ sourceUrl: tile128Url, tile128Url,
        avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
        tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
        trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
        blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
        brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
      });
      return { ok: true };
    }),
});

export type AppRouter = typeof appRouter;
