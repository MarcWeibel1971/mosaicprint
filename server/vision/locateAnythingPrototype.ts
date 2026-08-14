/**
 * INTERNAL R&D ONLY — not imported by the production server.
 *
 * Converts LocateAnything's textual grounding tokens into normalised boxes and
 * an optional coarse MosaicPrint cell mask. This module never contacts a model
 * and intentionally contains no credentials or customer-image handling.
 */
export type NormalizedBox = {
  label: string;
  /** [x1, y1, x2, y2], each normalised to a 0–1000 coordinate space. */
  box: [number, number, number, number];
};

const refOrBoxPattern = /<ref>([\s\S]*?)<\/ref>|<box>([\s\S]*?)<\/box>/gi;
const coordinatePattern = /<\s*([0-9]+(?:\.[0-9]+)?)\s*>/g;

function clampCoordinate(value: number): number {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

/** Parses LocateAnything output such as `<ref>face</ref><box><120><80><640><920></box>`. */
export function parseLocateAnythingBoxes(rawText: string, fallbackLabel = "subject"): NormalizedBox[] {
  const boxes: NormalizedBox[] = [];
  let activeLabel = fallbackLabel;

  for (const match of rawText.matchAll(refOrBoxPattern)) {
    if (match[1] !== undefined) {
      const proposedLabel = match[1].replace(/\s+/g, " ").trim();
      if (proposedLabel) activeLabel = proposedLabel.slice(0, 120);
      continue;
    }

    const coordinates = [...(match[2] ?? "").matchAll(coordinatePattern)]
      .map((coordinate) => clampCoordinate(Number(coordinate[1])));
    if (coordinates.length !== 4) continue;

    const [x1, y1, x2, y2] = coordinates;
    if (x2 <= x1 || y2 <= y1) continue;
    boxes.push({ label: activeLabel, box: [x1, y1, x2, y2] });
  }

  return boxes;
}

/**
 * Marks mosaic cells intersecting one or more normalised boxes. This is a
 * visualisation aid for internal comparison only; it changes no rendering.
 */
export function boxesToCellMask(boxes: NormalizedBox[], cols: number, rows: number): Uint8Array {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error("cols and rows must be positive integers");
  }

  const mask = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellIndex = row * cols + col;
      const centerX = ((col + 0.5) / cols) * 1000;
      const centerY = ((row + 0.5) / rows) * 1000;
      if (boxes.some(({ box: [x1, y1, x2, y2] }) => centerX >= x1 && centerX <= x2 && centerY >= y1 && centerY <= y2)) {
        mask[cellIndex] = 1;
      }
    }
  }
  return mask;
}
