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

  console.log("[DB] Schema ensured (v2 with QA tables)");
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
      br_l as "brL", br_a as "brA", br_b as "brB"
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
  sourceUrl: string; tile128Url: string | null;
  avgL: number; avgA: number; avgB: number;
  tlL?: number; tlA?: number; tlB?: number;
  trL?: number; trA?: number; trB?: number;
  blL?: number; blA?: number; blB?: number;
  brL?: number; brA?: number; brB?: number;
  subject?: string;        // legacy – mapped to theme
  theme?: string;          // canonical field
  sourceProvider?: string; // 'pexels' | 'unsplash' | 'pixabay' | 'picsum' | 'upload'
  importQuery?: string;    // keyword used to find this tile
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
  const res = await pool.query(
    `INSERT INTO mosaic_images
       (source_url, tile128_url, avg_l, avg_a, avg_b,
        tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
        bl_l, bl_a, bl_b, br_l, br_a, br_b,
        subject, theme, source_provider, import_query, url_hash, imported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,MD5($1),NOW())
     ON CONFLICT (source_url) DO NOTHING
     RETURNING id`,
    [
      normalizedUrl, data.tile128Url,
      data.avgL, data.avgA, data.avgB,
      tlL, tlA, tlB, trL, trA, trB,
      blL, blA, blB, brL, brA, brB,
      theme, theme, sourceProvider, data.importQuery ?? null
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
    WHERE avg_l IS NOT NULL AND lab_indexed = true
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
