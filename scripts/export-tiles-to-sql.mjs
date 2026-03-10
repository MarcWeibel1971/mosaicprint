/**
 * export-tiles-to-sql.mjs
 * Exports all mosaic_images from TiDB to a PostgreSQL-compatible SQL file.
 * This file is committed to git for permanent backup.
 * 
 * Usage:
 *   node scripts/export-tiles-to-sql.mjs
 */

import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../heartmosaic/.env') });

const DB_URL = process.env.DATABASE_URL || '';
const OUTPUT_FILE = path.join(__dirname, '../data/mosaic_tiles_seed.sql');
const BATCH_SIZE = 1000;

async function main() {
  const match = DB_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);
  if (!match) { console.error('❌ No valid DATABASE_URL found'); process.exit(1); }
  const [, user, pass, host, port, dbname] = match;

  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: pass,
    database: dbname, ssl: { rejectUnauthorized: false }
  });
  console.log('✅ Connected to TiDB');

  const [countRows] = await conn.execute('SELECT COUNT(*) as cnt FROM mosaic_images');
  const total = Number(countRows[0].cnt);
  console.log(`📊 Exporting ${total} tiles...`);

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const out = fs.createWriteStream(OUTPUT_FILE);

  out.write(`-- MosaicPrint tile seed data\n`);
  out.write(`-- Exported: ${new Date().toISOString()}\n`);
  out.write(`-- Total tiles: ${total}\n\n`);
  out.write(`CREATE TABLE IF NOT EXISTS mosaic_images (\n`);
  out.write(`  id SERIAL PRIMARY KEY,\n`);
  out.write(`  source_url TEXT NOT NULL,\n`);
  out.write(`  tile128_url TEXT,\n`);
  out.write(`  avg_l REAL DEFAULT 50, avg_a REAL DEFAULT 0, avg_b REAL DEFAULT 0,\n`);
  out.write(`  tl_l REAL DEFAULT 50, tl_a REAL DEFAULT 0, tl_b REAL DEFAULT 0,\n`);
  out.write(`  tr_l REAL DEFAULT 50, tr_a REAL DEFAULT 0, tr_b REAL DEFAULT 0,\n`);
  out.write(`  bl_l REAL DEFAULT 50, bl_a REAL DEFAULT 0, bl_b REAL DEFAULT 0,\n`);
  out.write(`  br_l REAL DEFAULT 50, br_a REAL DEFAULT 0, br_b REAL DEFAULT 0,\n`);
  out.write(`  created_at TIMESTAMPTZ DEFAULT NOW()\n`)
  out.write(`);\n\n`);

  let offset = 0;
  let exported = 0;

  while (offset < total) {
    const [rows] = await conn.execute(
      `SELECT source_url, tile128_url, avg_l, avg_a, avg_b,
              tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
              bl_l, bl_a, bl_b, br_l, br_a, br_b
       FROM mosaic_images ORDER BY id ASC LIMIT ${BATCH_SIZE} OFFSET ${offset}`
    );
    if (!rows.length) break;

    const vals = rows.map(r => {
      const esc = (v) => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
      const num = (v) => v === null || v === undefined ? '50' : Number(v).toFixed(4);
      return `(${esc(r.source_url)},${esc(r.tile128_url)},${num(r.avg_l)},${num(r.avg_a)},${num(r.avg_b)},${num(r.tl_l)},${num(r.tl_a)},${num(r.tl_b)},${num(r.tr_l)},${num(r.tr_a)},${num(r.tr_b)},${num(r.bl_l)},${num(r.bl_a)},${num(r.bl_b)},${num(r.br_l)},${num(r.br_a)},${num(r.br_b)})`;
    }).join(',\n');

    out.write(`INSERT INTO mosaic_images (source_url,tile128_url,avg_l,avg_a,avg_b,tl_l,tl_a,tl_b,tr_l,tr_a,tr_b,bl_l,bl_a,bl_b,br_l,br_a,br_b) VALUES\n${vals}\nON CONFLICT DO NOTHING;\n\n`);

    exported += rows.length;
    offset += BATCH_SIZE;
    process.stdout.write(`\r📦 Exported: ${exported}/${total}`);
  }

  out.end();
  await conn.end();
  console.log(`\n✅ Done! SQL file: ${OUTPUT_FILE} (${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => { console.error('❌ Export failed:', e); process.exit(1); });
