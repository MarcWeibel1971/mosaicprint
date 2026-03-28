import { z } from "zod";
import { randomUUID } from "crypto";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import * as db from "./db.js";
import { renderMosaicOnServer, type TileData } from "./mosaicExport.js";
import Stripe from "stripe";
import { cronState } from "./cron-state.js";
import { downloadAndUploadToR2, isR2Configured } from "./r2.js";
import { rgbToLab as _rgbToLab } from "./colorUtils.js";

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

// CALM_NATURE_KEYWORDS: Natural calm tiles (sky, water, fog, bokeh) – the most important
// category for smooth portrait mosaics. These are the "boring" tiles that make mosaics smooth.
// Target: 30% of DB. Priority: HIGHEST.
const CALM_NATURE_KEYWORDS = [
  // Sky gradients (most important – maps to skin highlights, backgrounds)
  "clear blue sky gradient minimal", "overcast sky soft gray", "pale sky horizon minimal",
  "sunrise sky gradient soft", "sunset sky gradient orange pink", "golden hour sky smooth",
  "blue sky cloudless minimal", "white sky overcast soft", "dawn sky gradient pale",
  "dusk sky gradient purple", "hazy sky minimal", "morning sky soft light",
  // Sky color variants (user-requested)
  "red sky sunset dramatic", "crimson sky dusk gradient", "orange red sky horizon",
  "deep blue sky clear minimal", "bright blue sky cloudless", "azure blue sky smooth",
  "white sky bright overcast", "pale white sky minimal", "milky white sky soft",
  "green sky aurora borealis", "teal green sky abstract", "emerald sky gradient soft",
  // Fog and mist (maps to pale skin, highlights, soft backgrounds)
  "fog mist minimal soft", "morning fog landscape", "misty forest soft",
  "haze soft minimal", "foggy morning field", "mist water reflection",
  "soft mist abstract", "fog neutral minimal", "misty mountain soft gray",
  "foggy lake morning", "white mist minimal", "soft haze neutral",
  // Water surfaces (calm, reflective – maps to cool skin tones)
  "calm water surface reflection", "still lake reflection", "ocean horizon calm",
  "smooth water abstract", "blue water surface minimal", "water reflection soft",
  "calm sea surface", "lake water smooth", "river reflection calm",
  "water texture smooth blue", "ocean calm minimal", "still water abstract",
  // Meer / Ocean (user-requested)
  "ocean surface calm minimal", "sea water texture smooth", "deep ocean blue minimal",
  "mediterranean sea calm", "tropical ocean surface", "ocean horizon line minimal",
  "sea surface reflection", "calm ocean blue abstract", "open sea minimal",
  "ocean water color gradient", "sea gradient blue smooth", "sea calm minimal",
  // Bokeh backgrounds (most useful for portrait mosaics)
  "bokeh background soft blur", "out of focus background neutral", "defocused background warm",
  "blurred background abstract", "bokeh lights soft", "soft focus background",
  "warm bokeh blur", "cool bokeh blur", "neutral bokeh background",
  "defocused green bokeh", "blurred warm bokeh", "soft bokeh minimal",
  // Bokeh & Radiant (user-requested)
  "bokeh radiant light abstract", "radiant bokeh soft glow", "glowing bokeh light",
  "radiant light abstract minimal", "luminous bokeh background", "radiant glow soft",
  "bokeh radiant warm light", "radiant bokeh cool blue", "soft radiant light bokeh",
  "glowing radiant abstract smooth", "radiant light gradient soft", "bokeh glow smooth warm",
  // Fabric and textile (maps to clothing areas)
  "fabric texture smooth minimal", "linen texture neutral", "cotton fabric smooth",
  "silk texture smooth", "wool texture soft", "canvas texture neutral",
  "smooth cloth texture", "fabric background minimal", "textile texture smooth",
  // Sand and earth (maps to warm skin tones)
  "sand texture smooth minimal", "beach sand closeup", "fine sand texture",
  "sandy beach smooth", "desert sand minimal", "warm sand abstract",
  // Sand variants (user-requested)
  "sand dunes smooth gradient", "golden sand beach minimal", "white sand beach smooth",
  "sand pattern abstract warm", "fine sand texture closeup", "beach sand gradient warm",
  "desert sand warm minimal", "sand color abstract smooth", "sandy texture warm soft",
  // Paper and minimal surfaces
  "paper texture minimal white", "blank paper background", "white paper smooth",
  "cream paper texture", "off-white paper minimal", "light paper background",
  // NEW: additional calm nature keywords for Production API
  "cumulus clouds blue sky", "cirrus clouds wispy", "stratus clouds gray",
  "blue sky horizon line", "sky reflection water", "twilight sky gradient",
  "night sky dark blue", "stormy sky dramatic", "rainbow sky after rain",
  "arctic sky pale", "tropical sky bright", "mountain sky clear",
  "sea fog coastal", "valley mist morning", "low cloud cover soft",
  "rain mist abstract", "steam vapor soft", "smoke abstract minimal",
  "ocean wave close", "sea foam white", "tide pool reflection",
  "rain puddle reflection", "dew drops grass", "ice surface smooth",
  "snow surface minimal", "frozen lake surface", "glacier surface blue",
  "river current smooth", "stream water clear", "waterfall mist soft",
  "bokeh city lights night", "bokeh nature green", "bokeh flowers soft",
  "lens flare soft", "light leak abstract", "sunbeam through trees",
  "gauze fabric soft", "muslin cloth neutral", "chiffon fabric light",
  "velvet texture dark", "suede texture warm", "felt texture soft",
  "clay texture smooth", "plaster wall smooth", "stucco wall texture",
  "concrete floor smooth", "stone surface flat", "slate surface dark",
  // NEW: high-volume keywords (100k+ Unsplash results)
  "sand", "sand texture", "sand dunes", "sand beach", "sand pattern",
  "sea", "sea water", "sea horizon", "sea calm", "sea blue",
  "blue sky", "blue sky minimal", "sky blue", "clear blue sky", "sky blue gradient",
  "sky blue cloudless", "sky blue clear", "sky blue horizon", "sky blue calm",
  "northern lights", "aurora borealis", "aurora sky", "northern lights green",
  "northern lights purple", "aurora borealis sky", "aurora night sky",
  "ocean surface", "ocean water", "ocean blue", "ocean calm", "ocean horizon",
  "ocean waves aerial", "ocean texture", "sea surface", "sea water blue",
  "radiant light", "radiant bokeh", "radiant glow soft", "radiant sky",
];

// CALM_MONOCHROME_KEYWORDS: Single-hue, low-texture tiles for backgrounds and clothing
// These are ruhige Naturbilder with a single dominant color tone — ideal for:
//   - Dark clothing (navy, charcoal, forest green)
//   - Light backgrounds (pale blue sky, white wall, light gray)
//   - Skin-adjacent areas (beige, peach, warm gray)
// Keywords deliberately avoid busy textures: no leaves, no patterns, no details.
const CALM_MONOCHROME_KEYWORDS = [
  // ── Neutral / Gray / White (backgrounds, light clothing) ──
  "plain white wall minimal", "light gray wall smooth", "white paper background clean",
  "gray concrete smooth minimal", "pale gray sky overcast", "white mist fog minimal",
  "light beige wall smooth", "cream white background minimal", "off white texture smooth",
  "silver gray smooth abstract", "pale neutral background", "soft white light background",
  // ── Dark / Black (dark jackets, hair, shadows) ──
  "dark navy blue smooth", "charcoal gray smooth minimal", "dark slate background clean",
  "black smooth gradient", "dark gray smooth abstract", "deep charcoal minimal",
  "dark blue smooth background", "very dark gray minimal", "black gradient smooth",
  // ── Blue (sky, water, cool backgrounds) ──
  "clear blue sky minimal", "smooth blue gradient abstract", "pale blue background minimal",
  "deep blue ocean smooth", "navy blue smooth gradient", "blue sky cloudless",
  "soft blue abstract smooth", "blue gradient minimal", "cornflower blue smooth",
  // ── Green (nature backgrounds, foliage out of focus) ──
  "dark green smooth bokeh", "forest green abstract blur", "olive green smooth minimal",
  "soft green bokeh background", "deep green smooth gradient", "sage green minimal",
  "muted green abstract smooth", "dark olive smooth", "forest bokeh green blur",
  // ── Warm / Brown / Beige (clothing, warm backgrounds) ──
  "warm beige smooth background", "tan brown minimal smooth", "warm brown gradient",
  "camel beige smooth abstract", "warm taupe minimal", "light brown smooth",
  "warm sand minimal background", "khaki smooth abstract", "warm neutral smooth",
  // ── Red / Burgundy (clothing, warm accents) ──
  "dark burgundy smooth minimal", "deep red smooth gradient", "muted red abstract smooth",
  "wine red minimal", "dark maroon smooth", "soft red gradient abstract",
  // ── Teal / Cyan (cool clothing, water backgrounds) ──
  "teal smooth gradient minimal", "dark teal abstract smooth", "muted teal minimal",
  "soft cyan smooth background", "dark teal smooth", "muted turquoise minimal",
  // ── NEW: additional monochrome tones ──
  "lavender purple smooth", "mauve purple minimal", "dusty rose smooth",
  "blush pink minimal", "salmon pink smooth", "peach tone minimal",
  "terracotta smooth abstract", "rust brown minimal", "sienna warm smooth",
  "forest green dark smooth", "hunter green minimal", "moss green smooth",
  "cobalt blue smooth", "royal blue minimal", "slate blue smooth",
  "midnight blue dark", "indigo smooth abstract", "violet purple smooth",
  "gold yellow smooth", "amber warm minimal", "honey tone smooth",
  "cream ivory minimal", "ecru neutral smooth", "linen beige minimal",
  "graphite gray smooth", "pewter gray minimal", "ash gray smooth",
  "espresso dark brown", "chocolate brown smooth", "walnut dark minimal",
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

// TEXTURE_KEYWORDS: Strukturierte Oberflächen – Stein, Beton, Papier, Stoff, Marmor
// Kategorie 4 aus dem Dokument: "Texturen (extrem wichtig)"
// Ziel: 20% des Pools. Geben strukturelle Vielfalt ohne Farbrauschen.
const TEXTURE_KEYWORDS = [
  // Stein & Beton
  "concrete texture closeup", "stone texture surface", "rough concrete wall",
  "granite texture closeup", "limestone texture surface", "cobblestone texture",
  "slate rock texture", "sandstone surface closeup", "rough stone wall",
  // Papier & Stoff
  "paper texture white minimal", "linen fabric texture closeup", "canvas texture neutral",
  "cotton fabric closeup", "rough burlap texture", "smooth silk texture",
  "woven fabric texture", "denim texture closeup", "velvet texture dark",
  // Marmor & Holz
  "marble texture white veins", "wood grain texture closeup", "oak wood texture",
  "dark marble texture", "light marble surface", "walnut wood grain",
  "bamboo texture closeup", "cork texture surface", "birch wood texture",
  // Metall & Glas
  "metal texture brushed", "rust texture abstract", "glass texture surface",
  "steel texture smooth", "copper texture closeup", "aluminum surface texture",
];

// ARCHITECTURE_KEYWORDS: Gebäude, Fassaden, Fenster, Muster
// Kategorie 8 aus dem Dokument: "Architektur"
// Ziel: 15% des Pools. Viele interessante Muster und Strukturen.
const ARCHITECTURE_KEYWORDS = [
  // Fassaden & Wände
  "building facade minimal", "brick wall texture", "concrete building facade",
  "modern architecture minimal", "glass building facade", "stone building wall",
  "white wall architecture", "industrial building facade", "urban wall texture",
  // Fenster & Muster
  "window pattern architecture", "geometric building pattern", "grid window facade",
  "repeating pattern architecture", "abstract building geometry", "symmetrical facade",
  // Spezifische Strukturen
  "wooden door texture", "metal door abstract", "tile floor pattern",
  "mosaic tile pattern", "geometric tile abstract", "staircase abstract minimal",
];

// URBAN_KEYWORDS: Strassen, Asphalt, Stadtoberflächen
// Kategorie 9 aus dem Dokument: "Strassen / Urban"
// Ziel: 10% des Pools. Dunkle und mittlere Töne für Schatten und Hintergründe.
const URBAN_KEYWORDS = [
  // Asphalt & Strassen
  "asphalt texture closeup", "road surface texture", "wet asphalt abstract",
  "pavement texture minimal", "sidewalk texture", "cobblestone street",
  "concrete road surface", "tarmac texture closeup", "gravel texture surface",
  // Urban Oberflächen
  "urban texture abstract", "city street minimal", "graffiti wall abstract",
  "rusty metal urban", "weathered wall texture", "peeling paint texture",
  "urban decay abstract", "industrial texture minimal", "worn concrete surface",
];

// PLANTS_GREEN_KEYWORDS: Pflanzen, Grünflächen, Blätter
// Kategorie 10 aus dem Dokument: "Pflanzen / Grünflächen"
// Ziel: 10% des Pools. Wichtig für Farbdiversität (Grüntöne).
const PLANTS_GREEN_KEYWORDS = [
  // Blätter & Pflanzen
  "green leaves texture closeup", "leaf texture macro", "plant texture minimal",
  "tropical leaves closeup", "fern texture green", "moss texture closeup",
  "ivy leaves texture", "palm leaf texture", "bamboo leaves minimal",
  // Gras & Felder
  "grass texture closeup", "grass field minimal", "lawn texture green",
  "meadow grass abstract", "green field minimal", "clover texture closeup",
  // Wald & Natur
  "forest texture abstract", "tree canopy minimal", "forest floor texture",
  "dark forest abstract", "woodland texture minimal", "tree bark texture",
  // Abstrakt Grün
  "green bokeh background", "blurred green nature", "soft green abstract",
  "dark green minimal", "forest green abstract", "muted green texture",
];

// ── Gradient / Edge tiles: specifically for edge-aware matching ──
// These have smooth directional gradients (light→dark or color→color transitions)
// that are ideal for edge cells in the mosaic where Sobel detects contours.
const GRADIENT_EDGE_KEYWORDS = [
  // Directional gradients (strong L-channel transition across tile)
  "smooth gradient light to dark abstract", "diagonal gradient minimal abstract",
  "black white gradient smooth", "gradient shadow light abstract",
  "light dark transition smooth", "shadow gradient abstract minimal",
  // Color gradients (hue transitions)
  "sunset gradient two tone sky", "blue orange gradient smooth sky",
  "warm cool gradient abstract", "color gradient smooth transition",
  "pink blue gradient abstract", "yellow orange gradient sky",
  // Soft directional light
  "window light gradient smooth", "soft directional light abstract",
  "spotlight gradient dark background", "side light gradient portrait",
  "chiaroscuro abstract smooth", "dramatic light shadow gradient",
  // Natural gradients
  "horizon line gradient sky water", "forest edge gradient light dark",
  "mountain silhouette gradient", "tree shadow gradient ground",
  "sand to water gradient beach", "snow to rock gradient mountain",
  // Vignette and radial gradients
  "vignette dark edges abstract", "radial gradient smooth center",
  "light center dark edges abstract", "tunnel light gradient abstract",
];

function getColorCategory(avgL: number, avgA: number, avgB: number): string {
  if (avgL < 25) return "black";
  if (avgL > 80) return "white";
  if (Math.abs(avgA) < 8 && Math.abs(avgB) < 8) return "neutral";
  // Determine dominant channel: whichever of |a| or |b| is larger wins
  const absA = Math.abs(avgA);
  const absB = Math.abs(avgB);
  if (absB >= absA) {
    // b-channel dominates
    if (avgB < -15) return "blue";
    if (avgB > 20) return "yellow";
    if (avgA < -10 && avgB < -5) return "cyan";
    if (avgA < -10) return "green";
  } else {
    // a-channel dominates
    if (avgA > 20) return "red";
    if (avgA > 10 && avgB < 0) return "purple";
    if (avgA > 10 && avgB > 10) return "orange";
    if (avgA > 10) return "pink";
  }
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

  // ── Step 2b2: Calm Nature tiles (HIGHEST PRIORITY – sky, water, fog, bokeh) ──
  // Target: 30% of DB. These are the most important tiles for smooth portrait mosaics.
  // "70% boring" principle: calm tiles should dominate the pool.
  {
    const calmNatureCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'calm_nature'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const calmNaturePct = calmNatureCnt / total;
    const calmNaturePriority = Math.max(0, (0.30 - calmNaturePct) / 0.30) * 3.5; // max 3.5 – HIGHEST
    if (calmNaturePriority > 0.05) {
      const deficit = Math.round((0.30 - calmNaturePct) * total);
      for (const kw of CALM_NATURE_KEYWORDS) {
        tasks.push({ query: kw, priority: calmNaturePriority, deficit, label: `🌤️ Calm-Natur (Sky/Fog/Water/Bokeh) (${Math.round(calmNaturePct*100)}% → Ziel 30%)`, subject: 'calm_nature' });
      }
    }
  }

  // ── Step 2b2: Calm Monochrome tiles ──
  // Target: 20% of DB. Single-hue, low-texture tiles for backgrounds and clothing.
  // These reduce graininess in uniform areas (dark jackets, light backgrounds).
  {
    const calmCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'calm_monochrome'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const calmPct = calmCnt / total;
    const calmPriority = Math.max(0, (0.20 - calmPct) / 0.20) * 3.0; // max 3.0 (erhöht von 2.5)
    if (calmPriority > 0.05) {
      const deficit = Math.round((0.20 - calmPct) * total);
      for (const kw of CALM_MONOCHROME_KEYWORDS) {
        tasks.push({ query: kw, priority: calmPriority, deficit, label: `🎨 Ruhige Einfarbige (${Math.round(calmPct*100)}% → Ziel 20%)`, subject: 'calm_monochrome' });
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
    const abstractPriority = Math.max(0, (0.25 - abstractPct) / 0.25) * 2.8; // max 2.8 (erhöht von 2.0)
    if (abstractPriority > 0.05) {
      const deficit = Math.round((0.25 - abstractPct) * total);
      for (const kw of ABSTRACT_LOW_EDGE_KEYWORDS) {
        tasks.push({ query: kw, priority: abstractPriority, deficit, label: `🌫️ Abstrakt-Glatt (${Math.round(abstractPct*100)}% → Ziel 25%)`, subject: 'abstract_smooth' });
      }
    }
  }

  // ── Step 2d: Mosaic-optimierte Kategorien (KEINE Tiere/Blumen/Space als Einzelobjekte) ──
  // Ziel: Bilder die als Mosaic-Tiles funktionieren: monochrom/zweifarbig, kein dominantes Einzelobjekt
  const MOSAIC_THEME_TARGETS: Array<{subject: string; label: string; emoji: string; queries: string[]; targetPct: number; maxPriority: number}> = [
    {
      subject: 'bokeh_gradient',
      label: '✨ Bokeh & Gradienten',
      emoji: '✨',
      targetPct: 0.12, maxPriority: 3.0,
      queries: [
        'bokeh lights warm background', 'bokeh lights cool background', 'soft bokeh abstract',
        'blurred lights background', 'defocused lights warm', 'bokeh circle lights',
        'smooth color gradient abstract', 'gradient sky abstract', 'color wash gradient',
        'soft light bokeh neutral', 'warm bokeh background photography', 'cool bokeh night',
        'blurred background warm tones', 'smooth pastel gradient', 'bokeh photography abstract',
        'light leak bokeh warm', 'golden bokeh background', 'blue bokeh abstract',
      ],
    },
    {
      subject: 'pure_sky',
      label: '☁️ Reiner Himmel',
      emoji: '☁️',
      targetPct: 0.10, maxPriority: 3.0,
      queries: [
        'clear blue sky minimal', 'blue sky no clouds', 'sky gradient blue',
        'overcast grey sky', 'dramatic sky clouds', 'sunset sky orange',
        'pink sky sunset minimal', 'purple sky dusk', 'golden hour sky',
        'blue sky horizon minimal', 'cloudy sky texture', 'sky abstract minimal',
        'dawn sky pastel', 'twilight sky gradient', 'sky photography minimal',
        'stormy sky dark', 'sky blue gradient photography', 'sunrise sky warm',
      ],
    },
    {
      subject: 'water_surface',
      label: '🌊 Wasseroberflächen',
      emoji: '🌊',
      targetPct: 0.10, maxPriority: 2.8,
      queries: [
        'calm water surface abstract', 'ocean water texture', 'sea surface minimal',
        'water reflection abstract', 'lake surface calm', 'water ripple abstract',
        'ocean blue surface', 'turquoise water surface', 'dark water surface',
        'water texture photography', 'sea foam abstract', 'calm lake reflection',
        'water color abstract blue', 'ocean horizon minimal', 'water abstract photography',
        'rain water surface', 'pool water surface', 'river water abstract',
      ],
    },
    {
      subject: 'sand_earth',
      label: '🏜️ Sand & Erde',
      emoji: '🏜️',
      targetPct: 0.08, maxPriority: 2.5,
      queries: [
        'sand texture closeup minimal', 'desert sand dunes', 'sand dunes abstract',
        'sandy beach texture', 'dry earth texture', 'soil texture abstract',
        'desert landscape minimal', 'sand pattern abstract', 'golden sand texture',
        'beach sand minimal', 'earth texture brown', 'dry desert abstract',
        'sand ripple pattern', 'warm sand texture photography', 'desert abstract warm',
        'clay earth texture', 'sandy ground texture', 'brown earth minimal',
      ],
    },
    {
      subject: 'fog_mist',
      label: '🌫️ Nebel & Dunst',
      emoji: '🌫️',
      targetPct: 0.06, maxPriority: 2.5,
      queries: [
        'fog landscape minimal', 'misty morning abstract', 'foggy forest minimal',
        'mist abstract photography', 'foggy mountain minimal', 'morning mist landscape',
        'haze abstract minimal', 'foggy valley landscape', 'soft mist photography',
        'fog abstract grey', 'misty water surface', 'fog light abstract',
      ],
    },
    {
      subject: 'autumn_carpet',
      label: '🍂 Herbst-Teppich',
      emoji: '🍂',
      targetPct: 0.06, maxPriority: 2.2,
      queries: [
        'autumn leaves carpet ground', 'fallen leaves texture', 'autumn leaves background',
        'orange leaves ground texture', 'red autumn leaves carpet', 'autumn foliage abstract',
        'colorful autumn leaves background', 'fall leaves texture photography', 'autumn ground abstract',
        'maple leaves carpet', 'autumn colors abstract', 'fall foliage background',
      ],
    },
    {
      subject: 'snow_ice',
      label: '❄️ Schnee & Eis',
      emoji: '❄️',
      targetPct: 0.06, maxPriority: 2.2,
      queries: [
        'snow field minimal', 'white snow abstract', 'snow texture closeup',
        'snow landscape minimal', 'ice texture abstract', 'frozen surface abstract',
        'snow ground texture', 'winter white abstract', 'snow abstract photography',
        'blizzard abstract white', 'snow drift minimal', 'ice crystal abstract',
      ],
    },
  ];
  for (const themeTarget of MOSAIC_THEME_TARGETS) {
    const themeCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = $1`, [themeTarget.subject]
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const targetCnt = Math.round(total * themeTarget.targetPct);
    const deficit = Math.max(0, targetCnt - themeCnt);
    if (deficit > 0) {
      const priority = Math.min(themeTarget.maxPriority, (deficit / Math.max(1, targetCnt)) * themeTarget.maxPriority);
      for (const kw of themeTarget.queries) {
        tasks.push({ query: kw, priority, deficit, label: `${themeTarget.emoji} ${themeTarget.label} (${themeCnt} → Ziel ${targetCnt})`, subject: themeTarget.subject });
      }
    }
  }

  // ── Step 2e: Texture tiles (Kategorie 4 aus dem Dokument) ──
  // Ziel: 20% des Pools. Strukturelle Vielfalt: Stein, Beton, Papier, Stoff, Marmor, Holz.
  {
    const textureCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'texture'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const texturePct = textureCnt / total;
    const texturePriority = Math.max(0, (0.20 - texturePct) / 0.20) * 2.0; // max 2.0
    if (texturePriority > 0.05) {
      const deficit = Math.round((0.20 - texturePct) * total);
      for (const kw of TEXTURE_KEYWORDS) {
        tasks.push({ query: kw, priority: texturePriority, deficit, label: `🧱 Texturen (Stein/Stoff/Holz) (${Math.round(texturePct*100)}% → Ziel 20%)`, subject: 'texture' });
      }
    }
  }

  // ── Step 2f: Architecture tiles (Kategorie 8 aus dem Dokument) ──
  // Ziel: 15% des Pools. Gebäude, Fassaden, Fenster, Muster.
  {
    const archCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'architecture'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const archPct = archCnt / total;
    const archPriority = Math.max(0, (0.15 - archPct) / 0.15) * 1.8; // max 1.8
    if (archPriority > 0.05) {
      const deficit = Math.round((0.15 - archPct) * total);
      for (const kw of ARCHITECTURE_KEYWORDS) {
        tasks.push({ query: kw, priority: archPriority, deficit, label: `🏛️ Architektur (Fassaden/Muster) (${Math.round(archPct*100)}% → Ziel 15%)`, subject: 'architecture' });
      }
    }
  }

  // ── Step 2g: Urban tiles (Kategorie 9 aus dem Dokument) ──
  // Ziel: 10% des Pools. Strassen, Asphalt, Stadtoberflächen.
  {
    const urbanCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'urban'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const urbanPct = urbanCnt / total;
    const urbanPriority = Math.max(0, (0.10 - urbanPct) / 0.10) * 1.5; // max 1.5
    if (urbanPriority > 0.05) {
      const deficit = Math.round((0.10 - urbanPct) * total);
      for (const kw of URBAN_KEYWORDS) {
        tasks.push({ query: kw, priority: urbanPriority, deficit, label: `🏙️ Urban (Asphalt/Strassen) (${Math.round(urbanPct*100)}% → Ziel 10%)`, subject: 'urban' });
      }
    }
  }

  // ── Step 2h: Plants/Green tiles (Kategorie 10 aus dem Dokument) ──
  // Ziel: 10% des Pools. Pflanzen, Grünflächen, Blätter.
  {
    const plantsCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'plants'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const plantsPct = plantsCnt / total;
    const plantsPriority = Math.max(0, (0.10 - plantsPct) / 0.10) * 1.5; // max 1.5
    if (plantsPriority > 0.05) {
      const deficit = Math.round((0.10 - plantsPct) * total);
      for (const kw of PLANTS_GREEN_KEYWORDS) {
        tasks.push({ query: kw, priority: plantsPriority, deficit, label: `🌿 Pflanzen/Grün (${Math.round(plantsPct*100)}% → Ziel 10%)`, subject: 'plants' });
      }
    }
  }

  // ── Step 2h2: Gradient/Edge tiles (for edge-aware tile matching) ──
  // These tiles have smooth directional gradients ideal for Sobel-detected edge cells.
  // Target: 10% of DB. High priority because edge quality depends on these.
  {
    const gradientCnt = await pool.query(
      `SELECT COUNT(*) as cnt FROM mosaic_images WHERE subject = 'gradient_edge'`
    ).then(r => Number(r.rows[0]?.cnt ?? 0));
    const gradientPct = gradientCnt / total;
    const gradientPriority = Math.max(0, (0.10 - gradientPct) / 0.10) * 2.5; // max 2.5
    if (gradientPriority > 0.05) {
      const deficit = Math.round((0.10 - gradientPct) * total);
      for (const kw of GRADIENT_EDGE_KEYWORDS) {
        tasks.push({ query: kw, priority: gradientPriority, deficit, label: `🔲 Gradient/Edge-Tiles (${Math.round(gradientPct*100)}% → Ziel 10%)`, subject: 'gradient_edge' });
      }
    }
  }

  // ── Step 2i: Critical LAB-color gaps (high priority for underrepresented colors) ──
  // Pool analysis shows certain LAB color categories are critically low (<5% of total).
  // These need targeted imports with higher priority than generic color buckets.
  {
    const colorCountRes = await pool.query(`
      SELECT
        CASE
          WHEN avg_l < 25 THEN 'schwarz'
          WHEN avg_l > 80 THEN 'weiss'
          WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 THEN 'grau'
          WHEN ABS(avg_b) >= ABS(avg_a) AND avg_b < -15 THEN 'blau'
          WHEN ABS(avg_b) >= ABS(avg_a) AND avg_b > 20 THEN 'gelb'
          WHEN ABS(avg_b) >= ABS(avg_a) AND avg_a < -10 AND avg_b < -5 THEN 'cyan'
          WHEN ABS(avg_b) >= ABS(avg_a) AND avg_a < -10 THEN 'gruen'
          WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 20 THEN 'rot'
          WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 AND avg_b < 0 THEN 'violett'
          WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 AND avg_b > 10 THEN 'orange'
          WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 THEN 'pink'
          ELSE 'grau'
        END as color_cat,
        COUNT(*) as cnt
      FROM mosaic_images
      GROUP BY color_cat
    `);
    const colorCounts = new Map<string, number>();
    for (const row of colorCountRes.rows) {
      colorCounts.set(row.color_cat, Number(row.cnt));
    }

    // Target: each color should have at least 5% of total (or minimum 800 tiles)
    const minPerColor = Math.max(800, Math.round(total * 0.05));
    const COLOR_GAP_KEYWORDS: Record<string, { emoji: string; label: string; keywords: string[] }> = {
      cyan: {
        emoji: '🩵', label: 'Cyan/Türkis',
        keywords: [
          "turquoise water surface tropical", "teal wall texture smooth", "swimming pool surface blue",
          "tropical water turquoise", "cyan abstract gradient", "teal blue ocean surface",
          "turquoise blue abstract smooth", "aqua water color gradient", "seafoam green smooth",
          "teal fabric texture", "turquoise stone texture", "cyan neon abstract",
        ],
      },
      gruen: {
        emoji: '🟢', label: 'Grün',
        keywords: [
          "green leaves close texture", "grass texture macro closeup", "moss surface texture green",
          "emerald fabric texture", "green abstract gradient smooth", "forest green bokeh",
          "green plant leaves texture", "dark green nature abstract", "lime green abstract bright",
          "sage green smooth wall", "olive green texture", "mint green abstract",
        ],
      },
      orange: {
        emoji: '🟠', label: 'Orange',
        keywords: [
          "sunset gradient orange sky", "terracotta wall texture", "rust texture surface orange",
          "copper metal texture", "orange abstract gradient smooth", "amber warm abstract",
          "orange peel texture macro", "burnt orange fabric", "tangerine color abstract",
          "peach orange gradient smooth", "apricot color bokeh", "warm orange abstract",
        ],
      },
      violett: {
        emoji: '🟣', label: 'Violett',
        keywords: [
          "lavender field purple", "purple fabric texture smooth", "violet abstract gradient",
          "amethyst crystal purple", "purple bokeh abstract", "indigo blue purple gradient",
          "lilac flower purple", "deep violet abstract smooth", "purple neon abstract",
          "mauve purple texture smooth", "plum purple abstract", "wisteria purple bokeh",
        ],
      },
      pink: {
        emoji: '🩷', label: 'Pink',
        keywords: [
          "pink roses flower closeup", "magenta abstract gradient", "pink fabric texture smooth",
          "fuchsia bright abstract", "pink sky sunset gradient", "blush pink smooth bokeh",
          "hot pink neon abstract", "rose pink gradient smooth", "pink cherry blossom",
          "pink tulip flower macro", "salmon pink abstract", "coral pink texture",
        ],
      },
      rot: {
        emoji: '🔴', label: 'Rot',
        keywords: [
          "red brick wall texture", "cherry red fruit closeup", "poppy field red flowers",
          "crimson fabric texture", "red abstract gradient smooth", "dark red wine color",
          "ruby red crystal", "red rose macro closeup", "bright red abstract",
          "scarlet red texture", "vermilion red abstract", "blood red gradient smooth",
        ],
      },
    };

    for (const [colorKey, { emoji, label, keywords }] of Object.entries(COLOR_GAP_KEYWORDS)) {
      const cnt = colorCounts.get(colorKey) ?? 0;
      const deficit = Math.max(0, minPerColor - cnt);
      if (deficit > 0) {
        // Priority scales with severity: 2.0 if completely missing, decreasing as we approach target
        const priority = Math.min(2.0, (deficit / minPerColor) * 2.0);
        for (const kw of keywords) {
          tasks.push({ query: kw, priority, deficit, label: `${emoji} ${label} (${cnt} → Ziel ${minPerColor})`, subject: `color_${colorKey}` });
        }
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
        WHEN ABS(avg_b) >= ABS(avg_a) AND avg_b < -15 THEN 'blue'
        WHEN ABS(avg_b) >= ABS(avg_a) AND avg_b > 20 THEN 'yellow'
        WHEN ABS(avg_b) >= ABS(avg_a) AND avg_a < -10 AND avg_b < -5 THEN 'cyan'
        WHEN ABS(avg_b) >= ABS(avg_a) AND avg_a < -10 THEN 'green'
        WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 20 THEN 'red'
        WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 AND avg_b < 0 THEN 'purple'
        WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 THEN 'pink'
        WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
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
  // Boost calm categories to ensure they dominate imports
  // New categories (texture, architecture, urban, plants) come after calm but before color buckets
  tasks.sort((a, b) => {
    // Calm categories always first (portrait quality)
    const calmSubjects = ['calm_nature', 'calm_monochrome', 'abstract_smooth'];
    const aIsCalm = calmSubjects.includes(a.subject);
    const bIsCalm = calmSubjects.includes(b.subject);
    if (aIsCalm && !bIsCalm) return -1;
    if (!aIsCalm && bIsCalm) return 1;
    // Color-gap categories second (critically underrepresented LAB colors)
    const aIsColorGap = a.subject.startsWith('color_');
    const bIsColorGap = b.subject.startsWith('color_');
    if (aIsColorGap && !bIsColorGap) return -1;
    if (!aIsColorGap && bIsColorGap) return 1;
    // Structural categories third (texture, architecture, urban, plants)
    const structuralSubjects = ['texture', 'architecture', 'urban', 'plants'];
    const aIsStructural = structuralSubjects.includes(a.subject);
    const bIsStructural = structuralSubjects.includes(b.subject);
    if (aIsStructural && !bIsStructural && b.subject !== 'general') return -1;
    if (!aIsStructural && bIsStructural && a.subject !== 'general') return 1;
    return b.priority - a.priority;
  });
  return tasks;
}

// Legacy function kept for backward compatibility
async function getUnderrepresentedColors(targetPerColor = 500): Promise<string[]> {
  const tasks = await analyzeDbGaps(targetPerColor);
  return tasks.slice(0, 30).map(t => t.query);
}

// ---- Job state ----
type JobStatus = { running: boolean; log: string[]; startedAt: string | null; finishedAt: string | null; error: string | null; imported: number; total: number; sessionId?: string | null; pendingReview?: boolean; };
const importJobStatuses: Record<string, JobStatus> = {};
const smartImportJobs: Record<string, JobStatus> = {};
// targetedImport jobs: keyed by sessionId (client-generated)
type TargetedJobStatus = JobStatus & { query: string; sourceId: string; report?: Array<{keyword: string; imported: number; rejected: number; total: number}> };
const targetedImportJobs: Record<string, TargetedJobStatus> = {};
// Multi-keyword session: groups multiple targetedImport jobs
type KeywordSession = { sessionId: string; keywords: string[]; source: string; startedAt: string; finishedAt: string | null; results: Array<{keyword: string; imported: number; rejected: number; total: number; status: 'running'|'done'|'error'}>; totalImported: number; totalBefore: number; totalAfter: number };
const keywordSessions: Record<string, KeywordSession> = {};
let rebuildJobStatus = { running: false, log: [] as string[], startedAt: null as string | null, finishedAt: null as string | null, error: null as string | null };

function getImportStatus(sourceId: string): JobStatus {
  if (!importJobStatuses[sourceId]) {
    importJobStatuses[sourceId] = { running: false, log: [], startedAt: null, finishedAt: null, error: null, imported: 0, total: 0, sessionId: null };
  }
  return importJobStatuses[sourceId];
}

// Compute LAB from raw RGB pixels (3 bytes per pixel)
// Verwendet _rgbToLab aus colorUtils.ts (keine lokale Duplikation)
function rgbPixelsToLab(px: Buffer, pixelCount: number): { L: number; a: number; b: number } {
  let rSum = 0, gSum = 0, bSum = 0;
  for (let j = 0; j < px.length; j += 3) { rSum += px[j]; gSum += px[j + 1]; bSum += px[j + 2]; }
  const [L, a, b] = _rgbToLab(Math.round(rSum / pixelCount), Math.round(gSum / pixelCount), Math.round(bSum / pixelCount));
  return { L, a, b };
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
  edgeDensity: number; // 0-1 echter Sobel-basierter Kantenwert
  blurScore: number;   // Laplacian Variance (< 100 = unscharf)
  pHash: string | null; // 16-char hex perceptual hash
  mosaicScore: number; // 0-1 Gesamteignung als Mosaic-Tile (Schärfe + Farbvielfalt + Kantendichte)
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
    // ── Step 1: Resize to 16x16 for edge detection + 8x8 for LAB quadrants ──
    const img16 = image.clone();
    img16.resize({ w: 16, h: 16 });
    // Extract 16x16 grayscale pixels for Sobel edge detection
    const gray16: number[] = [];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const rgba = img16.getPixelColor(x, y);
        const r = (rgba >> 24) & 0xff;
        const g = (rgba >> 16) & 0xff;
        const b = (rgba >> 8)  & 0xff;
        gray16.push(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    // Sobel edge energy on 16x16 (skip border pixels)
    let sobelSum = 0;
    let sobelCount = 0;
    for (let y = 1; y < 15; y++) {
      for (let x = 1; x < 15; x++) {
        const idx = (r: number, c: number) => gray16[r * 16 + c];
        const gx = -idx(y-1,x-1) + idx(y-1,x+1) - 2*idx(y,x-1) + 2*idx(y,x+1) - idx(y+1,x-1) + idx(y+1,x+1);
        const gy = -idx(y-1,x-1) - 2*idx(y-1,x) - idx(y-1,x+1) + idx(y+1,x-1) + 2*idx(y+1,x) + idx(y+1,x+1);
        sobelSum += Math.sqrt(gx*gx + gy*gy);
        sobelCount++;
      }
    }
    // Normalize: Sobel magnitude per pixel, max ~1440 (255*sqrt(32)), normalize to 0-1
    const edgeDensity = sobelCount > 0 ? (sobelSum / sobelCount) / 1440 : 0;

    // ── Step 2: Resize to 8x8 for global + quadrant LAB extraction ──
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

    // ── Step 3: Sättigungs-Varianz (Chroma = sqrt(a²+b²) pro Quadrant) ──
    const chromas = [
      Math.sqrt(tl.a**2 + tl.b**2),
      Math.sqrt(tr.a**2 + tr.b**2),
      Math.sqrt(bl.a**2 + bl.b**2),
      Math.sqrt(br.a**2 + br.b**2),
    ];
    const meanChroma = chromas.reduce((s, v) => s + v, 0) / 4;
    const chromaVariance = chromas.reduce((s, v) => s + (v - meanChroma) ** 2, 0) / 4;
    // Normalize chromaVariance: max ~2500 (50² per quadrant), normalize to 0-1
    const chromaVarNorm = Math.min(chromaVariance / 2500, 1);

    // ── Step 4: Pixel-Diversität (wie viele unterschiedliche Graustufen in 16x16) ──
    // Quantize to 16 buckets (0-15), count unique buckets used
    const buckets = new Set<number>();
    for (const g of gray16) buckets.add(Math.floor(g / 16));
    const pixelDiversity = buckets.size / 16; // 0-1, 1 = maximale Diversität

    // ── Step 5: Quadrant-L-Varianz (Helligkeitskontrast zwischen Quadranten) ──
    const quadrantLs = [tl.L, tr.L, bl.L, br.L];
    const meanL = quadrantLs.reduce((s, v) => s + v, 0) / 4;
    const varianceL = quadrantLs.reduce((s, v) => s + (v - meanL) ** 2, 0) / 4;
    // Normalize: max varianceL ~2500 (50²), normalize to 0-1
    const varianceLNorm = Math.min(varianceL / 2500, 1);

    // ── Step 6: Mehrdimensionaler Komplexitäts-Score ──
    // Gewichtung: Edge-Density 50%, Chroma-Varianz 20%, Pixel-Diversität 20%, L-Varianz 10%
    // Rationale:
    //   - Edge-Density: wichtigster Indikator für visuelle Unruhe (Blumen, Tiere, Essen)
    //   - Chroma-Varianz: erkennt bunte, unruhige Tiles (Chamäleon, Regenbogen)
    //   - Pixel-Diversität: erkennt komplexe Strukturen (Steinmuster, Gitter)
    //   - L-Varianz: erkennt starke Hell-Dunkel-Kontraste (Sonnenblume auf Dunkel)
    const complexityScore = (
      edgeDensity * 0.50 +
      chromaVarNorm * 0.20 +
      pixelDiversity * 0.20 +
      varianceLNorm * 0.10
    );
    // Schwellen: calm < 0.18, busy > 0.38 (kalibriert auf Testbilder)
    // Vorher: calm < 80/1240, busy > 400/1240 (LAB-Varianz-basiert, zu grob)
    const tileType: 'calm' | 'medium' | 'busy' = complexityScore < 0.18 ? 'calm' : complexityScore > 0.38 ? 'busy' : 'medium';

    // ── Step 7: Legacy quadrant LAB variance (kept for backward compatibility) ──
    const quadrantAs = [tl.a, tr.a, bl.a, br.a];
    const quadrantBs = [tl.b, tr.b, bl.b, br.b];
    const meanA = quadrantAs.reduce((s, v) => s + v, 0) / 4;
    const meanB = quadrantBs.reduce((s, v) => s + v, 0) / 4;
    const varianceA = quadrantAs.reduce((s, v) => s + (v - meanA) ** 2, 0) / 4;
    const varianceB = quadrantBs.reduce((s, v) => s + (v - meanB) ** 2, 0) / 4;
    void varianceA; void varianceB; // used in legacy code paths only

    // ── Step 8: Blur-Score via Laplacian Variance on 16x16 grayscale ──
    // Laplacian kernel: [0,1,0,1,-4,1,0,1,0]
    // Low variance = blurry (< 100), high = sharp
    let lapSum = 0; let lapCount = 0;
    for (let y = 1; y < 15; y++) {
      for (let x = 1; x < 15; x++) {
        const idx = (r: number, c: number) => gray16[r * 16 + c];
        const lap = idx(y-1,x) + idx(y+1,x) + idx(y,x-1) + idx(y,x+1) - 4 * idx(y,x);
        lapSum += lap * lap;
        lapCount++;
      }
    }
    const blurScore = lapCount > 0 ? lapSum / lapCount : 0; // Laplacian Variance (< 100 = blurry)

    // ── Step 9: pHash (8x8 DCT-like average hash) ──
    // Uses 8x8 downscale of gray16 (take every other pixel)
    const gray8: number[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        gray8.push(gray16[(y*2)*16 + (x*2)]);
      }
    }
    const meanGray = gray8.reduce((s, v) => s + v, 0) / 64;
    let hashBits = '';
    for (const g of gray8) hashBits += g > meanGray ? '1' : '0';
    let pHash = '';
    for (let i = 0; i < 64; i += 4) pHash += parseInt(hashBits.slice(i, i+4), 2).toString(16);

    // Mosaic-Score: Gesamteignung als Tile (0-1)
    // Faktoren: Schärfe (40%), Farbvielfalt/Chroma (30%), Kantendichte (30%)
    const sharpnessScore = Math.min(1, blurScore / 300); // 300+ = sehr scharf
    const chromaScore = Math.min(1, Math.sqrt(global.a * global.a + global.b * global.b) / 40); // Chroma 0-40+
    const edgeScore = Math.min(1, edgeDensity / 0.3); // 0.3+ = gut strukturiert
    const mosaicScore = 0.4 * sharpnessScore + 0.3 * chromaScore + 0.3 * edgeScore;

    return {
      L: global.L, a: global.a, b: global.b,
      tlL: tl.L, tlA: tl.a, tlB: tl.b,
      trL: tr.L, trA: tr.a, trB: tr.b,
      blL: bl.L, blA: bl.a, blB: bl.b,
      brL: br.L, brA: br.a, brB: br.b,
      tileType,
      edgeDensity, // echter Sobel-basierter Kantenwert (0-1)
      blurScore,   // Laplacian Variance (< 100 = unscharf)
      pHash,       // 16-char hex perceptual hash
      mosaicScore, // 0-1 Gesamteignung als Mosaic-Tile
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

    // toLinear und rgbToLab aus colorUtils.ts (keine lokale Duplikation)
    // ── 1. Saturation check (16×16 pixels, LAB chroma) ──
    const SIZE = 16;
    const img16 = await Jimp.fromBuffer(buf);
    img16.resize({ w: SIZE, h: SIZE });
    let chromaSum = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const rgba = img16.getPixelColor(x, y);
        const [, labA, labB] = _rgbToLab((rgba >> 24) & 0xff, (rgba >> 16) & 0xff, (rgba >> 8) & 0xff);
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
    // Calm subjects (sky, water, fog, bokeh) have naturally low edge energy
    // Use very lenient thresholds to avoid over-filtering these critical tiles
    const isCalmSubject = subject === 'calm_nature' || subject === 'calm_monochrome' ||
      subject === 'abstract_smooth' || subject === 'skin_tone';
    // Relaxed thresholds: Gemini does the real quality check, pre-filter only for obvious junk
    const satThreshold = isPortraitSubject ? 0.90 : isCalmSubject ? 0.90 : 0.85;
    const edgeThreshold = isPortraitSubject ? 0.95 : isCalmSubject ? 0.90 : 0.80;  // much more lenient – let Gemini decide
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
      // Count tiles with real quadrant data: tl_l IS NOT NULL AND avg_l IS NOT NULL
      // (grayscale tiles legitimately have tl_a≈0 and tl_b≈0, so we use avg_l presence instead)
      const quadRes = await pool.query(
        "SELECT COUNT(*) FROM mosaic_images WHERE tl_l IS NOT NULL AND avg_l IS NOT NULL"
      );
      const r2Res = await pool.query("SELECT COUNT(*) FROM mosaic_images WHERE r2_url IS NOT NULL");
      const mirrorRes = await pool.query("SELECT COUNT(*) FROM mosaic_images WHERE source_url LIKE '%#mirror'");
      const total = Number(totalRes.rows[0].count);
      const labIndexed = Number(labRes.rows[0].count);
      const quadrantIndexed = Number(quadRes.rows[0].count);
      const r2Count = Number(r2Res.rows[0].count);
      const mirrorCount = Number(mirrorRes.rows[0].count);
      return { total, labIndexed, notIndexed: total - labIndexed, quadrantIndexed, quadrantMissing: total - quadrantIndexed, r2Count, mirrorCount };
    } catch {
      return { total: 0, labIndexed: 0, notIndexed: 0, quadrantIndexed: 0, quadrantMissing: 0, r2Count: 0, mirrorCount: 0 };
    }
  }),

  // Admin: API key status
  getApiKeyStatus: publicProcedure.query(() => {
    return {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      unsplash: !!process.env.UNSPLASH_ACCESS_KEY,
      pexels: !!process.env.PEXELS_API_KEY,
      pixabay: !!process.env.PIXABAY_API_KEY,
      flickr: !!process.env.FLICKR_API_KEY,
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
            WHEN ABS(avg_b) >= ABS(avg_a) AND avg_b < -15 THEN 'blau'
            WHEN ABS(avg_b) >= ABS(avg_a) AND avg_b > 20 THEN 'gelb'
            WHEN ABS(avg_b) >= ABS(avg_a) AND avg_a < -10 AND avg_b < -5 THEN 'cyan'
            WHEN ABS(avg_b) >= ABS(avg_a) AND avg_a < -10 THEN 'gruen'
            WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 20 THEN 'rot'
            WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 AND avg_b < 0 THEN 'violett'
            WHEN ABS(avg_a) > ABS(avg_b) AND avg_a > 10 THEN 'pink'
            WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
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

      // Tile-Type distribution: calm / medium / busy
      const tileTypeRes = await pool.query(`
        SELECT COALESCE(tile_type, 'medium') as tile_type, COUNT(*) as cnt
        FROM mosaic_images
        GROUP BY tile_type
      `);
      const byTileType: Record<string, number> = {};
      for (const row of tileTypeRes.rows) byTileType[row.tile_type] = Number(row.cnt);

      // 3D matrix gaps analysis
      const gapTasks = await analyzeDbGaps(200);
      const topGaps = gapTasks.slice(0, 20).map(t => ({ label: t.label, deficit: t.deficit, query: t.query }));
      return { total, labIndexed, bySource, byColor, byBrightness, bySubject, topGaps, count: total, target: TILE_TARGET,
        byWarmCool, byBrightness5, bySaturation, grayCount, byTileType };
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
  importFromSource: adminProcedure
    .input(z.object({ source: z.enum(["pexels", "unsplash", "pixabay", "flickr"]), count: z.number().min(1).max(5000).default(500), category: z.string().optional() }))
    .mutation(async ({ input }) => {
      const status = getImportStatus(input.source);
      if (status.running) return { started: false, message: "Import läuft bereits" };
      const importSessionId = randomUUID();
      status.running = true; status.startedAt = new Date().toISOString(); status.log = []; status.imported = 0; status.total = input.count; status.error = null; status.sessionId = importSessionId;
      const log = (msg: string) => { status.log.push(msg); if (status.log.length > 200) status.log = status.log.slice(-200); };
      (async () => {
        try {
          const apiKey = input.source === "pexels" ? process.env.PEXELS_API_KEY
            : input.source === "unsplash" ? process.env.UNSPLASH_ACCESS_KEY
            : input.source === "flickr" ? process.env.FLICKR_API_KEY
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
          const perPage = input.source === "pexels" ? 80 : input.source === "pixabay" ? 200 : input.source === "flickr" ? 100 : 30;
          // Unsplash Production API: use ALL keyword arrays for maximum coverage
          if (input.source === "unsplash" && !input.category) {
            const allExtendedKeywords = [
              ...orderedKeywords,
              ...CALM_NATURE_KEYWORDS,
              ...CALM_MONOCHROME_KEYWORDS,
              ...ABSTRACT_LOW_EDGE_KEYWORDS,
              ...SKIN_TONE_KEYWORDS,
              ...HIGH_SAT_KEYWORDS,
              ...LOW_SAT_KEYWORDS,
              ...COOL_KEYWORDS,
              ...EXTREME_DARK_KEYWORDS,
              ...EXTREME_BRIGHT_KEYWORDS,
              ...MEDIUM_SAT_KEYWORDS,
            ];
            orderedKeywords = [...new Set(allExtendedKeywords)];
          }
          const CONCURRENCY = input.source === "unsplash" ? 10 : input.source === "flickr" ? 10 : 5;
          // Unsplash/Flickr Production: iterate pages 1-10 systematically; others: random page 1-5
          const maxPages = input.source === "unsplash" ? 10 : input.source === "flickr" ? 10 : 1;
          let kwIdx = 0;
          outerImport: while (imported < input.count && kwIdx < orderedKeywords.length) {
            const keyword = orderedKeywords[kwIdx++];
            for (let pageLoop = 1; pageLoop <= maxPages; pageLoop++) {
            if (imported >= input.count) break outerImport;
            const page = (input.source === "unsplash" || input.source === "flickr") ? pageLoop : (Math.floor(Math.random() * 5) + 1);
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
              } else if (input.source === "flickr") {
                const res = await fetch(
                  `https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&format=json&nojsoncallback=1&license=1,2,4,5,7,9,10&sort=relevance&content_type=1&safe_search=1&extras=url_m,url_l,url_z`
                );
                if (!res.ok) { log(`⚠️ Flickr ${res.status} for "${keyword}"`); continue; }
                const data = await res.json() as any;
                photos = (data.photos?.photo ?? []).map((p: any) => ({
                  sourceUrl: p.url_l || p.url_z || p.url_m || `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_b.jpg`,
                  tile128Url: p.url_m || `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_m.jpg`,
                })).filter((p: any) => p.tile128Url);
              } else {
                const res = await fetch(
                  `https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&per_page=${perPage}&page=${page}&orientation=squarish`,
                  { headers: { Authorization: `Client-ID ${apiKey}` } }
                );
                if (!res.ok) { log(`⚠️ Unsplash ${res.status} for "${keyword}"`); continue; }
                const data = await res.json() as any;
                photos = (data.results ?? []).map((p: any) => ({
                  sourceUrl: p.urls.regular,
                  tile128Url: p.urls.thumb,
                  photographerName: p.user?.name ?? null,
                  photographerUrl: p.user?.links?.html ? `${p.user.links.html}?utm_source=mosaicprint&utm_medium=referral` : null,
                  downloadLocation: p.links?.download_location ?? null,
                }));
              }
              // Process in parallel for speed
              let batchNew = 0;
              for (let i = 0; i < photos.length; i += CONCURRENCY) {
                const batch = photos.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (photo) => {
                  try {
                    const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                    // Blur-Filter: very lenient (5) to allow smooth/gradient tiles
                    if (lab && lab.blurScore < 5) { return; }
                    const result = await db.insertMosaicImage({ ...photo,
                      avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                      tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                      trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                      blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                      brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                      sourceProvider: input.source,
                      importQuery: keyword,
                      tileType: lab?.tileType,
                      edgeEnergy: lab?.edgeDensity,
                      pHash: lab?.pHash,
                      importSessionId,
                      pendingReview: true,
                    });
                    // Unsplash: trigger download tracking as required by API guidelines
                    if (result.inserted && (photo as any).downloadLocation && apiKey) {
                      fetch((photo as any).downloadLocation, { headers: { Authorization: `Client-ID ${apiKey}` } }).catch(() => {});
                    }
                    if (result.inserted) { imported++; batchNew++; status.imported = imported; }
                  } catch { /* duplicate or error – skip */ }
                }));
              }
              if (batchNew > 0) log(`"${keyword}" p${page}: +${batchNew} neu (${imported}/${input.count})`);
              // Early exit: if page returned 0 new results and we're past page 1, stop paginating
              if (batchNew === 0 && pageLoop >= 2) break;
            } catch (e) { log(`"${keyword}" p${pageLoop} error: ${e}`); }
            } // end for pageLoop
          } // end outerImport
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
    .input(z.object({ source: z.enum(["pexels", "unsplash", "pixabay", "flickr"]).default("pexels") }))
    .query(({ input }) => getImportStatus(input.source)),

  // Admin: Import Preview – returns all pending_review tiles for a session
  getImportPreview: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const pool = (await import('./db.js')).getPool();
      const res = await pool.query(
        `SELECT id, tile128_url, r2_url, source_url, avg_l, avg_a, avg_b, subject, import_query, source_provider
         FROM mosaic_images
         WHERE import_session_id = $1 AND quality_status = 'pending_review'
         ORDER BY id ASC
         LIMIT 2000`,
        [input.sessionId]
      );
      return { tiles: res.rows as Array<{ id: number; tile128_url: string; r2_url: string | null; source_url: string; avg_l: number; avg_a: number; avg_b: number; subject: string; import_query: string; source_provider: string }> };
    }),
  // Admin: Confirm Import – activates selected tiles, deletes rejected ones
  confirmImport: adminProcedure
    .input(z.object({
      sessionId: z.string(),
      rejectedIds: z.array(z.number()), // IDs to delete
    }))
    .mutation(async ({ input }) => {
      const pool = (await import('./db.js')).getPool();
      // Activate all pending_review tiles in this session
      const activateRes = await pool.query(
        `UPDATE mosaic_images SET quality_status = 'pending'
         WHERE import_session_id = $1 AND quality_status = 'pending_review'`,
        [input.sessionId]
      );
      // Delete rejected tiles
      let deleted = 0;
      if (input.rejectedIds.length > 0) {
        const delRes = await pool.query(
          `DELETE FROM mosaic_images WHERE id = ANY($1::int[]) AND import_session_id = $2`,
          [input.rejectedIds, input.sessionId]
        );
        deleted = delRes.rowCount ?? 0;
      }
      const activated = (activateRes.rowCount ?? 0) - deleted;
      return { activated, deleted };
    }),
  // Admin: Smart Import (DB-gap analysis → fills most needed color×brightness buckets first)
  smartImport: adminProcedure
    .input(z.object({
      sourceId: z.enum(["unsplash", "pexels", "pixabay", "flickr"]).default("pexels"),
      count: z.number().min(1).max(5000).default(500),
      targetPerBucket: z.number().min(100).max(2000).default(400),
      // Optional: specific keywords from image analysis (bypasses DB gap analysis)
      keywords: z.array(z.string()).optional(),
      jobLabel: z.string().optional(), // custom label for the job (e.g. "Analyse-Import: Portrait")
    }))
    .mutation(async ({ input }) => {
      const jobKey = input.keywords?.length ? `smart_analysis_${input.sourceId}` : `smart_${input.sourceId}`;
      if (smartImportJobs[jobKey]?.running) return { started: false };
      const smartSessionId = randomUUID();
      smartImportJobs[jobKey] = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, imported: 0, total: input.count, sessionId: smartSessionId };
      const log = (msg: string) => { smartImportJobs[jobKey].log.push(msg); if (smartImportJobs[jobKey].log.length > 500) smartImportJobs[jobKey].log = smartImportJobs[jobKey].log.slice(-500); };
      (async () => {
        try {
          const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY
            : input.sourceId === "pixabay" ? process.env.PIXABAY_API_KEY
            : input.sourceId === "flickr" ? process.env.FLICKR_API_KEY
            : process.env.UNSPLASH_ACCESS_KEY;
          if (!apiKey) { smartImportJobs[jobKey].error = "API key missing"; return; }
          // Track if Unsplash is rate-limited → fall back to Pexels automatically
          let unsplashRateLimited = false;
          let pexelsRateLimited = false;
          let pexelsRateLimitUntil = 0; // timestamp until which Pexels is rate-limited

          // Helper: fetch from Pexels with automatic backoff on 429
          const fetchPexels = async (query: string, perPg: number, key: string): Promise<Array<{sourceUrl: string; tile128Url: string}>> => {
            if (pexelsRateLimited && Date.now() < pexelsRateLimitUntil) return [];
            const res = await fetch(
              `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPg}&orientation=square`,
              { headers: { Authorization: key } }
            );
            if (res.status === 429) {
              const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
              pexelsRateLimited = true;
              pexelsRateLimitUntil = Date.now() + retryAfter * 1000;
              log(`⏳ Pexels 429 – warte ${retryAfter}s (bis ${new Date(pexelsRateLimitUntil).toLocaleTimeString('de-CH')})`);
              return [];
            }
            if (!res.ok) { log(`⚠️ Pexels ${res.status} for "${query}"`); return []; }
            pexelsRateLimited = false;
            const data = await res.json() as any;
            return (data.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small }));
          };

          // Helper: fetch from Pixabay
          const fetchPixabay = async (query: string, perPg: number, key: string): Promise<Array<{sourceUrl: string; tile128Url: string}>> => {
            const res = await fetch(
              `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${perPg}&image_type=photo&safesearch=true&orientation=horizontal`,
              { headers: { Accept: 'application/json' } }
            );
            if (!res.ok) { log(`⚠️ Pixabay ${res.status} for "${query}"`); return []; }
            const data = await res.json() as any;
            return (data.hits ?? []).map((p: any) => ({
              sourceUrl: p.largeImageURL || p.webformatURL || p.previewURL || '',
              tile128Url: p.webformatURL || p.previewURL || '',
            })).filter((p: any) => p.tile128Url);
          };

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
          // Production API limits: Unsplash 5000 req/h, Pexels 200 req/h, Pixabay 100 req/h
          const CONCURRENCY = input.sourceId === "unsplash" ? 20 : 5; // Unsplash Production: 5000 req/h → 20 parallel für maximalen Durchsatz
          const perPage = input.sourceId === "pexels" ? 30 : input.sourceId === "pixabay" ? 200 : 30; // Unsplash max=30 per request

          // BUG FIX: count ist Gesamt-Limit, aber pro Keyword soll ein fairer Anteil importiert werden.
          // Ohne diesen Fix importiert das erste Keyword alle Bilder und die restlichen werden übersprungen.
          const countPerKeyword = tasks.length > 0 ? Math.ceil(input.count / tasks.length) : input.count;
          const keywordImported: Record<string, number> = {};

          for (const task of tasks) {
            if (imported >= input.count) break;
            const maxForThisKeyword = Math.min(countPerKeyword, input.count - imported);
            try {
              let photos: Array<{ sourceUrl: string; tile128Url: string }> = [];
              if (input.sourceId === "pexels") {
                photos = await fetchPexels(task.query, perPage, apiKey);
                // Auto-fallback to Pixabay when Pexels is rate-limited
                if (photos.length === 0 && pexelsRateLimited && process.env.PIXABAY_API_KEY) {
                  log(`🔄 Pexels rate-limited → Pixabay fallback for "${task.query}"`);
                  photos = await fetchPixabay(task.query, 200, process.env.PIXABAY_API_KEY);
                }
                // Also try Unsplash for more variety if available and Pexels returned few results
                if (photos.length < 10 && process.env.UNSPLASH_ACCESS_KEY && !unsplashRateLimited) {
                  try {
                    const uRes = await fetch(
                      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(task.query)}&per_page=30&orientation=squarish`,
                      { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`, Accept: 'application/json' } }
                    );
                    if (uRes.ok) {
                      const uData = await uRes.json() as any;
                      const uPhotos = (uData.results ?? []).map((p: any) => ({
                        sourceUrl: p.urls.regular, tile128Url: p.urls.thumb,
                        downloadLocation: p.links?.download_location ?? null,
                      }));
                      photos.push(...uPhotos);
                      if (uPhotos.length > 0) log(`📸 +${uPhotos.length} Unsplash Fotos für "${task.query}"`);
                    } else if (uRes.status === 429 || uRes.status === 403) {
                      unsplashRateLimited = true;
                    }
                  } catch { /* ignore Unsplash errors */ }
                }
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
              } else if (input.sourceId === "flickr") {
                // Flickr: CC-licensed photos, multi-page, best resolution
                const flickrPerPage = 100;
                const flickrMaxPages = Math.ceil(Math.min(input.count, 500) / flickrPerPage);
                for (let pg = 1; pg <= flickrMaxPages && photos.length < input.count; pg++) {
                  const res = await fetch(
                    `https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(task.query)}&per_page=${flickrPerPage}&page=${pg}&format=json&nojsoncallback=1&license=1,2,4,5,7,9,10&sort=relevance&content_type=1&safe_search=1&extras=url_m,url_l,url_z`
                  );
                  if (!res.ok) { log(`⚠️ Flickr API error ${res.status} for "${task.query}" p${pg}`); break; }
                  const data = await res.json() as any;
                  const pagePhotos = (data.photos?.photo ?? []).map((p: any) => ({
                    sourceUrl: p.url_l || p.url_z || p.url_m || `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_b.jpg`,
                    tile128Url: p.url_m || `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_m.jpg`,
                  })).filter((p: any) => p.tile128Url);
                  photos.push(...pagePhotos);
                  log(`📸 Flickr p${pg}: ${pagePhotos.length} Fotos für "${task.query}"`);
                  if (pagePhotos.length < flickrPerPage) break;
                }
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
                  // Production API: fetch multiple pages (1-10) per keyword to get more variety
                  const maxPages = 10; // 10 pages × 30 = 300 photos per keyword (5000 req/h Production API)
                  for (let pg = 1; pg <= maxPages && !unsplashRateLimited; pg++) {
                    const res = await fetch(
                      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(task.query)}&per_page=${perPage}&page=${pg}&orientation=squarish`,
                      { headers: { Authorization: `Client-ID ${apiKey}` } }
                    );
                    if (!res.ok) {
                      log(`⚠️ Unsplash API error ${res.status} for "${task.query}" p${pg}`);
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
                            photos.push(...(d2.photos ?? []).map((p: any) => ({ sourceUrl: p.src.large, tile128Url: p.src.small })));
                          }
                        }
                      }
                      break;
                    } else {
                      const data = await res.json() as any;
                      const pagePhotos = (data.results ?? []).map((p: any) => ({
                        sourceUrl: p.urls.regular,
                        tile128Url: p.urls.thumb,
                        photographerName: p.user?.name ?? null,
                        photographerUrl: p.user?.links?.html ? `${p.user.links.html}?utm_source=mosaicprint&utm_medium=referral` : null,
                        downloadLocation: p.links?.download_location ?? null,
                      }));
                      photos.push(...pagePhotos);
                      // Stop if last page returned fewer results than requested
                      if (pagePhotos.length < perPage) break;
                    }
                  }
                }
              }

              // Process in parallel batches for speed
              // BUG FIX: limit photos to maxForThisKeyword to ensure all keywords get processed
              const photosToProcess = photos.slice(0, maxForThisKeyword * 3); // 3x buffer to account for rejections
              let batchImported = 0;
              let batchRejected = 0;
              const smartApiKey = process.env.UNSPLASH_ACCESS_KEY;
              for (let i = 0; i < photosToProcess.length; i += CONCURRENCY) {
                // Stop if we've hit the per-keyword limit
                if (batchImported >= maxForThisKeyword) break;
                const batch = photosToProcess.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (photo) => {
                  if (batchImported >= maxForThisKeyword) return; // per-keyword limit reached
                  try {
                    // ── Post-Import Quality Check ──
                    const quality = await checkTileQuality(photo.tile128Url ?? photo.sourceUrl, task.subject);
                    if (quality.rejected) {
                      batchRejected++;
                      return; // discard – too vivid / noisy / watermarked
                    }
                    const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                    // Subject-aware quality thresholds:
                    // Calm/smooth/gradient tiles are INTENTIONALLY low-texture — don't reject them for it
                    const isCalmTarget = ['calm_nature', 'calm_monochrome', 'abstract_smooth', 'skin_tone',
                      'gradient_edge', 'bokeh_gradient', 'pure_sky', 'fog_mist', 'snow_ice',
                      'portrait_nature', 'water_surface'].includes(task.subject);
                    // Blur-Filter: calm tiles can be very smooth (blurScore 5-50 is normal for gradients)
                    const blurThreshold = isCalmTarget ? 5 : 30;
                    if (lab && lab.blurScore < blurThreshold) { batchRejected++; return; }
                    // Mosaic-Score: calm neutral tiles naturally score low (no edges, no chroma)
                    // Only reject truly degenerate tiles (solid single-color with no info)
                    const mosaicThreshold = isCalmTarget ? 0.02 : 0.15;
                    if (lab && typeof lab.mosaicScore === 'number' && lab.mosaicScore < mosaicThreshold) { batchRejected++; return; }
                    // R2 upload is handled automatically by insertMosaicImage (fire-and-forget)
                    const result = await db.insertMosaicImage({ ...photo,
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
                      edgeEnergy: lab?.edgeDensity,
                      pHash: lab?.pHash,
                      mosaicScore: lab?.mosaicScore,
                      importSessionId: smartSessionId,
                      pendingReview: true,
                    });
                    // Unsplash: trigger download tracking as required by API guidelines
                    if (result.inserted && (photo as any).downloadLocation && smartApiKey) {
                      fetch((photo as any).downloadLocation, { headers: { Authorization: `Client-ID ${smartApiKey}` } }).catch(() => {});
                    }
                    if (result.inserted) { imported++; batchImported++; smartImportJobs[jobKey].imported = imported; }
                  } catch { /* skip duplicates / errors */ }
                }));
              }
              keywordImported[task.query] = batchImported;
              if (batchImported > 0 || batchRejected > 0) {
                log(`✓ [${task.label}] "${task.query}": +${batchImported} importiert, ${batchRejected} abgelehnt (deficit: ${task.deficit})`);
              } else {
                log(`⚠️ "${task.query}": 0 importiert (${photos.length} Fotos gefunden, alle abgelehnt oder Duplikate)`);
              }
            } catch (e) { log(`✗ "${task.query}" error: ${e}`); }
          }
          log(`✅ Smart Import fertig: ${imported} neue Bilder importiert`);
          smartImportJobs[jobKey].finishedAt = new Date().toISOString();

          // ── Import-Bericht erstellen ──
          try {
            const pool = db.getPool();
            const totalRes = await pool.query('SELECT COUNT(*) FROM mosaic_images');
            const totalTiles = Number(totalRes.rows[0].count);
            // Gather per-keyword stats from log
            const keywordStats: Array<{query: string; imported: number; rejected: number}> = [];
            for (const line of smartImportJobs[jobKey].log) {
              const m = line.match(/"([^"]+)":\s\+(\d+) importiert,\s(\d+) abgelehnt/);
              if (m) keywordStats.push({ query: m[1], imported: Number(m[2]), rejected: Number(m[3]) });
            }
            const report = {
              timestamp: new Date().toISOString(),
              jobKey,
              source: input.sourceId,
              duration: smartImportJobs[jobKey].finishedAt && smartImportJobs[jobKey].startedAt
                ? Math.round((new Date(smartImportJobs[jobKey].finishedAt!).getTime() - new Date(smartImportJobs[jobKey].startedAt!).getTime()) / 1000)
                : null,
              imported,
              totalTilesAfter: totalTiles,
              pexelsRateLimited,
              keywordStats: keywordStats.sort((a, b) => b.imported - a.imported),
              topImported: keywordStats.filter(k => k.imported > 0).slice(0, 10),
              log: smartImportJobs[jobKey].log.slice(-50),
            };
            // Store report in job status for retrieval
            (smartImportJobs[jobKey] as any).report = report;
            log(`📊 Bericht erstellt: ${keywordStats.length} Keywords, ${imported} importiert, ${totalTiles} total`);
          } catch (e) { log(`⚠️ Bericht-Fehler: ${e}`); }

        } catch (e: unknown) {
          smartImportJobs[jobKey].error = e instanceof Error ? e.message : String(e);
        } finally {
          smartImportJobs[jobKey].running = false;
        }
      })();
      return { started: true, jobKey };
    }),

  // Admin: Smart Import status
  getSmartImportStatus: adminProcedure
    .input(z.object({ sourceId: z.enum(["unsplash", "pexels", "pixabay", "flickr"]).default("pexels"), isAnalysis: z.boolean().optional() }))
    .query(({ input }) => {
      const jobKey = input.isAnalysis ? `smart_analysis_${input.sourceId}` : `smart_${input.sourceId}`;
      const job = smartImportJobs[jobKey] ?? { running: false, log: [], startedAt: null, finishedAt: null, error: null, imported: 0, total: 0 };
      return { ...job, report: (job as any).report ?? null };
    }),

  // Admin: Get last import report (JSON download)
  getLastImportReport: adminProcedure
    .input(z.object({ sourceId: z.enum(["unsplash", "pexels", "pixabay", "flickr"]).default("pexels"), isAnalysis: z.boolean().optional() }))
    .query(({ input }) => {
      const jobKey = input.isAnalysis ? `smart_analysis_${input.sourceId}` : `smart_${input.sourceId}`;
      const job = smartImportJobs[jobKey];
      if (!job) return null;
      return (job as any).report ?? null;
    }),

  // Admin: Get import recommendations from analyzeDbGaps
  // Returns the top-N tasks sorted by priority for display in the UI
  getImportRecommendations: adminProcedure
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

  // Admin: Get top import keywords from excellent-rated images
  // Groups by import_query, counts occurrences, returns sorted by frequency
  getExcellentKeywords: adminProcedure
    .input(z.object({
      limit: z.number().min(5).max(100).default(30),
      minCount: z.number().min(1).max(50).default(2), // minimum images per keyword
    }))
    .query(async ({ input }) => {
      const pool = db.getPool();
      const res = await pool.query(`
        SELECT
          import_query AS keyword,
          COUNT(*) AS count,
          ROUND(AVG(ai_mosaic_score)::numeric, 1) AS avg_score,
          ROUND(AVG(SQRT(avg_a * avg_a + avg_b * avg_b))::numeric, 1) AS avg_chroma
        FROM mosaic_images
        WHERE ai_suitability = 'excellent'
          AND import_query IS NOT NULL
          AND import_query != ''
        GROUP BY import_query
        HAVING COUNT(*) >= $1
        ORDER BY COUNT(*) DESC
        LIMIT $2
      `, [input.minCount, input.limit]);
      return {
        keywords: res.rows.map((r: any) => ({
          keyword: r.keyword as string,
          count: Number(r.count),
          avgScore: Number(r.avg_score),
          avgChroma: Number(r.avg_chroma),
        })),
        totalExcellent: await pool.query(`SELECT COUNT(*) FROM mosaic_images WHERE ai_suitability = 'excellent' AND import_query IS NOT NULL`).then(r => Number(r.rows[0].count)),
      };
    }),

  // Admin: Import All Sources simultaneously (Pexels + Unsplash in parallel)
  // This starts both importFromSource jobs at the same time for maximum throughput
  importAll: adminProcedure
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
        const importAllSessionId = randomUUID();
        status.running = true;
        status.startedAt = new Date().toISOString();
        status.log = [];
        status.imported = 0;
        status.total = input.count;
        status.error = null;
        status.sessionId = importAllSessionId;
        const log = (msg: string) => { status.log.push(msg); if (status.log.length > 200) status.log = status.log.slice(-200); };
        results[source] = true;
        // Fire-and-forget background job (same logic as importFromSource)
        (async (src: 'pexels' | 'unsplash' | 'pixabay') => {
          try {
            const apiKey = src === 'pexels' ? process.env.PEXELS_API_KEY!
              : src === 'pixabay' ? process.env.PIXABAY_API_KEY!
              : process.env.UNSPLASH_ACCESS_KEY!;
            let imported = 0;
            // Build comprehensive keyword list from ALL available keyword arrays
            const allKeywords = [
              ...SUBJECT_KEYWORDS,
              ...Object.values(COLOR_BRIGHTNESS_KEYWORDS).flatMap(b => Object.values(b).flat()),
              ...CALM_NATURE_KEYWORDS,
              ...CALM_MONOCHROME_KEYWORDS,
              ...ABSTRACT_LOW_EDGE_KEYWORDS,
              ...SKIN_TONE_KEYWORDS,
              ...HIGH_SAT_KEYWORDS,
              ...LOW_SAT_KEYWORDS,
              ...COOL_KEYWORDS,
              ...EXTREME_DARK_KEYWORDS,
              ...EXTREME_BRIGHT_KEYWORDS,
              ...MEDIUM_SAT_KEYWORDS,
            ];
            // Deduplicate keywords
            const uniqueKeywords = [...new Set(allKeywords)];
            const shuffled = uniqueKeywords.sort(() => Math.random() - 0.5);
            const perPage = src === 'pexels' ? 80 : src === 'pixabay' ? 200 : 30;
            // For Unsplash Production API (5000 req/h): systematically iterate pages 1-10
            // This ensures we get ALL available images, not just random pages
            const maxPages = src === 'unsplash' ? 10 : 5;
            const CONCURRENCY = src === 'unsplash' ? 10 : 5;
            let kwIdx = 0;
            outerLoop: while (imported < input.count && kwIdx < shuffled.length) {
              const keyword = shuffled[kwIdx++];
              // Iterate all pages systematically instead of random page
              for (let page = 1; page <= maxPages; page++) {
                if (imported >= input.count) break outerLoop;
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
                  photos = (data.results ?? []).map((p: any) => ({
                    sourceUrl: p.urls.regular,
                    tile128Url: p.urls.thumb,
                    photographerName: p.user?.name ?? null,
                    photographerUrl: p.user?.links?.html ? `${p.user.links.html}?utm_source=mosaicprint&utm_medium=referral` : null,
                    downloadLocation: p.links?.download_location ?? null,
                  }));
                }
                let batchNew = 0;
                for (let i = 0; i < photos.length; i += CONCURRENCY) {
                  const batch = photos.slice(i, i + CONCURRENCY);
                  await Promise.all(batch.map(async (photo) => {
                    try {
                      const lab = await computeLabForUrl(photo.tile128Url ?? photo.sourceUrl);
                      const result = await db.insertMosaicImage({ ...photo,
                        avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                        sourceProvider: src,
                        importQuery: keyword,
                        importSessionId: importAllSessionId,
                        pendingReview: true,
                      });
                      // Unsplash: trigger download tracking
                      if (result.inserted && (photo as any).downloadLocation && apiKey) {
                        fetch((photo as any).downloadLocation, { headers: { Authorization: `Client-ID ${apiKey}` } }).catch(() => {});
                      }
                      if (result.inserted) { imported++; batchNew++; status.imported = imported; }
                    } catch { /* duplicate – skip */ }
                  }));
                }
                if (batchNew > 0) log(`[${src}] "${keyword}" p${page}: +${batchNew} (${imported}/${input.count})`);
                // If page returned 0 new results, stop paginating this keyword early
                if (batchNew === 0 && page >= 2) break;
              } catch { /* skip page */ }
              } // end for page loop
            } // end outerLoop
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
  rebuildTileIndex: adminProcedure.mutation(async () => {
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
                  br_l=$13, br_a=$14, br_b=$15,
                  tile_type=$17, edge_energy=$18
                WHERE id=$16`,
                [lab.L, lab.a, lab.b,
                 lab.tlL, lab.tlA, lab.tlB,
                 lab.trL, lab.trA, lab.trB,
                 lab.blL, lab.blA, lab.blB,
                 lab.brL, lab.brA, lab.brB,
                 row.id, lab.tileType, lab.edgeDensity]
              );
              indexed++;
            }
          }));
          if (i % 200 === 0) log(`${indexed}/${res.rows.length} indexiert...`);
        }
        log(`✅ Fertig: ${indexed} Bilder reindexiert (inkl. Quadrant-LAB + edge_energy)`);
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
  getRebuildStatus: adminProcedure.query(() => rebuildJobStatus),

  // Admin: indexLabColors – alias for rebuildTileIndex (called by Admin panel "LAB indexieren" button)
  // Backfills quadrant LAB for ALL tiles (critical for 15D matching quality)
  indexLabColors: adminProcedure.mutation(async () => {
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
           AND (
             -- Default neutral values (new tiles without quadrant data)
             (tl_l = 50 AND tl_a = 0 AND tl_b = 0 AND tr_a = 0 AND tr_b = 0)
             OR
             -- Old bug: quadrant values copied from global avg (all 4 identical to avg)
             (ABS(tl_l - avg_l) < 0.01 AND ABS(tl_a - avg_a) < 0.01 AND ABS(tl_b - avg_b) < 0.01
              AND ABS(tr_l - avg_l) < 0.01 AND ABS(tr_a - avg_a) < 0.01 AND ABS(tr_b - avg_b) < 0.01
              AND ABS(bl_l - avg_l) < 0.01 AND ABS(bl_a - avg_a) < 0.01 AND ABS(bl_b - avg_b) < 0.01
              AND ABS(br_l - avg_l) < 0.01 AND ABS(br_a - avg_a) < 0.01 AND ABS(br_b - avg_b) < 0.01)
           )`
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
                  br_l=$13, br_a=$14, br_b=$15,
                  tile_type=$17, edge_energy=$18
                WHERE id=$16`,
                [lab.L, lab.a, lab.b,
                 lab.tlL, lab.tlA, lab.tlB,
                 lab.trL, lab.trA, lab.trB,
                 lab.blL, lab.blA, lab.blB,
                 lab.brL, lab.brA, lab.brB,
                 row.id, lab.tileType, lab.edgeDensity]
              );
              totalIndexed++;
            }
          }));
          if (i % 500 === 0) log(`${totalIndexed}/${res.rows.length} Quadrant-LAB berechnet...`);
        }
        log(`✅ Backfill fertig: ${totalIndexed} Tiles mit Quadrant-LAB + edge_energy aktualisiert`);
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

  // Admin: batchReclassifyTileTypes – reclassify ALL tiles using the new multi-dimensional score
  // Uses Sobel edge density + chroma variance + pixel diversity + L-variance
  // This replaces the old LAB-quadrant-variance-only classification
  batchReclassifyTileTypes: adminProcedure.mutation(async () => {
    if (rebuildJobStatus.running) return { started: false, message: 'Ein Job läuft bereits' };
    rebuildJobStatus = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    const log = (msg: string) => { rebuildJobStatus.log.push(msg); if (rebuildJobStatus.log.length > 300) rebuildJobStatus.log = rebuildJobStatus.log.slice(-300); };
    (async () => {
      try {
        const pool = db.getPool();
        const res = await pool.query(
          `SELECT id, tile128_url FROM mosaic_images WHERE tile128_url IS NOT NULL ORDER BY id`
        );
        log(`🔄 Starte Reklassifizierung: ${res.rows.length} Tiles`);
        let calm = 0, medium = 0, busy = 0, errors = 0;
        const CONCURRENCY = 6;
        for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
          const batch = res.rows.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (row: any) => {
            try {
              const lab = await computeLabFull(row.tile128_url);
              if (lab) {
                await pool.query(
                  `UPDATE mosaic_images SET tile_type=$1, edge_energy=$3 WHERE id=$2`,
                  [lab.tileType, row.id, lab.edgeDensity]
                );
                if (lab.tileType === 'calm') calm++;
                else if (lab.tileType === 'busy') busy++;
                else medium++;
              } else { errors++; }
            } catch { errors++; }
          }));
          if (i % 1000 === 0 && i > 0) {
            const done = i + CONCURRENCY;
            log(`${done}/${res.rows.length} – 🌫️ ${calm} ruhig / 🎨 ${medium} normal / 🌀 ${busy} komplex`);
          }
        }
        log(`✅ Reklassifizierung abgeschlossen: 🌫️ ${calm} ruhig / 🎨 ${medium} normal / 🌀 ${busy} komplex / ❌ ${errors} Fehler`);
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

  // Admin: Get images with filters
  getAdminImages: adminProcedure
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
  getAllTilesForPdf: adminProcedure
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
  deleteMosaicImage: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => db.deleteMosaicImage(input.id)),

  // Admin: Alle Tiles einer Quelle löschen
  deleteBySource: adminProcedure
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
  getColorDistribution: adminProcedure.query(async () => {
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
  exportSeed: adminProcedure.mutation(async () => {
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
  serverExport: adminProcedure
    .input(z.object({ tiles: z.array(z.object({ url: z.string(), col: z.number(), row: z.number() })), cols: z.number(), rows: z.number(), tilePx: z.number(), overlayBase64: z.string().optional(), overlayAlpha: z.number().optional(), formatLabel: z.string() }))
    .mutation(async ({ input }) => {
      const buf = await renderMosaicOnServer({ tiles: input.tiles as TileData[], cols: input.cols, rows: input.rows, tilePx: input.tilePx, overlayBase64: input.overlayBase64, overlayAlpha: input.overlayAlpha });
      const base64 = buf.toString("base64");
      return { base64, mimeType: "image/png" };
    }),

  // Targeted import: import images for a specific search query
  targetedImport: adminProcedure
    .input(z.object({
      sourceId: z.enum(["unsplash", "pexels", "pixabay", "flickr"]).default("pexels"),
      query: z.string().min(1).max(200),
      count: z.number().min(10).max(5000).default(100),
      sessionId: z.string().optional(), // optional: group into a multi-keyword session
    }))
    .mutation(async ({ input }) => {
      const jobKey = `targeted_${input.sourceId}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const apiKey = input.sourceId === "pexels" ? process.env.PEXELS_API_KEY
        : input.sourceId === "pixabay" ? process.env.PIXABAY_API_KEY
        : input.sourceId === "flickr" ? process.env.FLICKR_API_KEY
        : process.env.UNSPLASH_ACCESS_KEY;
      if (!apiKey) return { started: false, error: "API key missing" };
      // Init job tracking
      // Use client-provided sessionId as the DB import_session_id so getImportPreview can find the tiles
      const targetedSessionId = input.sessionId ?? randomUUID();
      targetedImportJobs[jobKey] = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, imported: 0, total: input.count, query: input.query, sourceId: input.sourceId, sessionId: targetedSessionId };
      // Register in session if provided
      if (input.sessionId && keywordSessions[input.sessionId]) {
        keywordSessions[input.sessionId].results.push({ keyword: input.query, imported: 0, rejected: 0, total: 0, status: 'running' });
      }
      // Run in background
      (async () => {
        try {
          const perPage = Math.min(input.count, input.sourceId === "pexels" ? 80 : input.sourceId === "pixabay" ? 200 : input.sourceId === "flickr" ? 100 : 30);
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
                sourceUrl: p.largeImageURL || p.webformatURL || p.previewURL || '',
                tile128Url: p.webformatURL || p.previewURL || '',
              })).filter((p: any) => p.tile128Url);
            }
          } else if (input.sourceId === "flickr") {
            // Flickr: 100/page, CC-licensed photos only, multi-page
            const flickrPerPage = 100;
            const flickrMaxPages = Math.ceil(input.count / flickrPerPage);
            for (let pg = 1; pg <= flickrMaxPages && photos.length < input.count; pg++) {
              const res = await fetch(
                `https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key=${encodeURIComponent(apiKey!)}&text=${encodeURIComponent(input.query)}&per_page=${flickrPerPage}&page=${pg}&format=json&nojsoncallback=1&license=1,2,4,5,7,9,10&sort=relevance&content_type=1&safe_search=1&extras=url_m,url_l,url_z`
              );
              if (!res.ok) break;
              const data = await res.json() as any;
              const pagePhotos = (data.photos?.photo ?? []).map((p: any) => ({
                sourceUrl: p.url_l || p.url_z || p.url_m || `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_b.jpg`,
                tile128Url: p.url_m || `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_m.jpg`,
              })).filter((p: any) => p.tile128Url);
              photos.push(...pagePhotos);
              if (pagePhotos.length < flickrPerPage) break;
            }
          } else {
            // Unsplash: fetch multiple pages to reach requested count (max 30/page)
            const unsplashPerPage = 30;
            const maxPages = Math.ceil(input.count / unsplashPerPage);
            for (let pg = 1; pg <= maxPages && photos.length < input.count; pg++) {
              const res = await fetch(
                `https://api.unsplash.com/search/photos?query=${encodeURIComponent(input.query)}&per_page=${unsplashPerPage}&page=${pg}&orientation=squarish`,
                { headers: { Authorization: `Client-ID ${apiKey}` } }
              );
              if (!res.ok) {
                if (res.status === 403 || res.status === 429) break; // rate limit
                break;
              }
              const data = await res.json() as any;
              const pagePhotos = (data.results ?? []).map((p: any) => ({
                sourceUrl: p.urls.regular,
                tile128Url: p.urls.thumb,
                photographerName: p.user?.name ?? null,
                photographerUrl: p.user?.links?.html ? `${p.user.links.html}?utm_source=mosaicprint&utm_medium=referral` : null,
                downloadLocation: p.links?.download_location ?? null,
              }));
              photos.push(...pagePhotos);
              if (pagePhotos.length < unsplashPerPage) break; // last page
            }
          }
          // Process photos and track actual imported count
          let imported = 0; let rejected = 0;
          const CONCURRENCY = 3;
          const targetedApiKey = process.env.UNSPLASH_ACCESS_KEY;
          console.log(`[targetedImport] Processing ${photos.length} photos from ${input.sourceId} (query: ${input.query})`);
          for (let i = 0; i < photos.length; i += CONCURRENCY) {
            const batch = photos.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (photo) => {
              try {
                const labUrl = photo.tile128Url ?? photo.sourceUrl;
                const lab = await computeLabFull(labUrl);
                if (!lab) {
                  console.warn(`[targetedImport] computeLabFull null for ${labUrl.slice(0,100)}`);
                }
                // Blur-Filter: very lenient to allow smooth/gradient tiles through
                if (lab && lab.blurScore < 5) { rejected++; return; }
                const result = await db.insertMosaicImage({ ...photo,
                  avgL: lab?.L ?? 50, avgA: lab?.a ?? 0, avgB: lab?.b ?? 0,
                  tlL: lab?.tlL, tlA: lab?.tlA, tlB: lab?.tlB,
                  trL: lab?.trL, trA: lab?.trA, trB: lab?.trB,
                  blL: lab?.blL, blA: lab?.blA, blB: lab?.blB,
                  brL: lab?.brL, brA: lab?.brA, brB: lab?.brB,
                  tileType: lab?.tileType,
                  edgeEnergy: lab?.edgeDensity,
                  pHash: lab?.pHash,
                  sourceProvider: input.sourceId, // explicitly set provider
                  importQuery: input.query,
                  importSessionId: targetedSessionId,
                  pendingReview: true,
                });
                // Unsplash: trigger download tracking
                if (result?.inserted && (photo as any).downloadLocation && targetedApiKey) {
                  fetch((photo as any).downloadLocation, { headers: { Authorization: `Client-ID ${targetedApiKey}` } }).catch(() => {});
                }
                if (result?.inserted) { imported++; } else { rejected++; }
              } catch (err) {
                console.error(`[targetedImport] error processing photo from ${input.sourceId}:`, String(err).slice(0,200));
                rejected++;
              }
            }));
            targetedImportJobs[jobKey].imported = imported;
          }
          targetedImportJobs[jobKey].running = false;
          targetedImportJobs[jobKey].finishedAt = new Date().toISOString();
          targetedImportJobs[jobKey].imported = imported;
          // Update session
          if (input.sessionId && keywordSessions[input.sessionId]) {
            const sess = keywordSessions[input.sessionId];
            const idx = sess.results.findIndex(r => r.keyword === input.query && r.status === 'running');
            if (idx >= 0) sess.results[idx] = { keyword: input.query, imported, rejected, total: photos.length, status: 'done' };
            sess.totalImported = sess.results.reduce((s, r) => s + r.imported, 0);
            const allDone = sess.results.every(r => r.status !== 'running');
            if (allDone) sess.finishedAt = new Date().toISOString();
          }
        } catch (e) {
          console.error('[targetedImport error]', e);
          targetedImportJobs[jobKey].running = false;
          targetedImportJobs[jobKey].error = String(e);
          if (input.sessionId && keywordSessions[input.sessionId]) {
            const sess = keywordSessions[input.sessionId];
            const idx = sess.results.findIndex(r => r.keyword === input.query && r.status === 'running');
            if (idx >= 0) sess.results[idx].status = 'error';
          }
        }
      })();
      return { started: true, query: input.query, jobKey };
    }),

  // Create a keyword import session (groups multiple targetedImport calls)
  createKeywordSession: adminProcedure
    .input(z.object({
      sessionId: z.string(),
      keywords: z.array(z.string()),
      source: z.string(),
    }))
    .mutation(async ({ input }) => {
      // Get current tile count before import
      let totalBefore = 0;
      try {
        const _pool = db.getPool();
        const res = await _pool.query("SELECT COUNT(*) as cnt FROM mosaic_images");
        totalBefore = Number(res.rows[0]?.cnt ?? 0);
      } catch {}
      keywordSessions[input.sessionId] = {
        sessionId: input.sessionId,
        keywords: input.keywords,
        source: input.source,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        results: [],
        totalImported: 0,
        totalBefore,
        totalAfter: 0,
      };
      return { ok: true, sessionId: input.sessionId };
    }),

  // Get keyword session status and results
  getKeywordSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const sess = keywordSessions[input.sessionId];
      if (!sess) return null;
      // If all done, get current tile count
      if (sess.finishedAt && sess.totalAfter === 0) {
        try {
          const _pool = db.getPool();
          const res = await _pool.query("SELECT COUNT(*) as cnt FROM mosaic_images");
          sess.totalAfter = Number(res.rows[0]?.cnt ?? 0);
        } catch {}
      }
      return sess;
    }),

  // Upload tile image
  uploadTileImage: adminProcedure
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
        edgeEnergy: lab?.edgeDensity,
        pHash: lab?.pHash,
      });
      return { ok: true };
    }),

  // ── Mirror Tiles: create horizontally flipped copies of all tiles ──────────
  // This effectively doubles the tile pool without downloading new images.
  // Mirrored tiles get swapped quadrant LAB values (TL↔TR, BL↔BR).
  mirrorTiles: adminProcedure
    .input(z.object({
      batchSize: z.number().default(500),  // tiles per batch
      dryRun: z.boolean().default(false),  // if true, only count without inserting
    }))
    .mutation(async ({ input }) => {
      const pool = db.getPool();
      // Get tiles that don't have a mirrored version yet
      // Use LEFT JOIN to find originals without a mirror counterpart
      const countRes = await pool.query(`
        SELECT COUNT(*) as total FROM mosaic_images orig
        WHERE orig.source_url NOT LIKE '%#mirror'
        AND orig.avg_l IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM mosaic_images m
          WHERE m.source_url = orig.source_url || '#mirror'
        )
      `);
      const total = Number(countRes.rows[0].total);
      if (input.dryRun) {
        return { dryRun: true, eligible: total, wouldCreate: total };
      }
      // Check how many mirrors already exist
      const existingRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images WHERE source_url LIKE '%#mirror'`);
      const existingMirrors = Number(existingRes.rows[0].cnt);
      // Process in batches - only tiles without mirror
      let inserted = 0; let skipped = 0;
      const limit = Math.min(input.batchSize, 2000);
      const rows = await pool.query(`
        SELECT orig.id, orig.source_url, orig.tile128_url, orig.r2_url, orig.avg_l, orig.avg_a, orig.avg_b,
          orig.tl_l, orig.tl_a, orig.tl_b, orig.tr_l, orig.tr_a, orig.tr_b,
          orig.bl_l, orig.bl_a, orig.bl_b, orig.br_l, orig.br_a, orig.br_b,
          orig.theme, orig.source_provider, orig.import_query, orig.tile_type, orig.edge_energy, orig.phash
        FROM mosaic_images orig
        WHERE orig.source_url NOT LIKE '%#mirror'
        AND orig.avg_l IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM mosaic_images m
          WHERE m.source_url = orig.source_url || '#mirror'
        )
        ORDER BY orig.id ASC
        LIMIT $1
      `, [limit]);
      for (const row of rows.rows) {
        const mirrorUrl = row.source_url + '#mirror';
        // Swap TL↔TR and BL↔BR for horizontal mirror
        // Original:  TL | TR      Mirror:  TR | TL
        //            BL | BR               BR | BL
        const mirrorPhash = row.phash ? row.phash + 'm' : null;
        try {
          const res = await pool.query(
            `INSERT INTO mosaic_images
               (source_url, tile128_url, r2_url, avg_l, avg_a, avg_b,
                tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
                bl_l, bl_a, bl_b, br_l, br_a, br_b,
                subject, theme, source_provider, import_query, url_hash,
                imported_at, tile_type, edge_energy, phash)
             VALUES ($1,$2,$3,$4,$5,$6,
                $7,$8,$9,   $10,$11,$12,
                $13,$14,$15, $16,$17,$18,
                $19,$19,$20,$21,MD5($1),NOW(),$22,$23,$24)
             ON CONFLICT (source_url) DO NOTHING
             RETURNING id`,
            [
              mirrorUrl,                    // $1  source_url
              row.tile128_url,              // $2  tile128_url (same image, only LAB swapped)
              row.r2_url,                   // $3  r2_url
              row.avg_l, row.avg_a, row.avg_b, // $4,$5,$6  global LAB unchanged
              // TL gets TR values (horizontal mirror: left becomes right)
              row.tr_l, row.tr_a, row.tr_b, // $7,$8,$9   new TL = original TR
              // TR gets TL values
              row.tl_l, row.tl_a, row.tl_b, // $10,$11,$12  new TR = original TL
              // BL gets BR values
              row.br_l, row.br_a, row.br_b, // $13,$14,$15  new BL = original BR
              // BR gets BL values
              row.bl_l, row.bl_a, row.bl_b, // $16,$17,$18  new BR = original BL
              row.theme,                    // $19 subject/theme
              row.source_provider,          // $20
              row.import_query,             // $21
              row.tile_type,                // $22
              row.edge_energy,              // $23
              mirrorPhash,                  // $24
            ]
          );
          if ((res.rowCount ?? 0) > 0) inserted++; else skipped++;
        } catch { skipped++; }
      }
      return { inserted, skipped, existingMirrors, eligible: total, processed: rows.rows.length };
    }),

  // ── QA: Run quality check ──────────────────────────────────────────────────
  runQualityCheck: adminProcedure
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

  saveAlgorithmProfile: adminProcedure
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
  getAdminImagesFiltered: adminProcedure
    .input(z.object({
      page: z.number().default(1),
      limit: z.number().default(50),
      brightnessFilter: z.string().optional(),
      colorFilter: z.string().optional(),
      warmCoolFilter: z.string().optional(), // 'warm' | 'kuehl' | 'neutral'
      saturationFilter: z.string().optional(), // 'niedrig' | 'mittel' | 'hoch'
      geminiFilter: z.string().optional(), // 'excellent' | 'good' | 'poor' | 'reject'
      sourceId: z.string().optional(),
      importedSince: z.string().optional(), // ISO date string, or 'last-import' for last session
      qualityStatus: z.string().optional(),
      semanticTheme: z.string().optional(),
      tileType: z.string().optional(),
    }))
    .query(async ({ input }) => {
      let importedSince = input.importedSince;
      // Resolve 'last-import' to the startedAt of the most recent keyword session
      if (importedSince === 'last-import') {
        const sessions = Object.values(keywordSessions).sort((a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        );
        importedSince = sessions.length > 0 ? sessions[0].startedAt : undefined;
        // Fallback: if no session, use last 1 hour
        if (!importedSince) {
          importedSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        }
      } else if (importedSince === '24h') {
        importedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      } else if (importedSince === '7d') {
        importedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (importedSince === '30d') {
        importedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      }
      return db.getAdminImages({
        page: input.page,
        limit: input.limit,
        brightnessFilter: input.brightnessFilter,
        colorFilter: input.colorFilter,
        warmCoolFilter: input.warmCoolFilter,
        saturationFilter: input.saturationFilter,
        sourceId: input.sourceId,
        importedSince,
        qualityStatus: input.qualityStatus,
        semanticTheme: input.semanticTheme,
        tileType: input.tileType,
        geminiFilter: input.geminiFilter,
      });
    }),

  // ── Image Categories ────────────────────────────────────────────────────────────
  getImageCategories: publicProcedure
    .query(async () => {
      return await db.getImageCategories();
    }),

  saveImageCategoryAlgoSettings: adminProcedure
    .input(z.object({
      categoryName: z.string(),
      algoSettings: z.record(z.unknown()),
    }))
    .mutation(async ({ input }) => {
      await db.saveImageCategoryAlgoSettings(input.categoryName, input.algoSettings);
      return { ok: true };
    }),

  upsertImageCategory: adminProcedure
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
  analyzeTestImage: adminProcedure
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
          // Qualitätsgewichtete Verfügbarkeit: exzellente Tiles zählen mehr
          const available = nearby.reduce((s: number, p: {count: number; qualityCount?: number}) =>
            s + (p.qualityCount ?? p.count), 0);
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
          if (keywordSuggestions.length >= 8) break;
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
        keywordSuggestions: uniqueKeywords.slice(0, isPortrait ? 8 : 10),
        poolSize: poolStats.reduce((s: number, p: {count: number}) => s + p.count, 0),
      };
    }),

  // ── Auto-Learn: Start cycle ────────────────────────────────────────────────
  startAutoLearnCycle: adminProcedure
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
          // Snapshot: Vorher-Stats
          const alPool2 = db.getPool();
          const beforeStats = await alPool2.query(`
            SELECT COUNT(*) as total,
              SUM(CASE WHEN quality_status='rejected' THEN 1 ELSE 0 END) as rejected,
              SUM(CASE WHEN avg_l IS NULL OR (avg_l=50 AND avg_a=0 AND avg_b=0) THEN 1 ELSE 0 END) as unindexed,
              AVG(quality_score) as avg_quality,
              SUM(CASE WHEN semantic_theme='portrait_medium_skin' THEN 1 ELSE 0 END) as portrait_medium_skin,
              SUM(CASE WHEN semantic_theme='city_night' THEN 1 ELSE 0 END) as city_night,
              SUM(CASE WHEN semantic_theme='nature_forest' THEN 1 ELSE 0 END) as nature_forest,
              SUM(CASE WHEN semantic_theme='nature_sunset' THEN 1 ELSE 0 END) as nature_sunset
            FROM mosaic_images
          `);
          const bs = beforeStats.rows[0];
          const beforeTotal = Number(bs.total);
          await addStep('snapshot-before', 'done',
            `Vorher: ${beforeTotal.toLocaleString('de-CH')} Tiles | portrait_medium_skin: ${Math.round(Number(bs.portrait_medium_skin)/beforeTotal*100)}% | city_night: ${Math.round(Number(bs.city_night)/beforeTotal*100)}% | Ø Qualität: ${Number(bs.avg_quality).toFixed(1)}`);
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
          const gapSummary = alTasks.slice(0, 5).map((t: {label: string; deficit: number}) => `${t.label}(-${t.deficit})`).join(', ');
          await addStep('gap-analysis', 'done', `${alTasks.length} Import-Tasks | Top-Lücken: ${gapSummary}`);
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
                      // Unsplash: Multi-Page-Fetch (max 30/Seite)
                      const alMaxPages = Math.ceil(input.importCount / 30);
                      for (let alPg = 1; alPg <= alMaxPages && alPhotos.length < input.importCount; alPg++) {
                        const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(task.query)}&per_page=30&page=${alPg}&orientation=squarish`, { headers: { Authorization: `Client-ID ${alApiKey}` } });
                        if (!res.ok) break;
                        const data = await res.json() as any;
                        const pg = (data.results ?? []).map((p: any) => ({ sourceUrl: p.urls.regular, tile128Url: p.urls.thumb, downloadLocation: p.links?.download_location ?? null }));
                        alPhotos.push(...pg);
                        if (pg.length < 30) break;
                      }
                    }
                    let alBatchImported = 0;
                    for (let i = 0; i < alPhotos.length; i += AL_CONCURRENCY) {
                      const batch = alPhotos.slice(i, i + AL_CONCURRENCY);
                      await Promise.all(batch.map(async (photo) => {
                        try {
                          const quality = await checkTileQuality(photo.tile128Url ?? photo.sourceUrl, task.subject);
                          if (quality.rejected) return;
                          const lab = await computeLabFull(photo.tile128Url ?? photo.sourceUrl);
                          // Blur-Filter: lenient to allow smooth/gradient tiles
                          const isCalmSubj = ['calm_nature', 'calm_monochrome', 'abstract_smooth', 'skin_tone',
                            'gradient_edge', 'bokeh_gradient', 'pure_sky', 'fog_mist', 'snow_ice',
                            'portrait_nature', 'water_surface'].includes(task.subject);
                          if (lab && lab.blurScore < (isCalmSubj ? 5 : 30)) { return; }
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
                            edgeEnergy: lab?.edgeDensity,
                            pHash: lab?.pHash,
                          });
                          if (ins.inserted) { alImported++; alBatchImported++; smartImportJobs[jobKey].imported = alImported; totalImported++; }
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
                    'UPDATE mosaic_images SET avg_l=$1,avg_a=$2,avg_b=$3,tl_l=$4,tl_a=$5,tl_b=$6,tr_l=$7,tr_a=$8,tr_b=$9,bl_l=$10,bl_a=$11,bl_b=$12,br_l=$13,br_a=$14,br_b=$15,tile_type=$16,edge_energy=$18,indexed_at=NOW() WHERE id=$17',
                    [lab.L,lab.a,lab.b,lab.tlL,lab.tlA,lab.tlB,lab.trL,lab.trA,lab.trB,lab.blL,lab.blA,lab.blB,lab.brL,lab.brA,lab.brB,lab.tileType,row.id,lab.edgeDensity]
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
          // Snapshot: Nachher-Stats + Vergleich
          const afterStats = await alPool2.query(`
            SELECT COUNT(*) as total,
              SUM(CASE WHEN quality_status='rejected' THEN 1 ELSE 0 END) as rejected,
              AVG(quality_score) as avg_quality,
              SUM(CASE WHEN semantic_theme='portrait_medium_skin' THEN 1 ELSE 0 END) as portrait_medium_skin,
              SUM(CASE WHEN semantic_theme='city_night' THEN 1 ELSE 0 END) as city_night,
              SUM(CASE WHEN semantic_theme='nature_forest' THEN 1 ELSE 0 END) as nature_forest,
              SUM(CASE WHEN semantic_theme='nature_sunset' THEN 1 ELSE 0 END) as nature_sunset
            FROM mosaic_images
          `);
          const as2 = afterStats.rows[0];
          const afterTotal = Number(as2.total);
          const newTiles = afterTotal - beforeTotal;
          const qualityDelta = Number(as2.avg_quality) - Number(bs.avg_quality);
          const skinBefore = Math.round(Number(bs.portrait_medium_skin)/beforeTotal*100);
          const skinAfter = Math.round(Number(as2.portrait_medium_skin)/afterTotal*100);
          const cityBefore = Math.round(Number(bs.city_night)/beforeTotal*100);
          const cityAfter = Math.round(Number(as2.city_night)/afterTotal*100);
          const forestBefore = Math.round(Number(bs.nature_forest)/beforeTotal*100);
          const forestAfter = Math.round(Number(as2.nature_forest)/afterTotal*100);
          await addStep('snapshot-after', 'done',
            `Nachher: ${afterTotal.toLocaleString('de-CH')} Tiles (+${newTiles}) | portrait_medium_skin: ${skinBefore}%→${skinAfter}% | city_night: ${cityBefore}%→${cityAfter}% | nature_forest: ${forestBefore}%→${forestAfter}% | Ø Qualität: ${Number(as2.avg_quality).toFixed(1)} (${qualityDelta >= 0 ? '+' : ''}${qualityDelta.toFixed(1)})`);
          await addStep('done', 'done', `Auto-Learn-Zyklus abgeschlossen: +${newTiles} neue Tiles, Pool jetzt ${afterTotal.toLocaleString('de-CH')} Tiles`);
          await db.finishAutoLearnRun(runId, 'success', { steps: steps.length, newTiles, beforeTotal, afterTotal, skinBefore, skinAfter });
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

  // ── Bereinigungsassistent ──────────────────────────────────────────────────────────────────────────────────────
  /**
   * Analysiert den Tile-Pool und gibt Kandidaten für jede der 2 Bereinigungsstufen zurück.
   * Stufe 1: Automatisch löschbar (rejected inkl. Gemini-Rejects + URL-Duplikate + Pixabay-Hotlinks)
   * Stufe 2: Bulk-Delete mit Vorschau (grau+busy, fast-weiss, tiefer Quality-Score)
   */
  getCleanupCandidates: adminProcedure.query(async () => {
    const pool = db.getPool();

    // Alle Counts in einem einzigen Query (deutlich schneller auf grosser DB)
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE quality_status = 'rejected' OR ai_suitability = 'reject') AS rejected,
        COUNT(*) FILTER (WHERE ai_suitability = 'poor'
          AND COALESCE(quality_status,'') != 'rejected') AS poor,
        COUNT(*) FILTER (WHERE id NOT IN (
          SELECT MIN(id) FROM mosaic_images GROUP BY source_url
        )) AS url_duplicates,
        COUNT(*) FILTER (WHERE SQRT(avg_a*avg_a + avg_b*avg_b) < 3
          AND tile_type = 'busy'
          AND quality_status != 'rejected' AND COALESCE(ai_suitability,'') != 'reject') AS gray_busy,
        COUNT(*) FILTER (WHERE avg_l > 92
          AND SQRT(avg_a*avg_a + avg_b*avg_b) < 5
          AND quality_status != 'rejected' AND COALESCE(ai_suitability,'') != 'reject') AS near_white,
        COUNT(*) FILTER (WHERE quality_score < 40
          AND quality_status != 'rejected' AND COALESCE(ai_suitability,'') != 'reject') AS low_score,
        COUNT(*) FILTER (WHERE COALESCE(source_provider, '') = 'pixabay'
          AND r2_url IS NULL
          AND quality_status != 'rejected' AND COALESCE(ai_suitability,'') != 'reject') AS pixabay_hotlink,
        COUNT(*) FILTER (WHERE quality_status != 'rejected' AND COALESCE(ai_suitability,'') != 'reject') AS total_active
      FROM mosaic_images
    `);
    const s = statsRes.rows[0];
    const totalActive = Number(s.total_active);
    const rejectedCount = Number(s.rejected);
    const urlDupCount = Number(s.url_duplicates);
    const grayBusyCount = Number(s.gray_busy);
    const nearWhiteCount = Number(s.near_white);
    const lowScoreCount = Number(s.low_score);
    const pixabayHotlinkCount = Number(s.pixabay_hotlink);
    const poorCount = Number(s.poor);

    return {
      totalActive,
      stage1: {
        rejected: rejectedCount,
        poor: poorCount,
        urlDuplicates: urlDupCount,
        pixabayHotlink: pixabayHotlinkCount,
        total: rejectedCount + poorCount + urlDupCount + pixabayHotlinkCount,
      },
      stage2: {
        grayBusy: grayBusyCount,
        nearWhite: nearWhiteCount,
        lowScore: lowScoreCount,
        total: grayBusyCount + nearWhiteCount + lowScoreCount,
      },
    };
  }),

  /**
   * Gibt eine Vorschau (max. 50 Tiles) für eine bestimmte Bereinigungskategorie zurück.
   */
  getCleanupPreview: adminProcedure
    .input(z.object({
      category: z.enum(['rejected', 'poor', 'urlDuplicates', 'grayBusy', 'nearWhite', 'lowScore', 'generalLow', 'oversaturatedSkin', 'portraitBusy', 'pixabayHotlink']),
      limit: z.number().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const pool = db.getPool();
      let whereClause = '';
      switch (input.category) {
        case 'rejected':
          whereClause = `quality_status = 'rejected' OR ai_suitability = 'reject'`;
          break;
        case 'poor':
          whereClause = `ai_suitability = 'poor' AND COALESCE(quality_status,'') != 'rejected'`;
          break;
        case 'urlDuplicates':
          whereClause = `id NOT IN (SELECT MIN(id) FROM mosaic_images GROUP BY source_url)`;
          break;
        case 'grayBusy':
          whereClause = `SQRT(avg_a*avg_a + avg_b*avg_b) < 3 AND tile_type = 'busy' AND quality_status != 'rejected'`;
          break;
        case 'nearWhite':
          whereClause = `avg_l > 92 AND SQRT(avg_a*avg_a + avg_b*avg_b) < 5 AND quality_status != 'rejected'`;
          break;
        case 'lowScore':
        case 'generalLow': // backward compat
          whereClause = `quality_score < 40 AND quality_status != 'rejected'`;
          break;
        case 'oversaturatedSkin':
          whereClause = `semantic_theme LIKE 'portrait%' AND SQRT(avg_a*avg_a + avg_b*avg_b) > 35 AND quality_status != 'rejected'`;
          break;
        case 'portraitBusy':
          whereClause = `semantic_theme LIKE 'portrait%' AND tile_type = 'busy' AND quality_score < 55 AND quality_status != 'rejected'`;
          break;
        case 'pixabayHotlink':
          whereClause = `COALESCE(source_provider, '') = 'pixabay' AND r2_url IS NULL AND quality_status != 'rejected'`;
          break;
      }
      const res = await pool.query(
        `SELECT id, tile128_url, source_url, avg_l, avg_a, avg_b,
                tile_type, semantic_theme, quality_score, quality_status,
                photographer_name, import_query
         FROM mosaic_images
         WHERE ${whereClause}
         ORDER BY id ASC
         LIMIT $1`,
        [input.limit]
      );
      return {
        tiles: res.rows.map(r => ({
          id: r.id,
          thumbUrl: r.tile128_url,
          sourceUrl: r.source_url,
          avgL: Number(r.avg_l),
          avgA: Number(r.avg_a),
          avgB: Number(r.avg_b),
          chroma: Math.round(Math.sqrt(r.avg_a ** 2 + r.avg_b ** 2)),
          tileType: r.tile_type,
          semanticTheme: r.semantic_theme,
          qualityScore: r.quality_score,
          qualityStatus: r.quality_status,
          photographerName: r.photographer_name,
          importQuery: r.import_query,
        })),
      };
    }),

  /**
   * Löscht Tiles einer bestimmten Bereinigungskategorie (mit optionaler ID-Liste für selektives Löschen).
   * Gibt die Anzahl gelöschter Tiles zurück.
   */
  bulkDeleteTiles: adminProcedure
    .input(z.object({
      category: z.enum(['rejected', 'poor', 'urlDuplicates', 'grayBusy', 'nearWhite', 'generalLow', 'lowScore', 'oversaturatedSkin', 'portraitBusy', 'pixabayHotlink']),
      // Wenn ids angegeben: nur diese IDs löschen (selektiv)
      // Wenn ids leer: alle Kandidaten der Kategorie löschen
      ids: z.array(z.number()).optional(),
      dryRun: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const pool = db.getPool();
      let whereClause = '';
      switch (input.category) {
        case 'rejected':
          whereClause = `quality_status = 'rejected' OR ai_suitability = 'reject'`;
          break;
        case 'poor':
          whereClause = `ai_suitability = 'poor' AND COALESCE(quality_status,'') != 'rejected'`;
          break;
        case 'urlDuplicates':
          whereClause = `id NOT IN (SELECT MIN(id) FROM mosaic_images GROUP BY source_url)`;
          break;
        case 'grayBusy':
          whereClause = `SQRT(avg_a*avg_a + avg_b*avg_b) < 3 AND tile_type = 'busy' AND quality_status != 'rejected'`;
          break;
        case 'nearWhite':
          whereClause = `avg_l > 92 AND SQRT(avg_a*avg_a + avg_b*avg_b) < 5 AND quality_status != 'rejected'`;
          break;
        case 'lowScore':
        case 'generalLow': // backward compat
          whereClause = `quality_score < 40 AND quality_status != 'rejected'`;
          break;
        case 'oversaturatedSkin':
          whereClause = `semantic_theme LIKE 'portrait%' AND SQRT(avg_a*avg_a + avg_b*avg_b) > 35 AND quality_status != 'rejected'`;
          break;
        case 'portraitBusy':
          whereClause = `semantic_theme LIKE 'portrait%' AND tile_type = 'busy' AND quality_score < 55 AND quality_status != 'rejected'`;
          break;
        case 'pixabayHotlink':
          whereClause = `COALESCE(source_provider, '') = 'pixabay' AND r2_url IS NULL AND quality_status != 'rejected'`;
          break;
      }

      // Wenn spezifische IDs angegeben: nur diese löschen (Sicherheitsnetz: müssen auch Kriterium erfüllen)
      const hasIds = input.ids && input.ids.length > 0;
      let finalWhere: string;
      let queryParams: unknown[];
      if (hasIds) {
        // ID-Filter kombinieren: nur die angegebenen IDs, die auch das Kriterium erfüllen
        finalWhere = `id = ANY($1::int[]) AND (${whereClause})`;
        queryParams = [input.ids];
      } else {
        finalWhere = whereClause;
        queryParams = [];
      }

      if (input.dryRun) {
        const countRes = await pool.query(
          `SELECT COUNT(*) as cnt FROM mosaic_images WHERE ${finalWhere}`,
          queryParams
        );
        return { deleted: 0, wouldDelete: Number(countRes.rows[0].cnt), dryRun: true };
      }

      const deleteRes = await pool.query(
        `DELETE FROM mosaic_images WHERE ${finalWhere} RETURNING id`,
        queryParams
      );
      return { deleted: deleteRes.rowCount ?? 0, wouldDelete: 0, dryRun: false };
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
    // Check: tile_type-Vollständigkeit (calm/medium/busy)
    const tileTypeRes = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN tile_type IS NULL THEN 1 ELSE 0 END) as no_tile_type,
        SUM(CASE WHEN tile_type = 'calm' THEN 1 ELSE 0 END) as calm,
        SUM(CASE WHEN tile_type = 'medium' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN tile_type = 'busy' THEN 1 ELSE 0 END) as busy
      FROM mosaic_images
    `);
    const tt = tileTypeRes.rows[0];
    const noTileType = Number(tt.no_tile_type);
    const tileTypeTotal = Number(tt.total);
    items.push({
      runId, entityType: 'db', entityId: 'tile_type',
      status: noTileType > tileTypeTotal * 0.10 ? 'warn' : 'pass',
      message: `tile_type: ${tileTypeTotal - noTileType}/${tileTypeTotal} klassifiziert (calm: ${tt.calm}, medium: ${tt.medium}, busy: ${tt.busy})${noTileType > 0 ? ` → ${noTileType} ohne Typ (Reklassifizierung empfohlen)` : ''}`,
      details: { noTileType, calm: Number(tt.calm), medium: Number(tt.medium), busy: Number(tt.busy) },
    });
    // Check: edge_energy-Vollständigkeit (Sobel-Backfill)
    const edgeRes = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN edge_energy IS NULL THEN 1 ELSE 0 END) as no_edge
      FROM mosaic_images
    `);
    const noEdge = Number(edgeRes.rows[0].no_edge);
    const edgeTotal = Number(edgeRes.rows[0].total);
    const edgeCovPct = edgeTotal > 0 ? ((edgeTotal - noEdge) / edgeTotal * 100).toFixed(1) : '0';
    items.push({
      runId, entityType: 'db', entityId: 'edge_energy',
      status: noEdge > edgeTotal * 0.50 ? 'warn' : 'pass',
      message: `edge_energy (Sobel): ${edgeCovPct}% der Tiles haben echten Kantenwert${noEdge > 0 ? ` → ${noEdge} ohne Wert (Tile-Typen reklassifizieren für Backfill)` : ''}`,
      details: { noEdge, edgeTotal, coveragePct: edgeCovPct },
    });
    // Check: quality_status-Verteilung
    const qualRes = await pool.query(`
      SELECT
        SUM(CASE WHEN quality_status = 'ok' THEN 1 ELSE 0 END) as ok_count,
        SUM(CASE WHEN quality_status = 'warn' THEN 1 ELSE 0 END) as warn_count,
        SUM(CASE WHEN quality_status = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
        SUM(CASE WHEN quality_status IS NULL OR quality_status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        COUNT(*) as total
      FROM mosaic_images
    `);
    const qs = qualRes.rows[0];
    items.push({
      runId, entityType: 'db', entityId: 'quality_status',
      status: 'pass',
      message: `ℹ️ quality_status: ${qs.ok_count} ok / ${qs.warn_count} warn / ${qs.rejected_count} rejected / ${qs.pending_count} pending`,
      details: { ok: Number(qs.ok_count), warn: Number(qs.warn_count), rejected: Number(qs.rejected_count), pending: Number(qs.pending_count) },
    });
    await db.insertQualityItems(items);
    const hasWarn = items.some(i => i.status === 'warn' || i.status === 'fail');
    await db.finishQualityRun(runId, hasWarn ? 'warning' : 'success', {
      total: Number(res.rows[0].total), unindexed: Number(res.rows[0].unindexed), noQuadrant, noSrc, noTileType, noEdge
    });

  } else if (checkType === 'pool-balance') {
    // Check LAB-Cube coverage: are all color regions represented?
    // Zielwerte basieren auf der realen Portrait-Pool-Zusammensetzung:
    // - Niedrig-Sättigung (Hauttöne, Grautöne) ist naturgemäss hoch (~70-85%)
    // - Hoch-Sättigung (Natur, Abstrakt) ist selten (~5-15%)
    // - Ziel: Mindest-Abdeckung für kritische Bereiche (dunkel, hell, bunt)
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
        SUM(CASE WHEN avg_a > 10 AND avg_b > 5 THEN 1 ELSE 0 END) as warm_skin,
        SUM(CASE WHEN tile_type IS NOT NULL THEN 1 ELSE 0 END) as has_tile_type,
        SUM(CASE WHEN edge_energy IS NOT NULL THEN 1 ELSE 0 END) as has_edge_energy,
        SUM(CASE WHEN quality_status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
      FROM mosaic_images
    `);
    const r = res.rows[0];
    const total = Number(r.total);
    // Farbraum-Checks: Zielwerte sind Mindest-Abdeckungen (nicht Obergrenzen)
    // Status: fail = unter Minimum, warn = nahe am Minimum, pass = ausreichend
    // Für Niedrig-Sättigung: Wert ist INFORMATIV (kein fail), da Hauttöne naturgemäss dominieren
    const colorChecks = [
      { key: 'extreme_dark',  label: 'Extrem-Dunkel (L<20)',        minTarget: 0.04, infoOnly: false },
      { key: 'extreme_bright',label: 'Extrem-Hell (L>85)',          minTarget: 0.04, infoOnly: false },
      { key: 'low_sat',       label: 'Niedrig-Sättigung / Hauttöne (<C20)', minTarget: 0.50, infoOnly: true  },
      { key: 'mid_sat',       label: 'Mittel-Sättigung (C 20-42)',  minTarget: 0.08, infoOnly: false },
      { key: 'high_sat',      label: 'Hoch-Sättigung / Bunt (>C42)',minTarget: 0.03, infoOnly: false },
      { key: 'cool',          label: 'Kühl-Töne (b<-5)',            minTarget: 0.05, infoOnly: false },
      { key: 'warm_skin',     label: 'Warm/Haut-Töne (a>10, b>5)', minTarget: 0.10, infoOnly: false },
    ];
    for (const c of colorChecks) {
      const count = Number(r[c.key]);
      const pct = total > 0 ? count / total : 0;
      const diff = pct - c.minTarget;
      const status: 'pass' | 'warn' | 'fail' = c.infoOnly ? 'pass'
        : diff < -0.02 ? 'fail'
        : diff < 0 ? 'warn'
        : 'pass';
      const label = c.infoOnly ? `ℹ️ ${c.label}` : c.label;
      items.push({
        runId, entityType: 'pool', entityId: c.key,
        status,
        message: `${label}: ${(pct*100).toFixed(1)}% (Minimum: ${(c.minTarget*100).toFixed(0)}%, Δ${diff > 0 ? '+' : ''}${(diff*100).toFixed(1)}%)`,
        details: { count, pct: Math.round(pct*1000)/10, minTarget: c.minTarget*100, infoOnly: c.infoOnly },
      });
    }
    // tile_type-Vollständigkeit
    const tileTypePct = total > 0 ? Number(r.has_tile_type) / total : 0;
    items.push({
      runId, entityType: 'pool', entityId: 'tile_type_coverage',
      status: tileTypePct < 0.90 ? 'warn' : 'pass',
      message: `tile_type (calm/medium/busy): ${(tileTypePct*100).toFixed(1)}% der Tiles klassifiziert${tileTypePct < 0.90 ? ' → Tile-Typen reklassifizieren empfohlen' : ''}`,
      details: { hasTileType: Number(r.has_tile_type), total, pct: Math.round(tileTypePct*1000)/10 },
    });
    // edge_energy-Vollständigkeit (Sobel-Backfill)
    const edgePct = total > 0 ? Number(r.has_edge_energy) / total : 0;
    items.push({
      runId, entityType: 'pool', entityId: 'edge_energy_coverage',
      status: edgePct < 0.50 ? 'warn' : 'pass',
      message: `edge_energy (Sobel): ${(edgePct*100).toFixed(1)}% der Tiles haben echten Kantenwert${edgePct < 0.90 ? ' → Tile-Typen reklassifizieren für vollständigen Backfill' : ''}`,
      details: { hasEdgeEnergy: Number(r.has_edge_energy), total, pct: Math.round(edgePct*1000)/10 },
    });
    // rejected-Tiles Info
    const rejectedPct = total > 0 ? Number(r.rejected_count) / total : 0;
    items.push({
      runId, entityType: 'pool', entityId: 'rejected_tiles',
      status: 'pass',
      message: `ℹ️ Abgelehnte Tiles: ${r.rejected_count} (${(rejectedPct*100).toFixed(1)}%) – werden aus Index ausgeschlossen`,
      details: { rejectedCount: Number(r.rejected_count), total, pct: Math.round(rejectedPct*1000)/10 },
    });
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
      // chromaScore: Farbigkeit (hohe Chroma = gut)
      const chromaScore = Math.min(chroma / 40, 1);
      // brightnessScore: KEIN Mitteltöne-Bias mehr.
      // Extreme Helligkeiten (sehr hell oder sehr dunkel) sind für Mosaike wertvoll
      // (weisse Wolken, schwarze Haare, helle Haut, dunkle Kleidung).
      // Stattdessen: Score = 1.0 für alle L-Werte ausser dem "toten" Bereich (L<5 oder L>97)
      const brightnessScore = (row.avg_l < 5 || row.avg_l > 97) ? 0.5 : 1.0;
      // textureScore: Quadrant-Varianz = Textur/Struktur
      const textureScore = Math.min(Math.sqrt(lVariance) / 20, 1);
      // Qualitäts-Score: Chroma 40%, Helligkeit 20%, Textur 40%
      // (Helligkeit weniger gewichtet, da extreme Werte jetzt nicht mehr bestraft werden)
      const qualityScore = Math.round((chromaScore * 0.4 + brightnessScore * 0.2 + textureScore * 0.4) * 100) / 100;
      // Reject-Kriterien überarbeitet:
      // Nur ablehnen wenn: (a) komplett einfarbig (lVariance < 1) UND (b) komplett farblos (chroma < 3)
      // UND (c) im "toten" Bereich (L < 5 = fast schwarz, L > 97 = fast weiss ohne Struktur)
      // Früher: lVariance < 2 && (avg_l < 15 || avg_l > 90) – zu aggressiv, bestraft gute Tiles
      const isRejected = lVariance < 1 && chroma < 3 && (row.avg_l < 5 || row.avg_l > 97);
      const status: 'pass' | 'warn' | 'fail' = isRejected ? 'fail' : qualityScore < 0.2 ? 'warn' : 'pass';
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
