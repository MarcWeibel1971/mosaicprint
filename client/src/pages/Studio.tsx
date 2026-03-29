import React, { useState, useCallback, useRef, useEffect } from "react";
import ReactCrop, { type Crop, type PixelCrop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
gsap.registerPlugin(useGSAP);
import { loadStripe } from "@stripe/stripe-js";
import { Link, useSearchParams } from "react-router-dom";
import {
  Upload, ZoomIn, ZoomOut, Download, Printer, Eye,
  Loader2, X, RefreshCw, ChevronDown, Check,
  ImagePlus, Images, Sparkles, Grid3X3, Palette, BarChart3,
  Save, FolderOpen, Info, Search, SlidersHorizontal
} from "lucide-react";
import { buildUnsplashPool, UNSPLASH_PHOTO_IDS } from "../lib/unsplash-pool";
import { rgbToLab, toLinear, deltaE2000 } from "../lib/colorUtils";
import { loadImageCached, getMemoryCacheSize, getIDBCacheSize, warmUpCache } from "../lib/image-cache";
import { loadTileAtlas, clearAtlasCache } from "../lib/tile-atlas";
import { useAuth } from "../contexts/AuthContext";
import MosaicProgress from "../components/MosaicProgress";


// Canvas-based face/skin detection (replaces MediaPipe to avoid WASM issues)
// Detects skin-tone pixels using LAB color space heuristics and returns bounding boxes
function detectFaceRegionsCanvas(img: HTMLImageElement): Array<{x: number; y: number; w: number; h: number}> {
  try {
    const SIZE = 128;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    // rgbToLab und toLinear aus colorUtils (keine lokale Duplikation mehr)
    // Build skin-pixel mask: warm (a>3, b>5), medium brightness (L 30-85), low-medium chroma
    const skinMask = new Uint8Array(SIZE * SIZE);
    let skinCount = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      const [labL, labA, labB] = rgbToLab(r, g, b);
      const chroma = Math.sqrt(labA*labA + labB*labB);
      if (labA > 2 && labB > 4 && labL > 28 && labL < 88 && chroma < 50) {
        skinMask[i] = 1; skinCount++;
      }
    }
    if (skinCount / (SIZE * SIZE) < 0.08) return []; // not enough skin pixels
    // Find connected skin regions using simple flood-fill bounding boxes
    const visited = new Uint8Array(SIZE * SIZE);
    const regions: Array<{x: number; y: number; w: number; h: number}> = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (!skinMask[i] || visited[i]) continue;
      // BFS to find connected region
      const queue = [i]; visited[i] = 1;
      let minX = SIZE, minY = SIZE, maxX = 0, maxY = 0, count = 0;
      while (queue.length > 0) {
        const idx = queue.pop()!;
        const px = idx % SIZE, py = Math.floor(idx / SIZE);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        count++;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = px+dx, ny = py+dy;
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
          const ni = ny*SIZE+nx;
          if (skinMask[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
        }
      }
      if (count > 50) { // minimum region size
        regions.push({ x: minX/SIZE, y: minY/SIZE, w: (maxX-minX)/SIZE, h: (maxY-minY)/SIZE });
      }
    }
    // Merge overlapping regions
    return regions.slice(0, 5); // max 5 face regions
  } catch { return []; }
}

// Face subregion types for per-region matching weights
type FaceSubRegion = 'eye' | 'mouth' | 'nose' | 'cheek' | 'forehead' | null;

// MediaPipe Face Mesh landmark index groups (subset of 468 landmarks)
// Reference: https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
// FACE_LANDMARK_GROUPS removed - using Canvas-based skin detection instead
// -- Picsum fallback pool ------------------------------------------------------
const PICSUM_IDS: number[] = (() => {
  // IDs that return 404 on picsum.photos (verified via API)
  const skip = new Set([
    86, 97, 105, 138, 148, 150, 205, 207, 224, 226, 245, 246, 262, 285, 286,
    298, 303, 332, 333, 346, 359, 394, 414, 422, 438, 462, 463, 470, 489, 540,
    561, 578, 587, 589, 592, 595, 597, 601, 624, 632, 636, 644, 647, 673, 697,
    706, 707, 708, 709, 710, 711, 712, 713, 714, 720, 725, 734, 745, 746, 747,
    748, 749, 750, 751, 752, 753, 754, 759, 761, 762, 763, 771, 792, 801, 812,
    843, 850, 854, 895, 897, 899, 917, 920, 934, 956, 963, 968, 1007, 1017,
    1030, 1034, 1046,
  ]);
  const ids: number[] = [];
  for (let i = 0; i <= 1084; i++) if (!skip.has(i)) ids.push(i);
  return ids;
})();

function buildPhotoPool(_size: number): string[] {
  // Always load at 64px for reliable loading (Canvas downscales for display)
  const LOAD_SIZE = 64;
  const unsplash = buildUnsplashPool(LOAD_SIZE);
  const picsum = PICSUM_IDS.map(id => `https://picsum.photos/id/${id}/${LOAD_SIZE}/${LOAD_SIZE}`);
  return [...unsplash, ...picsum];
}

function getPhotoUrls(count: number, tileSize: number): string[] {
  const pool = buildPhotoPool(tileSize);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (count <= pool.length) return pool.slice(0, count);
  const urls: string[] = [...pool];
  while (urls.length < count) {
    const extra = [...pool];
    for (let i = extra.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [extra[i], extra[j]] = [extra[j], extra[i]];
    }
    urls.push(...extra);
  }
  return urls.slice(0, count);
}

// loadImage is replaced by loadImageCached from image-cache.ts

// Poll server for render job completion (robust fallback — works through any proxy)
async function pollForResult(
  jobId: string,
  onProgress?: (p: number) => void,
  onMessage?: (m: string) => void,
): Promise<{ token: string; filename: string; size: number }> {
  const deadline = Date.now() + 15 * 60 * 1000; // 15 min max
  let lastProgress = 0;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`/api/print-job/${jobId}`);
      if (r.ok) {
        const data = await r.json();
        if (data.progress && data.progress >= lastProgress) {
          lastProgress = data.progress;
          onProgress?.(data.progress);
        }
        if (data.message) onMessage?.(data.message);
        if (data.error) throw new Error(data.message || 'Server-Fehler');
        if (data.done && data.result) return data.result;
      }
    } catch (e: any) {
      if (e?.message?.includes('Server-Fehler')) throw e;
      // Network error — retry
    }
    await new Promise(r => setTimeout(r, 1500)); // poll every 1.5s
  }
  throw new Error('Zeitüberschreitung (15 Min) – bitte erneut versuchen');
}

/**
 * Force-download a Blob as a file, bypassing Chrome's PDF viewer interception.
 * Chrome + Adobe Acrobat extension can intercept blob: URLs and open them as PDF.
 * This helper uses multiple strategies to ensure the file is saved correctly.
 */
async function forceDownloadBlob(blob: Blob, filename: string, mimeType: string) {
  // Strategy 1: Upload blob to server, then open /api/print-download/:token
  // This is the most reliable method: server sends Content-Disposition: attachment
  // which Chrome always treats as a download, bypassing Adobe Acrobat extension
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const response = await fetch('/api/temp-blob', {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: arrayBuffer,
    });
    if (response.ok) {
      const { token } = await response.json();
      // Navigate directly to the server download URL.
      // Server sets Content-Disposition: attachment + X-Content-Type-Options: nosniff
      // Using window.location.href bypasses Adobe Acrobat extension completely
      // (it only intercepts blob: URLs and synthetic <a> clicks, not real navigations)
      const downloadUrl = `/api/print-download/${token}?filename=${encodeURIComponent(filename)}`;
      window.location.href = downloadUrl;
      return;
    }
  } catch (e) {
    console.warn('[forceDownloadBlob] Server upload failed, falling back to blob URL:', e);
  }
  
  // Fallback: direct blob URL download
  const typedBlob = new Blob([blob], { type: mimeType });
  const url = URL.createObjectURL(typedBlob);
  const dlLink = document.createElement('a');
  dlLink.href = url;
  dlLink.download = filename;
  dlLink.type = mimeType;
  dlLink.style.display = 'none';
  dlLink.rel = 'noopener';
  document.body.appendChild(dlLink);
  dlLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  setTimeout(() => { document.body.removeChild(dlLink); URL.revokeObjectURL(url); }, 15000);
}

/**
 * Client-side mosaic print rendering.
 * Renders the mosaic at high resolution using already-loaded tile images,
 * applies contrast + soft-light overlay, and returns a downloadable Blob.
 * Completely bypasses the server — no tile downloads needed.
 */
async function renderMosaicClientSide(opts: {
  cols: number; rows: number; tilePx: number; format: 'jpg' | 'png';
  assignment: number[]; rotations: number[]; tileIds: number[];
  validImgs: HTMLImageElement[]; hiResImgs: (HTMLImageElement | null)[];
  snapshot: ImageData | null; origTilePx: number;
  targetColors: number[]; edgeMap: number[]; faceMask: boolean[];
  cellLab?: [number, number, number][]; // LAB target per cell (blurred+original mix) for accurate color correction
  userOverlay?: number; // 0-100: how much original photo shows through (from Foto-Overlay slider)
  userPhotoImg?: HTMLImageElement | null; // original user photo for overlay
  onProgress?: (pct: number, msg: string) => void;
}): Promise<{ blob: Blob; width: number; height: number; filename: string }> {
  const { cols, rows, tilePx, format, assignment, rotations, tileIds, validImgs, hiResImgs,
    snapshot, origTilePx, targetColors: tc, edgeMap: em, faceMask: fm,
    cellLab: cellLabData,
    userOverlay = 0, userPhotoImg = null, onProgress } = opts;
  const algoSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();

  onProgress?.(2, 'Tiles prüfen...');

  // Pre-check: count how many tile images are still available
  const uniqueIdxs = [...new Set(assignment)];
  let missingCount = 0;
  const missingIdxs = new Set<number>();
  for (const idx of uniqueIdxs) {
    const hiImg = hiResImgs[idx];
    const img = (hiImg && hiImg.complete && hiImg.naturalWidth > 0) ? hiImg : validImgs[idx];
    if (!img || !img.complete || img.naturalWidth === 0) {
      missingCount++;
      missingIdxs.add(idx);
    }
  }
  console.log(`[PrintRender] ${uniqueIdxs.length} unique tiles, ${missingCount} missing (GC'd)`);

  // HI-RES RELOAD: For print quality, load ALL DB tiles via source_url (original ~940px from Pexels/Unsplash).
  // Strategy: use /api/tile-urls?hires=1 to get direct source_url for each tile,
  // then load images directly from source (bypasses server proxy, avoids 128px upscale).
  // Fallback: /api/tile/:id?size=400 (server proxy) if direct load fails.
  const hiResReloadMap: Record<number, HTMLImageElement> = {};
  const hiResNeeded = uniqueIdxs.filter(idx => {
    const dbId = tileIds[idx];
    return dbId && dbId > 0; // reload all DB tiles, skip user tiles
  });
  console.log(`[PrintRender] Hi-res reload: ${hiResNeeded.length}/${uniqueIdxs.length} DB tiles via source_url`);
  if (hiResNeeded.length > 0) {
    onProgress?.(3, `${hiResNeeded.length} Tiles in Druckqualität laden...`);

    // Step 1: Fetch source_url for all DB tiles via /api/tile-urls?hires=1
    const dbIds = hiResNeeded.map(idx => tileIds[idx]).filter(id => id > 0);
    let sourceUrlMap: Record<number, string> = {};
    try {
      const urlRes = await fetch(`/api/tile-urls?ids=${dbIds.join(',')}&hires=1`);
      if (urlRes.ok) {
        const data = await urlRes.json() as Record<string, string>;
        // Convert string keys to number keys
        for (const [k, v] of Object.entries(data)) { if (v) sourceUrlMap[Number(k)] = v; }
        console.log(`[PrintRender] Got ${Object.keys(sourceUrlMap).length} source URLs`);
      }
    } catch (e) {
      console.warn('[PrintRender] Failed to fetch source URLs, will use proxy fallback', e);
    }

    let loaded = 0;
    let failed = 0;
    const BATCH = 6; // small batches for reliable mobile loading

    // Helper: load image with retry, trying source_url first then proxy fallback
    const loadTileHiRes = (idx: number): Promise<HTMLImageElement | null> => {
      const dbId = tileIds[idx];
      const sourceUrl = sourceUrlMap[dbId];
      return new Promise(resolve => {
        const tryLoad = (url: string, retries: number, isFallback: boolean) => {
          const img = new Image();
          // crossOrigin needed for canvas operations when loading from external URLs
          if (!url.startsWith('/')) img.crossOrigin = 'anonymous';
          const timeout = setTimeout(() => {
            img.onload = img.onerror = null;
            console.warn(`[PrintRender] Tile ${dbId} timeout (${url.substring(0, 60)})`);
            if (retries > 0) { setTimeout(() => tryLoad(url, retries - 1, isFallback), 500); }
            else if (!isFallback && sourceUrl) {
              // Try proxy fallback
              console.warn(`[PrintRender] Tile ${dbId} source_url failed, trying proxy`);
              tryLoad(`/api/tile/${dbId}?size=400&t=${Date.now()}`, 2, true);
            } else { resolve(null); }
          }, 12000);
          img.onload = () => {
            clearTimeout(timeout);
            if (img.naturalWidth < 10 || img.naturalHeight < 10) {
              if (retries > 0) { setTimeout(() => tryLoad(url, retries - 1, isFallback), 300); }
              else if (!isFallback && sourceUrl) { tryLoad(`/api/tile/${dbId}?size=400&t=${Date.now()}`, 2, true); }
              else { resolve(null); }
            } else {
              console.log(`[PrintRender] Tile ${dbId} loaded at ${img.naturalWidth}x${img.naturalHeight} (${isFallback ? 'proxy' : 'source'})`);
              resolve(img);
            }
          };
          img.onerror = () => {
            clearTimeout(timeout);
            if (retries > 0) { setTimeout(() => tryLoad(url, retries - 1, isFallback), 500); }
            else if (!isFallback && sourceUrl) {
              console.warn(`[PrintRender] Tile ${dbId} source_url error, trying proxy`);
              tryLoad(`/api/tile/${dbId}?size=400&t=${Date.now()}`, 2, true);
            } else { resolve(null); }
          };
          img.src = url;
        };
        // Start with source_url if available, otherwise use proxy directly
        const startUrl = sourceUrl || `/api/tile/${dbId}?size=400&t=${Date.now()}`;
        const isFallback = !sourceUrl;
        tryLoad(startUrl, 2, isFallback);
      });
    };

    for (let i = 0; i < hiResNeeded.length; i += BATCH) {
      const batch = hiResNeeded.slice(i, i + BATCH);
      await Promise.all(batch.map(async (idx) => {
        const dbId = tileIds[idx];
        if (!dbId || dbId <= 0) return;
        const img = await loadTileHiRes(idx);
        if (img && img.naturalWidth >= 10) {
          hiResReloadMap[idx] = img;
          loaded++;
        } else {
          failed++;
          console.error(`[PrintRender] FAILED to load tile ${dbId}`);
        }
      }));
      onProgress?.(3 + Math.round((loaded / hiResNeeded.length) * 12), `Hi-Res laden: ${loaded}/${hiResNeeded.length}`);
      await new Promise(r => setTimeout(r, 0));
    }
    console.log(`[PrintRender] Hi-res done: ${loaded} loaded, ${failed} failed out of ${hiResNeeded.length}`);
  }

  onProgress?.(15, 'Canvas erstellen...');

  // Create canvas with progressive fallback
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let actualTile = tilePx;
  for (const tryTile of [tilePx, Math.floor(tilePx * 0.75), Math.floor(tilePx * 0.5), 64]) {
    const c = document.createElement('canvas');
    c.width = cols * tryTile; c.height = rows * tryTile;
    const cx = c.getContext('2d');
    if (cx) { cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'; canvas = c; ctx = cx; actualTile = tryTile; break; }
  }
  if (!canvas || !ctx) throw new Error('Canvas creation failed');
  const W = canvas.width, H = canvas.height;

  // Snapshot fallback for GC'd images
  const snapCanvas = document.createElement('canvas');
  const snapCtx = snapCanvas.getContext('2d');
  if (snapshot && snapCtx) { snapCanvas.width = snapshot.width; snapCanvas.height = snapshot.height; snapCtx.putImageData(snapshot, 0, 0); }

  // Draw tiles with per-tile LAB color transfer (matches preview quality)
  const total = cols * rows;
  // PRINT: Use same contrast boost as preview (avgL is now consistent via 8x8 downsample)
  const cBoost = algoSettings.contrastBoost ?? 1.30;
  const histBlend = algoSettings.histogramBlend ?? 0.0;
  const blendFactor = Math.min(1.0, histBlend / 0.10);
  // LAB parameters match preview exactly — avgL consistency is now ensured by 8x8 downsample
  // (same as preview which computes avgL on 64px thumbnails = equivalent low-freq reference)
  const L_BLEND  = 0.40 + 0.40 * blendFactor;  // matches preview
  const AB_BLEND = 0.12 + 0.20 * blendFactor;  // matches preview
  const MAX_COLOR_SHIFT = 18;  // matches preview
  const MAX_BLUE_SHIFT = 10;   // matches preview

  // Overlay parameters (needed inside tile loop for inline overlay application)
  const BASE_OL = algoSettings.baseOverlay ?? 0.15;
  const EDGE_B = algoSettings.edgeBoost ?? 0.20;
  const olMode = algoSettings.overlayMode ?? 'none';

  // Offscreen buffer canvas for per-tile LAB processing (reused across all tiles)
  const bCanvas = document.createElement('canvas');
  bCanvas.width = actualTile; bCanvas.height = actualTile;
  const bCtx = bCanvas.getContext('2d')!;
  // Direct pixel subsampling for avgL (no extra canvas needed)
  // Sample every Nth pixel from getImageData for consistent avgL with preview
  const REF_SAMPLES = 64; // 8x8 equivalent sample count

  for (let ci = 0; ci < total; ci++) {
    const col = ci % cols, row = Math.floor(ci / cols);
    const x = col * actualTile, y = row * actualTile;
    const idx = assignment[ci];
    // Priority: hi-res reloaded > existing hiResImgs > validImgs (thumbnail)
    const reloadedImg = hiResReloadMap[idx];
    const hiImg = reloadedImg || hiResImgs[idx];
    const img = (hiImg && hiImg.complete && hiImg.naturalWidth > 0) ? hiImg : validImgs[idx];
    const rot = rotations[ci] || 0;
    const tci = ci * 3;
    const tR = tc.length > tci+2 ? tc[tci] : 128;
    const tG = tc.length > tci+2 ? tc[tci+1] : 128;
    const tBv = tc.length > tci+2 ? tc[tci+2] : 128;
    // Use cellLab if available (blurred+original mix, same as renderMosaic) for accurate color correction
    // Fallback: compute from raw targetColors (100% original, slightly different)
    const [tL, tA, tB] = (cellLabData && cellLabData.length > ci) ? cellLabData[ci] : rgbToLab(tR, tG, tBv);

    if (img && img.complete && img.naturalWidth > 0) {
      try {
        // Draw tile to offscreen buffer for pixel manipulation
        bCtx.clearRect(0, 0, actualTile, actualTile);
        if (rot === 0) { bCtx.drawImage(img, 0, 0, actualTile, actualTile); }
        else { bCtx.save(); bCtx.translate(actualTile/2, actualTile/2); bCtx.rotate(rot * Math.PI/2); bCtx.drawImage(img, -actualTile/2, -actualTile/2, actualTile, actualTile); bCtx.restore(); }

        // Per-tile LAB color transfer (same as preview rendering)
        const isShadowZone = tL < 40;
        const shadowBoost = isShadowZone ? Math.max(0, (40 - tL) / 40) : 0;
        const effectiveL_BLEND = Math.min(0.98, L_BLEND + shadowBoost * 0.50);

        const tilePixels = bCtx.getImageData(0, 0, actualTile, actualTile);
        const td = tilePixels.data;
        // Compute tile average L by direct subsampling of getImageData (no extra canvas).
        // Sample REF_SAMPLES evenly-spaced pixels — equivalent to 8x8 downsample.
        const totalPx = td.length / 4;
        const step = Math.max(1, Math.floor(totalPx / REF_SAMPLES));
        let sumL = 0, sampleCount = 0;
        for (let si = 0; si < totalPx; si += step) {
          const spi = si * 4;
          sumL += rgbToLab(td[spi], td[spi+1], td[spi+2])[0];
          sampleCount++;
        }
        const avgL = sampleCount > 0 ? sumL / sampleCount : 50;
        const rawLumScale = avgL > 1 ? tL / avgL : 1;
        const maxLumScale = isShadowZone ? Math.min(1.0, rawLumScale) : rawLumScale;
        const clampedLumScale = Math.max(0.05, Math.min(4.0, maxLumScale));
        const lumScale = 1 + (clampedLumScale - 1) * effectiveL_BLEND;

        // Pre-compute overlay strength for this tile (avoid per-pixel recompute)
        const edge = em.length > ci ? em[ci] : 0;
        const fb = fm.length > ci && fm[ci] ? 0.04 : 0;
        const str = olMode !== 'none' ? Math.min(0.30, BASE_OL + edge*EDGE_B + fb) : 0;
        const applyOverlay = str > 0.01;

        const outData = new Uint8ClampedArray(td.length);
        for (let pi = 0; pi < td.length; pi += 4) {
          const [pl, pa, pb] = rgbToLab(td[pi], td[pi+1], td[pi+2]);
          let newL = Math.max(0, Math.min(100, pl * lumScale));
          if (isShadowZone && shadowBoost > 0.05) {
            const deviation = pl - avgL;
            const stretchFactor = 1.0 + shadowBoost * 0.4;
            newL = Math.max(0, Math.min(100, (newL + deviation * (stretchFactor - 1.0))));
          }
          if (isShadowZone && newL > tL + 25) {
            newL = tL + 25 + (newL - tL - 25) * 0.2;
          }
          const rawDeltaA = (tA - pa) * AB_BLEND;
          const rawDeltaB = (tB - pb) * AB_BLEND;
          const clampedDeltaA = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, rawDeltaA));
          const clampedDeltaB = rawDeltaB < 0
            ? Math.max(-MAX_BLUE_SHIFT, rawDeltaB)
            : Math.min(MAX_COLOR_SHIFT, rawDeltaB);
          const newA = Math.max(-128, Math.min(127, pa + clampedDeltaA));
          const newBv = Math.max(-128, Math.min(127, pb + clampedDeltaB));
          const contrastL = Math.max(0, Math.min(100, 50 + (newL - 50) * cBoost));
          const satBoost = 0.90 + cBoost * 0.15;
          const boostedA = Math.max(-128, Math.min(127, newA * satBoost));
          const bSatBoost = newBv < 0 ? Math.min(satBoost, 1.0) : satBoost;
          const boostedB = Math.max(-128, Math.min(127, newBv * bSatBoost));
          let [nr, ng, nb] = labToRgb(contrastL, boostedA, boostedB);
          // Apply overlay inline (avoids second full-image pass)
          if (applyOverlay) {
            if (olMode === 'softlight') {
              const sl2 = (base: number, blend: number) => { const b2=blend/255,s=base/255; return Math.round((b2<0.5?s-(1-2*b2)*s*(1-s):s+(2*b2-1)*(Math.sqrt(s)-s))*255); };
              nr = Math.round(nr*(1-str)+sl2(nr,tR)*str);
              ng = Math.round(ng*(1-str)+sl2(ng,tG)*str);
              nb = Math.round(nb*(1-str)+sl2(nb,tBv)*str);
            } else {
              nr = Math.round(nr*(1-str)+tR*str);
              ng = Math.round(ng*(1-str)+tG*str);
              nb = Math.round(nb*(1-str)+tBv*str);
            }
          }
          outData[pi]   = nr;
          outData[pi+1] = ng;
          outData[pi+2] = nb;
          outData[pi+3] = td[pi+3];
        }
        const outImageData = bCtx.createImageData(actualTile, actualTile);
        outImageData.data.set(outData);
        bCtx.putImageData(outImageData, 0, 0);
        ctx.drawImage(bCanvas, x, y, actualTile, actualTile);
      } catch {
        // Fallback: use snapshot canvas if available, otherwise fill with target color
        let usedSnap = false;
        if (snapCtx && snapshot && snapshot.width > 0 && snapshot.height > 0) {
          try {
            const snapTW = snapshot.width / cols;
            const snapTH = snapshot.height / rows;
            ctx.drawImage(snapCanvas, col * snapTW, row * snapTH, snapTW, snapTH, x, y, actualTile, actualTile);
            usedSnap = true;
          } catch { /* fall through */ }
        }
        if (!usedSnap) {
          ctx.fillStyle = `rgb(${tR},${tG},${tBv})`;
          ctx.fillRect(x, y, actualTile, actualTile);
        }
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[PrintRender] Tile ci=${ci} idx=${idx} LAB transfer failed, using ${usedSnap ? 'snapshot' : 'target color'}`);
        }
      }
    } else {
      // Fallback: use snapshot canvas (preview quality) instead of flat target color
      // This prevents visible bright/flat patches in the print output
      let usedSnapshot = false;
      if (snapCtx && snapshot && snapshot.width > 0 && snapshot.height > 0) {
        try {
          // Map print tile position to snapshot coordinates
          const snapTileW = snapshot.width / cols;
          const snapTileH = snapshot.height / rows;
          const sx = col * snapTileW;
          const sy = row * snapTileH;
          // Draw the snapshot region scaled up to the print tile size
          ctx.drawImage(snapCanvas, sx, sy, snapTileW, snapTileH, x, y, actualTile, actualTile);
          usedSnapshot = true;
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[PrintRender] Tile ci=${ci} idx=${idx} missing, used snapshot fallback`);
          }
        } catch {
          // Snapshot extraction failed, fall through to target color
        }
      }
      if (!usedSnapshot) {
        ctx.fillStyle = tc.length > tci+2 ? `rgb(${tR},${tG},${tBv})` : '#888';
        ctx.fillRect(x, y, actualTile, actualTile);
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[PrintRender] Tile ci=${ci} idx=${idx} not drawn, using target color`);
        }
      }
    }
    if (ci % 200 === 0) { onProgress?.(15 + Math.round((ci/total)*55), `Tiles: ${ci}/${total}`); await new Promise(r => setTimeout(r, 0)); }
  }

  // Apply user photo overlay (Foto-Overlay slider) — same as preview
  if (userOverlay > 0 && userPhotoImg && userPhotoImg.complete && userPhotoImg.naturalWidth > 0) {
    onProgress?.(90, 'Foto-Overlay anwenden...');
    ctx.save();
    ctx.globalAlpha = userOverlay / 100;
    ctx.drawImage(userPhotoImg, 0, 0, W, H);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  onProgress?.(92, 'Erstelle Datei...');

  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>(resolve => {
    const t = setTimeout(() => resolve(null), 90000);
    canvas!.toBlob(b => { clearTimeout(t); resolve(b); }, mimeType, format === 'png' ? undefined : 0.95);
  });
  if (!blob) throw new Error('Datei-Erstellung fehlgeschlagen');
  const filename = `mosaicprint-${W}x${H}-druckbereit.${format === 'png' ? 'png' : 'jpg'}`;
  onProgress?.(100, `✓ Fertig: ${filename}`);
  return { blob, width: W, height: H, filename };
}

// ─── Linear→sRGB LUT (4096 steps over [0,1]) ─────────────────────────────
// Eliminates Math.pow(1/2.4) in labToRgb hot path.
const _LIN_STEPS = 4096;
const _linearToSrgb = new Uint8Array(_LIN_STEPS + 1);
for (let i = 0; i <= _LIN_STEPS; i++) {
  const v = i / _LIN_STEPS;
  _linearToSrgb[i] = Math.round((v > 0.0031308 ? 1.055 * Math.pow(v, 1/2.4) - 0.055 : 12.92 * v) * 255);
}
const _toSrgbFast = (v: number): number => {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return _linearToSrgb[(v * _LIN_STEPS + 0.5) | 0];
};

// LAB -> RGB (inverse of rgbToLab) — LUT-accelerated
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const x = (fx > 0.206897 ? fx * fx * fx : (fx - 16/116) / 7.787) * 0.95047;
  const y = (fy > 0.206897 ? fy * fy * fy : (fy - 16/116) / 7.787) * 1.00000;
  const z = (fz > 0.206897 ? fz * fz * fz : (fz - 16/116) / 7.787) * 1.08883;
  const rLin =  x * 3.2404542 - y * 1.5371385 - z * 0.4985314;
  const gLin = -x * 0.9692660 + y * 1.8760108 + z * 0.0415560;
  const bLin =  x * 0.0556434 - y * 0.2040259 + z * 1.0572252;
  return [_toSrgbFast(rLin), _toSrgbFast(gLin), _toSrgbFast(bLin)];
}

// rgbToLab, toLinear, deltaE2000: importiert aus ../lib/colorUtils.ts (keine lokalen Duplikate)

// Printolino-konforme Druckformate
// Pixelgroesse bei 400 dpi (Ultra HD Druckqualitaet): px = cm x (400 / 2.54) = cm x 157.48
// 400 DPI = 1 Kachel pro cm bei 157px Kachelgroesse → optimale Druckschaerfe
// Kleinste sinnvolle Kachelgroesse: 40x40cm (darunter sind einzelne Kacheln zu klein)
const PRINT_FORMATS = [
  { label: "40x40 cm",   widthCm: 40,  heightCm: 40,  price: 69,  dpi: 400, pxW: 6299, pxH: 6299 },
  { label: "50x70 cm",   widthCm: 50,  heightCm: 70,  price: 99,  dpi: 400, pxW: 7874, pxH: 11024 },
  { label: "70x70 cm",   widthCm: 70,  heightCm: 70,  price: 139, dpi: 400, pxW: 11024, pxH: 11024 },
  { label: "100x100 cm", widthCm: 100, heightCm: 100, price: 199, dpi: 400, pxW: 15748, pxH: 15748 },
];

const MATERIALS = [
  { label: "Leinwand", surcharge: 0, icon: "🖼️" },
  { label: "Acrylglas", surcharge: 20, icon: "✨" },
  { label: "Alu-Dibond", surcharge: 15, icon: "🔲" },
  { label: "Fotopapier", surcharge: -10, icon: "📄" },
];

// Download/Print formats – used for BOTH digital download and print order
// tilePx determines output resolution: same rendering path for both use cases
const DIGITAL_FORMATS = [
  { label: "HD", desc: "Hochauflösend (ca. 10.000×12.000 px)", tilePx: 100, price: 19, format: 'jpg' as const },
  { label: "Ultra HD", desc: "Maximale Auflösung (1cm@400PPI)", tilePx: 157, price: 29, format: 'jpg' as const },
  { label: "PNG Lossless", desc: "Verlustfrei, maximale Qualität", tilePx: 157, price: 39, format: 'png' as const },
];

export default function Studio() {
  const { user, authHeaders } = useAuth();
  const [searchParams] = useSearchParams();
  // Mobile detection (used for hi-res overlay, canvas memory limits, etc.)
  const isMobile = typeof window !== 'undefined' && (window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent));
  const [userPhoto, setUserPhoto] = useState<string | null>(null);
  const [userPhotoImg, setUserPhotoImg] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  // Separate download progress (shown inline in order panel, not at top)
  const [dlProgress, setDlProgress] = useState(0);
  const [dlProgressMsg, setDlProgressMsg] = useState("");
  const [dlLoading, setDlLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  // Keep readyRef in sync for use in stable callbacks (timers, etc.)
  readyRef.current = ready;
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [sharpness] = useState(100); // always 100% hi-res
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [editCols, setEditCols] = useState<number | null>(null); // editable cols in stats modal
  const [editRows, setEditRows] = useState<number | null>(null); // editable rows in stats modal
  const [userOverlay, setUserOverlay] = useState(0); // 0-100: how much original photo shows through
  const [colorEnhance, setColorEnhance] = useState(0); // 0-100: tint tiles toward target color
  const [colorEnhanceUrl, setColorEnhanceUrl] = useState<string | null>(null); // data URL of target color canvas
  const [userOverlayUrl, setUserOverlayUrl] = useState<string | null>(null); // data URL of target photo at canvas aspect ratio
  const [compareMode, setCompareMode] = useState(false);
  const [distancePreview, setDistancePreview] = useState(false); // Simulate 2-3m viewing distance
  const [comparePos, setComparePos] = useState(50);
  const [popOutMode, setPopOutMode] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState(0); // 40x40 default (smallest available)
  const [selectedMaterial, setSelectedMaterial] = useState(0); // Leinwand default

  // Tile source mode: 'pool' = our DB only (default), 'own' = user photos only, 'mix' = user + DB
  const [tileSourceMode, setTileSourceMode] = useState<'pool' | 'own' | 'mix'>('pool');
  const [userTileFiles, setUserTileFiles] = useState<File[]>([]);
  const [userTileImages, setUserTileImages] = useState<HTMLImageElement[]>([]);
  const userTileImagesRef = useRef<HTMLImageElement[]>([]);
  const userTileHiResRef = useRef<HTMLImageElement[]>([]); // hi-res versions (512px) for detail/zoom
  const userTileOriginalRef = useRef<HTMLImageElement[]>([]); // full-resolution originals for print quality
  const validImgsHiResRef = useRef<(HTMLImageElement | null)[]>([]); // parallel to validImgsRef: hi-res for user tiles, null for DB tiles
  const tileSourceModeRef = useRef<'pool' | 'own' | 'mix'>('pool');
  const tileUploadRef = useRef<HTMLInputElement>(null);
  const MIN_OWN_TILES = 20; // minimum tiles for 'own' mode
  const [showOrderPanel, setShowOrderPanel] = useState(false);
  const [orderMode, setOrderMode] = useState<'print' | 'digital'>('print');
  const [selectedDigitalFormat, setSelectedDigitalFormat] = useState(0); // HD default (index 0 after removing Standard)
  const [showPhotoPreview, setShowPhotoPreview] = useState(false); // Modal for uploaded photo preview
  // Crop modal state
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null); // original uploaded image URL for cropping
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const cropImgRef = useRef<HTMLImageElement | null>(null);
  const [cacheSize, setCacheSize] = useState(0);
  const [dbTileCount, setDbTileCount] = useState<number | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [detectedImageType, setDetectedImageType] = useState<'portrait' | 'landscape' | 'abstract' | null>(null);
  const detectedImageTypeRef = useRef<typeof detectedImageType>(null);
  useEffect(() => { detectedImageTypeRef.current = detectedImageType; }, [detectedImageType]);
  const [autoPresetApplied, setAutoPresetApplied] = useState<string | null>(null);
  // Gemini AI toggle: when true (default), Gemini dynamic settings are applied directly.
  // When false, heuristic presets + admin overrides are used instead.
  const [useGemini, setUseGemini] = useState<boolean>(() => {
    try { return localStorage.getItem('mosaicprint_use_gemini') !== 'false'; } catch { return true; }
  });
  const [selectedTheme, setSelectedTheme] = useState<string>('alle'); // Theme filter for tile pool
  const selectedThemeRef = useRef<string>('alle'); // Ref for use inside renderMosaic callback
  const [suggestedThemes, setSuggestedThemes] = useState<Array<{key: string; label: string; emoji: string; score: number; profileSettings?: Record<string, unknown>}>>([]);
  // Owner mode: activated by secret URL param ?owner=2b98c0bb3c8e7b17868d22ac8e157bfe
  // Once activated, stored permanently in localStorage
  const [isAdminMode] = useState<boolean>(() => {
    try {
      const OWNER_SECRET = '2b98c0bb3c8e7b17868d22ac8e157bfe';
      const params = new URLSearchParams(window.location.search);
      if (params.get('owner') === OWNER_SECRET) {
        localStorage.setItem('mosaicprint_owner_mode', '1');
      }
      return !!localStorage.getItem('mosaicprint_owner_mode') ||
             !!localStorage.getItem('mosaicprint_admin_visited') ||
             !!localStorage.getItem('mosaicprint_algo_overrides');
    } catch { return false; }
  });
  // Post-generation quality metrics
  const [qualityMetrics, setQualityMetrics] = useState<{
    avgDeltaE: number;
    reuseRate: number;
    satLow: number;   // % tiles with saturation < 20 (muted/gray)
    satMid: number;   // % tiles with saturation 20-60 (moderate)
    satHigh: number;  // % tiles with saturation > 60 (vivid)
    totalTiles: number;
    uniqueTiles: number;
  } | null>(null);
  // Progressive rendering: show LAB-only preview while SSD matching runs
  const [renderPass, setRenderPass] = useState<1 | 2 | null>(null);

  // -- Debug Report: detailed algorithm trace after generation --------------
  const [debugReport, setDebugReport] = useState<{
    // Tile pool
    dbTilesTotal: number;       // tiles in LAB index
    indexDimension: string;     // '4D' | '7D' | '14D' | '15D'
    tilesLoaded: number;        // images actually loaded
    tilesAfterFilter: number;   // after clipart filter
    tilesFiltered: number;      // removed by clipart filter
    // Grid
    cols: number;
    rows: number;
    totalCells: number;
    tilePx: number;
    // Matching
    use2Stage: boolean;
    topK: number;
    maxReuse: number;
    neighborRadius: number;
    neighborPenalty: number;
    enableRotation: boolean;
    // Scoring weights (Stage C)
    wSsd: number;
    wLab: number;
    wBrightness: number;
    wTexture: number;
    wSaturation: number;
    wQuad: number;
    // Face
    facesDetected: number;
    faceCellCount: number;      // cells inside face regions
    faceCellPct: number;        // % of total cells
    // Color transfer
    lBlend: number;
    abBlend: number;
    maxColorShift: number;
    histogramBlend: number;
    contrastBoost: number;
    // Overlay
    overlayMode: string;
    baseOverlay: number;
    edgeBoost: number;
    // Timing
    generationMs: number;
  } | null>(null);

  // -- Tile Detail Popup: click on mosaic to see individual tile ----------------
  const [tileDetail, setTileDetail] = useState<{
    col: number; row: number; tileIdx: number;
    tileUrl: string; cellColor: string;
  } | null>(null);
  const clickStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // -- Project Save/Restore (localStorage) ------------------------------------
  const savedProjectIdRef = useRef<number | null>(null); // ID of last saved project (for print upload)
  const [hasSavedProject, setHasSavedProject] = useState<boolean>(() => {
    try { return !!localStorage.getItem('mosaicprint_saved_project'); } catch { return false; }
  });
  const [showRestoreBanner, setShowRestoreBanner] = useState<boolean>(() => {
    try { return !!localStorage.getItem('mosaicprint_saved_project'); } catch { return false; }
  });
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveProjectName, setSaveProjectName] = useState('');
  const [savingProject, setSavingProject] = useState(false);
  const [saveMode, setSaveMode] = useState<'new' | 'overwrite'>('new');
  const [existingProjects, setExistingProjects] = useState<Array<{ id: number; name: string; thumbnail_url: string | null; updated_at: string }>>([]);
  const [selectedOverwriteId, setSelectedOverwriteId] = useState<number | null>(null);
  const [loadingExistingProjects, setLoadingExistingProjects] = useState(false);

  // Update cache size display
  useEffect(() => {
    getIDBCacheSize().then(n => setCacheSize(n + getMemoryCacheSize()));
    // Fetch real DB tile count for the badge
    fetch('/api/trpc/getTileStats')
      .then(r => r.json())
      .then((data: { result?: { data?: { total?: number } } }) => {
        const total = data?.result?.data?.total;
        if (typeof total === 'number' && total > 0) setDbTileCount(total);
      })
      .catch(() => {});
  }, []);

  // Preload: Load the full 7D feature index (all tiles, ~330KB binary) in the background
  // Format: [id, L, a, b, edge, brightness, saturation] x 7 floats x 4 bytes = 28 bytes/tile
  // This enables multi-dimensional k-NN: LAB + edge + brightness + saturation
  useEffect(() => {
    if (labIndexLoadedRef.current) return;
    fetch('/api/tile-lab-index')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // Read floats-per-tile from header (default 4 for backward compat, 7 for new format)
        const floatsPerTile = Number(r.headers.get('X-Floats-Per-Tile') ?? '4');
        floatsPerTileRef.current = floatsPerTile;
        return r.arrayBuffer();
      })
      .then(buf => {
        labIndexRef.current = new Float32Array(buf);
        labIndexLoadedRef.current = true;
        const fpt = floatsPerTileRef.current;
        const count = buf.byteLength / (fpt * 4);
        console.log(`[Studio] Feature index loaded: ${count} tiles, ${fpt}D (${(buf.byteLength/1024).toFixed(0)} KB)`);
      })
      .catch(e => {
        console.warn('[Studio] Feature index not available, will use legacy pool:', e);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preload: Load the tile URL index (tileId -> R2/CDN URL) in the background
  // Used to load tiles directly from tiles.mosaicprint.ch (CDN) instead of Railway proxy
  // This avoids rate-limiting and reduces Railway egress costs
  useEffect(() => {
    if (tileUrlIndexLoadedRef.current) return;
    fetch('/api/tile-url-index')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { urls: Record<string, string>; r2Count: number; proxyCount: number; count: number }) => {
        tileUrlIndexRef.current = data.urls;
        tileUrlIndexLoadedRef.current = true;
        console.log(`[Studio] Tile URL index loaded: ${data.count} tiles, ${data.r2Count} R2 CDN, ${data.proxyCount} proxy fallback`);
      })
      .catch(e => {
        console.warn('[Studio] Tile URL index not available, will use proxy fallback:', e);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const useGeminiRef = useRef(useGemini);
  useGeminiRef.current = useGemini;
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const snapshotRef = useRef<ImageData | null>(null);
  const popOutContainerRef = useRef<HTMLDivElement>(null);
  const popOutWaveTlRef = useRef<gsap.core.Timeline | null>(null);
  const compareDragging = useRef(false);
  // Store tile assignment for hi-res re-render
  const assignmentRef = useRef<number[]>([]);
  const validImgsRef = useRef<HTMLImageElement[]>([]);
  // DB tile IDs parallel to validImgsRef (for multi-res loading via /api/tile/:id)
  const tileIdsRef = useRef<number[]>([]);
  // Full feature index: Float32Array of [id, L, a, b, edge, brightness, saturation, ...] for ALL tiles
  // Loaded once at startup, used for fast multi-dimensional k-NN pre-filter over entire DB
  const labIndexRef = useRef<Float32Array | null>(null);
  const labIndexLoadedRef = useRef<boolean>(false);
  const floatsPerTileRef = useRef<number>(4); // 4 (legacy), 7 (7D), 14 (14D), 15 (15D with isSkinFriendly), 16 (16D with tileComplexity)
  // Tile URL index: maps tileId (string) -> direct R2/CDN URL (tiles.mosaicprint.ch)
  // Loaded once at startup alongside LAB index, used to load tiles directly from CDN
  const tileUrlIndexRef = useRef<Record<string, string> | null>(null);
  const tileUrlIndexLoadedRef = useRef<boolean>(false);
  const mosaicParamsRef = useRef<{cols:number; rows:number; tilePx:number; canvasW:number; canvasH:number} | null>(null);
  const skipAutoRenderRef = useRef(false); // Skip auto-render when loading a project (already has rendered image)
  // Overlay data: stored from renderMosaic for server-side overlay in print/digital downloads
  const targetColorsRef = useRef<number[]>([]); // flat [r,g,b,r,g,b,...] per cell (COLS×ROWS)
  const edgeMapRef = useRef<number[]>([]);      // edge strength 0-1 per cell
  const faceMaskRef = useRef<boolean[]>([]);     // face region flag per cell
  const cellLabRef = useRef<[number, number, number][]>([]); // LAB target color per cell (for hi-res color correction)
  const assignmentRotRef = useRef<number[]>([]);  // rotation per cell (0-3)
  const colorEnhanceCanvasRef = useRef<HTMLCanvasElement | null>(null); // small canvas with target colors per cell
  const colorEnhanceRef = useRef(0); // current colorEnhance value for use in callbacks

  // HI-RES ZOOM: server-rendered high-resolution image for sharp zooming
  // When user zooms beyond 1x, we trigger a server-side render at 128px/tile,
  // block zoom until it's ready, then display a sharp hi-res img element.
  const [hiResReady, setHiResReady] = useState(false);
  const [hiResLoading, setHiResLoading] = useState(false);
  const [hiResImgUrl, setHiResImgUrl] = useState<string | null>(null);
  const hiResImgUrlRef = useRef<string | null>(null);
  // Refs for use in stable callbacks (handleWheel)
  const hiResReadyRef = useRef(false);
  const hiResLoadingRef = useRef(false);
  const triggerClientHiResRef = useRef<(() => Promise<void>) | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  hiResReadyRef.current = hiResReady;
  hiResLoadingRef.current = hiResLoading;

  // Check if hi-res server render is possible (only DB tiles have valid positive IDs)
  const canDoHiRes = useCallback(() => {
    const ids = tileIdsRef.current;
    if (!ids.length) return false;
    // User-uploaded tiles have negative IDs – server can't render those.
    // In mix mode, tileIds contains both negative (user) and positive (DB) IDs.
    // If ANY tile has a negative ID, server-render would produce gray tiles for those positions.
    // Therefore, require ALL tiles to have positive IDs before using server-render.
    return ids.every(id => id > 0);
  }, []);

  // Trigger server-side hi-res render for zoom
  const triggerHiResRender = useCallback(async () => {
    if (!assignmentRef.current.length || !tileIdsRef.current.length || !mosaicParamsRef.current) return;
    if (hiResLoadingRef.current) return;
    // Skip hi-res if using own photos (negative tile IDs) – server can't load them
    if (!canDoHiRes()) return;

    setHiResLoading(true);
    setProgressMsg('Rendere Zoomansicht...');
    setProgress(5);

    const { cols, rows } = mosaicParamsRef.current;
    // Mobile: limit output to ~16 MP (4096px max dimension) to prevent iOS Safari OOM crash
    // Desktop: allow up to 12000px for sharp zoom
    const isMob = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    const maxDim = isMob ? 4096 : 12000;
    const ZOOM_TILE_PX = Math.min(256, Math.floor(maxDim / Math.max(cols, rows)));
    console.log(`[HiRes] Server render: ${cols}x${rows} @ ${ZOOM_TILE_PX}px = ${cols*ZOOM_TILE_PX}x${rows*ZOOM_TILE_PX} (mobile=${isMob})`);
    const zoomJobId = `zoom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // SSE progress for zoom render
    let sseSource: EventSource | null = null;
    try {
      sseSource = new EventSource(`/api/print-progress/${zoomJobId}`);
      sseSource.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.progress) setProgress(data.progress);
          if (data.message) {
            const etaStr = data.eta > 0 ? ` (~${data.eta}s)` : '';
            setProgressMsg(`${data.message}${etaStr}`);
          }
        } catch { /* ignore */ }
      };
    } catch { /* SSE not critical */ }

    try {
      // Send overlay data so server bakes in color correction (prevents color mismatch on zoom)
      const algoSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();
      // Timeout: 30s mobile, 90s desktop (server needs time to download tiles + composite)
      const fetchTimeout = isMob ? 30000 : 90000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);
      const resp = await fetch('/api/print-render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          tileIds: tileIdsRef.current,
          assignment: assignmentRef.current,
          cols, rows,
          tilePx: ZOOM_TILE_PX,
          format: 'jpg',
          jobId: zoomJobId,
          overlayMode: algoSettings.overlayMode ?? 'softlight',
          baseOverlay: algoSettings.baseOverlay ?? 0.15,
          edgeBoost: algoSettings.edgeBoost ?? 0.20,
          targetColors: targetColorsRef.current,
          edgeMap: edgeMapRef.current,
          faceMask: faceMaskRef.current,
        }),
      });
      clearTimeout(timeoutId);
      if (!resp.ok) { if (sseSource) sseSource.close(); throw new Error(`Server error: ${resp.status}`); }
      // Server returns {accepted:true, jobId} immediately – poll for result
      const acceptedData = await resp.json();
      if (!acceptedData.accepted) { if (sseSource) sseSource.close(); throw new Error('Server did not accept job'); }
      setProgress(10);
      setProgressMsg('Zoom wird gerendert...');

      // Poll for completion (server processes async)
      const pollResult = await pollForResult(
        zoomJobId,
        (p) => setProgress(Math.max(10, Math.min(85, p))),
        (m) => setProgressMsg(m),
      );
      if (sseSource) sseSource.close();
      const { token } = pollResult;
      setProgress(90);
      setProgressMsg('Lade Zoomansicht...');

      // Fetch the rendered image as blob (with timeout)
      const dlController = new AbortController();
      const dlTimeout = setTimeout(() => dlController.abort(), isMob ? 20000 : 60000);
      const imgResp = await fetch(`/api/print-download/${token}`, { signal: dlController.signal });
      clearTimeout(dlTimeout);
      if (!imgResp.ok) throw new Error('Download failed');
      const blob = await imgResp.blob();
      // Safety: check blob size – if too large for mobile, skip (will fall back to client render)
      const MAX_BLOB_MB = isMob ? 15 : 100;
      if (blob.size > MAX_BLOB_MB * 1024 * 1024) {
        console.warn(`[HiRes] Blob too large for mobile: ${(blob.size/1024/1024).toFixed(1)}MB > ${MAX_BLOB_MB}MB`);
        throw new Error(`Image too large: ${(blob.size/1024/1024).toFixed(1)}MB`);
      }
      console.log(`[HiRes] Downloaded: ${(blob.size/1024).toFixed(0)}KB, ${cols*ZOOM_TILE_PX}x${rows*ZOOM_TILE_PX}`);

      // Revoke previous URL if any
      if (hiResImgUrlRef.current) URL.revokeObjectURL(hiResImgUrlRef.current);
      const url = URL.createObjectURL(blob);
      hiResImgUrlRef.current = url;
      setHiResImgUrl(url);
      setHiResReady(true);
      setProgress(100);
      setProgressMsg('Zoomansicht bereit!');
      setTimeout(() => { setProgressMsg(''); setProgress(0); }, 2000);
    } catch (e) {
      console.error('[HiRes] Server render failed, falling back to client render:', e);
      setProgressMsg('Server-Zoom fehlgeschlagen, nutze Client-Rendering...');
      // CRITICAL FIX: Fall back to client-side hi-res render instead of giving up
      // This ensures zoom always works, even if server is slow/down/OOM
      setHiResLoading(false); // reset so client render can start
      hiResLoadingRef.current = false; // sync ref immediately so triggerClientHiRes doesn't skip
      try {
        if (triggerClientHiResRef.current) await triggerClientHiResRef.current();
      } catch (e2) {
        console.error('[HiRes] Client fallback also failed:', e2);
        setProgressMsg('');
        setProgress(0);
      }
      return; // skip the finally block's setHiResLoading since client render handles it
    } finally {
      setHiResLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDoHiRes]);

  // Client-side hi-res render for own photos (where server render can't work)
  // Draws tiles at larger resolution using the original HTMLImageElements,
  // then composites the color-transferred mosaic as a tint overlay.
  const triggerClientHiResRender = useCallback(async () => {
    const assignment = assignmentRef.current;
    const validImgs = validImgsRef.current;
    const hiResImgs = validImgsHiResRef.current;
    const params = mosaicParamsRef.current;
    const snapshot = snapshotRef.current;
    if (!assignment.length || !validImgs.length || !params) {
      console.warn('[ClientHiRes] Skipped: assignment=', assignment.length, 'validImgs=', validImgs.length, 'params=', !!params);
      setHiResLoading(false);
      return;
    }
    if (hiResLoadingRef.current) return;

    setHiResLoading(true);
    const { cols, rows, tilePx } = params;
    const totalCells = cols * rows;
    // Adaptive hi-res tile size: use largest that fits within canvas limits
    // Mobile Safari limits total canvas area to ~16.7 MP (4096×4096).
    // Desktop can handle much larger canvases (up to ~268 MP).
    const isMob = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    // Mobile: use OffscreenCanvas or chunked rendering to allow larger tiles
    // iOS Safari supports up to ~16.7 MP but we can tile-render in chunks
    // Desktop: cap at 80MP to keep toBlob() fast (< 5s). At 120×90 tiles:
    //   128px → 176.9MP (too slow), 96px → 99.5MP (borderline), 80px → 69.1MP (fast)
    // Mobile: cap at 50MP
    const maxCanvasArea = isMob ? 50_000_000 : 80_000_000;
    const maxCanvasDim = isMob ? 8192 : 12000;
    const maxTileFromArea = Math.floor(Math.sqrt(maxCanvasArea / (cols * rows)));
    const maxTileFromDim = Math.floor(maxCanvasDim / Math.max(cols, rows));
    // Desktop ideal: 96px (sharp but not too large). Mobile: 256px (chunked)
    const idealDesktopTile = 96;
    const idealMobileTile = 256;
    const HR_TILE = Math.min(isMob ? idealMobileTile : idealDesktopTile, Math.max(32, Math.min(maxTileFromArea, maxTileFromDim)));
    const hrW = cols * HR_TILE;
    const hrH = rows * HR_TILE;
    console.log(`[ClientHiRes] ${cols}×${rows} grid, HR_TILE=${HR_TILE}px, canvas=${hrW}×${hrH} (${(hrW*hrH/1e6).toFixed(1)}MP, mobile=${isMob})`);

    // Safety: don't create canvases beyond limits
    if (hrW > maxCanvasDim || hrH > maxCanvasDim || hrW * hrH > maxCanvasArea) {
      console.warn(`[ClientHiRes] Canvas too large: ${hrW}×${hrH}, aborting`);
      setHiResLoading(false);
      return;
    }

    try {
      await new Promise(r => setTimeout(r, 0)); // yield to UI

      // 1. Draw hi-res tiles from original images
      // Try creating canvas, with progressive fallback for mobile memory limits
      let hrCanvas: HTMLCanvasElement | null = null;
      let hrCtx: CanvasRenderingContext2D | null = null;
      let actualTile = HR_TILE;
      for (const tryTile of [HR_TILE, Math.floor(HR_TILE * 0.6), Math.floor(HR_TILE * 0.4), 12]) {
        const c = document.createElement('canvas');
        c.width = cols * tryTile;
        c.height = rows * tryTile;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          hrCanvas = c;
          hrCtx = ctx;
          actualTile = tryTile;
          if (tryTile !== HR_TILE) console.warn(`[ClientHiRes] Fallback to tile=${tryTile}px (${c.width}×${c.height})`);
          break;
        }
        console.warn(`[ClientHiRes] getContext failed for tile=${tryTile}px (${c.width}×${c.height})`);
      }
      if (!hrCanvas || !hrCtx) {
        console.error('[ClientHiRes] All canvas sizes failed, aborting');
        setHiResLoading(false);
        return;
      }
      const rotations = assignmentRotRef.current;
      const tileIds = tileIdsRef.current;

      // HI-RES RELOAD for zoom: load DB tiles via source_url (original ~940px from Pexels/Unsplash).
      // This avoids 128px→256px upscale (blurry). Direct source_url gives full-resolution tiles.
      const zoomHiResMap: Record<number, HTMLImageElement> = {};
      const uniqueZoomIdxs = [...new Set(assignment)];
      const ZOOM_NEED_SIZE = 256; // minimum acceptable size for zoom
      const zoomReloadNeeded = uniqueZoomIdxs.filter(idx => {
        const dbId = tileIds[idx];
        if (!dbId || dbId <= 0) return false;
        const hi = hiResImgs[idx];
        if (hi && hi.complete && hi.naturalWidth >= ZOOM_NEED_SIZE * 0.8) return false; // already hi-res
        const img = validImgs[idx];
        return !img || !img.complete || img.naturalWidth === 0 || img.naturalWidth < ZOOM_NEED_SIZE * 0.8;
      });
      if (zoomReloadNeeded.length > 0) {
        console.log(`[ClientHiRes] Reloading ${zoomReloadNeeded.length} tiles via source_url for zoom`);

        // Fetch source_url for all needed tiles in one request
        const zoomDbIds = zoomReloadNeeded.map(idx => tileIds[idx]).filter(id => id > 0);
        let zoomSourceUrlMap: Record<number, string> = {};
        try {
          const urlRes = await fetch(`/api/tile-urls?ids=${zoomDbIds.join(',')}&hires=1`);
          if (urlRes.ok) {
            const data = await urlRes.json() as Record<string, string>;
            for (const [k, v] of Object.entries(data)) { if (v) zoomSourceUrlMap[Number(k)] = v; }
            console.log(`[ClientHiRes] Got ${Object.keys(zoomSourceUrlMap).length} source URLs for zoom`);
          }
        } catch (e) {
          console.warn('[ClientHiRes] Failed to fetch zoom source URLs', e);
        }

        const ZBATCH = 8;
        const loadZoomTile = (dbId: number): Promise<HTMLImageElement | null> => {
          const sourceUrl = zoomSourceUrlMap[dbId];
          return new Promise(resolve => {
            const tryLoad = (url: string, retries: number, isFallback: boolean) => {
              const img = new Image();
              if (!url.startsWith('/')) img.crossOrigin = 'anonymous';
              const timeout = setTimeout(() => {
                img.onload = img.onerror = null;
                if (retries > 0) { setTimeout(() => tryLoad(url, retries - 1, isFallback), 300); }
                else if (!isFallback && sourceUrl) { tryLoad(`/api/tile/${dbId}?size=256&t=${Date.now()}`, 1, true); }
                else { resolve(null); }
              }, 10000);
              img.onload = () => {
                clearTimeout(timeout);
                if (img.naturalWidth < 10) {
                  if (retries > 0) { setTimeout(() => tryLoad(url, retries - 1, isFallback), 300); }
                  else if (!isFallback && sourceUrl) { tryLoad(`/api/tile/${dbId}?size=256&t=${Date.now()}`, 1, true); }
                  else { resolve(null); }
                } else { resolve(img); }
              };
              img.onerror = () => {
                clearTimeout(timeout);
                if (retries > 0) { setTimeout(() => tryLoad(url, retries - 1, isFallback), 500); }
                else if (!isFallback && sourceUrl) { tryLoad(`/api/tile/${dbId}?size=256&t=${Date.now()}`, 1, true); }
                else { resolve(null); }
              };
              img.src = url;
            };
            const startUrl = sourceUrl || `/api/tile/${dbId}?size=256&t=${Date.now()}`;
            tryLoad(startUrl, 1, !sourceUrl);
          });
        };

        for (let i = 0; i < zoomReloadNeeded.length; i += ZBATCH) {
          const batch = zoomReloadNeeded.slice(i, i + ZBATCH);
          await Promise.all(batch.map(async (idx) => {
            const dbId = tileIds[idx];
            if (!dbId || dbId <= 0) return;
            const img = await loadZoomTile(dbId);
            if (img && img.naturalWidth > 0) zoomHiResMap[idx] = img;
          }));
          await new Promise(r => setTimeout(r, 0));
        }
        console.log(`[ClientHiRes] Zoom hi-res loaded: ${Object.keys(zoomHiResMap).length}/${zoomReloadNeeded.length}`);
      }

      // Helper: extract tile region from original rendered canvas (snapshot) as fallback
      // This prevents gray patches when tile images are GC'd or broken
      const snapshotCanvas = document.createElement('canvas');
      const snapshotCtxHelper = snapshotCanvas.getContext('2d');
      if (snapshot && snapshotCtxHelper) {
        snapshotCanvas.width = snapshot.width;
        snapshotCanvas.height = snapshot.height;
        snapshotCtxHelper.putImageData(snapshot, 0, 0);
      }

      // Wait for any pending data-URL images to finish decoding (fixes gray tiles on mobile)
      const pendingDecodes = validImgs.filter(img => img && !img.complete).map(img =>
        img.decode().catch(() => {})
      );
      if (pendingDecodes.length > 0) {
        console.log(`[ClientHiRes] Waiting for ${pendingDecodes.length} images to decode...`);
        await Promise.all(pendingDecodes);
      }

      for (let ci = 0; ci < totalCells; ci++) {
        const col = ci % cols;
        const row = Math.floor(ci / cols);
        const x = col * actualTile;
        const y = row * actualTile;
        const tileIdx = assignment[ci];
        // Priority: zoom-reloaded hi-res (DB tiles) > hiResImgs (user tiles 256/512px) > validImgs (64px thumbnail)
        // IMPORTANT: For user tiles (negative IDs), hiResImgs[tileIdx] contains the 256/512px hi-res version.
        // Never use validImgs (64px) for zoom rendering – it would be massively upscaled and blurry.
        const zoomReloaded = zoomHiResMap[tileIdx];
        const hiImg = (zoomReloaded && zoomReloaded.complete && zoomReloaded.naturalWidth > 0) ? zoomReloaded : hiResImgs[tileIdx];
        const img = (hiImg && hiImg.complete && hiImg.naturalWidth > 0) ? hiImg : validImgs[tileIdx];
        const rot = rotations[ci] || 0;

        if (img && img.complete && img.naturalWidth > 0) {
          try {
            if (rot === 0) {
              hrCtx.drawImage(img, x, y, actualTile, actualTile);
            } else {
              hrCtx.save();
              hrCtx.translate(x + actualTile / 2, y + actualTile / 2);
              hrCtx.rotate(rot * Math.PI / 2);
              hrCtx.drawImage(img, -actualTile / 2, -actualTile / 2, actualTile, actualTile);
              hrCtx.restore();
            }
          } catch {
            // Fallback: copy tile region from original rendered canvas (preserves appearance)
            const { tilePx: origTilePx } = params;
            const srcX = col * origTilePx, srcY = row * origTilePx;
            try {
              hrCtx.drawImage(snapshotCanvas, srcX, srcY, origTilePx, origTilePx, x, y, actualTile, actualTile);
            } catch {
              const tci = ci * 3;
              const tc = targetColorsRef.current;
              hrCtx.fillStyle = tc.length > tci + 2 ? `rgb(${tc[tci]},${tc[tci+1]},${tc[tci+2]})` : '#ccc';
              hrCtx.fillRect(x, y, actualTile, actualTile);
            }
          }
        } else {
          // Image not available (GC'd or broken) – copy from original render as fallback
          const { tilePx: origTilePx } = params;
          const srcX = col * origTilePx, srcY = row * origTilePx;
          try {
            hrCtx.drawImage(snapshotCanvas, srcX, srcY, origTilePx, origTilePx, x, y, actualTile, actualTile);
          } catch {
            const tci = ci * 3;
            const tc = targetColorsRef.current;
            hrCtx.fillStyle = tc.length > tci + 2 ? `rgb(${tc[tci]},${tc[tci+1]},${tc[tci+2]})` : '#ccc';
            hrCtx.fillRect(x, y, actualTile, actualTile);
          }
        }

        if (ci % 200 === 0) await new Promise(r => setTimeout(r, 0));
      }

      // 2. Apply LAB-based color correction to match main canvas appearance
      // The main render applies luminance scaling + AB color transfer per tile (Reinhard-style).
      // Hi-res uses original photos which are more saturated/different than 64px thumbnails.
      // We apply the same LAB correction here to ensure visual consistency between preview and zoom.
      // Skip on mobile: getImageData on large canvas can crash mobile Safari.
      if (!isMob) {
        const hrW = hrCanvas!.width;
        const hrH = hrCanvas!.height;
        const hrImageData = hrCtx!.getImageData(0, 0, hrW, hrH);
        const hd = hrImageData.data;
        const cellLabData = cellLabRef.current;  // LAB target per cell
        const algoSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();
        const blendFactor = Math.min(1.0, (algoSettings.histogramBlend ?? 0.0) / 0.10);
        // colorEnhance slider (0-100) scales the AB color transfer strength
        // 0% = minimum LAB correction (base only), 100% = full correction
        const colorEnhanceVal = colorEnhanceRef.current / 100; // 0.0 - 1.0
        // Use same parameters as renderMosaic for visual consistency
        const L_BLEND  = 0.40 + 0.40 * blendFactor;  // 0.40 minimum
        const AB_BLEND_BASE = 0.12 + 0.20 * blendFactor;  // 0.12 minimum
        const AB_BLEND = AB_BLEND_BASE * (0.5 + 0.5 * colorEnhanceVal); // scale by colorEnhance (50%-100% of base)
        const MAX_COLOR_SHIFT = 18;
        const MAX_BLUE_SHIFT = 10;
        const cBoost = algoSettings.contrastBoost ?? 1.30;  // same default as renderMosaic

        if (cellLabData.length > 0) {
          console.log('[ClientHiRes] Applying LAB color correction (same as renderMosaic)');
          // Process each tile cell
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const ci = row * cols + col;
              if (ci >= cellLabData.length) continue;
              const [tL, tA, tB] = cellLabData[ci];
              const isShadowZone = tL < 40;
              const shadowBoost = isShadowZone ? Math.max(0, (40 - tL) / 40) : 0;
              const effectiveL_BLEND = Math.min(0.98, L_BLEND + shadowBoost * 0.50);

              // Compute tile average L using 8x8 subsample for consistency with preview/print.
              // Full-resolution avgL differs from preview (64px thumbnails) — causes color mismatch.
              const yStart = row * actualTile;
              const xStart = col * actualTile;
              const REF_N = 8;
              const stepY = Math.max(1, Math.floor(actualTile / REF_N));
              const stepX = Math.max(1, Math.floor(actualTile / REF_N));
              let sumL = 0, pCount = 0;
              for (let sy = 0; sy < REF_N; sy++) {
                for (let sx = 0; sx < REF_N; sx++) {
                  const py = Math.min(yStart + sy * stepY, yStart + actualTile - 1);
                  const px = Math.min(xStart + sx * stepX, xStart + actualTile - 1);
                  if (py < hrH && px < hrW) {
                    const pi = (py * hrW + px) * 4;
                    sumL += rgbToLab(hd[pi], hd[pi+1], hd[pi+2])[0];
                    pCount++;
                  }
                }
              }
              const avgL = pCount > 0 ? sumL / pCount : 50;
              const rawLumScale = avgL > 1 ? tL / avgL : 1;
              const maxLumScale = isShadowZone ? Math.min(1.0, rawLumScale) : rawLumScale;
              const clampedLumScale = Math.max(0.05, Math.min(4.0, maxLumScale));
              const lumScale = 1 + (clampedLumScale - 1) * effectiveL_BLEND;

              // Apply per-pixel LAB correction
              for (let py = yStart; py < yEnd; py++) {
                for (let px = xStart; px < xEnd; px++) {
                  const pi = (py * hrW + px) * 4;
                  const [pl, pa, pb] = rgbToLab(hd[pi], hd[pi+1], hd[pi+2]);
                  let newL = Math.max(0, Math.min(100, pl * lumScale));
                  if (isShadowZone && shadowBoost > 0.05) {
                    const deviation = pl - avgL;
                    const stretchFactor = 1.0 + shadowBoost * 0.4;
                    newL = Math.max(0, Math.min(100, (newL + deviation * (stretchFactor - 1.0))));
                  }
                  if (isShadowZone && newL > tL + 25) {
                    newL = tL + 25 + (newL - tL - 25) * 0.2;
                  }
                  const rawDeltaA = (tA - pa) * AB_BLEND;
                  const rawDeltaB = (tB - pb) * AB_BLEND;
                  const clampedDeltaA = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, rawDeltaA));
                  const clampedDeltaB = rawDeltaB < 0
                    ? Math.max(-MAX_BLUE_SHIFT, rawDeltaB)
                    : Math.min(MAX_COLOR_SHIFT, rawDeltaB);
                  const newA = Math.max(-128, Math.min(127, pa + clampedDeltaA));
                  const newB = Math.max(-128, Math.min(127, pb + clampedDeltaB));
                  const contrastL = Math.max(0, Math.min(100, 50 + (newL - 50) * cBoost));
                  const satBoost = 0.90 + cBoost * 0.15;
                  const boostedA = Math.max(-128, Math.min(127, newA * satBoost));
                  const bSatBoost = newB < 0 ? Math.min(satBoost, 1.0) : satBoost;
                  const boostedB = Math.max(-128, Math.min(127, newB * bSatBoost));
                  const [nr, ng, nb] = labToRgb(contrastL, boostedA, boostedB);
                  hd[pi] = nr;
                  hd[pi+1] = ng;
                  hd[pi+2] = nb;
                }
              }
            }
            // Yield to UI every few rows
            if (row % 10 === 0) await new Promise(r => setTimeout(r, 0));
          }
          hrCtx!.putImageData(hrImageData, 0, 0);
        } else {
          // No cellLab data available (e.g. loaded from saved project without re-render)
          // Fall back to simple contrast boost only
          console.log('[ClientHiRes] No cellLab data, skipping LAB correction');
        }
      }

      // 3. Convert to blob URL (with timeout for mobile)
      const blob = await new Promise<Blob | null>(resolve => {
        const timeout = setTimeout(() => { console.warn('[ClientHiRes] toBlob timed out'); resolve(null); }, 45000);
        try {
          hrCanvas!.toBlob(b => { clearTimeout(timeout); resolve(b); }, 'image/jpeg', isMob ? 0.92 : 0.95);
        } catch (e) { clearTimeout(timeout); console.error('[ClientHiRes] toBlob error:', e); resolve(null); }
      });

      if (blob) {
        console.log(`[ClientHiRes] Success: blob=${(blob.size/1024).toFixed(0)}KB, tile=${actualTile}px, canvas=${hrCanvas!.width}×${hrCanvas!.height}`);
        if (hiResImgUrlRef.current) URL.revokeObjectURL(hiResImgUrlRef.current);
        const url = URL.createObjectURL(blob);
        hiResImgUrlRef.current = url;
        setHiResImgUrl(url);
        setHiResReady(true);
      } else {
        console.error('[ClientHiRes] toBlob returned null');
      }
    } catch (e) {
      console.error('[ClientHiRes] Failed:', e);
    } finally {
      setHiResLoading(false);
      // MOBILE FIX: Restore main canvas from snapshot after hi-res render.
      // Mobile browsers may evict main canvas pixels when large hi-res canvases
      // are created (canvas memory pressure). This restores the mosaic appearance.
      const mainCanvas = canvasRef.current;
      const snap = snapshotRef.current;
      if (mainCanvas && snap) {
        try {
          // Force canvas buffer re-allocation by resetting dimensions
          // (evicted canvases may silently fail on putImageData)
          const w = mainCanvas.width;
          const h = mainCanvas.height;
          const mainCtx = mainCanvas.getContext('2d');
          if (mainCtx) {
            const probe = mainCtx.getImageData(0, 0, 1, 1).data;
            if (probe[3] === 0 && snap.data[3] !== 0) {
              console.warn('[ClientHiRes] Main canvas was evicted, restoring from snapshot');
              // Reset canvas dimensions to force buffer re-allocation
              mainCanvas.width = w;
              mainCanvas.height = h;
              const freshCtx = mainCanvas.getContext('2d');
              if (freshCtx) freshCtx.putImageData(snap, 0, 0);
            }
          }
        } catch { /* ignore – hi-res overlay will cover the canvas anyway */ }
      }
    }
  }, []);
  // Keep ref in sync so triggerHiResRender can call it as fallback
  triggerClientHiResRef.current = triggerClientHiResRender;

  // Reset hi-res when new mosaic is rendered
  const resetHiRes = () => {
    setHiResReady(false);
    setHiResLoading(false);
    if (hiResImgUrlRef.current) { URL.revokeObjectURL(hiResImgUrlRef.current); hiResImgUrlRef.current = null; }
    setHiResImgUrl(null);
  };

  const tilesRef = useRef<Array<{ x: number; y: number; px: number; url?: string }>>([]);

  // Apply a crop to the uploaded image and set it as the user photo
  const applyCropAndSetPhoto = useCallback((dataUrl: string, pixelCrop?: PixelCrop | null) => {
    if (!pixelCrop || pixelCrop.width === 0 || pixelCrop.height === 0) {
      // No crop: use full image
      const img = new Image();
      img.onload = async () => {
        setUserPhoto(dataUrl);
        setUserPhotoImg(img);
        setReady(false); setError(null); setZoom(1); setPan({ x: 0, y: 0 }); setCompareMode(false);
      };
      img.src = dataUrl;
      return;
    }
    // Crop: draw cropped region onto a new canvas
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixelCrop.width;
      canvas.height = pixelCrop.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height, 0, 0, pixelCrop.width, pixelCrop.height);
      const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
      const croppedImg = new Image();
      croppedImg.onload = async () => {
        setUserPhoto(croppedDataUrl);
        setUserPhotoImg(croppedImg);
        setReady(false); setError(null); setZoom(1); setPan({ x: 0, y: 0 }); setCompareMode(false);
      };
      croppedImg.src = croppedDataUrl;
    };
    img.src = dataUrl;
  }, []);

  const handleUpload = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      // Open crop modal instead of directly setting photo
      setCropSrc(dataUrl);
      setCrop(undefined);
      setCompletedCrop(null);
      setCropModalOpen(true);
      const img = new Image();
      img.onload = async () => {
        // NOTE: Do NOT call setUserPhotoImg here – that would trigger the auto-render useEffect
        // before the crop modal is confirmed. setUserPhotoImg is called in applyCropAndSetPhoto
        // after the user confirms the crop, which is the correct single trigger point.
        // Calling it here caused a double renderMosaic (first with uncropped, then with cropped image).
        setReady(false);
        setError(null);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setCompareMode(false);

        // -- Auto Portrait Detection ------------------------------------------
        // Detect if the image is a portrait (face-heavy) and auto-apply optimal settings
        try {
          const aspectRatio = img.naturalWidth / img.naturalHeight;
          let imageType: 'portrait' | 'landscape' | 'abstract' = 'abstract';

          // Step 1: Aspect ratio heuristic (portrait photos are usually taller than wide)
          const isVertical = aspectRatio < 0.85;

          // Step 2: Try browser FaceDetector API
          // STRICT: require face area >= 3% of image (prevents false positives on landscapes)
          let hasFace = false;
          if ('FaceDetector' in window) {
            try {
              const faceDetector = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
              const smallCanvas = document.createElement('canvas');
              const scale = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
              smallCanvas.width = Math.round(img.naturalWidth * scale);
              smallCanvas.height = Math.round(img.naturalHeight * scale);
              const sCtx = smallCanvas.getContext('2d')!;
              sCtx.drawImage(img, 0, 0, smallCanvas.width, smallCanvas.height);
              const faces = await faceDetector.detect(smallCanvas);
              // STRICT: face must cover at least 3% of image area to count as portrait
              // This prevents landscape/mountain/sky photos from triggering portrait mode
              const imgArea = smallCanvas.width * smallCanvas.height;
              const significantFaces = faces.filter((f: any) => {
                const faceArea = (f.boundingBox?.width ?? 0) * (f.boundingBox?.height ?? 0);
                return faceArea / imgArea >= 0.03; // face must be >= 3% of image
              });
              hasFace = significantFaces.length > 0;
            } catch { /* FaceDetector not available */ }
          }

          // Step 3: Skin-tone heuristic (center region analysis)
          // STRICT: raised threshold from 15% to 28% to avoid false positives on warm landscapes
          if (!hasFace) {
            const sampleCanvas = document.createElement('canvas');
            sampleCanvas.width = 32; sampleCanvas.height = 32;
            const sCtx = sampleCanvas.getContext('2d')!;
            sCtx.drawImage(img, 0, 0, 32, 32);
            const pixels = sCtx.getImageData(8, 4, 16, 20).data; // center crop
            let skinPixels = 0, totalPixels = 0;
            for (let pi = 0; pi < pixels.length; pi += 4) {
              const r = pixels[pi], g = pixels[pi+1], b = pixels[pi+2];
              // Skin tone detection: r > 95, g > 40, b > 20, r > g, r > b, |r-g| > 15
              // ALSO require b < 200 to exclude sky-blue/purple haze (common in sunsets)
              if (r > 95 && g > 40 && b > 20 && b < 200 && r > g && r > b && Math.abs(r - g) > 15) skinPixels++;
              totalPixels++;
            }
            // STRICT: raised from 15% to 22% - group photos have multiple faces but background dilutes ratio
            hasFace = skinPixels / totalPixels > 0.22;
          }

          // Portrait mode requires BOTH face detection AND vertical orientation
          // (or very strong face detection alone)
          // This prevents landscape photos (horizontal, no clear face) from triggering portrait mode
          const strongFaceSignal = hasFace; // FaceDetector or strong skin heuristic
          if (strongFaceSignal && isVertical) {
            imageType = 'portrait';  // both signals required
          } else if (strongFaceSignal && !isVertical) {
            // Horizontal photo with face: could be group photo - use portrait preset
            // (fal.ai will confirm or override below)
            imageType = 'portrait';
          } else if (aspectRatio > 1.3) {
            imageType = 'landscape';
          }

          setDetectedImageType(imageType);

          // Step 4: Auto-apply optimal preset on EVERY upload.
          // Preset always wins on upload. Admin manual overrides are stored separately
          // in 'mosaicprint_algo_overrides' and applied ON TOP of the preset.
          // This prevents stale localStorage (e.g. portraitMode:false from last session) from
          // overriding the freshly detected preset.
          const adminOverrides = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_overrides') || '{}'); } catch { return {}; } })();
          // Portrait-critical parameters must NOT be overridden by Admin settings:
          // tilePx, maxReuse, rotation are essential for portrait quality
          const PORTRAIT_LOCKED_KEYS = ['tilePx', 'baseTiles', 'maxReuse', 'rotation', 'neighborPenalty', 'neighborRadius'];
          const mergeWithAdmin = (preset: Record<string, unknown>) => {
            const merged = { ...preset, ...adminOverrides };
            // If this is a portrait preset, restore locked keys from preset
            if (preset.portraitMode === true) {
              for (const key of PORTRAIT_LOCKED_KEYS) {
                if (key in preset) merged[key] = preset[key];
              }
            }
            return merged;
          };

          // White-Hair detection: analyze top 30% of image for bright pixels
          // Also check overall brightness (>40% bright pixels = bright background/skin)
          let isWhiteHairPortrait = false;
          if (imageType === 'portrait') {
            try {
              const whCanvas = document.createElement('canvas');
              whCanvas.width = 64; whCanvas.height = 64;
              const whCtx = whCanvas.getContext('2d')!;
              whCtx.drawImage(img, 0, 0, 64, 64);
              const whData = whCtx.getImageData(0, 0, 64, 64).data;
              let hairBright = 0, hairTotal = 0, allBright = 0, allTotal = 0;
              let grayPixels = 0; // gray/silver pixels (desaturated mid-bright)
              for (let pi = 0; pi < whData.length; pi += 4) {
                const row = Math.floor((pi / 4) / 64);
                const r = whData[pi], g = whData[pi+1], b = whData[pi+2];
                const l = 0.299*r + 0.587*g + 0.114*b;
                const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
                const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
                allTotal++;
                if (l > 160) allBright++; // bright pixel (lowered from 180)
                // Gray/silver: mid-bright + low saturation = gray hair
                if (l > 120 && l < 220 && sat < 0.20) grayPixels++;
                if (row < 20) { // top 30% of image (was 25%)
                  hairTotal++;
                  if (l > 150) hairBright++; // bright in hair zone (lowered from 180)
                }
              }
              const hairBrightRatio = hairTotal > 0 ? hairBright / hairTotal : 0;
              const allBrightRatio = allTotal > 0 ? allBright / allTotal : 0;
              const grayRatio = allTotal > 0 ? grayPixels / allTotal : 0;
              // White/gray hair: top 30% mostly bright OR significant gray pixels overall
              isWhiteHairPortrait = (hairBrightRatio > 0.28 && allBrightRatio > 0.35) || grayRatio > 0.25;
              console.log('[Studio] White-hair check: hairBright=' + hairBrightRatio.toFixed(2) + ' allBright=' + allBrightRatio.toFixed(2) + ' gray=' + grayRatio.toFixed(2) + ' → isWhiteHair=' + isWhiteHairPortrait);
            } catch { /* ignore */ }
          }

          if (isWhiteHairPortrait) {
            // White/gray hair + light skin: special profile to prevent over-correction
            const whiteHairPreset = {
              baseTiles: 100,           // fewer cols: larger tiles = less noise on bright skin
              tilePx: 9,               // larger tiles: smoother appearance for light areas
              maxReuse: 12,
              rotation: false,
              neighborRadius: 5,
              neighborPenalty: 160,     // lower: less aggressive anti-repetition for bright tiles
              contrastBoost: 1.45,      // higher: compensate for low-contrast bright areas
              histogramBlend: 0.07,     // low: prevent histogram from darkening whites
              baseOverlay: 0.28,        // higher: strengthen mosaic structure
              edgeBoost: 0.15,          // subtle edge enhancement
              overlayMode: 'softlight',
              labWeight: 0.30,          // color matching for subtle tones
              brightnessWeight: 0.70,   // high: prioritize brightness matching for bright skin/hair
              textureWeight: 0.05,
              edgeWeight: 0.05,
              saturationWeight: 0.20,   // low: allow desaturated tiles for white/gray areas
              lBlend: 0.35,             // lower: less luminance shifting
              abBlend: 0.12,            // much lower: preserve original pastel/neutral tones
              portraitMode: true,
            };
            localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(mergeWithAdmin(whiteHairPreset)));
            localStorage.removeItem('mosaicprint_selected_theme');
            setAutoPresetApplied('Weiße Haare');
            console.log('[Studio] Auto-applied White Hair preset');
          } else if (imageType === 'portrait') {
            const portraitPreset = {
              baseTiles: 120,         // 120 cols: more tiles = sharper facial features
               tilePx: 7,              // 7px tiles: finer detail for eyes/nose/mouth
               maxReuse: 8,            // increased: allows more reuse for smoother result (was 4)
               rotation: false,        // no rotation: keeps tile orientation consistent
               neighborRadius: 6,      // wider radius: more anti-repetition (was 5)
               neighborPenalty: 200,   // reduced: allow more reuse for smoother result (was 400)
              contrastBoost: 1.35,    // stronger contrast for crisp edges
              histogramBlend: 0.09,   // slightly more blend for smoother skin tones
              baseOverlay: 0.22,      // stronger overlay for clearer mosaic structure
              edgeBoost: 0.28,        // more edge sharpening on facial features
              overlayMode: 'softlight',
              labWeight: 0.15,
              brightnessWeight: 0.55, // slightly reduced: prevents over-darkening warm faces
              textureWeight: 0.10,
              edgeWeight: 0.20,
              saturationWeight: 0.35, // reduced: less aggressive sat-penalty → warmer tiles allowed
              portraitMode: true,
            };
            // Merge: Admin settings override preset (Admin wins)
            localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(mergeWithAdmin(portraitPreset)));
            // Clear theme filter so ALL tiles are available for skin tone matching
            localStorage.removeItem('mosaicprint_selected_theme');
            setAutoPresetApplied('Portrait');
          } else if (imageType === 'landscape') {
            // Landscape preset: wider tiles, more color accuracy
            const landscapePreset = {
              baseTiles: 60,
              tilePx: 16,             // Medium tiles for landscapes
              neighborRadius: 3,
              neighborPenalty: 120,
              contrastBoost: 1.15,
              histogramBlend: 0.05,
              baseOverlay: 0.12,
              edgeBoost: 0.18,
              labWeight: 0.20,
              brightnessWeight: 0.35,
              textureWeight: 0.08,
              edgeWeight: 0.20,
              saturationWeight: 0.25,
              portraitMode: false,
            };
            localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(mergeWithAdmin(landscapePreset)));
            setAutoPresetApplied('Landschaft');
          } else {
            // Abstract/general preset
            const abstractPreset = {
              baseTiles: 70,
              tilePx: 14,
              neighborRadius: 4,
              neighborPenalty: 160,
              contrastBoost: 1.20,
              histogramBlend: 0.05,
              baseOverlay: 0.12,
              edgeBoost: 0.18,
              labWeight: 0.18,
              brightnessWeight: 0.38,
              textureWeight: 0.10,
              edgeWeight: 0.20,
              saturationWeight: 0.30,
              portraitMode: false,
            };
            localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(mergeWithAdmin(abstractPreset)));
            setAutoPresetApplied(null);
          }

          // -- Gemini Vision async background analysis --
          // Runs after heuristic preset is applied; Gemini dynamicSettings REPLACE the heuristic preset
          (() => {
            try {
              const falCanvas = document.createElement('canvas');
              const falScale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
              falCanvas.width = Math.round(img.naturalWidth * falScale);
              falCanvas.height = Math.round(img.naturalHeight * falScale);
              const falCtx = falCanvas.getContext('2d')!;
              falCtx.drawImage(img, 0, 0, falCanvas.width, falCanvas.height);
              const falBase64 = falCanvas.toDataURL('image/jpeg', 0.7).split(',')[1];
              fetch('/api/analyze-image-fal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageBase64: falBase64, mimeType: 'image/jpeg' }),
                signal: AbortSignal.timeout(20000),
              }).then(r => r.json()).then((falResult: any) => {
                if (!falResult?.ok) return;
                const falHasFace: boolean = falResult.hasFace ?? false;
                const falSceneType: string = falResult.sceneType ?? '';
                const adminOverrides2 = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_overrides') || '{}'); } catch { return {}; } })();
                const mergeWithAdmin2 = (preset: Record<string, unknown>) => {
                  const merged = { ...preset, ...adminOverrides2 };
                  return merged;
                };
                // Extract Gemini region analysis and algo recommendations
                const geminiRegions = falResult.regions ?? null;
                const geminiAlgo = falResult.algoRecommendations ?? null;
                const geminiDynamic = falResult.dynamicSettings ?? null;

                // Store Gemini region data for use in matching algorithm
                if (geminiRegions) {
                  localStorage.setItem('mosaicprint_gemini_regions', JSON.stringify(geminiRegions));
                  console.log('[Studio] Gemini regions: face=' + (geminiRegions.face?.pct ?? 0) + '% bg=' + (geminiRegions.background?.pct ?? 0) + '%');
                }

                // ── Dynamic Settings: Gemini returns image-specific algo parameters ──
                // When useGemini is ON (default): apply Gemini settings DIRECTLY (no admin merge)
                // When useGemini is OFF: skip Gemini entirely, keep heuristic preset + admin overrides
                const geminiEnabled = useGeminiRef.current;

                if (geminiEnabled && geminiDynamic && typeof geminiDynamic.baseTiles === 'number') {
                  // Apply Gemini dynamic settings DIRECTLY (no admin override merge)
                  const dynamicPreset: Record<string, unknown> = {
                    baseTiles: geminiDynamic.baseTiles,
                    tilePx: geminiDynamic.tilePx ?? 8,
                    maxReuse: geminiDynamic.maxReuse ?? 10,
                    rotation: geminiDynamic.rotation ?? false,
                    neighborRadius: geminiDynamic.neighborRadius ?? geminiAlgo?.neighborRadius ?? 5,
                    neighborPenalty: geminiDynamic.neighborPenalty ?? geminiAlgo?.neighborPenalty ?? 200,
                    contrastBoost: geminiDynamic.contrastBoost ?? 1.30,
                    histogramBlend: geminiDynamic.histogramBlend ?? 0.08,
                    baseOverlay: geminiDynamic.baseOverlay ?? 0.15,
                    edgeBoost: geminiDynamic.edgeBoost ?? 0.15,
                    overlayMode: geminiDynamic.overlayMode ?? 'softlight',
                    labWeight: geminiDynamic.labWeight ?? 0.20,
                    brightnessWeight: geminiDynamic.brightnessWeight ?? 0.45,
                    textureWeight: geminiDynamic.textureWeight ?? 0.10,
                    edgeWeight: geminiDynamic.edgeWeight ?? 0.15,
                    saturationWeight: geminiDynamic.saturationWeight ?? 0.30,
                    portraitMode: geminiDynamic.portraitMode ?? falHasFace,
                    tileComplexityThreshold: geminiAlgo?.tileComplexityThreshold ?? 0.25,
                  };
                  // Gemini settings applied directly — no admin override merge
                  localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(dynamicPreset));

                  // Update detected type & preset label
                  const profile = geminiAlgo?.recommendedProfile ?? falSceneType ?? 'abstract';
                  if (falHasFace || profile === 'portrait') {
                    localStorage.removeItem('mosaicprint_selected_theme');
                    setAutoPresetApplied('KI-Dynamisch');
                    setDetectedImageType('portrait');
                  } else if (profile === 'landscape' || profile === 'nature') {
                    setAutoPresetApplied('KI-Dynamisch');
                    setDetectedImageType('landscape');
                  } else {
                    setAutoPresetApplied('KI-Dynamisch');
                    setDetectedImageType('abstract');
                  }

                  console.log('[Studio] Gemini dynamicSettings applied DIRECTLY (no admin merge): baseTiles=' + dynamicPreset.baseTiles + ' tilePx=' + dynamicPreset.tilePx + ' brightnessW=' + dynamicPreset.brightnessWeight + ' labW=' + dynamicPreset.labWeight + ' portrait=' + dynamicPreset.portraitMode);
                  console.log('[Studio] Gemini reasoning: ' + (geminiDynamic.reasoning ?? 'n/a'));
                } else if (geminiEnabled) {
                  // Gemini ON but no dynamicSettings returned: fallback with Gemini algo refinements
                  if (falHasFace && imageType !== 'portrait') {
                    const neighborPenalty = geminiAlgo?.neighborPenalty ?? 200;
                    const neighborRadius = geminiAlgo?.neighborRadius ?? 6;
                    const tileComplexityThreshold = geminiAlgo?.tileComplexityThreshold ?? 0.22;
                    const portraitPreset = { baseTiles: 120, tilePx: 7, maxReuse: 8, rotation: false, neighborRadius, neighborPenalty, contrastBoost: 1.35, histogramBlend: 0.09, baseOverlay: 0.22, edgeBoost: 0.28, overlayMode: 'softlight', labWeight: 0.15, brightnessWeight: 0.55, textureWeight: 0.10, edgeWeight: 0.20, saturationWeight: 0.35, portraitMode: true, tileComplexityThreshold };
                    localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(portraitPreset));
                    localStorage.removeItem('mosaicprint_selected_theme');
                    setAutoPresetApplied('Portrait');
                    setDetectedImageType('portrait');
                  } else if (!falHasFace && imageType === 'portrait') {
                    const neighborPenalty = geminiAlgo?.neighborPenalty ?? 280;
                    const neighborRadius = geminiAlgo?.neighborRadius ?? 4;
                    const recommendedProfile = geminiAlgo?.recommendedProfile ?? 'landscape';
                    const abstractPreset = { baseTiles: 70, tilePx: 14, neighborRadius, neighborPenalty, contrastBoost: 1.20, histogramBlend: 0.05, baseOverlay: 0.12, edgeBoost: 0.18, labWeight: 0.18, brightnessWeight: 0.38, textureWeight: 0.10, edgeWeight: 0.20, saturationWeight: 0.30, portraitMode: false };
                    localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(abstractPreset));
                    setAutoPresetApplied(null);
                    setDetectedImageType(recommendedProfile as any);
                  } else if (falHasFace && imageType === 'portrait' && geminiAlgo) {
                    const currentSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();
                    const refined = { ...currentSettings, neighborPenalty: geminiAlgo.neighborPenalty, neighborRadius: geminiAlgo.neighborRadius, tileComplexityThreshold: geminiAlgo.tileComplexityThreshold };
                    localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(refined));
                  }
                } else {
                  // Gemini OFF: keep heuristic preset + admin overrides (already applied above)
                  console.log('[Studio] Gemini OFF: keeping heuristic preset + admin overrides');
                }

                // Store full Gemini analysis for Admin Qualität tab (admin-only display)
                try {
                  localStorage.setItem('mosaicprint_gemini_analysis', JSON.stringify({
                    timestamp: new Date().toISOString(),
                    sceneType: falSceneType,
                    hasFace: falHasFace,
                    faceCount: falResult.faceCount ?? 0,
                    description: falResult.description ?? '',
                    attributes: falResult.attributes ?? {},
                    regions: geminiRegions,
                    algoRecommendations: geminiAlgo,
                    dynamicSettings: geminiDynamic,
                    appliedSettings: JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'),
                  }));
                  window.dispatchEvent(new Event('geminiAnalysisUpdated'));
                } catch { /* ignore */ }

                console.log('[Studio] Gemini result: sceneType=' + falSceneType + ' hasFace=' + falHasFace + ' profile=' + (geminiAlgo?.recommendedProfile ?? 'n/a'));
              }).catch(e => console.warn('[Studio] Gemini async failed:', e));
            } catch (e) { console.warn('[Studio] Gemini setup failed:', e); }
          })();

          // -- KI-Themen-Analyse: Farbpalette des Fotos analysieren --
          // Analysiert die dominanten Farbtoene und schlaegt passende Tile-Themen vor
          try {
            const paletteCanvas = document.createElement('canvas');
            paletteCanvas.width = 64; paletteCanvas.height = 64;
            const pCtx = paletteCanvas.getContext('2d')!;
            pCtx.drawImage(img, 0, 0, 64, 64);
            const pData = pCtx.getImageData(0, 0, 64, 64).data;

            // Analyse: Hue-Histogramm + Helligkeits- und Saettigungsverteilung
            let warmPixels = 0, coolPixels = 0, darkPixels = 0, brightPixels = 0;
            let greenPixels = 0, purplePixels = 0, totalPx = 0;
            let avgR = 0, avgG = 0, avgB = 0;
            // Hair zone: top 25% of image (rows 0-15 of 64px canvas)
            let hairBrightPx = 0, hairDarkPx = 0, hairTotalPx = 0;
            const HAIR_ZONE_END_ROW = 16; // top 25% of 64px canvas

            for (let pi = 0; pi < pData.length; pi += 4) {
              const pixelIdx = pi / 4;
              const row = Math.floor(pixelIdx / 64);
              const r = pData[pi], g = pData[pi+1], b = pData[pi+2];
              const l = 0.299*r + 0.587*g + 0.114*b; // luminance
              const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
              const s = maxC === 0 ? 0 : (maxC - minC) / maxC;
              // Hue
              let hue = 0;
              if (maxC !== minC) {
                if (maxC === r) hue = ((g - b) / (maxC - minC) + 6) % 6 * 60;
                else if (maxC === g) hue = ((b - r) / (maxC - minC) + 2) * 60;
                else hue = ((r - g) / (maxC - minC) + 4) * 60;
              }
              if (s > 0.15) { // only saturated pixels count for hue analysis
                if ((hue >= 0 && hue < 60) || (hue >= 300 && hue <= 360)) warmPixels++; // red/orange
                else if (hue >= 60 && hue < 150) greenPixels++; // yellow/green
                else if (hue >= 150 && hue < 260) coolPixels++; // cyan/blue
                else purplePixels++; // purple/magenta
              }
              if (l < 60) darkPixels++;
              if (l > 180) brightPixels++;
              avgR += r; avgG += g; avgB += b;
              totalPx++;
              // Hair zone analysis: top 25% of image
              if (row < HAIR_ZONE_END_ROW) {
                hairTotalPx++;
                if (l > 180) hairBrightPx++; // very bright = white/gray hair
                if (l < 80) hairDarkPx++;    // very dark = dark hair
              }
            }
            avgR /= totalPx; avgG /= totalPx; avgB /= totalPx;
            const warmRatio = warmPixels / totalPx;
            const coolRatio = coolPixels / totalPx;
            const greenRatio = greenPixels / totalPx;
            const purpleRatio = purplePixels / totalPx;
            const darkRatio = darkPixels / totalPx;
            const brightRatio = brightPixels / totalPx;
            // Hair zone ratios: how bright/dark is the top of the image
            const hairBrightRatio = hairTotalPx > 0 ? hairBrightPx / hairTotalPx : 0;
            const hairDarkRatio = hairTotalPx > 0 ? hairDarkPx / hairTotalPx : 0;

            // Profile-Scoring basierend auf Farbpalette – mappt auf die 9 Admin-Profile
            // Jedes Profil hat einen Score basierend auf Bildmerkmalen
            const PROFILE_SCORES: Array<{key: string; label: string; emoji: string; score: number; profileSettings: Record<string, unknown>}> = [
              {
                key: 'portrait', label: 'Portrait', emoji: '👤',
                score: (imageType === 'portrait') ? 3.0 : warmRatio * 0.8 + brightRatio * 0.5,
                profileSettings: { baseTiles: 120, tilePx: 8, baseOverlay: 0.20, edgeBoost: 0.0, brightnessWeight: 0.45, labWeight: 0.30, textureWeight: 0.12, edgeWeight: 0.13, contrastBoost: 1.28, histogramBlend: 0.08, overlayMode: 'softlight', enableRotation: false, neighborRadius: 6, neighborPenalty: 400 }
              },
              {
                key: 'portrait_dark', label: 'Portrait dunkel', emoji: '🧑🏿',
                score: (imageType === 'portrait' && darkRatio > 0.35) ? 2.5 : 0,
                profileSettings: { baseTiles: 120, tilePx: 8, baseOverlay: 0.18, edgeBoost: 0.0, brightnessWeight: 0.45, labWeight: 0.35, textureWeight: 0.10, edgeWeight: 0.10, contrastBoost: 1.15, histogramBlend: 0.09, overlayMode: 'softlight', enableRotation: false, neighborRadius: 6, neighborPenalty: 380 }
              },
              {
                key: 'white_hair', label: 'Weiße Haare', emoji: '👴',
                // Use hair zone (top 25% of image) bright ratio for accurate white hair detection
                // hairBrightRatio > 0.35: top of image is mostly bright = white/gray hair
                // Also require overall brightRatio > 0.50 to avoid false positives from bright backgrounds
                score: (imageType === 'portrait' && hairBrightRatio > 0.35 && brightRatio > 0.50) ? 2.0 : 0,
                profileSettings: { baseTiles: 120, tilePx: 8, baseOverlay: 0.20, edgeBoost: 0.0, brightnessWeight: 0.60, labWeight: 0.30, textureWeight: 0.05, edgeWeight: 0.05, contrastBoost: 1.20, histogramBlend: 0.07, overlayMode: 'softlight', enableRotation: false, neighborRadius: 6, neighborPenalty: 350 }
              },
              {
                key: 'landscape', label: 'Landschaft', emoji: '🏔️',
                score: greenRatio * 2.5 + (imageType !== 'portrait' ? brightRatio * 0.8 : 0),
                profileSettings: { baseTiles: 80, tilePx: 10, baseOverlay: 0.0, edgeBoost: 0.0, brightnessWeight: 0.28, labWeight: 0.40, textureWeight: 0.20, edgeWeight: 0.12, contrastBoost: 1.45, histogramBlend: 0.12, overlayMode: 'none', enableRotation: true, neighborRadius: 8, neighborPenalty: 150 }
              },
              {
                key: 'night', label: 'Nacht / Skyline', emoji: '🌃',
                score: darkRatio * 2.5 + coolRatio * 0.8,
                profileSettings: { baseTiles: 90, tilePx: 9, baseOverlay: 0.05, edgeBoost: 0.15, brightnessWeight: 0.35, labWeight: 0.25, textureWeight: 0.30, edgeWeight: 0.10, contrastBoost: 1.65, histogramBlend: 0.05, overlayMode: 'softlight', enableRotation: true, neighborRadius: 6, neighborPenalty: 200 }
              },
              {
                key: 'colorful', label: 'Farbenreich', emoji: '🎨',
                score: (warmRatio + purpleRatio) * 2.0 + brightRatio * 1.0,
                profileSettings: { baseTiles: 100, tilePx: 8, baseOverlay: 0.0, edgeBoost: 0.0, brightnessWeight: 0.25, labWeight: 0.45, textureWeight: 0.15, edgeWeight: 0.15, contrastBoost: 1.40, histogramBlend: 0.13, overlayMode: 'none', enableRotation: true, neighborRadius: 6, neighborPenalty: 200 }
              },
              {
                key: 'abstract_art', label: 'Abstrakt / Kunst', emoji: '🖼️',
                score: purpleRatio * 2.0 + (warmRatio + coolRatio) * 0.8,
                profileSettings: { baseTiles: 100, tilePx: 9, baseOverlay: 0.0, edgeBoost: 0.0, brightnessWeight: 0.20, labWeight: 0.50, textureWeight: 0.15, edgeWeight: 0.15, contrastBoost: 1.40, histogramBlend: 0.13, overlayMode: 'none', enableRotation: true, neighborRadius: 5, neighborPenalty: 180 }
              },
              {
                key: 'highres', label: 'Hochauflösend', emoji: '🔬',
                score: 0.5, // always available as option
                profileSettings: { baseTiles: 150, tilePx: 6, baseOverlay: 0.0, edgeBoost: 0.0, brightnessWeight: 0.45, labWeight: 0.25, textureWeight: 0.15, edgeWeight: 0.15, contrastBoost: 1.15, histogramBlend: 0.05, overlayMode: 'none', enableRotation: false, neighborRadius: 4, neighborPenalty: 310 }
              },
              {
                key: 'minimal', label: 'Minimalistisch', emoji: '⬜',
                score: brightRatio * 1.5 + (1 - warmRatio) * 0.5,
                profileSettings: { baseTiles: 140, tilePx: 7, baseOverlay: 0.0, edgeBoost: 0.0, brightnessWeight: 0.35, labWeight: 0.40, textureWeight: 0.15, edgeWeight: 0.10, contrastBoost: 1.10, histogramBlend: 0.06, overlayMode: 'none', enableRotation: false, neighborRadius: 5, neighborPenalty: 200 }
              },
            ];

            // Top 3 Profile nach Score, Mindest-Score 0.4
            const sorted = PROFILE_SCORES
              .filter(p => p.score > 0.4)
              .sort((a, b) => b.score - a.score)
              .slice(0, 3);
            setSuggestedThemes(sorted);
          } catch (e) {
            console.warn('[Studio] Theme analysis failed:', e);
          }

        } catch (e) {
          console.warn('[Studio] Auto-detection failed:', e);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, []);

  // Handle user tile photo uploads (multiple files)
  const handleTileUpload = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setUserTileFiles(prev => [...prev, ...imageFiles]);
    // Load all images:
    // - 64px thumbnail for tile matching (fast, low memory)
    // - 512/256px hi-res for zoom/detail (medium quality)
    // - ORIGINAL full-resolution for print quality (center-cropped, max quality)
    const isMobile = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    const HR_SIZE = isMobile ? 256 : 512;
    const loadPromises = imageFiles.map(file => new Promise<{thumb: HTMLImageElement; hires: HTMLImageElement; original: HTMLImageElement} | null>(resolve => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          // Center-crop to square
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          const sx = (img.naturalWidth - s) / 2;
          const sy = (img.naturalHeight - s) / 2;

          // 64x64 thumbnail for tile matching
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = 64; thumbCanvas.height = 64;
          const thumbCtx = thumbCanvas.getContext('2d')!;
          thumbCtx.drawImage(img, sx, sy, s, s, 0, 0, 64, 64);

          // Hi-res for detail popup and zoom rendering
          const hiresSize = Math.min(HR_SIZE, s); // don't upscale tiny originals
          const hiresCanvas = document.createElement('canvas');
          hiresCanvas.width = hiresSize; hiresCanvas.height = hiresSize;
          const hiresCtx = hiresCanvas.getContext('2d');
          if (hiresCtx) {
            hiresCtx.drawImage(img, sx, sy, s, s, 0, 0, hiresSize, hiresSize);
          } else {
            console.warn('[TileUpload] hi-res canvas context failed, using thumbnail');
          }

          // ORIGINAL: full-resolution center-cropped square for print quality
          // Cap at 2048px to avoid memory issues, but keep as large as possible
          const MAX_ORIG = isMobile ? 1024 : 2048;
          const origSize = Math.min(MAX_ORIG, s);
          const origCanvas = document.createElement('canvas');
          origCanvas.width = origSize; origCanvas.height = origSize;
          const origCtx = origCanvas.getContext('2d');
          if (origCtx) {
            origCtx.drawImage(img, sx, sy, s, s, 0, 0, origSize, origSize);
          }

          const thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.85);
          const hiresDataUrl = hiresCtx ? hiresCanvas.toDataURL('image/jpeg', 0.92) : thumbDataUrl;
          const origDataUrl = origCtx ? origCanvas.toDataURL('image/jpeg', 0.95) : hiresDataUrl;

          let loaded = 0;
          const thumbImg = new Image();
          const hiresImg = new Image();
          const origImg = new Image();
          const checkDone = () => {
            loaded++;
            if (loaded === 3) resolve({ thumb: thumbImg, hires: hiresImg, original: origImg });
          };
          thumbImg.onload = checkDone;
          thumbImg.onerror = () => resolve(null);
          hiresImg.onload = checkDone;
          hiresImg.onerror = () => { console.warn('[TileUpload] hires image load failed'); loaded++; if (loaded === 3) resolve({ thumb: thumbImg, hires: thumbImg, original: thumbImg }); };
          origImg.onload = checkDone;
          origImg.onerror = () => { console.warn('[TileUpload] original image load failed'); loaded++; if (loaded === 3) resolve({ thumb: thumbImg, hires: hiresImg, original: hiresImg }); };
          thumbImg.src = thumbDataUrl;
          hiresImg.src = hiresDataUrl;
          origImg.src = origDataUrl;
          console.log(`[TileUpload] ${file.name}: original=${img.naturalWidth}x${img.naturalHeight} → thumb=64, hires=${hiresSize}, print=${origSize}px`);
        };
        img.onerror = () => resolve(null);
        img.src = e.target?.result as string;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    }));
    Promise.all(loadPromises).then(results => {
      const valid = results.filter(Boolean) as {thumb: HTMLImageElement; hires: HTMLImageElement; original: HTMLImageElement}[];
      const thumbs = valid.map(v => v.thumb);
      const hires = valid.map(v => v.hires);
      const originals = valid.map(v => v.original);
      setUserTileImages(prev => {
        const next = [...prev, ...thumbs];
        userTileImagesRef.current = next;
        return next;
      });
      userTileHiResRef.current = [...userTileHiResRef.current, ...hires];
      userTileOriginalRef.current = [...userTileOriginalRef.current, ...originals];
    });
  }, []);

  const removeUserTile = useCallback((index: number) => {
    setUserTileFiles(prev => prev.filter((_, i) => i !== index));
    setUserTileImages(prev => {
      const next = prev.filter((_, i) => i !== index);
      userTileImagesRef.current = next;
      return next;
    });
    userTileHiResRef.current = userTileHiResRef.current.filter((_, i) => i !== index);
    userTileOriginalRef.current = userTileOriginalRef.current.filter((_, i) => i !== index);
  }, []);

  // Auto-render when photo is loaded
  useEffect(() => {
    if (!userPhotoImg) return;
    // Skip auto-render when loading a saved project (it already has a rendered mosaic image)
    if (skipAutoRenderRef.current) {
      skipAutoRenderRef.current = false;
      return;
    }
    const run = async () => {
      setLoading(true);
      setProgress(0);
      setProgressMsg("Initialisiere...");
      // Wait for React to re-render and mount the canvas into the DOM
      // before calling renderMosaic which needs canvasRef.current
      await new Promise(r => setTimeout(r, 50));
      try {
        // MOBILE: Downscale user photo to max 2048px to save decoded memory
        // A 12MP photo = 48MB decoded. At 2048px max → ~8MB. Mosaic only needs ~500px target.
        let renderImg = userPhotoImg;
        const _isMob = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
        if (_isMob && (userPhotoImg.naturalWidth > 2048 || userPhotoImg.naturalHeight > 2048)) {
          const scale = 2048 / Math.max(userPhotoImg.naturalWidth, userPhotoImg.naturalHeight);
          const w = Math.round(userPhotoImg.naturalWidth * scale);
          const h = Math.round(userPhotoImg.naturalHeight * scale);
          const tmpC = document.createElement('canvas');
          tmpC.width = w; tmpC.height = h;
          tmpC.getContext('2d')!.drawImage(userPhotoImg, 0, 0, w, h);
          renderImg = await new Promise<HTMLImageElement>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = tmpC.toDataURL('image/jpeg', 0.92);
          });
          console.log(`[Studio] Mobile: downscaled user photo from ${userPhotoImg.naturalWidth}x${userPhotoImg.naturalHeight} to ${w}x${h}`);
        }
        await renderMosaic(renderImg);
      } catch (e) {
        setError("Fehler beim Rendern: " + String(e));
        setLoading(false);
      }
    };
    run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPhotoImg]);

  const renderMosaic = useCallback(async (targetImg: HTMLImageElement) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    resetHiRes();
    setQualityMetrics(null);
    setRenderPass(null);
    setDebugReport(null);
    const _debugStartMs = performance.now();

    const savedSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();
    // Load Gemini region analysis (set async after image upload)
    const geminiRegions: Record<string, { pct: number; dominantColor: string; tileComplexityMax: number; preferCalm: boolean; notes: string }> | null =
      (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_gemini_regions') || 'null'); } catch { return null; } })();
    // Global tileComplexity threshold from Gemini (overrides hardcoded values if available)
    const geminiComplexityThreshold: number | null = savedSettings.tileComplexityThreshold ?? null;
    const BASE_TILES = savedSettings.baseTiles ?? 60;  // Mosaicer-style: fewer, larger tiles
    const imgAspect = targetImg.naturalWidth / targetImg.naturalHeight;
    const COLS = imgAspect >= 1 ? BASE_TILES : Math.round(BASE_TILES * imgAspect);
    const ROWS = imgAspect >= 1 ? Math.round(BASE_TILES / imgAspect) : BASE_TILES;
    const TILE_PX = savedSettings.tilePx ?? 16;  // Larger tiles = more recognizable photos
    const CANVAS_W = COLS * TILE_PX;
    const CANVAS_H = ROWS * TILE_PX;
    const MAX_DISPLAY_W = 720;
    const DISPLAY_SCALE = Math.min(8 / TILE_PX, MAX_DISPLAY_W / CANVAS_W);

    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.width = `${Math.round(CANVAS_W * DISPLAY_SCALE)}px`;
    canvas.style.height = `${Math.round(CANVAS_H * DISPLAY_SCALE)}px`;
    (canvas as any)._displayScale = DISPLAY_SCALE;
    mosaicParamsRef.current = { cols: COLS, rows: ROWS, tilePx: TILE_PX, canvasW: CANVAS_W, canvasH: CANVAS_H };
    (mosaicParamsRef.current as any)._displayScale = DISPLAY_SCALE;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // ???????????????????????????????????????????????????????????????????????
    // SSD PIXEL-LEVEL MATCHING (inspired by Mosaicer open-source engine)
    // Instead of comparing 1 average color per tile, we compare EVERY PIXEL
    // of each tile against the corresponding target region.
    // This gives 192x more information (8x8x3 channels vs 1x3 channels).
    // ???????????????????????????????????????????????????????????????????????

    const SSD_SIZE = 8; // Each tile & target region scaled to 8x8 for matching
    const TOTAL_TILES = COLS * ROWS;

    // Step 1: Create full-resolution target at SSD_SIZE per cell
    // Target image scaled to (COLS * SSD_SIZE) x (ROWS * SSD_SIZE)
    setProgressMsg("Analysiere Foto...");
    setProgress(5);
    const targetW = COLS * SSD_SIZE;
    const targetH = ROWS * SSD_SIZE;
    const targetCanvas = document.createElement("canvas");
    targetCanvas.width = targetW; targetCanvas.height = targetH;
    const targetCtx = targetCanvas.getContext("2d")!;
    targetCtx.drawImage(targetImg, 0, 0, targetW, targetH);
    const targetPixels = targetCtx.getImageData(0, 0, targetW, targetH).data;

    // Create overlay image at canvas aspect ratio (prevents misalignment on mobile)
    {
      const olCanvas = document.createElement('canvas');
      olCanvas.width = CANVAS_W; olCanvas.height = CANVAS_H;
      olCanvas.getContext('2d')!.drawImage(targetImg, 0, 0, CANVAS_W, CANVAS_H);
      setUserOverlayUrl(olCanvas.toDataURL('image/jpeg', 0.92));
    }

    // Extract target region pixels for each cell (flattened RGB arrays)
    // targetRegions[cellIndex] = Uint8Array of SSD_SIZE*SSD_SIZE*3 values
    const targetRegions: Uint8Array[] = new Array(TOTAL_TILES);
    for (let row = 0; row < (ROWS); row++) {
      for (let col = 0; col < (COLS); col++) {
        const ci = row * COLS + col;
        const region = new Uint8Array(SSD_SIZE * SSD_SIZE * 3);
        let ri = 0;
        for (let py = 0; py < (SSD_SIZE); py++) {
          for (let px = 0; px < (SSD_SIZE); px++) {
            const srcX = col * SSD_SIZE + px;
            const srcY = row * SSD_SIZE + py;
            const si = (srcY * targetW + srcX) * 4;
            region[ri++] = targetPixels[si];
            region[ri++] = targetPixels[si + 1];
            region[ri++] = targetPixels[si + 2];
          }
        }
        targetRegions[ci] = region;
      }
    }

    // Free targetCanvas memory (data already extracted into targetRegions)
    targetCanvas.width = 0; targetCanvas.height = 0;

    // Also keep a 1px-per-cell version for overlay/fallback
    const offscreen = document.createElement("canvas");
    offscreen.width = COLS; offscreen.height = ROWS;
    const offCtx = offscreen.getContext("2d")!;
    offCtx.drawImage(targetImg, 0, 0, COLS, ROWS);
    const targetData = offCtx.getImageData(0, 0, COLS, ROWS).data;

    // -- Low-Frequency Guidance (most important trick for mosaic quality) ------
    // Apply Gaussian blur to extract low-frequency structure (face shape, shadows)
    // Matching against blurred target: clearer faces, less noisy mosaic
    const BLUR_RADIUS = 2; // blur in tile-grid pixels (= ~30px at 1:15 scale)
    const blurredData = new Uint8ClampedArray(targetData.length);
    for (let row = 0; row < (ROWS); row++) {
      for (let col = 0; col < (COLS); col++) {
        let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
        for (let dr = -BLUR_RADIUS; dr <= (BLUR_RADIUS); dr++) {
          for (let dc = -BLUR_RADIUS; dc <= (BLUR_RADIUS); dc++) {
            const nr = row + dr, nc = col + dc;
            if (nr < 0 || nr >= (ROWS) || nc < 0 || nc >= (COLS)) continue;
            // Gaussian weight: exp(-(dr^2+dc^2)/(2*sigma^2)), sigma=BLUR_RADIUS/2
            const sigma = BLUR_RADIUS / 1.5;
            const w = Math.exp(-(dr*dr + dc*dc) / (2 * sigma * sigma));
            const ni = (nr * COLS + nc) * 4;
            rSum += targetData[ni] * w;
            gSum += targetData[ni+1] * w;
            bSum += targetData[ni+2] * w;
            wSum += w;
          }
        }
        const bi = (row * COLS + col) * 4;
        blurredData[bi]   = rSum / wSum;
        blurredData[bi+1] = gSum / wSum;
        blurredData[bi+2] = bSum / wSum;
        blurredData[bi+3] = 255;
      }
    }
    // Use blurred data for tile matching (low-frequency guidance)
    const cellLab: [number, number, number][] = [];
    for (let row = 0; row < (ROWS); row++) {
      for (let col = 0; col < (COLS); col++) {
        const i = (row * COLS + col) * 4;
        // Mix: 50% blurred (structure) + 50% original (color accuracy)
        // Reduced blur weight for sharper contour matching (was 70/30)
        const r = blurredData[i] * 0.5 + targetData[i] * 0.5;
        const g = blurredData[i+1] * 0.5 + targetData[i+1] * 0.5;
        const b = blurredData[i+2] * 0.5 + targetData[i+2] * 0.5;
        cellLab.push(rgbToLab(r, g, b));
      }
    }
    const saliency: number[] = new Array(TOTAL_TILES).fill(0);
    const edgeMap: number[] = new Array(TOTAL_TILES).fill(0); // normalized 0-1

    // Full Sobel on the offscreen canvas (3x3 kernel)
    // Compute on full-res offscreen for accuracy
    const edgeOffscreen = document.createElement('canvas');
    edgeOffscreen.width = COLS; edgeOffscreen.height = ROWS;
    const eCtx = edgeOffscreen.getContext('2d')!;
    eCtx.drawImage(targetImg, 0, 0, COLS, ROWS);
    const eData = eCtx.getImageData(0, 0, COLS, ROWS).data;

    let maxEdge = 0;
    const rawEdge: number[] = new Array(TOTAL_TILES).fill(0);
    // Store Sobel gradient direction (gx, gy) for edge-aware quadrant matching
    const sobelGx: number[] = new Array(TOTAL_TILES).fill(0);
    const sobelGy: number[] = new Array(TOTAL_TILES).fill(0);
    for (let row = 1; row < (ROWS) - 1; row++) {
      for (let col = 1; col < (COLS) - 1; col++) {
        // Sobel 3x3 on luminance
        const lum = (r: number, c: number) => {
          const i = (r * COLS + c) * 4;
          return 0.299 * eData[i] + 0.587 * eData[i+1] + 0.114 * eData[i+2];
        };
        const gx = -lum(row-1,col-1) + lum(row-1,col+1)
                   -2*lum(row,col-1) + 2*lum(row,col+1)
                   -lum(row+1,col-1) + lum(row+1,col+1);
        const gy = -lum(row-1,col-1) - 2*lum(row-1,col) - lum(row-1,col+1)
                   +lum(row+1,col-1) + 2*lum(row+1,col) + lum(row+1,col+1);
        const mag = Math.sqrt(gx*gx + gy*gy);
        const ci = row * COLS + col;
        rawEdge[ci] = mag;
        sobelGx[ci] = gx;
        sobelGy[ci] = gy;
        if (mag > maxEdge) maxEdge = mag;
      }
    }
    // Normalize edge map to 0-1
    const edgeNorm = maxEdge > 0 ? 1 / maxEdge : 1;
    for (let ci = 0; ci < (TOTAL_TILES); ci++) {
      edgeMap[ci] = rawEdge[ci] * edgeNorm;
      saliency[ci] = edgeMap[ci]; // saliency = edge strength
    }

    // Free temporary canvases to reduce memory pressure on mobile
    edgeOffscreen.width = 0; edgeOffscreen.height = 0;
    offscreen.width = 0; offscreen.height = 0;

    // Step 2: 2-STAGE MATCHING
    // Stage A: LAB k-NN over ALL tiles in DB (no image loading needed)
    //   -> For each mosaic cell, find Top-K candidates by LAB distance
    // Stage B: Load only the Top-K tile images, compute SSD, pick best
    //   -> Only ~30 images per cell are ever loaded (vs 2000 before)
    //
    // This gives: better quality (all 12K tiles searched) + faster loading
    const isMobile = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    const isMobileOrSlow = isMobile || (navigator as any).connection?.effectiveType === "2g";

    // FIX: Mobile gets reduced grid to prevent memory crash (iOS canvas limit ~16MP)
    // iOS Safari kills tabs at ~150 MB RAM. Each tile image ~20 KB -> max ~400 tiles in memory.
    // With baseTiles=40, tilePx=12: 40x50x12px = 480x600px canvas, ~2000 cells
    // TOP_K=15 -> ~1200 unique tiles needed (well within 400 LRU cache limit)
    // Portrait mode: enforce critical parameters regardless of device or Admin overrides.
    // Admin may have saved tilePx:16 into mosaicprint_algo_settings, which would override the preset.
    // We enforce portrait-critical caps here at render time so they always apply.
    if (savedSettings.portraitMode === true) {
      // tilePx: portrait needs fine tiles (max 8px) for face detail
      if ((savedSettings.tilePx ?? 16) > 8) {
        console.log('[Studio] Portrait: capping tilePx from', savedSettings.tilePx, '→ 8');
        savedSettings.tilePx = 8;
      }
      // enableRotation: portrait tiles must not rotate (ruins face structure)
      if (savedSettings.enableRotation !== false) {
        console.log('[Studio] Portrait: disabling rotation (was', savedSettings.enableRotation, ')');
        savedSettings.enableRotation = false;
      }
    }

    if (isMobile) {
      // Mobile caps: portrait gets more tiles/smaller tiles for face sharpness
      // Portrait: 90 tiles x 8px = 720x960px canvas, ~8100 cells -> ~26 MB RAM (safe)
      // Non-portrait: 60 tiles x 10px = 600x800px canvas, ~3600 cells -> ~14 MB RAM
      const isPortraitMode = savedSettings.portraitMode === true;
      const mobileMaxTiles = isPortraitMode ? 90 : 60;  // portrait: more tiles for face detail
      const mobileTilePxMax = isPortraitMode ? 8 : 10;  // cap tile size DOWN for sharpness
      if (savedSettings.baseTiles > mobileMaxTiles) savedSettings.baseTiles = mobileMaxTiles;
      // FIX: cap tilePx from ABOVE (large tiles → small), not from below
      // Old localStorage may have tilePx=16 (landscape preset) → must be capped to 8 for portrait
      if (savedSettings.tilePx > mobileTilePxMax) savedSettings.tilePx = mobileTilePxMax;
      console.log('[Studio] Mobile (' + (isPortraitMode ? 'portrait' : 'default') + '): capped to', savedSettings.baseTiles, 'tiles x', savedSettings.tilePx, 'px');
    }

     // -- Stage A: Load LAB index (if not already loaded) ----------------------
    setProgressMsg("Lade LAB-Index aller Kacheln...");
    setProgress(10);
    // Theme filter: if a theme is selected, always reload the index with theme param
    const currentTheme = selectedThemeRef.current;
    const themeParam = (currentTheme && currentTheme !== 'alle') ? `?theme=${encodeURIComponent(currentTheme)}` : '';
    let labIndex: Float32Array | null = (currentTheme === 'alle') ? labIndexRef.current : null;
    if (!labIndex) {
      try {
        const r = await fetch(`/api/tile-lab-index${themeParam}`);
        if (r.ok) {
          const floatsPerTile = Number(r.headers.get('X-Floats-Per-Tile') ?? '4');
          floatsPerTileRef.current = floatsPerTile;
          const buf = await r.arrayBuffer();
          labIndex = new Float32Array(buf);
          console.log(`[Studio] LAB index loaded: ${labIndex.length} floats, ${floatsPerTile} per tile = ${Math.floor(labIndex.length / floatsPerTile)} tiles`);
          if (currentTheme === 'alle') {
            labIndexRef.current = labIndex;
            labIndexLoadedRef.current = true;
          }
        } else {
          console.warn(`[Studio] LAB index fetch failed: HTTP ${r.status}`);
        }
      } catch (labErr) {
        console.warn('[Studio] LAB index fetch error:', labErr);
      }
    }

    const FPT = floatsPerTileRef.current; // floats per tile: 4 (legacy), 7 (7D), 14 (14D), 15 (15D with isSkinFriendly), 16 (16D with tileComplexity), 17 (17D with mosaicScore), 18 (18D with blurNorm)
    const IS_16D = FPT >= 16; // includes tileComplexity
    const IS_17D = FPT >= 17; // includes mosaicScore (AI quality tiebreaker)
    const IS_18D = FPT >= 18; // includes blurNorm (Laplacian sharpness, 0=blurry, 1=sharp)
    const currentTileSourceMode = tileSourceModeRef.current;
    const skipDbTiles = currentTileSourceMode === 'own' && userTileImagesRef.current.length >= MIN_OWN_TILES;
    const USE_2STAGE = !skipDbTiles && labIndex !== null && labIndex.length >= (FPT);
    const TOTAL_DB_TILES = USE_2STAGE ? Math.floor(labIndex!.length / FPT) : 0;
    const IS_7D = FPT >= 7;
    const IS_14D = FPT >= 14;
    const IS_15D = FPT >= 15; // includes isSkinFriendly flag
    console.log(`[Studio] 2-stage matching: ${USE_2STAGE ? `YES (${TOTAL_DB_TILES} tiles, ${FPT}D index)` : 'NO (fallback to legacy)'}`);

    // -- Stage A helper: multi-dimensional k-NN over all DB tiles ---------------------
    // 14D distance: global LAB + quadrant a/b (8 values) + edge + brightness
    // Quadrant colors catch color gradients (e.g. blue sky top / green grass bottom)
    // TOP_K=80 gives SSD stage enough diverse candidates to avoid repetition
    const TOP_K = isMobileOrSlow ? 100 : 150; // More candidates = better face detail on mobile too (was 80/120)
    const knnLAB = (
      targetL: number, targetA: number, targetB: number,
      targetEdge = 0, targetBrightness = targetL / 100, targetSat = 0,
      targetQuadA: [number,number,number,number] = [targetA,targetA,targetA,targetA],
      targetQuadB: [number,number,number,number] = [targetB,targetB,targetB,targetB],
      edgeQuadBoost = 1.0 // multiplier for W_QUAD on edge cells (>1 = prefer gradient tiles)
    ): Array<{tileId: number; labDist: number}> => {
      if (!labIndex) return [];
      // Weighted distance in feature space
      // Global LAB: perceptual color distance (primary signal)
      // Quadrant a/b: color distribution within tile (catches gradients)
      // Edge: shape similarity
      // Brightness: prevents dark tiles in bright areas
      // Dynamic AB weights: boost color matching for saturated target areas (red jacket, blue sky, green grass etc.)
      // targetSat 0-1: at sat=0.3 (moderately colorful), W_A/W_B = 3.2; at sat=0.6+, W_A/W_B = 5.0
      const satBoost = Math.min(3.0, targetSat * 5.0); // 0 at gray, up to +3.0 at fully saturated
      const W_L = 1.2, W_A = 2.0 + satBoost, W_B = 2.0 + satBoost; // Dynamic: 2.0 (gray) to 5.0 (saturated)
      // W_QUAD: Quadrant-a/b-Matching in Stage A (spatial color distribution).
      // For edge cells, edgeQuadBoost pushes gradient-matching tiles into the Top-K candidates.
      // Higher base (0.35) ensures quadrant color matters even for non-edge cells.
      const W_QUAD = IS_14D ? 0.35 * edgeQuadBoost : 0;
      // W_EDGE: active for all index types - edge energy drives contour sharpness
      const W_EDGE = IS_7D ? 25.0 : 22.0;
      // W_BRIGHT: brightness matching - prevents dark tiles in bright areas
      const W_BRIGHT = IS_7D ? 15.0 : 10.0;
      // Gray-penalty: when target cell is colorful (sat > 0.12), penalize gray tiles (sat < 0.08)
      // Stronger penalty for very saturated areas (red, blue, green objects)
      const GRAY_PENALTY = Math.max(0, (targetSat - 0.12) * 400); // Increased from 250 for better color accuracy
      const heap: Array<{tileId: number; labDist: number; mosaicScore: number}> = [];
      let maxDist = Infinity;
      let worstIdx = 0;
      for (let i = 0; i < labIndex.length; i += (FPT)) {
        const id = labIndex[i];
        const L = labIndex[i + 1];
        const a = labIndex[i + 2];
        const b = labIndex[i + 3];
        const dL = targetL - L, dA = targetA - a, dB = targetB - b;
        let dist = W_L*dL*dL + W_A*dA*dA + W_B*dB*dB;
        // Early termination: skip expensive penalty calculations when base LAB cost already
        // exceeds the current worst candidate in the heap (tile cannot improve Top-K).
        if (dist >= maxDist) continue;
        if (IS_14D) {
          // Quadrant a/b: [4]=TL_a, [5]=TL_b, [6]=TR_a, [7]=TR_b
          //               [8]=BL_a, [9]=BL_b, [10]=BR_a, [11]=BR_b
          const dTLa = targetQuadA[0] - labIndex[i+4], dTLb = targetQuadB[0] - labIndex[i+5];
          const dTRa = targetQuadA[1] - labIndex[i+6], dTRb = targetQuadB[1] - labIndex[i+7];
          const dBLa = targetQuadA[2] - labIndex[i+8], dBLb = targetQuadB[2] - labIndex[i+9];
          const dBRa = targetQuadA[3] - labIndex[i+10], dBRb = targetQuadB[3] - labIndex[i+11];
          dist += (W_QUAD)*(dTLa*dTLa + dTLb*dTLb + dTRa*dTRa + dTRb*dTRb +
                          dBLa*dBLa + dBLb*dBLb + dBRa*dBRa + dBRb*dBRb);
          const edge = labIndex[i + 12];
          const brightness = labIndex[i + 13];
          dist += (W_EDGE)*(targetEdge-edge)*(targetEdge-edge) + W_BRIGHT*(targetBrightness-brightness)*(targetBrightness-brightness);
          // Extra brightness penalty: dark tile in bright area
          // MASSIV verstärkt: dark tiles in bright backgrounds are very visible
          if (targetBrightness > 0.55 && brightness < 0.30) {
            const darkPenalty = (0.30 - brightness) * (targetBrightness - 0.55) * 1500;
            dist += darkPenalty; // up to +200 for very dark tile in very bright area
          }
          // Moderate mismatch: tile noticeably darker than target
          if (targetBrightness > 0.50 && brightness < targetBrightness - 0.30) {
            dist += (targetBrightness - brightness - 0.30) * 400; // gradual penalty
          }
          // CRITICAL FIX: Bright tile in dark area penalty (prevents white spots in dark clothing/hair)
          // A bright tile (brightness>0.55) in a dark area (targetBrightness<0.35) is almost never correct
          if (targetBrightness < 0.35 && brightness > 0.55) {
            const brightInDarkPenalty = (brightness - 0.55) * (0.35 - targetBrightness) * 2000;
            dist += brightInDarkPenalty; // up to +300 for very bright tile in very dark area
          }
          // ── Color-Mismatch-Penalty (konsolidiert aus: Gray-, Skin-, Green-, Blue-Penalty) ──
          // Alle Farb-Mismatch-Penalties sind hier zusammengefasst, um Überlappungen zu vermeiden.
          const sat = Math.min(1, Math.sqrt(a*a + b*b) / 60); // Tile-Sättigung 0-1
          const isTargetSkinArea = targetL >= 35 && targetL <= 85 && targetA >= 2 && targetA <= 30;

          // (A) Gray-Penalty: graue Tiles in farbigen Bereichen bestrafen
          // Nur aktiv wenn Zielbereich Farbe hat (targetSat > 0.12)
          if (GRAY_PENALTY > 0 && sat < 0.08) dist += GRAY_PENALTY;

          // (B) Color-Mismatch-Penalty: Tile-Farbe weicht stark von Ziel-Farbe ab
          // Ersetzt: "Extra low-sat penalty" + "Skin-Penalty" (beide waren überlappend)
          // Aktiv wenn: Ziel hat Farbe (targetSat > 0.10) UND Tile ist fast grau (sat < 0.15)
          if (targetSat > 0.10 && sat < 0.15) {
            // Skaliert mit Ziel-Sättigung: je farbiger das Ziel, desto höher die Strafe
            dist += (0.15 - sat) * targetSat * 600; // max +90 bei sat=0 und targetSat=1
          }

          // (C) Hue-Mismatch-Penalty für Hautton-Bereiche: grüne/blaue Tiles bestrafen
          // MASSIV verstärkt: Nur warme/braune Tiles dürfen in Gesichtsbereiche
          if (isTargetSkinArea) {
            // Grüne Tiles (a < -3): fast nie passend für Gesichter
            if (a < -3) dist += Math.min(2000, (-a - 3) * 80);
            // Kühle/blaue Tiles (b < 5): Hauttöne haben typisch b > 10
            // MASSIV: Jede Tile unter b=5 ist zu kühl für Gesichter
            if (b < 5) dist += Math.min(2000, (5 - b) * 60);
            // Warm-Cool-Gap: Je wärmer das Ziel, desto stärker Strafe für kühle Tiles
            if (targetB > 5 && b < 8) {
              dist += Math.min(1500, (targetB - 5) * (8 - b) * 8);
            }
            // Cool-A penalty: Haut hat a > 3, Tiles mit a < 2 bestrafen
            if (a < 2 && targetA > 3) {
              dist += Math.min(1000, (2 - a) * (targetA - 3) * 12);
            }
            // Non-warm tile penalty: Tile ist nicht warm (a<3 OR b<5) → hard penalty
            const tileIsWarmKnn = a > 3 && b > 5;
            if (!tileIsWarmKnn) dist += 500;
          }

          // (D) isSkinFriendly (15D): Nicht-Hautton-Tiles in Gesichtsbereichen bestrafen
          if (IS_15D && savedSettings.portraitMode) {
            const isSkinFriendlyTile = labIndex[i + 14] > 0.5;
            if (isTargetSkinArea && !isSkinFriendlyTile) dist += 500;
          }
           // tileComplexity (16D): calm=0.0, medium=0.5, busy=1.0
           // Smooth target areas (sky, water, skin) should use calm tiles
           // Detailed target areas (hair, texture, edges) can use busy tiles
           if (IS_16D) {
             const tileComplexity = labIndex[i + 15]; // 0=calm, 0.5=medium, 1=busy
             const cellEdge = targetEdge; // 0-1 target edge energy (passed as parameter)
             // Gemini-based global threshold: if Gemini says max complexity=0.22, apply globally
             const globalMaxComplexity = geminiComplexityThreshold ?? 1.0;
             if (globalMaxComplexity < 1.0 && tileComplexity > globalMaxComplexity) {
               dist += (tileComplexity - globalMaxComplexity) * 600; // Gemini-guided global penalty
             }
             if (cellEdge < 0.15) {
               // Very smooth target (sky, fog, skin highlight): AGGRESSIVELY penalize busy tiles
               if (tileComplexity > 0.30) dist += (tileComplexity - 0.30) * 900; // up to +630
             } else if (cellEdge < 0.30) {
               // Smooth target (skin, calm water, background): strongly penalize busy tiles
               if (tileComplexity > 0.40) dist += (tileComplexity - 0.40) * 700; // up to +420
             } else if (cellEdge < 0.50) {
               // Moderate target (face skin, gradients): penalize busy tiles
               if (tileComplexity > 0.55) dist += (tileComplexity - 0.55) * 500; // up to +225
             } else if (cellEdge < 0.70) {
               // Higher-edge target: still penalize very busy tiles
               if (tileComplexity > 0.75) dist += (tileComplexity - 0.75) * 300; // up to +75
             } else if (cellEdge > 0.70 && tileComplexity < 0.2) {
               // Very detailed target + calm tile = mild penalty (calm tiles lack detail for edges)
               dist += (0.2 - tileComplexity) * 80; // up to +16
             }
           }
        } else if (IS_7D) {
          const edge = labIndex[i + 4];
          const brightness = labIndex[i + 5];
          const sat = labIndex[i + 6];
          const dEdge = targetEdge - edge;
          const dBright = targetBrightness - brightness;
          const dSat = targetSat - sat;
          dist += (W_EDGE)*dEdge*dEdge + W_BRIGHT*dBright*dBright + (10.0)*dSat*dSat;
          // Gray-penalty: penalize gray tiles when target is colorful
          if (GRAY_PENALTY > 0 && sat < 0.08) dist += (GRAY_PENALTY);
        }
        // CRITICAL FIX: Bright tile in dark area penalty (prevents white spots in dark clothing/hair)
        // Must be OUTSIDE IS_14D/IS_16D blocks so it applies to ALL index types (7D, 14D, 15D, 16D, 17D)
        // brightness is at [13] for 14D+, [5] for 7D
        const tileBrightness = IS_7D && !IS_14D ? labIndex[i + 5] : (IS_14D ? labIndex[i + 13] : 0.5);
        if (targetBrightness < 0.35 && tileBrightness > 0.55) {
          // Bright tile in dark area: strong penalty to prevent white spots
          dist += (tileBrightness - 0.55) * (0.35 - targetBrightness) * 3000; // up to +450
        }
        // Also penalize dark tiles in very bright areas (symmetric)
        if (targetBrightness > 0.70 && tileBrightness < 0.15) {
          dist += (0.15 - tileBrightness) * (targetBrightness - 0.70) * 1000; // up to +150
        }
        // mosaicScore as REAL penalty (not just tiebreaker): low-quality tiles get penalized
        // mosaicScore=1.0 (excellent) → 0 penalty
        // mosaicScore=0.7 (good)      → +90 penalty
        // mosaicScore=0.5 (fair)      → +210 penalty
        // mosaicScore=0.3 (poor)      → +330 penalty
        // mosaicScore=0.0 (reject)    → +450 penalty
        // This ensures high-quality tiles (gradients, bokeh, calm landscapes) beat
        // low-quality tiles (animals, single objects, busy scenes) even at same LAB distance
        const mosaicScore = IS_17D ? labIndex[i + 16] : 0.68;
        if (IS_17D && mosaicScore < 1.0) {
          dist += (1.0 - mosaicScore) * 450; // max +450 for score=0
        }
        // blurNorm penalty (18D): penalize blurry tiles
        // blurNorm=0.0 (very blurry) → +300 penalty
        // blurNorm=0.5 (medium)      → +150 penalty
        // blurNorm=1.0 (sharp)       → +0 penalty
        // Ensures sharp tiles beat blurry tiles at equal LAB distance
        if (IS_18D) {
          const blurNorm = labIndex[i + 17]; // 0=blurry, 1=sharp
          if (blurNorm < 1.0) {
            dist += (1.0 - blurNorm) * 300; // max +300 for blurNorm=0
          }
        }
        if (heap.length < (TOP_K)) {
          heap.push({ tileId: id, labDist: dist, mosaicScore });
          if (heap.length === TOP_K) {
            // Find initial worst
            worstIdx = 0;
            maxDist = heap[0].labDist;
            for (let j = 1; j < (TOP_K); j++) {
              if (heap[j].labDist > maxDist) { maxDist = heap[j].labDist; worstIdx = j; }
            }
          }
        } else if (dist < maxDist) {
          heap[worstIdx] = { tileId: id, labDist: dist, mosaicScore };
          // Update worst
          worstIdx = 0;
          maxDist = heap[0].labDist;
          for (let j = 1; j < (TOP_K); j++) {
            if (heap[j].labDist > maxDist) { maxDist = heap[j].labDist; worstIdx = j; }
          }
        }
      }
      // Sort by combined score (labDist already includes mosaicScore penalty)
      return heap.sort((a, b) => a.labDist - b.labDist);
    };

    // -- Stage B: Pre-compute per-cell Top-K candidates -----------------------
    // For each cell, find the Top-K tile IDs by LAB distance
    // Then deduplicate: collect the UNIQUE tile IDs needed across all cells
    setProgressMsg(`Suche beste Kacheln in ${TOTAL_DB_TILES.toLocaleString()} Bildern...`);
    setProgress(15);

    // Map: tileId -> candidate index (for SSD lookup after loading)
    const cellCandidates: Array<Array<{tileId: number; labDist: number}>> = [];
    const neededTileIds = new Set<number>();

    if (USE_2STAGE) {
      // 2-pass: first collect all candidates (with 14D features), then load images
      // EDGE-AWARE QUADRANT MATCHING:
      // For edge cells (contours), compute quadrant target colors from neighboring cells
      // using the Sobel gradient direction. This lets the kNN find two-tone/gradient tiles
      // that match the actual color transition (e.g., skin→background at chin line).
      const EDGE_QUAD_THRESHOLD = 0.15; // lowered from 0.25: more cells get edge-aware treatment
      for (let ci = 0; ci < (TOTAL_TILES); ci++) {
        const [tL, tA, tB] = cellLab[ci];
        // FIX: targetEdge/targetBright/targetSat must be active for ALL index types (7D, 14D, 15D)!
        const targetEdge = edgeMap[ci]; // always active
        const targetBright = tL / 100;  // always active
        const targetSat = Math.min(1, Math.sqrt(tA*tA + tB*tB) / 60); // always active

        let tQuadA: [number,number,number,number];
        let tQuadB: [number,number,number,number];

        if (IS_14D && targetEdge > EDGE_QUAD_THRESHOLD) {
          // EDGE CELL: Compute directional quadrant targets from neighbors
          // Sobel gx>0 = brighter to the right, gy>0 = brighter below
          // Sample 2 neighbors in each direction for more reliable color estimates
          const col = ci % COLS, row = Math.floor(ci / COLS);
          const gx = sobelGx[ci], gy = sobelGy[ci];
          const mag = Math.sqrt(gx * gx + gy * gy);

          if (mag > 0) {
            const nx = gx / mag, ny = gy / mag;
            // Sample 2 neighbors in gradient direction for more stable color estimate
            const sampleLab = (dirX: number, dirY: number): [number, number, number] => {
              let sL = 0, sA = 0, sB = 0, sN = 0;
              for (let step = 1; step <= 2; step++) {
                const sc = Math.min(COLS - 1, Math.max(0, Math.round(col + dirX * step)));
                const sr = Math.min(ROWS - 1, Math.max(0, Math.round(row + dirY * step)));
                const lab = cellLab[sr * COLS + sc];
                sL += lab[0]; sA += lab[1]; sB += lab[2]; sN++;
              }
              return [sL / sN, sA / sN, sB / sN];
            };
            const plusLab = sampleLab(nx, ny);   // brighter side
            const minusLab = sampleLab(-nx, -ny); // darker side

            // Assign quadrants: dot product with gradient direction determines
            // which side of the edge each quadrant faces
            const quadDirs: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
            tQuadA = [0, 0, 0, 0];
            tQuadB = [0, 0, 0, 0];
            for (let q = 0; q < 4; q++) {
              const dot = quadDirs[q][0] * nx + quadDirs[q][1] * ny;
              // Stronger blending (×3) for more pronounced color separation at edges
              const blend = Math.max(-1, Math.min(1, dot * 3));
              const t = (blend + 1) / 2; // 0=minus, 0.5=center, 1=plus
              tQuadA[q] = minusLab[1] * (1 - t) + plusLab[1] * t;
              tQuadB[q] = minusLab[2] * (1 - t) + plusLab[2] * t;
            }
          } else {
            tQuadA = [tA, tA, tA, tA];
            tQuadB = [tB, tB, tB, tB];
          }
        } else {
          // Non-edge cell: all quadrants same as cell center (original behavior)
          tQuadA = [tA, tA, tA, tA];
          tQuadB = [tB, tB, tB, tB];
        }

        // Edge cells: boost W_QUAD 12× so gradient tiles rank much higher in candidates
        // Scaled by edge strength: stronger edges get more boost
        const edgeStrength = targetEdge;
        const eqBoost = (IS_14D && targetEdge > EDGE_QUAD_THRESHOLD)
          ? 4.0 + edgeStrength * 16.0  // 4-20× boost, proportional to edge strength
          : 1.0;
        const candidates = knnLAB(tL, tA, tB, targetEdge, targetBright, targetSat, tQuadA, tQuadB, eqBoost);
        cellCandidates.push(candidates);
        candidates.forEach(c => neededTileIds.add(c.tileId));
        if (ci % 500 === 0) {
          setProgress(15 + Math.round((ci / TOTAL_TILES) * 10));
          await new Promise(r => setTimeout(r, 0));
        }
      }
      console.log(`[Studio] ${IS_14D ? '14D' : IS_7D ? '7D' : '4D'} k-NN done: ${neededTileIds.size} unique tiles needed for ${TOTAL_TILES} cells`);
      // Cap unique tiles to prevent 429 rate-limit errors and OOM:
      // - Mobile: 1500 tiles (iOS Safari memory limit)
      // - Desktop: 5000 tiles (avoids Railway/Fastly 429 when loading 17k+ tiles individually)
      // Strategy: keep tiles that appear in the TOP-3 candidates for the most cells
      // This preserves quality (best matches kept) while reducing memory footprint
      const MOBILE_MAX_TILES = savedSettings.mobileMaxTiles ?? 1200;
      const DESKTOP_MAX_TILES = 5000;
      const MAX_TILES = isMobileOrSlow ? MOBILE_MAX_TILES : DESKTOP_MAX_TILES;
      if (neededTileIds.size > MAX_TILES) {
        // Score each tile: sum of (1/(rank+1)) across all cells where it appears
        // Higher score = appears as top candidate for more cells = more important to keep
        const tileScore = new Map<number, number>();
        for (const candidates of cellCandidates) {
          for (let rank = 0; rank < candidates.length; rank++) {
            const id = candidates[rank].tileId;
            tileScore.set(id, (tileScore.get(id) ?? 0) + 1 / (rank + 1));
          }
        }
        // Keep top MAX_TILES tiles by score
        const sorted = [...tileScore.entries()].sort((a, b) => b[1] - a[1]);
        const keepIds = new Set(sorted.slice(0, MAX_TILES).map(e => e[0]));
        // Rebuild neededTileIds with only the kept tiles
        for (const id of [...neededTileIds]) {
          if (!keepIds.has(id)) neededTileIds.delete(id);
        }
        // Also update cellCandidates to only reference kept tiles (for SSD stage)
        for (let ci = 0; ci < cellCandidates.length; ci++) {
          cellCandidates[ci] = cellCandidates[ci].filter(c => keepIds.has(c.tileId));
        }
        console.log(`[Studio] ${isMobileOrSlow ? 'Mobile' : 'Desktop'}: capped neededTileIds to ${neededTileIds.size}/${MAX_TILES} (score-based selection)`);
      }
    }

    // -- Stage B: Load only the needed tile images -----------------------------
    setProgressMsg(`Lade ${neededTileIds.size} Kachel-Bilder...`);
    setProgress(25);

    // tileId -> HTMLImageElement (loaded at 64px on mobile, 128px on desktop)
    const tileImgMap = new Map<number, HTMLImageElement>();
    const IMG_TIMEOUT = isMobileOrSlow ? 10000 : 15000;

    // MOBILE: CDN serves 128px tiles but we only need 64px for preview canvas.
    // 128px decoded: 128*128*4 = 64KB/tile, 800 tiles = 50MB → iOS Safari OOM crash.
    // 64px decoded:   64*64*4 = 16KB/tile, 800 tiles = 12.5MB → safe.
    // Downscale loaded images using a shared offscreen canvas.
    const MOBILE_TILE_DOWNSCALE = 64;
    const downscaleCanvas = isMobileOrSlow ? document.createElement('canvas') : null;
    if (downscaleCanvas) { downscaleCanvas.width = MOBILE_TILE_DOWNSCALE; downscaleCanvas.height = MOBILE_TILE_DOWNSCALE; }
    const downscaleCtx = downscaleCanvas?.getContext('2d') ?? null;
    function downscaleTile(img: HTMLImageElement): HTMLImageElement {
      if (!downscaleCtx || !downscaleCanvas) return img;
      if (img.naturalWidth <= MOBILE_TILE_DOWNSCALE) return img; // already small
      downscaleCtx.clearRect(0, 0, MOBILE_TILE_DOWNSCALE, MOBILE_TILE_DOWNSCALE);
      downscaleCtx.drawImage(img, 0, 0, MOBILE_TILE_DOWNSCALE, MOBILE_TILE_DOWNSCALE);
      const smallImg = new Image();
      smallImg.src = downscaleCanvas.toDataURL('image/jpeg', 0.8);
      smallImg.dataset.originalSrc = (img.dataset && img.dataset.originalSrc) ? img.dataset.originalSrc : '';
      return smallImg;
    }

    console.log(`[Studio] Pre-load: USE_2STAGE=${USE_2STAGE}, neededTileIds.size=${neededTileIds.size}, urlIndex=${tileUrlIndexRef.current ? Object.keys(tileUrlIndexRef.current).length : 'null'}`);
    if (USE_2STAGE && neededTileIds.size > 0) {
      try {
      // -- Strategy: Direct R2/CDN loading (preferred) or Atlas fallback --
      // If tile URL index is available (tiles.mosaicprint.ch CDN), load tiles directly
      // This bypasses Railway proxy, avoids 429 rate-limiting, and is much faster
      const urlIndex = tileUrlIndexRef.current;
      const hasDirectUrls = urlIndex !== null && Object.keys(urlIndex).length > 0;
      const neededArray = Array.from(neededTileIds);

      if (hasDirectUrls) {
        // -- Direct R2/CDN loading strategy --
        // Load tiles in parallel batches directly from tiles.mosaicprint.ch
        // CDN has no rate limits and serves from edge nodes worldwide
        const DIRECT_BATCH = isMobileOrSlow ? 10 : 100; // Small batches on mobile (memory pressure)
        const DIRECT_TIMEOUT = isMobileOrSlow ? 12000 : 15000;
        const BATCH_DELAY = isMobileOrSlow ? 300 : 50; // ms between batches (GC breathing room)
        // On mobile first load, skip IDB reads (empty cache = 800 wasted IDB transactions)
        const skipIDB = isMobileOrSlow;
        let loaded = 0;
        let r2Loaded = 0;
        let proxyFallback = 0;
        setProgressMsg(`Lade ${neededArray.length} Kacheln direkt von CDN...`);
        for (let i = 0; i < neededArray.length; i += DIRECT_BATCH) {
          const batchIds = neededArray.slice(i, i + DIRECT_BATCH);
          try {
            const batchImgs = await Promise.all(
              batchIds.map(async (id) => {
                const directUrl = urlIndex[String(id)];
                if (directUrl) {
                  try {
                    const img = await loadImageCached(directUrl, DIRECT_TIMEOUT, { skipIDB });
                    if (img) { r2Loaded++; return img; }
                  } catch { /* fall through to proxy */ }
                }
                proxyFallback++;
                return loadImageCached(`/api/tile/${id}?size=64`, DIRECT_TIMEOUT, { skipIDB });
              })
            );
            for (let j = 0; j < batchIds.length; j++) {
              if (batchImgs[j]) {
                // On mobile, downscale 128px CDN tiles to 64px to save ~75% decoded memory
                tileImgMap.set(batchIds[j], isMobileOrSlow ? downscaleTile(batchImgs[j]!) : batchImgs[j]!);
              }
            }
          } catch (batchErr) {
            console.warn(`[Studio] CDN batch ${i}-${i + DIRECT_BATCH} failed:`, batchErr);
            // Continue with next batch instead of crashing entire render
          }
          loaded += batchIds.length;
          const pct = 25 + Math.round((loaded / neededArray.length) * 17);
          setProgress(Math.min(pct, 42));
          if (i + DIRECT_BATCH < neededArray.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
        console.log(`[Studio] Direct CDN loading: ${tileImgMap.size}/${neededArray.length} tiles (${r2Loaded} R2, ${proxyFallback} proxy fallback)`);
        setProgress(42);
      } else {
      // -- Targeted Atlas strategy: build sprite-sheet only for needed tile IDs --
      // Split into chunks of max 1500 to avoid Railway timeouts and 429s
      const ATLAS_CHUNK = isMobileOrSlow ? 200 : 500; // Smaller chunks = more reliable (no IncompleteRead)
      const ATLAS_TIMEOUT = isMobileOrSlow ? 20000 : 30000; // 30s per chunk (500 tiles)

      // Helper: fetch one atlas chunk and extract tiles into tileImgMap
      const fetchAtlasChunk = async (chunkIds: number[], progressStart: number, progressEnd: number): Promise<boolean> => {
        try {
          setProgressMsg(`Lade ${chunkIds.length} Kacheln als Atlas...`);
          const atlasResp = await fetch('/api/tile-atlas-targeted', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: chunkIds, tileSize: 64 }),
            signal: AbortSignal.timeout(ATLAS_TIMEOUT),
          });
          if (!atlasResp.ok) return false;
          // Support multipart-v2 format: [4-byte LE JSON length][JSON map][JPEG bytes]
          // This avoids HTTP header size limits for large mosaics (270 KB+ map)
          const format = atlasResp.headers.get('X-Atlas-Format');
          let map: Record<number, [number, number]> = {};
          let ts = 64;
          let blob: Blob;
          if (format === 'multipart-v2') {
            const arrayBuf = await atlasResp.arrayBuffer();
            const allBytes = new Uint8Array(arrayBuf);
            // Read 4-byte LE length prefix
            const jsonLen = allBytes[0] | (allBytes[1] << 8) | (allBytes[2] << 16) | (allBytes[3] << 24);
            // Use slice() to get a proper copy (avoids TypedArray alignment issues with offset views)
            const jsonBytes = allBytes.slice(4, 4 + jsonLen);
            const meta = JSON.parse(new TextDecoder().decode(jsonBytes)) as { map: Record<number, [number, number]>; cols: number; rows: number; tileSize: number };
            map = meta.map;
            ts = meta.tileSize ?? 64;
            const jpegBytes = allBytes.slice(4 + jsonLen);
            blob = new Blob([jpegBytes], { type: 'image/jpeg' });
          } else {
            // Legacy format (fallback)
            ts = parseInt(atlasResp.headers.get('X-Atlas-TileSize') ?? '64');
            const mapJson = atlasResp.headers.get('X-Atlas-Map');
            map = mapJson ? JSON.parse(mapJson) : {};
            blob = await atlasResp.blob();
          }
          const atlasUrl = URL.createObjectURL(blob);
          // Debug: log blob size and type
          console.log(`[Studio] Atlas blob: ${blob.size} bytes, type=${blob.type}, url=${atlasUrl.slice(0,40)}`);
          const atlasImg = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              console.log(`[Studio] Atlas img loaded: ${img.naturalWidth}x${img.naturalHeight}`);
              resolve(img);
            };
            img.onerror = (e) => {
              console.error(`[Studio] Atlas img FAILED to load. Blob size=${blob.size}, type=${blob.type}`, e);
              reject(new Error(`Atlas image load failed: blob size=${blob.size}`));
            };
            img.src = atlasUrl;
          });
          const offscreen = document.createElement('canvas');
          offscreen.width = ts; offscreen.height = ts;
          const octx = offscreen.getContext('2d')!;
          const atlasEntries = Object.entries(map);
          const EXTRACT_YIELD = isMobileOrSlow ? 50 : 200;
          for (let ei = 0; ei < atlasEntries.length; ei++) {
            const [idStr, [col, row]] = atlasEntries[ei] as [string, [number, number]];
            const id = Number(idStr);
            octx.clearRect(0, 0, ts, ts);
            octx.drawImage(atlasImg, col * ts, row * ts, ts, ts, 0, 0, ts, ts);
            const tileImg = new Image();
            tileImg.src = offscreen.toDataURL('image/jpeg', 0.85);
            tileImgMap.set(id, tileImg);
            if (ei % EXTRACT_YIELD === EXTRACT_YIELD - 1) {
              const pct = progressStart + Math.round((ei / atlasEntries.length) * (progressEnd - progressStart));
              setProgress(Math.min(pct, progressEnd));
              await new Promise(r => setTimeout(r, 0));
            }
          }
          URL.revokeObjectURL(atlasUrl);
          return true;
        } catch (e) {
          console.warn('[Studio] Atlas chunk failed:', e);
          return false;
        }
      };

      // Load in chunks of ATLAS_CHUNK
      const totalChunks = Math.ceil(neededArray.length / ATLAS_CHUNK);
      for (let ci = 0; ci < totalChunks; ci++) {
        const chunkIds = neededArray.slice(ci * ATLAS_CHUNK, (ci + 1) * ATLAS_CHUNK);
        const pStart = 25 + Math.round((ci / totalChunks) * 17);
        const pEnd = 25 + Math.round(((ci + 1) / totalChunks) * 17);
        const ok = await fetchAtlasChunk(chunkIds, pStart, pEnd);
        if (!ok) {
          // Retry with half-size chunk
          const half = Math.ceil(chunkIds.length / 2);
          await fetchAtlasChunk(chunkIds.slice(0, half), pStart, Math.round((pStart + pEnd) / 2));
          await fetchAtlasChunk(chunkIds.slice(half), Math.round((pStart + pEnd) / 2), pEnd);
        }
        // Small delay between chunks (reduced for Pro plan)
        if (ci < totalChunks - 1) await new Promise(r => setTimeout(r, 50));
      }
      console.log(`[Studio] Targeted atlas: ${tileImgMap.size}/${neededTileIds.size} tiles loaded`);
      setProgress(42);

      // Load any tiles not covered by the atlas via additional atlas chunks (avoids 429)
      // Use atlas chunks instead of individual /api/tile/:id requests
      const allMissingIds = Array.from(neededTileIds).filter(id => !tileImgMap.has(id));
      const MISSING_CAP = isMobileOrSlow ? 300 : 1000; // cap fallback to avoid long waits
      const missingIds = allMissingIds.slice(0, MISSING_CAP);
      if (missingIds.length > 0) {
        setProgressMsg(`Lade ${missingIds.length} weitere Kacheln (Fallback)...`);
        console.log(`[Studio] Fallback: loading ${missingIds.length} missing tiles via atlas chunks`);
        // Use atlas chunks for fallback too (avoids individual 429 errors)
        const FALLBACK_CHUNK = isMobileOrSlow ? 100 : 300;
        const BATCH_DELAY = 200;
        let loaded = 0;
        for (let i = 0; i < missingIds.length; i += FALLBACK_CHUNK) {
          const batchIds = missingIds.slice(i, i + FALLBACK_CHUNK);
          // Try atlas first, fall back to individual requests only if atlas fails
          const atlasOk = await fetchAtlasChunk(batchIds, 42, 45);
          if (!atlasOk) {
            // Last resort: individual requests with strict throttling
            const batchImgs = await Promise.all(
              batchIds.map(id => loadImageCached(`/api/tile/${id}?size=64`, IMG_TIMEOUT))
            );
            for (let j = 0; j < batchIds.length; j++) {
              if (batchImgs[j]) tileImgMap.set(batchIds[j], isMobileOrSlow ? downscaleTile(batchImgs[j]!) : batchImgs[j]!);
            }
          }
          loaded += batchIds.length;
          const pct = 42 + Math.round((loaded / missingIds.length) * 3);
          setProgress(Math.min(pct, 45));
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
        console.log(`[Studio] +${loaded} individual tiles loaded (${allMissingIds.length - missingIds.length} skipped)`);
      }

      if (tileImgMap.size === 0) {
        // Full fallback: no atlas available, load all individually with throttling
        console.log('[Studio] Atlas unavailable, falling back to individual tile requests');
        setProgressMsg(`Lade ${neededTileIds.size} Kachel-Bilder...`);
        const tileIdArray = Array.from(neededTileIds);
        const BATCH = isMobileOrSlow ? 15 : 20; // Reduced to avoid 429 rate limits
        const DELAY = isMobileOrSlow ? 200 : 100; // ms between batches
        let loaded = 0;
        for (let i = 0; i < tileIdArray.length; i += BATCH) {
          const batchIds = tileIdArray.slice(i, i + BATCH);
          const batchImgs = await Promise.all(
            batchIds.map(id => loadImageCached(`/api/tile/${id}?size=64`, IMG_TIMEOUT))
          );
          for (let j = 0; j < batchIds.length; j++) {
            if (batchImgs[j]) tileImgMap.set(batchIds[j], isMobileOrSlow ? downscaleTile(batchImgs[j]!) : batchImgs[j]!);
          }
          loaded += batchIds.length;
          const pct = 25 + Math.round((loaded / tileIdArray.length) * 20);
          setProgress(Math.min(pct, 45));
          setCacheSize(getMemoryCacheSize());
          await new Promise(r => setTimeout(r, DELAY));
        }
        console.log(`[Studio] Loaded ${tileImgMap.size}/${neededTileIds.size} tile images`);
      }

      setProgress(45);
      } // end else (Atlas fallback)
      } catch (tileLoadErr) {
        console.error('[Studio] Tile loading phase failed:', tileLoadErr);
        // Continue with whatever tiles we managed to load
        setProgress(45);
      }
    }

    // -- Fallback: legacy pool if 2-stage not available ------------------------
    // Build validImgs/validTileIds arrays for the rest of the pipeline
    let validImgs: HTMLImageElement[];
    let validTileIds: number[];
    let dbTilePool: Array<{id: number; l: number; a: number; b: number}> = [];

    if (!USE_2STAGE || tileImgMap.size === 0) {
      // Legacy: load a fixed pool of images
      console.warn(`[Studio] Fallback triggered: USE_2STAGE=${USE_2STAGE}, tileImgMap.size=${tileImgMap.size}, labIndex=${labIndex ? labIndex.length : 'null'}, FPT=${FPT}`);
      setProgressMsg("Lade Kachel-Pool (Fallback)...");
      const isPortrait = savedSettings.portraitMode === true;
      const TARGET_POOL = isMobileOrSlow ? 600 : (isPortrait ? 2500 : 1500);
      let allUrls: string[] = [];
      let dbTileIds: number[] = [];
      try {
        const poolRes = await fetch(`/api/trpc/getTilePool?limit=${TARGET_POOL}&labOnly=true`);
        if (poolRes.ok) {
          dbTilePool = await poolRes.json();
          allUrls = dbTilePool.map(t => `/api/tile/${t.id}?size=64`);
          dbTileIds = dbTilePool.map(t => t.id);
        }
      } catch { /* ignore */ }
      if (allUrls.length === 0) {
        allUrls = getPhotoUrls(TARGET_POOL, 64);
        dbTileIds = [];
      }
      const loadedImgs: (HTMLImageElement | null)[] = [];
      const BATCH = isMobileOrSlow ? 30 : 80;
      for (let i = 0; i < allUrls.length; i += (BATCH)) {
        const batch = await Promise.all(allUrls.slice(i, i + BATCH).map(u => loadImageCached(u, IMG_TIMEOUT)));
        loadedImgs.push(...batch);
        setProgress(25 + Math.round(((i + BATCH) / allUrls.length) * 20));
        await new Promise(r => setTimeout(r, 0));
      }
      validImgs = loadedImgs.filter(Boolean) as HTMLImageElement[];
      validTileIds = validImgs.map((_, i) => dbTileIds[i] ?? 0);
    } else {
      // 2-stage: build flat arrays from tileImgMap (for feature extraction + rendering)
      validImgs = Array.from(tileImgMap.values());
      validTileIds = Array.from(tileImgMap.keys());
    }

    // -- Tile Source Mode: merge user-uploaded tiles into the pool ----------------
    const currentTileMode = tileSourceModeRef.current;
    const currentUserTiles = userTileImagesRef.current;
    const currentUserHiRes = userTileHiResRef.current;
    // PRINT QUALITY: use original full-resolution images (2048px mobile / 2048px desktop)
    // instead of 512px hi-res copies. Falls back to hi-res if original not available.
    const currentUserOriginals = userTileOriginalRef.current;
    const getHiResForIdx = (i: number): HTMLImageElement | null =>
      currentUserOriginals[i] || currentUserHiRes[i] || null;
    let validImgsHiRes: (HTMLImageElement | null)[] = new Array(validImgs.length).fill(null);

    if (currentTileMode === 'own' && currentUserTiles.length > 0) {
      // Only user tiles – replace entire pool
      validImgs = [...currentUserTiles];
      validTileIds = currentUserTiles.map((_, i) => -(i + 1)); // negative IDs for user tiles
      validImgsHiRes = currentUserTiles.map((_, i) => getHiResForIdx(i));
      // Duplicate tiles to fill pool if too few (repeat to reach ~200 minimum for variety)
      while (validImgs.length < 200 && currentUserTiles.length > 0) {
        validImgs.push(...currentUserTiles);
        validTileIds.push(...currentUserTiles.map((_, i) => -(i + 1)));
        validImgsHiRes.push(...currentUserTiles.map((_, i) => getHiResForIdx(i)));
      }
      console.log(`[Studio] Tile source: OWN ONLY – ${currentUserTiles.length} user tiles (expanded to ${validImgs.length}), originals: ${currentUserOriginals.length}`);
    } else if (currentTileMode === 'mix' && currentUserTiles.length > 0) {
      // Mix: user tiles + DB pool – expand user tiles to ~30% of pool for strong presence
      const dbPoolSize = validImgs.length;
      // Target: user tiles should be ~30% of total pool (but at least 5x multiplied)
      const targetUserCount = Math.max(currentUserTiles.length * 5, Math.ceil(dbPoolSize * 0.43)); // 0.43 of DB → ~30% of total
      const reps = Math.max(1, Math.ceil(targetUserCount / currentUserTiles.length));
      const userExpanded: HTMLImageElement[] = [];
      const userHiResExpanded: (HTMLImageElement | null)[] = [];
      for (let rep = 0; rep < reps; rep++) {
        userExpanded.push(...currentUserTiles);
        // Use original full-resolution for print quality (falls back to hi-res if not available)
        userHiResExpanded.push(...currentUserTiles.map((_, i) => getHiResForIdx(i)));
      }
      const userIds = userExpanded.map((_, i) => -(i + 1));
      validImgs = [...userExpanded, ...validImgs];
      validTileIds = [...userIds, ...validTileIds];
      validImgsHiRes = [...userHiResExpanded, ...validImgsHiRes];
      console.log(`[Studio] Tile source: MIX – ${currentUserTiles.length} user tiles (${reps}x = ${userExpanded.length}) + ${dbPoolSize} DB tiles (user share: ${Math.round(userExpanded.length / validImgs.length * 100)}%)`);
    } else {
      console.log(`[Studio] Tile source: POOL ONLY – ${validImgs.length} DB tiles`);
    }

    // Step 3: Extract features
    // Feature vector per tile: [globalLAB(3), quadrant TL(3), TR(3), BL(3), BR(3), brightness(1), textureVariance(1), saturation(1)]
    // Total: 17 values per tile
    setProgressMsg("Extrahiere Features...");
    setProgress(47);

    // Extended feature: LAB quadrants + brightness + texture variance + saturation + edgeEnergy
    type ImgFeature = {
      lab: [number,number,number];       // global LAB average
      quads: [[number,number,number],[number,number,number],[number,number,number],[number,number,number]]; // TL,TR,BL,BR
      brightness: number;                // 0-100
      texture: number;                   // luminance variance (0-1000)
      saturation: number;                // chroma = sqrt(a^2+b^2), 0-100
      edgeEnergy: number;                // normalized Sobel energy 0-1 (frequency-aware)
      ssdPixels: Uint8Array;             // 8x8 RGB pixel data for pixel-accurate SSD matching
    };

    const extractFeature = (d: Uint8ClampedArray, SZ: number): ImgFeature => {
      const half = SZ / 2;
      let sL=0, sA=0, sB=0, n=0;
      let lumVarSum=0;
      // Cache all LAB values to avoid recomputing them in avgLab (was: 1 pass + 4 quadrant passes = 5× calls)
      const labCache = new Float32Array(SZ * SZ * 3);
      // Pre-compute luminance array for Sobel (avoids 8 redundant lookups per interior pixel)
      const lumArr = new Float32Array(SZ * SZ);
      for (let y=0; y<SZ; y++) for (let x=0; x<SZ; x++) {
        const i = (y*SZ+x)*4;
        const [L,a,b] = rgbToLab(d[i], d[i+1], d[i+2]);
        const ci3 = (y*SZ+x)*3;
        labCache[ci3]=L; labCache[ci3+1]=a; labCache[ci3+2]=b;
        lumArr[y*SZ+x] = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        sL+=L; sA+=a; sB+=b; n++;
      }
      const gL=sL/n, gA=sA/n, gB=sB/n;
      const meanL = gL;
      for (let k=0; k<n; k++) lumVarSum += (labCache[k*3] - meanL) * (labCache[k*3] - meanL);
      const texture = Math.sqrt(lumVarSum / n); // std-dev of luminance
      const saturation = Math.sqrt(gA*gA + gB*gB);

      // Sobel edge energy for frequency-aware matching (uses pre-computed lumArr, no per-pixel recomputation)
      let edgeSum = 0;
      for (let ey=1; ey<SZ-1; ey++) for (let ex=1; ex<SZ-1; ex++) {
        const tl=lumArr[(ey-1)*SZ+(ex-1)], tc=lumArr[(ey-1)*SZ+ex], tr=lumArr[(ey-1)*SZ+(ex+1)];
        const ml=lumArr[ey*SZ+(ex-1)],                               mr=lumArr[ey*SZ+(ex+1)];
        const bl=lumArr[(ey+1)*SZ+(ex-1)], bc=lumArr[(ey+1)*SZ+ex], br=lumArr[(ey+1)*SZ+(ex+1)];
        const gx = -tl+tr - 2*ml+2*mr - bl+br;
        const gy = -tl-2*tc-tr + bl+2*bc+br;
        edgeSum += Math.sqrt(gx*gx+gy*gy);
      }
      const edgeEnergy = Math.min(1, edgeSum / ((SZ-2)*(SZ-2) * 255));

      // avgLab reads from labCache instead of calling rgbToLab again
      const avgLab = (x0: number, y0: number, x1: number, y1: number): [number,number,number] => {
        let qL=0, qA=0, qB=0, qn=0;
        for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) {
          const ci3 = (y*SZ+x)*3;
          qL+=labCache[ci3]; qA+=labCache[ci3+1]; qB+=labCache[ci3+2]; qn++;
        }
        return qn>0 ? [qL/qn, qA/qn, qB/qn] : [50,0,0];
      };
      // Extract 8x8 RGB pixel data for SSD matching (downscale from SZ to 8)
      const SSD_SZ = 8;
      const ssdPixels = new Uint8Array(SSD_SZ * SSD_SZ * 3);
      const scaleX = SZ / SSD_SZ, scaleY = SZ / SSD_SZ;
      let si2 = 0;
      for (let sy = 0; sy < (SSD_SZ); sy++) {
        for (let sx = 0; sx < (SSD_SZ); sx++) {
          const srcX = Math.floor(sx * scaleX), srcY = Math.floor(sy * scaleY);
          const idx = (srcY * SZ + srcX) * 4;
          ssdPixels[si2++] = d[idx];
          ssdPixels[si2++] = d[idx + 1];
          ssdPixels[si2++] = d[idx + 2];
        }
      }
      return {
        lab: [gL, gA, gB],
        quads: [avgLab(0,0,half,half), avgLab(half,0,SZ,half), avgLab(0,half,half,SZ), avgLab(half,half,SZ,SZ)],
        brightness: gL,
        texture,
        saturation,
        edgeEnergy,
        ssdPixels,
      };
    };

    const imgFeatures: ImgFeature[] = validImgs.map(img => {
      try {
        if (!img || !img.complete || img.naturalWidth === 0) {
          return { lab:[50,0,0], quads:[[50,0,0],[50,0,0],[50,0,0],[50,0,0]], brightness:50, texture:0, saturation:0, edgeEnergy:0, ssdPixels: new Uint8Array(8*8*3) } as ImgFeature;
        }
        const SZ = 16;
        const c = document.createElement("canvas"); c.width = SZ; c.height = SZ;
        const cx = c.getContext("2d")!; cx.drawImage(img, 0, 0, SZ, SZ);
        const d = cx.getImageData(0, 0, SZ, SZ).data;
        return extractFeature(d, SZ);
      } catch { 
        return { lab:[50,0,0], quads:[[50,0,0],[50,0,0],[50,0,0],[50,0,0]], brightness:50, texture:0, saturation:0, edgeEnergy:0, ssdPixels: new Uint8Array(8*8*3) } as ImgFeature;
      }
    });

    // -- Filter out clipart-like tiles (white/flat backgrounds) --------------
    // Tiles with very high L (>92) AND very low texture (<3) are almost certainly
    // white-background clipart images that ruin the mosaic.
    // Also filter tiles with very low saturation AND high L (washed out).
    const goodTileIndices: number[] = [];
    const goodImgFeatures: ImgFeature[] = [];
    const goodValidImgs: HTMLImageElement[] = [];
    const goodTileIds: number[] = [];
    const goodHiRes: (HTMLImageElement | null)[] = [];
    // Compute target image average brightness to calibrate dark-tile filter
    let targetAvgL = 0;
    for (let ci2 = 0; ci2 < (TOTAL_TILES); ci2++) { targetAvgL += cellLab[ci2][0]; }
    targetAvgL /= TOTAL_TILES;
    // For bright target images (avg L > 65), filter out extremely dark tiles (L < 8 = nearly pure black)
    // Threshold raised from 50->65 and 12->8 to avoid over-filtering (was causing white patches)
    const filterDarkTiles = targetAvgL > 65;
    for (let i = 0; i < imgFeatures.length; i++) {
      const f = imgFeatures[i];
      const isWhiteClipart = f.brightness > 92 && f.texture < 3;
      const isWashedOut = f.brightness > 88 && f.saturation < 5 && f.texture < 5;
      // Only filter near-pure-black tiles (L < 8) to avoid over-filtering
      const isTooDark = filterDarkTiles && f.brightness < 8; // L < 8 = nearly pure black only
      if (!isWhiteClipart && !isWashedOut && !isTooDark) {
        goodTileIndices.push(i);
        goodImgFeatures.push(f);
        goodValidImgs.push(validImgs[i]);
        goodTileIds.push(validTileIds[i]);
        goodHiRes.push(validImgsHiRes[i] || null);
      }
    }
    console.log(`[Mosaic] Filtered ${imgFeatures.length - goodImgFeatures.length} clipart tiles, ${goodImgFeatures.length} remaining`);
    // -- Tile-Pool Diversification: remove extremely yellow tiles that cause yellow flecks --------
    // Problem: Sunset/warm photo pools have very yellow tiles (LAB b > 28) that cause yellow flecks
    // in bright neutral areas (white backgrounds, beige clothing) even with penalties.
    // Solution 1: Remove tiles with b > 28 AND high saturation (these are pure yellow/orange tiles)
    // Solution 2: Cap moderately yellow tiles (b 20-28) at max 12% of pool
    const EXTREME_YELLOW_THRESHOLD = 28; // b > 28 with high sat = pure yellow tile, always remove
    const MODERATE_YELLOW_THRESHOLD = 20; // b 20-28 = moderately yellow, cap at 12%
    const MAX_MODERATE_YELLOW_FRACTION = 0.12;
    const extremeYellowIndices: number[] = [];
    const moderateYellowIndices: number[] = [];
    const nonYellowTileIndices: number[] = [];
    for (let i = 0; i < goodImgFeatures.length; i++) {
      const b = goodImgFeatures[i].lab[2];
      const sat = goodImgFeatures[i].saturation;
      if (b > EXTREME_YELLOW_THRESHOLD && sat > 20) {
        extremeYellowIndices.push(i); // These will be removed entirely
      } else if (b > MODERATE_YELLOW_THRESHOLD && sat > 15) {
        moderateYellowIndices.push(i); // These will be capped
      } else {
        nonYellowTileIndices.push(i);
      }
    }
    const maxModerateCount = Math.round(goodImgFeatures.length * MAX_MODERATE_YELLOW_FRACTION);
    const keptModerateIndices = moderateYellowIndices.length > maxModerateCount
      ? moderateYellowIndices.slice(0, maxModerateCount)
      : moderateYellowIndices;
    const diversifiedIndices = [...nonYellowTileIndices, ...keptModerateIndices];
    // Note: extremeYellowIndices are intentionally excluded
    const filteredImgFeatures = diversifiedIndices.map(i => goodImgFeatures[i]);
    const filteredValidImgs = diversifiedIndices.map(i => goodValidImgs[i]);
    const filteredTileIds = diversifiedIndices.map(i => goodTileIds[i]);
    const filteredHiRes = diversifiedIndices.map(i => goodHiRes[i] || null);
    console.log(`[Mosaic] Pool diversification: removed ${extremeYellowIndices.length} extreme yellow tiles (b>${EXTREME_YELLOW_THRESHOLD}), capped ${moderateYellowIndices.length}->${keptModerateIndices.length} moderate yellow tiles, total: ${filteredImgFeatures.length}`);

    // Cell features from target image
    const cellFeatures: ImgFeature[] = [];
    for (let ci = 0; ci < (TOTAL_TILES); ci++) {
      const col = ci % COLS, row = Math.floor(ci / COLS);
      const [gL,gA,gB] = cellLab[ci];
      const sat = Math.sqrt(gA*gA + gB*gB);
      // For target cells, quads all equal global (we only have 1px per cell in offscreen)
      cellFeatures.push({
        lab: [gL, gA, gB],
        quads: [[gL,gA,gB],[gL,gA,gB],[gL,gA,gB],[gL,gA,gB]],
        brightness: gL,
        texture: saliency[ci] * 50, // use saliency as proxy for target texture
        saturation: sat,
        edgeEnergy: edgeMap[ci], // use Sobel edge strength as target edge energy
        ssdPixels: new Uint8Array(8*8*3), // not used for cell features (targetRegions used instead)
      });
      // -- Step 3b: Face Detection (MediaPipe FaceLandmarker) --------------------------
    }
    // Creates a subRegionMask with per-cell face subregion labels:
    // 'cheek' (face region) | null
    // Canvas-based skin-tone detection (no external dependencies)
    setProgressMsg("Gesichtserkennung...");
    setProgress(48);
    const faceMask: boolean[] = new Array(TOTAL_TILES).fill(false);
    const subRegionMask: FaceSubRegion[] = new Array(TOTAL_TILES).fill(null);
    let _debugFacesDetected = 0;
    try {
      const faceRegions = detectFaceRegionsCanvas(targetImg);
      _debugFacesDetected = faceRegions.length;
      console.log(`[FaceDetect] Detected ${faceRegions.length} skin region(s) via Canvas heuristic`);
      for (const region of faceRegions) {
        // Expand region slightly for better coverage
        const expand = 0.02;
        const c0 = Math.max(0, Math.floor((region.x - expand) * COLS));
        const c1 = Math.min(COLS - 1, Math.ceil((region.x + region.w + expand) * COLS));
        const r0 = Math.max(0, Math.floor((region.y - expand) * ROWS));
        const r1 = Math.min(ROWS - 1, Math.ceil((region.y + region.h + expand) * ROWS));
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const ci = r * COLS + c;
            faceMask[ci] = true;
            subRegionMask[ci] = 'cheek'; // treat all face regions as cheek for matching
          }
        }
      }
      const faceCount = faceMask.filter(Boolean).length;
      console.log(`[FaceDetect] Marked ${faceCount} cells as face regions`);
    } catch (e) { console.warn('[FaceDetect] Failed:', e); /* continue without */ }

    // -- Soft-Border Zone: 2-tile transition band around face mask ----------------
    // Cells in this zone get blended scoring (face+background) for smooth roundings
    // This prevents the hard rectangular edge that makes head/chin/cheek look blocky
    const SOFT_BORDER_RADIUS = 2; // tiles of transition zone
    const softBorderMask: number[] = new Array(TOTAL_TILES).fill(0); // 0=none, 1=outer, 2=inner
    for (let ci = 0; ci < TOTAL_TILES; ci++) {
      if (faceMask[ci]) continue; // already a face cell
      const col = ci % COLS, row = Math.floor(ci / COLS);
      let minDist = Infinity;
      for (let dr = -SOFT_BORDER_RADIUS; dr <= SOFT_BORDER_RADIUS; dr++) {
        for (let dc = -SOFT_BORDER_RADIUS; dc <= SOFT_BORDER_RADIUS; dc++) {
          const nr = row + dr, nc = col + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
            const ni = nr * COLS + nc;
            if (faceMask[ni]) {
              const d = Math.sqrt(dr*dr + dc*dc);
              if (d < minDist) minDist = d;
            }
          }
        }
      }
      if (minDist <= 1.5) softBorderMask[ci] = 2; // inner border: 70% face scoring
      else if (minDist <= SOFT_BORDER_RADIUS) softBorderMask[ci] = 1; // outer border: 35% face scoring
    }

    // -- Progressive Rendering: Pass 1 (LAB-color preview) ---------------------
    // Before running the expensive SSD matching loop, draw a fast LAB-color preview:
    // each cell gets the average color of its best k-NN candidate (from Stage A).
    // This gives the user immediate visual feedback while the full SSD pass runs.
    setRenderPass(1);
    setProgressMsg("Vorschau (Pass 1)...");
    setProgress(49);
    if (USE_2STAGE) {
      for (let ci = 0; ci < (TOTAL_TILES); ci++) {
        const col = ci % COLS, row = Math.floor(ci / COLS);
        const x = col * TILE_PX, y = row * TILE_PX;
        // Use the best k-NN candidate's LAB color as a solid fill
        const best = cellCandidates[ci]?.[0];
        if (best) {
          // Look up loaded image for this candidate
          const img = tileImgMap.get(best.tileId);
          if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, x, y, TILE_PX, TILE_PX);
          } else {
            // Fallback: fill with target cell color
            const [tL, tA, tB] = cellLab[ci];
            const [fr, fg, fb] = labToRgb(tL, tA, tB);
            ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
            ctx.fillRect(x, y, TILE_PX, TILE_PX);
          }
        } else {
          const [tL, tA, tB] = cellLab[ci];
          const [fr, fg, fb] = labToRgb(tL, tA, tB);
          ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
          ctx.fillRect(x, y, TILE_PX, TILE_PX);
        }
      }
      await new Promise(r => setTimeout(r, 0)); // flush to screen
    }

    // Step 4: Match tiles
    // 2-STAGE MATCHING:
    //   Stage A (done above): k-NN over ALL DB tiles in LAB space -> cellCandidates[ci]
    //   Stage B (here): For each cell, get the pre-computed Top-K candidates,
    //                   look up their loaded images, run SSD + full scoring, pick best
    //
    // For legacy fallback (no LAB index): use filteredImgFeatures as before
    setRenderPass(2);
    setProgressMsg("Matche Fotos (Pass 2)...");
    setProgress(50);

    // Build a tileId -> index map for the loaded images (for 2-stage lookup)
    const tileIdToIdx = new Map<number, number>();
    for (let i = 0; i < filteredTileIds.length; i++) {
      tileIdToIdx.set(filteredTileIds[i], i);
    }
    // Pre-collect user tile indices (negative IDs) for mix mode injection
    const userTileFilteredIndices: number[] = [];
    const userTileFilteredSet = new Set<number>(); // fast lookup for scoring bonus
    if (currentTileSourceMode === 'mix') {
      for (const [tid, idx] of tileIdToIdx) {
        if (tid < 0) {
          userTileFilteredIndices.push(idx);
          userTileFilteredSet.add(idx);
        }
      }
    }

    const useCount = new Array(filteredValidImgs.length).fill(0);
    // DYNAMIC MAX_REUSE: Analyse Pool-Diversität pro Helligkeitsbereich
    // Ziel: In Bereichen mit wenig passenden Tiles (z.B. sehr hell) höheres MAX_REUSE erlauben
    const poolSize = filteredValidImgs.length;
    // Globales MAX_REUSE (Basis)
    const MAX_REUSE_GLOBAL = poolSize >= (TOTAL_TILES) * 3
      ? 3  : poolSize >= (TOTAL_TILES) * 1.5
        ? 5  : Math.max(8, Math.ceil((TOTAL_TILES * 2.5) / Math.max(1, poolSize)));
    // Pool-Diversität: Zähle Tiles pro Helligkeitsbereich
    const poolBuckets = { vd: 0, dk: 0, md: 0, br: 0, vb: 0 };
    for (const mf of filteredImgFeatures) {
      const L = mf.lab[0];
      if (L < 20) poolBuckets.vd++;
      else if (L < 40) poolBuckets.dk++;
      else if (L < 65) poolBuckets.md++;
      else if (L < 82) poolBuckets.br++;
      else poolBuckets.vb++;
    }
    const cellBuckets = { vd: 0, dk: 0, md: 0, br: 0, vb: 0 };
    for (let ci = 0; ci < TOTAL_TILES; ci++) {
      const L = cellLab[ci][0];
      if (L < 20) cellBuckets.vd++;
      else if (L < 40) cellBuckets.dk++;
      else if (L < 65) cellBuckets.md++;
      else if (L < 82) cellBuckets.br++;
      else cellBuckets.vb++;
    }
    const calcMR = (p: number, c: number): number => {
      if (c === 0) return MAX_REUSE_GLOBAL;
      const r = p / c;
      return r >= 3.0 ? 3 : r >= 1.5 ? 5 : r >= 0.8 ? 8 : r >= 0.4 ? 12 : 20;
    };
    const MR_BUCKET = {
      vd: calcMR(poolBuckets.vd, cellBuckets.vd),
      dk: calcMR(poolBuckets.dk, cellBuckets.dk),
      md: calcMR(poolBuckets.md, cellBuckets.md),
      br: calcMR(poolBuckets.br, cellBuckets.br),
      vb: calcMR(poolBuckets.vb, cellBuckets.vb),
    };
    console.log('[Mosaic] Pool buckets:', poolBuckets, '| Cell buckets:', cellBuckets, '| MAX_REUSE by bucket:', MR_BUCKET);
    const getMaxReuseForCell = (cellL: number): number => {
      if (cellL < 20) return MR_BUCKET.vd;
      if (cellL < 40) return MR_BUCKET.dk;
      if (cellL < 65) return MR_BUCKET.md;
      if (cellL < 82) return MR_BUCKET.br;
      return MR_BUCKET.vb;
    };
    const MAX_REUSE = MAX_REUSE_GLOBAL; // globaler Fallback
    const assignment: number[] = new Array(TOTAL_TILES).fill(-1);
    // Also store best rotation per tile (0=0deg, 1=90deg, 2=180deg, 3=270deg)
    const assignmentRotation: number[] = new Array(TOTAL_TILES).fill(0);
    // Repetition Lock: radius 4, penalty 160 (portrait-optimized per feedback)
    // For small pools (own photos), reduce penalties to allow better color matching
    const isSmallPool = poolSize < 500;
    const NEIGHBOR_RADIUS = savedSettings.neighborRadius ?? 4;
    const NEIGHBOR_PENALTY = savedSettings.neighborPenalty ?? (isSmallPool ? 60 : 160);
    const ENABLE_ROTATION = savedSettings.enableRotation ?? true; // Tile rotation for better matching

    // Pre-compute rotated features for all tiles (0deg, 90deg, 180deg, 270deg)
    // For rotation: 90deg swaps quadrants: TL->TR->BR->BL->TL
    // quads order: [TL, TR, BL, BR]
    const rotateQuads = (quads: [[number,number,number],[number,number,number],[number,number,number],[number,number,number]], rot: number): [[number,number,number],[number,number,number],[number,number,number],[number,number,number]] => {
      if (rot === 0) return quads;
      if (rot === 1) return [quads[2], quads[0], quads[3], quads[1]]; // 90deg: BL->TL, TL->TR, BR->BL, TR->BR
      if (rot === 2) return [quads[3], quads[2], quads[1], quads[0]]; // 180deg
      return [quads[1], quads[3], quads[0], quads[2]]; // 270deg
    };

    const tileOrder = Array.from({ length: TOTAL_TILES }, (_, i) => i)
      .sort((a, b) => saliency[b] - saliency[a]);

    // Legacy: Pre-sort imgFeatures by LAB for fast candidate pre-filtering
    const sortedByL = Array.from({ length: filteredValidImgs.length }, (_, i) => i)
      .sort((a, b) => filteredImgFeatures[a].lab[0] - filteredImgFeatures[b].lab[0]);

    for (let ti = 0; ti < (TOTAL_TILES); ti++) {
      const ci = tileOrder[ti];
      const tf = cellFeatures[ci];
      const col = ci % COLS, row = Math.floor(ci / COLS);
      const inFace = faceMask[ci];
      const subRegion = subRegionMask[ci]; // 'eye' | 'mouth' | 'nose' | 'cheek' | 'forehead' | null
      const softBorder = softBorderMask[ci]; // 0=none, 1=outer(35%), 2=inner(70%)

      // Collect neighbor tile IDs for anti-repetition
      const neighborIds = new Set<number>();
      for (let dr = -NEIGHBOR_RADIUS; dr <= (NEIGHBOR_RADIUS); dr++) {
        for (let dc = -NEIGHBOR_RADIUS; dc <= (NEIGHBOR_RADIUS); dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr, nc = col + dc;
          if (nr >= 0 && nr < (ROWS) && nc >= 0 && nc < (COLS)) {
            const ni = nr * COLS + nc;
            if (assignment[ni] >= 0) neighborIds.add(assignment[ni]);
          }
        }
      }

      // 2-STAGE: Use pre-computed k-NN candidates from LAB index
      // Map candidate tileIds to their indices in filteredImgFeatures
      let candidateIndices: number[];
      if (USE_2STAGE && cellCandidates[ci]?.length > 0) {
        // Map tileIds to feature indices, skip tiles not loaded (filtered out)
        candidateIndices = cellCandidates[ci]
          .map(c => tileIdToIdx.get(c.tileId) ?? -1)
          .filter(idx => idx >= 0);
        // MIX mode: inject user tile indices into every candidate set
        // User tiles have negative tileIds and are not in the server LAB index,
        // so they must be added here to compete in Stage B (SSD matching)
        if (userTileFilteredIndices.length > 0) {
          for (const idx of userTileFilteredIndices) {
            candidateIndices.push(idx);
          }
        }
        // If too few candidates loaded (e.g., all filtered), fall back to legacy
        if (candidateIndices.length < 5) {
          candidateIndices = Array.from({ length: Math.min(30, filteredValidImgs.length) }, (_, i) => i);
        }
      } else {
        // Legacy fallback: binary search in sortedByL
        // For small pools (<500 tiles), use ALL tiles as candidates - no pre-filtering needed
        // This ensures every cell considers every tile, giving the best possible color match
        const PRE_FILTER_COUNT = Math.min(isSmallPool ? filteredValidImgs.length : 80, filteredValidImgs.length);
        if (!isSmallPool && filteredValidImgs.length > (PRE_FILTER_COUNT) * 2) {
          const targetL = tf.lab[0];
          let lo = 0, hi = sortedByL.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (filteredImgFeatures[sortedByL[mid]].lab[0] < targetL) lo = mid + 1; else hi = mid;
          }
          const windowStart = Math.max(0, lo - PRE_FILTER_COUNT / 2);
          const windowEnd = Math.min(sortedByL.length, windowStart + PRE_FILTER_COUNT * 2);
          candidateIndices = sortedByL.slice(windowStart, windowEnd)
            .map(j => {
              const [dL,dA,dB] = [tf.lab[0]-filteredImgFeatures[j].lab[0], tf.lab[1]-filteredImgFeatures[j].lab[1], tf.lab[2]-filteredImgFeatures[j].lab[2]];
              return { j, dist: dL*dL + dA*dA + dB*dB };
            })
            .sort((a, b) => a.dist - b.dist)
            .slice(0, PRE_FILTER_COUNT)
            .map(x => x.j);
        } else {
          candidateIndices = Array.from({ length: filteredValidImgs.length }, (_, i) => i);
        }
      }

      let bestIdx = 0, bestDist = Infinity, bestRot = 0;
      const rotations = ENABLE_ROTATION ? [0, 1, 2, 3] : [0];
      // Hoist cell-level constants outside candidate + rotation loops (settings don't change per render)
      const noOverlay = (savedSettings.baseOverlay ?? 0.15) < 0.05;
      // Small pools: SSD-only scoring. The 8×8 pixel comparison already captures
      // color, brightness, texture, and spatial distribution in one metric.
      // Other weights are redundant and can cause worse matches by overriding SSD.
      const wSsdBase = isSmallPool ? 1.0 : (noOverlay ? 0.50 : 0.38);
      const wLabBase = isSmallPool ? 0 : (savedSettings.labWeight ?? 0.15);
      const wBrightBase = isSmallPool ? 0 : (savedSettings.brightnessWeight ?? 0.40);
      const wTextureBase = isSmallPool ? 0 : (savedSettings.textureWeight ?? 0.08);
      const wSatBase = isSmallPool ? 0 : (savedSettings.saturationWeight ?? 0.25);
      // Cell-level features (constant across all candidates for this cell)
      const targetSatC = tf.saturation;
      const cellEdge = edgeMap[ci]; // 0-1
      for (const j of candidateIndices) {
        const mf = filteredImgFeatures[j];
        // Base penalties (rotation-independent)
        // neighborPenalty applied uniformly - no special reduction for bright tiles
        // (previously reduced for bright neutral tiles, but this caused white spots in dark areas)
        let neighborPenalty = neighborIds.has(j) ? NEIGHBOR_PENALTY : 0;
        const cellMaxReuse = getMaxReuseForCell(cellLab[ci][0]);
        // Small pool: uniformly boost reuse limit (each tile used ~53x with 203 photos)
        const effectiveMaxReuse = isSmallPool ? cellMaxReuse * 3 : cellMaxReuse;
        const reusePenalty = useCount[j] >= effectiveMaxReuse ? 25 * (useCount[j] - effectiveMaxReuse + 1) : 0;

        // ── Rotation-independent metrics (computed once per candidate, not per rotation) ──────────
        // 0. Pixel-accurate SSD score (8x8 RGB comparison - most accurate signal)
        // ssdPixels are not rotated, so SSD is identical for all rotations of the same tile.
        const tRegion = targetRegions[ci]; // 8x8x3 RGB of target cell
        const mPixels = mf.ssdPixels;       // 8x8x3 RGB of candidate tile
        let ssdSum = 0;
        for (let px = 0; px < tRegion.length; px++) {
          const d2 = tRegion[px] - mPixels[px];
          ssdSum += d2 * d2;
        }
        const ssdScore = ssdSum / (tRegion.length / 3) / (255 * 255); // normalize 0-1

        // 1. Global LAB distance (color matching) - CIEDE2000 (perceptually uniform)
        // Replaces Euclidean DeltaE: CIEDE2000 is more accurate for skin tones and near-neutral colors.
        // Particularly important for portrait mosaics: reduces over-emphasis on blue/yellow shifts.
        // mf.lab is rotation-invariant, so labDist is the same for all rotations.
        const labDist = deltaE2000(tf.lab[0], tf.lab[1], tf.lab[2], mf.lab[0], mf.lab[1], mf.lab[2]);
        // 3. Brightness difference (Hybrid-SSD: brightness gets extra weight for contrast)
        const brightDiff = Math.abs(tf.brightness - mf.brightness);
        // 4. Texture similarity
        const textureDiff = Math.abs(tf.texture - mf.texture) / 50;
        // 5. Edge Priority Matching: adaptive weight 0.05-0.50 based on cell edge strength
        const edgeDiff = Math.abs(tf.edgeEnergy - mf.edgeEnergy);
        const edgeWeight = isSmallPool ? 0 : (0.05 + cellEdge * 0.75); // small pools: SSD-only; otherwise 0.05-0.80
        // 6. Saturation difference
        // Prevents gray tiles in colorful areas and vice versa
        // saturation = sqrt(a^2+b^2), range 0-100
        const tileSatC = mf.saturation;
        const satDiff = Math.abs(targetSatC - tileSatC) / 100; // normalize 0-1
        // Repetition penalty: gentle growth to allow more reuse (reduces graininess)
        // User tiles in mix mode get much softer reuse penalty (they should appear frequently)
        const rc = useCount[j] || 0;
        const isUserTileMix = userTileFilteredSet.has(j);
        const repPenalty = isUserTileMix
          ? (rc === 0 ? 0 : rc <= 3 ? 3 : rc <= 8 ? 8 : rc <= 15 ? 20 : 40)
          : (rc === 0 ? 0 : rc === 1 ? 15 : rc === 2 ? 40 : rc === 3 ? 80 : 150);

        // ── Compute baseDist: all scoring except quadDist (which is rotation-dependent) ──────────
        // quadDist (weight 0.15) is added in the rotation loop below.
        let baseDist: number;
        // Face region scoring
        if (inFace && isSmallPool) {
          // ── SMALL POOL FACE: SSD + strong warm-tone enforcement ──────────────────
          // SSD captures pixel-level similarity, but small pools often lack warm tiles.
          // Strong color-direction guards ensure no blue/green tiles in face/skin areas.
          baseDist = ssdScore * 100;
          // Skin-tone detection for target cell
          const spIsTargetSkin = tf.lab[0] >= 35 && tf.lab[0] <= 85 && tf.lab[1] >= 2 && tf.lab[2] >= 5;
          // Green guard: green tiles (a < -3) are wrong in face areas
          if (mf.lab[1] < -3) {
            const spGreenPen = spIsTargetSkin ? 40 : 20;
            baseDist += Math.min(500, (-mf.lab[1] - (-3)) * spGreenPen);
          }
          // Blue/cool guard: cool tiles (b < 5) are wrong in warm skin areas
          if (mf.lab[2] < 5) {
            const spBluePen = spIsTargetSkin ? 30 : 15;
            baseDist += Math.min(500, (5 - mf.lab[2]) * spBluePen);
          }
          // Warm-cool gap: if target is warm (b>8) and tile is cool (b<8), penalize
          if (spIsTargetSkin && tf.lab[2] > 8 && mf.lab[2] < 8) {
            baseDist += Math.min(400, (tf.lab[2] - 8) * (8 - mf.lab[2]) * 5);
          }
          // Brightness consistency in face: penalize large brightness differences
          if (Math.abs(tf.brightness - mf.brightness) > 20) {
            baseDist += (Math.abs(tf.brightness - mf.brightness) - 20) * 3;
          }
          baseDist += neighborPenalty * 0.3 + reusePenalty * 0.2;
        } else if (inFace) {
          // Per-subregion weight multipliers (MediaPipe Face Mesh)
          // eye: max edge sharpness, high SSD, moderate sat penalty (eyes have color)
          // mouth: high edge + SSD, strong sat penalty (lips have color but must match)
          // nose: high brightness, moderate edge, strong sat penalty (skin area)
          // cheek/forehead: max skin-tone matching, low edge, very strong sat penalty
          const wSsdFace   = subRegion === 'eye' ? 0.65 : subRegion === 'mouth' ? 0.60 : subRegion === 'nose' ? 0.50 : 0.45;
          const wLabF      = subRegion === 'eye' ? wLabBase * 2.0 : subRegion === 'mouth' ? wLabBase * 1.8 : subRegion === 'nose' ? wLabBase * 2.0 : wLabBase * 2.2;
          // Dynamic brightness weight:
          // MASSIV erhöht für Hautbereiche: Helligkeitsunterschiede sind im Gesicht sehr auffällig
          const isVeryBright = tf.brightness > 75;
          const faceBrightBoost = isVeryBright ? 1.6 : (tf.brightness > 65 ? 0.85 : 1.0);
          const wBrightF   = (subRegion === 'cheek' || subRegion === 'forehead' ? wBrightBase * 2.5 : subRegion === 'nose' ? wBrightBase * 2.2 : wBrightBase * 1.8) * faceBrightBoost;
          const faceEdgeWeight = subRegion === 'eye' ? edgeWeight * 3.0 : subRegion === 'mouth' ? edgeWeight * 2.5 : subRegion === 'nose' ? edgeWeight * 2.0 : edgeWeight * 1.5;
          // Texture weight: STARK erhöht für Hautbereiche - ruhige Tiles bevorzugen
          const faceTextureWeight = subRegion === 'eye' ? wTextureBase * 2.5 : subRegion === 'mouth' ? wTextureBase * 2.0 : subRegion === 'nose' ? wTextureBase * 3.0 : wTextureBase * 3.5;
          // Saturation weight: moderate for face
          const faceSatWeight = subRegion === 'cheek' || subRegion === 'forehead' ? wSatBase * 1.8 : subRegion === 'nose' ? wSatBase * 1.5 : wSatBase * 1.2;
          baseDist = wSsdFace * ssdScore * 100 + wLabF * labDist + wBrightF * brightDiff + faceTextureWeight * textureDiff * 50 + faceEdgeWeight * edgeDiff * 100 + faceSatWeight * satDiff * 100;
          // BRIGHTNESS CONSISTENCY: penalize tiles with significantly different brightness in face
          // This is the key fix for "Kontrastvariation" in skin areas
          if (Math.abs(tf.brightness - mf.brightness) > 15) {
            baseDist += (Math.abs(tf.brightness - mf.brightness) - 15) * 4; // gradual penalty
          }
          // Skin-tone detection: warm L:40-85, a:3-25, b:8-35 (tighter range for better consistency)
          const isTargetSkin = tf.lab[0] >= 35 && tf.lab[0] <= 85 && tf.lab[1] >= 3 && tf.lab[1] <= 25 && tf.lab[2] >= 8 && tf.lab[2] <= 35;
          const isTileSkin = mf.lab[0] >= 35 && mf.lab[0] <= 85 && mf.lab[1] >= 3 && mf.lab[1] <= 25 && mf.lab[2] >= 8 && mf.lab[2] <= 35;
          if (isTargetSkin && isTileSkin) baseDist -= 400; // skin-tone bonus: MASSIV bevorzugen (was -200)
          // cheek/forehead: stronger penalty for non-skin tiles in skin areas
          const skinMismatchPenalty = (subRegion === 'cheek' || subRegion === 'forehead') ? 1200 : (subRegion === 'nose' ? 900 : 500);
          if (isTargetSkin && !isTileSkin) baseDist += skinMismatchPenalty;
          // EXTRA: Any tile with cool hue (b < 3) in warm skin area gets penalty
          if (isTargetSkin && mf.lab[2] < 3 && tf.lab[2] > 8) {
            baseDist += Math.min(300, (tf.lab[2] - mf.lab[2]) * 8); // push cool tiles away from warm skin
          }
          // MIX MODE: User tile preference bonus (user photos should appear prominently)
          if (isUserTileMix) baseDist -= 25;
          // GREEN/COOL TILE PENALTY: always active in face regions (regardless of isTargetSkin)
           // Exception: very bright target areas (L>75 = white hair/beard) – cool/neutral tiles are OK there
           if (!isVeryBright) {
             // Green tiles (a < 0) are almost never correct in face areas
             if (mf.lab[1] < 0) {
               const greenFactor = isTargetSkin ? 250 : 120;
               baseDist += Math.min(5000, (-mf.lab[1]) * greenFactor);
             }
             // BLUE/COOL TILE PENALTY: cool tiles in face regions
             // MASSIV verstärkt: Hauttöne haben b > 10, ALLE kühlen Tiles (b < 5) hart bestrafen
             if (mf.lab[2] < 5) {
               const bluePenaltyFactor = isTargetSkin ? 200 : (mf.lab[0] < 65 ? 120 : 50);
               baseDist += Math.min(5000, (5 - mf.lab[2]) * bluePenaltyFactor);
             }
             // CYAN/TEAL PENALTY: tiles with negative a AND negative b (cool-toned) in face
             if (mf.lab[1] < 0 && mf.lab[2] < 0) {
               baseDist += Math.min(500, Math.abs(mf.lab[1]) * Math.abs(mf.lab[2]) * 3); // penalize cool-toned tiles
             }
           } else {
             // Very bright target (white hair/beard): penalize ALL blue/cool tiles
             // White hair (L>75) needs neutral/warm tiles – blue pool tiles (water, sky) look wrong
             // Tier 1: Any tile with b < -3 (slightly blue) gets moderate penalty
             if (mf.lab[2] < -3) {
               const blueStrength = -3 - mf.lab[2]; // how blue the tile is
               const brightFactor = Math.min(1.0, (tf.brightness - 75) / 15); // ramp up with target brightness
               baseDist += Math.min(800, blueStrength * 40 * (0.5 + brightFactor * 0.5));
             }
             // Tier 2: Dark blue tiles (L<60) get extra penalty (they look terrible in white hair)
             if (mf.lab[2] < -5 && mf.lab[0] < 60) {
               baseDist += Math.min(600, (-mf.lab[2] - 5) * 35);
             }
             // Tier 3: High-saturation cool tiles (saturated blue/teal) in white hair
             if (tileSatC > 20 && mf.lab[2] < 0) {
               baseDist += Math.min(500, tileSatC * (-mf.lab[2]) * 2);
             }
           }
           // Subject-Penalty: non-warm, non-neutral colorful tiles in skin areas
           // MASSIV verstärkt: Blaue/grüne Tiles haben NICHTS in Gesichtern zu suchen
           {
             const tileIsWarm = mf.lab[1] > 3 && mf.lab[2] > 5; // a>3, b>5 = clearly warm/skin-like (verschärft)
             const tileIsNeutral = tileSatC < 15 && mf.lab[2] > -3; // low saturation AND not blue (verschärft)
             if (isTargetSkin && !tileIsWarm && !tileIsNeutral) {
               // Any non-warm, non-neutral tile in skin area: heavy penalty
               const coolPenalty = tileSatC > 25 ? 1500 : (tileSatC > 15 ? 800 : 400);
               baseDist += coolPenalty;
             }
           }
           // Warm-Cool-Gap Penalty: Hauttöne sind warm (b > 5), kühle Tiles (b < 8) bestrafen
           // MASSIV verstärkt für Anti-Blaustich
           if (isTargetSkin && tf.lab[2] > 5 && mf.lab[2] < 8) {
             baseDist += Math.min(3000, (tf.lab[2] - 5) * (8 - mf.lab[2]) * 12);
           }
           // Cool-A-Axis Penalty: Skin has positive a (red), penalize tiles with a < 2
           if (isTargetSkin && tf.lab[1] > 3 && mf.lab[1] < 2) {
             baseDist += Math.min(2000, (tf.lab[1] - 3) * (2 - mf.lab[1]) * 10);
           }
           // tileComplexity Penalty in Face (Stage-2) - VERSCHÄRFT:
           // Penalize busy/detailed tiles in smooth skin areas.
           // Eye zone allows complexity (eyebrows, lashes), skin/cheek/forehead must be calm.
           {
             const faceTileCx = mf.edgeEnergy; // proxy for tileComplexity (0=calm, 1=busy)
             const faceCellEdge = cellEdge;     // 0-1 target edge energy (hoisted to cell level)
             if (subRegion === 'cheek' || subRegion === 'forehead' || subRegion === 'nose') {
               // Skin areas: AGGRESSIVELY penalize busy tiles
               if (faceCellEdge < 0.25 && faceTileCx > 0.30) {
                 baseDist += (faceTileCx - 0.30) * 600; // up to +420 (was +120)
               } else if (faceCellEdge < 0.50 && faceTileCx > 0.40) {
                 baseDist += (faceTileCx - 0.40) * 400; // up to +240 (was +120)
               } else if (faceCellEdge < 0.70 && faceTileCx > 0.60) {
                 baseDist += (faceTileCx - 0.60) * 200; // up to +80 (new)
               }
             } else if (subRegion === 'mouth') {
               // Mouth: some complexity OK (lip texture), but not too busy
               if (faceCellEdge < 0.50 && faceTileCx > 0.50) {
                 baseDist += (faceTileCx - 0.50) * 300; // up to +150 (was +80)
               }
             } else if (subRegion === 'chin' || subRegion === 'jaw') {
               // Chin/jaw: smooth areas, penalize busy tiles
               if (faceCellEdge < 0.40 && faceTileCx > 0.40) {
                 baseDist += (faceTileCx - 0.40) * 350; // up to +210 (new)
               }
             }
             // Eye zone: no tileComplexity penalty (eyes need detail)
           }
          // Low-saturation penalty: only active for non-bright target areas (L < 75)
          // For very bright areas (white hair/beard, L>75): skip sat penalties entirely
          // – those areas need light tiles regardless of saturation
          if (!isVeryBright) {
            if (targetSatC < 25 && tileSatC > 35) {
              // Gray/neutral target area: strongly penalize colorful tiles
              baseDist += (tileSatC - 35) / 100 * 6 * 100; // x6 multiplier
            }
            if (isTargetSkin && tileSatC < 12) {
              // Skin area: penalize very washed-out gray tiles
              baseDist += (12 - tileSatC) / 12 * 3 * 100; // up to +300 for sat=0 in skin area
            }
            // Penalize highly saturated tiles (sat>65) in face regions
            if (tileSatC > 65) {
              baseDist += (tileSatC - 65) / 35 * 3 * 100; // up to +300 for sat=100 in face
            }
          } else {
            // Very bright target (L>75): only penalize DARK tiles (they look wrong in bright areas)
            if (mf.lab[0] < 50 && tf.brightness > 80) {
              baseDist += (50 - mf.lab[0]) * 3; // up to +150 for very dark tile in very bright area
            }
          }
          // CRITICAL FIX: Bright tile in dark face area (prevents white spots in dark beard/hair/clothing)
          if (tf.brightness < 35 && mf.brightness > 60) {
            baseDist += (mf.brightness - 60) * (35 - tf.brightness) * 1.5; // up to ~900 for bright tile in dark face area
          }
          baseDist += neighborPenalty + reusePenalty + repPenalty;
        } else if (isSmallPool) {
          // ── SMALL POOL: Pure SSD scoring with minimal penalties ──────────────────
          // With ~200 photos for ~10800 cells, SSD is the ONLY reliable signal.
          // All hue/saturation/edge/yellow penalties are DISABLED because they
          // override the pixel-accurate SSD match with heuristics designed for
          // large diverse pools. The 8×8 pixel comparison already captures
          // color, brightness, texture, and spatial distribution.
          baseDist = ssdScore * 100;
          // Only keep very minimal anti-repetition to avoid identical neighbors
          // but NOT strong enough to override good SSD matches
          baseDist += neighborPenalty * 0.3 + reusePenalty * 0.2;
        } else {
          // Non-face: full scoring with saturation term
          // Low-sat penalty also applies outside face regions (prevents rainbow-noise in backgrounds)
          // Without overlay: SSD is the primary signal (pixel-accurate color+brightness match)
          // SSD 45% . LAB 15% . Brightness 50% . Texture 15% . Quad 10% . Saturation 40%
          // Higher SSD weight = tiles that look most like the target region (color + luminance)
          baseDist = wSsdBase * ssdScore * 100 + wLabBase * labDist + wBrightBase * brightDiff + wTextureBase * textureDiff * 50 + edgeWeight * edgeDiff * 100 + wSatBase * satDiff * 100;

          // HUE-DIRECTION ENFORCEMENT (non-face regions)
          // This is the KEY FIX for landscapes: cool/gray areas must not get warm tiles
          const tA = tf.lab[1], tB = tf.lab[2];
          const mA = mf.lab[1], mB = mf.lab[2];
          // COOL TARGET (b < 0, slightly blue/neutral): penalize warm tiles (b > 8)
          // This prevents beige/orange/yellow tiles in sky, water, fog, mist
          if (tB < 0 && mB > 8) {
            baseDist += Math.min(600, (-tB + 1) * (mB - 8) * 4);
          }
          // COOL TARGET: also penalize tiles with strong warm red (a > 8) in cool areas
          if (tA < 2 && mA > 8) {
            baseDist += Math.min(400, (mA - 8) * (-tA + 3) * 5);
          }
          // WARM TARGET (b > 5): penalize cool/blue tiles in warm areas
          // Verschärft: mB < 5 (leicht kühle Tiles b=1-4 sehen gegen gelben Hintergrund b=25 deutlich bläulich aus)
          // Cap 1200 (war 500) – verhindert dass guter SSD-Score die Penalty überschreibt
          if (tB > 5 && mB < 5) {
            const warmGap = tB - 5;
            const coolGap = 5 - mB;
            baseDist += Math.min(1200, warmGap * coolGap * 5);
          }

          // SKIN-TONE ENFORCEMENT (non-face regions like ears, neck, arms)
          // Face mask doesn't always cover all skin — catch skin-like LAB values outside face regions
          const isNonFaceSkin = tf.lab[0] >= 35 && tf.lab[0] <= 85 && tf.lab[1] >= 3 && tf.lab[1] <= 30 && tf.lab[2] >= 5 && tf.lab[2] <= 40;
          if (isNonFaceSkin) {
            // Blue/cool tiles (b < 5) in skin areas: strong penalty
            if (mB < 5) {
              baseDist += Math.min(1500, (5 - mB) * 80);
            }
            // Green tiles (a < 0) in skin areas
            if (mA < 0) {
              baseDist += Math.min(1000, (-mA) * 60);
            }
            // Non-warm tile general penalty
            const tileIsWarmNf = mA > 3 && mB > 5;
            const tileIsNeutralNf = tileSatC < 15 && mB > -3;
            if (!tileIsWarmNf && !tileIsNeutralNf && tileSatC > 15) {
              baseDist += 500; // hard penalty for clearly cool/colored tiles in skin
            }
          }
          // NEUTRAL/GRAY TARGET (low saturation, near-neutral LAB):
          // Penalize tiles with strong hue in any direction
          if (targetSatC < 15 && tileSatC > 30) {
            baseDist += (tileSatC - 30) * 4; // up to +280 for very saturated tile in neutral area
          }

          // BIDIRECTIONAL saturation penalty (fixes gray/dark patches in colored areas):
          // (1) Colorful tile in gray/neutral target area -> penalize
          if (targetSatC < 25 && tileSatC > 40) {
            baseDist += (tileSatC - 40) / 100 * 2 * 100; // x2 multiplier for non-face
          }
          // (2) Gray/desaturated tile in strongly colored target area -> heavy penalty
          // This is the KEY FIX for red jacket / blue sky / green grass appearing dark/gray
          if (targetSatC > 30) {
            // Strongly saturated target: penalize tiles that are much less saturated
            const satGap = targetSatC - tileSatC;
            if (satGap > 20) {
              baseDist += (satGap - 20) / 80 * 8 * 100; // up to +800 for very gray tile in very colorful area
            }
            // HUE MISMATCH PENALTY: penalize tiles whose hue direction is wrong
            // In LAB: a=red/green axis, b=yellow/blue axis
            // If target is strongly red (a>15), penalize tiles with negative a (green)
            // If target is strongly blue (b<-15), penalize tiles with positive b (yellow)
            // (tA, tB, mA, mB already declared above)
            // Red target (a>15): penalize green tiles (a<0)
            if (tA > 15 && mA < 0) baseDist += Math.min(400, (-mA) * (tA / 15) * 8);
            // Blue target (b<-15): penalize yellow tiles (b>0)
            if (tB < -15 && mB > 0) baseDist += Math.min(400, mB * (-tB / 15) * 8);
            // Green target (a<-15): penalize red tiles (a>0)
            if (tA < -15 && mA > 0) baseDist += Math.min(400, mA * (-tA / 15) * 8);
            // Yellow target (b>15): penalize cool/blue tiles (b<5)
            // Verschärft: mB<5 statt mB<0 (leicht kühle Tiles b=0-4 wirken bläulich gegen gelb)
            // Cap 800 (war 400) – verhindert Überschreibung durch SSD
            if (tB > 15 && mB < 5) baseDist += Math.min(800, (5 - mB) * (tB / 15) * 12);
          } else if (targetSatC > 15 && tileSatC < 10) {
            baseDist += (10 - tileSatC) / 10 * 4 * 100; // x4: strongly push gray tiles away from colored areas
          } else if (targetSatC > 10 && tileSatC < 18 && tf.lab[1] > 2) {
            // Softer penalty for slightly gray tiles in warm/colored areas
            baseDist += (18 - tileSatC) / 18 * 2 * 100; // x2 soft penalty
          }
          // YELLOW AREA: prevent cool/blue tiles in strongly yellow targets (b>20)
          // Gelbe T-Shirts/Kleidung: Jeder Tile mit b < 8 bekommt harte Strafe
          if (tB > 20 && mB < 8) {
            baseDist += Math.min(1500, (8 - mB) * (tB - 20) * 8);
          }

          // YELLOW TILE PENALTY: overly yellow tile (LAB b > 28) in skin/warm area (a > 3, b < 25)
          // Prevents bright yellow sunset tiles from appearing in skin-tone face areas
          const tileB = mf.lab[2];    // LAB b channel: positive = yellow
          const targetA = tf.lab[1];  // LAB a channel: positive = red/warm
          const targetBLab = tf.lab[2]; // LAB b channel of target
          if (tileB > 28 && targetA > 3 && targetBLab < 22) {
            // Tile is very yellow but target is warm/skin (not yellow) -> penalize
            baseDist += (tileB - 28) * (targetA / 10) * 6; // up to ~120 penalty
          }
          // EXTENDED YELLOW PENALTY: penalize tiles that are much more yellow than the target
          // This fixes yellow flecks in beige sweaters, white backgrounds, gray hair
          // Condition: tile is significantly more yellow than target AND target is bright
          // TWO-TIER: very bright (L>65) = aggressive; moderate (L=55-65) = gentle
          if (tf.brightness > 55 && tileB > targetBLab + 12) {
            // Tile is much more yellow than target -> penalize
            const yellowOvershoot = tileB - targetBLab - 12;
            const isVeryBright = tf.brightness > 65;
            const brightStrength = isVeryBright
              ? Math.min(1.0, (tf.brightness - 65) / 20) // aggressive for very bright
              : Math.min(0.35, (tf.brightness - 55) / 28); // gentle for moderate brightness
            const penaltyFactor = isVeryBright ? 22 : 10;
            baseDist += yellowOvershoot * penaltyFactor * brightStrength;
          }
          // DARK TILE IN BRIGHT AREA PENALTY: prevents dark spots in bright backgrounds
          // MASSIV verstärkt: dark tiles in bright areas are the #1 visual defect
          const targetBr = tf.brightness; // 0-100
          const tileBr = mf.brightness;   // 0-100
          // Tier 1: Very dark tile in very bright area (e.g. black tile in white wall)
          if (targetBr > 65 && tileBr < 25) {
            baseDist += (25 - tileBr) * (targetBr - 65) * 0.8; // up to +700
          }
          // Tier 2: Moderate brightness mismatch (e.g. gray tile in bright area)
          if (targetBr > 55 && tileBr < targetBr - 35) {
            baseDist += (targetBr - tileBr - 35) * 3; // gradual penalty for any significant mismatch
          }

          // FIX 2: SMOOTH-REGION → CALM-TILES RULE (VERSCHÄRFT)
          // If target cell is smooth (low edgeEnergy), only allow calm tiles
          // This prevents busy/detailed tiles from appearing in sky, water, fog, haze
          const cellEdgeEnergy = cellEdge; // 0-1: how much edge/detail in target cell (hoisted to cell level)
          const tileEdgeEnergy = mf.edgeEnergy; // 0-1: how much edge/detail in tile
          if (cellEdgeEnergy < 0.15) {
            // Very smooth target (sky, fog, calm water): AGGRESSIVELY penalize busy tiles
            if (tileEdgeEnergy > 0.25) {
              baseDist += (tileEdgeEnergy - 0.25) * 1000; // up to +750 (was +390)
            }
          } else if (cellEdgeEnergy < 0.30) {
            // Smooth target: strongly penalize busy tiles
            if (tileEdgeEnergy > 0.40) {
              baseDist += (tileEdgeEnergy - 0.40) * 700; // up to +420 (was +135)
            }
          } else if (cellEdgeEnergy < 0.50) {
            // Moderate target: penalize very busy tiles
            if (tileEdgeEnergy > 0.60) {
              baseDist += (tileEdgeEnergy - 0.60) * 400; // up to +160 (new tier)
            }
          }

          // FIX 3: EDGE-MISMATCH PENALTY (VERSCHÄRFT)
          // Add an explicit mismatch penalty: if cell is smooth but tile is detailed, penalize hard
          if (cellEdgeEnergy < 0.25 && tileEdgeEnergy > 0.45) {
            // Smooth cell + busy tile = very bad match
            baseDist += (tileEdgeEnergy - 0.45) * (0.25 - cellEdgeEnergy) * 1500; // was 1000
          }

          // FIX 4: DARK-REGION PROTECTION
          // Dark target areas (sky at dusk, dark water, shadows): prevent chaotic high-contrast tiles
          if (targetBr < 35) {
            // Dark area: penalize tiles with very high internal contrast (high edgeEnergy)
            // These create the "black pixel noise" effect in dark regions
            if (tileEdgeEnergy > 0.60) {
              baseDist += (tileEdgeEnergy - 0.60) * 400; // up to +160 for very busy tile in dark area
            }
            // Also penalize tiles that are much brighter than the target (creates bright spots in dark areas)
            // CRITICAL FIX: Strong penalty for bright tiles in dark areas (prevents white spots in dark clothing)
            if (tileBr > targetBr + 25) {
              baseDist += (tileBr - targetBr - 25) * 20; // up to ~1100 for very bright tile in dark area (was *3)
            }
          }

          // SOFT-BORDER ZONE: blend face+background scoring for smooth roundings
          // Cells at the edge of the face mask get partial face scoring to avoid blocky transitions
          if (softBorder > 0) {
            const blendFaceWeight = softBorder === 2 ? 0.70 : 0.35; // inner: 70%, outer: 35%
            // Skin-tone bonus: prefer warm tiles in transition zone (matches face edge)
            const isTargetSkinBorder = tf.lab[0] >= 30 && tf.lab[0] <= 85 && tf.lab[1] >= 2 && tf.lab[1] <= 32 && tf.lab[2] >= 3 && tf.lab[2] <= 42;
            const isTileSkinBorder = mf.lab[0] >= 30 && mf.lab[0] <= 85 && mf.lab[1] >= 2 && mf.lab[1] <= 32 && mf.lab[2] >= 3 && mf.lab[2] <= 42;
            if (isTargetSkinBorder && isTileSkinBorder) baseDist -= 12 * blendFaceWeight; // skin-tone bonus
            if (isTargetSkinBorder && !isTileSkinBorder) baseDist += 30 * blendFaceWeight; // skin mismatch penalty
            // Penalize green/cool tiles in transition zone (same as face region)
            if (!isTargetSkinBorder && mf.lab[1] < -3) baseDist += Math.min(400, (-mf.lab[1] - 3) * 30) * blendFaceWeight;
            // Brightness matching: transition zone needs smooth brightness gradient
            const borderBrightPenalty = brightDiff * 0.4 * blendFaceWeight;
            baseDist += borderBrightPenalty;
          }

          // YELLOW/WARM-TILE PENALTY for bright neutral non-face areas (white background, gray hair)
          // Prevents yellow/warm tiles from appearing in white walls, gray hair, neutral backgrounds
          // TWO-TIER: very bright (L>68) = aggressive; moderately bright (L=55-68) = gentle
          if (tf.brightness > 55 && targetSatC < 32) {
            const tileLabB = mf.lab[2]; // LAB b: positive = yellow
            const tileLabA = mf.lab[1]; // LAB a: positive = red/warm
            // Very bright (L>68): full aggressive penalty for white walls/gray hair
            // Moderately bright (L=55-68): gentle penalty only for extreme yellow tiles
            const isVeryBrightNeutral = tf.brightness > 68;
            const neutralStrength = isVeryBrightNeutral
              ? Math.min(1.0, (tf.brightness - 68) / 15) // 0 at L=68, 1 at L=83
              : Math.min(0.4, (tf.brightness - 55) / 32); // max 0.4 for moderate brightness
            // Penalize yellow tiles in bright neutral areas
            const yellowThreshold = isVeryBrightNeutral ? 8 : 14; // more lenient for moderate brightness
            if (tileLabB > yellowThreshold) {
              const factor = isVeryBrightNeutral ? 38 : 20; // aggressive for very bright, gentle for moderate
              baseDist += (tileLabB - yellowThreshold) * factor * neutralStrength;
            }
            // Penalize warm/red tiles in very bright neutral areas only
            if (isVeryBrightNeutral && tileLabA > 6) {
              baseDist += (tileLabA - 6) * 22 * neutralStrength; // up to ~660 for very warm tile
            }
            // EXTENDED: also penalize tiles that are much more yellow than the target
            const overshootThreshold = isVeryBrightNeutral ? 8 : 16;
            if (tileLabB > targetBLab + overshootThreshold) {
              const overshoot = tileLabB - targetBLab - overshootThreshold;
              const overshootFactor = isVeryBrightNeutral ? 30 : 14;
              baseDist += overshoot * overshootFactor * neutralStrength;
            }
          }

          // NEUTRAL-TARGET PENALTY: if target is truly neutral (|b| < 14), penalize yellow OR blue tiles
          // This is the key fix for white backgrounds and gray hair areas
          // Different from the above: this fires for ALL neutral targets regardless of brightness
          if (Math.abs(targetBLab) < 14 && tf.brightness > 40) {
            const tileB2 = mf.lab[2];
            const brightnessScale = Math.min(1.0, (tf.brightness - 40) / 20); // ramp up with brightness
            if (tileB2 > 12) {
              // Target is neutral but tile is yellow -> strong penalty
              const neutralYellowPenalty = (tileB2 - 12) * brightnessScale * 45;
              baseDist += neutralYellowPenalty;
            }
            if (tileB2 < -5) {
              // Target is neutral but tile is blue -> penalize (prevents blue flecks in white hair/walls)
              // Threshold lowered from -12 to -5: tiles with b=-6 to -11 were slipping through
              // Factor increased for bright targets (white hair has brightness > 70)
              // brightBoost: 2.5 → 5.0 for L>70, 3.0 for L>60 (white/gray hair outside face mesh)
              const brightBoost = tf.brightness > 75 ? 5.0 : (tf.brightness > 70 ? 3.5 : (tf.brightness > 60 ? 2.0 : 1.0));
              const neutralBluePenalty = (-tileB2 - 5) * brightnessScale * 55 * brightBoost;
              baseDist += Math.min(2500, neutralBluePenalty);
            }
            // Extra: very blue tiles (b < -12) in ANY bright neutral area get a hard cap penalty
            if (tileB2 < -12 && tf.brightness > 55) {
              baseDist += Math.min(1500, (-tileB2 - 12) * 80 * brightnessScale);
            }
          }
          // MIX MODE: User tile preference bonus (user photos should appear prominently)
          if (isUserTileMix) baseDist -= 25;
          // Anti-repetition penalties
          baseDist += neighborPenalty + reusePenalty + repPenalty;
        } // end if (inFace) / else

        // ── Rotation loop: only quadDist is rotation-dependent ────────────────────────────────────
        // Quadrant LAB distances (spatial color accuracy) - the only term that varies per rotation.
        // Edge-adaptive weight: edge cells get much higher quadrant weight to prefer gradient tiles
        // that match the actual color transition direction.
        const wQuadSSD = isSmallPool ? 0 : (cellEdge > 0.15
          ? 0.15 + cellEdge * 0.60  // edge cells: 0.24 (weak edge) to 0.75 (strong edge)
          : 0.15);                   // flat cells: baseline 0.15
        for (const rot of rotations) {
          const rotatedQuads = rotateQuads(mf.quads, rot);
          let quadDist = 0;
          for (let q=0; q<4; q++) {
            const [ql,qa,qb] = [tf.quads[q][0]-rotatedQuads[q][0], tf.quads[q][1]-rotatedQuads[q][1], tf.quads[q][2]-rotatedQuads[q][2]];
            quadDist += Math.sqrt(ql*ql + qa*qa + qb*qb);
          }
          quadDist /= 4;
          const dist = baseDist + wQuadSSD * quadDist;
          if (dist < bestDist) { bestDist = dist; bestIdx = j; bestRot = rot; }
        }
      }
      assignment[ci] = bestIdx;
      assignmentRotation[ci] = bestRot;
      useCount[bestIdx]++;
      if (ti % 300 === 0) {
        setProgress(50 + Math.round((ti / TOTAL_TILES) * 10));
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Store assignment and valid images for hi-res re-render
    assignmentRef.current = assignment;
    assignmentRotRef.current = [...assignmentRotation];
    validImgsRef.current = filteredValidImgs;
    validImgsHiResRef.current = filteredHiRes;
    tileIdsRef.current = filteredTileIds;
    // Store overlay data for server-side overlay in print/digital downloads
    const targetColorsFlat: number[] = new Array(TOTAL_TILES * 3);
    for (let ci = 0; ci < TOTAL_TILES; ci++) {
      const i = ci * 4;
      targetColorsFlat[ci * 3]     = targetData[i];
      targetColorsFlat[ci * 3 + 1] = targetData[i + 1];
      targetColorsFlat[ci * 3 + 2] = targetData[i + 2];
    }
    targetColorsRef.current = targetColorsFlat;
    edgeMapRef.current = [...edgeMap];
    faceMaskRef.current = [...faceMask];
    cellLabRef.current = [...cellLab]; // Store for hi-res color correction

    // Build color enhance canvas: 1 pixel per cell with target color
    // Used as a real-time multiply overlay controlled by the Color Enhance slider
    {
      const ceCanvas = document.createElement('canvas');
      ceCanvas.width = COLS;
      ceCanvas.height = ROWS;
      const ceCtx = ceCanvas.getContext('2d')!;
      const ceData = ceCtx.createImageData(COLS, ROWS);
      for (let ci = 0; ci < TOTAL_TILES; ci++) {
        const pi = ci * 4;
        const ti = ci * 3;
        ceData.data[pi]     = targetColorsFlat[ti];
        ceData.data[pi + 1] = targetColorsFlat[ti + 1];
        ceData.data[pi + 2] = targetColorsFlat[ti + 2];
        ceData.data[pi + 3] = 255;
      }
      ceCtx.putImageData(ceData, 0, 0);
      colorEnhanceCanvasRef.current = ceCanvas;
      setColorEnhanceUrl(ceCanvas.toDataURL('image/png'));
    }

    // -- Compute Quality Metrics ----------------------------------------------
    // Compute after matching so we have the final assignment
    try {
      let deltaESum = 0;
      let satLowCount = 0, satMidCount = 0, satHighCount = 0;
      const uniqueUsed = new Set<number>();
      for (let ci = 0; ci < (TOTAL_TILES); ci++) {
        const idx = assignment[ci];
        if (idx < 0) continue;
        uniqueUsed.add(idx);
        const mf = filteredImgFeatures[idx];
        const tf = cellFeatures[ci];
        // Delta-E: CIEDE2000 (perceptually uniform, same formula as Stage C scoring)
        deltaESum += deltaE2000(tf.lab[0], tf.lab[1], tf.lab[2], mf.lab[0], mf.lab[1], mf.lab[2]);
        // Saturation distribution of assigned tiles
        const sat = mf.saturation; // sqrt(a^2+b^2), range 0-100
        if (sat < 20) satLowCount++;
        else if (sat <= 60) satMidCount++;
        else satHighCount++;
      }
      const validCount = TOTAL_TILES;
      setQualityMetrics({
        avgDeltaE: deltaESum / validCount,
        reuseRate: uniqueUsed.size / filteredValidImgs.length,
        satLow: (satLowCount / validCount) * 100,
        satMid: (satMidCount / validCount) * 100,
        satHigh: (satHighCount / validCount) * 100,
        totalTiles: TOTAL_TILES,
        uniqueTiles: uniqueUsed.size,
      });

      // -- Build Debug Report ----------------------------------------------
      const blendFactor = Math.min(1.0, (savedSettings.histogramBlend ?? 0.0) / 0.10);
      const faceCellCount = faceMask.filter(Boolean).length;
      setDebugReport({
        // Tile pool
        dbTilesTotal: TOTAL_DB_TILES,
        indexDimension: IS_15D ? '15D' : IS_14D ? '14D' : IS_7D ? '7D' : '4D',
        tilesLoaded: filteredValidImgs.length + (imgFeatures.length - filteredImgFeatures.length),
        tilesAfterFilter: filteredValidImgs.length,
        tilesFiltered: imgFeatures.length - filteredImgFeatures.length,
        // Grid
        cols: COLS,
        rows: ROWS,
        totalCells: TOTAL_TILES,
        tilePx: TILE_PX,
        // Matching
        use2Stage: USE_2STAGE,
        topK: TOP_K,
        maxReuse: MAX_REUSE,
        neighborRadius: NEIGHBOR_RADIUS,
        neighborPenalty: NEIGHBOR_PENALTY,
        enableRotation: ENABLE_ROTATION,
        // Scoring weights (Stage C non-face)
        wSsd: savedSettings.ssdWeight ?? 0.30,
        wLab: savedSettings.labWeight ?? 0.15,
        wBrightness: savedSettings.brightnessWeight ?? 0.40,
        wTexture: savedSettings.textureWeight ?? 0.08,
        wSaturation: savedSettings.saturationWeight ?? 0.25,
        wQuad: 0.10,
        // Face
        facesDetected: _debugFacesDetected,
        faceCellCount,
        faceCellPct: (faceCellCount / TOTAL_TILES) * 100,
        // Color transfer
        lBlend: 0.20 + 0.50 * blendFactor,
        abBlend: 0.10 + 0.20 * blendFactor,
        maxColorShift: 12,
        histogramBlend: savedSettings.histogramBlend ?? 0.0,
        contrastBoost: savedSettings.contrastBoost ?? 1.30,
        // Overlay
        overlayMode: savedSettings.overlayMode ?? 'softlight',
        baseOverlay: savedSettings.baseOverlay ?? 0.15,
        edgeBoost: savedSettings.edgeBoost ?? 0.20,
        // Timing
        generationMs: performance.now() - _debugStartMs,
      });
      // Save debug report to localStorage so Admin panel can read it
      try {
        const reportForAdmin = {
          pool: {
            dbTotal: TOTAL_DB_TILES,
            loaded: filteredValidImgs.length + (imgFeatures.length - filteredImgFeatures.length),
            afterFilter: filteredValidImgs.length,
            filterNote: `${imgFeatures.length - filteredImgFeatures.length} gefiltert`,
            matchingMode: USE_2STAGE ? '2-Stage k-NN' : 'k-NN',
            topK: TOP_K,
          },
          grid: {
            cols: COLS, rows: ROWS, total: TOTAL_TILES, tilePx: TILE_PX,
            maxReuse: MAX_REUSE, rotation: ENABLE_ROTATION,
            antiRepeat: { radius: NEIGHBOR_RADIUS, penalty: NEIGHBOR_PENALTY },
            faceDetection: { count: _debugFacesDetected, pct: Math.round((faceMask.filter(Boolean).length / TOTAL_TILES) * 100) },
          },
          weights: {
            'Helligkeit (L)': savedSettings.brightnessWeight ?? 0.40,
            'Farbe (LAB)': savedSettings.labWeight ?? 0.15,
            'Textur': savedSettings.textureWeight ?? 0.08,
            'Sättigung': savedSettings.saturationWeight ?? 0.25,
            'Kanten': savedSettings.edgeWeight ?? 0.12,
          },
          colorTransfer: {
            'L-Blend': (0.20 + 0.50 * Math.min(1.0, (savedSettings.histogramBlend ?? 0.0) / 0.10)).toFixed(2),
            'AB-Blend': (0.10 + 0.20 * Math.min(1.0, (savedSettings.histogramBlend ?? 0.0) / 0.10)).toFixed(2),
            'Kontrast-Boost': savedSettings.contrastBoost ?? 1.30,
            'Histogram-Blend': savedSettings.histogramBlend ?? 0.0,
          },
          overlay: {
            'Modus': savedSettings.overlayMode ?? 'none',
            'Basis-Opacity': savedSettings.baseOverlay ?? 0.0,
            'Edge-Boost': savedSettings.edgeBoost ?? 0.0,
          },
          quality: {
            avgDeltaE: Math.round((deltaESum / validCount) * 10) / 10,
            uniqueTiles: uniqueUsed.size,
            totalTiles: TOTAL_TILES,
            satLow: Math.round((satLowCount / validCount) * 100),
            satMid: Math.round((satMidCount / validCount) * 100),
            satHigh: Math.round((satHighCount / validCount) * 100),
          },
          renderTimeMs: performance.now() - _debugStartMs,
          suggestions: (() => {
            const s: string[] = [];
            const avgDE = deltaESum / validCount;
            const div = uniqueUsed.size / filteredValidImgs.length;
            if (avgDE > 25) s.push('Farb-Abstand sehr hoch (ΔE > 25): Mehr Tiles importieren (Smart-Import) in unterrepräsentierten Farbbereichen.');
            if (avgDE > 15) s.push('Farb-Transfer aktivieren (Histogram-Blend > 0.05) für bessere Farbgenauigkeit.');
            if (div < 0.3) s.push('Tile-Diversität niedrig (< 30%): Max-Reuse erhöhen oder mehr Tiles importieren.');
            if (TOTAL_TILES > 5000 && uniqueUsed.size / TOTAL_TILES < 0.5) s.push('Für grosse Mosaike (> 5000 Kacheln) mindestens 10.000 Tiles im Pool empfohlen.');
            if (avgDE < 10) s.push('Sehr gute Farbgenauigkeit! Overlay kann auf 0 reduziert werden für reines Tile-Rendering.');
            return s;
          })(),
        };
        localStorage.setItem('mosaicprint_last_debug_report', JSON.stringify(reportForAdmin));
        window.dispatchEvent(new Event('mosaicDebugReportUpdated'));
      } catch { /* ignore */ }
    } catch { /* metrics are optional */ }

    // Step 5: Render with tile rotation and contrast boost
    setProgressMsg("Rendere Mosaik...");
    setProgress(62);
    tilesRef.current = Array.from({ length: TOTAL_TILES }, (_, ci) => ({
      x: (ci % COLS) * TILE_PX,
      y: Math.floor(ci / COLS) * TILE_PX,
      px: TILE_PX,
      url: undefined,
    }));

    // Off-screen canvas for tile contrast boost and rotation
    const tileOffscreen = document.createElement('canvas');
    tileOffscreen.width = TILE_PX; tileOffscreen.height = TILE_PX;
    const tileCtx = tileOffscreen.getContext('2d')!;

    const RENDER_BATCH = 60;
    for (let ci = 0; ci < (TOTAL_TILES); ci++) {
      const col = ci % COLS;
      const row = Math.floor(ci / COLS);
      const x = col * TILE_PX, y = row * TILE_PX;
      const img = filteredValidImgs[assignment[ci]];
      const rot = assignmentRotation[ci]; // 0=0deg, 1=90deg, 2=180deg, 3=270deg
      if (img && img.complete && img.naturalWidth > 0) {
        // Draw tile with rotation into offscreen canvas
        tileCtx.clearRect(0, 0, TILE_PX, TILE_PX);
        try {
        if (rot === 0) {
          tileCtx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
        } else {
          tileCtx.save();
          tileCtx.translate(TILE_PX / 2, TILE_PX / 2);
          tileCtx.rotate(rot * Math.PI / 2);
          tileCtx.drawImage(img, -TILE_PX / 2, -TILE_PX / 2, TILE_PX, TILE_PX);
          tileCtx.restore();
        }
        } catch (e) {
          // Broken image - fill with target pixel color as fallback
          const fi = (row * COLS + col) * 4;
          tileCtx.fillStyle = `rgb(${targetData[fi]},${targetData[fi+1]},${targetData[fi+2]})`;
          tileCtx.fillRect(0, 0, TILE_PX, TILE_PX);
        }
        // Apply contrast boost from settings (default 1.30)
        const cBoost = savedSettings.contrastBoost ?? 1.30;
        // NOTE: ctx.filter is NOT used here because Mobile Safari (iOS) throws
        // InvalidStateError when ctx.filter is set on a canvas context.
        // Contrast/brightness/saturation are applied manually in the pixel loop below.
        const boostCanvas = document.createElement('canvas');
        boostCanvas.width = TILE_PX; boostCanvas.height = TILE_PX;
        const bCtx = boostCanvas.getContext('2d')!;
        try { bCtx.drawImage(tileOffscreen, 0, 0); } catch { bCtx.drawImage(tileOffscreen, 0, 0, TILE_PX, TILE_PX); }
        // Store original URL for hi-res re-render
        // Note: user-uploaded tiles (from canvas.toDataURL) may not have dataset.originalSrc
        tilesRef.current[ci].url = (img.dataset && img.dataset.originalSrc) ? img.dataset.originalSrc : img.src;
        // -- Professional Luminance-Scale + Moderate AB-Transfer (Reinhard-style) --------
        // Based on best-practice mosaic engine pipeline:
        //   1. Luminance scaling: pixel.L *= (targetL / tileAvgL)   -> clamp 0.6-1.5
        //   2. Moderate AB shift: pixel.A = mix(pixel.A, targetA, AB_BLEND)
        //   3. Max color shift clamp: |delta_A|, |delta_B| <= (MAX_COLOR_SHIFT)
        //
        // L_BLEND = 0.70 (luminance dominates - eye sees structure via brightness)
        // AB_BLEND = 0.25 (gentle color nudge - preserves natural tile colors)
        // MAX_COLOR_SHIFT = 18 (prevents unnatural tinting)
        //
        // histogramBlend slider (0-0.15) scales both: 0.10 = full strength
        // Mosaicer reference: NO overlay by default - tiles match naturally via precise color selection
        // Only apply subtle luminance correction to preserve face structure
        const blendFactor = Math.min(1.0, (savedSettings.histogramBlend ?? 0.0) / 0.10);
        // L_BLEND: minimum 0.40 always active (ensures strong brightness correction for face structure)
        // At histogramBlend=0.07 -> blendFactor=0.7 -> L_BLEND=0.40+0.40*0.7=0.68
        const L_BLEND  = 0.40 + 0.40 * blendFactor;  // 0.40 minimum, up to 0.80 at full blend
        // AB_BLEND: minimum 0.12 (reduced from 0.20 to prevent blue tint accumulation)
        // At histogramBlend=0.07 -> blendFactor=0.7 -> AB_BLEND=0.12+0.20*0.7=0.26
        const AB_BLEND = 0.12 + 0.20 * blendFactor;  // 0.12 minimum, up to 0.32 at full blend
        const MAX_COLOR_SHIFT = 18;            // wider clamp: allows stronger color correction for saturated areas
        // Asymmetric blue clamp: limit blue shifts more aggressively (human eye is sensitive to blue tint)
        const MAX_BLUE_SHIFT = 10;             // tighter clamp for negative b direction (toward blue)
        const [tL, tA, tB] = cellLab[ci];
        // -- Shadow-Boost: in dark areas (tL < 35), stretch contrast to improve visibility --
        // Problem: tiles in shadow zones all look uniformly dark -> face structure lost
        // Solution: in shadow zones, increase L_BLEND and apply local contrast stretch
        // so that subtle luminance differences between tiles become visible again.
        // NOTE: stretchFactor must stay LOW to avoid amplifying bright pixels within tiles
        // (e.g. a tile with white sky at top would create white spots in dark shirt/beard)
        const isShadowZone = tL < 40;  // extended shadow zone threshold (was 35)
        const shadowBoost = isShadowZone ? Math.max(0, (40 - tL) / 40) : 0; // 0-1, strongest at tL=0
        const effectiveL_BLEND = Math.min(0.98, L_BLEND + shadowBoost * 0.50); // stronger boost in shadows (was 0.40)
        const tilePixels = bCtx.getImageData(0, 0, TILE_PX, TILE_PX);
        const td = tilePixels.data;
        // Step 1: Compute tile average L from 8x8 downsample (consistent with print render)
        const REF_SZ = 8;
        const refC = document.createElement('canvas');
        refC.width = REF_SZ; refC.height = REF_SZ;
        const refCx = refC.getContext('2d')!;
        refCx.drawImage(boostCanvas, 0, 0, REF_SZ, REF_SZ);
        const refD = refCx.getImageData(0, 0, REF_SZ, REF_SZ).data;
        let sumL = 0;
        const refPC = refD.length / 4;
        for (let pi = 0; pi < refD.length; pi += 4) {
          sumL += rgbToLab(refD[pi], refD[pi+1], refD[pi+2])[0];
        }
        const avgL = sumL / refPC;
        // Luminance scale factor: how much brighter/darker target is vs tile
        // Wide clamp 0.15-4.0 to allow strong darkening/brightening for portrait visibility
        const rawLumScale = avgL > 1 ? tL / avgL : 1;
        // CRITICAL FIX: In dark target areas (tL < 40), cap lumScale to 1.0
        // This prevents bright tiles from being scaled UP in dark areas (white spots in dark shirt/beard)
        // A tile that is already darker than the target can still be scaled up slightly,
        // but a tile that is brighter than the target must be scaled DOWN (never up)
        const maxLumScale = isShadowZone ? Math.min(1.0, rawLumScale) : rawLumScale;
        const clampedLumScale = Math.max(0.05, Math.min(4.0, maxLumScale));
        const lumScale = 1 + (clampedLumScale - 1) * effectiveL_BLEND;
        // Step 2: Apply per-pixel luminance scale + moderate AB transfer
        // In shadow zones: also apply local contrast stretch to spread the tile's
        // internal luminance range wider (makes tile texture visible in dark areas)
        const outData = new Uint8ClampedArray(td.length);
        for (let pi = 0; pi < td.length; pi += 4) {
          const [pl, pa, pb] = rgbToLab(td[pi], td[pi+1], td[pi+2]);
          // Luminance: scale toward target brightness
          let newL = Math.max(0, Math.min(100, pl * lumScale));
          // Shadow contrast stretch: expand internal contrast around target L
          // This makes tile texture (edges, details) visible even in dark zones
          // REDUCED stretchFactor: was 1.2x (up to 2.2x total) → now 0.4x (up to 1.4x)
          // Reason: high stretch amplifies bright pixels within tiles → white spots in dark shirt/beard
          if (isShadowZone && shadowBoost > 0.05) {
            const deviation = pl - avgL;  // how much this pixel deviates from tile average
            const stretchFactor = 1.0 + shadowBoost * 0.4;  // up to 1.4x stretch (was 2.2x)
            newL = Math.max(0, Math.min(100, (newL + deviation * (stretchFactor - 1.0))));
          }
          // CRITICAL: In dark target areas, cap tile pixel brightness to prevent white spots
          // Even after stretch, no pixel should be much brighter than the target cell
          if (isShadowZone && newL > tL + 25) {
            newL = tL + 25 + (newL - tL - 25) * 0.2; // soft cap: allow max tL+25, compress beyond
          }
          // Color: gentle shift toward target a/b, clamped to MAX_COLOR_SHIFT
          const rawDeltaA = (tA - pa) * AB_BLEND;
          const rawDeltaB = (tB - pb) * AB_BLEND;
          const clampedDeltaA = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, rawDeltaA));
          // Asymmetric b clamp: tighter limit for blue direction (rawDeltaB < 0 = toward blue)
          const clampedDeltaB = rawDeltaB < 0
            ? Math.max(-MAX_BLUE_SHIFT, rawDeltaB)   // blue direction: max -10
            : Math.min(MAX_COLOR_SHIFT, rawDeltaB);   // warm direction: max +18
          const newA = Math.max(-128, Math.min(127, pa + clampedDeltaA));
          const newB = Math.max(-128, Math.min(127, pb + clampedDeltaB));
          // Apply contrast boost manually (replaces ctx.filter which breaks on iOS Safari)
          // Contrast: scale L around midpoint 50 by cBoost factor
          const contrastL = Math.max(0, Math.min(100, 50 + (newL - 50) * cBoost));
          // Saturation boost: scale a/b chroma by cBoost
          const satBoost = 0.90 + cBoost * 0.15; // matches old saturate() CSS filter
          const boostedA = Math.max(-128, Math.min(127, newA * satBoost));
          // Reduce saturation boost for blue (negative b) to prevent blue tint amplification
          const bSatBoost = newB < 0 ? Math.min(satBoost, 1.0) : satBoost;
          const boostedB = Math.max(-128, Math.min(127, newB * bSatBoost));
          const [nr, ng, nb] = labToRgb(contrastL, boostedA, boostedB);
          outData[pi]   = nr;
          outData[pi+1] = ng;
          outData[pi+2] = nb;
          outData[pi+3] = td[pi+3];
        }
        const transferredCanvas = document.createElement('canvas');
        transferredCanvas.width = TILE_PX; transferredCanvas.height = TILE_PX;
        const tCtxOut = transferredCanvas.getContext('2d')!;
        const outImageData = tCtxOut.createImageData(TILE_PX, TILE_PX);
        outImageData.data.set(outData);
        tCtxOut.putImageData(outImageData, 0, 0);
        try {
          ctx.drawImage(transferredCanvas, x, y, TILE_PX, TILE_PX);
        } catch (e) {
          // Fallback: fill with target pixel color
          const fi = (row * COLS + col) * 4;
          ctx.fillStyle = `rgb(${targetData[fi]},${targetData[fi+1]},${targetData[fi+2]})`;
          ctx.fillRect(x, y, TILE_PX, TILE_PX);
        }
      } else {
        const i = (row * COLS + col) * 4;
        ctx.fillStyle = `rgb(${targetData[i]},${targetData[i+1]},${targetData[i+2]})`;
        ctx.fillRect(x, y, TILE_PX, TILE_PX);
      }
      if (ci % RENDER_BATCH === 0) {
        setProgress(62 + Math.round((ci / TOTAL_TILES) * 30));
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Step 6: Adaptive Edge-based Overlay (configurable mode)
    setProgressMsg("Finalisiere...");
    setProgress(93);

    const BASE_OVERLAY = savedSettings.baseOverlay ?? 0.15;
    const EDGE_BOOST = savedSettings.edgeBoost ?? 0.20;
    const OVERLAY_MODE = savedSettings.overlayMode ?? 'softlight';

    if (OVERLAY_MODE !== 'none') {
      // Apply overlay (soft-light or alpha-blend)
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = CANVAS_W; overlayCanvas.height = CANVAS_H;
      const olCtx = overlayCanvas.getContext('2d')!;
      olCtx.drawImage(canvas, 0, 0);
      const mosaicData = olCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      const md = mosaicData.data;
      for (let row = 0; row < (ROWS); row++) {
        for (let col = 0; col < (COLS); col++) {
          const ci = row * COLS + col;
          const i = (row * COLS + col) * 4;
          const tr = targetData[i], tg = targetData[i+1], tb = targetData[i+2];
          const edge = edgeMap[ci];
          // Adaptive strength: BASE_OVERLAY at flat areas, +EDGE_BOOST at edges
          // In face regions: small boost for portrait visibility (reduced to avoid brownish patches)
          const faceBoost = faceMask[ci] ? 0.04 : 0;  // reduced: 0.25→0.04
          const strength = Math.min(0.30, BASE_OVERLAY + edge * EDGE_BOOST + faceBoost);  // cap 0.85→0.30
          for (let py = row * TILE_PX; py < (row + 1) * TILE_PX && py < (CANVAS_H); py++) {
            for (let px = col * TILE_PX; px < (col + 1) * TILE_PX && px < (CANVAS_W); px++) {
              const pi = (py * CANVAS_W + px) * 4;
              if (OVERLAY_MODE === 'softlight') {
                // -- Soft-Light Blending (Photoshop formula) --
                const softLight = (base: number, blend: number) => {
                  const b = blend / 255, s = base / 255;
                  const result = b < 0.5
                    ? s - (1 - 2*b) * s * (1 - s)
                    : s + (2*b - 1) * (Math.sqrt(s) - s);
                  return Math.round(result * 255);
                };
                md[pi]   = Math.round(md[pi]   * (1 - strength) + softLight(md[pi],   tr) * strength);
                md[pi+1] = Math.round(md[pi+1] * (1 - strength) + softLight(md[pi+1], tg) * strength);
                md[pi+2] = Math.round(md[pi+2] * (1 - strength) + softLight(md[pi+2], tb) * strength);
              } else {
                // -- Alpha Blend (simpler, more direct color shift) --
                md[pi]   = Math.round(md[pi]   * (1 - strength) + tr * strength);
                md[pi+1] = Math.round(md[pi+1] * (1 - strength) + tg * strength);
                md[pi+2] = Math.round(md[pi+2] * (1 - strength) + tb * strength);
              }
            }
          }
        }
      }
      olCtx.putImageData(mosaicData, 0, 0);
      ctx.drawImage(overlayCanvas, 0, 0);
    }
    // overlayMode === 'none': skip overlay entirely - pure tile rendering

    // Vignette
    const vigGrad = ctx.createRadialGradient(
      CANVAS_W / 2, CANVAS_H / 2, Math.min(CANVAS_W, CANVAS_H) * 0.35,
      CANVAS_W / 2, CANVAS_H / 2, Math.max(CANVAS_W, CANVAS_H) * 0.72,
    );
    vigGrad.addColorStop(0, "rgba(0,0,0,0)");
    vigGrad.addColorStop(1, "rgba(0,0,0,0.15)");
    ctx.save();
    ctx.fillStyle = vigGrad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
    // -- Blur-Overlay: soften harsh tile grid edges for smoother mosaic look --
    // Draw a 1px-blurred copy of the mosaic at configurable opacity on top.
    // This blends hard pixel-grid lines without making tiles themselves blurry.
    // Only in pure tile mode (overlayMode='none') to avoid double-blending.
    // blurOpacity: 0 = off, 0.08 = 8% (default, subtle), 0.20-0.30 = visibly softer
    const BLUR_OPACITY = savedSettings.blurOpacity ?? 0.08;
    if ((savedSettings.overlayMode ?? 'none') === 'none' && BLUR_OPACITY > 0) {
      try {
        const blurCanvas = document.createElement('canvas');
        blurCanvas.width = CANVAS_W; blurCanvas.height = CANVAS_H;
        const blurCtx = blurCanvas.getContext('2d')!;
        blurCtx.filter = 'blur(1px)';
        blurCtx.drawImage(canvas, 0, 0);
        blurCtx.filter = 'none';
        ctx.globalAlpha = BLUR_OPACITY;
        ctx.drawImage(blurCanvas, 0, 0);
        ctx.globalAlpha = 1.0;
      } catch { /* ignore if canvas is tainted */ }
    }
    // -- Eye/Mouth Sharpening Pass (Portrait only) --------------------------------
    // Problem: even with fine tiles (6px), eyes/mouth have limited tile resolution.
    // Solution: draw the original image at moderate opacity ONLY over eye/mouth regions.
    // This adds structural sharpness (contours, shadows) while keeping the mosaic look.
    // Strength: 0.28 = visible but tiles still clearly recognizable underneath.
    // Only active when MediaPipe detected subregions (eye/mouth cells exist).
    const isPortraitMode = savedSettings.portraitMode === true;
    const hasEyeRegions = subRegionMask.some(r => r === 'eye' || r === 'mouth');
    if (isPortraitMode && hasEyeRegions && OVERLAY_MODE !== 'none') {
      // Draw original image scaled to canvas size
      const sharpCanvas = document.createElement('canvas');
      sharpCanvas.width = CANVAS_W; sharpCanvas.height = CANVAS_H;
      const sharpCtx = sharpCanvas.getContext('2d')!;
      sharpCtx.drawImage(targetImg, 0, 0, CANVAS_W, CANVAS_H);
      const sharpData = sharpCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      const sd = sharpData.data;
      // Get current mosaic pixels
      const mosaicSnap = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      const ms = mosaicSnap.data;
      // Blend original over eye/mouth cells at high opacity
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const ci = row * COLS + col;
          const subR = subRegionMask[ci];
          // Eye: 0.32 opacity (strongest - eyes are most critical)
          // Mouth: 0.28 opacity
          // Nose: 0.18 opacity (subtle)
          const sharpStrength = subR === 'eye' ? 0.32 : subR === 'mouth' ? 0.28 : subR === 'nose' ? 0.18 : 0;
          if (sharpStrength === 0) continue;
          for (let py = row * TILE_PX; py < (row + 1) * TILE_PX && py < CANVAS_H; py++) {
            for (let px = col * TILE_PX; px < (col + 1) * TILE_PX && px < CANVAS_W; px++) {
              const pi = (py * CANVAS_W + px) * 4;
              ms[pi]   = Math.round(ms[pi]   * (1 - sharpStrength) + sd[pi]   * sharpStrength);
              ms[pi+1] = Math.round(ms[pi+1] * (1 - sharpStrength) + sd[pi+1] * sharpStrength);
              ms[pi+2] = Math.round(ms[pi+2] * (1 - sharpStrength) + sd[pi+2] * sharpStrength);
            }
          }
        }
      }
      ctx.putImageData(mosaicSnap, 0, 0);
    }
    snapshotRef.current = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);

    // Auto-zoom
    const containerW = canvas.parentElement?.clientWidth ?? 700;
    const containerH = window.innerHeight * 0.65;
    const displayW = CANVAS_W * DISPLAY_SCALE;
    const displayH = CANVAS_H * DISPLAY_SCALE;
    const fitZoom = Math.min(containerW / displayW, containerH / displayH) * 0.92;
    setZoom(Math.min(Math.max(fitZoom, 0.3), 1.5));
    setPan({ x: 0, y: 0 });

    setProgress(100);
    setProgressMsg("Fertig!");

    // Smart defaults: set overlay & color enhance based on image type and tile source
    // Portrait: overlay helps recognizability, moderate color enhance for skin tones
    // Landscape: less overlay needed, light color enhance
    // Own tiles: higher overlay since user photos may not match colors perfectly
    const imgType = detectedImageTypeRef.current;
    const tileMode = tileSourceModeRef.current;
    const hasUserTiles = tileMode === 'own' || tileMode === 'mix';
    const defaultOverlay = imgType === 'portrait' ? (hasUserTiles ? 30 : 25)
                         : imgType === 'landscape' ? (hasUserTiles ? 20 : 10)
                         : (hasUserTiles ? 20 : 10);
    const defaultColorEnhance = imgType === 'portrait' ? 12
                              : imgType === 'landscape' ? 10
                              : 8;
    setUserOverlay(defaultOverlay);
    setColorEnhance(defaultColorEnhance);
    colorEnhanceRef.current = defaultColorEnhance;

    setReady(true);
    setLoading(false);
    setShowOrderPanel(true);
  }, []);

  // Pop-Out effect: tiles zoom out of the mosaic one by one
  // The normal canvas stays visible. High-res tile overlays animate above it.
  useEffect(() => {
    if (!popOutMode || !ready) {
      if (popOutWaveTlRef.current) { popOutWaveTlRef.current.kill(); popOutWaveTlRef.current = null; }
      const popContainer = popOutContainerRef.current;
      if (popContainer) popContainer.innerHTML = '';
      return;
    }

    const params = mosaicParamsRef.current;
    const popContainer = popOutContainerRef.current;
    const canvas = canvasRef.current;
    if (!params || !popContainer || !canvas) return;
    const { cols, rows, tilePx } = params;
    const displayScale = (params as any)._displayScale || 1;
    const cssTileW = tilePx * displayScale;
    const cssTileH = tilePx * displayScale;
    const validImgs = validImgsRef.current;
    const assignment = assignmentRef.current;
    const rotations = assignmentRotRef.current;
    const totalCells = cols * rows;

    // Desired zoomed-in size: ~150px (4cm on screen)
    const targetZoomedPx = 150;
    const popScale = Math.max(3, targetZoomedPx / cssTileW);

    // Hi-res canvas resolution: must be large enough to look sharp at ~150px CSS display
    // Use 512px for all devices so the zoomed tile is crisp even on retina screens
    // 15 tiles × 512×512×4 bytes = 15 MB → unbedenklich auch auf Mobile
    // iPhone 3× DPR: 512px auf ~150px CSS = 3.4× → Retina-scharf
    const canvasResPx = 512;

    // Create snapshot fallback canvas
    const snapshot = snapshotRef.current;
    let srcCanvas: HTMLCanvasElement | null = null;
    if (snapshot) {
      srcCanvas = document.createElement('canvas');
      srcCanvas.width = snapshot.width;
      srcCanvas.height = snapshot.height;
      srcCanvas.getContext('2d')!.putImageData(snapshot, 0, 0);
    }

    // Build a pool of tile indices (shuffle for randomness)
    const indices = Array.from({ length: totalCells }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    popContainer.innerHTML = '';

    // Create one hi-res canvas overlay per animated tile, positioned exactly over its spot
    const isMob = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    const numTiles = Math.min(isMob ? 15 : 30, totalCells); // fewer tiles on mobile to save memory
    const tileEls: HTMLCanvasElement[] = [];

    for (let t = 0; t < numTiles; t++) {
      const ci = indices[t];
      const col = ci % cols;
      const row = Math.floor(ci / cols);

      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = canvasResPx;
      tileCanvas.height = canvasResPx;
      const tCtx = tileCanvas.getContext('2d')!;
      tCtx.imageSmoothingEnabled = true;
      tCtx.imageSmoothingQuality = 'high';

      // Draw from best available tile image: originals > hi-res > thumbnail > snapshot
      let drawn = false;
      if (assignment && validImgs) {
        const tileIdx = assignment[ci];
        // Priority chain: user originals (full-res) > hi-res > thumbnail
        const userOriginals = userTileOriginalRef.current;
        const hiResImgs = validImgsHiResRef.current;
        const origImg = userOriginals?.[tileIdx >= 0 ? -1 : -(tileIdx + 1)]; // user tiles have negative IDs
        const hiImg = hiResImgs?.[tileIdx];
        const bestImg = (origImg && origImg.complete && origImg.naturalWidth > 0) ? origImg
          : (hiImg && hiImg.complete && hiImg.naturalWidth > 0) ? hiImg
          : validImgs[tileIdx];
        if (bestImg && bestImg.complete && bestImg.naturalWidth > 0) {
          try {
            const rot = rotations?.[ci] || 0;
            if (rot === 0) {
              tCtx.drawImage(bestImg, 0, 0, canvasResPx, canvasResPx);
            } else {
              tCtx.save();
              tCtx.translate(canvasResPx / 2, canvasResPx / 2);
              tCtx.rotate(rot * Math.PI / 2);
              tCtx.drawImage(bestImg, -canvasResPx / 2, -canvasResPx / 2, canvasResPx, canvasResPx);
              tCtx.restore();
            }
            drawn = true;
          } catch { /* fallback */ }
        }
      }
      if (!drawn && srcCanvas) {
        tCtx.drawImage(srcCanvas, col * tilePx, row * tilePx, tilePx, tilePx, 0, 0, canvasResPx, canvasResPx);
      }

      // Position exactly over the tile's spot in the mosaic
      const left = col * cssTileW;
      const top = row * cssTileH;
      tileCanvas.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${cssTileW}px;height:${cssTileH}px;transform-origin:center center;will-change:transform;opacity:0;z-index:10;pointer-events:none;`;
      popContainer.appendChild(tileCanvas);
      tileEls.push(tileCanvas);
    }

    // GSAP animation: tiles pop out one by one
    if (popOutWaveTlRef.current) { popOutWaveTlRef.current.kill(); }
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.0 });

    tileEls.forEach((tile, i) => {
      const delay = i * 3.0; // 3s between each tile start
      // Appear + zoom out towards viewer (3s)
      tl.fromTo(tile, {
        opacity: 0, scale: 1,
        boxShadow: 'none',
      }, {
        opacity: 1, scale: popScale,
        boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
        duration: 3.0,
        ease: 'power2.out',
      }, delay);
      // Hold visible (1s), then shrink back + fade (2s)
      tl.to(tile, {
        scale: 1, opacity: 0,
        boxShadow: 'none',
        duration: 2.0,
        ease: 'power2.inOut',
      }, delay + 4.0);
    });

    popOutWaveTlRef.current = tl;
  }, [popOutMode, ready]);

  // Auto-start Hi-Res rendering in background once mosaic is ready
  // Always use client-side render (images already loaded, no download failures)
  // MOBILE: Skip auto-trigger to prevent canvas memory eviction (mosaic disappears).
  // On mobile, hi-res render is only triggered when user actively zooms > 1.5x.
  useEffect(() => {
    if (!ready) return;
    if (hiResReadyRef.current || hiResLoadingRef.current) return;
    const isMob = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    if (isMob) return; // mobile: only render hi-res on zoom (saves memory, prevents canvas eviction)
    // Short delay so UI renders first, then verify ready is still true
    // (a second renderMosaic call could have reset ready=false in the meantime)
    const timer = setTimeout(() => {
      if (!readyRef.current) return; // mosaic was re-rendered, skip stale hi-res
      if (hiResReadyRef.current || hiResLoadingRef.current) return;
      triggerClientHiResRender();
    }, 1500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.85 : 1.18;
    const currentZ = zoomRef.current;
    const newZ = Math.min(8, Math.max(0.2, currentZ * factor));

    // Always use client-side hi-res render for zoom preview (fast, no downloads needed).
    // Server render is reserved for actual print downloads to avoid gray tiles from failed URL fetches.
    if (newZ > 1.5 && !hiResReadyRef.current && !hiResLoadingRef.current) {
      triggerClientHiResRender();
    }

    setZoom(newZ);
  }, [triggerClientHiResRender]);
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true; lastMouse.current = { x: e.clientX, y: e.clientY };
    clickStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
  }, []);
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastMouse.current.x, dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    isDragging.current = false;
    // Detect click (vs drag): small movement + short duration
    const start = clickStartRef.current;
    if (!start || !ready || !mosaicParamsRef.current || !assignmentRef.current.length) return;
    const dist = Math.sqrt((e.clientX - start.x) ** 2 + (e.clientY - start.y) ** 2);
    const duration = Date.now() - start.time;
    if (dist > 5 || duration > 300) return; // was a drag, not a click

    // Calculate which tile was clicked
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const { cols, rows, tilePx, canvasW, canvasH } = mosaicParamsRef.current;
    const displayScale = (mosaicParamsRef.current as any)._displayScale ?? 0.5;
    const displayW = canvasW * displayScale;
    const displayH = canvasH * displayScale;

    // Center of container
    const cx = rect.width / 2 + pan.x;
    const cy = rect.height / 2 + pan.y;
    // Mouse position relative to canvas origin (accounting for zoom + pan)
    const mouseX = (e.clientX - rect.left - cx) / zoom + displayW / 2;
    const mouseY = (e.clientY - rect.top - cy) / zoom + displayH / 2;
    // Convert display coords to canvas coords
    const canvasX = mouseX / displayScale;
    const canvasY = mouseY / displayScale;
    const col = Math.floor(canvasX / tilePx);
    const row = Math.floor(canvasY / tilePx);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;

    const ci = row * cols + col;
    const tileIdx = assignmentRef.current[ci];
    if (tileIdx < 0) return;

    // Get tile URL – try multiple sources for best quality
    let tileUrl = '';
    const tileId = tileIdsRef.current[tileIdx];
    if (tileId && tileId > 0) {
      // DB tile – load from server at high resolution (400px = 1cm @ 400 PPI, scharf im Detail-Modal)
      tileUrl = `/api/tile/${tileId}?size=400`;
    } else {
      // User-uploaded tile (negative ID) – use hi-res version if available
      const hiRes = validImgsHiResRef.current[tileIdx];
      if (hiRes && hiRes.src && hiRes.complete && hiRes.naturalWidth > 0) {
        tileUrl = hiRes.src;
      } else if (validImgsRef.current[tileIdx]?.src) {
        tileUrl = validImgsRef.current[tileIdx].src;
      }
    }
    // Fallback: extract tile region from rendered canvas as data URL
    if (!tileUrl) {
      try {
        const snap = snapshotRef.current;
        if (snap) {
          const extractCanvas = document.createElement('canvas');
          extractCanvas.width = tilePx; extractCanvas.height = tilePx;
          const exCtx = extractCanvas.getContext('2d')!;
          const srcX = col * tilePx, srcY = row * tilePx;
          // Extract tile region from snapshot ImageData
          const tileData = exCtx.createImageData(tilePx, tilePx);
          for (let py = 0; py < tilePx; py++) {
            for (let px = 0; px < tilePx; px++) {
              const si = ((srcY + py) * snap.width + (srcX + px)) * 4;
              const di = (py * tilePx + px) * 4;
              tileData.data[di] = snap.data[si];
              tileData.data[di+1] = snap.data[si+1];
              tileData.data[di+2] = snap.data[si+2];
              tileData.data[di+3] = 255;
            }
          }
          exCtx.putImageData(tileData, 0, 0);
          tileUrl = extractCanvas.toDataURL('image/jpeg', 0.9);
        }
      } catch { /* ignore */ }
    }

    // Get cell target color from snapshot
    let cellColor = '#888';
    if (snapshotRef.current) {
      const px = col * tilePx + Math.floor(tilePx / 2);
      const py = row * tilePx + Math.floor(tilePx / 2);
      const pi = (py * canvasW + px) * 4;
      const d = snapshotRef.current.data;
      if (pi + 2 < d.length) {
        cellColor = `rgb(${d[pi]}, ${d[pi + 1]}, ${d[pi + 2]})`;
      }
    }

    setTileDetail({ col, row, tileIdx, tileUrl, cellColor });
  }, [ready, zoom, pan]);

  // Fetch existing projects for the overwrite option
  const fetchExistingProjects = useCallback(async () => {
    if (!user) return;
    setLoadingExistingProjects(true);
    try {
      const res = await fetch('/api/projects', { headers: authHeaders() });
      const data = await res.json();
      if (data.ok) setExistingProjects(data.projects);
    } catch { /* ignore */ }
    finally { setLoadingExistingProjects(false); }
  }, [user, authHeaders]);

  // Project save handler — saves to server if logged in, otherwise localStorage
  const saveProject = useCallback(async (projectName?: string, overwriteId?: number) => {
    setSavingProject(true);
    try {
      const name = projectName?.trim() || 'Mein Mosaik';
      const data: Record<string, unknown> = {
        version: 1,
        savedAt: new Date().toISOString(),
        userPhoto,
        assignment: assignmentRef.current,
        tileIds: tileIdsRef.current,
        mosaicParams: mosaicParamsRef.current,
        qualityMetrics,
        selectedFormat,
        selectedMaterial,
        selectedTheme,
        tileSourceMode,
      };
      // Save mosaic canvas as data URL
      let thumbnailUrl: string | undefined;
      if (canvasRef.current) {
        data.mosaicImage = canvasRef.current.toDataURL('image/jpeg', 0.7);
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 300;
        thumbCanvas.height = Math.round(300 * (canvasRef.current.height / canvasRef.current.width));
        const thumbCtx = thumbCanvas.getContext('2d');
        if (thumbCtx) {
          thumbCtx.drawImage(canvasRef.current, 0, 0, thumbCanvas.width, thumbCanvas.height);
          thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.6);
        }
      }

      const userTilesPayload = (tileSourceMode === 'own' || tileSourceMode === 'mix') && userTileHiResRef.current.length > 0
        ? userTileHiResRef.current.map(img => img?.src || null).filter(Boolean)
        : null;

      // Save to server if logged in
      if (user) {
        let res: Response;
        if (overwriteId) {
          // Overwrite existing project
          res = await fetch(`/api/projects/${overwriteId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name, data, thumbnailUrl, tileSourceMode, userTiles: userTilesPayload }),
          });
        } else {
          // Create new project
          res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name, data, thumbnailUrl, tileSourceMode, projectType: 'mosaic', userTiles: userTilesPayload }),
          });
        }
        const result = await res.json();
        if (result.ok) {
          if (result.project?.id) savedProjectIdRef.current = result.project.id;
          setHasSavedProject(true);
          setShowSaveModal(false);
        } else {
          console.warn('[Project Save] Server error:', result.error);
          localStorage.setItem('mosaicprint_saved_project', JSON.stringify(data));
          setHasSavedProject(true);
          setShowSaveModal(false);
        }
      } else {
        localStorage.setItem('mosaicprint_saved_project', JSON.stringify(data));
        setHasSavedProject(true);
        setShowSaveModal(false);
      }
    } catch (e) {
      console.warn('[Project Save] Failed:', e);
    } finally {
      setSavingProject(false);
    }
  }, [userPhoto, qualityMetrics, selectedFormat, selectedMaterial, selectedTheme, tileSourceMode, user, authHeaders]);

  // Project restore handler
  const restoreProject = useCallback(() => {
    try {
      const raw = localStorage.getItem('mosaicprint_saved_project');
      if (!raw) return;
      const data = JSON.parse(raw);

      if (data.userPhoto) setUserPhoto(data.userPhoto);
      if (data.selectedFormat !== undefined) setSelectedFormat(data.selectedFormat);
      if (data.selectedMaterial !== undefined) setSelectedMaterial(data.selectedMaterial);
      if (data.selectedTheme) { setSelectedTheme(data.selectedTheme); selectedThemeRef.current = data.selectedTheme; }
      if (data.tileSourceMode) { setTileSourceMode(data.tileSourceMode); tileSourceModeRef.current = data.tileSourceMode; }
      if (data.qualityMetrics) setQualityMetrics(data.qualityMetrics);
      if (data.assignment) assignmentRef.current = data.assignment;
      if (data.tileIds) tileIdsRef.current = data.tileIds;
      if (data.mosaicParams) mosaicParamsRef.current = data.mosaicParams;

      // Restore mosaic image to canvas
      if (data.mosaicImage && data.mosaicParams) {
        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const { canvasW, canvasH } = data.mosaicParams;
          canvas.width = canvasW;
          canvas.height = canvasH;
          const displayScale = (data.mosaicParams as any)._displayScale ?? 0.5;
          canvas.style.width = `${Math.round(canvasW * displayScale)}px`;
          canvas.style.height = `${Math.round(canvasH * displayScale)}px`;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, canvasW, canvasH);
            snapshotRef.current = ctx.getImageData(0, 0, canvasW, canvasH);
          }
          setReady(true);
          setShowOrderPanel(true);
          // Auto-zoom
          const containerW = canvas.parentElement?.clientWidth ?? 700;
          const containerH = window.innerHeight * 0.65;
          const displayW2 = canvasW * displayScale;
          const displayH2 = canvasH * displayScale;
          const fitZoom = Math.min(containerW / displayW2, containerH / displayH2) * 0.92;
          setZoom(Math.min(Math.max(fitZoom, 0.3), 1.5));
          setPan({ x: 0, y: 0 });
        };
        img.src = data.mosaicImage;
      }

      // Restore user photo as image element (skip auto-render: project already has rendered image)
      if (data.userPhoto) {
        skipAutoRenderRef.current = true;
        const uImg = new Image();
        uImg.onload = () => setUserPhotoImg(uImg);
        uImg.src = data.userPhoto;
      }

      setShowRestoreBanner(false);
    } catch (e) {
      console.warn('[Project Restore] Failed:', e);
    }
  }, []);

  const clearSavedProject = useCallback(() => {
    try { localStorage.removeItem('mosaicprint_saved_project'); } catch {}
    setHasSavedProject(false);
    setShowRestoreBanner(false);
  }, []);

  // Load project from server if ?project=ID in URL
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectLoadMsg, setProjectLoadMsg] = useState('');
  useEffect(() => {
    const projectId = searchParams.get('project');
    console.log(`[ProjectLoad] Effect fired: projectId=${projectId}, user=${user?.email ?? 'null'}`);
    if (!projectId || !user) return;
    if (projectId) savedProjectIdRef.current = parseInt(projectId, 10);
    (async () => {
      try {
        setProjectLoading(true);
        setProjectLoadMsg('Projektdaten laden...');
        console.log(`[ProjectLoad] Fetching project ${projectId}...`);

        const res = await fetch(`/api/projects/${projectId}`, { headers: authHeaders() });
        const result = await res.json();
        console.log(`[ProjectLoad] Response: ok=${result.ok}, hasData=${!!result.project?.data}, status=${res.status}`);
        if (result.ok && result.project?.data) {
          const data = typeof result.project.data === 'string' ? JSON.parse(result.project.data) : result.project.data;
          console.log(`[ProjectLoad] Data keys: ${Object.keys(data).join(', ')}, hasMosaicImage=${!!data.mosaicImage}, hasUserPhoto=${!!data.userPhoto}, tiles=${result.project.user_tiles?.length ?? 0}`);
          if (data.userPhoto) setUserPhoto(data.userPhoto);
          if (data.selectedFormat !== undefined) setSelectedFormat(data.selectedFormat);
          if (data.selectedMaterial !== undefined) setSelectedMaterial(data.selectedMaterial);
          if (data.selectedTheme) { setSelectedTheme(data.selectedTheme); selectedThemeRef.current = data.selectedTheme; }
          if (data.tileSourceMode) { setTileSourceMode(data.tileSourceMode); tileSourceModeRef.current = data.tileSourceMode; }
          if (data.qualityMetrics) setQualityMetrics(data.qualityMetrics);
          if (data.assignment) assignmentRef.current = data.assignment;
          if (data.tileIds) tileIdsRef.current = data.tileIds;
          if (data.mosaicParams) mosaicParamsRef.current = data.mosaicParams;

          // Restore user tiles from project if available
          const savedTiles = result.project.user_tiles;
          if (savedTiles && Array.isArray(savedTiles) && savedTiles.length > 0) {
            setProjectLoadMsg('Fotos werden geladen...');
            const parsedTiles = typeof savedTiles === 'string' ? JSON.parse(savedTiles) : savedTiles;
            const totalTiles = (parsedTiles as string[]).length;
            let loadedCount = 0;
            const hiResImgs: HTMLImageElement[] = [];
            const thumbImgs: HTMLImageElement[] = [];
            await Promise.all((parsedTiles as string[]).map((src: string) => new Promise<void>(resolve => {
              const hiImg = new Image();
              hiImg.onload = () => {
                hiResImgs.push(hiImg);
                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = 64; thumbCanvas.height = 64;
                const tCtx = thumbCanvas.getContext('2d')!;
                tCtx.drawImage(hiImg, 0, 0, 64, 64);
                const thumbImg = new Image();
                thumbImg.onload = () => {
                  thumbImgs.push(thumbImg);
                  loadedCount++;
                  setProjectLoadMsg(`Fotos laden: ${loadedCount}/${totalTiles}`);
                  resolve();
                };
                thumbImg.onerror = () => { loadedCount++; resolve(); };
                thumbImg.src = thumbCanvas.toDataURL('image/jpeg', 0.85);
              };
              hiImg.onerror = () => { loadedCount++; resolve(); };
              hiImg.src = src;
            })));
            if (thumbImgs.length > 0) {
              setUserTileImages(thumbImgs);
              userTileImagesRef.current = thumbImgs;
              userTileHiResRef.current = hiResImgs;
              // Rebuild validImgsRef so triggerClientHiResRender can work (HD-Button).
              // Mirror what renderMosaic does for tileMode='own': expand to >=200 entries.
              const expandedThumbs: HTMLImageElement[] = [...thumbImgs];
              const expandedHiRes: (HTMLImageElement | null)[] = [...hiResImgs];
              const expandedIds: number[] = thumbImgs.map((_, i) => -(i + 1));
              while (expandedThumbs.length < 200 && thumbImgs.length > 0) {
                expandedThumbs.push(...thumbImgs);
                expandedHiRes.push(...hiResImgs);
                expandedIds.push(...thumbImgs.map((_, i) => -(i + 1)));
              }
              validImgsRef.current = expandedThumbs;
              validImgsHiResRef.current = expandedHiRes;
              // Only overwrite tileIds if not already restored from saved data
              if (!data.tileIds) tileIdsRef.current = expandedIds;
              console.log(`[ProjectLoad] validImgsRef rebuilt: ${expandedThumbs.length} entries from ${thumbImgs.length} user tiles`);
            }
          }

          setProjectLoadMsg('Mosaik wird angezeigt...');

          console.log(`[ProjectLoad] mosaicImage=${data.mosaicImage ? data.mosaicImage.substring(0, 50) + '...' : 'null'}, mosaicParams=${JSON.stringify(data.mosaicParams)}`);
          if (data.mosaicImage && data.mosaicParams) {
            await new Promise<void>((resolve) => {
              const img = new Image();
              img.onload = () => {
                console.log(`[ProjectLoad] Mosaic image loaded: ${img.naturalWidth}x${img.naturalHeight}`);
                const canvas = canvasRef.current;
                if (!canvas) { console.warn('[ProjectLoad] Canvas ref is null!'); resolve(); return; }
                const { canvasW, canvasH } = data.mosaicParams;
                canvas.width = canvasW;
                canvas.height = canvasH;
                const displayScale = data.mosaicParams._displayScale ?? 0.5;
                canvas.style.width = `${Math.round(canvasW * displayScale)}px`;
                canvas.style.height = `${Math.round(canvasH * displayScale)}px`;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(img, 0, 0, canvasW, canvasH);
                  snapshotRef.current = ctx.getImageData(0, 0, canvasW, canvasH);
                }
                setReady(true);
                setShowOrderPanel(true);
                // Auto-zoom to fit
                const containerW = canvas.parentElement?.clientWidth ?? 700;
                const containerH = window.innerHeight * 0.65;
                const displayW2 = canvasW * displayScale;
                const displayH2 = canvasH * displayScale;
                const fitZoom = Math.min(containerW / displayW2, containerH / displayH2) * 0.92;
                setZoom(Math.min(Math.max(fitZoom, 0.3), 1.5));
                setPan({ x: 0, y: 0 });
                resolve();
              };
              img.onerror = (e) => { console.error('[ProjectLoad] Mosaic image FAILED to load:', e); resolve(); };
              img.src = data.mosaicImage;
            });
          }
          // Restore color enhance overlay from target colors
          // Rebuild the colorEnhanceUrl from the saved mosaicImage target pixels
          if (data.mosaicParams && data.userPhoto) {
            try {
              const { cols, rows } = data.mosaicParams;
              // Extract target colors from the user photo at mosaic resolution
              const targetImg = new Image();
              await new Promise<void>((resolve) => {
                targetImg.onload = () => {
                  const offCanvas = document.createElement('canvas');
                  offCanvas.width = cols;
                  offCanvas.height = rows;
                  const offCtx = offCanvas.getContext('2d')!;
                  offCtx.drawImage(targetImg, 0, 0, cols, rows);
                  const targetData = offCtx.getImageData(0, 0, cols, rows).data;
                  // Store targetColors for server-side overlay
                  const targetColorsFlat: number[] = new Array(cols * rows * 3);
                  for (let ci = 0; ci < cols * rows; ci++) {
                    const i = ci * 4;
                    targetColorsFlat[ci * 3] = targetData[i];
                    targetColorsFlat[ci * 3 + 1] = targetData[i + 1];
                    targetColorsFlat[ci * 3 + 2] = targetData[i + 2];
                  }
                  targetColorsRef.current = targetColorsFlat;
                  // Build colorEnhance overlay image
                  const ceCanvas = document.createElement('canvas');
                  ceCanvas.width = cols;
                  ceCanvas.height = rows;
                  const ceCtx = ceCanvas.getContext('2d')!;
                  ceCtx.putImageData(offCtx.getImageData(0, 0, cols, rows), 0, 0);
                  setColorEnhanceUrl(ceCanvas.toDataURL('image/png'));
                  // Don't auto-enable colorEnhance for loaded projects
                  // User can adjust the slider manually if desired
                  resolve();
                };
                targetImg.onerror = () => resolve();
                targetImg.src = data.userPhoto;
              });
            } catch (e) {
              console.warn('[ProjectLoad] Failed to restore color enhance:', e);
            }
          }

          // Restore user photo (skip auto-render: project already has rendered image)
          if (data.userPhoto) {
            skipAutoRenderRef.current = true;
            const uImg = new Image();
            uImg.onload = () => setUserPhotoImg(uImg);
            uImg.src = data.userPhoto;
          }
        }
      } catch (e) {
        console.warn('[Project Load] Failed:', e);
      } finally {
        setProjectLoading(false);
        setProjectLoadMsg('');
      }
    })();
  }, [searchParams, user, authHeaders]);

  // Print Export: high-quality render with 128px tiles
  // Two modes:
  // - Preview (paid=false): uses existing canvas, adds watermark
  // - Print (paid=true): re-renders with 128px tiles at target DPI resolution
  const handleDownload = useCallback(async (paid = false) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const fmt = PRINT_FORMATS[selectedFormat];

    // FIX: preserve mosaic aspect ratio instead of forcing square format
    // The mosaic canvas has the correct proportions (cols x tilePx : rows x tilePx)
    // We scale to fit within fmt dimensions while keeping the aspect ratio.
    const mosaicAspect = canvas.width / canvas.height;
    const fmtAspect = fmt.pxW / fmt.pxH;
    let outW: number, outH: number;
    if (mosaicAspect > fmtAspect) {
      // Wider than format: fit width, reduce height
      outW = fmt.pxW;
      outH = Math.round(fmt.pxW / mosaicAspect);
    } else {
      // Taller than format: fit height, reduce width
      outH = fmt.pxH;
      outW = Math.round(fmt.pxH * mosaicAspect);
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext("2d")!;

    if (paid && assignmentRef.current.length && tileIdsRef.current.length && mosaicParamsRef.current) {
      const { cols, rows } = mosaicParamsRef.current;
      const PX_PER_CM = 400 / 2.54; // = 157.48 px/cm at 400 DPI (Ultra HD: 1 Kachel = 1cm @ 400 PPI)
      const tileSizeCm = fmt.widthCm / cols;
      const naturalTilePx = Math.round(tileSizeCm * PX_PER_CM);
      const PRINT_TILE_PX = Math.min(400, Math.max(64, naturalTilePx)); // cap at 400px (max available from API)
      const printOutW = cols * PRINT_TILE_PX;
      const printOutH = rows * PRINT_TILE_PX;
      console.log(`[Print] Format: ${fmt.label}, cols=${cols}, rows=${rows}, naturalTilePx=${naturalTilePx}, PRINT_TILE_PX=${PRINT_TILE_PX}, output=${printOutW}x${printOutH}px`);

      // CLIENT-SIDE PRINT RENDER: used when tiles are user-uploaded (negative IDs)
      // Uses renderMosaicClientSide (same as DB-tiles path) to ensure LAB color correction is applied.
      if (!canDoHiRes()) {
        try {
          setDlLoading(true);
          setDlProgressMsg(`Rendere Druckqualitaet lokal (${printOutW}x${printOutH}px)...`);
          setDlProgress(5);

          // Canvas size limits for mobile
          const isMob = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
          const maxArea = isMob ? 16_000_000 : 200_000_000;
          const maxDim = isMob ? 4096 : 16000;
          const maxTileArea = Math.floor(Math.sqrt(maxArea / (cols * rows)));
          const maxTileDim = Math.floor(maxDim / Math.max(cols, rows));
          const CLIENT_TILE = Math.min(PRINT_TILE_PX, maxTileArea, maxTileDim);
          const cW = cols * CLIENT_TILE;
          const cH = rows * CLIENT_TILE;
          console.log(`[ClientPrint] CLIENT_TILE=${CLIENT_TILE}px, canvas=${cW}x${cH} (${(cW*cH/1e6).toFixed(1)}MP)`);

          if (cW > maxDim || cH > maxDim || cW * cH > maxArea) {
            throw new Error(`Canvas zu gross: ${cW}x${cH}`);
          }

          // Use renderMosaicClientSide for consistent LAB color correction (same as DB-tile path)
          const { blob: printBlob, filename: printFilename } = await renderMosaicClientSide({
            cols, rows, tilePx: CLIENT_TILE, format: 'jpg',
            assignment: assignmentRef.current, rotations: assignmentRotRef.current, tileIds: tileIdsRef.current,
            validImgs: validImgsRef.current, hiResImgs: validImgsHiResRef.current,
            snapshot: snapshotRef.current, origTilePx: mosaicParamsRef.current?.tilePx || 8,
            targetColors: targetColorsRef.current, edgeMap: edgeMapRef.current, faceMask: faceMaskRef.current,
            cellLab: cellLabRef.current,
            userOverlay, userPhotoImg,
            onProgress: (pct, msg) => { setDlProgress(pct); setDlProgressMsg(msg); },
          });

          // Upload print file to R2 BEFORE triggering download (same as hi-res path)
          const jpgBlob1 = new Blob([await printBlob.arrayBuffer()], { type: 'image/jpeg' });
          if (savedProjectIdRef.current && user) {
            try {
              setDlProgressMsg('Druckdatei wird auf Server gespeichert...');
              const uploadRes1 = await fetch(`/api/projects/${savedProjectIdRef.current}/print-url`, {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg', ...authHeaders() },
                body: jpgBlob1,
              });
              const uploadResult1 = await uploadRes1.json();
              if (uploadResult1.ok) {
                setDlProgressMsg('✓ Druckdatei gespeichert – wird heruntergeladen...');
                // Send confirmation email
                try {
                  await fetch(`/api/projects/${savedProjectIdRef.current}/send-confirmation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ printUrl: uploadResult1.printUrl }),
                  });
                } catch (emailErr) {
                  console.warn('[Email] Confirmation email failed:', emailErr);
                }
              } else {
                setDlProgressMsg('⚠ Druckdatei konnte nicht auf Server gespeichert werden.');
              }
            } catch (uploadErr) {
              console.warn('[PrintUpload] Failed:', uploadErr);
              setDlProgressMsg('⚠ Upload fehlgeschlagen – Druckdatei wird lokal heruntergeladen.');
            }
          } else if (!savedProjectIdRef.current && user) {
            setDlProgressMsg('✓ Download fertig. Tipp: Projekt speichern, um Druckdatei unter Projekte abzurufen.');
          }
          // Force download with proper MIME type (bypasses Chrome PDF viewer)
          forceDownloadBlob(jpgBlob1, printFilename, 'image/jpeg');
          setDlProgressMsg(`✓ Download: ${printFilename} (${(jpgBlob1.size / 1024 / 1024).toFixed(1)} MB)`);
          setDlProgress(100);
        } catch (e) {
          console.error('[ClientPrint] Failed:', e);
          setDlProgressMsg(`Fehler: ${e}`);
        } finally {
          setDlLoading(false);
          setTimeout(() => { setDlProgressMsg(''); setDlProgress(0); }, 5000);
        }
        return;
      }

      // CLIENT-SIDE PRINT RENDER: renders locally using loaded tile images (no server needed)
      try {
        setDlLoading(true);
        setDlProgressMsg(`Rendere Druckqualitaet lokal...`);
        setDlProgress(5);

        const { blob: printBlob, filename: printFilename } = await renderMosaicClientSide({
          cols, rows, tilePx: PRINT_TILE_PX, format: 'jpg',
          assignment: assignmentRef.current, rotations: assignmentRotRef.current, tileIds: tileIdsRef.current,
          validImgs: validImgsRef.current, hiResImgs: validImgsHiResRef.current,
          snapshot: snapshotRef.current, origTilePx: mosaicParamsRef.current?.tilePx || 8,
          targetColors: targetColorsRef.current, edgeMap: edgeMapRef.current, faceMask: faceMaskRef.current,
          cellLab: cellLabRef.current, // Pass cellLab for accurate color correction (blurred+original mix)
          userOverlay, userPhotoImg,
          onProgress: (pct, msg) => { setDlProgress(pct); setDlProgressMsg(msg); },
        });

        setDlProgress(100);
        // Upload print file to R2 BEFORE triggering download
        // (forceDownloadBlob navigates away via window.location.href, killing any code after it)
        if (savedProjectIdRef.current && user) {
          try {
            setDlProgressMsg('Druckdatei wird auf Server gespeichert...');
            const uploadRes = await fetch(`/api/projects/${savedProjectIdRef.current}/print-url`, {
              method: 'POST',
              headers: { 'Content-Type': 'image/jpeg', ...authHeaders() },
              body: printBlob,
            });
            const uploadResult = await uploadRes.json();
            if (uploadResult.ok) {
              setDlProgressMsg('✓ Druckdatei gespeichert – wird heruntergeladen...');
              // Send confirmation email
              try {
                await fetch(`/api/projects/${savedProjectIdRef.current}/send-confirmation`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders() },
                  body: JSON.stringify({ printUrl: uploadResult.printUrl }),
                });
              } catch (emailErr) {
                console.warn('[Email] Confirmation email failed:', emailErr);
              }
            } else {
              setDlProgressMsg('⚠ Druckdatei konnte nicht auf Server gespeichert werden.');
            }
          } catch (uploadErr) {
            console.warn('[PrintUpload] Failed:', uploadErr);
            setDlProgressMsg('⚠ Upload fehlgeschlagen – Druckdatei wird lokal heruntergeladen.');
          }
        } else if (!savedProjectIdRef.current && user) {
          setDlProgressMsg('✓ Download fertig. Tipp: Projekt speichern, um Druckdatei unter Projekte abzurufen.');
        }

        // Force download AFTER R2 upload (navigation via window.location.href kills subsequent code)
        const jpgBlob2 = new Blob([await printBlob.arrayBuffer()], { type: 'image/jpeg' });
        forceDownloadBlob(jpgBlob2, printFilename, 'image/jpeg');
        setDlProgressMsg(`✓ Download: ${printFilename} (${(jpgBlob2.size / 1024 / 1024).toFixed(1)} MB)`);

      } catch (e) {
        console.error('[Print] Server render failed:', e);
        setDlProgressMsg(`Server-Fehler: ${e}. Verwende Canvas-Fallback...`);
        // Fallback: scale existing canvas (lower quality but works offline)
        const fallbackCanvas = document.createElement('canvas');
        fallbackCanvas.width = outW; fallbackCanvas.height = outH;
        const fbCtx = fallbackCanvas.getContext('2d')!;
        fbCtx.fillStyle = '#ffffff'; fbCtx.fillRect(0, 0, outW, outH);
        fbCtx.drawImage(canvas, 0, 0, outW, outH);
        const fallbackBlob = await new Promise<Blob>((resolve) => {
          fallbackCanvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95);
        });
        const url2 = URL.createObjectURL(fallbackBlob);
        const link2 = document.createElement('a');
        link2.download = `mosaicprint-${outW}x${outH}-druckbereit.jpg`;
        link2.href = url2;
        document.body.appendChild(link2);
        link2.click();
        document.body.removeChild(link2);
        setTimeout(() => (URL).revokeObjectURL(url2), 10000);
      } finally {
        setDlLoading(false);
        setTimeout(() => { setDlProgressMsg(''); setDlProgress(0); }, 8000);
      }
      return; // early return for print mode
    }

    // PREVIEW MODE: scale existing canvas (aspect-correct)
    outCtx.drawImage(canvas, 0, 0, outW, outH);

    // Add watermark for preview downloads
    const wm = "MosaicPrint.ch - Vorschau";
    const fontSize = Math.max(24, Math.round(outW * 0.025));
    outCtx.save();
    outCtx.globalAlpha = 0.28;
    outCtx.fillStyle = "#ffffff";
    outCtx.font = `bold ${fontSize}px sans-serif`;
    outCtx.textAlign = "center";
    outCtx.textBaseline = "middle";
    const step = Math.round(outW * 0.22);
    for (let y = -step; y < outH + step; y += step) {
      for (let x = -step; x < outW + step; x += step) {
        outCtx.save();
        outCtx.translate(x, y);
        outCtx.rotate(-Math.PI / 6);
        outCtx.fillText(wm, 0, 0);
        outCtx.restore();
      }
    }
    outCtx.restore();

    // Download as JPG (high quality, compatible with Printolino)
    const link = document.createElement('a');
    link.download = `mosaicprint-${outW}x${outH}-vorschau.jpg`;
    link.href = outCanvas.toDataURL('image/jpeg', 0.95);
    link.click();
  }, [selectedFormat]);

  const totalPrice = DIGITAL_FORMATS[selectedDigitalFormat].price;

  // Digital download handler: server-side render without watermark
  const handleDigitalDownload = useCallback(async () => {
    if (!assignmentRef.current.length || !tileIdsRef.current.length || !mosaicParamsRef.current) return;
    const digFmt = DIGITAL_FORMATS[selectedDigitalFormat];
    const { cols, rows } = mosaicParamsRef.current;
    // Replicate server-side clamping (MAX_DIM=32000, tilePx 32-256) so progress shows real dimensions
    const SERVER_MAX_DIM = 16000;
    let TILE_PX = Math.min(Math.max(digFmt.tilePx, 32), 256);
    if (cols * TILE_PX > SERVER_MAX_DIM || rows * TILE_PX > SERVER_MAX_DIM) {
      TILE_PX = Math.min(Math.floor(SERVER_MAX_DIM / cols), Math.floor(SERVER_MAX_DIM / rows), TILE_PX);
      TILE_PX = Math.max(32, TILE_PX);
    }
    const outW = cols * TILE_PX;
    const outH = rows * TILE_PX;

    try {
      setDlLoading(true);
      setDlProgressMsg(`Rendere ${digFmt.label} (${outW.toLocaleString()}x${outH.toLocaleString()}px)...`);
      setDlProgress(5);

      const digJobId = `dig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const useFormat = digFmt.format === 'png' ? 'png' : 'jpg';

      // CLIENT-SIDE RENDERING using shared renderMosaicClientSide()
      const { blob, filename } = await renderMosaicClientSide({
        cols, rows, tilePx: TILE_PX, format: useFormat as 'jpg' | 'png',
        assignment: assignmentRef.current, rotations: assignmentRotRef.current, tileIds: tileIdsRef.current,
        validImgs: validImgsRef.current, hiResImgs: validImgsHiResRef.current,
        snapshot: snapshotRef.current, origTilePx: mosaicParamsRef.current?.tilePx || 8,
        targetColors: targetColorsRef.current, edgeMap: edgeMapRef.current, faceMask: faceMaskRef.current,
        onProgress: (pct, msg) => { setDlProgress(pct); setDlProgressMsg(msg); },
      });
      const mimeType3 = useFormat === 'png' ? 'image/png' : 'image/jpeg';
      forceDownloadBlob(blob, filename, mimeType3);
      setDlProgressMsg(`✓ Download: ${filename} (${(blob3.size / 1024 / 1024).toFixed(1)} MB)`);
      setDlProgress(100);
    } catch (e: any) {
      console.error('[Digital Download] Failed:', e);
      setDlProgressMsg(`Fehler: ${e?.message || e}`);
    } finally {
      setDlLoading(false);
      setTimeout(() => { setDlProgressMsg(''); setDlProgress(0); }, 5000);
    }
  }, [selectedDigitalFormat]);

  // Admin max-quality download: always uses 400px/tile PNG (same as digital PNG Lossless)
  const handleAdminMaxDownload = useCallback(async () => {
    if (!assignmentRef.current.length || !tileIdsRef.current.length || !mosaicParamsRef.current) return;
    const { cols, rows } = mosaicParamsRef.current;
    const SERVER_MAX_DIM = 16000;
    let TILE_PX = 256; // Max tile size supported by server
    if (cols * TILE_PX > SERVER_MAX_DIM || rows * TILE_PX > SERVER_MAX_DIM) {
      TILE_PX = Math.min(Math.floor(SERVER_MAX_DIM / cols), Math.floor(SERVER_MAX_DIM / rows), TILE_PX);
      TILE_PX = Math.max(32, TILE_PX);
    }
    const outW = cols * TILE_PX;
    const outH = rows * TILE_PX;

    try {
      setDlLoading(true);
      setDlProgressMsg(`Admin: Rendere max. Qualitaet (${outW.toLocaleString()}x${outH.toLocaleString()}px JPG)...`);
      setDlProgress(5);

      // CLIENT-SIDE RENDERING (admin max quality) - JPG for Printolino compatibility
      const { blob: adminBlob, filename: adminFilename } = await renderMosaicClientSide({
        cols, rows, tilePx: TILE_PX, format: 'jpg',
        assignment: assignmentRef.current, rotations: assignmentRotRef.current, tileIds: tileIdsRef.current,
        validImgs: validImgsRef.current, hiResImgs: validImgsHiResRef.current,
        snapshot: snapshotRef.current, origTilePx: mosaicParamsRef.current?.tilePx || 8,
        targetColors: targetColorsRef.current, edgeMap: edgeMapRef.current, faceMask: faceMaskRef.current,
        onProgress: (pct, msg) => { setDlProgress(pct); setDlProgressMsg(msg); },
      });
      forceDownloadBlob(adminBlob, adminFilename, 'image/jpeg');
      setDlProgressMsg(`✓ Download: ${adminFilename} (${(adminBlob2.size / 1024 / 1024).toFixed(1)} MB)`);
      setDlProgress(100);
    } catch (e) {
      console.error('[Admin Max Download] Failed:', e);
      setDlProgressMsg(`Fehler: ${e}`);
    } finally {
      setDlLoading(false);
      setTimeout(() => { setDlProgressMsg(''); setDlProgress(0); }, 4000);
    }
  }, []);

  // Druck bestellen: create order in DB + render file client-side for admin fulfillment
  const [printolinoLoading, setPrintolinoLoading] = useState(false);
  const [printolinoSuccess, setPrintolinoSuccess] = useState(false);
  const handlePrintolinoOrder = useCallback(async () => {
    if (!assignmentRef.current.length || !tileIdsRef.current.length || !mosaicParamsRef.current) return;
    const { cols, rows } = mosaicParamsRef.current;
    // 1 tile = 1 cm @ 400 DPI → tilePx = 1 cm × (400/2.54) ≈ 157 px
    // This gives cols cm × rows cm poster size (e.g. 120×90 cm for 120×90 tiles)
    const TILE_PX_400DPI = 157;
    const SERVER_MAX_DIM = 16000;
    let PRINT_TILE_PX = TILE_PX_400DPI;
    if (cols * PRINT_TILE_PX > SERVER_MAX_DIM || rows * PRINT_TILE_PX > SERVER_MAX_DIM) {
      PRINT_TILE_PX = Math.min(Math.floor(SERVER_MAX_DIM / cols), Math.floor(SERVER_MAX_DIM / rows), PRINT_TILE_PX);
      PRINT_TILE_PX = Math.max(32, PRINT_TILE_PX);
    }
    const outW = cols * PRINT_TILE_PX;
    const outH = rows * PRINT_TILE_PX;
    const useFormat = 'jpg'; // JPG for print (PNG would be too large for upload);

    setPrintolinoLoading(true);
    setDlLoading(true);
    try {
      // 1. Render file client-side (same path as digital download = same quality)
      setDlProgressMsg(`Rendere Druckdatei ${cols}x${rows} cm (${outW.toLocaleString()}x${outH.toLocaleString()}px @ 400 DPI)...`);
      setDlProgress(5);
      const { blob: printBlob, filename: printFilename } = await renderMosaicClientSide({
        cols, rows, tilePx: PRINT_TILE_PX, format: useFormat as 'jpg' | 'png',
        assignment: assignmentRef.current, rotations: assignmentRotRef.current, tileIds: tileIdsRef.current,
        validImgs: validImgsRef.current, hiResImgs: validImgsHiResRef.current,
        snapshot: snapshotRef.current, origTilePx: mosaicParamsRef.current?.tilePx || 8,
        targetColors: targetColorsRef.current, edgeMap: edgeMapRef.current, faceMask: faceMaskRef.current,
        cellLab: cellLabRef.current,
        userOverlay, userPhotoImg,
        onProgress: (pct, msg) => { setDlProgress(pct); setDlProgressMsg(msg); },
      });
      setDlProgress(70);
      setDlProgressMsg('Datei wird auf Server gespeichert...');

      // 2. Upload to R2 for persistent download link
      let printUrl: string | null = null;
      if (savedProjectIdRef.current && user) {
        try {
          const mimeType4 = useFormat === 'png' ? 'image/png' : 'image/jpeg';
          const uploadBlob = new Blob([await printBlob.arrayBuffer()], { type: mimeType4 });
          const uploadRes = await fetch(`/api/projects/${savedProjectIdRef.current}/print-url`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType4, ...authHeaders() },
            body: uploadBlob,
          });
          const uploadResult = await uploadRes.json();
          if (uploadResult.ok) printUrl = uploadResult.printUrl ?? null;
        } catch (uploadErr) {
          console.warn('[PrintOrder] R2 upload failed:', uploadErr);
        }
      }
      setDlProgress(85);
      setDlProgressMsg('Bestellung wird angelegt...');

      // 3. Create order in DB
      const orderResp = await fetch('/api/orders/printolino', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          formatLabel: `${cols}x${rows} cm (${outW.toLocaleString()}x${outH.toLocaleString()} px)`,
          materialLabel: 'JPG 400DPI',
          priceChf: 29,
          customerEmail: user?.email ?? null,
          userId: user?.id ?? null,
          renderParams: {
            cols, rows,
            tilePx: PRINT_TILE_PX,
            format: useFormat,
            outputWidth: outW,
            outputHeight: outH,
            printUrl,
          },
        }),
      });
      const orderData = await orderResp.json();
      if (!orderData.ok) throw new Error(orderData.error || 'Order creation failed');

      // 4. If we have a printUrl, mark order as ready immediately
      if (printUrl && orderData.orderId) {
        await fetch(`/api/admin/orders/${orderData.orderId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ status: 'ready', downloadToken: printUrl }),
        });
      }

      // 5. Send confirmation email
      if (savedProjectIdRef.current && user) {
        try {
          await fetch(`/api/projects/${savedProjectIdRef.current}/send-confirmation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ printUrl, orderId: orderData.orderId }),
          });
        } catch (emailErr) {
          console.warn('[PrintOrder] Email failed:', emailErr);
        }
      }

      setDlProgress(100);
      setDlProgressMsg(`✓ Bestellung #${orderData.orderId} erstellt! Download: ${printFilename}`);
      setPrintolinoSuccess(true);

      // 6. Trigger local download too
      const mimeType5 = useFormat === 'png' ? 'image/png' : 'image/jpeg';
      forceDownloadBlob(printBlob, printFilename, mimeType5);

      setTimeout(() => { setDlProgressMsg(''); setDlProgress(0); setPrintolinoSuccess(false); }, 8000);
    } catch (e) {
      console.error('[PrintOrder] Failed:', e);
      setDlProgressMsg(`Fehler: ${e}`);
      setTimeout(() => { setDlProgressMsg(''); setDlProgress(0); }, 3000);
    } finally {
      setPrintolinoLoading(false);
      setDlLoading(false);
    }
  }, [selectedDigitalFormat, user, authHeaders, userOverlay, userPhotoImg]);

  // Stripe Checkout: redirect to Stripe payment page
  const handleStripeCheckout = useCallback(async () => {
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      const res = await fetch("/api/trpc/createCheckout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formatIdx: selectedFormat,
          materialIdx: selectedMaterial,
          successUrl: `${window.location.origin}/studio?payment=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${window.location.origin}/studio?payment=cancelled`,
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url; // Redirect to Stripe Checkout
      } else if (data.error) {
        // Stripe not configured: allow direct download as fallback
        setPaymentError("Stripe nicht konfiguriert - direkt herunterladen.");
        handleDownload(true);
      }
    } catch {
      // Network error: allow direct download as fallback
      setPaymentError("Zahlung nicht verfuegbar - direkt herunterladen.");
      handleDownload(true);
    } finally {
      setPaymentLoading(false);
      setShowPayModal(false);
    }
  }, [selectedFormat, selectedMaterial, handleDownload]);

  // Check for payment success on mount (after Stripe redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success") {
      const sessionId = params.get("session_id");
      if (sessionId) {
        setPaymentSuccess(true);
        // Verify and auto-download
        fetch(`/api/payment/verify/${sessionId}`)
          .then(r => r.json())
          .then(data => {
            if (data.paid) {
              setSelectedFormat(data.formatIdx ?? 1);
              setSelectedMaterial(data.materialIdx ?? 0);
            }
          })
          .catch(() => {});
        // Clean URL
        window.history.replaceState({}, "", "/studio");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-cream-100 py-10">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">

        {/* Header */}
        <div className="text-center mb-8">
          <span className="inline-block text-xs font-semibold tracking-widest uppercase text-coral-500 bg-coral-50 border border-coral-100 rounded-full px-4 py-1.5 mb-4">Mosaik-Studio</span>
          <h1 className="font-serif text-3xl sm:text-4xl text-gray-900 mb-2">
            Dein Foto als <em className="text-coral-500 not-italic">lebendiges Kunstwerk</em>
          </h1>
          <p className="text-gray-500">Lade dein Lieblingsfoto hoch - unsere KI baut es aus Hunderten kleiner Fotos nach.</p>
        </div>

        {/* Cache status badge */}
        {(cacheSize > 0 || dbTileCount !== null) && !userPhoto && !loading && (
          <div className="flex justify-center mb-4">
            <div className="inline-flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 text-xs font-semibold px-3 py-1.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {dbTileCount !== null
                ? `${dbTileCount.toLocaleString('de-CH')} Bilder verfuegbar - schneller Start garantiert`
                : `${cacheSize} Bilder im Cache - schneller Start garantiert`}
            </div>
          </div>
        )}

        {/* Tile source mode selector */}
        {!userPhoto && !loading && (
          <div className="max-w-xl mx-auto mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 text-center">Kachel-Quelle waehlen</p>
            <div className="grid grid-cols-3 gap-3">
              {([
                { key: 'pool' as const, icon: Sparkles, label: 'KI-Bilderpool', desc: 'Schnelles Ergebnis aus 10\'000+ Fotos' },
                { key: 'mix' as const, icon: Images, label: 'Mix', desc: 'Deine Fotos + unser Pool zur Ergaenzung' },
                { key: 'own' as const, icon: ImagePlus, label: 'Eigene Fotos', desc: `Min. ${MIN_OWN_TILES} eigene Fotos hochladen` },
              ]).map(({ key, icon: Icon, label, desc }) => (
                <button
                  key={key}
                  onClick={() => { setTileSourceMode(key); tileSourceModeRef.current = key; }}
                  className={`flex flex-col items-center gap-1.5 p-4 rounded-2xl border-2 transition-all text-center ${
                    tileSourceMode === key
                      ? 'border-coral-500 bg-coral-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-coral-300'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    tileSourceMode === key ? 'bg-coral-500 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className={`text-sm font-bold ${tileSourceMode === key ? 'text-coral-700' : 'text-gray-700'}`}>{label}</span>
                  <span className="text-[11px] text-gray-400 leading-tight">{desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* User tile upload area (shown for 'own' and 'mix' modes) */}
        {!userPhoto && !loading && (tileSourceMode === 'own' || tileSourceMode === 'mix') && (
          <div className="max-w-xl mx-auto mb-6">
            <div
              className="border-2 border-dashed border-teal-200 rounded-2xl p-6 text-center cursor-pointer hover:border-teal-400 hover:bg-teal-50 transition-all"
              onClick={() => tileUploadRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (e.dataTransfer.files) handleTileUpload(e.dataTransfer.files); }}
            >
              <input ref={tileUploadRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => { if (e.target.files) handleTileUpload(e.target.files); e.target.value = ''; }} />
              <ImagePlus className="w-8 h-8 text-teal-500 mx-auto mb-2" />
              <p className="text-sm font-bold text-gray-700">Kachel-Fotos hochladen</p>
              <p className="text-xs text-gray-400 mt-1">Mehrere Bilder gleichzeitig waehlen oder per Drag & Drop</p>
            </div>

            {/* User tile preview grid */}
            {userTileFiles.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-bold ${
                    tileSourceMode === 'own' && userTileImages.length < MIN_OWN_TILES
                      ? 'text-amber-600'
                      : 'text-teal-600'
                  }`}>
                    {userTileImages.length} Kachel-Fotos geladen
                    {tileSourceMode === 'own' && userTileImages.length < MIN_OWN_TILES &&
                      ` (mind. ${MIN_OWN_TILES} noetig)`}
                  </span>
                  <button
                    onClick={() => { setUserTileFiles([]); setUserTileImages([]); userTileImagesRef.current = []; }}
                    className="text-xs text-red-400 hover:text-red-600 font-medium"
                  >
                    Alle entfernen
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {userTileFiles.slice(0, 50).map((f, i) => (
                    <div key={i} className="relative group">
                      <div className="w-12 h-12 rounded-lg overflow-hidden border border-gray-200">
                        {userTileImages[i] ? (
                          <img src={userTileImages[i].src} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-gray-100 animate-pulse" />
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeUserTile(i); }}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {userTileFiles.length > 50 && (
                    <div className="w-12 h-12 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center">
                      <span className="text-[10px] font-bold text-gray-400">+{userTileFiles.length - 50}</span>
                    </div>
                  )}
                </div>
                {tileSourceMode === 'own' && userTileImages.length < MIN_OWN_TILES && (
                  <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    <p className="text-xs text-amber-700">
                      Noch <strong>{MIN_OWN_TILES - userTileImages.length}</strong> Fotos noetig. Je mehr Fotos, desto besser das Ergebnis!
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Restore saved project banner */}
        {showRestoreBanner && !userPhoto && !loading && !projectLoading && (
          <div className="max-w-xl mx-auto mb-6 bg-green-50 border border-green-200 rounded-2xl p-4 flex items-center gap-3">
            <FolderOpen className="w-6 h-6 text-green-600 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-green-800">Gespeichertes Projekt gefunden</p>
              <p className="text-xs text-green-600">Dein letztes Mosaik kann wiederhergestellt werden.</p>
            </div>
            <button
              onClick={restoreProject}
              className="flex items-center gap-1.5 bg-green-600 text-white text-xs font-bold px-3 py-2 rounded-xl hover:bg-green-700 transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Laden
            </button>
            <button
              onClick={clearSavedProject}
              className="text-green-400 hover:text-green-700 transition-colors"
              title="Verwerfen"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Project loading overlay */}
        {projectLoading && (
          <div className="max-w-md mx-auto bg-white rounded-2xl p-10 shadow-lg border border-cream-200 mb-8 text-center">
            <div className="w-16 h-16 mx-auto mb-5 animate-spin rounded-xl overflow-hidden" style={{ animationDuration: '2s', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px', padding: '4px', background: '#1a1a1a' }}>
              {["#e8573a","#3dbfb8","#f59e0b","#6366f1","#22c55e","#ec4899","#d44228","#2aada6","#d97706"].map((c, i) => (
                <div key={i} style={{ backgroundColor: c, borderRadius: '3px' }} />
              ))}
            </div>
            <p className="font-bold text-lg text-gray-900 mb-2">Projekt wird geladen</p>
            <p className="text-sm text-gray-500">{projectLoadMsg}</p>
          </div>
        )}

        {/* Upload area (when no photo) */}
        {!userPhoto && !loading && !projectLoading && (
          <div
            className={`max-w-xl mx-auto border-2 border-dashed border-coral-200 rounded-3xl p-12 text-center cursor-pointer hover:border-coral-400 hover:bg-coral-50 transition-all group mb-8 ${
              tileSourceMode === 'own' && userTileImages.length < MIN_OWN_TILES ? 'opacity-50 pointer-events-none' : ''
            }`}
            onClick={() => uploadRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleUpload(f); }}
          >
            <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <div className="w-16 h-16 rounded-2xl bg-coral-100 group-hover:bg-coral-200 flex items-center justify-center mx-auto mb-4 transition-colors">
              <Upload className="w-8 h-8 text-coral-600" />
            </div>
            <p className="text-xl font-bold text-gray-800 mb-2">Hauptfoto hochladen</p>
            <p className="text-gray-500 mb-1">Das Foto, das als Mosaik dargestellt wird</p>
            <p className="text-sm text-gray-400">JPG, PNG, HEIC . Drag & Drop oder klicken</p>
          </div>
        )}

        {/* Loading progress */}
        {loading && (
          <MosaicProgress progress={progress} message={progressMsg} renderPass={renderPass} />
        )}

        {/* Error */}
        {error && (
          <div className="max-w-xl mx-auto bg-red-50 border border-red-200 rounded-2xl p-4 text-red-700 text-sm mb-6">
            {error}
          </div>
        )}

        {/* Gemini AI Toggle (Admin only) - shown after upload */}
        {isAdminMode && detectedImageType && (ready || loading) && (
          <div className="flex items-center justify-center gap-3 mb-3">
            <span className="text-xs font-medium text-gray-500">Algorithmus-Quelle:</span>
            <div className="inline-flex rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <button
                onClick={() => {
                  setUseGemini(true);
                  localStorage.setItem('mosaicprint_use_gemini', 'true');
                  // Re-apply Gemini settings if available
                  try {
                    const analysis = JSON.parse(localStorage.getItem('mosaicprint_gemini_analysis') || 'null');
                    const gd = analysis?.dynamicSettings;
                    if (gd && typeof gd.baseTiles === 'number') {
                      const dynamicPreset: Record<string, unknown> = {
                        baseTiles: gd.baseTiles, tilePx: gd.tilePx ?? 8, maxReuse: gd.maxReuse ?? 10,
                        rotation: gd.rotation ?? false, neighborRadius: gd.neighborRadius ?? 5,
                        neighborPenalty: gd.neighborPenalty ?? 200, contrastBoost: gd.contrastBoost ?? 1.30,
                        histogramBlend: gd.histogramBlend ?? 0.08, baseOverlay: gd.baseOverlay ?? 0.15,
                        edgeBoost: gd.edgeBoost ?? 0.15, overlayMode: gd.overlayMode ?? 'softlight',
                        labWeight: gd.labWeight ?? 0.20, brightnessWeight: gd.brightnessWeight ?? 0.45,
                        textureWeight: gd.textureWeight ?? 0.10, edgeWeight: gd.edgeWeight ?? 0.15,
                        saturationWeight: gd.saturationWeight ?? 0.30,
                        portraitMode: gd.portraitMode ?? analysis?.hasFace ?? false,
                        tileComplexityThreshold: analysis?.algoRecommendations?.tileComplexityThreshold ?? 0.25,
                      };
                      localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(dynamicPreset));
                      setAutoPresetApplied('KI-Dynamisch');
                    }
                  } catch { /* ignore */ }
                }}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  useGemini
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Gemini AI
              </button>
              <button
                onClick={() => {
                  setUseGemini(false);
                  localStorage.setItem('mosaicprint_use_gemini', 'false');
                  // Re-apply heuristic preset + admin overrides
                  try {
                    const overrides = JSON.parse(localStorage.getItem('mosaicprint_algo_overrides') || '{}');
                    const current = JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}');
                    // Restore from overrides (admin presets)
                    if (Object.keys(overrides).length > 0) {
                      localStorage.setItem('mosaicprint_algo_settings', JSON.stringify({ ...current, ...overrides }));
                    }
                    setAutoPresetApplied(detectedImageType === 'portrait' ? 'Portrait' : detectedImageType === 'landscape' ? 'Landschaft' : null);
                  } catch { /* ignore */ }
                }}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  !useGemini
                    ? 'bg-amber-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Voreinstellungen
              </button>
            </div>
            <span className="text-xs text-gray-400">
              {useGemini ? 'Gemini passt alle Parameter an' : 'Admin-Presets werden verwendet'}
            </span>
          </div>
        )}

        {/* Canvas container - always in DOM (hidden when not needed) for ref availability */}
        {(ready || loading || projectLoading) && (
          <>
            {/* Controls - hidden during project loading */}
            <div className={`flex flex-wrap items-center justify-between gap-3 mb-4${projectLoading ? ' hidden' : ''}`}>
              <div className="flex items-center gap-2">
                {userPhoto && (
                  <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-1.5 shadow-sm">
                    <button
                      onClick={() => setShowPhotoPreview(true)}
                      className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                      title="Hochgeladenes Foto vergrössern"
                    >
                      <img src={userPhoto} alt="Dein Foto" className="w-8 h-8 rounded-lg object-cover" />
                      <span className="text-xs font-semibold text-gray-700">Dein Foto</span>
                      <Eye className="w-3 h-3 text-gray-400" />
                    </button>
                    <button onClick={() => { setUserPhoto(null); setUserPhotoImg(null); setReady(false); setLoading(false); setShowOrderPanel(false); }} className="text-gray-400 hover:text-gray-700 ml-1">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { const nz = Math.min(8, zoom * 1.3); if (nz > 1.5 && !hiResReady && !hiResLoading) { triggerClientHiResRender(); } setZoom(nz); }} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900">
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button onClick={() => setZoom(z => Math.max(0.2, z / 1.3))} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900" title="Ansicht zurücksetzen">
                  <Eye className="w-4 h-4" />
                </button>
                {ready && (
                  <button
                    onClick={() => setDistancePreview(d => !d)}
                    className={`p-2.5 rounded-xl border shadow-sm hover:shadow-md transition-all text-xs font-bold ${
                      distancePreview
                        ? 'bg-blue-100 border-blue-400 text-blue-700'
                        : 'bg-white border-gray-200 text-gray-600 hover:text-gray-900'
                    }`}
                    title={distancePreview ? 'Fernansicht deaktivieren' : 'Fernansicht: So sieht das Mosaik aus 2-3m Distanz aus'}
                  >
                    {distancePreview ? '2-3m ✓' : '2-3m'}
                  </button>
                )}
                {ready && (
                  <>
                    {/* HD Zoom Button: shown when mosaic is ready but no hi-res available yet.
                        Useful when loading a saved project (tiles not in memory → auto hi-res fails).
                        Also shown when auto hi-res was skipped or failed. */}
                    {!hiResReady && !hiResLoading && (
                      <button
                        onClick={() => triggerClientHiResRender()}
                        className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-200 shadow-sm hover:shadow-md transition-all text-indigo-600 hover:text-indigo-800"
                        title="HD-Zoom aktivieren (schärfere Darstellung beim Zoomen)"
                      >
                        <span className="text-[10px] font-bold leading-none">HD</span>
                      </button>
                    )}
                    <button onClick={() => handleDownload(false)} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900" title="Vorschau herunterladen (mit Wasserzeichen)">
                      <Download className="w-4 h-4" />
                    </button>
                    <button onClick={() => { if (userPhotoImg) { setReady(false); setLoading(true); setProgress(0); renderMosaic(userPhotoImg); } }} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900" title="Neu generieren">
                      <RefreshCw className="w-4 h-4" />
                    </button>
                    <button onClick={() => { setSaveProjectName(''); setShowSaveModal(true); }} className="p-2.5 rounded-xl bg-green-50 border border-green-200 shadow-sm hover:shadow-md transition-all text-green-600 hover:text-green-800" title="Projekt speichern">
                      <Save className="w-4 h-4" />
                    </button>
                    <button onClick={() => setShowStatsModal(true)} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900" title="Statistiken & Einstellungen">
                      <SlidersHorizontal className="w-4 h-4" />
                    </button>
                  </>
                )}
                <span className="text-xs font-semibold text-gray-500 bg-white border border-gray-200 rounded-xl px-3 py-2">
                  {Math.round(zoom * 100)}%
                </span>
              </div>
            </div>

            {/* Canvas */}
            <div
              ref={containerRef}
              className="relative rounded-2xl overflow-hidden shadow-2xl mb-6 select-none"
              style={{
                background: "linear-gradient(135deg, #f0f4ff 0%, #f5f8ff 50%, #eef2ff 100%)",
                cursor: isDragging.current ? "grabbing" : "grab",
                height: "min(90vw, 75vh)",
              }}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              <div style={{
                position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {/* Wrapper: all layers share position via this relative container */}
                {/* FIX: use explicit width/height from canvas CSS size so transformOrigin:center center
                     is computed correctly on mobile (avoids jump-to-right at zoom > 1) */}
                <div style={{
                  position: "relative",
                  display: "block",
                  flexShrink: 0,
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center center",
                  transition: isDragging.current ? "none" : "transform 0.1s ease",
                  width: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasW * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : undefined,
                  height: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasH * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : undefined,
                }}>
                  <canvas
                    ref={canvasRef}
                    style={{
                      display: (ready || loading || projectLoading) ? "block" : "none",
                      imageRendering: zoom > 1 && !distancePreview && !(hiResReady && (isMobile || zoom > 1.5)) ? "pixelated" : "auto",
                      filter: distancePreview ? "blur(2px)" : "none",
                      maxWidth: "none",
                    }}
                  />
                  {/* Pop-Out: animated tile overlays above the canvas */}
                  <div
                    ref={popOutContainerRef}
                    style={{
                      display: popOutMode && ready ? "block" : "none",
                      position: "absolute",
                      top: 0, left: 0, width: "100%", height: "100%",
                      pointerEvents: "none",
                      overflow: "visible",
                    }}
                  />
                  {/* Hi-Res image overlay - sharp zoom
                      Desktop: show from zoom > 1.5 (main canvas is always intact)
                      Mobile: show always when ready (main canvas may be evicted by memory pressure) */}
                  {hiResImgUrl && hiResReady && (isMobile || zoom > 1.5) && (
                    <img
                      src={hiResImgUrl}
                      alt=""
                      style={{
                        display: "block",
                        position: "absolute",
                        top: 0, left: 0,
                        width: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasW * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : "100%",
                        height: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasH * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : "100%",
                        pointerEvents: "none",
                        imageRendering: "auto" as const,
                        // No CSS filter needed: LAB color correction is applied directly in canvas
                        // during hi-res rendering (same Reinhard-style correction as renderMosaic).
                        filter: undefined,
                      }}
                    />
                  )}
                  {/* Color Enhance overlay - target colors per tile with color blend */}
                  {/* Auto-reduce at high zoom: individual tiles are visible, color overlay looks artificial */}
                  {colorEnhance > 0 && ready && colorEnhanceUrl && (() => {
                    // Disable color enhance overlay when hi-res is active: hi-res render already
                    // has per-pixel color correction built in. Overlay on top causes color patches.
                    if (hiResReady && (isMobile || zoom > 1.5)) return null;
                    // Gentle zoom fade: full strength at <=100%, fades out quickly at zoom >1.2
                    // At zoom=1.5 without hi-res: 25% strength; at zoom=2.0: 0%
                    const zoomFade = zoom <= 1.0 ? 1.0 : Math.max(0.0, 1.0 - (zoom - 1.0) / 2.0);
                    const effectiveOpacity = (colorEnhance / 100) * zoomFade;
                    if (effectiveOpacity < 0.01) return null;
                    return (
                      <img
                        src={colorEnhanceUrl}
                        alt=""
                        style={{
                          display: "block",
                          position: "absolute",
                          top: 0, left: 0,
                          width: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasW * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : "100%",
                          height: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasH * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : "100%",
                          pointerEvents: "none",
                          imageRendering: "pixelated" as const,
                          mixBlendMode: "color" as const,
                          opacity: effectiveOpacity,
                        }}
                      />
                    );
                  })()}
                  {/* User overlay - original photo at canvas aspect ratio (prevents mobile misalignment) */}
                  {userOverlayUrl && userOverlay > 0 && ready && (
                    <img
                      src={userOverlayUrl}
                      alt=""
                      style={{
                        display: "block",
                        position: "absolute",
                        top: 0, left: 0,
                        width: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasW * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : "100%",
                        height: mosaicParamsRef.current ? `${Math.round(mosaicParamsRef.current.canvasH * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px` : "100%",
                        opacity: userOverlay / 100,
                        pointerEvents: "none",
                        mixBlendMode: "normal",
                      }}
                    />
                  )}
                </div>
                {/* Hi-Res loading overlay - fixed position in viewport, not affected by zoom */}
                {hiResLoading && (
                  <div style={{
                    position: "absolute", top: 12, right: 12,
                    pointerEvents: "none", zIndex: 10,
                    opacity: zoom > 1.05 ? 1 : 0.7,
                    transition: "opacity 0.3s",
                  }}>
                    <div style={{
                      background: "white", borderRadius: zoom > 1.05 ? 12 : 8,
                      padding: zoom > 1.05 ? "8px 16px" : "5px 10px",
                      textAlign: "center", boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                      transition: "all 0.3s",
                    }}>
                      <div style={{ fontSize: zoom > 1.05 ? 11 : 10, fontWeight: 600, color: "#1f2937", marginBottom: 2 }}>
                        {zoom > 1.05 ? 'HD wird geladen...' : 'HD wird vorbereitet…'}
                      </div>
                      <div style={{ width: zoom > 1.05 ? 100 : 70, height: zoom > 1.05 ? 4 : 3, background: "#e5e7eb", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
                          borderRadius: 2, transition: "width 0.3s",
                          width: `${progress}%`,
                        }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {ready && zoom === 1 && (
                <div className="absolute bottom-3 right-3 text-xs text-white/80 bg-black/40 rounded-lg px-2 py-1 pointer-events-none">
                  {distancePreview ? 'Fernansicht: So sieht das Mosaik aus 2-3m Distanz aus' : 'Scroll zum Zoomen . Drag zum Verschieben'}
                </div>
              )}
            </div>

            {/* Unsplash Attribution Badge */}
            {ready && (
              <div className="flex items-center justify-center mb-4">
                <a
                  href="https://unsplash.com/?utm_source=mosaicprint&utm_medium=referral"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 bg-black text-white text-xs font-semibold px-3 py-1.5 rounded-full hover:bg-gray-800 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 32 32" fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M10 9V0h12v9H10zm12 5h10v18H0V14h10v9h12v-9z"/>
                  </svg>
                  Photos powered by Unsplash
                </a>
              </div>
            )}

            {/* Inline sliders: Foto-Overlay & Color Enhance side by side */}
            {ready && (
              <div className="flex gap-4 mb-4">
                {userPhotoImg && (
                  <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-xs font-medium text-gray-600">Foto-Overlay</p>
                      <span className="text-xs font-bold text-blue-600">{userOverlay}%</span>
                    </div>
                    <input
                      type="range" min={0} max={80} step={5} value={userOverlay}
                      onChange={e => setUserOverlay(Number(e.target.value))}
                      className="w-full h-1.5 rounded-full cursor-pointer"
                      style={{ accentColor: '#3B82F6' }}
                    />
                    <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                      <span>Mosaik</span>
                      <span>Originalfoto</span>
                    </div>
                  </div>
                )}
                <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs font-medium text-gray-600">Farbkorrektur</p>
                    <span className="text-xs font-bold text-purple-600">{colorEnhance}%</span>
                  </div>
                  <input
                    type="range" min={0} max={100} step={5} value={colorEnhance}
                    onChange={e => {
                      const v = Number(e.target.value);
                      setColorEnhance(v); colorEnhanceRef.current = v;
                      // If hi-res is active, reset and re-trigger hi-res render
                      // so the new colorEnhance value is baked into the hi-res image
                      if (hiResReadyRef.current && (isMobile || zoom > 1.5)) {
                        resetHiRes();
                        setTimeout(() => { triggerClientHiResRef.current?.(); }, 50);
                      }
                    }}
                    className="w-full h-1.5 rounded-full cursor-pointer"
                    style={{ accentColor: '#8B5CF6' }}
                  />
                  <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                    <span>Keine</span>
                    <span>Maximal</span>
                  </div>
                </div>
              </div>
            )}

            {/* Statistiken & Einstellungen Modal */}
            {showStatsModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowStatsModal(false)}>
                <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <SlidersHorizontal className="w-5 h-5 text-gray-600" />
                      <h2 className="text-lg font-bold text-gray-900">Statistiken & Einstellungen</h2>
                    </div>
                    <button onClick={() => setShowStatsModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Mosaik-Statistik */}
                  {qualityMetrics && (() => {
                    const curCols = mosaicParamsRef.current?.cols ?? 0;
                    const curRows = mosaicParamsRef.current?.rows ?? 0;
                    const imgAspect = curCols > 0 && curRows > 0 ? curCols / curRows : 1;
                    // Min/Max: 10-200 Spalten, proportionale Zeilen
                    const MIN_COLS = 10; const MAX_COLS = 200;
                    const dispCols = editCols ?? curCols;
                    const dispRows = editRows ?? curRows;
                    const clampCols = (v: number) => Math.max(MIN_COLS, Math.min(MAX_COLS, v));
                    const clampRows = (v: number) => Math.max(Math.ceil(MIN_COLS / Math.max(imgAspect, 0.1)), Math.min(Math.ceil(MAX_COLS / Math.max(imgAspect, 0.1)), v));
                    const handleRerender = () => {
                      if (!userPhotoImg) return;
                      const newCols = clampCols(dispCols);
                      const newRows = clampRows(dispRows);
                      // Derive baseTiles from newCols/newRows (baseTiles = longer side)
                      const newBase = imgAspect >= 1 ? newCols : newRows;
                      try {
                        const s = JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}');
                        s.baseTiles = newBase;
                        localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(s));
                      } catch { /* ignore */ }
                      setEditCols(null); setEditRows(null);
                      setShowStatsModal(false);
                      setReady(false); setLoading(true); setProgress(0);
                      renderMosaic(userPhotoImg);
                    };
                    const colsChanged = dispCols !== curCols || dispRows !== curRows;
                    return (
                    <div className="mb-5">
                      <div className="flex items-center gap-2 mb-3">
                        <BarChart3 className="w-4 h-4 text-gray-500" />
                        <p className="text-sm font-bold text-gray-800">Mosaik-Statistik</p>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="bg-gray-50 rounded-xl p-3 text-center">
                          <div className="text-lg font-extrabold text-gray-900">{qualityMetrics.totalTiles.toLocaleString('de-CH')}</div>
                          <div className="text-[11px] text-gray-500 font-medium">Kacheln total</div>
                        </div>
                        <div className="bg-gray-50 rounded-xl p-3 text-center">
                          <div className="text-lg font-extrabold text-teal-700">{qualityMetrics.uniqueTiles.toLocaleString('de-CH')}</div>
                          <div className="text-[11px] text-gray-500 font-medium">Unique Bilder</div>
                        </div>
                        <div className="bg-gray-50 rounded-xl p-3 text-center">
                          <div className="text-lg font-extrabold text-blue-700">{qualityMetrics.avgDeltaE.toFixed(1)}</div>
                          <div className="text-[11px] text-gray-500 font-medium">Farbtreue (dE)</div>
                        </div>
                        <div className="bg-gray-50 rounded-xl p-3 text-center">
                          <div className="text-lg font-extrabold text-coral-600">{Math.round(qualityMetrics.reuseRate * 100)}%</div>
                          <div className="text-[11px] text-gray-500 font-medium">Pool-Nutzung</div>
                        </div>
                      </div>
                      {/* Saturation distribution bar */}
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
                          <span>Sättigung</span>
                          <span>Gedämpft {Math.round(qualityMetrics.satLow)}% | Mittel {Math.round(qualityMetrics.satMid)}% | Lebendig {Math.round(qualityMetrics.satHigh)}%</span>
                        </div>
                        <div className="flex h-2 rounded-full overflow-hidden">
                          <div className="bg-gray-300" style={{ width: `${qualityMetrics.satLow}%` }} />
                          <div className="bg-amber-400" style={{ width: `${qualityMetrics.satMid}%` }} />
                          <div className="bg-emerald-500" style={{ width: `${qualityMetrics.satHigh}%` }} />
                        </div>
                      </div>

                      {/* Zeilen / Spalten Stepper */}
                      <div className="mt-4 border-t border-gray-100 pt-4">
                        <p className="text-xs font-bold text-gray-700 mb-3">Raster anpassen</p>
                        <div className="grid grid-cols-2 gap-3">
                          {/* Spalten */}
                          <div className="bg-gray-50 rounded-xl p-3">
                            <div className="text-[10px] text-gray-500 font-medium mb-2">Spalten (Breite)</div>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setEditCols(clampCols((editCols ?? curCols) - 5))}
                                className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 font-bold text-sm hover:bg-gray-100 flex items-center justify-center"
                              >−</button>
                              <input
                                type="number" min={MIN_COLS} max={MAX_COLS} step={1}
                                value={dispCols}
                                onChange={e => setEditCols(clampCols(Number(e.target.value)))}
                                className="flex-1 w-0 text-center text-sm font-extrabold text-gray-900 bg-white border border-gray-200 rounded-lg py-1 px-1 focus:outline-none focus:border-blue-400"
                              />
                              <button
                                onClick={() => setEditCols(clampCols((editCols ?? curCols) + 5))}
                                className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 font-bold text-sm hover:bg-gray-100 flex items-center justify-center"
                              >+</button>
                            </div>
                            <div className="text-[9px] text-gray-400 mt-1 text-center">Min {MIN_COLS} – Max {MAX_COLS}</div>
                          </div>
                          {/* Zeilen */}
                          <div className="bg-gray-50 rounded-xl p-3">
                            <div className="text-[10px] text-gray-500 font-medium mb-2">Zeilen (Höhe)</div>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setEditRows(clampRows((editRows ?? curRows) - 5))}
                                className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 font-bold text-sm hover:bg-gray-100 flex items-center justify-center"
                              >−</button>
                              <input
                                type="number" min={1} max={300} step={1}
                                value={dispRows}
                                onChange={e => setEditRows(clampRows(Number(e.target.value)))}
                                className="flex-1 w-0 text-center text-sm font-extrabold text-gray-900 bg-white border border-gray-200 rounded-lg py-1 px-1 focus:outline-none focus:border-blue-400"
                              />
                              <button
                                onClick={() => setEditRows(clampRows((editRows ?? curRows) + 5))}
                                className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 font-bold text-sm hover:bg-gray-100 flex items-center justify-center"
                              >+</button>
                            </div>
                            <div className="text-[9px] text-gray-400 mt-1 text-center">Proportional zum Bild</div>
                          </div>
                        </div>
                        {/* Neu erstellen Button */}
                        <button
                          onClick={handleRerender}
                          disabled={loading || !userPhotoImg}
                          className={`w-full mt-3 py-2.5 rounded-xl text-sm font-bold transition-colors disabled:opacity-50 ${
                            colsChanged
                              ? 'bg-blue-600 hover:bg-blue-700 text-white'
                              : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                          }`}
                        >
                          {colsChanged
                            ? `Neu erstellen: ${clampCols(dispCols)} Sp. × ${clampRows(dispRows)} Z. = ${(clampCols(dispCols) * clampRows(dispRows)).toLocaleString('de-CH')} Kacheln`
                            : `Neu erstellen (${curCols} × ${curRows} Kacheln)`
                          }
                        </button>
                      </div>
                    </div>
                    );
                  })()}

                  {/* Hi-Res Status */}
                  <div className="mb-5 bg-green-50 rounded-xl p-3 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">Hi-Res Rendering</span>
                    {hiResReady ? (
                      <span className="text-xs font-semibold text-green-600 bg-green-100 rounded px-2 py-1">100% aktiv</span>
                    ) : hiResLoading ? (
                      <span className="text-xs font-semibold text-amber-600 bg-amber-100 rounded px-2 py-1">Wird geladen...</span>
                    ) : (
                      <span className="text-xs text-gray-500 bg-gray-100 rounded px-2 py-1">Wird automatisch vorbereitet…</span>
                    )}
                  </div>

                  {/* Foto-Overlay slider (inside modal) */}
                  {userPhotoImg && (
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-gray-700">Foto-Overlay</p>
                        <span className="text-xs font-bold text-blue-600 bg-blue-50 rounded px-2 py-0.5">{userOverlay}%</span>
                      </div>
                      <input
                        type="range" min={0} max={80} step={5} value={userOverlay}
                        onChange={e => setUserOverlay(Number(e.target.value))}
                        className="w-full h-2 rounded-full cursor-pointer"
                        style={{ accentColor: '#3B82F6' }}
                      />
                      <div className="flex justify-between text-xs text-gray-400 mt-1">
                        <span>Nur Mosaik</span>
                        <span>Mehr Originalfoto</span>
                      </div>
                    </div>
                  )}

                  {/* Color Enhance slider (inside modal) */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-gray-700">Color Enhance</p>
                      <span className="text-xs font-bold text-purple-600 bg-purple-50 rounded px-2 py-0.5">{colorEnhance}%</span>
                    </div>
                    <input
                      type="range" min={0} max={100} step={5} value={colorEnhance}
                      onChange={e => {
                        const v = Number(e.target.value);
                        setColorEnhance(v); colorEnhanceRef.current = v;
                        if (hiResReadyRef.current && (isMobile || zoom > 1.5)) {
                          resetHiRes();
                          setTimeout(() => { triggerClientHiResRef.current?.(); }, 50);
                        }
                      }}
                      className="w-full h-2 rounded-full cursor-pointer"
                      style={{ accentColor: '#8B5CF6' }}
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>Keine Verstärkung</span>
                      <span>Maximale Farbkorrektur</span>
                    </div>
                  </div>

                  <button onClick={() => setShowStatsModal(false)} className="w-full mt-2 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm font-semibold text-gray-700 transition-colors">
                    Schliessen
                  </button>
                </div>
              </div>
            )}

            {/* Compare slider */}
            {ready && userPhotoImg && (
              <div className="mb-6 bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-bold text-gray-800">Original vs. Mosaik</p>
                    <p className="text-xs text-gray-500">Schiebe den Regler um zu vergleichen</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setPopOutMode(m => !m); }}
                      className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-all ${popOutMode ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                    >
                      {popOutMode ? "Pop-Out AN" : "Pop-Out"}
                    </button>
                    <button
                      onClick={() => { setCompareMode(m => !m); if (!compareMode) setComparePos(50); }}
                      className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-all ${compareMode ? "bg-coral-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                    >
                      {compareMode ? "Vergleich AN" : "Vergleich AUS"}
                    </button>
                  </div>
                </div>
                {compareMode && (
                  <>
                    <div
                      className="relative w-full rounded-xl overflow-hidden cursor-col-resize select-none"
                      style={{ aspectRatio: `${canvasRef.current?.width ?? 1} / ${canvasRef.current?.height ?? 1}`, background: "#111" }}
                      onMouseDown={e => {
                        compareDragging.current = true;
                        const rect = e.currentTarget.getBoundingClientRect();
                        setComparePos(Math.round(((e.clientX - rect.left) / rect.width) * 100));
                      }}
                      onMouseMove={e => {
                        if (!compareDragging.current) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        setComparePos(Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100))));
                      }}
                      onMouseUp={() => { compareDragging.current = false; }}
                      onMouseLeave={() => { compareDragging.current = false; }}
                    >
                      <canvas
                        ref={el => {
                          if (el && snapshotRef.current && canvasRef.current) {
                            el.width = canvasRef.current.width;
                            el.height = canvasRef.current.height;
                            el.style.width = "100%"; el.style.height = "100%"; el.style.display = "block";
                            const ctx = el.getContext("2d");
                            if (ctx) ctx.putImageData(snapshotRef.current, 0, 0);
                          }
                        }}
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                      />
                      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${100 - comparePos}% 0 0)`, transition: "clip-path 0.05s ease" }}>
                        <img src={userPhotoImg.src} alt="Original" style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }} />
                      </div>
                      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${comparePos}%`, transform: "translateX(-50%)", width: 3, background: "white", boxShadow: "0 0 8px rgba(0,0,0,0.5)", transition: "left 0.05s ease", pointerEvents: "none" }}>
                        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 36, height: 36, borderRadius: "50%", background: "white", boxShadow: "0 2px 12px rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>👁️</div>
                      </div>
                      <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(0,0,0,0.6)", color: "white", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6 }}>Original</div>
                      <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(59,107,255,0.85)", color: "white", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6 }}>Mosaik</div>
                    </div>
                    <input type="range" min={0} max={100} step={1} value={comparePos} onChange={e => setComparePos(Number(e.target.value))} className="w-full h-2 rounded-full accent-coral-500 cursor-pointer mt-3" />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>Original</span>
                      <span className="font-semibold text-coral-600">{comparePos}%</span>
                      <span>Mosaik</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}


        {/* Order panel */}
        {ready && showOrderPanel && (
          <div className="bg-white rounded-2xl border border-coral-100 shadow-lg p-6 mb-8">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <Printer className="w-5 h-5 text-coral-600" />
                Jetzt bestellen
              </h2>
              <button onClick={() => setShowOrderPanel(false)} className="text-gray-400 hover:text-gray-700">
                <ChevronDown className="w-5 h-5" />
              </button>
            </div>

            {/* Digital / Print Tab Switcher */}
            <div className="flex gap-2 mb-5 bg-gray-100 rounded-xl p-1">
              <button
                onClick={() => setOrderMode('digital')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold transition-all ${
                  orderMode === 'digital'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Download className="w-4 h-4" />
                Digitale Datei
              </button>
              <button
                onClick={() => setOrderMode('print')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold transition-all ${
                  orderMode === 'print'
                    ? 'bg-white text-coral-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Printer className="w-4 h-4" />
                Druck bestellen
              </button>
            </div>

            {/* ===== DIGITAL MODE ===== */}
            {orderMode === 'digital' && (
              <>
                {/* Digital format selection */}
                <div className="mb-5">
                  <p className="text-sm font-bold text-gray-700 mb-3">Aufloesung waehlen</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {DIGITAL_FORMATS.map(({ label, desc, tilePx: rawTilePx, price, format }, idx) => {
                      const cols = mosaicParamsRef.current?.cols ?? 60;
                      const rows = mosaicParamsRef.current?.rows ?? 80;
                      // Replicate server-side clamping (MAX_DIM=32000, tilePx 32-256)
                      const SERVER_MAX_DIM = 16000;
                      let clampedTilePx = Math.min(Math.max(rawTilePx, 32), 256);
                      if (cols * clampedTilePx > SERVER_MAX_DIM || rows * clampedTilePx > SERVER_MAX_DIM) {
                        clampedTilePx = Math.min(Math.floor(SERVER_MAX_DIM / cols), Math.floor(SERVER_MAX_DIM / rows), clampedTilePx);
                        clampedTilePx = Math.max(32, clampedTilePx);
                      }
                      const outW = cols * clampedTilePx;
                      const outH = rows * clampedTilePx;
                      return (
                        <button
                          key={label}
                          onClick={() => setSelectedDigitalFormat(idx)}
                          className={`relative p-3 rounded-xl border-2 text-left transition-all ${
                            selectedDigitalFormat === idx
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-gray-100 hover:border-blue-200'
                          }`}
                        >
                          {idx === 2 && <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">Beliebt</div>}
                          <div className="text-xs font-bold text-gray-900">{label}</div>
                          <div className="text-[10px] text-gray-500 mt-0.5">{desc}</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">{outW.toLocaleString()}x{outH.toLocaleString()} px . {format.toUpperCase()}</div>
                          <div className="text-xs text-blue-700 font-bold mt-1">CHF {price}</div>
                          {selectedDigitalFormat === idx && <Check className="w-3 h-3 text-blue-600 absolute top-1 right-1" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Digital order summary */}
                <div className="bg-blue-50 rounded-xl p-4 mb-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-gray-900">Digitale Datei - {DIGITAL_FORMATS[selectedDigitalFormat].label}</p>
                      <p className="text-sm text-gray-500">Sofort-Download . Ohne Wasserzeichen . {DIGITAL_FORMATS[selectedDigitalFormat].format.toUpperCase()}</p>
                    </div>
                    <div className="text-2xl font-extrabold text-blue-700">CHF {totalPrice}</div>
                  </div>
                </div>

                {/* Payment success banner */}
                {paymentSuccess && (
                  <div className="mb-4 bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2 text-green-800 text-sm font-semibold">
                    <Check className="w-4 h-4 text-green-600" />
                    Zahlung erfolgreich! Lade jetzt deine Datei herunter.
                    <button
                      onClick={handleDigitalDownload}
                      className="ml-auto flex items-center gap-1 bg-green-600 text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-green-700 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Herunterladen
                    </button>
                  </div>
                )}

                {paymentError && (
                  <div className="mb-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-800 text-xs">
                    {paymentError}
                  </div>
                )}

                <button
                  onClick={() => setShowPayModal(true)}
                  disabled={paymentLoading}
                  className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-bold py-3.5 rounded-xl shadow-md hover:shadow-lg transition-all disabled:opacity-60"
                >
                  {paymentLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                  Digitale Datei kaufen . CHF {totalPrice}
                </button>

                <div className="flex items-center justify-between mt-3">
                  <button
                    onClick={() => handleDownload(false)}
                    className="text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    Vorschau herunterladen (mit Wasserzeichen)
                  </button>
                  {isAdminMode && (
                    <button
                      onClick={handleAdminMaxDownload}
                      disabled={dlLoading}
                      className="text-xs text-amber-600 hover:text-amber-800 underline font-medium disabled:opacity-50"
                    >
                      {dlLoading ? 'Rendere...' : 'Admin: Direkt herunterladen (max. Qualitaet)'}
                    </button>
                  )}
                </div>

                {/* Inline Download Progress */}
                {(dlLoading || dlProgressMsg) && (
                  <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-blue-800 truncate pr-2">{dlProgressMsg || 'Verarbeite...'}</p>
                      <span className="text-lg font-bold text-blue-600 whitespace-nowrap">{dlProgress}%</span>
                    </div>
                    <div className="w-full bg-blue-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="h-2.5 rounded-full transition-all duration-500 ease-out"
                        style={{
                          width: `${Math.max(dlProgress, 2)}%`,
                          background: 'linear-gradient(90deg, #3B82F6 0%, #2563EB 100%)',
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ===== PRINT MODE ===== */}
            {orderMode === 'print' && (
              <>
                {/* Print info: format derived from grid (cols cm × rows cm @ 1cm/tile, 400 DPI) */}
                {(() => {
                  const printCols = mosaicParamsRef.current?.cols ?? 120;
                  const printRows = mosaicParamsRef.current?.rows ?? 90;
                  // 1 tile = 1 cm → poster size in cm = cols × rows
                  // tilePx at 400 DPI: 1 cm × (400/2.54) ≈ 157 px
                  const TILE_PX_400DPI = 157;
                  const outW = printCols * TILE_PX_400DPI;
                  const outH = printRows * TILE_PX_400DPI;
                  return (
                    <>
                      {/* Blue info box: poster format derived from grid */}
                      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-5 text-sm">
                        <p className="font-bold text-blue-800 mb-2">Druckqualitaet &amp; Poster-Groesse</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <span className="text-blue-600 font-medium">Poster-Groesse:</span>
                          <span className="text-blue-900 font-bold">{printCols} × {printRows} cm</span>
                          <span className="text-blue-600 font-medium">Kachel-Groesse:</span>
                          <span className="text-blue-900 font-bold">10mm × 10mm ✓</span>
                          <span className="text-blue-600 font-medium">Anzahl Kacheln:</span>
                          <span className="text-blue-900 font-bold">{printCols} × {printRows} = {(printCols * printRows).toLocaleString('de-CH')}</span>
                          <span className="text-blue-600 font-medium">Ausgabe-Pixel:</span>
                          <span className="text-blue-900 font-bold">{outW.toLocaleString()} × {outH.toLocaleString()} px</span>
                        </div>
                        <p className="text-[10px] text-blue-500 mt-2">400 DPI Druckqualitaet · JPG · Ideal fuer 20–30 cm Betrachtungsabstand</p>
                      </div>
                      {/* Order summary */}
                      <div className="bg-coral-50 rounded-xl p-4 mb-5">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-bold text-gray-900">Druck bestellen &ndash; {printCols}×{printRows} cm</p>
                            <p className="text-sm text-gray-500">Hochauflösende Druckdatei · {outW.toLocaleString()}×{outH.toLocaleString()} px · JPG</p>
                          </div>
                          <div className="text-2xl font-extrabold text-coral-700">CHF 29</div>
                        </div>
                      </div>
                    </>
                  );
                })()}

                {/* Order success banner */}
                {printolinoSuccess && (
                  <div className="mb-4 bg-green-50 border border-green-200 rounded-xl p-3 text-green-800 text-sm font-semibold">
                    <Check className="w-4 h-4 text-green-600 inline mr-2" />
                    Bestellung erstellt! Die Druckdatei erscheint im Admin-Bereich unter &quot;Kundenbestellungen&quot;.
                  </div>
                )}

                <button
                  onClick={handlePrintolinoOrder}
                  disabled={printolinoLoading || dlLoading}
                  className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-coral-500 to-coral-600 hover:from-coral-600 hover:to-coral-700 text-white font-bold py-3.5 rounded-xl shadow-md hover:shadow-lg transition-all disabled:opacity-60"
                >
                  {(printolinoLoading || dlLoading) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
                  {`Druck bestellen · ${mosaicParamsRef.current?.cols ?? 120}×${mosaicParamsRef.current?.rows ?? 90} cm · CHF 29`}
                </button>

                <div className="flex items-center justify-between mt-3">
                  <button
                    onClick={() => handleDownload(false)}
                    className="text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    Vorschau herunterladen (mit Wasserzeichen)
                  </button>
                  {isAdminMode && (
                    <button
                      onClick={handleAdminMaxDownload}
                      disabled={dlLoading}
                      className="text-xs text-amber-600 hover:text-amber-800 underline font-medium disabled:opacity-50"
                    >
                      {dlLoading ? 'Rendere...' : 'Admin: Direkt herunterladen (max. Qualitaet)'}
                    </button>
                  )}
                </div>

                                {/* Inline Download Progress (Print) */}
                {(dlLoading || dlProgressMsg) && (
                  <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-blue-800 truncate pr-2">{dlProgressMsg || 'Verarbeite...'}</p>
                      <span className="text-lg font-bold text-blue-600 whitespace-nowrap">{dlProgress}%</span>
                    </div>
                    <div className="w-full bg-blue-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="h-2.5 rounded-full transition-all duration-500 ease-out"
                        style={{
                          width: `${Math.max(dlProgress, 2)}%`,
                          background: 'linear-gradient(90deg, #3B82F6 0%, #2563EB 100%)',
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Upload new photo CTA */}
        {ready && (
          <div className="text-center">
            <button
              onClick={() => uploadRef.current?.click()}
              className="inline-flex items-center gap-2 bg-white border-2 border-gray-200 hover:border-coral-200 text-gray-700 hover:text-coral-700 font-semibold px-6 py-3 rounded-2xl transition-all"
            >
              <Upload className="w-4 h-4" />
              Anderes Foto hochladen
            </button>
            <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
          </div>
        )}

        {/* Info box */}
        {!userPhoto && !loading && (
          <div className="max-w-xl mx-auto mt-8 bg-coral-50 border border-coral-100 rounded-2xl p-5 text-center">
            <p className="text-sm font-semibold text-coral-800 mb-1">Kostenlose Vorschau</p>
            <p className="text-xs text-coral-600">Die Vorschau ist kostenlos. Erst beim Bestellen des Drucks fallen Kosten an.</p>
            <Link to="/preise" className="inline-flex items-center gap-1 text-xs text-coral-700 hover:text-coral-900 font-semibold mt-2 underline">
              Alle Preise ansehen -&gt;
            </Link>
          </div>
        )}
      </div>

      {/* Stripe Payment Modal */}
      {/* Photo Preview Modal */}
      {showPhotoPreview && userPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.85)" }}
          onClick={() => setShowPhotoPreview(false)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] w-full"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowPhotoPreview(false)}
              className="absolute -top-10 right-0 text-white hover:text-gray-300 transition-colors"
            >
              <X className="w-7 h-7" />
            </button>
            <img
              src={userPhoto}
              alt="Dein Foto"
              className="w-full h-auto max-h-[85vh] object-contain rounded-xl shadow-2xl"
            />
            <p className="text-center text-white text-sm mt-3 opacity-70">Klick ausserhalb zum Schliessen</p>
          </div>
        </div>
      )}

      {/* Save Project Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">Projekt speichern</h3>
              <button onClick={() => setShowSaveModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tab: New vs Overwrite */}
            {user && (
              <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-0.5">
                <button
                  onClick={() => { setSaveMode('new'); setSelectedOverwriteId(null); }}
                  className={`flex-1 text-sm font-medium py-2 rounded-md transition-colors ${saveMode === 'new' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Neues Projekt
                </button>
                <button
                  onClick={() => { setSaveMode('overwrite'); fetchExistingProjects(); }}
                  className={`flex-1 text-sm font-medium py-2 rounded-md transition-colors ${saveMode === 'overwrite' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Überschreiben
                </button>
              </div>
            )}

            {saveMode === 'new' ? (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1">Projektname</label>
                <input
                  type="text"
                  value={saveProjectName}
                  onChange={e => setSaveProjectName(e.target.value)}
                  placeholder="z.B. Familienportrait, Hochzeit 2024..."
                  className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 focus:border-green-400 mb-4"
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && !savingProject) saveProject(saveProjectName); }}
                />
              </>
            ) : (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Projekt zum Überschreiben wählen</label>
                {loadingExistingProjects ? (
                  <div className="flex justify-center py-4"><RefreshCw className="w-5 h-5 text-gray-300 animate-spin" /></div>
                ) : existingProjects.length === 0 ? (
                  <p className="text-sm text-gray-400 py-3 text-center">Keine bestehenden Projekte</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto space-y-1.5 border border-gray-200 rounded-xl p-2">
                    {existingProjects.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedOverwriteId(p.id); setSaveProjectName(p.name); }}
                        className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${
                          selectedOverwriteId === p.id ? 'bg-green-50 border border-green-300' : 'hover:bg-gray-50 border border-transparent'
                        }`}
                      >
                        <div className="w-10 h-10 rounded-lg bg-gray-100 overflow-hidden flex-shrink-0">
                          {p.thumbnail_url ? (
                            <img src={p.thumbnail_url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-300">
                              <FolderOpen className="w-4 h-4" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                          <p className="text-xs text-gray-400">{new Date(p.updated_at).toLocaleDateString('de-CH')}</p>
                        </div>
                        {selectedOverwriteId === p.id && (
                          <span className="text-green-600 text-xs font-semibold flex-shrink-0">Gewählt</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setShowSaveModal(false)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={() => {
                  if (saveMode === 'overwrite' && selectedOverwriteId) {
                    saveProject(saveProjectName, selectedOverwriteId);
                  } else {
                    saveProject(saveProjectName);
                  }
                }}
                disabled={savingProject || (saveMode === 'overwrite' && !selectedOverwriteId)}
                className="flex-1 px-4 py-2.5 rounded-xl bg-green-500 hover:bg-green-600 disabled:bg-green-300 text-white text-sm font-semibold transition-colors"
              >
                {savingProject ? 'Speichert...' : saveMode === 'overwrite' ? 'Überschreiben' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">Jetzt kaufen</h3>
              <button onClick={() => setShowPayModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-coral-50 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-gray-900">{PRINT_FORMATS[selectedFormat].label}</p>
                  <p className="text-sm text-gray-500">{MATERIALS[selectedMaterial].label} . Druckbereite PNG-Datei</p>
                  <p className="text-xs text-gray-400 mt-0.5">{PRINT_FORMATS[selectedFormat].pxW}x{PRINT_FORMATS[selectedFormat].pxH} px . {PRINT_FORMATS[selectedFormat].dpi} dpi . RGB</p>
                </div>
                <div className="text-2xl font-extrabold text-coral-700">CHF {totalPrice}</div>
              </div>
            </div>

            <div className="text-xs text-gray-500 mb-4 space-y-1">
              <p>OK Sofort-Download nach Zahlung</p>
              <p>OK Wasserzeichenfreie Druckdatei</p>
              <p>OK Printolino-konformes Format (RGB PNG)</p>
              <p>OK Sichere Zahlung via Stripe</p>
            </div>

            <button
              onClick={handleStripeCheckout}
              disabled={paymentLoading}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-coral-500 to-coral-600 hover:from-coral-600 hover:to-coral-700 text-white font-bold py-3.5 rounded-xl shadow-md hover:shadow-lg transition-all disabled:opacity-60 mb-3"
            >
              {paymentLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
              {paymentLoading ? "Weiterleitung..." : `CHF ${totalPrice} - Jetzt bezahlen`}
            </button>

            <p className="text-xs text-center text-gray-400">
              Gesichert durch Stripe . Kreditkarte, TWINT, PayPal
            </p>
          </div>
        </div>
      )}

      {/* Tile Detail Modal */}
      {tileDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.75)" }}
          onClick={() => setTileDetail(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5 relative"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setTileDetail(null)}
              className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 mb-4">
              <Search className="w-4 h-4 text-gray-500" />
              <p className="text-sm font-bold text-gray-800">Kachel-Detail</p>
            </div>

            {/* Tile image */}
            <div className="rounded-xl overflow-hidden border border-gray-200 mb-4 bg-gray-50">
              {tileDetail.tileUrl ? (
                <img
                  src={tileDetail.tileUrl}
                  alt={`Tile ${tileDetail.col},${tileDetail.row}`}
                  className="w-full aspect-square object-cover"
                  onError={(e) => {
                    // If primary URL fails (e.g. DB tile 404), try source_url (Pexels original ~940px)
                    const img = e.currentTarget;
                    if (img.dataset.retried) return;
                    img.dataset.retried = 'true';
                    // Try source_url via tile API with size=original
                    const tileId = tileIdsRef.current[tileDetail.tileIdx];
                    if (tileId && tileId > 0) {
                      img.src = `/api/tile/${tileId}?size=256`;
                      return;
                    }
                    // Last resort: extract from canvas (16px upscaled, blurry but better than nothing)
                    try {
                      const snap = snapshotRef.current;
                      const params = mosaicParamsRef.current;
                      if (snap && params) {
                        const { tilePx } = params;
                        const extractCanvas = document.createElement('canvas');
                        extractCanvas.width = tilePx; extractCanvas.height = tilePx;
                        const exCtx = extractCanvas.getContext('2d')!;
                        const srcX = tileDetail.col * tilePx, srcY = tileDetail.row * tilePx;
                        const tileData = exCtx.createImageData(tilePx, tilePx);
                        for (let py = 0; py < tilePx; py++) {
                          for (let px = 0; px < tilePx; px++) {
                            const si = ((srcY + py) * snap.width + (srcX + px)) * 4;
                            const di = (py * tilePx + px) * 4;
                            tileData.data[di] = snap.data[si];
                            tileData.data[di+1] = snap.data[si+1];
                            tileData.data[di+2] = snap.data[si+2];
                            tileData.data[di+3] = 255;
                          }
                        }
                        exCtx.putImageData(tileData, 0, 0);
                        img.src = extractCanvas.toDataURL('image/jpeg', 0.9);
                      }
                    } catch { /* ignore */ }
                  }}
                />
              ) : (
                <div className="w-full aspect-square flex items-center justify-center text-gray-400 text-sm">
                  Kein Bild
                </div>
              )}
            </div>

            {/* Tile info grid */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-gray-50 rounded-lg p-2.5">
                <span className="text-gray-400 block">Position</span>
                <span className="font-bold text-gray-800">Spalte {tileDetail.col + 1}, Zeile {tileDetail.row + 1}</span>
              </div>
              <div className="bg-gray-50 rounded-lg p-2.5">
                <span className="text-gray-400 block">Tile-Index</span>
                <span className="font-bold text-gray-800">#{tileDetail.tileIdx}</span>
              </div>
              <div className="bg-gray-50 rounded-lg p-2.5 col-span-2">
                <span className="text-gray-400 block mb-1">Zielfarbe an dieser Stelle</span>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md border border-gray-300" style={{ backgroundColor: tileDetail.cellColor }} />
                  <span className="font-mono font-bold text-gray-800">{tileDetail.cellColor}</span>
                </div>
              </div>
            </div>

            <p className="text-[10px] text-gray-400 mt-3 text-center">Klick auf eine Kachel im Mosaik um Details zu sehen</p>
          </div>
        </div>
      )}

      {/* ── Crop Modal ── */}
      {cropModalOpen && cropSrc && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.85)' }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col"
            style={{ maxHeight: '90vh' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900 text-base">Bildausschnitt wählen</p>
                <p className="text-xs text-gray-500 mt-0.5">Ziehe einen Rahmen um den gewünschten Bereich — z.B. Gesicht vergrößern</p>
              </div>
              <button
                onClick={() => {
                  setCropModalOpen(false);
                  // Use full image if user closes without cropping
                  if (cropSrc) applyCropAndSetPhoto(cropSrc, null);
                }}
                className="text-gray-400 hover:text-gray-700 ml-3 flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Crop area */}
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-gray-50">
              <ReactCrop
                crop={crop}
                onChange={(c) => setCrop(c)}
                onComplete={(c) => setCompletedCrop(c)}
                minWidth={50}
                minHeight={50}
                keepSelection
              >
                <img
                  ref={cropImgRef}
                  src={cropSrc}
                  alt="Zu croppende Bild"
                  style={{ maxWidth: '100%', maxHeight: '55vh', objectFit: 'contain', display: 'block' }}
                  onLoad={(e) => {
                    // Default: center crop covering 80% of the image
                    const { naturalWidth, naturalHeight } = e.currentTarget;
                    const defaultCrop = centerCrop(
                      makeAspectCrop({ unit: '%', width: 80 }, naturalWidth / naturalHeight, naturalWidth, naturalHeight),
                      naturalWidth, naturalHeight
                    );
                    setCrop(defaultCrop);
                  }}
                />
              </ReactCrop>
            </div>

            {/* Footer buttons */}
            <div className="px-5 pb-5 pt-3 flex gap-3 border-t border-gray-100">
              <button
                onClick={() => {
                  setCropModalOpen(false);
                  if (cropSrc) applyCropAndSetPhoto(cropSrc, null);
                }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Ganzes Bild verwenden
              </button>
              <button
                onClick={() => {
                  setCropModalOpen(false);
                  if (!cropSrc) return;
                  // Convert current crop (may be % or px) to pixel coordinates
                  const imgEl = cropImgRef.current;
                  if (imgEl && crop && crop.width && crop.height) {
                    const scaleX = imgEl.naturalWidth / imgEl.width;
                    const scaleY = imgEl.naturalHeight / imgEl.height;
                    let pixCrop: PixelCrop;
                    if (crop.unit === '%') {
                      pixCrop = {
                        unit: 'px',
                        x: Math.round((crop.x / 100) * imgEl.naturalWidth),
                        y: Math.round((crop.y / 100) * imgEl.naturalHeight),
                        width: Math.round((crop.width / 100) * imgEl.naturalWidth),
                        height: Math.round((crop.height / 100) * imgEl.naturalHeight),
                      };
                    } else {
                      pixCrop = {
                        unit: 'px',
                        x: Math.round(crop.x * scaleX),
                        y: Math.round(crop.y * scaleY),
                        width: Math.round(crop.width * scaleX),
                        height: Math.round(crop.height * scaleY),
                      };
                    }
                    applyCropAndSetPhoto(cropSrc, pixCrop);
                  } else {
                    applyCropAndSetPhoto(cropSrc, completedCrop);
                  }
                }}
                className="flex-1 py-2.5 rounded-xl bg-coral-500 text-white text-sm font-semibold hover:bg-coral-600 transition-colors"
                style={{ backgroundColor: '#e05c4b' }}
              >
                Ausschnitt verwenden
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
