import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import * as db from "./db.js";
import { renderMosaicOnServer, type TileData } from "./mosaicExport.js";
import Stripe from "stripe";
import { cronState } from "./cron-state.js";

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
// Updated per smart-import guide: more abstract/non-nature vivid to avoid noisy portrait tiles
const HIGH_SAT_KEYWORDS = [
  // Vivid abstract (preferred – no natural noise for portraits)
  "vibrant abstract pattern -nature -flower", "high saturation color gradient smooth",
  "neon lights urban night -people", "colorful bokeh minimal -green",
  "saturated fabric texture closeup", "vivid paint splatter abstract",
  "colorful smoke abstract vivid", "rainbow gradient smooth",
  "neon abstract bright minimal", "vivid color explosion abstract",
  "saturated color texture smooth", "bright vivid bokeh abstract",
  // Vivid nature (accent tiles – ok for lips, bright areas)
  "vivid rainbow colors", "colorful tropical fish", "bright coral reef", "vivid butterfly",
  "colorful parrot", "vivid flowers macro", "bright tropical bird",
  // Vivid food & objects
  "colorful macarons", "vivid fruit market", "bright candy colors", "colorful vegetables",
  "bright neon lights", "colorful umbrellas", "vivid balloons",
  // Cool vivid
  "vivid blue turquoise", "bright teal ocean", "electric blue abstract", "vivid cyan water",
  "bright indigo purple", "vivid violet abstract", "electric green nature", "bright lime abstract",
];

// SKIN_TONE_KEYWORDS: skin-specific neutral/warm tiles for portrait quality
// Target: 25-30% of DB. These directly reduce ΔE in face regions.
const SKIN_TONE_KEYWORDS = [
  // Direct skin tones (from recommendation)
  "neutral beige skin tone texture smooth minimalist -vibrant -nature -flower",
  "flesh tone bokeh neutral minimal -people -face",
  "taupe off-white paper closeup plain background",
  "beige skin tone gradient smooth", "taupe fabric closeup minimal",
  "warm brown wood texture -dark", "neutral gray pattern low edge",
  "medium saturation abstract texture", "skin tone portrait abstract bokeh",
  "human skin texture neutral -face", "beige flesh tone smooth minimal",
  "warm neutral portrait background -vibrant",
  // Warm neutrals (cheeks, forehead, neck)
  "warm beige abstract smooth", "peach cream texture soft", "ivory white minimal",
  "warm sand texture closeup", "caramel brown smooth abstract", "rose gold texture minimal",
  "blush pink neutral background", "warm taupe gradient", "nude beige bokeh soft",
  // Cool neutrals (shadows, cool skin)
  "cool gray abstract smooth", "blue gray stone texture", "silver gray minimal",
  "cool beige background", "ash gray texture", "cool white abstract",
  // Additional low-sat warm tones
  "linen fabric texture neutral", "warm parchment paper texture",
  "skin tone gradient abstract minimal", "warm cream background soft",
  "light tan abstract smooth", "warm ivory bokeh background",
];

// ABSTRACT_LOW_EDGE_KEYWORDS: smooth low-texture abstract tiles
// Target: 25% of DB. Low edge energy = no noise in portrait regions.
const ABSTRACT_LOW_EDGE_KEYWORDS = [
  // From recommendation: explicitly low-contrast, low-sat
  "light gray abstract gradient low contrast -colorful",
  "abstract pattern low saturation smooth", "bokeh blur neutral tones",
  "gradient texture minimalist gray", "smooth color gradient abstract",
  "soft focus background blur", "minimalist abstract smooth",
  "out of focus bokeh warm", "defocused background neutral",
  "smooth pastel gradient", "blurred background abstract soft",
  "low contrast texture minimal", "soft light abstract background",
  "smooth gradient beige", "blurred bokeh neutral warm",
  "minimal texture smooth gray", "soft abstract gradient cool",
  // Additional smooth/minimal tiles
  "watercolor wash soft neutral", "smooth ink wash abstract",
  "minimal paper texture white", "soft diffused light abstract",
  "gentle gradient neutral tones", "smooth monochrome abstract",
  "soft cloud texture minimal", "hazy fog abstract neutral",
  "smooth silk texture neutral", "gentle blur abstract warm",
];

// PORTRAIT_NATURE_KEYWORDS: Natural gradient tiles ideal for portrait mosaics
// Sunset, desert, beach, autumn, golden hour, night, fog, fire – smooth gradients
// that map perfectly to skin tones, hair, shadows and highlights in portraits.
// These are ALWAYS useful for portraits regardless of current DB proportions.
const PORTRAIT_NATURE_KEYWORDS = [
  // Warm sunset / golden hour (skin tones, warm cheeks, forehead)
  "sunset golden hour sky", "orange sunset landscape", "warm sunset reflection water",
  "golden hour portrait glow", "sunset desert dunes", "warm evening sky orange",
  "sunrise orange pink sky", "sunset beach silhouette", "golden sunset clouds",
  // Desert / sand / earth (beige, tan, warm brown – perfect for skin)
  // Updated: add -plant -flower -vibrant to reduce noisy hits
  "sand dunes desert warm -plant", "sandy beach texture closeup", "warm desert landscape -vibrant",
  "red rock canyon desert", "dry earth cracked texture", "warm sandstone texture",
  "golden wheat field harvest -flower", "dry grass warm light", "warm soil texture",
  // Autumn / fall (orange, brown, red – skin tones and hair)
  "autumn leaves orange red", "fall foliage warm colors", "autumn forest golden",
  "red maple leaves closeup", "autumn bokeh warm", "fall harvest orange",
  // Night / dark sky (deep shadows, hair, pupils)
  // Updated: low-sat variants for dark areas without color noise
  "night sky stars dark", "dark blue night landscape", "milky way galaxy minimal abstract -starburst",
  "space nebula low saturation", "cosmic texture smooth black -vibrant",
  "night city lights bokeh", "deep blue night ocean",
  // Fog / mist (soft gray-white – pale skin, highlights)
  // Updated: neutral/smooth variants for clean highlights
  "morning fog misty landscape", "foggy forest soft light", "misty mountain soft",
  "haze soft light bokeh", "foggy morning field", "soft mist water reflection",
  "neutral sunset bokeh -vibrant", "warm horizon dusk plain -mountain",
  // Fire / warm light (intense orange-red for lips, warm shadows)
  "fire flames warm orange", "candle flame closeup", "warm fireplace glow",
  "burning embers orange", "warm campfire night", "glowing ember red",
  // Water / ocean (cool blue-gray for cool skin tones, backgrounds)
  "ocean wave closeup blue", "calm water reflection", "blue sea horizon",
  "turquoise water tropical", "grey ocean overcast", "deep blue water abstract",
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
export async function analyzeDbGapsForCron(targetPerBucket = 200): Promise<Array<{query: string; priority: number; deficit: number; label: string; subject: string}>>
{
  return analyzeDbGaps(targetPerBucket);
}

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

  // PORTRAIT_NATURE: Always import – these gradient tiles are universally useful for portraits.
  // Priority is moderate (1.2) but constant – they never become over-represented.
  // These are the tiles that make the difference between a "smooth" and "noisy" portrait mosaic.
  {
    const portraitNatureDeficit = Math.round(total * 0.15); // target ~15% of DB
    const portraitNatureCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'portrait_nature'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const portraitNaturePct = portraitNatureCnt / total;
    const portraitNaturePriority = Math.max(0, (0.15 - portraitNaturePct) / 0.15) * 2.0; // max 2.0
    if (portraitNaturePriority > 0.05) {
      for (const kw of PORTRAIT_NATURE_KEYWORDS) {
        tasks.push({ query: kw, priority: portraitNaturePriority, deficit: portraitNatureDeficit - portraitNatureCnt, label: `🌅 Portrait-Natur (Sunset/Wüste/Herbst)`, subject: 'portrait_nature' });
      }
    }
  }

  // ── Step 2b: Skin-Tone tiles (new category) ──
  // Target: 15% of DB. Skin-tone tiles directly reduce ΔE in face regions.
  {
    const skinCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'skin_tone'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const skinPct = skinCnt / total;
    const skinPriority = Math.max(0, (0.25 - skinPct) / 0.25) * 2.5; // max 2.5 – target 25% (was 15%)
    if (skinPriority > 0.05) {
      const deficit = Math.round((0.25 - skinPct) * total);
      for (const kw of SKIN_TONE_KEYWORDS) {
        tasks.push({ query: kw, priority: skinPriority, deficit, label: `🧖 Haut-Töne (${Math.round(skinPct*100)}% → Ziel 25%)`, subject: 'skin_tone' });
      }
    }
  }

  // ── Step 2c: Abstract Low-Edge tiles (new category) ──
  // Target: 20% of DB. Low edge energy = no noise in portrait regions.
  {
    const abstractCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'abstract_smooth'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const abstractPct = abstractCnt / total;
    const abstractPriority = Math.max(0, (0.25 - abstractPct) / 0.25) * 2.0; // max 2.0 – target 25% (was 20%)
    if (abstractPriority > 0.05) {
      const deficit = Math.round((0.25 - abstractPct) * total);
      for (const kw of ABSTRACT_LOW_EDGE_KEYWORDS) {
        tasks.push({ query: kw, priority: abstractPriority, deficit, label: `🌫️ Abstrakt-Glatt (${Math.round(abstractPct*100)}% → Ziel 25%)`, subject: 'abstract_smooth' });
      }
    }
  }

  // ── Step 2d: New theme gaps (animals, flowers, space) ──
  // Target: at least 1000 tiles per new theme (min 3.5% of DB)
  const NEW_THEME_TARGETS: Array<{subject: string; label: string; emoji: string; queries: string[]}> = [
    {
      subject: 'animals',
      label: '🐾 Tiere/Pets',
      emoji: '🐾',
      queries: [
        'cute dog portrait', 'cat closeup face', 'wild lion portrait', 'bird colorful feathers',
        'horse running field', 'fox wildlife', 'elephant wildlife', 'deer forest',
        'owl closeup', 'butterfly macro', 'tiger portrait', 'wolf wildlife',
        'puppy cute', 'kitten closeup', 'bear wildlife', 'eagle flying',
      ],
    },
    {
      subject: 'flowers',
      label: '🌸 Blumen/Flowers',
      emoji: '🌸',
      queries: [
        'rose closeup macro', 'sunflower bright', 'tulip field colorful', 'cherry blossom pink',
        'lavender purple field', 'daisy white flower', 'orchid exotic', 'poppy red field',
        'wildflowers meadow', 'flower bouquet colorful', 'lotus flower water', 'magnolia blossom',
        'peony pink flower', 'iris purple flower', 'cosmos flower pink', 'dahlia colorful',
      ],
    },
    {
      subject: 'space',
      label: '🌌 Space/Galaxy',
      emoji: '🌌',
      queries: [
        'milky way galaxy night', 'nebula colorful space', 'stars night sky dark', 'aurora borealis night',
        'galaxy deep space', 'moon closeup night', 'comet night sky', 'space abstract dark',
        'starry night sky', 'cosmic dust nebula', 'dark sky stars', 'purple blue nebula',
        'night sky long exposure', 'space galaxy colorful', 'astronomy night', 'dark cosmos abstract',
      ],
    },
  ];
  for (const themeTarget of NEW_THEME_TARGETS) {
    const themeCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = $1`, [themeTarget.subject]
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const targetCnt = Math.max(1000, Math.round(total * 0.04)); // min 1000 or 4% of DB
    const deficit = Math.max(0, targetCnt - themeCnt);
    if (deficit > 0) {
      const priority = Math.min(1.5, (deficit / targetCnt) * 1.5); // max 1.5
      for (const kw of themeTarget.queries) {
        tasks.push({ query: kw, priority, deficit, label: `${themeTarget.emoji} ${themeTarget.label} (${themeCnt} → Ziel ${targetCnt})`, subject: themeTarget.subject });
      }
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
// Uses Jimp (pure JS, no native binaries) instead of sharp for Railway compatibility
async function computeLabFull(url: string): Promise<{
  L: number; a: number; b: number;
  tlL: number; tlA: number; tlB: number;
  trL: number; trA: number; trB: number;
  blL: number; blA: number; blB: number;
  brL: number; brA: number; brB: number;
  tileType: 'calm' | 'medium' | 'busy';
} | null> {
  try {
    const { Jimp } = await import("jimp");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let image: any;
    if (url.startsWith("data:")) {
      const b64 = url.split(",")[1];
      const buf = Buffer.from(b64, "base64");
      image = await Jimp.fromBuffer(buf);
    } else {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      image = await Jimp.fromBuffer(buf);
    }
    // Resize to 8x8 for global + quadrant extraction
    image.resize({ w: 8, h: 8 });
    // Extract raw RGB pixels from 8x8 image
    const px = Buffer.allocUnsafe(8 * 8 * 3);
    let pi = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const rgba = image.getPixelColor(x, y);
        px[pi++] = (rgba >> 24) & 0xff; // R
        px[pi++] = (rgba >> 16) & 0xff; // G
        px[pi++] = (rgba >> 8)  & 0xff; // B
      }
    }
    // Global LAB (all 64 pixels)
    const global = rgbPixelsToLab(px, 64);
    // Extract quadrant pixels: 8x8 image, each quadrant is 4x4 = 16 pixels
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
    const tl = rgbPixelsToLab(extractQuadrant(0, 0), 16);
    const tr = rgbPixelsToLab(extractQuadrant(4, 0), 16);
    const bl = rgbPixelsToLab(extractQuadrant(0, 4), 16);
    const br = rgbPixelsToLab(extractQuadrant(4, 4), 16);
    // Compute tileType from quadrant LAB variance (texture complexity)
    const quadrantLs = [tl.L, tr.L, bl.L, br.L];
    const meanL = quadrantLs.reduce((s, v) => s + v, 0) / 4;
    const varianceL = quadrantLs.reduce((s, v) => s + (v - meanL) ** 2, 0) / 4;
    const quadrantAs = [tl.a, tr.a, bl.a, br.a];
    const quadrantBs = [tl.b, tr.b, bl.b, br.b];
    const meanA = quadrantAs.reduce((s, v) => s + v, 0) / 4;
    const meanB = quadrantBs.reduce((s, v) => s + v, 0) / 4;
    const varianceA = quadrantAs.reduce((s, v) => s + (v - meanA) ** 2, 0) / 4;
    const varianceB = quadrantBs.reduce((s, v) => s + (v - meanB) ** 2, 0) / 4;
    const totalVariance = varianceL + varianceA + varianceB;
    const tileType: 'calm' | 'medium' | 'busy' = totalVariance < 80 ? 'calm' : totalVariance > 400 ? 'busy' : 'medium';
    return {
      L: global.L, a: global.a, b: global.b,
      tlL: tl.L, tlA: tl.a, tlB: tl.b,
      trL: tr.L, trA: tr.a, trB: tr.b,
      blL: bl.L, blA: bl.a, blB: bl.b,
      brL: br.L, brA: br.a, brB: br.b,
      tileType,
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

// ── Post-Import Quality Check ──────────────────────────────────────────────
// Analyses a tile image and returns quality metrics:
//   saturation: 0-1 (LAB chroma / max chroma). High = very colorful.
//   edgeEnergy:  0-1 (normalised Sobel edge energy). High = lots of texture/noise.
//   hasBrightBand: true if a horizontal stripe of very bright pixels is detected
//                  (typical for Shutterstock watermarks).
//
// Thresholds (from smart-import guide):
//   saturation > 0.55 → discard (too vivid for portrait regions)
//   edgeEnergy  > 0.45 → discard (too noisy / textured)
//   hasBrightBand      → discard (watermark)
//
// Note: thresholds are intentionally lenient so we don't over-filter.
// High-sat tiles are still needed for vivid mosaics; we only reject extreme outliers.
type QualityResult = {
  saturation: number;
  edgeEnergy: number;
  hasBrightBand: boolean;
  rejected: boolean;
  reason: string;
};

async function checkTileQuality(url: string, subject?: string): Promise<QualityResult> {
  const defaultPass: QualityResult = { saturation: 0, edgeEnergy: 0, hasBrightBand: false, rejected: false, reason: '' };
  try {
    const { Jimp } = await import('jimp');
    let buf: Buffer;
    if (url.startsWith('data:')) {
      buf = Buffer.from(url.split(',')[1], 'base64');
    } else {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return defaultPass;
      buf = Buffer.from(await resp.arrayBuffer());
    }

    const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

    // ── 1. Saturation check (16×16 pixels, LAB chroma) ──
    const SIZE = 16;
    const img16 = await Jimp.fromBuffer(buf);
    img16.resize({ w: SIZE, h: SIZE });
    let chromaSum = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const rgba = img16.getPixelColor(x, y);
        const rl = toLinear((rgba >> 24) & 0xff);
        const gl = toLinear((rgba >> 16) & 0xff);
        const bl = toLinear((rgba >> 8) & 0xff);
        const X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
        const Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
        const Z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
        const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
        const labA = 500 * (f(X / 0.95047) - f(Y));
        const labB = 200 * (f(Y) - f(Z / 1.08883));
        chromaSum += Math.sqrt(labA * labA + labB * labB);
      }
    }
    const saturation = Math.min(1, (chromaSum / (SIZE * SIZE)) / 100);

    // ── 2. Edge energy check (Sobel on grayscale, 32×32 pixels) ──
    const ESIZE = 32;
    const imgE = await Jimp.fromBuffer(buf);
    imgE.resize({ w: ESIZE, h: ESIZE }).greyscale();
    const gray = new Uint8Array(ESIZE * ESIZE);
    for (let y = 0; y < ESIZE; y++) {
      for (let x = 0; x < ESIZE; x++) {
        gray[y * ESIZE + x] = (imgE.getPixelColor(x, y) >> 24) & 0xff;
      }
    }
    let edgeSum = 0;
    for (let y = 1; y < ESIZE - 1; y++) {
      for (let x = 1; x < ESIZE - 1; x++) {
        const idx = (r: number, c: number) => gray[r * ESIZE + c];
        const gx = -idx(y-1,x-1) + idx(y-1,x+1) - 2*idx(y,x-1) + 2*idx(y,x+1) - idx(y+1,x-1) + idx(y+1,x+1);
        const gy = -idx(y-1,x-1) - 2*idx(y-1,x) - idx(y-1,x+1) + idx(y+1,x-1) + 2*idx(y+1,x) + idx(y+1,x+1);
        edgeSum += Math.sqrt(gx * gx + gy * gy);
      }
    }
    const edgeEnergy = Math.min(1, edgeSum / ((ESIZE - 2) * (ESIZE - 2) * 400));

    // ── 3. Bright-band watermark detection (Shutterstock-style) ──
    const WSIZE = 64;
    const imgW = await Jimp.fromBuffer(buf);
    imgW.resize({ w: WSIZE, h: WSIZE }).greyscale();
    const bandStart = Math.floor(WSIZE * 0.80);
    let brightCount = 0, totalBandPx = 0;
    for (let y = bandStart; y < WSIZE; y++) {
      for (let x = 0; x < WSIZE; x++) {
        if (((imgW.getPixelColor(x, y) >> 24) & 0xff) > 230) brightCount++;
        totalBandPx++;
      }
    }
    const hasBrightBand = (brightCount / totalBandPx) > 0.55;

    // ── Decision ──
    // Portrait/face images have high edge energy by nature (facial features, hair)
    // Use relaxed thresholds for portrait subjects to avoid over-filtering
    const isPortraitSubject = subject === 'portrait' || subject === 'portrait_nature' ||
      subject === 'analysis' || subject === 'face';
    const satThreshold = isPortraitSubject ? 0.65 : 0.55;  // portraits can be more saturated
    const edgeThreshold = isPortraitSubject ? 0.75 : 0.45;  // portraits have high edge energy
    const reasons: string[] = [];
    if (saturation > satThreshold) reasons.push(`sat=${saturation.toFixed(2)}>${satThreshold}`);
    if (edgeEnergy  > edgeThreshold) reasons.push(`edge=${edgeEnergy.toFixed(2)}>${edgeThreshold}`);
    if (hasBrightBand)       reasons.push('watermark-band');
    const rejected = reasons.length > 0;

    return { saturation, edgeEnergy, hasBrightBand, rejected, reason: reasons.join(', ') };
  } catch {
    return defaultPass; // on error, don't reject
  }
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
      // By source (use source_provider column first, fall back to URL detection)
      const srcRes = await pool.query(`
        SELECT
          COALESCE(
            source_provider,
            CASE
              WHEN source_url LIKE '%picsum%' OR source_url LIKE '%lorempixel%' THEN 'picsum'
              WHEN source_url LIKE '%unsplash%' THEN 'unsplash'
              WHEN source_url LIKE '%pexels%' THEN 'pexels'
              WHEN source_url LIKE '%pixabay%' OR source_url LIKE '%cdn.pixabay%' THEN 'pixabay'
              ELSE 'other'
            END
          ) as src,
          COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY src
        ORDER BY cnt DESC
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
      return {
        enabled: current < TILE_TARGET,
        current,
        target: TILE_TARGET,
        remaining: Math.max(0, TILE_TARGET - current),
        intervalHours: 1,
        nextRunIn: CRON_INTERVAL_MS,
        cronRunning: cronState.running,
        lastCronRun: cronState.lastRun,
        lastCronResult: cronState.lastResult,
      };
    } catch {
      return { enabled: false, current: 0, target: TILE_TARGET, remaining: TILE_TARGET, intervalHours: 1, nextRunIn: CRON_INTERVAL_MS, cronRunning: false, lastCronRun: null, lastCronResult: null };
    }
  }),

  // Admin: Import from source (Pexels/Unsplash/Pixabay)
  importFromSource: publicProcedure
    .input(z.object({ source: z.enum(["pexels", "unsplash", "pixabay"]), count: z.number().min(1).max(5000).default(500), category: z.string().optional() }))
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
          // If category is specified, use its keywords preferentially
          let orderedKeywords: string[];
          if (input.category) {
            const pool = db.getPool();
            const catRow = await pool.query(`SELECT keywords FROM image_categories WHERE name = $1`, [input.category]);
            const catKeywords: string[] = catRow.rows[0]?.keywords ?? [];
            const allKeywords = [...SUBJECT_KEYWORDS, ...Object.values(COLOR_BRIGHTNESS_KEYWORDS).flatMap(b => Object.values(b).flat())];
            const extra = allKeywords.filter(k => !catKeywords.includes(k)).sort(() => Math.random() - 0.5);
            orderedKeywords = [...catKeywords, ...extra];
            log(`📂 Kategorie-Import: ${input.category} (${catKeywords.length} Kategorie-Keywords)`);
          } else {
            // Use gap-based keyword ordering: fill most-needed color buckets first
            const gapTasks = await analyzeDbGaps(200);
            const gapKeywords = gapTasks.map(t => t.query);
            const allKeywords = [...SUBJECT_KEYWORDS, ...Object.values(COLOR_BRIGHTNESS_KEYWORDS).flatMap(b => Object.values(b).flat())];
            const extra = allKeywords.filter(k => !gapKeywords.includes(k)).sort(() => Math.random() - 0.5);
            orderedKeywords = [...gapKeywords, ...extra];
          }
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
                  // previewURL (150px, stable CDN) used as dedup key via source_url
                  // webformatURL (640px) used as tile128Url for better LAB accuracy and rendering quality
                  // largeImageURL (1280px) used as sourceUrl for print-quality output
                  sourceUrl: p.largeImageURL || p.webformatURL || p.previewURL || '',
                  tile128Url: p.webformatURL || p.previewURL || '',
                })).filter((p: any) => p.tile128Url);
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
                    const inserted = await db.insertMosaicImage({ ...photo,
                      avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                      tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                      trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                      blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                      brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                      sourceProvider: input.source,
                      importQuery: keyword,
                      tileType: lab?.tileType,
                    });
                    if (inserted) { imported++; batchNew++; status.imported = imported; }
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
      // Optional: specific keywords from image analysis (bypasses DB gap analysis)
      keywords: z.array(z.string()).optional(),
      jobLabel: z.string().optional(), // custom label for the job (e.g. "Analyse-Import: Portrait")
    }))
    .mutation(async ({ input }) => {
      const jobKey = input.keywords?.length ? `smart_analysis_${input.sourceId}` : `smart_${input.sourceId}`;
      if (smartImportJobs[jobKey]?.running) return { started: false };
      smartImportJobs[jobKey] = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, imported: 0, total: input.count };
      const log = (msg: string) => { smartImportJobs[jobKey].log.push(msg); if (smartImportJobs[jobKey].log.length > 500) smartImportJobs[jobKey].log = smartImportJobs[jobKey].log.slice(-500); };
      (async () => {
        try {
          const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY
            : input.sourceId === "pixabay" ? process.env.PIXABAY_API_KEY
            : process.env.UNSPLASH_ACCESS_KEY;
          if (!apiKey) { smartImportJobs[jobKey].error = "API key missing"; return; }
          // Track if Unsplash is rate-limited → fall back to Pexels automatically
          let unsplashRateLimited = false;

          // If specific keywords provided (from image analysis), use them directly
          // Otherwise fall back to DB gap analysis
          let tasks: Array<{query: string; priority: number; deficit: number; label: string; subject: string}>;
          if (input.keywords && input.keywords.length > 0) {
            log(`🔬 Analyse-Import: ${input.keywords.length} Keywords aus Bildanalyse${input.jobLabel ? ` (${input.jobLabel})` : ''}`);
            tasks = input.keywords.map((kw, i) => ({ query: kw, priority: 10 - i, deficit: 500, label: `🔬 ${kw}`, subject: 'analysis' }));
          } else {
            // Analyse DB gaps: get prioritized list of (query, deficit, label)
            tasks = await analyzeDbGaps(input.targetPerBucket);
          }
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
                  // webformatURL (640px) for tile rendering quality; largeImageURL (1280px) for print
                  sourceUrl: p.largeImageURL || p.webformatURL || p.previewURL || '',
                  tile128Url: p.webformatURL || p.previewURL || '',
                })).filter((p: any) => p.tile128Url);
              } else {
                // Unsplash: if rate-limited, fall back to Pexels automatically
                if (unsplashRateLimited && process.env.PEXELS_API_KEY) {
                  log(`🔄 Unsplash rate-limited → Pexels fallback for "${task.query}"`);
                  const res = await fetch(
                    `https://api.pexels.com/v1/search?query=${encodeURIComponent(task.query)}&per_page=30&orientation=square`,
                    { headers: { Authorization: process.env.PEXELS_API_KEY } }
                  );
                  if (!res.ok) { log(`⚠️ Pexels fallback error ${res.status} for "${task.query}"`); continue; }
                  const data = await res.json() as any;
                  photos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
                } else {
                  const res = await fetch(
                    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(task.query)}&per_page=${perPage}&orientation=squarish`,
                    { headers: { Authorization: `Client-ID ${apiKey}` } }
                  );
                  if (!res.ok) {
                    log(`⚠️ Unsplash API error ${res.status} for "${task.query}"`);
                    if (res.status === 403 || res.status === 429) {
                      unsplashRateLimited = true;
                      log(`⚠️ Unsplash rate limit reached – switching to Pexels fallback for remaining keywords`);
                      // Retry this keyword with Pexels immediately
                      if (process.env.PEXELS_API_KEY) {
                        const r2 = await fetch(
                          `https://api.pexels.com/v1/search?query=${encodeURIComponent(task.query)}&per_page=30&orientation=square`,
                          { headers: { Authorization: process.env.PEXELS_API_KEY } }
                        );
                        if (r2.ok) {
                          const d2 = await r2.json() as any;
                          photos = (d2.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
                        }
                      }
                    } else { continue; }
                  } else {
                    const data = await res.json() as any;
                    photos = (data.results ?? []).map((p: any) => ({
                      sourceUrl: p.urls.regular,
                      tile128Url: p.urls.thumb,
                    }));
                  }
                }
              }

              // Process in parallel batches for speed
              let batchImported = 0;
              let batchRejected = 0;
              for (let i = 0; i < photos.length; i += CONCURRENCY) {
                const batch = photos.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (photo) => {
                  try {
                    // ── Post-Import Quality Check ──
                    const quality = await checkTileQuality(photo.tile128Url ?? photo.sourceUrl, task.subject);
                    if (quality.rejected) {
                      batchRejected++;
                      return; // discard – too vivid / noisy / watermarked
                    }
                    const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                    const inserted = await db.insertMosaicImage({ ...photo,
                      avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                      tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                      trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                      blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                      brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                      theme: task.subject ?? 'general',
                      subject: task.subject ?? 'general',
                      sourceProvider: input.sourceId,
                      importQuery: task.query,
                      tileType: lab?.tileType,
                    });
                    if (inserted) { imported++; batchImported++; smartImportJobs[jobKey].imported = imported; }
                  } catch { /* skip duplicates / errors */ }
                }));
              }
              if (batchImported > 0 || batchRejected > 0) {
                log(`✓ [${task.label}] "${task.query}": +${batchImported} importiert, ${batchRejected} abgelehnt (deficit: ${task.deficit})`);
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
    .input(z.object({ sourceId: z.enum(["unsplash", "pexels", "pixabay"]).default("pexels"), isAnalysis: z.boolean().optional() }))
    .query(({ input }) => {
      const jobKey = input.isAnalysis ? `smart_analysis_${input.sourceId}` : `smart_${input.sourceId}`;
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
                    // webformatURL (640px) for tile rendering quality; largeImageURL (1280px) for print
                    sourceUrl: p.largeImageURL || p.webformatURL || p.previewURL || '',
                    tile128Url: p.webformatURL || p.previewURL || '',
                  })).filter((p: any) => p.tile128Url);
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
                      const inserted = await db.insertMosaicImage({ ...photo,
                        avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                        sourceProvider: src,
                        importQuery: keyword,
                      });
                      if (inserted) { imported++; batchNew++; status.imported = imported; }
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
      if (input.sourceId && input.sourceId !== 'alle') {
        // Prefer source_provider column (canonical), fall back to URL pattern for legacy rows
        const sid = input.sourceId;
        if (sid === 'pexels') conditions.push("(source_provider = 'pexels' OR (source_provider IS NULL AND source_url LIKE '%pexels%'))");
        else if (sid === 'unsplash') conditions.push("(source_provider = 'unsplash' OR (source_provider IS NULL AND source_url LIKE '%unsplash%'))");
        else if (sid === 'picsum') conditions.push("(source_provider = 'picsum' OR (source_provider IS NULL AND (source_url LIKE '%picsum%' OR source_url LIKE '%lorempixel%')))");
        else if (sid === 'pixabay') conditions.push("(source_provider = 'pixabay' OR (source_provider IS NULL AND (source_url LIKE '%pixabay%' OR source_url LIKE '%cdn.pixabay%')))");
        else conditions.push(`source_provider = '${sid}'`);
      }
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

  // Admin: Alle Tiles einer Quelle löschen
  deleteBySource: publicProcedure
    .input(z.object({ source: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const pool = db.getPool();
      const res = await pool.query(
        `DELETE FROM mosaic_images WHERE source_provider = $1`,
        [input.source]
      );
      return { deleted: res.rowCount ?? 0 };
    }),

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
                // webformatURL (640px) for tile rendering quality; largeImageURL (1280px) for print
                sourceUrl: p.largeImageURL || p.webformatURL || p.previewURL || '',
                tile128Url: p.webformatURL || p.previewURL || '',
              })).filter((p: any) => p.tile128Url);
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
                  tileType: lab?.tileType,
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
      const { Jimp } = await import("jimp");
      const buf = Buffer.from(input.base64, "base64");
      const img = await Jimp.fromBuffer(buf);
      img.resize({ w: 128, h: 128 });
      const thumb = await img.getBuffer("image/jpeg", { quality: 85 });
      const tile128Url = "data:image/jpeg;base64," + thumb.toString("base64");
      const lab = await computeLabFull(tile128Url).catch(() => null);
      await db.insertMosaicImage({ sourceUrl: tile128Url, tile128Url,
        avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
        tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
        trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
        blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
        brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
        sourceProvider: 'upload',
        tileType: lab?.tileType,
      });
      return { ok: true };
    }),

  // ── QA: Run quality check ──────────────────────────────────────────────────
  runQualityCheck: publicProcedure
    .input(z.object({
      checkType: z.enum(['index-integrity', 'import-health', 'pool-balance', 'duplicate-check', 'tile-quality-score', 'all']),
    }))
    .mutation(async ({ input }) => {
      const checksToRun = input.checkType === 'all'
        ? ['index-integrity', 'import-health', 'pool-balance', 'duplicate-check', 'tile-quality-score']
        : [input.checkType];
      const runIds: Record<string, number> = {};
      for (const checkType of checksToRun) {
        const runId = await db.startQualityRun(checkType);
        runIds[checkType] = runId;
        // Run async (don't await – returns immediately)
        runQualityCheckAsync(checkType, runId).catch(e => {
          console.error(`[QA] ${checkType} failed:`, e);
          db.finishQualityRun(runId, 'error', { error: String(e) }).catch(() => {});
        });
      }
      return { started: true, runIds };
    }),

  // ── QA: Get quality check runs ─────────────────────────────────────────────
  getQualityRuns: publicProcedure
    .input(z.object({ checkType: z.string().optional(), limit: z.number().default(20) }))
    .query(async ({ input }) => {
      return db.getQualityRuns({ checkType: input.checkType, limit: input.limit });
    }),

  // ── QA: Get quality check run items ───────────────────────────────────────
  getQualityRunItems: publicProcedure
    .input(z.object({ runId: z.number() }))
    .query(async ({ input }) => {
      return db.getQualityRunItems(input.runId);
    }),

  // ── Algorithm Profiles ────────────────────────────────────────────────────
  getAlgorithmProfiles: publicProcedure
    .query(async () => db.getAlgorithmProfiles()),

  saveAlgorithmProfile: publicProcedure
    .input(z.object({
      name: z.string(),
      settings: z.record(z.any()),
      isDefault: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const id = await db.saveAlgorithmProfile(input.name, input.settings, input.isDefault);
      return { id };
    }),

  getDefaultAlgorithmProfile: publicProcedure
    .query(async () => db.getDefaultAlgorithmProfile()),

  // ── Admin: Get images with importedSince filter ───────────────────────────
  getAdminImagesFiltered: publicProcedure
    .input(z.object({
      page: z.number().default(1),
      limit: z.number().default(50),
      brightnessFilter: z.string().optional(),
      colorFilter: z.string().optional(),
      sourceId: z.string().optional(),
      importedSince: z.string().optional(),
      qualityStatus: z.string().optional(),
      semanticTheme: z.string().optional(),
    }))
    .query(async ({ input }) => {
      return db.getAdminImages({
        page: input.page,
        limit: input.limit,
        brightnessFilter: input.brightnessFilter,
        colorFilter: input.colorFilter,
        sourceId: input.sourceId,
        importedSince: input.importedSince,
        qualityStatus: input.qualityStatus,
        semanticTheme: input.semanticTheme,
      });
    }),

  // ── Image Categories ────────────────────────────────────────────────────────────
  getImageCategories: publicProcedure
    .query(async () => {
      return await db.getImageCategories();
    }),

  saveImageCategoryAlgoSettings: publicProcedure
    .input(z.object({
      categoryName: z.string(),
      algoSettings: z.record(z.unknown()),
    }))
    .mutation(async ({ input }) => {
      await db.saveImageCategoryAlgoSettings(input.categoryName, input.algoSettings);
      return { ok: true };
    }),

  upsertImageCategory: publicProcedure
    .input(z.object({
      name: z.string(),
      label: z.string(),
      description: z.string().optional(),
      parentCategory: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      algoSettings: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      await db.upsertImageCategory(input);
      return { ok: true };
    }),

  // ── Analyse Testbild gegen Pool ─────────────────────────────────────────────────────
  analyzeTestImage: publicProcedure
    .input(z.object({
      imageUrl: z.string().optional(), // kept for display only
      // LAB zones pre-computed by client-side Canvas (avoids server-side image processing)
      labZones: z.array(z.object({
        L: z.number(), a: z.number(), b: z.number(), count: z.number()
      })).optional(),
      imageError: z.string().optional(),
      category: z.string().optional(), // detected category (portrait, landscape, etc.) for context-aware keywords
    }))
    .mutation(async ({ input }) => {
      const imageLABZones: Array<{L: number; a: number; b: number; count: number}> = input.labZones ?? [];
      const imageError = input.imageError ?? (imageLABZones.length === 0 ? 'Keine LAB-Zonen vom Client empfangen' : '');

      // Get pool LAB distribution
      const poolStats = await db.getPoolLABStats();

      // Category-aware keyword lookup tables
      const category = input.category ?? 'general';
      const isPortrait = category === 'portrait' || category === 'people' || category === 'face';
      const isLandscape = category === 'landscape' || category === 'nature' || category === 'outdoor';
      const isNightScene = category === 'night' || category === 'dark';

      // Keyword tables: [generic, portrait-specific, landscape-specific]
      // Each entry: { condition, keyword, reason }
      // IMPORTANT: Portrait keywords are optimized for Unsplash API (short, high-result queries)
      // Tested: keywords with >100 results on Unsplash are marked as reliable
      type KwEntry = { keyword: string; reason: string };
      const kwTable: { test: (z: {L: number; a: number; b: number; brightness: string; warmth: string; saturation: string}) => boolean; generic: KwEntry; portrait: KwEntry; landscape: KwEntry }[] = [
        // Bright neutral (white/light backgrounds)
        {
          test: z => z.L > 70 && Math.abs(z.a) < 5 && Math.abs(z.b) < 5,
          generic:   { keyword: 'white paper texture minimal',           reason: 'helle neutrale Zone fehlt' },
          portrait:  { keyword: 'light background portrait',             reason: 'heller neutraler Hintergrund fehlt (Portrait)' }, // 522 results
          landscape: { keyword: 'bright overcast sky clouds white',      reason: 'heller Himmel fehlt' },
        },
        // Bright cool
        {
          test: z => z.L > 70 && z.b < -3,
          generic:   { keyword: 'overcast sky muted cool',               reason: 'helle kühle Zone fehlt' },
          portrait:  { keyword: 'portrait blue background light',        reason: 'kühler Hintergrund fehlt (Portrait)' }, // ~80 results
          landscape: { keyword: 'blue sky clouds bright',                reason: 'blauer Himmel fehlt' },
        },
        // Bright warm
        {
          test: z => z.L > 70 && z.b > 8,
          generic:   { keyword: 'warm light golden bright',              reason: 'helle warme Zone fehlt' },
          portrait:  { keyword: 'portrait face warm',                    reason: 'warmes Licht auf Haut fehlt' }, // 2917 results
          landscape: { keyword: 'golden hour sunlight warm bright',      reason: 'Goldstunde-Licht fehlt' },
        },
        // Skin tones (mid bright warm reddish)
        {
          test: z => z.a > 6 && z.L > 45 && z.L < 80,
          generic:   { keyword: 'skin tone portrait warm light',         reason: 'Hautton-Zone fehlt' },
          portrait:  { keyword: 'portrait face',                         reason: 'Hauttöne für Gesicht fehlen' }, // 286 results
          landscape: { keyword: 'warm earth sand desert texture',        reason: 'warme Erdtöne fehlen' },
        },
        // Dark cool
        {
          test: z => z.L < 35 && z.b < 0,
          generic:   { keyword: 'dark ocean water night',                reason: 'dunkle kühle Zone fehlt' },
          portrait:  { keyword: 'moody portrait dark',                   reason: 'dunkle Schatten fehlen (Portrait)' }, // 131 results
          landscape: { keyword: 'dark water night reflection',           reason: 'dunkles Wasser fehlt' },
        },
        // Dark warm
        {
          test: z => z.L < 35 && z.b > 5,
          generic:   { keyword: 'dark wood texture warm',                reason: 'dunkle warme Zone fehlt' },
          portrait:  { keyword: 'dark hair portrait',                    reason: 'dunkle Haare/Schatten fehlen' }, // 96 results
          landscape: { keyword: 'dark forest shadow warm',               reason: 'dunkler Wald fehlt' },
        },
        // Mid cool
        {
          test: z => z.b < -5 && z.L >= 35 && z.L <= 70,
          generic:   { keyword: 'blue gray fog misty',                   reason: 'mittlere kühle Zone fehlt' },
          portrait:  { keyword: 'gray sweater portrait',                 reason: 'neutrale Kleidung/Hintergrund fehlt' }, // 142 results
          landscape: { keyword: 'misty fog blue mountain',               reason: 'Nebel/Dunst fehlt' },
        },
        // Mid warm saturated
        {
          test: z => z.b > 10 && z.a > 5,
          generic:   { keyword: 'autumn leaves warm golden',             reason: 'warme Sättigungs-Zone fehlt' },
          portrait:  { keyword: 'portrait warm light face',              reason: 'warme Kleidungsfarben fehlen' }, // ~100 results
          landscape: { keyword: 'autumn foliage warm orange',            reason: 'Herbstfarben fehlen' },
        },
        // Mid neutral muted
        {
          test: z => z.saturation === 'muted' && z.brightness === 'mid',
          generic:   { keyword: 'neutral gray texture stone',            reason: 'mittlere neutrale Zone fehlt' },
          portrait:  { keyword: 'portrait face close',                   reason: 'neutraler Hintergrund fehlt (Portrait)' }, // 47 results
          landscape: { keyword: 'stone rock texture gray neutral',       reason: 'Stein/Fels fehlt' },
        },
        // Dark neutral
        {
          test: z => z.brightness === 'dark' && z.saturation === 'muted' && Math.abs(z.b) < 5,
          generic:   { keyword: 'dark neutral texture shadow',           reason: 'dunkle neutrale Zone fehlt' },
          portrait:  { keyword: 'dark portrait dramatic',                reason: 'dunkle Kleidung fehlt (Portrait)' }, // 83 results
          landscape: { keyword: 'dark shadow rock neutral',              reason: 'dunkle Schatten fehlen' },
        },
      ];

      // Find gaps: image zones with insufficient pool coverage
      const gapZones: Array<{zone: string; needed: number; available: number; deficit: number}> = [];
      const keywordSuggestions: Array<{keyword: string; reason: string; priority: string}> = [];

      // Portrait: use tighter LAB threshold (18 vs 12) to detect finer face-area gaps
      const labGapThreshold = isPortrait ? 18 : 12;

      if (imageLABZones.length > 0) {
        for (const zone of imageLABZones.slice(0, 15)) {
          // Find pool tiles within LAB distance of this zone
          const nearby = poolStats.filter((p: {avgL: number; avgA: number; avgB: number}) => {
            const dL = p.avgL - zone.L, dA = p.avgA - zone.a, dB = p.avgB - zone.b;
            return Math.sqrt(dL*dL + dA*dA + dB*dB) < labGapThreshold;
          });
          const needed = Math.max(50, zone.count * 10);
          const available = nearby.reduce((s: number, p: {count: number}) => s + p.count, 0);
          if (available < needed) {
            const deficit = needed - available;
            // Describe the zone
            const warmth = zone.b > 8 ? 'warm' : zone.b < -5 ? 'cool' : 'neutral';
            const brightness = zone.L > 70 ? 'bright' : zone.L < 35 ? 'dark' : 'mid';
            const saturation = Math.sqrt(zone.a*zone.a + zone.b*zone.b) > 20 ? 'saturated' : 'muted';
            const desc = `${brightness} ${warmth} ${saturation} (L=${zone.L} a=${zone.a} b=${zone.b})`;
            gapZones.push({ zone: desc, needed, available, deficit });

            // Generate category-aware keyword suggestions
            const priority = deficit > 200 ? 'high' : deficit > 80 ? 'medium' : 'low';
            const zCtx = { ...zone, brightness, warmth, saturation };
            let matched = false;
            for (const entry of kwTable) {
              if (entry.test(zCtx)) {
                const kw = isPortrait ? entry.portrait : isLandscape ? entry.landscape : entry.generic;
                keywordSuggestions.push({ keyword: kw.keyword, reason: kw.reason, priority });
                matched = true;
                break;
              }
            }
            if (!matched) {
              // Fallback: generic description but with category context
              const fallback = isPortrait
                ? `${brightness} ${warmth} portrait ${saturation === 'muted' ? 'soft' : 'vivid'}`
                : `${brightness} ${warmth} ${saturation} texture`;
              keywordSuggestions.push({ keyword: fallback, reason: `Lücke bei L=${zone.L}`, priority });
            }
          }
        }
      }

      // Portrait: always ensure 6 face-area keywords covering all key zones
      // Keywords optimized for Unsplash API (tested, each has >80 results)
      if (isPortrait) {
        const PORTRAIT_FACE_KEYWORDS = [
          { keyword: 'portrait face warm',                         reason: 'Haut-Midtones (Wangen, Stirn)' },     // 2917 results
          { keyword: 'portrait face',                             reason: 'Haut-Highlights (Stirn, Nase)' },     // 286 results
          { keyword: 'moody portrait dark',                       reason: 'Augen-/Schattenbereich' },            // 131 results
          { keyword: 'dark hair portrait',                        reason: 'Haare / dunkle Partien' },            // 96 results
          { keyword: 'light background portrait',                 reason: 'Heller Hintergrund / Schulterbereich' }, // 522 results
          { keyword: 'gray sweater portrait',                     reason: 'Neutrale Kleidung / Hintergrund' },   // 142 results
        ];
        const seenFaceKw = new Set(keywordSuggestions.map(k => k.keyword));
        for (const fkw of PORTRAIT_FACE_KEYWORDS) {
          if (!seenFaceKw.has(fkw.keyword)) {
            keywordSuggestions.push({ keyword: fkw.keyword, reason: fkw.reason, priority: 'medium' });
            seenFaceKw.add(fkw.keyword);
          }
          if (keywordSuggestions.length >= 6) break;
        }
      }

      // Deduplicate keyword suggestions
      const seenKw = new Set<string>();
      const uniqueKeywords = keywordSuggestions.filter(k => {
        if (seenKw.has(k.keyword)) return false;
        seenKw.add(k.keyword); return true;
      });

      return {
        imageUrl: input.imageUrl ?? '(uploaded file)',
        imageError: imageError,
        dominantZones: imageLABZones.slice(0, 10),
        gapZones: gapZones.slice(0, 10),
        keywordSuggestions: uniqueKeywords.slice(0, isPortrait ? 6 : 12),
        poolSize: poolStats.reduce((s: number, p: {count: number}) => s + p.count, 0),
      };
    }),

  // ── Auto-Learn: Start cycle ────────────────────────────────────────────────
  startAutoLearnCycle: publicProcedure
    .input(z.object({
      importCount: z.number().min(50).max(2000).default(300),
      targetPerBucket: z.number().min(50).max(1000).default(200),
    }))
    .mutation(async ({ input }) => {
      const runId = await db.startAutoLearnRun('manual');
      const steps: Array<{step: string; status: string; message: string; ts: string}> = [];
      const addStep = async (step: string, status: string, message: string) => {
        steps.push({ step, status, message, ts: new Date().toISOString() });
        await db.updateAutoLearnRun(runId, steps);
      };
      (async () => {
        try {
          await addStep('start', 'running', 'Auto-Learn-Zyklus gestartet');
          // Step 1: QA pre-check
          await addStep('qa-pre', 'running', 'QA-Vorab-Check (index-integrity + pool-balance)...');
          const qaRunId1 = await db.startQualityRun('index-integrity', 'auto-learn');
          const qaRunId2 = await db.startQualityRun('pool-balance', 'auto-learn');
          await runQualityCheckAsync('index-integrity', qaRunId1);
          await runQualityCheckAsync('pool-balance', qaRunId2);
          await addStep('qa-pre', 'done', 'QA-Vorab-Check abgeschlossen');
          // Step 2: Analyse gaps
          await addStep('gap-analysis', 'running', 'DB-Luecken analysieren...');
          const alTasks = await analyzeDbGaps(input.targetPerBucket);
          await addStep('gap-analysis', 'done', `${alTasks.length} Import-Tasks identifiziert`);
          // Step 3: Smart Import
          const alSources: Array<'pexels' | 'pixabay' | 'unsplash'> = [];
          if (process.env.PEXELS_API_KEY) alSources.push('pexels');
          if (process.env.PIXABAY_API_KEY) alSources.push('pixabay');
          if (process.env.UNSPLASH_ACCESS_KEY) alSources.push('unsplash');
          if (alSources.length === 0) {
            await addStep('import', 'skipped', 'Kein API-Key konfiguriert - Import uebersprungen');
          } else {
            await addStep('import', 'running', `Smart Import via ${alSources.join(', ')} (${input.importCount} Bilder)...`);
            let totalImported = 0;
            for (const alSource of alSources) {
              const jobKey = `smart_${alSource}`;
              if (smartImportJobs[jobKey]?.running) continue;
              smartImportJobs[jobKey] = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, imported: 0, total: input.importCount };
              const slog = (msg: string) => { smartImportJobs[jobKey].log.push(msg); if (smartImportJobs[jobKey].log.length > 500) smartImportJobs[jobKey].log = smartImportJobs[jobKey].log.slice(-500); };
              try {
                const alApiKey = alSource === 'pexels' ? process.env.PEXELS_API_KEY!
                  : alSource === 'pixabay' ? process.env.PIXABAY_API_KEY!
                  : process.env.UNSPLASH_ACCESS_KEY!;
                let alImported = 0;
                const alImportTasks = await analyzeDbGaps(input.targetPerBucket);
                const AL_CONCURRENCY = 3;
                const alPerPage = alSource === 'pexels' ? 80 : alSource === 'pixabay' ? 200 : 30;
                for (const task of alImportTasks) {
                  if (alImported >= input.importCount) break;
                  try {
                    let alPhotos: Array<{ sourceUrl: string; tile128Url: string }> = [];
                    if (alSource === 'pexels') {
                      const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(task.query)}&per_page=${alPerPage}&orientation=square`, { headers: { Authorization: alApiKey } });
                      if (res.ok) { const data = await res.json() as any; alPhotos = (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small })); }
                    } else if (alSource === 'pixabay') {
                      const res = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(alApiKey)}&q=${encodeURIComponent(task.query)}&per_page=${alPerPage}&image_type=photo&safesearch=true&orientation=horizontal`, { headers: { 'Accept': 'application/json' } });
                      if (res.ok) { const data = await res.json() as any; alPhotos = (data.hits ?? []).map((p: any) => ({ sourceUrl: p.largeImageURL || p.webformatURL || '', tile128Url: p.webformatURL || p.previewURL || '' })).filter((p: any) => p.tile128Url); }
                    } else {
                      const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(task.query)}&per_page=${alPerPage}&orientation=squarish`, { headers: { Authorization: `Client-ID ${alApiKey}` } });
                      if (res.ok) { const data = await res.json() as any; alPhotos = (data.results ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb })); }
                    }
                    let alBatchImported = 0;
                    for (let i = 0; i < alPhotos.length; i += AL_CONCURRENCY) {
                      const batch = alPhotos.slice(i, i + AL_CONCURRENCY);
                      await Promise.all(batch.map(async (photo) => {
                        try {
                          const quality = await checkTileQuality(photo.tile128Url ?? photo.sourceUrl, task.subject);
                          if (quality.rejected) return;
                          const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                          const ins = await db.insertMosaicImage({ ...photo,
                            avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                            tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                            trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                            blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                            brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                            theme: task.subject ?? 'general',
                            subject: task.subject ?? 'general',
                            sourceProvider: alSource,
                            importQuery: task.query,
                            tileType: lab?.tileType,
                          });
                          if (ins) { alImported++; alBatchImported++; smartImportJobs[jobKey].imported = alImported; totalImported++; }
                        } catch { /* skip */ }
                      }));
                    }
                    if (alBatchImported > 0) slog(`[${task.label}] +${alBatchImported}`);
                  } catch { /* skip task */ }
                }
                slog(`[${alSource}] ${alImported} Bilder importiert`);
                smartImportJobs[jobKey].finishedAt = new Date().toISOString();
              } catch (e: unknown) {
                smartImportJobs[jobKey].error = e instanceof Error ? e.message : String(e);
              } finally {
                smartImportJobs[jobKey].running = false;
              }
            }
            await addStep('import', 'done', `Import abgeschlossen: ${totalImported} neue Bilder`);
          }
          // Step 4: Rebuild tile index (only unindexed tiles)
          await addStep('reindex', 'running', 'Tile-Index neu aufbauen (LAB-Reindex)...');
          if (!rebuildJobStatus.running) {
            rebuildJobStatus = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
            const alPool = db.getPool();
            const reindexRes = await alPool.query("SELECT id, tile128_url FROM mosaic_images WHERE tile128_url IS NOT NULL AND (indexed_at IS NULL OR indexed_at < NOW() - INTERVAL '7 days') LIMIT 2000");
            let alIndexed = 0;
            const AL_CONCURRENCY2 = 6;
            for (let i = 0; i < reindexRes.rows.length; i += AL_CONCURRENCY2) {
              const batch = reindexRes.rows.slice(i, i + AL_CONCURRENCY2);
              await Promise.all(batch.map(async (row: any) => {
                const lab = await computeLabFull(row.tile128_url);
                if (lab) {
                  await alPool.query(
                    'UPDATE mosaic_images SET avg_l=$1,avg_a=$2,avg_b=$3,tl_l=$4,tl_a=$5,tl_b=$6,tr_l=$7,tr_a=$8,tr_b=$9,bl_l=$10,bl_a=$11,bl_b=$12,br_l=$13,br_a=$14,br_b=$15,tile_type=$16,indexed_at=NOW() WHERE id=$17',
                    [lab.L,lab.a,lab.b,lab.tlL,lab.tlA,lab.tlB,lab.trL,lab.trA,lab.trB,lab.blL,lab.blA,lab.blB,lab.brL,lab.brA,lab.brB,lab.tileType,row.id]
                  );
                  alIndexed++;
                }
              }));
            }
            rebuildJobStatus.running = false;
            rebuildJobStatus.finishedAt = new Date().toISOString();
            await addStep('reindex', 'done', `${alIndexed} Tiles neu indexiert`);
          } else {
            await addStep('reindex', 'skipped', 'Reindex laeuft bereits - uebersprungen');
          }
          // Step 5: QA post-check
          await addStep('qa-post', 'running', 'QA-Nachcheck (pool-balance)...');
          const qaRunId3 = await db.startQualityRun('pool-balance', 'auto-learn');
          await runQualityCheckAsync('pool-balance', qaRunId3);
          await addStep('qa-post', 'done', 'QA-Nachcheck abgeschlossen');
          await addStep('done', 'done', 'Auto-Learn-Zyklus erfolgreich abgeschlossen');
          await db.finishAutoLearnRun(runId, 'success', { steps: steps.length });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          steps.push({ step: 'error', status: 'error', message: msg, ts: new Date().toISOString() });
          await db.updateAutoLearnRun(runId, steps).catch(() => {});
          await db.finishAutoLearnRun(runId, 'error', { error: msg }).catch(() => {});
        }
      })();
      return { started: true, runId };
    }),

  // ── Auto-Learn: Get run status ─────────────────────────────────────────────
  getAutoLearnRun: publicProcedure
    .input(z.object({ runId: z.number() }))
    .query(async ({ input }) => db.getAutoLearnRun(input.runId)),

  // ── Auto-Learn: Get recent runs ────────────────────────────────────────────
  getAutoLearnRuns: publicProcedure
    .input(z.object({ limit: z.number().default(10) }))
    .query(async ({ input }) => db.getAutoLearnRuns(input.limit)),

  // ── Semantic Tagger ──────────────────────────────────────────────────────
  // Batch-tag all tiles with semantic_theme derived from LAB features
  runSemanticTagger: publicProcedure
    .input(z.object({ forceRetag: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const result = await db.batchTagSemanticThemes(input.forceRetag);
      return result;
    }),

  // Get distribution of semantic themes
  getSemanticThemeStats: publicProcedure
    .query(async () => db.getSemanticThemeStats()),

  // Tag a single tile (used after import)
  tagSingleTile: publicProcedure
    .input(z.object({ tileId: z.number() }))
    .mutation(async ({ input }) => {
      const pool = db.getPool();
      const res = await pool.query(
        `SELECT id, avg_l, avg_a, avg_b, tl_l, tl_a, tl_b, br_l, br_a, br_b,
                is_skin_friendly, tile_type, import_query
         FROM mosaic_images WHERE id = $1`,
        [input.tileId]
      );
      if (!res.rows[0]) return { ok: false, theme: null };
      const theme = db.deriveSemanticTheme(res.rows[0]);
      await pool.query(
        `UPDATE mosaic_images SET semantic_theme = $1 WHERE id = $2`,
        [theme, input.tileId]
      );
      return { ok: true, theme };
    }),
});

// ── Quality Check Async Runner ─────────────────────────────────────────────────
async function runQualityCheckAsync(checkType: string, runId: number): Promise<void> {
  const pool = db.getPool();
  const items: Array<{ runId: number; entityType: string; entityId: string; status: 'pass' | 'warn' | 'fail'; message: string; details?: object }> = [];

  if (checkType === 'index-integrity') {
    // Check: all images have LAB values computed (not default 50/0/0)
    const res = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN avg_l = 50 AND avg_a = 0 AND avg_b = 0 THEN 1 ELSE 0 END) as unindexed,
        SUM(CASE WHEN tile128_url IS NULL THEN 1 ELSE 0 END) as no_thumb
      FROM mosaic_images
    `);
    const { total, unindexed, no_thumb } = res.rows[0];
    const unindexedPct = total > 0 ? (unindexed / total * 100).toFixed(1) : '0';
    items.push({
      runId, entityType: 'db', entityId: 'mosaic_images',
      status: Number(unindexed) > Number(total) * 0.05 ? 'warn' : 'pass',
      message: `${unindexed}/${total} Bilder ohne LAB-Index (${unindexedPct}%)`,
      details: { total: Number(total), unindexed: Number(unindexed), no_thumb: Number(no_thumb) },
    });
    // Check: quadrant LAB completeness
    const quadRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM mosaic_images
      WHERE tl_l = 50 AND tl_a = 0 AND tl_b = 0 AND avg_l != 50
    `);
    const noQuadrant = Number(quadRes.rows[0].cnt);
    items.push({
      runId, entityType: 'db', entityId: 'quadrant_lab',
      status: noQuadrant > 100 ? 'warn' : 'pass',
      message: `${noQuadrant} Bilder ohne Quadrant-LAB (15D-Index unvollständig)`,
      details: { noQuadrant },
    });
    // Check: source_provider backfill
    const srcRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images WHERE source_provider IS NULL`);
    const noSrc = Number(srcRes.rows[0].cnt);
    items.push({
      runId, entityType: 'db', entityId: 'source_provider',
      status: noSrc > 0 ? 'warn' : 'pass',
      message: `${noSrc} Bilder ohne source_provider`,
      details: { noSrc },
    });
    await db.insertQualityItems(items);
    const hasWarn = items.some(i => i.status === 'warn' || i.status === 'fail');
    await db.finishQualityRun(runId, hasWarn ? 'warning' : 'success', {
      total: Number(res.rows[0].total), unindexed: Number(res.rows[0].unindexed), noQuadrant, noSrc
    });

  } else if (checkType === 'pool-balance') {
    // Check LAB-Cube coverage: are all color regions represented?
    const res = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN avg_l < 20 THEN 1 ELSE 0 END) as extreme_dark,
        SUM(CASE WHEN avg_l > 85 THEN 1 ELSE 0 END) as extreme_bright,
        SUM(CASE WHEN avg_l >= 20 AND avg_l <= 85 AND ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 1 ELSE 0 END) as neutral,
        SUM(CASE WHEN SQRT(avg_a*avg_a + avg_b*avg_b) < 20 THEN 1 ELSE 0 END) as low_sat,
        SUM(CASE WHEN SQRT(avg_a*avg_a + avg_b*avg_b) BETWEEN 20 AND 42 THEN 1 ELSE 0 END) as mid_sat,
        SUM(CASE WHEN SQRT(avg_a*avg_a + avg_b*avg_b) > 42 THEN 1 ELSE 0 END) as high_sat,
        SUM(CASE WHEN avg_b < -5 THEN 1 ELSE 0 END) as cool,
        SUM(CASE WHEN avg_a > 10 AND avg_b > 5 THEN 1 ELSE 0 END) as warm_skin
      FROM mosaic_images
    `);
    const r = res.rows[0];
    const total = Number(r.total);
    const checks = [
      { key: 'extreme_dark', label: 'Extrem-Dunkel (L<20)', target: 0.10 },
      { key: 'extreme_bright', label: 'Extrem-Hell (L>85)', target: 0.10 },
      { key: 'low_sat', label: 'Niedrig-Sättigung (<20)', target: 0.30 },
      { key: 'mid_sat', label: 'Mittel-Sättigung (20-42)', target: 0.40 },
      { key: 'high_sat', label: 'Hoch-Sättigung (>42)', target: 0.30 },
      { key: 'cool', label: 'Kühl-Töne (b<-5)', target: 0.20 },
      { key: 'warm_skin', label: 'Warm/Haut-Töne (a>10,b>5)', target: 0.15 },
    ];
    for (const c of checks) {
      const count = Number(r[c.key]);
      const pct = total > 0 ? count / total : 0;
      const diff = pct - c.target;
      items.push({
        runId, entityType: 'pool', entityId: c.key,
        status: diff < -0.05 ? 'fail' : diff < -0.02 ? 'warn' : 'pass',
        message: `${c.label}: ${(pct*100).toFixed(1)}% (Ziel: ${(c.target*100).toFixed(0)}%, Δ${diff > 0 ? '+' : ''}${(diff*100).toFixed(1)}%)`,
        details: { count, pct: Math.round(pct*1000)/10, target: c.target*100 },
      });
    }
    await db.insertQualityItems(items);
    const hasWarn = items.some(i => i.status === 'warn' || i.status === 'fail');
    await db.finishQualityRun(runId, hasWarn ? 'warning' : 'success', { total, checks: items.map(i => ({ id: i.entityId, status: i.status })) });

  } else if (checkType === 'import-health') {
    // Check: per-source import stats
    const res = await pool.query(`
      SELECT
        COALESCE(source_provider, 'unknown') as provider,
        COUNT(*) as total,
        SUM(CASE WHEN imported_at >= NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as last_24h,
        SUM(CASE WHEN imported_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as last_7d,
        COUNT(DISTINCT import_query) as unique_queries
      FROM mosaic_images
      GROUP BY COALESCE(source_provider, 'unknown')
      ORDER BY total DESC
    `);
    for (const row of res.rows) {
      items.push({
        runId, entityType: 'source', entityId: row.provider,
        status: 'pass',
        message: `${row.provider}: ${row.total} Bilder total, +${row.last_24h} (24h), +${row.last_7d} (7d), ${row.unique_queries} Keywords`,
        details: { total: Number(row.total), last24h: Number(row.last_24h), last7d: Number(row.last_7d), uniqueQueries: Number(row.unique_queries) },
      });
    }
    // Check: duplicate rate
    const dupRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT source_url, COUNT(*) as c FROM mosaic_images GROUP BY source_url HAVING COUNT(*) > 1
      ) t
    `);
    const dupCount = Number(dupRes.rows[0].cnt);
    items.push({
      runId, entityType: 'db', entityId: 'url_duplicates',
      status: dupCount > 0 ? 'fail' : 'pass',
      message: `${dupCount} doppelte source_urls in DB`,
      details: { dupCount },
    });
    await db.insertQualityItems(items);
    await db.finishQualityRun(runId, dupCount > 0 ? 'warning' : 'success', { sources: res.rows.length, dupCount });

  } else if (checkType === 'duplicate-check') {
    // Find visual duplicates via phash (if available) or via URL similarity
    const res = await pool.query(`
      SELECT phash, COUNT(*) as cnt, array_agg(id) as ids
      FROM mosaic_images
      WHERE phash IS NOT NULL
      GROUP BY phash HAVING COUNT(*) > 1
      LIMIT 100
    `);
    const urlDupRes = await pool.query(`
      SELECT source_url, COUNT(*) as cnt
      FROM mosaic_images
      GROUP BY source_url HAVING COUNT(*) > 1
      LIMIT 100
    `);
    items.push({
      runId, entityType: 'db', entityId: 'phash_dupes',
      status: res.rows.length > 0 ? 'warn' : 'pass',
      message: `${res.rows.length} pHash-Duplikat-Gruppen gefunden`,
      details: { groups: res.rows.length, examples: res.rows.slice(0, 5).map(r => ({ phash: r.phash, count: Number(r.cnt), ids: r.ids })) },
    });
    items.push({
      runId, entityType: 'db', entityId: 'url_dupes',
      status: urlDupRes.rows.length > 0 ? 'fail' : 'pass',
      message: `${urlDupRes.rows.length} URL-Duplikate in DB (sollte 0 sein)`,
      details: { count: urlDupRes.rows.length },
    });
    await db.insertQualityItems(items);
    const hasWarn = items.some(i => i.status === 'warn' || i.status === 'fail');
    await db.finishQualityRun(runId, hasWarn ? 'warning' : 'success', { phashDupes: res.rows.length, urlDupes: urlDupRes.rows.length });

  } else if (checkType === 'tile-quality-score') {
    // Sample 200 random tiles and compute quality score
    const res = await pool.query(`
      SELECT id, tile128_url, avg_l, avg_a, avg_b,
        tl_l, tl_a, tl_b, tr_l, tr_a, tr_b, bl_l, bl_a, bl_b, br_l, br_a, br_b
      FROM mosaic_images
      WHERE tile128_url IS NOT NULL
      ORDER BY RANDOM() LIMIT 200
    `);
    let pass = 0, warn = 0, fail = 0;
    for (const row of res.rows) {
      // Compute quality score from LAB values (no image download needed)
      const chroma = Math.sqrt(row.avg_a * row.avg_a + row.avg_b * row.avg_b);
      // Color diversity: variance across quadrants
      const lVals = [row.tl_l, row.tr_l, row.bl_l, row.br_l];
      const lMean = lVals.reduce((a: number, b: number) => a + b, 0) / 4;
      const lVariance = lVals.reduce((a: number, b: number) => a + (b - lMean) ** 2, 0) / 4;
      // Score components (0-1 each)
      const chromaScore = Math.min(chroma / 40, 1); // higher chroma = more colorful
      const brightnessScore = 1 - Math.abs(row.avg_l - 50) / 50; // prefer mid-brightness
      const textureScore = Math.min(Math.sqrt(lVariance) / 20, 1); // quadrant variance = texture
      const qualityScore = Math.round((chromaScore * 0.3 + brightnessScore * 0.3 + textureScore * 0.4) * 100) / 100;
      // Reject criteria: too uniform (lVariance < 5) AND too dark/bright
      const isRejected = lVariance < 2 && (row.avg_l < 15 || row.avg_l > 90);
      const status: 'pass' | 'warn' | 'fail' = isRejected ? 'fail' : qualityScore < 0.3 ? 'warn' : 'pass';
      if (status === 'pass') pass++;
      else if (status === 'warn') warn++;
      else fail++;
      items.push({
        runId, entityType: 'tile', entityId: String(row.id),
        status,
        message: `Score: ${qualityScore.toFixed(2)} | L=${row.avg_l.toFixed(0)} chroma=${chroma.toFixed(0)} texture=${Math.sqrt(lVariance).toFixed(1)}`,
        details: { qualityScore, avgL: row.avg_l, chroma: Math.round(chroma), lVariance: Math.round(lVariance) },
      });
    }
    await db.insertQualityItems(items);
    const overallStatus = fail > res.rows.length * 0.1 ? 'warning' : 'success';
    await db.finishQualityRun(runId, overallStatus, { sampled: res.rows.length, pass, warn, fail });
  }
}

// ── pHash berechnen für alle Tiles ohne Hash ─────────────────────────────────
async function computeSimplePHash(url: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let createCanvas: any = null, loadImage: any = null;
    try { const m = require('canvas'); createCanvas = m.createCanvas; loadImage = m.loadImage; } catch { return null; }
    if (!createCanvas || !loadImage) return null;
    const https = require('https');
    const http = require('http');
    const fetchBuf = (u: string): Promise<Buffer> => new Promise((res, rej) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'MosaicPrint/1.0' } }, (r: any) => {
        const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => res(Buffer.concat(c))); r.on('error', rej);
      }).on('error', rej);
    });
    const buf = await fetchBuf(url);
    const img = await loadImage(buf);
    // Resize to 8x8 DCT hash
    const canvas = createCanvas(8, 8);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 8, 8);
    const data = ctx.getImageData(0, 0, 8, 8).data;
    // Compute grayscale values
    const gray: number[] = [];
    for (let i = 0; i < 64; i++) gray.push(0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]);
    const mean = gray.reduce((a, b) => a + b, 0) / 64;
    // Build hash bits
    let hash = '';
    for (const g of gray) hash += g > mean ? '1' : '0';
    // Convert to hex
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(hash.slice(i, i+4), 2).toString(16);
    return hex;
  } catch { return null; }
}

export type AppRouter = typeof appRouter;
