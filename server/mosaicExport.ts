import sharp from "sharp";

export interface TileData {
  url: string;
  col: number;
  row: number;
}

/**
 * Renders a high-resolution mosaic PNG on the server using sharp.
 * Each tile is fetched (or decoded from base64), resized to tilePx×tilePx,
 * and composited onto a canvas. An optional overlay of the original image
 * is blended on top at the given alpha.
 */
export async function renderMosaicOnServer(params: {
  tiles: TileData[];
  cols: number;
  rows: number;
  tilePx: number;
  overlayBase64?: string;
  overlayAlpha?: number;
  dpi?: number;           // Output DPI metadata (default 300 for print quality)
  sharpen?: boolean;      // Apply post-sharpen after compositing (default true)
}): Promise<Buffer> {
  const { tiles, cols, rows, tilePx, overlayBase64, overlayAlpha = 0.0, dpi = 300, sharpen = true } = params;
  const canvasW = cols * tilePx;
  const canvasH = rows * tilePx;

  // Fetch all tile buffers in parallel (max 30 concurrent)
  const CONCURRENCY = 30;

  // Upgrade tile URLs to higher resolution for crisp mosaic output
  // Picsum: /id/X/80/80 → /id/X/400/400
  // Pexels: small (320px) → medium (1260px)
  // Unsplash: thumb (200px) → regular (1080px)
  function upgradeUrl(url: string): string {
    // Picsum: picsum.photos/id/NUMBER/WIDTH/HEIGHT pattern
    const picsumMatch = url.match(/picsum\.photos\/id\/([0-9]+)\/[0-9]+\/[0-9]+/);
    if (picsumMatch) {
      return `https://picsum.photos/id/${picsumMatch[1]}/400/400`;
    }
    const picsumMatch2 = url.match(/picsum\.photos\/([0-9]+)\/[0-9]+\/[0-9]+/);
    if (picsumMatch2) {
      return `https://picsum.photos/${picsumMatch2[1]}/400/400`;
    }
    // Pexels: upgrade small → medium for better quality
    if (url.includes('images.pexels.com') && url.includes('auto=compress')) {
      // Replace w=NNN&h=NNN with w=400&h=400 or remove size constraints
      return url.replace(/[?&]w=[0-9]+/g, '').replace(/[?&]h=[0-9]+/g, '') + '&w=400&h=400';
    }
    // Unsplash: upgrade thumb to regular (1080px wide)
    if (url.includes('images.unsplash.com') && (url.includes('w=200') || url.includes('q=80&w=200') || url.includes('thumb'))) {
      return url.replace(/[?&]w=[0-9]+/g, '').replace(/[?&]h=[0-9]+/g, '').replace(/[?&]q=[0-9]+/g, '') + '&w=400&q=85';
    }
    return url;
  }
  const compositeOps: sharp.OverlayOptions[] = [];

  for (let i = 0; i < tiles.length; i += CONCURRENCY) {
    const batch = tiles.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (tile) => {
        let tileBuffer: Buffer;
        if (tile.url.startsWith("data:")) {
          const base64 = tile.url.split(",")[1];
          tileBuffer = Buffer.from(base64, "base64");
        } else {
          const highResUrl = upgradeUrl(tile.url);
          const resp = await fetch(highResUrl, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          tileBuffer = Buffer.from(await resp.arrayBuffer());
        }
        const resized = await sharp(tileBuffer)
          .resize(tilePx, tilePx, { fit: "cover" })
          .png()
          .toBuffer();
        return { resized, col: tile.col, row: tile.row };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        compositeOps.push({
          input: result.value.resized,
          left: result.value.col * tilePx,
          top: result.value.row * tilePx,
        });
      }
    }
  }

  // Composite all tiles onto blank white canvas
  const tileCanvas = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(compositeOps)
    .png()
    .toBuffer();

  // Apply overlay of original image if provided
  if (overlayBase64 && overlayAlpha > 0) {
    const overlayBuffer = Buffer.from(overlayBase64, "base64");
    const alphaVal = Math.round(overlayAlpha * 255);
    // Resize overlay and apply alpha by modifying the alpha channel
    const overlayResized = await sharp(overlayBuffer)
      .resize(canvasW, canvasH, { fit: "fill" })
      .ensureAlpha()
      .toBuffer();

    // Apply alpha value to the overlay by using linear transform on alpha channel
    const overlayWithAlpha = await sharp(overlayResized)
      .joinChannel(
        Buffer.alloc(canvasW * canvasH, alphaVal),
        { raw: { width: canvasW, height: canvasH, channels: 1 } }
      )
      .png()
      .toBuffer();

    return sharp(tileCanvas)
      .composite([{ input: overlayWithAlpha, blend: "over" }])
      .png()
      .toBuffer();
  }

  // Post-sharpen for crisp tile edges (no overlay = no softening, so sharpen is effective)
  let result = tileCanvas;
  if (sharpen) {
    result = await sharp(tileCanvas)
      .sharpen({ sigma: 1.0, m1: 1.5, m2: 2.0 })
      .withMetadata({ density: dpi })
      .png({ quality: 95 })
      .toBuffer();
  } else {
    result = await sharp(tileCanvas)
      .withMetadata({ density: dpi })
      .png({ quality: 95 })
      .toBuffer();
  }
  return result;
}
