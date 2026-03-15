import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _pool = new pg.Pool({
      connectionString: url,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
      max: 10,
    });
  }
  return _pool;
}

export function getDb() {
  if (!_db) {
    _db = drizzle(getPool());
  }
  return _db;
}

// ── Schema ────────────────────────────────────────────────────────────────────
export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mosaic_images (
      id SERIAL PRIMARY KEY,
      source_url TEXT NOT NULL,
      tile128_url TEXT,
      avg_l REAL DEFAULT 50,
      avg_a REAL DEFAULT 0,
      avg_b REAL DEFAULT 0,
      tl_l REAL DEFAULT 50, tl_a REAL DEFAULT 0, tl_b REAL DEFAULT 0,
      tr_l REAL DEFAULT 50, tr_a REAL DEFAULT 0, tr_b REAL DEFAULT 0,
      bl_l REAL DEFAULT 50, bl_a REAL DEFAULT 0, bl_b REAL DEFAULT 0,
      br_l REAL DEFAULT 50, br_a REAL DEFAULT 0, br_b REAL DEFAULT 0,
      subject TEXT DEFAULT 'general',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Legacy migrations (idempotent)
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT 'general'`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'mosaic_images_source_url_unique'
      ) THEN
        ALTER TABLE mosaic_images ADD CONSTRAINT mosaic_images_source_url_unique UNIQUE (source_url);
      END IF;
    END $$
  `).catch(() => {});
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tl_l REAL DEFAULT 50`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tl_a REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tl_b REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tr_l REAL DEFAULT 50`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tr_a REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tr_b REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS bl_l REAL DEFAULT 50`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS bl_a REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS bl_b REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS br_l REAL DEFAULT 50`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS br_a REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS br_b REAL DEFAULT 0`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS url_hash TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_url_hash ON mosaic_images (url_hash)`);
  await pool.query(`UPDATE mosaic_images SET url_hash = MD5(source_url) WHERE url_hash IS NULL`).catch(() => {});
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS is_skin_friendly BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS r2_url TEXT`);
  await pool.query(`
    UPDATE mosaic_images
    SET is_skin_friendly = (SQRT(avg_a * avg_a + avg_b * avg_b) < 25 AND avg_l >= 35 AND avg_l <= 80)
    WHERE is_skin_friendly IS NULL OR is_skin_friendly = false
  `).catch(() => {});

  // ── QA Phase 1: New columns ───────────────────────────────────────────────
  // source_provider: canonical source name (replaces heuristic URL detection)
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS source_provider TEXT DEFAULT NULL`);
  await pool.query(`
    UPDATE mosaic_images SET source_provider =
      CASE
        WHEN source_url LIKE '%pexels%' THEN 'pexels'
        WHEN source_url LIKE '%unsplash%' THEN 'unsplash'
        WHEN source_url LIKE '%pixabay%' OR source_url LIKE '%cdn.pixabay%' THEN 'pixabay'
        WHEN source_url LIKE '%picsum%' OR source_url LIKE '%lorempixel%' THEN 'picsum'
        ELSE 'other'
      END
    WHERE source_provider IS NULL
  `).catch(() => {});
  // Fix: tiles imported with largeImageURL (pixabay.com/get/...) were tagged as 'other'
  // because the URL contains 'pixabay.com' but not the string 'pixabay' in path
  await pool.query(`
    UPDATE mosaic_images SET source_provider = 'pixabay'
    WHERE source_provider = 'other'
      AND (
        source_url LIKE '%pixabay.com%'
        OR tile128_url LIKE '%pixabay.com%'
        OR tile128_url LIKE '%cdn.pixabay%'
      )
  `).catch(() => {});

  // import_query: keyword used to find this tile
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS import_query TEXT DEFAULT NULL`);

  // theme: canonical field (replaces subject – same data, consistent naming)
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT NULL`);
  await pool.query(`UPDATE mosaic_images SET theme = subject WHERE theme IS NULL AND subject IS NOT NULL`).catch(() => {});

  // quality_status: 'pending' | 'approved' | 'rejected'
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS quality_status TEXT DEFAULT 'pending'`);
  // quality_score: 0.0–1.0 composite score
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS quality_score REAL DEFAULT NULL`);
  // quality_reason: rejection reason text
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS quality_reason TEXT DEFAULT NULL`);
  // phash: 64-bit perceptual hash for visual duplicate detection
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS phash TEXT DEFAULT NULL`);
  // imported_at: for 'recently imported' filter
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`UPDATE mosaic_images SET imported_at = created_at WHERE imported_at IS NULL`).catch(() => {});
  // indexed_at: when LAB/quadrant was last computed
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ DEFAULT NULL`);
  // last_checked_at: when quality check was last run on this tile
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ DEFAULT NULL`);
  // usage_count: how many times this tile was used in a mosaic
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS usage_count INT DEFAULT 0`);
  // last_used_at: when this tile was last used
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NULL`);

  // tile_type: 'calm' | 'medium' | 'busy' – texture complexity for tile matching
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS tile_type TEXT DEFAULT 'medium'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_tile_type ON mosaic_images (tile_type)`);

  // Indexes for new columns
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_source_provider ON mosaic_images (source_provider)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_quality_status ON mosaic_images (quality_status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_imported_at ON mosaic_images (imported_at)`);

  // ── Orders table ──────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mosaic_orders (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT UNIQUE,
      format_label TEXT,
      material_label TEXT,
      price_chf REAL,
      customer_email TEXT,
      status TEXT DEFAULT 'pending',
      export_url TEXT,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Algorithm profiles table (replaces localStorage) ──────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS algorithm_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_default BOOLEAN DEFAULT false,
      settings_json JSONB NOT NULL,
      algo_version TEXT DEFAULT '1.0',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Quality check tables ──────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_check_runs (
      id SERIAL PRIMARY KEY,
      check_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      triggered_by TEXT DEFAULT 'manual',
      summary_json JSONB
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_check_items (
      id SERIAL PRIMARY KEY,
      run_id INT REFERENCES quality_check_runs(id) ON DELETE CASCADE,
      entity_type TEXT,
      entity_id TEXT,
      status TEXT NOT NULL,
      message TEXT,
      details_json JSONB
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qc_items_run_id ON quality_check_items (run_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qc_items_status ON quality_check_items (status)`);

  // ── Image categories table ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      parent_category TEXT DEFAULT NULL,
      keywords TEXT[] DEFAULT '{}',
      algo_settings JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed default categories
  await pool.query(`
    INSERT INTO image_categories (name, label, description, parent_category, keywords) VALUES
      ('portrait_light_skin', 'Portrait – helle Haut', 'Helle Hauttöne, blondes/rotes Haar', 'portrait', ARRAY['portrait light skin', 'blonde woman', 'fair skin face', 'caucasian portrait']),
      ('portrait_medium_skin', 'Portrait – mittlere Haut', 'Mittlere Hauttöne, braunes Haar', 'portrait', ARRAY['portrait medium skin', 'brown hair face', 'olive skin portrait']),
      ('portrait_dark_skin', 'Portrait – dunkle Haut', 'Dunkle Hauttöne', 'portrait', ARRAY['dark skin portrait', 'african portrait', 'melanin skin face']),
      ('portrait_grey_hair', 'Portrait – graues Haar / Brille', 'Ältere Person, graues Haar, Brille', 'portrait', ARRAY['elderly portrait glasses', 'grey hair face', 'senior portrait']),
      ('portrait_child', 'Portrait – Kind / Baby', 'Kinderhaut, weiche Töne', 'portrait', ARRAY['child portrait', 'baby face', 'kid smile']),
      ('portrait_group', 'Portrait – Gruppe', 'Mehrere Personen, verschiedene Hauttöne', 'portrait', ARRAY['group portrait', 'family photo', 'people together']),
      ('nature_sunset', 'Natur – Sonnenuntergang', 'Warme Orangetöne, Himmel', 'nature', ARRAY['sunset orange sky', 'golden hour landscape', 'sunrise warm']),
      ('nature_ocean', 'Natur – Ozean / Meer', 'Blaue kühle Töne, Wasser', 'nature', ARRAY['ocean blue water', 'sea waves', 'beach turquoise']),
      ('nature_forest', 'Natur – Wald / Grün', 'Grüne Töne, Vegetation', 'nature', ARRAY['green forest trees', 'jungle foliage', 'meadow grass']),
      ('nature_snow', 'Natur – Schnee / Winter', 'Helle kühle Töne, Weiss', 'nature', ARRAY['snow white winter', 'frost ice', 'mountain snow']),
      ('nature_mountain', 'Natur – Berge', 'Fels, Schnee, Himmel', 'nature', ARRAY['mountain peaks', 'rocky landscape', 'alpine scenery']),
      ('city_night', 'Stadt – Nacht / Skyline', 'Dunkle Töne, Lichter', 'city', ARRAY['city night lights', 'skyline neon', 'urban dark']),
      ('city_architecture', 'Stadt – Architektur', 'Gebäude, Strukturen', 'city', ARRAY['architecture building', 'urban facade', 'city street']),
      ('animal_warm', 'Tier – Erdtöne', 'Löwe, Hund, warme Töne', 'animal', ARRAY['lion fur warm', 'dog portrait', 'animal earth tones']),
      ('animal_colorful', 'Tier – Bunt', 'Vogel, Fisch, bunte Töne', 'animal', ARRAY['colorful bird', 'tropical fish', 'parrot feathers']),
      ('abstract_colorful', 'Abstrakt – Farbenreich', 'Breites Farbspektrum', 'abstract', ARRAY['colorful abstract', 'rainbow colors', 'vibrant spectrum'])
    ON CONFLICT (name) DO NOTHING
  `);

  // ── Auto-Learn cycle runs table ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_learn_runs (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      triggered_by TEXT DEFAULT 'manual',
      steps_json JSONB DEFAULT '[]',
      summary_json JSONB
    )
  `);

  // semantic_theme: auto-tagged category derived from LAB features (no image download needed)
  // Values: portrait_light_skin | portrait_medium_skin | portrait_dark_skin | nature_sunset |
  //         nature_ocean | nature_forest | nature_snow | nature_mountain | city_night |
  //         city_architecture | animal_warm | animal_colorful | abstract_colorful | general
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS semantic_theme TEXT DEFAULT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_semantic_theme ON mosaic_images (semantic_theme)`);

  console.log("[DB] Schema ensured (v5 with semantic_theme)");
}

// ── Tile queries ──────────────────────────────────────────────────────────────
export async function getMosaicImageCount(): Promise<number> {
  const pool = getPool();
  const res = await pool.query("SELECT COUNT(*) as cnt FROM mosaic_images");
  return Number(res.rows[0]?.cnt ?? 0);
}

export async function getMosaicImagesForMatching() {
  const pool = getPool();
  const res = await pool.query(`
    SELECT id, source_url as "sourceUrl", tile128_url as "tile128Url",
      avg_l as "avgL", avg_a as "avgA", avg_b as "avgB",
      tl_l as "tlL", tl_a as "tlA", tl_b as "tlB",
      tr_l as "trL", tr_a as "trA", tr_b as "trB",
      bl_l as "blL", bl_a as "blA", bl_b as "blB",
      br_l as "brL", br_a as "brA", br_b as "brB",
      COALESCE(tile_type, 'medium') as "tileType"
    FROM mosaic_images ORDER BY id ASC
  `);
  return res.rows;
}

export async function getAdminImages(opts: {
  page: number; pageSize?: number; limit?: number;
  brightnessFilter?: string; colorFilter?: string;
  sourceId?: string;
  importedSince?: string; // ISO date string for 'recently imported' filter
  qualityStatus?: string;
  semanticTheme?: string; // filter by auto-tagged semantic category
}) {
  const pool = getPool();
  const pageSize = opts.pageSize ?? opts.limit ?? 50;
  const offset = (opts.page - 1) * pageSize;
  const conditions: string[] = [];

  // Source filter: use source_provider column if available, fall back to URL pattern
  if (opts.sourceId && opts.sourceId !== 'alle') {
    conditions.push(`COALESCE(source_provider, CASE
      WHEN source_url LIKE '%pexels%' THEN 'pexels'
      WHEN source_url LIKE '%unsplash%' THEN 'unsplash'
      WHEN source_url LIKE '%pixabay%' THEN 'pixabay'
      WHEN source_url LIKE '%picsum%' THEN 'picsum'
      ELSE 'other' END) = '${opts.sourceId}'`);
  }

  // Recently imported filter
  if (opts.importedSince) {
    conditions.push(`imported_at >= '${opts.importedSince}'`);
  }

  // Quality status filter
  if (opts.qualityStatus && opts.qualityStatus !== 'alle') {
    conditions.push(`COALESCE(quality_status, 'pending') = '${opts.qualityStatus}'`);
  }

  // Semantic theme filter
  if (opts.semanticTheme && opts.semanticTheme !== 'alle') {
    conditions.push(`semantic_theme = '${opts.semanticTheme.replace(/'/g, "''")}' `);
  }
  // Brightness filter
  if (opts.brightnessFilter === "dunkel") conditions.push("avg_l < 35");
  else if (opts.brightnessFilter === "mittel") conditions.push("avg_l >= 35 AND avg_l <= 65");
  else if (opts.brightnessFilter === "hell") conditions.push("avg_l > 65");

  // Color filter
  if (opts.colorFilter === "schwarz") conditions.push("avg_l < 25");
  else if (opts.colorFilter === "weiss") conditions.push("avg_l > 80");
  else if (opts.colorFilter === "grau") conditions.push("ABS(avg_a) < 8 AND ABS(avg_b) < 8 AND avg_l >= 25 AND avg_l <= 80");
  else if (opts.colorFilter === "rot") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 20");
  else if (opts.colorFilter === "orange") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 10 AND avg_b > 10 AND avg_a <= 20");
  else if (opts.colorFilter === "gelb") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_b > 20 AND avg_a <= 10");
  else if (opts.colorFilter === "cyan") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a < -10 AND avg_b < -5");
  else if (opts.colorFilter === "gruen") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a < -10 AND avg_b >= -5");
  else if (opts.colorFilter === "blau") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_b < -15 AND avg_a >= -10");
  else if (opts.colorFilter === "violett") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 10 AND avg_b < 0 AND avg_a <= 20");
  else if (opts.colorFilter === "pink") conditions.push("avg_l >= 25 AND NOT (ABS(avg_a) < 8 AND ABS(avg_b) < 8) AND avg_a > 10 AND avg_b >= 0 AND avg_a <= 20");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images ${where}`);
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const res = await pool.query(
    `SELECT id, source_url as "sourceUrl", tile128_url as "tile128Url",
      avg_l as "avgL", avg_a as "avgA", avg_b as "avgB", created_at as "createdAt",
      imported_at as "importedAt",
      tl_l as "tlL", tl_a as "tlA", tl_b as "tlB",
      tr_l as "trL", tr_a as "trA", tr_b as "trB",
      bl_l as "blL", bl_a as "blA", bl_b as "blB",
      br_l as "brL", br_a as "brA", br_b as "brB",
      COALESCE(theme, subject, 'general') as "theme",
      COALESCE(theme, subject, 'general') as "subject",
      semantic_theme as "semanticTheme",
      COALESCE(quality_status, 'pending') as "qualityStatus",
      quality_score as "qualityScore",
      quality_reason as "qualityReason",
      import_query as "importQuery",
      COALESCE(source_provider,
        CASE
          WHEN source_url LIKE '%pexels%' THEN 'pexels'
          WHEN source_url LIKE '%unsplash%' THEN 'unsplash'
          WHEN source_url LIKE '%picsum%' THEN 'picsum'
          WHEN source_url LIKE '%pixabay%' THEN 'pixabay'
          ELSE 'other'
        END
      ) as "sourceId",
      CASE
        WHEN avg_l < 25 THEN 'schwarz'
        WHEN avg_l > 80 THEN 'weiss'
        WHEN ABS(avg_a) < 8 AND ABS(avg_b) < 8 AND avg_l >= 25 AND avg_l <= 80 THEN 'grau'
        WHEN avg_a > 20 THEN 'rot'
        WHEN avg_a > 10 AND avg_b > 10 THEN 'orange'
        WHEN avg_b > 20 THEN 'gelb'
        WHEN avg_a < -10 AND avg_b < -5 THEN 'cyan'
        WHEN avg_a < -10 THEN 'gruen'
        WHEN avg_b < -15 THEN 'blau'
        WHEN avg_a > 10 AND avg_b < 0 THEN 'violett'
        WHEN avg_a > 10 THEN 'pink'
        ELSE 'grau'
      END as "colorCategory",
      CASE
        WHEN avg_l < 35 THEN 'Dunkel'
        WHEN avg_l > 65 THEN 'Hell'
        ELSE 'Mittel'
      END as "brightnessCategory"
    FROM mosaic_images ${where} ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  return { images: res.rows, total };
}

export async function deleteMosaicImage(id: number): Promise<boolean> {
  const pool = getPool();
  await pool.query("DELETE FROM mosaic_images WHERE id = $1", [id]);
  return true;
}

export async function insertMosaicImage(data: {
  sourceUrl: string; tile128Url: string | null; r2Url?: string | null;
  avgL: number; avgA: number; avgB: number;
  tlL?: number; tlA?: number; tlB?: number;
  trL?: number; trA?: number; trB?: number;
  blL?: number; blA?: number; blB?: number;
  brL?: number; brA?: number; brB?: number;
  subject?: string;        // legacy – mapped to theme
  theme?: string;          // canonical field
  sourceProvider?: string; // 'pexels' | 'unsplash' | 'pixabay' | 'picsum' | 'upload'
  importQuery?: string;    // keyword used to find this tile
  tileType?: string;       // 'calm' | 'medium' | 'busy' – texture complexity
}): Promise<boolean> {
  const pool = getPool();
  const normalizedUrl = data.sourceUrl.replace(/[?&](w|h|fit|auto|cs|fm|crop|ixid|ixlib|s)=[^&]*/g, '').replace(/[?&]+$/, '');
  const tlL = data.tlL ?? data.avgL, tlA = data.tlA ?? data.avgA, tlB = data.tlB ?? data.avgB;
  const trL = data.trL ?? data.avgL, trA = data.trA ?? data.avgA, trB = data.trB ?? data.avgB;
  const blL = data.blL ?? data.avgL, blA = data.blA ?? data.avgA, blB = data.blB ?? data.avgB;
  const brL = data.brL ?? data.avgL, brA = data.brA ?? data.avgA, brB = data.brB ?? data.avgB;
  const theme = data.theme ?? data.subject ?? 'general';
  const sourceProvider = data.sourceProvider ?? (
    normalizedUrl.includes('pexels') ? 'pexels' :
    normalizedUrl.includes('unsplash') ? 'unsplash' :
    normalizedUrl.includes('pixabay') ? 'pixabay' :
    normalizedUrl.includes('picsum') || normalizedUrl.includes('lorempixel') ? 'picsum' : 'other'
  );
  // Derive semantic_theme from LAB features at insert time
  const isSkinFriendly = Math.sqrt(data.avgA * data.avgA + data.avgB * data.avgB) < 25 && data.avgL >= 35 && data.avgL <= 80;
  const semanticTheme = deriveSemanticTheme({
    avg_l: data.avgL, avg_a: data.avgA, avg_b: data.avgB,
    tl_l: data.tlL, tl_a: data.tlA, tl_b: data.tlB,
    br_l: data.brL, br_a: data.brA, br_b: data.brB,
    is_skin_friendly: isSkinFriendly,
    tile_type: data.tileType ?? 'medium',
    import_query: data.importQuery ?? null,
  });
  const res = await pool.query(
    `INSERT INTO mosaic_images
       (source_url, tile128_url, r2_url, avg_l, avg_a, avg_b,
        tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
        bl_l, bl_a, bl_b, br_l, br_a, br_b,
        subject, theme, source_provider, import_query, url_hash, imported_at, tile_type, semantic_theme)
     VALUES ($1,$2,$24,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,MD5($1),NOW(),$22,$23)
     ON CONFLICT (source_url) DO NOTHING
     RETURNING id`,
    [
      normalizedUrl, data.tile128Url,
      data.avgL, data.avgA, data.avgB,
      tlL, tlA, tlB, trL, trA, trB,
      blL, blA, blB, brL, brA, brB,
      theme, theme, sourceProvider, data.importQuery ?? null,
      data.tileType ?? 'medium', semanticTheme,
      data.r2Url ?? null
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Quality Check DB functions ────────────────────────────────────────────────
export async function startQualityRun(checkType: string, triggeredBy = 'manual'): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO quality_check_runs (check_type, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
    [checkType, triggeredBy]
  );
  return res.rows[0].id;
}

export async function finishQualityRun(runId: number, status: 'success' | 'warning' | 'error', summary: object): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE quality_check_runs SET status = $1, finished_at = NOW(), summary_json = $2 WHERE id = $3`,
    [status, JSON.stringify(summary), runId]
  );
}

export async function insertQualityItems(items: Array<{
  runId: number; entityType: string; entityId: string;
  status: 'pass' | 'warn' | 'fail'; message: string; details?: object;
}>): Promise<void> {
  if (items.length === 0) return;
  const pool = getPool();
  const values = items.map((_, i) => `($${i*6+1},$${i*6+2},$${i*6+3},$${i*6+4},$${i*6+5},$${i*6+6})`).join(',');
  const params = items.flatMap(it => [it.runId, it.entityType, it.entityId, it.status, it.message, JSON.stringify(it.details ?? {})]);
  await pool.query(
    `INSERT INTO quality_check_items (run_id, entity_type, entity_id, status, message, details_json) VALUES ${values}`,
    params
  );
}

export async function getQualityRuns(opts: { checkType?: string; limit?: number } = {}): Promise<any[]> {
  const pool = getPool();
  const conditions: string[] = [];
  if (opts.checkType) conditions.push(`check_type = '${opts.checkType.replace(/'/g, "''")}'`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await pool.query(
    `SELECT * FROM quality_check_runs ${where} ORDER BY started_at DESC LIMIT $1`,
    [opts.limit ?? 20]
  );
  return res.rows;
}

export async function getQualityRunItems(runId: number): Promise<any[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM quality_check_items WHERE run_id = $1 ORDER BY id ASC LIMIT 500`,
    [runId]
  );
  return res.rows;
}

// ── Algorithm Profile DB functions ────────────────────────────────────────────
export async function getAlgorithmProfiles(): Promise<any[]> {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM algorithm_profiles ORDER BY is_default DESC, created_at ASC`);
  return res.rows;
}

export async function saveAlgorithmProfile(name: string, settings: object, isDefault = false): Promise<number> {
  const pool = getPool();
  if (isDefault) {
    await pool.query(`UPDATE algorithm_profiles SET is_default = false WHERE is_default = true`);
  }
  const res = await pool.query(
    `INSERT INTO algorithm_profiles (name, is_default, settings_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (name) DO UPDATE SET settings_json = $3, is_default = $2, updated_at = NOW()
     RETURNING id`,
    [name, isDefault, JSON.stringify(settings)]
  );
  return res.rows[0]?.id;
}

export async function getDefaultAlgorithmProfile(): Promise<any | null> {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM algorithm_profiles WHERE is_default = true LIMIT 1`);
  return res.rows[0] ?? null;
}

// ── Orders ────────────────────────────────────────────────────────────────────
export async function getMosaicOrders() {
  const pool = getPool();
  const res = await pool.query("SELECT * FROM mosaic_orders ORDER BY created_at DESC LIMIT 100");
  return res.rows;
}

export async function createMosaicOrder(data: {
  stripeSessionId: string; formatLabel: string; materialLabel: string;
  priceChf: number; customerEmail?: string | null;
}): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO mosaic_orders (stripe_session_id, format_label, material_label, price_chf, customer_email, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (stripe_session_id) DO NOTHING RETURNING id`,
    [data.stripeSessionId, data.formatLabel, data.materialLabel, data.priceChf, data.customerEmail ?? null]
  );
  return Number(res.rows[0]?.id ?? 0);
}

export async function markMosaicOrderPaid(stripeSessionId: string, exportUrl?: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE mosaic_orders SET status = 'paid', paid_at = NOW(), export_url = $1 WHERE stripe_session_id = $2",
    [exportUrl ?? null, stripeSessionId]
  );
}

// ── Pool LAB Stats (für Testbild-Analyse) ────────────────────────────────────
export async function getPoolLABStats(): Promise<Array<{avgL: number; avgA: number; avgB: number; count: number}>> {
  const pool = getPool();
  // Quantize LAB values to 8-unit grid and count tiles per zone
  const res = await pool.query(`
    SELECT
      ROUND(avg_l / 8) * 8 AS "avgL",
      ROUND(avg_a / 8) * 8 AS "avgA",
      ROUND(avg_b / 8) * 8 AS "avgB",
      COUNT(*) AS count
    FROM mosaic_images
    WHERE avg_l IS NOT NULL AND NOT (avg_l = 50 AND avg_a = 0 AND avg_b = 0)
    GROUP BY 1, 2, 3
    ORDER BY count DESC
    LIMIT 500
  `);
  return res.rows.map((r: {avgL: string; avgA: string; avgB: string; count: string}) => ({
    avgL: Number(r.avgL),
    avgA: Number(r.avgA),
    avgB: Number(r.avgB),
    count: Number(r.count),
  }));
}

// ── Image Categories ──────────────────────────────────────────────────────────
export async function getImageCategories(): Promise<any[]> {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM image_categories ORDER BY parent_category, name`);
  return res.rows;
}

export async function getImageCategory(name: string): Promise<any | null> {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM image_categories WHERE name = $1`, [name]);
  return res.rows[0] ?? null;
}

export async function saveImageCategoryAlgoSettings(name: string, algoSettings: object): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE image_categories SET algo_settings = $1, updated_at = NOW() WHERE name = $2`,
    [JSON.stringify(algoSettings), name]
  );
}

export async function upsertImageCategory(data: {
  name: string; label: string; description?: string;
  parentCategory?: string; keywords?: string[]; algoSettings?: object;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO image_categories (name, label, description, parent_category, keywords, algo_settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET
       label = $2, description = $3, parent_category = $4,
       keywords = $5, algo_settings = $6, updated_at = NOW()`,
    [
      data.name, data.label, data.description ?? null,
      data.parentCategory ?? null,
      data.keywords ?? [],
      JSON.stringify(data.algoSettings ?? {}),
    ]
  );
}

// ── Auto-Learn cycle DB functions ─────────────────────────────────────────────
export async function startAutoLearnRun(triggeredBy = 'manual'): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO auto_learn_runs (status, triggered_by) VALUES ('running', $1) RETURNING id`,
    [triggeredBy]
  );
  return res.rows[0].id;
}

export async function updateAutoLearnRun(runId: number, steps: object[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE auto_learn_runs SET steps_json = $1 WHERE id = $2`,
    [JSON.stringify(steps), runId]
  );
}

export async function finishAutoLearnRun(runId: number, status: 'success' | 'warning' | 'error', summary: object): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE auto_learn_runs SET status = $1, finished_at = NOW(), summary_json = $2 WHERE id = $3`,
    [status, JSON.stringify(summary), runId]
  );
}

export async function getAutoLearnRuns(limit = 20): Promise<any[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM auto_learn_runs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function getAutoLearnRun(runId: number): Promise<any | null> {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM auto_learn_runs WHERE id = $1`, [runId]);
  return res.rows[0] ?? null;
}

// ── Semantic Tagger ───────────────────────────────────────────────────────────
// Derives a semantic category from LAB features already stored in the DB.
// No image download needed – purely rule-based on avg_l, avg_a, avg_b,
// tile_type, is_skin_friendly and quadrant variance.
//
// Category hierarchy (priority order):
//   1. Portrait (skin-friendly + warm LAB)
//   2. Nature (color-based: sunset/ocean/forest/snow/mountain)
//   3. City (dark + low-sat → night; neutral + medium-L → architecture)
//   4. Animal (warm earth tones or vivid colors)
//   5. Abstract (very high saturation)
//   6. general (fallback)
export function deriveSemanticTheme(tile: {
  avg_l: number; avg_a: number; avg_b: number;
  tl_l?: number; tl_a?: number; tl_b?: number;
  br_l?: number; br_a?: number; br_b?: number;
  is_skin_friendly?: boolean;
  tile_type?: string;
  import_query?: string | null;
}): string {
  const L = tile.avg_l ?? 50;
  const a = tile.avg_a ?? 0;
  const b = tile.avg_b ?? 0;
  const sat = Math.sqrt(a * a + b * b); // LAB chroma (saturation proxy)
  const isSkin = tile.is_skin_friendly ?? false;
  const tileType = tile.tile_type ?? 'medium';
  const query = (tile.import_query ?? '').toLowerCase();

  // ── 1. Portrait detection ────────────────────────────────────────────────
  if (isSkin && L >= 35 && L <= 85) {
    // Distinguish by brightness + warmth (a-channel)
    if (L >= 65 && a >= 2 && a <= 18) return 'portrait_light_skin';   // fair/blonde
    if (L >= 45 && L < 65 && a >= 3 && a <= 22) return 'portrait_medium_skin'; // olive/brown
    if (L >= 35 && L < 50 && a >= 5) return 'portrait_dark_skin';     // dark skin
    if (L >= 60 && sat < 15) return 'portrait_grey_hair';              // grey/white hair
    if (L >= 65 && sat < 20 && a < 5) return 'portrait_child';        // soft pale child skin
    return 'portrait_medium_skin'; // fallback portrait
  }

  // ── 2. Nature ────────────────────────────────────────────────────────────
  // Sunset / golden hour: warm orange-red tones
  if (a >= 8 && b >= 12 && L >= 30 && L <= 80) return 'nature_sunset';
  // Ocean / sea: cyan-blue tones
  if (a <= -8 && b <= -8 && L >= 25) return 'nature_ocean';
  // Forest / vegetation: green tones
  if (a <= -8 && b >= -5 && L >= 25 && L <= 75) return 'nature_forest';
  // Snow / winter: very bright + low saturation
  if (L >= 78 && sat < 18) return 'nature_snow';
  // Mountain / rocky: medium-dark, low saturation, calm texture
  if (L >= 30 && L <= 65 && sat < 20 && tileType === 'calm') return 'nature_mountain';

  // ── 3. City ──────────────────────────────────────────────────────────────
  // Night / skyline: very dark
  if (L < 25) return 'city_night';
  // Architecture: medium brightness, low saturation, busy texture (lots of edges)
  if (L >= 35 && L <= 70 && sat < 22 && tileType === 'busy') return 'city_architecture';

  // ── 4. Animal ────────────────────────────────────────────────────────────
  // Warm earth tones (lion, dog, fox): warm + medium brightness
  if (a >= 5 && b >= 8 && L >= 35 && L <= 70 && sat >= 15 && sat < 40) return 'animal_warm';
  // Colorful animals (birds, fish): very vivid
  if (sat >= 45 && L >= 35 && L <= 75) return 'animal_colorful';

  // ── 5. Abstract ──────────────────────────────────────────────────────────
  if (sat >= 40) return 'abstract_colorful';

  // ── 6. Fallback ──────────────────────────────────────────────────────────
  return 'general';
}

// Batch-tag all tiles that have no semantic_theme yet (or force re-tag)
export async function batchTagSemanticThemes(forceRetag = false): Promise<{ tagged: number; skipped: number }> {
  const pool = getPool();
  const whereClause = forceRetag
    ? 'WHERE avg_l IS NOT NULL'
    : 'WHERE semantic_theme IS NULL AND avg_l IS NOT NULL';
  const res = await pool.query(
    `SELECT id, avg_l, avg_a, avg_b, tl_l, tl_a, tl_b, br_l, br_a, br_b,
            is_skin_friendly, tile_type, import_query
     FROM mosaic_images ${whereClause}`
  );
  if (res.rows.length === 0) return { tagged: 0, skipped: 0 };

  let tagged = 0;
  // Process in batches of 500 for efficiency
  const BATCH = 500;
  for (let i = 0; i < res.rows.length; i += BATCH) {
    const batch = res.rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: (string | number)[] = [];
    let pi = 1;
    for (const row of batch) {
      const theme = deriveSemanticTheme(row);
      values.push(`($${pi++}::int, $${pi++}::text)`);
      params.push(row.id, theme);
    }
    await pool.query(
      `UPDATE mosaic_images SET semantic_theme = v.theme
       FROM (VALUES ${values.join(',')}) AS v(id, theme)
       WHERE mosaic_images.id = v.id`,
      params
    );
    tagged += batch.length;
  }
  return { tagged, skipped: res.rows.length - tagged };
}

// Get distribution of semantic themes
export async function getSemanticThemeStats(): Promise<Array<{ theme: string; count: number; pct: number }>> {
  const pool = getPool();
  const res = await pool.query(`
    SELECT
      COALESCE(semantic_theme, 'untagged') as theme,
      COUNT(*) as count
    FROM mosaic_images
    GROUP BY semantic_theme
    ORDER BY count DESC
  `);
  const total = res.rows.reduce((s: number, r: { count: string }) => s + Number(r.count), 0);
  return res.rows.map((r: { theme: string; count: string }) => ({
    theme: r.theme,
    count: Number(r.count),
    pct: total > 0 ? Math.round((Number(r.count) / total) * 1000) / 10 : 0,
  }));
}
