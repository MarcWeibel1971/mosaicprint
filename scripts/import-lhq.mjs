#!/usr/bin/env node
/**
 * import-lhq.mjs — Import LHQ (Landscapes HQ) Dataset into MosaicPrint
 *
 * Downloads and imports 90,000 landscape images from the LHQ dataset
 * (https://universome.github.io/alis) into the mosaic_images table.
 *
 * Usage:
 *   node scripts/import-lhq.mjs <path-to-lhq-images-dir> [--limit N] [--batch N] [--skip N]
 *
 * Examples:
 *   # Import from extracted LHQ directory
 *   node scripts/import-lhq.mjs ./data/lhq_1024_jpg
 *
 *   # Import first 1000 images only
 *   node scripts/import-lhq.mjs ./data/lhq_1024_jpg --limit 1000
 *
 *   # Resume from image 5000
 *   node scripts/import-lhq.mjs ./data/lhq_1024_jpg --skip 5000
 *
 * Prerequisites:
 *   1. Download LHQ dataset: python download_lhq.py lhq_1024_jpg
 *      (from https://github.com/MarcWeibel1971/alis)
 *   2. Extract the zip into a directory
 *   3. Set DATABASE_URL in .env
 *
 * The script:
 *   - Reads images from the directory
 *   - Computes LAB colors (global + 4 quadrants), edge energy, blur score, pHash
 *   - Inserts into mosaic_images with source_provider='lhq'
 *   - Skips duplicates (ON CONFLICT DO NOTHING)
 *   - Shows progress every 50 images
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Parse args
const args = process.argv.slice(2);
const imageDir = args.find(a => !a.startsWith('--'));
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1]) : Infinity;
const skipArg = args.indexOf('--skip');
const skip = skipArg >= 0 ? parseInt(args[skipArg + 1]) : 0;
const batchArg = args.indexOf('--batch');
const batchSize = batchArg >= 0 ? parseInt(args[batchArg + 1]) : 10;

if (!imageDir) {
  console.error('Usage: node scripts/import-lhq.mjs <path-to-lhq-images-dir> [--limit N] [--skip N] [--batch N]');
  console.error('');
  console.error('Download the LHQ dataset first:');
  console.error('  python download_lhq.py lhq_1024_jpg');
  console.error('  (from https://github.com/MarcWeibel1971/alis)');
  process.exit(1);
}

if (!fs.existsSync(imageDir)) {
  console.error(`Directory not found: ${imageDir}`);
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set in .env');
  process.exit(1);
}

// Dynamic imports
const pg = await import('pg');
const pool = new pg.default.Pool({ connectionString: DATABASE_URL });

async function computeLabForFile(filePath) {
  const { Jimp } = await import('jimp');

  const buf = fs.readFileSync(filePath);
  const image = await Jimp.fromBuffer(buf);

  // RGB to LAB conversion (matches server/colorUtils.ts)
  function toLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function rgbToLab(r, g, b) {
    const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);
    const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
    const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
    const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }

  function avgLabFromPixels(pixels, count) {
    let sL = 0, sA = 0, sB = 0;
    for (let i = 0; i < count; i++) {
      const [l, a, b] = rgbToLab(pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]);
      sL += l; sA += a; sB += b;
    }
    return { L: sL / count, a: sA / count, b: sB / count };
  }

  // 16x16 for edge detection
  const img16 = image.clone();
  img16.resize({ w: 16, h: 16 });
  const gray16 = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const rgba = img16.getPixelColor(x, y);
      const r = (rgba >> 24) & 0xff;
      const g = (rgba >> 16) & 0xff;
      const b = (rgba >> 8) & 0xff;
      gray16.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }

  // Sobel edge energy
  let sobelSum = 0, sobelCount = 0;
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 15; x++) {
      const idx = (r, c) => gray16[r * 16 + c];
      const gx = -idx(y-1,x-1) + idx(y-1,x+1) - 2*idx(y,x-1) + 2*idx(y,x+1) - idx(y+1,x-1) + idx(y+1,x+1);
      const gy = -idx(y-1,x-1) - 2*idx(y-1,x) - idx(y-1,x+1) + idx(y+1,x-1) + 2*idx(y+1,x) + idx(y+1,x+1);
      sobelSum += Math.sqrt(gx*gx + gy*gy);
      sobelCount++;
    }
  }
  const edgeDensity = sobelCount > 0 ? (sobelSum / sobelCount) / 1440 : 0;

  // 8x8 for LAB
  image.resize({ w: 8, h: 8 });
  const px = Buffer.allocUnsafe(8 * 8 * 3);
  let pi = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const rgba = image.getPixelColor(x, y);
      px[pi++] = (rgba >> 24) & 0xff;
      px[pi++] = (rgba >> 16) & 0xff;
      px[pi++] = (rgba >> 8) & 0xff;
    }
  }

  const global = avgLabFromPixels(px, 64);

  // Quadrants (4x4 each from 8x8)
  function extractQuadrant(startX, startY) {
    const qpx = Buffer.allocUnsafe(16 * 3);
    let qi = 0;
    for (let y = startY; y < startY + 4; y++) {
      for (let x = startX; x < startX + 4; x++) {
        const src = (y * 8 + x) * 3;
        qpx[qi++] = px[src]; qpx[qi++] = px[src + 1]; qpx[qi++] = px[src + 2];
      }
    }
    return qpx;
  }
  const tl = avgLabFromPixels(extractQuadrant(0, 0), 16);
  const tr = avgLabFromPixels(extractQuadrant(4, 0), 16);
  const bl = avgLabFromPixels(extractQuadrant(0, 4), 16);
  const br = avgLabFromPixels(extractQuadrant(4, 4), 16);

  // Complexity score
  const chromas = [tl, tr, bl, br].map(q => Math.sqrt(q.a**2 + q.b**2));
  const meanChroma = chromas.reduce((s, v) => s + v, 0) / 4;
  const chromaVarNorm = Math.min(chromas.reduce((s, v) => s + (v - meanChroma)**2, 0) / 4 / 2500, 1);
  const buckets = new Set();
  for (const g of gray16) buckets.add(Math.floor(g / 16));
  const pixelDiversity = buckets.size / 16;
  const quadLs = [tl.L, tr.L, bl.L, br.L];
  const meanL = quadLs.reduce((s, v) => s + v, 0) / 4;
  const varLNorm = Math.min(quadLs.reduce((s, v) => s + (v - meanL)**2, 0) / 4 / 2500, 1);
  const complexity = edgeDensity * 0.5 + chromaVarNorm * 0.2 + pixelDiversity * 0.2 + varLNorm * 0.1;
  const tileType = complexity < 0.18 ? 'calm' : complexity > 0.38 ? 'busy' : 'medium';

  // Blur score (Laplacian variance)
  let lapSum = 0, lapCount = 0;
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 15; x++) {
      const idx = (r, c) => gray16[r * 16 + c];
      const lap = idx(y-1,x) + idx(y+1,x) + idx(y,x-1) + idx(y,x+1) - 4 * idx(y,x);
      lapSum += lap * lap;
      lapCount++;
    }
  }
  const blurScore = lapCount > 0 ? lapSum / lapCount : 0;

  // pHash (average hash)
  const gray8 = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      gray8.push(gray16[(y*2)*16 + (x*2)]);
    }
  }
  const meanGray = gray8.reduce((s, v) => s + v, 0) / 64;
  let hashBits = '';
  for (const g of gray8) hashBits += g > meanGray ? '1' : '0';
  let pHash = '';
  for (let i = 0; i < 64; i += 4) pHash += parseInt(hashBits.slice(i, i + 4), 2).toString(16);

  // Mosaic score
  const sharpnessScore = Math.min(1, blurScore / 300);
  const chromaScore = Math.min(1, Math.sqrt(global.a**2 + global.b**2) / 40);
  const edgeScore = Math.min(1, edgeDensity / 0.3);
  const mosaicScore = 0.4 * sharpnessScore + 0.3 * chromaScore + 0.3 * edgeScore;

  // Generate tile128 data URL
  const { default: sharp } = await import('sharp');
  const tile128 = await sharp(buf).resize(128, 128, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
  const tile128Url = `data:image/jpeg;base64,${tile128.toString('base64')}`;

  return {
    global, tl, tr, bl, br,
    tileType, edgeDensity, blurScore, pHash, mosaicScore, tile128Url,
  };
}

// Main
async function main() {
  // List image files
  const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const allFiles = fs.readdirSync(imageDir)
    .filter(f => extensions.has(path.extname(f).toLowerCase()))
    .sort();

  const files = allFiles.slice(skip, skip + limit);
  console.log(`[LHQ Import] Found ${allFiles.length} images in ${imageDir}`);
  console.log(`[LHQ Import] Processing ${files.length} images (skip=${skip}, limit=${limit === Infinity ? 'all' : limit})`);
  console.log(`[LHQ Import] Batch size: ${batchSize} concurrent`);
  console.log();

  const sessionId = crypto.randomUUID();
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const filePath = path.join(imageDir, file);
        const sourceUrl = `lhq://${file}`; // Unique identifier

        try {
          const lab = await computeLabForFile(filePath);

          // Derive semantic theme
          const isSkinFriendly = Math.sqrt(lab.global.a**2 + lab.global.b**2) < 25
            && lab.global.L >= 35 && lab.global.L <= 80;

          await pool.query(
            `INSERT INTO mosaic_images
              (source_url, tile128_url, avg_l, avg_a, avg_b,
               tl_l, tl_a, tl_b, tr_l, tr_a, tr_b,
               bl_l, bl_a, bl_b, br_l, br_a, br_b,
               subject, theme, source_provider, import_query, url_hash, imported_at,
               tile_type, edge_energy, phash, ai_mosaic_score,
               import_session_id, quality_status, is_skin_friendly)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                    $18,$18,$19,$20,MD5($1),NOW(),$21,$22,$23,$24,$25,'approved',$26)
            ON CONFLICT (source_url) DO NOTHING`,
            [
              sourceUrl, lab.tile128Url,
              lab.global.L, lab.global.a, lab.global.b,
              lab.tl.L, lab.tl.a, lab.tl.b,
              lab.tr.L, lab.tr.a, lab.tr.b,
              lab.bl.L, lab.bl.a, lab.bl.b,
              lab.br.L, lab.br.a, lab.br.b,
              'landscape',               // theme
              'lhq',                     // source_provider
              file,                      // import_query (filename)
              lab.tileType,              // tile_type
              lab.edgeDensity,           // edge_energy
              lab.pHash,                 // phash
              Math.round(lab.mosaicScore * 100), // ai_mosaic_score (0-100)
              sessionId,                 // import_session_id
              isSkinFriendly,            // is_skin_friendly
            ]
          );
          return 'inserted';
        } catch (e) {
          return 'error:' + String(e).slice(0, 100);
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value === 'inserted') inserted++;
        else skipped++;
      } else {
        errors++;
      }
    }

    // Progress
    const processed = Math.min(i + batchSize, files.length);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (processed / parseFloat(elapsed)).toFixed(1);
    const eta = ((files.length - processed) / parseFloat(rate)).toFixed(0);
    if (processed % 50 < batchSize || processed === files.length) {
      console.log(`[${processed}/${files.length}] ${inserted} inserted, ${skipped} skipped, ${errors} errors | ${rate}/s | ETA: ${eta}s`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log(`[LHQ Import] Done in ${totalTime}s`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (duplicates): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Session ID: ${sessionId}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
