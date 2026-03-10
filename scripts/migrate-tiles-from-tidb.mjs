/**
 * migrate-tiles-from-tidb.mjs
 * Migrates all mosaic_images from TiDB Cloud (MySQL) to Railway PostgreSQL.
 * 
 * Usage:
 *   TIDB_URL="mysql://user:pass@host:4000/db?ssl=true" \
 *   DATABASE_URL="postgresql://user:pass@host:5432/railway" \
 *   node scripts/migrate-tiles-from-tidb.mjs
 */

import mysql from 'mysql2/promise';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const TIDB_URL = process.env.TIDB_URL || process.env.MYSQL_URL;
const PG_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;

if (!TIDB_URL) {
  console.error('❌ TIDB_URL or MYSQL_URL environment variable required');
  process.exit(1);
}
if (!PG_URL) {
  console.error('❌ DATABASE_URL (PostgreSQL) environment variable required');
  process.exit(1);
}

async function main() {
  console.log('🔄 Starting migration: TiDB → PostgreSQL');
  
  // Connect to TiDB (MySQL)
  const match = TIDB_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);
  if (!match) { console.error('❌ Invalid TIDB_URL format'); process.exit(1); }
  const [, user, pass, host, port, dbname] = match;
  
  const mysqlConn = await mysql.createConnection({
    host, port: parseInt(port), user, password: pass,
    database: dbname, ssl: { rejectUnauthorized: false }
  });
  console.log('✅ Connected to TiDB');

  // Connect to PostgreSQL
  const pgPool = new pg.Pool({
    connectionString: PG_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  console.log('✅ Connected to PostgreSQL');

  // Ensure schema exists
  await pgPool.query(`
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ PostgreSQL schema ready');

  // Count source tiles
  const [countRows] = await mysqlConn.execute('SELECT COUNT(*) as cnt FROM mosaic_images');
  const total = Number(countRows[0].cnt);
  console.log(`📊 Total tiles to migrate: ${total}`);

  // Check existing tiles in PG
  const pgCount = await pgPool.query('SELECT COUNT(*) as cnt FROM mosaic_images');
  const existing = Number(pgCount.rows[0].cnt);
  if (existing > 0) {
    console.log(`ℹ️  PostgreSQL already has ${existing} tiles. Migrating remaining...`);
  }

  let migrated = 0;
  let offset = 0;

  while (offset < total) {
    const [rows] = await mysqlConn.execute(
      `SELECT source_url, tile128_url, avg_l, avg_a, avg_b,
              tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
              bl_l, bl_a, bl_b, br_l, br_a, br_b
       FROM mosaic_images ORDER BY id ASC LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset]
    );

    if (!rows.length) break;

    // Build batch insert
    const values = [];
    const placeholders = [];
    let idx = 1;
    for (const row of rows) {
      placeholders.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9},$${idx+10},$${idx+11},$${idx+12},$${idx+13},$${idx+14},$${idx+15},$${idx+16})`);
      values.push(
        row.source_url, row.tile128_url,
        row.avg_l ?? 50, row.avg_a ?? 0, row.avg_b ?? 0,
        row.tl_l ?? 50, row.tl_a ?? 0, row.tl_b ?? 0,
        row.tr_l ?? 50, row.tr_a ?? 0, row.tr_b ?? 0,
        row.bl_l ?? 50, row.bl_a ?? 0, row.bl_b ?? 0,
        row.br_l ?? 50, row.br_a ?? 0, row.br_b ?? 0
      );
      idx += 17;
    }

    await pgPool.query(
      `INSERT INTO mosaic_images 
        (source_url, tile128_url, avg_l, avg_a, avg_b,
         tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
         bl_l, bl_a, bl_b, br_l, br_a, br_b)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values
    );

    migrated += rows.length;
    offset += BATCH_SIZE;
    process.stdout.write(`\r✅ Migrated: ${migrated}/${total} tiles`);
  }

  console.log(`\n🎉 Migration complete! ${migrated} tiles migrated to PostgreSQL.`);
  await mysqlConn.end();
  await pgPool.end();
}

main().catch(e => { console.error('❌ Migration failed:', e); process.exit(1); });
