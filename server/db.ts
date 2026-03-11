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
  page: number; pageSize: number;
  brightnessFilter?: string; colorFilter?: string;
}) {
  const pool = getPool();
  const offset = (opts.page - 1) * opts.pageSize;
  const conditions: string[] = [];
  // Brightness filter
  if (opts.brightnessFilter === "dunkel") conditions.push("avg_l < 35");
  else if (opts.brightnessFilter === "mittel") conditions.push("avg_l >= 35 AND avg_l <= 65");
  else if (opts.brightnessFilter === "hell") conditions.push("avg_l > 65");
  // Color filter (matching LAB color classification used in getDbStats)
  if (opts.colorFilter === "schwarz") conditions.push("avg_l < 25");
  else if (opts.colorFilter === "weiss") conditions.push("avg_l > 80");
  else if (opts.colorFilter === "grau") conditions.push("ABS(avg_a) < 8 AND ABS(avg_b) < 8 AND avg_l >= 25 AND avg_l <= 80");
  else if (opts.colorFilter === "rot") conditions.push("avg_a > 20");
  else if (opts.colorFilter === "orange") conditions.push("avg_a > 10 AND avg_b > 10 AND avg_a <= 20");
  else if (opts.colorFilter === "gelb") conditions.push("avg_b > 20 AND avg_a <= 10");
  else if (opts.colorFilter === "cyan") conditions.push("avg_a < -10 AND avg_b < -5");
  else if (opts.colorFilter === "gruen") conditions.push("avg_a < -10 AND avg_b >= -5");
  else if (opts.colorFilter === "blau") conditions.push("avg_b < -15 AND avg_a >= -10");
  else if (opts.colorFilter === "violett") conditions.push("avg_a > 10 AND avg_b < 0 AND avg_a <= 20");
  else if (opts.colorFilter === "pink") conditions.push("avg_a > 10 AND avg_b >= 0 AND avg_a <= 20");
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM mosaic_images ${where}`);
  const total = Number(countRes.rows[0]?.cnt ?? 0);
  const res = await pool.query(
    `SELECT id, source_url as "sourceUrl", tile128_url as "tile128Url",
      avg_l as "avgL", avg_a as "avgA", avg_b as "avgB", created_at as "createdAt",
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
      END as "colorCategory",
      CASE
        WHEN avg_l < 35 THEN 'Dunkel'
        WHEN avg_l > 65 THEN 'Hell'
        ELSE 'Mittel'
      END as "brightnessCategory"
    FROM mosaic_images ${where} ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [opts.pageSize, offset]
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
  await pool.query(
    `INSERT INTO mosaic_images (source_url, tile128_url, avg_l, avg_a, avg_b, subject)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [data.sourceUrl, data.tile128Url, data.avgL, data.avgA, data.avgB, data.subject ?? 'general']
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
