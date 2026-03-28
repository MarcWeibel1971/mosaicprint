// Web Worker for parallel tile LAB color processing in print rendering.
// Each worker handles a horizontal strip of rows independently using OffscreenCanvas.

// ── Pre-computed LUTs (same as main thread, initialized once per worker) ──

const linearLUT = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  linearLUT[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function fastRgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = linearLUT[r], gl = linearLUT[g], bl = linearLUT[b];
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750);
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 0.137931;
  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 0.137931;
  const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 0.137931;
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const _LIN_STEPS = 4096;
const _linearToSrgb = new Uint8Array(_LIN_STEPS + 1);
for (let i = 0; i <= _LIN_STEPS; i++) {
  const v = i / _LIN_STEPS;
  _linearToSrgb[i] = Math.round((v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v) * 255);
}

function _toSrgbFast(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return _linearToSrgb[(v * _LIN_STEPS + 0.5) | 0];
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xv = (fx > 0.206897 ? fx * fx * fx : (fx - 16 / 116) / 7.787) * 0.95047;
  const yv = (fy > 0.206897 ? fy * fy * fy : (fy - 16 / 116) / 7.787) * 1.00000;
  const zv = (fz > 0.206897 ? fz * fz * fz : (fz - 16 / 116) / 7.787) * 1.08883;
  const rLin = xv * 3.2404542 - yv * 1.5371385 - zv * 0.4985314;
  const gLin = -xv * 0.9692660 + yv * 1.8760108 + zv * 0.0415560;
  const bLin = xv * 0.0556434 - yv * 0.2040259 + zv * 1.0572252;
  return [_toSrgbFast(rLin), _toSrgbFast(gLin), _toSrgbFast(bLin)];
}

// ── Tile processing: exact same algorithm as main thread renderMosaicClientSide ──

interface TileTask {
  col: number;
  row: number;          // row within this worker's strip (0-based)
  assignment: number;   // tile image index
  rotation: number;
  tR: number; tG: number; tBv: number;
  tL: number; tA: number; tB: number;
  edgeVal: number;
  faceMaskVal: boolean;
}

interface RenderParams {
  actualTile: number;
  cols: number;
  L_BLEND: number;
  AB_BLEND: number;
  MAX_COLOR_SHIFT: number;
  MAX_BLUE_SHIFT: number;
  cBoost: number;
  BASE_OL: number;
  EDGE_B: number;
  olMode: string;
}

function processTile(
  bCtx: OffscreenCanvasRenderingContext2D,
  tileBitmaps: Map<number, ImageBitmap>,
  task: TileTask,
  params: RenderParams,
): Uint8ClampedArray | null {
  const { actualTile, L_BLEND, AB_BLEND, MAX_COLOR_SHIFT, MAX_BLUE_SHIFT, cBoost, BASE_OL, EDGE_B, olMode } = params;
  const { assignment, rotation: rot, tR, tG, tBv, tL, tA, tB, edgeVal, faceMaskVal } = task;

  const bmp = tileBitmaps.get(assignment);
  if (!bmp) return null;

  // Draw tile to offscreen buffer
  bCtx.clearRect(0, 0, actualTile, actualTile);
  if (rot === 0) {
    bCtx.drawImage(bmp, 0, 0, actualTile, actualTile);
  } else {
    bCtx.save();
    bCtx.translate(actualTile / 2, actualTile / 2);
    bCtx.rotate(rot * Math.PI / 2);
    bCtx.drawImage(bmp, -actualTile / 2, -actualTile / 2, actualTile, actualTile);
    bCtx.restore();
  }

  // Per-tile LAB color transfer
  const isShadowZone = tL < 40;
  const shadowBoost = isShadowZone ? Math.max(0, (40 - tL) / 40) : 0;
  const effectiveL_BLEND = Math.min(0.98, L_BLEND + shadowBoost * 0.50);

  const tilePixels = bCtx.getImageData(0, 0, actualTile, actualTile);
  const td = tilePixels.data;

  // 8x8 subsample for average L
  const REF_N = 8;
  const stepY = Math.max(1, Math.floor(actualTile / REF_N));
  const stepX = Math.max(1, Math.floor(actualTile / REF_N));
  let sumL = 0, pCount = 0;
  for (let sy = 0; sy < REF_N; sy++) {
    const py = Math.min(sy * stepY, actualTile - 1);
    for (let sx = 0; sx < REF_N; sx++) {
      const px = Math.min(sx * stepX, actualTile - 1);
      const pi = (py * actualTile + px) * 4;
      sumL += fastRgbToLab(td[pi], td[pi + 1], td[pi + 2])[0];
      pCount++;
    }
  }
  const avgL = pCount > 0 ? sumL / pCount : 50;
  const rawLumScale = avgL > 1 ? tL / avgL : 1;
  const maxLumScale = isShadowZone ? Math.min(1.0, rawLumScale) : rawLumScale;
  const clampedLumScale = Math.max(0.05, Math.min(4.0, maxLumScale));
  const lumScale = 1 + (clampedLumScale - 1) * effectiveL_BLEND;

  // Overlay strength
  const edge = edgeVal;
  const fb = faceMaskVal ? 0.04 : 0;
  const str = olMode !== 'none' ? Math.min(0.30, BASE_OL + edge * EDGE_B + fb) : 0;
  const applyOverlay = str > 0.01;

  // Per-pixel LAB transform
  const outData = new Uint8ClampedArray(td.length);
  for (let pi = 0; pi < td.length; pi += 4) {
    const [pl, pa, pb] = fastRgbToLab(td[pi], td[pi + 1], td[pi + 2]);
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
    if (applyOverlay) {
      if (olMode === 'softlight') {
        const sl2 = (base: number, blend: number) => {
          const b2 = blend / 255, s = base / 255;
          return Math.round((b2 < 0.5 ? s - (1 - 2 * b2) * s * (1 - s) : s + (2 * b2 - 1) * (Math.sqrt(s) - s)) * 255);
        };
        nr = Math.round(nr * (1 - str) + sl2(nr, tR) * str);
        ng = Math.round(ng * (1 - str) + sl2(ng, tG) * str);
        nb = Math.round(nb * (1 - str) + sl2(nb, tBv) * str);
      } else {
        nr = Math.round(nr * (1 - str) + tR * str);
        ng = Math.round(ng * (1 - str) + tG * str);
        nb = Math.round(nb * (1 - str) + tBv * str);
      }
    }
    outData[pi] = nr;
    outData[pi + 1] = ng;
    outData[pi + 2] = nb;
    outData[pi + 3] = td[pi + 3];
  }
  return outData;
}

// ── Message handler ──

self.onmessage = function (e: MessageEvent) {
  const { type } = e.data;

  if (type === 'renderStrip') {
    const {
      tileBitmaps: bitmapMap,  // Record<number, ImageBitmap>
      tasks,                    // TileTask[]
      params,                   // RenderParams
      stripRows,                // number of rows in this strip
      workerId,                 // for identification
    } = e.data as {
      tileBitmaps: Record<number, ImageBitmap>;
      tasks: TileTask[];
      params: RenderParams;
      stripRows: number;
      workerId: number;
      type: string;
    };

    const { actualTile, cols } = params;
    const stripW = cols * actualTile;
    const stripH = stripRows * actualTile;

    // Convert bitmap record to Map
    const bmpMap = new Map<number, ImageBitmap>();
    for (const [k, v] of Object.entries(bitmapMap)) {
      bmpMap.set(Number(k), v);
    }

    // Create strip canvas
    const stripCanvas = new OffscreenCanvas(stripW, stripH);
    const stripCtx = stripCanvas.getContext('2d')!;

    // Buffer canvas for per-tile processing
    const bCanvas = new OffscreenCanvas(actualTile, actualTile);
    const bCtx = bCanvas.getContext('2d')!;
    bCtx.imageSmoothingEnabled = true;
    bCtx.imageSmoothingQuality = 'high';

    let processed = 0;
    for (const task of tasks) {
      const x = task.col * actualTile;
      const y = task.row * actualTile;  // row is relative to strip

      const outData = processTile(bCtx, bmpMap, task, params);
      if (outData) {
        const imgData = new ImageData(outData, actualTile, actualTile);
        bCtx.putImageData(imgData, 0, 0);
        stripCtx.drawImage(bCanvas, x, y);
      } else {
        // Fallback: fill with target color
        stripCtx.fillStyle = `rgb(${task.tR},${task.tG},${task.tBv})`;
        stripCtx.fillRect(x, y, actualTile, actualTile);
      }

      processed++;
      // Report progress every 50 tiles
      if (processed % 50 === 0) {
        (self as unknown as Worker).postMessage({
          type: 'progress',
          workerId,
          processed,
          total: tasks.length,
        });
      }
    }

    // Transfer the strip as ImageBitmap (zero-copy)
    const result = stripCanvas.transferToImageBitmap();
    (self as unknown as Worker).postMessage(
      { type: 'stripDone', workerId, bitmap: result },
      [result],
    );
  }
};
