// ── Serverseitige kanonische Preistabelle (Single Source of Truth) ───────────
// Spiegelt die Client-Definitionen in client/src/pages/Studio.tsx (Zeilen 598-650).
// SICHERHEIT: Preise werden niemals vom Client-Request übernommen. Endpoints
// (Stripe-Checkout, Printolino-Order) lösen den Preis immer hier auf und
// ignorieren bzw. protokollieren abweichende Client-Werte.

// ── Digitale Download-Formate (Stripe-Checkout, digitaler Flow) ──────────────
export const DIGITAL_FORMATS = [
  { label: "HD", price: 19, tilePx: 100 },
  { label: "Ultra HD", price: 29, tilePx: 157 },
  { label: "PNG Lossless", price: 39, tilePx: 157 },
] as const;

// ── Legacy Print-Formate (Stripe-Flow, physische Formate) ────────────────────
export const PRINT_FORMATS = [
  { label: "40x40 cm", price: 69 },
  { label: "50x70 cm", price: 99 },
  { label: "70x70 cm", price: 139 },
  { label: "100x100 cm", price: 199 },
] as const;

// ── Material-Zuschläge (Legacy Stripe-Printflow) ─────────────────────────────
export const MATERIAL_SURCHARGES: Record<string, number> = {
  "Leinwand": 0,
  "Acrylglas": 20,
  "Alu-Dibond": 15,
  "Fotopapier": -10,
};

// ── Printolino-Preisformel (Preisliste 2022, exkl. MWST, .90-Rundung) ────────
const PRINTOLINO_MATERIALS: Record<string, { base: number; perCm2: number }> = {
  "Alu-Dibond": { base: 20, perCm2: 0.022 },
  "Poster": { base: 5, perCm2: 0.006 },
  "Leinwand": { base: 15, perCm2: 0.015 },
  "Acrylglas": { base: 25, perCm2: 0.032 },
};

/**
 * Berechnet den Printolino-Printpreis serverseitig aus Fläche + Material.
 * Gibt null zurück bei unbekanntem Material oder ungültigen Dimensionen.
 */
export function getPrintolinoPrice(cols: number, rows: number, materialLabel: string): number | null {
  const cfg = PRINTOLINO_MATERIALS[materialLabel];
  if (!cfg || !Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null;
  const raw = cfg.base + cols * rows * cfg.perCm2;
  // Round to nearest .90 (Printolino pricing convention, wie Client)
  return Math.round(raw / 10) * 10 - 0.10;
}

export interface CheckoutPriceResult {
  priceChf: number;
  productName: string;
  kind: 'digital' | 'print';
}

/**
 * Löst den Server-Preis für den Stripe-Checkout auf.
 * Priorität: digitale Formate (HD / Ultra HD / PNG Lossless) → danach
 * Legacy-Printformate zzgl. Materialzuschlag.
 * Gibt null zurück, wenn die Kombination unbekannt ist (→ Endpoint lehnt ab).
 */
export function resolveCheckoutPrice(formatLabel: string, materialLabel?: string): CheckoutPriceResult | null {
  const digital = DIGITAL_FORMATS.find(f => f.label === formatLabel);
  if (digital) {
    return {
      priceChf: digital.price,
      productName: `MosaicPrint – ${digital.label} (Digitale Datei)`,
      kind: 'digital',
    };
  }
  const print = PRINT_FORMATS.find(f => f.label === formatLabel);
  if (print) {
    const surcharge = materialLabel !== undefined ? (MATERIAL_SURCHARGES[materialLabel] ?? null) : 0;
    if (surcharge === null) return null; // unbekanntes Material
    return {
      priceChf: print.price + surcharge,
      productName: `MosaicPrint – ${print.label} auf ${materialLabel}`,
      kind: 'print',
    };
  }
  return null;
}
