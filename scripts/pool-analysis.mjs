// Pool analysis script - run with: node scripts/pool-analysis.mjs
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);

// Load env vars manually
try {
  const envContent = readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.log('No DATABASE_URL'); process.exit(1); }

const { Pool } = require('pg');
// Try without SSL first (local), then with SSL (remote)
let pool;
try {
  pool = new Pool({ connectionString: dbUrl, ssl: false });
  await pool.query('SELECT 1');
} catch {
  pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
}

async function analyze() {
  // Overall stats
  const overall = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN tile_type='calm' THEN 1 END) as calm,
      COUNT(CASE WHEN tile_type='medium' THEN 1 END) as medium,
      COUNT(CASE WHEN tile_type='busy' THEN 1 END) as busy,
      COUNT(CASE WHEN COALESCE(quality_status,'pending')='approved' THEN 1 END) as approved,
      COUNT(CASE WHEN COALESCE(quality_status,'pending')='rejected' THEN 1 END) as rejected,
      ROUND(AVG(avg_l)::numeric,1) as avg_l,
      COUNT(CASE WHEN avg_l>70 THEN 1 END) as bright,
      COUNT(CASE WHEN avg_l<35 THEN 1 END) as dark,
      COUNT(CASE WHEN avg_l BETWEEN 35 AND 70 THEN 1 END) as mid,
      COUNT(CASE WHEN avg_saturation<15 THEN 1 END) as low_sat,
      COUNT(CASE WHEN avg_saturation BETWEEN 15 AND 40 THEN 1 END) as mid_sat,
      COUNT(CASE WHEN avg_saturation>40 THEN 1 END) as high_sat
    FROM mosaic_images
    WHERE COALESCE(quality_status,'pending') != 'rejected'
  `);
  console.log('\n=== POOL OVERVIEW ===');
  console.log(JSON.stringify(overall.rows[0], null, 2));

  // Calm tiles by brightness band
  const calmByBrightness = await pool.query(`
    SELECT
      CASE WHEN avg_l < 20 THEN 'very_dark(0-20)'
           WHEN avg_l < 35 THEN 'dark(20-35)'
           WHEN avg_l < 50 THEN 'mid_dark(35-50)'
           WHEN avg_l < 65 THEN 'mid(50-65)'
           WHEN avg_l < 80 THEN 'bright(65-80)'
           ELSE 'very_bright(80+)' END as band,
      COUNT(*) as total,
      COUNT(CASE WHEN tile_type='calm' THEN 1 END) as calm,
      COUNT(CASE WHEN tile_type='medium' THEN 1 END) as medium,
      COUNT(CASE WHEN tile_type='busy' THEN 1 END) as busy
    FROM mosaic_images
    WHERE COALESCE(quality_status,'pending') != 'rejected' AND avg_l IS NOT NULL
    GROUP BY 1 ORDER BY MIN(avg_l)
  `);
  console.log('\n=== CALM/MEDIUM/BUSY BY BRIGHTNESS BAND ===');
  for (const r of calmByBrightness.rows) {
    const total = Number(r.total);
    const calmPct = total > 0 ? Math.round(Number(r.calm)/total*100) : 0;
    console.log(`${r.band}: total=${r.total}, calm=${r.calm}(${calmPct}%), medium=${r.medium}, busy=${r.busy}`);
  }

  // LAB color coverage gaps (8-unit grid)
  const labGaps = await pool.query(`
    SELECT
      ROUND(avg_l/10)*10 as l_band,
      ROUND(avg_a/10)*10 as a_band,
      ROUND(avg_b/10)*10 as b_band,
      COUNT(*) as cnt,
      COUNT(CASE WHEN tile_type='calm' THEN 1 END) as calm_cnt
    FROM mosaic_images
    WHERE COALESCE(quality_status,'pending') != 'rejected' AND avg_l IS NOT NULL
    GROUP BY 1,2,3
    HAVING COUNT(*) < 3
    ORDER BY cnt ASC
    LIMIT 30
  `);
  console.log('\n=== SPARSE LAB ZONES (< 3 tiles) ===');
  for (const r of labGaps.rows) {
    console.log(`L=${r.l_band} a=${r.a_band} b=${r.b_band}: ${r.cnt} tiles (${r.calm_cnt} calm)`);
  }

  // Top themes
  const themes = await pool.query(`
    SELECT COALESCE(theme, 'untagged') as theme, COUNT(*) as cnt,
      COUNT(CASE WHEN tile_type='calm' THEN 1 END) as calm
    FROM mosaic_images
    WHERE COALESCE(quality_status,'pending') != 'rejected'
    GROUP BY 1 ORDER BY cnt DESC LIMIT 20
  `);
  console.log('\n=== TOP THEMES ===');
  for (const r of themes.rows) {
    console.log(`${r.theme}: ${r.cnt} tiles (${r.calm} calm)`);
  }

  await pool.end();
}

analyze().catch(e => { console.error(e); pool.end(); });
