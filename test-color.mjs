// Test rgbToLab → labToRgb roundtrip to identify blue tint source
// Replicate the exact same code from Studio.tsx and colorUtils.ts

// ─── rgbToLab from colorUtils.ts ───
const _srgbToLinear = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  _srgbToLinear[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

const _CBRT_STEPS = 4096;
const _CBRT_MAX = 1.5;
const _cbrtLut = new Float32Array(_CBRT_STEPS + 1);
for (let i = 0; i <= _CBRT_STEPS; i++) {
  _cbrtLut[i] = Math.cbrt(i / _CBRT_STEPS * _CBRT_MAX);
}
const _cbrtFast = (t) => {
  if (t <= 0) return 0;
  if (t >= _CBRT_MAX) return _cbrtLut[_CBRT_STEPS];
  const idx = (t / _CBRT_MAX) * _CBRT_STEPS;
  const lo = idx | 0;
  const frac = idx - lo;
  return _cbrtLut[lo] + frac * (_cbrtLut[lo + 1] - _cbrtLut[lo]);
};

function rgbToLab(r, g, b) {
  const rl = _srgbToLinear[r & 0xFF], gl = _srgbToLinear[g & 0xFF], bl = _srgbToLinear[b & 0xFF];
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t) => t > 0.008856 ? _cbrtFast(t) : 7.787 * t + 16 / 116;
  const L = 116 * f(y) - 16;
  const a = 500 * (f(x) - f(y));
  const bv = 200 * (f(y) - f(z));
  return [L, a, bv];
}

// ─── labToRgb from Studio.tsx ───
const _LIN_STEPS = 4096;
const _linearToSrgb = new Uint8Array(_LIN_STEPS + 1);
for (let i = 0; i <= _LIN_STEPS; i++) {
  const v = i / _LIN_STEPS;
  _linearToSrgb[i] = Math.round((v > 0.0031308 ? 1.055 * Math.pow(v, 1/2.4) - 0.055 : 12.92 * v) * 255);
}
const _toSrgbFast = (v) => {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return _linearToSrgb[(v * _LIN_STEPS + 0.5) | 0];
};

function labToRgb(L, a, b) {
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

// ─── Test roundtrip ───
console.log("=== RGB → LAB → RGB Roundtrip Test ===");
const testColors = [
  [255, 0, 0, "Red"],
  [0, 255, 0, "Green"],
  [0, 0, 255, "Blue"],
  [255, 255, 255, "White"],
  [128, 128, 128, "Gray"],
  [0, 0, 0, "Black"],
  [200, 150, 100, "Skin tone"],
  [180, 140, 120, "Warm beige"],
  [100, 80, 60, "Dark skin"],
  [220, 180, 140, "Light skin"],
  [50, 80, 120, "Blue-ish"],
  [139, 90, 43, "Brown"],
];

let maxDrift = [0, 0, 0];
let worstColor = "";

for (const [r, g, b, name] of testColors) {
  const [L, a, bv] = rgbToLab(r, g, b);
  const [r2, g2, b2] = labToRgb(L, a, bv);
  const dr = r2 - r, dg = g2 - g, db = b2 - b;
  console.log(`${name.padEnd(15)} RGB(${r},${g},${b}) → LAB(${L.toFixed(1)},${a.toFixed(1)},${bv.toFixed(1)}) → RGB(${r2},${g2},${b2})  Δ(${dr},${dg},${db})`);
  if (Math.abs(db) > Math.abs(maxDrift[2])) {
    maxDrift = [dr, dg, db];
    worstColor = name;
  }
}

// ─── Test color correction simulation ───
console.log("\n=== Color Correction Simulation (8% Farbkorrektur) ===");
// Simulate what happens with AB_BLEND at 8% colorEnhance
// colorEnhance = 8 → colorEnhanceVal = 0.08
// histogramBlend is separate from colorEnhance slider
// Let's check: what does the Farbkorrektur slider actually control?

// From the code: the Farbkorrektur slider is `colorEnhance` (0-100)
// In renderMosaic: AB_BLEND_BASE * (0.5 + 0.5 * colorEnhanceVal)
// At 8%: colorEnhanceVal = 0.08, so factor = 0.5 + 0.5*0.08 = 0.54
// AB_BLEND_BASE comes from histogramBlend setting

// But in the main render (renderMosaicClientSide), the code uses:
// AB_BLEND = 0.12 + 0.20 * blendFactor (from histogramBlend, NOT colorEnhance)
// So where does colorEnhance actually take effect?

console.log("Checking: where does colorEnhance slider actually affect rendering?");
console.log("The main renderMosaicClientSide uses histogramBlend (savedSettings), NOT colorEnhance directly.");
console.log("colorEnhance might only affect the overlay image, not the base mosaic.");

// Test: simulate AB shift with typical values
const skinTone = [200, 150, 100]; // warm skin
const targetLab = [60, 10, 30]; // warm target
const [pL, pA, pB] = rgbToLab(...skinTone);
console.log(`\nSkin pixel: RGB(${skinTone}) → LAB(${pL.toFixed(1)}, ${pA.toFixed(1)}, ${pB.toFixed(1)})`);
console.log(`Target LAB: (${targetLab})`);

const AB_BLEND = 0.12;
const rawDeltaB = (targetLab[2] - pB) * AB_BLEND;
console.log(`AB_BLEND=${AB_BLEND}, rawDeltaB=${rawDeltaB.toFixed(2)}`);
console.log(`If target has lower b than tile → negative delta → blue shift!`);

// Test with blue target (sky area)
const blueTarget = [50, -5, -20]; // blue sky target
const rawDeltaB2 = (blueTarget[2] - pB) * AB_BLEND;
console.log(`\nBlue sky target LAB: (${blueTarget})`);
console.log(`rawDeltaB for skin tile in blue area = ${rawDeltaB2.toFixed(2)} → BLUE SHIFT`);
console.log(`MAX_BLUE_SHIFT = 10, so clamped to max -10`);
console.log(`But even -10 in b* is a VISIBLE blue tint!`);
