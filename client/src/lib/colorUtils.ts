/**
 * colorUtils.ts – Gemeinsame Farb-Konvertierungs-Utilities (Client-seitig)
 *
 * Konsolidiert rgbToLab / toLinear / deltaE2000, die zuvor in Studio.tsx (2x)
 * und Admin.tsx dupliziert waren. Einzige Quelle der Wahrheit für LAB-Berechnungen
 * auf dem Client.
 *
 * Referenz: IEC 61966-2-1 (sRGB) + CIE 1976 L*a*b* (D65 Illuminant)
 */

// ─── Gamma-LUT: sRGB (0-255) → Linear (Float64) ───────────────────────────
// Precomputed once at module load. Eliminates Math.pow(2.4) in the hot path.
const _srgbToLinear = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  _srgbToLinear[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// ─── cbrt-LUT: XYZ values in [0, 1.5] → cbrt(t) ──────────────────────────
// XYZ components after D65 normalization are typically in [0, ~1.2].
// We use 4096 entries over [0, 1.5] for ~0.00037 step → sub-0.01 LAB error.
const _CBRT_STEPS = 4096;
const _CBRT_MAX = 1.5;
const _cbrtLut = new Float32Array(_CBRT_STEPS + 1);
for (let i = 0; i <= _CBRT_STEPS; i++) {
  _cbrtLut[i] = Math.cbrt(i / _CBRT_STEPS * _CBRT_MAX);
}
const _cbrtFast = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= _CBRT_MAX) return _cbrtLut[_CBRT_STEPS];
  const idx = (t / _CBRT_MAX) * _CBRT_STEPS;
  const lo = idx | 0;
  const frac = idx - lo;
  return _cbrtLut[lo] + frac * (_cbrtLut[lo + 1] - _cbrtLut[lo]);
};

/** sRGB-Linearisierung (IEC 61966-2-1) — LUT-accelerated */
export function toLinear(c: number): number {
  return _srgbToLinear[c & 0xFF];
}

/**
 * RGB (0–255) → CIE L*a*b* (D65) — LUT-accelerated (no Math.pow/cbrt in hot path)
 * Gibt [L, a, b] zurück.
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = _srgbToLinear[r & 0xFF], gl = _srgbToLinear[g & 0xFF], bl = _srgbToLinear[b & 0xFF];
  // sRGB → XYZ (D65)
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t: number) => t > 0.008856 ? _cbrtFast(t) : 7.787 * t + 16 / 116;
  const L = 116 * f(y) - 16;
  const a = 500 * (f(x) - f(y));
  const bv = 200 * (f(y) - f(z));
  return [L, a, bv];
}

/**
 * CIEDE2000 Farbabstand (perceptually uniform)
 * Genauer als euklidischer DeltaE, besonders für Hauttöne und Neutralfarben.
 */
export function deltaE2000(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number
): number {
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360);
  const Lbar = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let Hbarp: number;
  if (C1p * C2p === 0) Hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) Hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) Hbarp = (h1p + h2p + 360) / 2;
  else Hbarp = (h1p + h2p - 360) / 2;
  const T = 1
    - 0.17 * Math.cos((Hbarp - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * Hbarp * Math.PI / 180)
    + 0.32 * Math.cos((3 * Hbarp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * Hbarp - 63) * Math.PI / 180);
  const SL = 1 + 0.015 * (Lbar - 50) * (Lbar - 50) / Math.sqrt(20 + (Lbar - 50) * (Lbar - 50));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const dTheta = 30 * Math.exp(-((Hbarp - 275) / 25) * ((Hbarp - 275) / 25));
  const RT = -Math.sin(2 * dTheta * Math.PI / 180) * RC;
  return Math.sqrt(
    (dLp / (kL * SL)) ** 2 +
    (dCp / (kC * SC)) ** 2 +
    (dHp / (kH * SH)) ** 2 +
    RT * (dCp / (kC * SC)) * (dHp / (kH * SH))
  );
}
