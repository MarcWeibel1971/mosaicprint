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

// ---- Schema ----
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
  // Add subject column if missing (migration for existing tables)
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT 'general'`);
  // Add UNIQUE constraint on source_url to prevent duplicates at DB level
  // This is idempotent: IF NOT EXISTS equivalent via DO NOTHING on pg_constraint check
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'mosaic_images_source_url_unique'
      ) THEN
        ALTER TABLE mosaic_images ADD CONSTRAINT mosaic_images_source_url_unique UNIQUE (source_url);
      END IF;
    END $$
  `).catch(() => { /* ignore if constraint already exists or duplicate data prevents it */ });
  // Add url_hash column for fast duplicate lookup (MD5 of normalized URL)
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS url_hash TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mosaic_images_url_hash ON mosaic_images (url_hash)`);
  // Backfill url_hash for existing rows
  await pool.query(`UPDATE mosaic_images SET url_hash = MD5(source_url) WHERE url_hash IS NULL`).catch(() => {});
  // Add is_skin_friendly flag for portrait-mode matching
  // A tile is skin-friendly if: low chroma (sqrt(a²+b²) < 25) AND mid brightness (L 35-80)
  // This is computed from existing avg_a/avg_b/avg_l – no new data needed.
  // We store it as a plain boolean column and update it once on migration.
  await pool.query(`ALTER TABLE mosaic_images ADD COLUMN IF NOT EXISTS is_skin_friendly BOOLEAN DEFAULT false`);
  // Backfill: mark all existing rows that match the skin-friendly criteria
  await pool.query(`
    UPDATE mosaic_images
    SET is_skin_friendly = (SQRT(avg_a * avg_a + avg_b * avg_b) < 25 AND avg_l >= 35 AND avg_l <= 80)
    WHERE is_skin_friendly IS NULL OR is_skin_friendly = false
  `).catch(() => { /* ignore if already done */ });
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
  console.log("[DB] Schema ensured");
}

// ---- Tile queries ----
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
}) {
  const pool = getPool();
  // Support both 'pageSize' and 'limit' parameter names (client sends 'limit')
  const pageSize = opts.pageSize ?? opts.limit ?? 50;
  const offset = (opts.page - 1) * pageSize;
  const conditions: string[] = [];
  // Source filter: derive from source_url pattern (no source_id column in DB)
  if (opts.sourceId === 'pexels') conditions.push("source_url LIKE '%pexels%'");
  else if (opts.sourceId === 'unsplash') conditions.push("source_url LIKE '%unsplash%'");
  else if (opts.sourceId === 'picsum') conditions.push("(source_url LIKE '%picsum%' OR source_url LIKE '%lorempixel%')");
  // Brightness filter
  if (opts.brightnessFilter === "dunkel") conditions.push("avg_l < 35");
  else if (opts.brightnessFilter === "mittel") conditions.push("avg_l >= 35 AND avg_l <= 65");
  else if (opts.brightnessFilter === "hell") conditions.push("avg_l > 65");
  // Color filter — exact same LAB thresholds as getDbStats for consistency
  // Priority order matters: schwarz/weiss first, then grau, then chromatic colors
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
      COALESCE(subject, 'general') as "subject",
      CASE
        WHEN source_url LIKE '%pexels%' THEN 'pexels'
        WHEN source_url LIKE '%unsplash%' THEN 'unsplash'
        WHEN source_url LIKE '%picsum%' THEN 'picsum'
        ELSE 'other'
      END as "sourceId",
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
  subject?: string;
}): Promise<void> {
  const pool = getPool();
  // Normalize URL: strip query params that change between requests (Pexels/Unsplash add w/h/fit params)
  // Extract the stable photo ID from the URL to detect duplicates even if URL params differ
  const normalizedUrl = data.sourceUrl.replace(/[?&](w|h|fit|auto|cs|fm|crop|ixid|ixlib|s)=[^&]*/g, '').replace(/[?&]+$/, '');
  await pool.query(
    `INSERT INTO mosaic_images (source_url, tile128_url, avg_l, avg_a, avg_b, subject, url_hash)
     VALUES ($1, $2, $3, $4, $5, $6, MD5($1))
     ON CONFLICT (source_url) DO NOTHING`,
    [normalizedUrl, data.tile128Url, data.avgL, data.avgA, data.avgB, data.subject ?? 'general']
  );
}

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
