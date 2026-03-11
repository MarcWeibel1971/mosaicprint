import React, { useState, useCallback, useRef, useEffect } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Link } from "react-router-dom";
import {
  Upload, ZoomIn, ZoomOut, Download, Printer, Eye,
  Loader2, X, RefreshCw, ExternalLink, ChevronDown, Check
} from "lucide-react";
import { buildUnsplashPool, UNSPLASH_PHOTO_IDS } from "../lib/unsplash-pool";
import { loadImageCached, getMemoryCacheSize, getIDBCacheSize, warmUpCache } from "../lib/image-cache";

// ── Picsum fallback pool ──────────────────────────────────────────────────────
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

// LAB → RGB (inverse of rgbToLab)
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
  const toSrgb = (v: number) => Math.max(0, Math.min(255, Math.round((v > 0.0031308 ? 1.055 * Math.pow(v, 1/2.4) - 0.055 : 12.92 * v) * 255)));
  return [toSrgb(rLin), toSrgb(gLin), toSrgb(bLin)];
}

// RGB → LAB
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.00000;
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

// Printolino-konforme Druckformate
// Pixelgrösse bei 150 dpi: px = cm × (150 / 2.54) = cm × 59.055
// Mindestanforderung Printolino: 72 dpi (= 28.35 px/cm)
// Empfehlung: 150 dpi für gutes Ergebnis bei handhabbarerDateigrösse
const PRINT_FORMATS = [
  { label: "20×20 cm",   widthCm: 20,  heightCm: 20,  price: 29,  dpi: 150, pxW: 1181, pxH: 1181 },
  { label: "30×30 cm",   widthCm: 30,  heightCm: 30,  price: 49,  dpi: 150, pxW: 1772, pxH: 1772 },
  { label: "40×40 cm",   widthCm: 40,  heightCm: 40,  price: 69,  dpi: 150, pxW: 2362, pxH: 2362 },
  { label: "50×70 cm",   widthCm: 50,  heightCm: 70,  price: 99,  dpi: 150, pxW: 2953, pxH: 4134 },
  { label: "70×70 cm",   widthCm: 70,  heightCm: 70,  price: 139, dpi: 150, pxW: 4134, pxH: 4134 },
  { label: "100×100 cm", widthCm: 100, heightCm: 100, price: 199, dpi: 150, pxW: 5906, pxH: 5906 },
];

const MATERIALS = [
  { label: "Leinwand", surcharge: 0, icon: "🖼️" },
  { label: "Acrylglas", surcharge: 20, icon: "✨" },
  { label: "Alu-Dibond", surcharge: 15, icon: "🔲" },
  { label: "Fotopapier", surcharge: -10, icon: "📄" },
];

export default function Studio() {
  const [userPhoto, setUserPhoto] = useState<string | null>(null);
  const [userPhotoImg, setUserPhotoImg] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [sharpness, setSharpness] = useState(80);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePos, setComparePos] = useState(50);
  const [selectedFormat, setSelectedFormat] = useState(1); // 30×30 default
  const [selectedMaterial, setSelectedMaterial] = useState(0); // Leinwand default
  const [showOrderPanel, setShowOrderPanel] = useState(false);
  const [cacheSize, setCacheSize] = useState(0);
  const [dbTileCount, setDbTileCount] = useState<number | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [detectedImageType, setDetectedImageType] = useState<'portrait' | 'landscape' | 'abstract' | null>(null);
  const [autoPresetApplied, setAutoPresetApplied] = useState<string | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<string>('alle'); // Theme filter for tile pool
  const selectedThemeRef = useRef<string>('alle'); // Ref for use inside renderMosaic callback

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
  // Format: [id, L, a, b, edge, brightness, saturation] × 7 floats × 4 bytes = 28 bytes/tile
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiResCanvasRef = useRef<HTMLCanvasElement>(null); // second canvas for hi-res zoom
  const uploadRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const snapshotRef = useRef<ImageData | null>(null);
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
  const floatsPerTileRef = useRef<number>(4); // 4 (legacy), 7 (7D), or 14 (14D with quadrant colors)
  const mosaicParamsRef = useRef<{cols:number; rows:number; tilePx:number; canvasW:number; canvasH:number} | null>(null);
  const [hiResReady, setHiResReady] = useState(false);
  const [hiResLoading, setHiResLoading] = useState(false);

  // HI-RES: threshold for activating hi-res canvas
    // Multi-tier zoom thresholds:
    // zoom < 1.2 → 64px tiles (preview, already loaded)
    // zoom 1.2–1.8 → 128px tiles (medium zoom)
    // zoom > 1.8 → 200px tiles (high zoom, crisp detail)
    const HI_RES_THRESHOLD = 1.2;
    const ULTRA_RES_THRESHOLD = 1.8;
    const showHiRes = ready && zoom >= HI_RES_THRESHOLD && sharpness > 0;
    // Determine which resolution tier to use
    const hiResTileSize = zoom >= ULTRA_RES_THRESHOLD ? 200 : 128;
    // Hi-res canvas opacity: starts at 0.5 at threshold, reaches sharpness% at zoom 2×
    const hiResOpacity = showHiRes && hiResReady
      ? Math.min(1.0, 0.5 + (zoom - HI_RES_THRESHOLD) / 0.8) * (sharpness / 100)
      : 0;

  /** Convert a tile URL or /api/tile/:id URL to a higher-resolution version */
  const toHiResUrl = (url: string, size = 400) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    // Already a proxied tile URL: just change the size param
    const tileMatch = url.match(/\/api\/tile\/(\d+)/);
    if (tileMatch) return `/api/tile/${tileMatch[1]}?size=${size}`;
    // Legacy external URLs (fallback)
    let hi = url.replace(/([?&])w=\d+/, `$1w=${size}`).replace(/&h=\d+/, `&h=${size}`);
    hi = hi.replace(/(picsum\.photos\/id\/\d+\/)\d+\/\d+/, `$1${size}/${size}`);
    hi = hi.replace(/(picsum\.photos\/)\d+\/\d+$/, `$1${size}/${size}`);
    return hi;
  };

  // Track the last rendered hi-res tile size to re-render when zoom tier changes
  const lastHiResTileSizeRef = useRef<number>(0);

  // Render hi-res canvas when zoom crosses threshold or tier changes
  useEffect(() => {
    if (!showHiRes || hiResLoading) return;
    if (!assignmentRef.current.length || !validImgsRef.current.length || !mosaicParamsRef.current) return;
    // Only re-render if tile size tier changed (avoid redundant renders)
    if (hiResReady && lastHiResTileSizeRef.current === hiResTileSize) return;
    const renderHiRes = async () => {
      setHiResLoading(true);
      const { cols, rows, canvasW, canvasH } = mosaicParamsRef.current!;
      const HIREZ_PX = hiResTileSize; // 128px at medium zoom, 200px at high zoom
      const hiW = cols * HIREZ_PX, hiH = rows * HIREZ_PX;
      const hc = hiResCanvasRef.current;
      if (!hc) { setHiResLoading(false); return; }
      hc.width = hiW; hc.height = hiH;
      hc.style.width = `${Math.round(canvasW * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px`;
      hc.style.height = `${Math.round(canvasH * ((mosaicParamsRef.current as any)._displayScale ?? 0.5))}px`;
      const hCtx = hc.getContext('2d')!;
      // Load tiles at the appropriate resolution tier
      const hiResImgs: (HTMLImageElement | null)[] = [];
      const urlsToLoad = tileIdsRef.current.length > 0
        ? tileIdsRef.current.map(id => id > 0 ? `/api/tile/${id}?size=${HIREZ_PX}` : '')
        : validImgsRef.current.map(img => toHiResUrl(img.dataset.originalSrc || img.src, HIREZ_PX));
      const BATCH = 20;
      for (let i = 0; i < urlsToLoad.length; i += BATCH) {
        const batch = await Promise.all(
          urlsToLoad.slice(i, i + BATCH).map(u => u ? loadImageCached(u, 8000) : Promise.resolve(null))
        );
        hiResImgs.push(...batch);
        await new Promise(r => setTimeout(r, 0));
      }
      // Draw hi-res tiles
      const assignment = assignmentRef.current;
      const TOTAL = cols * rows;
      for (let ci = 0; ci < TOTAL; ci++) {
        const col = ci % cols, row = Math.floor(ci / cols);
        const img = hiResImgs[assignment[ci]] || validImgsRef.current[assignment[ci]];
        if (img && img.complete && img.naturalWidth > 0) {
          try {
            hCtx.drawImage(img, col * HIREZ_PX, row * HIREZ_PX, HIREZ_PX, HIREZ_PX);
          } catch (e) {
            // Broken image – fill with neutral grey placeholder
            hCtx.fillStyle = '#888888';
            hCtx.fillRect(col * HIREZ_PX, row * HIREZ_PX, HIREZ_PX, HIREZ_PX);
          }
        }
      }
      lastHiResTileSizeRef.current = HIREZ_PX;
      setHiResReady(true);
      setHiResLoading(false);
    };
    renderHiRes().catch(() => setHiResLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHiRes, hiResTileSize]);

  // Reset hi-res when new mosaic is rendered
  const resetHiRes = () => { setHiResReady(false); setHiResLoading(false); };

  const tilesRef = useRef<Array<{ x: number; y: number; px: number; url?: string }>>([]);

  const handleUpload = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setUserPhoto(dataUrl);
      const img = new Image();
      img.onload = async () => {
        setUserPhotoImg(img);
        setReady(false);
        setError(null);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setCompareMode(false);

        // ── Auto Portrait Detection ──────────────────────────────────────────
        // Detect if the image is a portrait (face-heavy) and auto-apply optimal settings
        try {
          const aspectRatio = img.naturalWidth / img.naturalHeight;
          let imageType: 'portrait' | 'landscape' | 'abstract' = 'abstract';

          // Step 1: Aspect ratio heuristic (portrait photos are usually taller than wide)
          const isVertical = aspectRatio < 0.85;

          // Step 2: Try browser FaceDetector API
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
              hasFace = faces.length > 0;
            } catch { /* FaceDetector not available */ }
          }

          // Step 3: Skin-tone heuristic (center region analysis)
          // Portrait photos typically have skin tones in the center
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
              if (r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15) skinPixels++;
              totalPixels++;
            }
            hasFace = skinPixels / totalPixels > 0.15; // >15% skin pixels in center
          }

          if (hasFace || isVertical) {
            imageType = 'portrait';
          } else if (aspectRatio > 1.3) {
            imageType = 'landscape';
          }

          setDetectedImageType(imageType);

          // Step 4: Auto-apply optimal preset if no custom settings exist
          const currentSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();
          const hasCustomSettings = Object.keys(currentSettings).length > 0;

          if (imageType === 'portrait' && !hasCustomSettings) {
            // Portrait preset: fine grid for sharp face details, strong brightness + SSD matching
            // More tiles (90 cols) + smaller tile size (12px) = 3× more cells for eyes/nose/mouth
            const portraitPreset = {
              baseTiles: 90,        // More columns = finer grid = sharper face details
              tilePx: 12,           // Smaller tiles = more detail in face regions
              neighborRadius: 5,    // wider anti-repetition radius for portrait
              neighborPenalty: 200, // strong anti-repetition
              contrastBoost: 1.25,  // stronger contrast for face clarity
              histogramBlend: 0.0,  // NO overlay – tiles match naturally
              labWeight: 0.12,
              brightnessWeight: 0.45, // KEY: brightness drives face structure without overlay
              textureWeight: 0.10,
              portraitMode: true,   // enables skin-tone boost in matching
            };
            localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(portraitPreset));
            // Also clear theme filter so ALL tiles are available for skin tone matching
            localStorage.removeItem('mosaicprint_selected_theme');
            setAutoPresetApplied('Portrait');
          } else if (imageType === 'landscape' && !hasCustomSettings) {
            // Landscape preset: wider tiles, more color accuracy, no overlay
            const landscapePreset = {
              baseTiles: 60,
              tilePx: 18,           // Even larger tiles for landscapes
              neighborRadius: 3,
              neighborPenalty: 120,
              contrastBoost: 1.15,
              histogramBlend: 0.0,  // NO overlay
              labWeight: 0.20,
              brightnessWeight: 0.35,
              textureWeight: 0.08,
            };
            localStorage.setItem('mosaicprint_algo_settings', JSON.stringify(landscapePreset));
            setAutoPresetApplied('Landschaft');
          }
        } catch (e) {
          console.warn('[Studio] Auto-detection failed:', e);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, []);

  // Auto-render when photo is loaded
  useEffect(() => {
    if (!userPhotoImg) return;
    const run = async () => {
      setLoading(true);
      setProgress(0);
      setProgressMsg("Initialisiere...");
      // Wait for React to re-render and mount the canvas into the DOM
      // before calling renderMosaic which needs canvasRef.current
      await new Promise(r => setTimeout(r, 50));
      try {
        await renderMosaic(userPhotoImg);
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

    const savedSettings = (() => { try { return JSON.parse(localStorage.getItem('mosaicprint_algo_settings') || '{}'); } catch { return {}; } })();
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

    // ═══════════════════════════════════════════════════════════════════════
    // SSD PIXEL-LEVEL MATCHING (inspired by Mosaicer open-source engine)
    // Instead of comparing 1 average color per tile, we compare EVERY PIXEL
    // of each tile against the corresponding target region.
    // This gives 192× more information (8×8×3 channels vs 1×3 channels).
    // ═══════════════════════════════════════════════════════════════════════

    const SSD_SIZE = 8; // Each tile & target region scaled to 8×8 for matching
    const TOTAL_TILES = COLS * ROWS;

    // Step 1: Create full-resolution target at SSD_SIZE per cell
    // Target image scaled to (COLS * SSD_SIZE) × (ROWS * SSD_SIZE)
    setProgressMsg("Analysiere Foto...");
    setProgress(5);
    const targetW = COLS * SSD_SIZE;
    const targetH = ROWS * SSD_SIZE;
    const targetCanvas = document.createElement("canvas");
    targetCanvas.width = targetW; targetCanvas.height = targetH;
    const targetCtx = targetCanvas.getContext("2d")!;
    targetCtx.drawImage(targetImg, 0, 0, targetW, targetH);
    const targetPixels = targetCtx.getImageData(0, 0, targetW, targetH).data;

    // Extract target region pixels for each cell (flattened RGB arrays)
    // targetRegions[cellIndex] = Uint8Array of SSD_SIZE*SSD_SIZE*3 values
    const targetRegions: Uint8Array[] = new Array(TOTAL_TILES);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const ci = row * COLS + col;
        const region = new Uint8Array(SSD_SIZE * SSD_SIZE * 3);
        let ri = 0;
        for (let py = 0; py < SSD_SIZE; py++) {
          for (let px = 0; px < SSD_SIZE; px++) {
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

    // Also keep a 1px-per-cell version for overlay/fallback
    const offscreen = document.createElement("canvas");
    offscreen.width = COLS; offscreen.height = ROWS;
    const offCtx = offscreen.getContext("2d")!;
    offCtx.drawImage(targetImg, 0, 0, COLS, ROWS);
    const targetData = offCtx.getImageData(0, 0, COLS, ROWS).data;

    // ── Low-Frequency Guidance (most important trick for mosaic quality) ──────
    // Apply Gaussian blur to extract low-frequency structure (face shape, shadows)
    // Matching against blurred target: clearer faces, less noisy mosaic
    const BLUR_RADIUS = 2; // blur in tile-grid pixels (= ~30px at 1:15 scale)
    const blurredData = new Uint8ClampedArray(targetData.length);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
        for (let dr = -BLUR_RADIUS; dr <= BLUR_RADIUS; dr++) {
          for (let dc = -BLUR_RADIUS; dc <= BLUR_RADIUS; dc++) {
            const nr = row + dr, nc = col + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
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
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = (row * COLS + col) * 4;
        // Mix: 70% blurred (structure) + 30% original (color accuracy)
        const r = blurredData[i] * 0.7 + targetData[i] * 0.3;
        const g = blurredData[i+1] * 0.7 + targetData[i+1] * 0.3;
        const b = blurredData[i+2] * 0.7 + targetData[i+2] * 0.3;
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
    for (let row = 1; row < ROWS - 1; row++) {
      for (let col = 1; col < COLS - 1; col++) {
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
        rawEdge[row * COLS + col] = mag;
        if (mag > maxEdge) maxEdge = mag;
      }
    }
    // Normalize edge map to 0-1
    const edgeNorm = maxEdge > 0 ? 1 / maxEdge : 1;
    for (let ci = 0; ci < TOTAL_TILES; ci++) {
      edgeMap[ci] = rawEdge[ci] * edgeNorm;
      saliency[ci] = edgeMap[ci]; // saliency = edge strength
    }

    // Step 2: 2-STAGE MATCHING
    // Stage A: LAB k-NN over ALL tiles in DB (no image loading needed)
    //   → For each mosaic cell, find Top-K candidates by LAB distance
    // Stage B: Load only the Top-K tile images, compute SSD, pick best
    //   → Only ~30 images per cell are ever loaded (vs 2000 before)
    //
    // This gives: better quality (all 12K tiles searched) + faster loading
    const isMobile = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
    const isMobileOrSlow = isMobile || (navigator as any).connection?.effectiveType === "2g";

     // ── Stage A: Load LAB index (if not already loaded) ──────────────────────
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
          if (currentTheme === 'alle') {
            labIndexRef.current = labIndex;
            labIndexLoadedRef.current = true;
          }
        }
      } catch { /* fallback to legacy below */ }
    }

    const FPT = floatsPerTileRef.current; // floats per tile: 4 (legacy), 7 (7D), or 14 (14D)
    const USE_2STAGE = labIndex !== null && labIndex.length >= FPT;
    const TOTAL_DB_TILES = USE_2STAGE ? Math.floor(labIndex!.length / FPT) : 0;
    const IS_7D = FPT >= 7;
    const IS_14D = FPT >= 14;
    console.log(`[Studio] 2-stage matching: ${USE_2STAGE ? `YES (${TOTAL_DB_TILES} tiles, ${FPT}D index)` : 'NO (fallback to legacy)'}`);

    // ── Stage A helper: multi-dimensional k-NN over all DB tiles ─────────────────────
    // 14D distance: global LAB + quadrant a/b (8 values) + edge + brightness
    // Quadrant colors catch color gradients (e.g. blue sky top / green grass bottom)
    // TOP_K=80 gives SSD stage enough diverse candidates to avoid repetition
    const TOP_K = isMobileOrSlow ? 35 : 80; // more candidates = better diversity + SSD selection
    const knnLAB = (
      targetL: number, targetA: number, targetB: number,
      targetEdge = 0, targetBrightness = targetL / 100, targetSat = 0,
      targetQuadA: [number,number,number,number] = [targetA,targetA,targetA,targetA],
      targetQuadB: [number,number,number,number] = [targetB,targetB,targetB,targetB]
    ): Array<{tileId: number; labDist: number}> => {
      if (!labIndex) return [];
      // Weighted distance in feature space
      // Global LAB: perceptual color distance (primary signal)
      // Quadrant a/b: color distribution within tile (catches gradients)
      // Edge: shape similarity
      // Brightness: prevents dark tiles in bright areas
      const W_L = 1.0, W_A = 1.5, W_B = 1.5; // slightly higher weight on a/b for color accuracy
      const W_QUAD = IS_14D ? 0.4 : 0;        // quadrant color weight (per quadrant a/b pair)
      const W_EDGE = IS_7D ? 25.0 : 0;        // shape priority
      const W_BRIGHT = IS_7D ? 15.0 : 0;      // brightness matching
      // Gray-penalty: when target cell is colorful (sat > 0.15), penalize gray tiles (sat < 0.08)
      const GRAY_PENALTY = IS_7D ? Math.max(0, (targetSat - 0.15) * 200) : 0;
      const heap: Array<{tileId: number; labDist: number}> = [];
      let maxDist = Infinity;
      let worstIdx = 0;
      for (let i = 0; i < labIndex.length; i += FPT) {
        const id = labIndex[i];
        const L = labIndex[i + 1];
        const a = labIndex[i + 2];
        const b = labIndex[i + 3];
        const dL = targetL - L, dA = targetA - a, dB = targetB - b;
        let dist = W_L*dL*dL + W_A*dA*dA + W_B*dB*dB;
        if (IS_14D) {
          // Quadrant a/b: [4]=TL_a, [5]=TL_b, [6]=TR_a, [7]=TR_b
          //               [8]=BL_a, [9]=BL_b, [10]=BR_a, [11]=BR_b
          const dTLa = targetQuadA[0] - labIndex[i+4], dTLb = targetQuadB[0] - labIndex[i+5];
          const dTRa = targetQuadA[1] - labIndex[i+6], dTRb = targetQuadB[1] - labIndex[i+7];
          const dBLa = targetQuadA[2] - labIndex[i+8], dBLb = targetQuadB[2] - labIndex[i+9];
          const dBRa = targetQuadA[3] - labIndex[i+10], dBRb = targetQuadB[3] - labIndex[i+11];
          dist += W_QUAD*(dTLa*dTLa + dTLb*dTLb + dTRa*dTRa + dTRb*dTRb +
                          dBLa*dBLa + dBLb*dBLb + dBRa*dBRa + dBRb*dBRb);
          const edge = labIndex[i + 12];
          const brightness = labIndex[i + 13];
          dist += W_EDGE*(targetEdge-edge)*(targetEdge-edge) + W_BRIGHT*(targetBrightness-brightness)*(targetBrightness-brightness);
          // Gray-penalty: penalize gray tiles when target is colorful
          const sat = Math.min(1, Math.sqrt(a*a + b*b) / 60);
          if (GRAY_PENALTY > 0 && sat < 0.08) dist += GRAY_PENALTY;
        } else if (IS_7D) {
          const edge = labIndex[i + 4];
          const brightness = labIndex[i + 5];
          const sat = labIndex[i + 6];
          const dEdge = targetEdge - edge;
          const dBright = targetBrightness - brightness;
          const dSat = targetSat - sat;
          dist += W_EDGE*dEdge*dEdge + W_BRIGHT*dBright*dBright + (10.0)*dSat*dSat;
          // Gray-penalty: penalize gray tiles when target is colorful
          if (GRAY_PENALTY > 0 && sat < 0.08) dist += GRAY_PENALTY;
        }
        if (heap.length < TOP_K) {
          heap.push({ tileId: id, labDist: dist });
          if (heap.length === TOP_K) {
            // Find initial worst
            worstIdx = 0;
            maxDist = heap[0].labDist;
            for (let j = 1; j < TOP_K; j++) {
              if (heap[j].labDist > maxDist) { maxDist = heap[j].labDist; worstIdx = j; }
            }
          }
        } else if (dist < maxDist) {
          heap[worstIdx] = { tileId: id, labDist: dist };
          // Update worst
          worstIdx = 0;
          maxDist = heap[0].labDist;
          for (let j = 1; j < TOP_K; j++) {
            if (heap[j].labDist > maxDist) { maxDist = heap[j].labDist; worstIdx = j; }
          }
        }
      }
      return heap.sort((a, b) => a.labDist - b.labDist);
    };

    // ── Stage B: Pre-compute per-cell Top-K candidates ───────────────────────
    // For each cell, find the Top-K tile IDs by LAB distance
    // Then deduplicate: collect the UNIQUE tile IDs needed across all cells
    setProgressMsg(`Suche beste Kacheln in ${TOTAL_DB_TILES.toLocaleString()} Bildern...`);
    setProgress(15);

    // Map: tileId → candidate index (for SSD lookup after loading)
    const cellCandidates: Array<Array<{tileId: number; labDist: number}>> = [];
    const neededTileIds = new Set<number>();

    if (USE_2STAGE) {
      // 2-pass: first collect all candidates (with 14D features), then load images
      for (let ci = 0; ci < TOTAL_TILES; ci++) {
        const [tL, tA, tB] = cellLab[ci];
        const targetEdge = IS_7D ? edgeMap[ci] : 0;
        const targetBright = IS_7D ? tL / 100 : 0;
        const targetSat = IS_7D ? Math.min(1, Math.sqrt(tA*tA + tB*tB) / 60) : 0;
        // For 14D: use cell LAB for all quadrants (cell resolution = 1px, so all quads equal)
        // The quadrant matching happens on the TILE side (DB has per-quadrant data)
        const tQuadA: [number,number,number,number] = [tA, tA, tA, tA];
        const tQuadB: [number,number,number,number] = [tB, tB, tB, tB];
        const candidates = knnLAB(tL, tA, tB, targetEdge, targetBright, targetSat, tQuadA, tQuadB);
        cellCandidates.push(candidates);
        candidates.forEach(c => neededTileIds.add(c.tileId));
        if (ci % 500 === 0) {
          setProgress(15 + Math.round((ci / TOTAL_TILES) * 10));
          await new Promise(r => setTimeout(r, 0));
        }
      }
      console.log(`[Studio] ${IS_14D ? '14D' : IS_7D ? '7D' : '4D'} k-NN done: ${neededTileIds.size} unique tiles needed for ${TOTAL_TILES} cells`);
    }

    // ── Stage B: Load only the needed tile images ─────────────────────────────
    setProgressMsg(`Lade ${neededTileIds.size} Kachel-Bilder...`);
    setProgress(25);

    // tileId → HTMLImageElement (loaded at 64px)
    const tileImgMap = new Map<number, HTMLImageElement>();
    const IMG_TIMEOUT = isMobileOrSlow ? 10000 : 15000;

    if (USE_2STAGE && neededTileIds.size > 0) {
      const tileIdArray = Array.from(neededTileIds);
      const BATCH = isMobileOrSlow ? 30 : 80;
      let loaded = 0;
      for (let i = 0; i < tileIdArray.length; i += BATCH) {
        const batchIds = tileIdArray.slice(i, i + BATCH);
        const batchImgs = await Promise.all(
          batchIds.map(id => loadImageCached(`/api/tile/${id}?size=64`, IMG_TIMEOUT))
        );
        for (let j = 0; j < batchIds.length; j++) {
          if (batchImgs[j]) tileImgMap.set(batchIds[j], batchImgs[j]!);
        }
        loaded += batchIds.length;
        const pct = 25 + Math.round((loaded / tileIdArray.length) * 20);
        setProgress(Math.min(pct, 45));
        setCacheSize(getMemoryCacheSize());
        await new Promise(r => setTimeout(r, 0));
      }
      console.log(`[Studio] Loaded ${tileImgMap.size}/${neededTileIds.size} tile images`);
    }

    // ── Fallback: legacy pool if 2-stage not available ────────────────────────
    // Build validImgs/validTileIds arrays for the rest of the pipeline
    let validImgs: HTMLImageElement[];
    let validTileIds: number[];
    let dbTilePool: Array<{id: number; l: number; a: number; b: number}> = [];

    if (!USE_2STAGE || tileImgMap.size === 0) {
      // Legacy: load a fixed pool of images
      setProgressMsg("Lade Kachel-Pool (Fallback)...");
      const TARGET_POOL = isMobileOrSlow ? 600 : 1500;
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
      for (let i = 0; i < allUrls.length; i += BATCH) {
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
      saturation: number;                // chroma = sqrt(a²+b²), 0-100
      edgeEnergy: number;                // normalized Sobel energy 0-1 (frequency-aware)
      ssdPixels: Uint8Array;             // 8×8 RGB pixel data for pixel-accurate SSD matching
    };

    const extractFeature = (d: Uint8ClampedArray, SZ: number): ImgFeature => {
      const half = SZ / 2;
      let sL=0, sA=0, sB=0, n=0;
      let lumVarSum=0;
      const lums: number[] = [];
      for (let y=0; y<SZ; y++) for (let x=0; x<SZ; x++) {
        const i = (y*SZ+x)*4;
        const [L,a,b] = rgbToLab(d[i], d[i+1], d[i+2]);
        sL+=L; sA+=a; sB+=b; n++;
        lums.push(L);
      }
      const gL=sL/n, gA=sA/n, gB=sB/n;
      const meanL = gL;
      for (const l of lums) lumVarSum += (l - meanL) * (l - meanL);
      const texture = Math.sqrt(lumVarSum / n); // std-dev of luminance
      const saturation = Math.sqrt(gA*gA + gB*gB);

      // Sobel edge energy for frequency-aware matching
      let edgeSum = 0;
      for (let ey=1; ey<SZ-1; ey++) for (let ex=1; ex<SZ-1; ex++) {
        const lum = (r: number, c: number) => {
          const idx = (r*SZ+c)*4;
          return 0.299*d[idx] + 0.587*d[idx+1] + 0.114*d[idx+2];
        };
        const gx = -lum(ey-1,ex-1)+lum(ey-1,ex+1)-2*lum(ey,ex-1)+2*lum(ey,ex+1)-lum(ey+1,ex-1)+lum(ey+1,ex+1);
        const gy = -lum(ey-1,ex-1)-2*lum(ey-1,ex)-lum(ey-1,ex+1)+lum(ey+1,ex-1)+2*lum(ey+1,ex)+lum(ey+1,ex+1);
        edgeSum += Math.sqrt(gx*gx+gy*gy);
      }
      const edgeEnergy = Math.min(1, edgeSum / ((SZ-2)*(SZ-2) * 255));

      const avgLab = (x0: number, y0: number, x1: number, y1: number): [number,number,number] => {
        let qL=0, qA=0, qB=0, qn=0;
        for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) {
          const i = (y*SZ+x)*4;
          const [L,a,b] = rgbToLab(d[i], d[i+1], d[i+2]);
          qL+=L; qA+=a; qB+=b; qn++;
        }
        return qn>0 ? [qL/qn, qA/qn, qB/qn] : [50,0,0];
      };
      // Extract 8×8 RGB pixel data for SSD matching (downscale from SZ to 8)
      const SSD_SZ = 8;
      const ssdPixels = new Uint8Array(SSD_SZ * SSD_SZ * 3);
      const scaleX = SZ / SSD_SZ, scaleY = SZ / SSD_SZ;
      let si2 = 0;
      for (let sy = 0; sy < SSD_SZ; sy++) {
        for (let sx = 0; sx < SSD_SZ; sx++) {
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

    // ── Filter out clipart-like tiles (white/flat backgrounds) ──────────────
    // Tiles with very high L (>92) AND very low texture (<3) are almost certainly
    // white-background clipart images that ruin the mosaic.
    // Also filter tiles with very low saturation AND high L (washed out).
    const goodTileIndices: number[] = [];
    const goodImgFeatures: ImgFeature[] = [];
    const goodValidImgs: HTMLImageElement[] = [];
    const goodTileIds: number[] = [];
    for (let i = 0; i < imgFeatures.length; i++) {
      const f = imgFeatures[i];
      const isWhiteClipart = f.brightness > 92 && f.texture < 3;
      const isWashedOut = f.brightness > 88 && f.saturation < 5 && f.texture < 5;
      if (!isWhiteClipart && !isWashedOut) {
        goodTileIndices.push(i);
        goodImgFeatures.push(f);
        goodValidImgs.push(validImgs[i]);
        goodTileIds.push(validTileIds[i]);
      }
    }
    console.log(`[Mosaic] Filtered ${imgFeatures.length - goodImgFeatures.length} clipart tiles, ${goodImgFeatures.length} remaining`);
    // Replace arrays with filtered versions
    const filteredImgFeatures = goodImgFeatures;
    const filteredValidImgs = goodValidImgs;
    const filteredTileIds = goodTileIds;

    // Cell features from target image
    const cellFeatures: ImgFeature[] = [];
    for (let ci = 0; ci < TOTAL_TILES; ci++) {
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
    }

    // ── Step 3b: Face Detection (browser FaceDetector API) ──────────────────
    // Creates a face mask: cells inside detected faces get priority boost (score *= 0.7)
    setProgressMsg("Gesichtserkennung...");
    setProgress(48);
    const faceMask: boolean[] = new Array(TOTAL_TILES).fill(false);
    try {
      if ('FaceDetector' in window) {
        const faceDetector = new (window as any).FaceDetector({ fastMode: false, maxDetectedFaces: 10 });
        const faceCanvas = document.createElement('canvas');
        faceCanvas.width = targetImg.naturalWidth; faceCanvas.height = targetImg.naturalHeight;
        const fCtx = faceCanvas.getContext('2d')!;
        fCtx.drawImage(targetImg, 0, 0);
        const faces = await faceDetector.detect(faceCanvas);
        for (const face of faces) {
          const { x, y, width, height } = face.boundingBox;
          // Expand bounding box by 20% for better coverage
          const ex = x - width * 0.1, ey = y - height * 0.1;
          const ew = width * 1.2, eh = height * 1.2;
          // Map to tile grid
          const c0 = Math.max(0, Math.floor(ex / targetImg.naturalWidth * COLS));
          const c1 = Math.min(COLS - 1, Math.ceil((ex + ew) / targetImg.naturalWidth * COLS));
          const r0 = Math.max(0, Math.floor(ey / targetImg.naturalHeight * ROWS));
          const r1 = Math.min(ROWS - 1, Math.ceil((ey + eh) / targetImg.naturalHeight * ROWS));
          for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) faceMask[r * COLS + c] = true;
        }
      }
    } catch { /* FaceDetector not available or failed – continue without */ }

    // Step 4: Match tiles
    // 2-STAGE MATCHING:
    //   Stage A (done above): k-NN over ALL DB tiles in LAB space → cellCandidates[ci]
    //   Stage B (here): For each cell, get the pre-computed Top-K candidates,
    //                   look up their loaded images, run SSD + full scoring, pick best
    //
    // For legacy fallback (no LAB index): use filteredImgFeatures as before
    setProgressMsg("Matche Fotos...");
    setProgress(50);

    // Build a tileId → index map for the loaded images (for 2-stage lookup)
    const tileIdToIdx = new Map<number, number>();
    for (let i = 0; i < filteredTileIds.length; i++) {
      tileIdToIdx.set(filteredTileIds[i], i);
    }

    const useCount = new Array(filteredValidImgs.length).fill(0);
    // MAX_REUSE: hard cap — if we have enough tiles, limit to 1-2 uses per tile
    // With 17k+ tiles and 2k cells, each tile should ideally be used at most once
    const MAX_REUSE = filteredValidImgs.length >= TOTAL_TILES * 3
      ? 1  // plenty of tiles: each used max once
      : filteredValidImgs.length >= TOTAL_TILES * 1.5
        ? 2  // good coverage: max 2 uses
        : Math.max(3, Math.ceil((TOTAL_TILES * 1.5) / Math.max(1, filteredValidImgs.length)));
    const assignment: number[] = new Array(TOTAL_TILES).fill(-1);
    // Also store best rotation per tile (0=0°, 1=90°, 2=180°, 3=270°)
    const assignmentRotation: number[] = new Array(TOTAL_TILES).fill(0);
    // Repetition Lock: radius 4, penalty 160 (portrait-optimized per feedback)
    const NEIGHBOR_RADIUS = savedSettings.neighborRadius ?? 4;
    const NEIGHBOR_PENALTY = savedSettings.neighborPenalty ?? 160;
    const ENABLE_ROTATION = savedSettings.enableRotation ?? true; // Tile rotation for better matching

    // Pre-compute rotated features for all tiles (0°, 90°, 180°, 270°)
    // For rotation: 90° swaps quadrants: TL→TR→BR→BL→TL
    // quads order: [TL, TR, BL, BR]
    const rotateQuads = (quads: [[number,number,number],[number,number,number],[number,number,number],[number,number,number]], rot: number): [[number,number,number],[number,number,number],[number,number,number],[number,number,number]] => {
      if (rot === 0) return quads;
      if (rot === 1) return [quads[2], quads[0], quads[3], quads[1]]; // 90°: BL→TL, TL→TR, BR→BL, TR→BR
      if (rot === 2) return [quads[3], quads[2], quads[1], quads[0]]; // 180°
      return [quads[1], quads[3], quads[0], quads[2]]; // 270°
    };

    const tileOrder = Array.from({ length: TOTAL_TILES }, (_, i) => i)
      .sort((a, b) => saliency[b] - saliency[a]);

    // Legacy: Pre-sort imgFeatures by LAB for fast candidate pre-filtering
    const sortedByL = Array.from({ length: filteredValidImgs.length }, (_, i) => i)
      .sort((a, b) => filteredImgFeatures[a].lab[0] - filteredImgFeatures[b].lab[0]);

    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const ci = tileOrder[ti];
      const tf = cellFeatures[ci];
      const col = ci % COLS, row = Math.floor(ci / COLS);
      const inFace = faceMask[ci];

      // Collect neighbor tile IDs for anti-repetition
      const neighborIds = new Set<number>();
      for (let dr = -NEIGHBOR_RADIUS; dr <= NEIGHBOR_RADIUS; dr++) {
        for (let dc = -NEIGHBOR_RADIUS; dc <= NEIGHBOR_RADIUS; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr, nc = col + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
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
        // If too few candidates loaded (e.g., all filtered), fall back to legacy
        if (candidateIndices.length < 5) {
          candidateIndices = Array.from({ length: Math.min(30, filteredValidImgs.length) }, (_, i) => i);
        }
      } else {
        // Legacy fallback: binary search in sortedByL
        const PRE_FILTER_COUNT = Math.min(80, filteredValidImgs.length);
        if (filteredValidImgs.length > PRE_FILTER_COUNT * 2) {
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
      for (const j of candidateIndices) {
        const mf = filteredImgFeatures[j];
        // Base penalties (rotation-independent)
        const neighborPenalty = neighborIds.has(j) ? NEIGHBOR_PENALTY : 0;
        const reusePenalty = useCount[j] >= MAX_REUSE ? 150 * (useCount[j] - MAX_REUSE + 1) : 0;

        for (const rot of rotations) {
          const rotatedQuads = rotateQuads(mf.quads, rot);
          // 0. Pixel-accurate SSD score (8×8 RGB comparison – most accurate signal)
          // Compares every pixel of the tile against the target region
          const tRegion = targetRegions[ci]; // 8×8×3 RGB of target cell
          const mPixels = mf.ssdPixels;       // 8×8×3 RGB of candidate tile
          let ssdSum = 0;
          for (let px = 0; px < tRegion.length; px++) {
            const d2 = tRegion[px] - mPixels[px];
            ssdSum += d2 * d2;
          }
          const ssdScore = ssdSum / (tRegion.length / 3) / (255 * 255); // normalize 0-1

          // 1. Global LAB distance (color matching)
          const [dL,dA,dB] = [tf.lab[0]-mf.lab[0], tf.lab[1]-mf.lab[1], tf.lab[2]-mf.lab[2]];
          const labDist = Math.sqrt(dL*dL + dA*dA + dB*dB);
          // 2. Quadrant LAB distances (spatial color accuracy)
          let quadDist = 0;
          for (let q=0; q<4; q++) {
            const [ql,qa,qb] = [tf.quads[q][0]-rotatedQuads[q][0], tf.quads[q][1]-rotatedQuads[q][1], tf.quads[q][2]-rotatedQuads[q][2]];
            quadDist += Math.sqrt(ql*ql + qa*qa + qb*qb);
          }
          quadDist /= 4;
          // 3. Brightness difference (Hybrid-SSD: brightness gets extra weight for contrast)
          const brightDiff = Math.abs(tf.brightness - mf.brightness);
          // 4. Texture similarity
          const textureDiff = Math.abs(tf.texture - mf.texture) / 50;
          // 5. Edge Priority Matching: adaptive weight 0.05–0.50 based on cell edge strength
          const cellEdge = edgeMap[ci]; // 0-1
          const edgeDiff = Math.abs(tf.edgeEnergy - mf.edgeEnergy);
          const edgeWeight = 0.05 + cellEdge * 0.45; // 0.05 (flat) to 0.50 (sharp edge)
          // Mosaicer-inspired weights: Brightness dominates (35%) for natural luminance matching
          // Without overlay, brightness matching IS the luminance structure of the mosaic
          // SSD 30% · LAB 15% · Brightness 40% · Texture 8% · Quad 7%
          const wSsdBase = 0.30;
          const wLabBase = savedSettings.labWeight ?? 0.15;
          const wBrightBase = savedSettings.brightnessWeight ?? 0.40; // KEY: brightness drives face structure
          const wTextureBase = savedSettings.textureWeight ?? 0.08;
          // Repetition penalty: exponential growth to strongly discourage reuse
          // 1st reuse: +80, 2nd: +320, 3rd: +1280, 4th+: +5120 (effectively banned)
          const rc = useCount[j] || 0;
          const repPenalty = rc === 0 ? 0 : rc === 1 ? 80 : rc === 2 ? 320 : rc === 3 ? 1280 : 5120;
          // Face region: boost SSD, brightness, edge and texture weights for sharper eye/nose/mouth
          if (inFace) {
            const wSsdFace = 0.50;             // SSD dominates in face areas (pixel accuracy)
            const wLabF = wLabBase * 0.60;     // less LAB weight – SSD handles color
            const wBrightF = wBrightBase * 1.30; // extra brightness boost in face areas
            const faceEdgeWeight = edgeWeight * 1.8; // stronger edge matching in faces
            const faceTextureWeight = wTextureBase * 1.5; // texture matters for skin/hair
            let dist = wSsdFace * ssdScore * 100 + wLabF * labDist + 0.06 * quadDist + wBrightF * brightDiff + faceTextureWeight * textureDiff * 50 + faceEdgeWeight * edgeDiff * 100;
            // Skin-tone bonus: if target cell is skin-toned (warm L:40-80, a:5-25, b:10-35)
            // and tile is also skin-toned, reduce distance (better match)
            const isTargetSkin = tf.lab[0] >= 40 && tf.lab[0] <= 80 && tf.lab[1] >= 5 && tf.lab[1] <= 25 && tf.lab[2] >= 10 && tf.lab[2] <= 35;
            const isTileSkin = mf.lab[0] >= 40 && mf.lab[0] <= 80 && mf.lab[1] >= 5 && mf.lab[1] <= 25 && mf.lab[2] >= 10 && mf.lab[2] <= 35;
            if (isTargetSkin && isTileSkin) dist -= 8; // skin-tone bonus: prefer matching skin tiles
            if (isTargetSkin && !isTileSkin) dist += 12; // penalize non-skin tiles in skin areas
            dist += neighborPenalty + reusePenalty + repPenalty;
            if (dist < bestDist) { bestDist = dist; bestIdx = j; bestRot = rot; }
            continue;
          }
          let dist = wSsdBase * ssdScore * 100 + wLabBase * labDist + 0.10 * quadDist + wBrightBase * brightDiff + wTextureBase * textureDiff * 50 + edgeWeight * edgeDiff * 100;
          // Anti-repetition penalties
          dist += neighborPenalty + reusePenalty + repPenalty;
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
    validImgsRef.current = filteredValidImgs;
    tileIdsRef.current = filteredTileIds;

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
    for (let ci = 0; ci < TOTAL_TILES; ci++) {
      const col = ci % COLS;
      const row = Math.floor(ci / COLS);
      const x = col * TILE_PX, y = row * TILE_PX;
      const img = filteredValidImgs[assignment[ci]];
      const rot = assignmentRotation[ci]; // 0=0°, 1=90°, 2=180°, 3=270°
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
          // Broken image – fill with target pixel color as fallback
          const fi = (row * COLS + col) * 4;
          tileCtx.fillStyle = `rgb(${targetData[fi]},${targetData[fi+1]},${targetData[fi+2]})`;
          tileCtx.fillRect(0, 0, TILE_PX, TILE_PX);
        }
        // Apply contrast boost from settings (default 1.30)
        const cBoost = savedSettings.contrastBoost ?? 1.30;
        const boostCanvas = document.createElement('canvas');
        boostCanvas.width = TILE_PX; boostCanvas.height = TILE_PX;
        const bCtx = boostCanvas.getContext('2d')!;
        bCtx.filter = `brightness(${(0.95 + cBoost * 0.05).toFixed(2)}) saturate(${(0.90 + cBoost * 0.15).toFixed(2)}) contrast(${cBoost.toFixed(2)})`;
        try { bCtx.drawImage(tileOffscreen, 0, 0); } catch { bCtx.drawImage(tileOffscreen, 0, 0, TILE_PX, TILE_PX); }
        bCtx.filter = 'none';
        // Store original URL for hi-res re-render
        tilesRef.current[ci].url = img.dataset.originalSrc || img.src;
        // ── Professional Luminance-Scale + Moderate AB-Transfer (Reinhard-style) ────────
        // Based on best-practice mosaic engine pipeline:
        //   1. Luminance scaling: pixel.L *= (targetL / tileAvgL)   → clamp 0.6–1.5
        //   2. Moderate AB shift: pixel.A = mix(pixel.A, targetA, AB_BLEND)
        //   3. Max color shift clamp: |delta_A|, |delta_B| ≤ MAX_COLOR_SHIFT
        //
        // L_BLEND = 0.70 (luminance dominates – eye sees structure via brightness)
        // AB_BLEND = 0.25 (gentle color nudge – preserves natural tile colors)
        // MAX_COLOR_SHIFT = 18 (prevents unnatural tinting)
        //
        // histogramBlend slider (0–0.15) scales both: 0.10 = full strength
        // Mosaicer reference: NO overlay by default – tiles match naturally via precise color selection
        // Only apply subtle luminance correction to preserve face structure
        const blendFactor = Math.min(1.0, (savedSettings.histogramBlend ?? 0.0) / 0.10);
        const L_BLEND  = 0.30 * blendFactor;  // very subtle luminance nudge (was 0.90 – too aggressive)
        const AB_BLEND = 0.15 * blendFactor;  // very subtle color nudge (was 0.35 – too aggressive)
        const MAX_COLOR_SHIFT = 12;            // tighter clamp to preserve natural tile colors            // max a/b channel shift
        const [tL, tA, tB] = cellLab[ci];
        const tilePixels = bCtx.getImageData(0, 0, TILE_PX, TILE_PX);
        const td = tilePixels.data;
        // Step 1: Compute tile average L (for luminance scaling)
        let sumL = 0;
        const pCount = td.length / 4;
        for (let pi = 0; pi < td.length; pi += 4) {
          sumL += rgbToLab(td[pi], td[pi+1], td[pi+2])[0];
        }
        const avgL = sumL / pCount;
        // Luminance scale factor: how much brighter/darker target is vs tile
        // Wide clamp 0.15–4.0 to allow strong darkening/brightening for portrait visibility
        const rawLumScale = avgL > 1 ? tL / avgL : 1;
        const clampedLumScale = Math.max(0.15, Math.min(4.0, rawLumScale));
        const lumScale = 1 + (clampedLumScale - 1) * L_BLEND;
        // Step 2: Apply per-pixel luminance scale + moderate AB transfer
        const outData = new Uint8ClampedArray(td.length);
        for (let pi = 0; pi < td.length; pi += 4) {
          const [pl, pa, pb] = rgbToLab(td[pi], td[pi+1], td[pi+2]);
          // Luminance: scale toward target brightness
          const newL = Math.max(0, Math.min(100, pl * lumScale));
          // Color: gentle shift toward target a/b, clamped to MAX_COLOR_SHIFT
          const rawDeltaA = (tA - pa) * AB_BLEND;
          const rawDeltaB = (tB - pb) * AB_BLEND;
          const clampedDeltaA = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, rawDeltaA));
          const clampedDeltaB = Math.max(-MAX_COLOR_SHIFT, Math.min(MAX_COLOR_SHIFT, rawDeltaB));
          const newA = Math.max(-128, Math.min(127, pa + clampedDeltaA));
          const newB = Math.max(-128, Math.min(127, pb + clampedDeltaB));
          const [nr, ng, nb] = labToRgb(newL, newA, newB);
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
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const ci = row * COLS + col;
          const i = (row * COLS + col) * 4;
          const tr = targetData[i], tg = targetData[i+1], tb = targetData[i+2];
          const edge = edgeMap[ci];
          // Adaptive strength: BASE_OVERLAY at flat areas, +EDGE_BOOST at edges
          const strength = BASE_OVERLAY + edge * EDGE_BOOST;
          for (let py = row * TILE_PX; py < (row + 1) * TILE_PX && py < CANVAS_H; py++) {
            for (let px = col * TILE_PX; px < (col + 1) * TILE_PX && px < CANVAS_W; px++) {
              const pi = (py * CANVAS_W + px) * 4;
              if (OVERLAY_MODE === 'softlight') {
                // ── Soft-Light Blending (Photoshop formula) ──
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
                // ── Alpha Blend (simpler, more direct color shift) ──
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
    // overlayMode === 'none': skip overlay entirely – pure tile rendering

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
    setReady(true);
    setLoading(false);
    setShowOrderPanel(true);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.min(8, Math.max(0.2, z * (e.deltaY > 0 ? 0.85 : 1.18))));
  }, []);
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true; lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastMouse.current.x, dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);
  const handleMouseUp = useCallback(() => { isDragging.current = false; }, []);

  // Print Export: high-quality render with 128px tiles
  // Two modes:
  // - Preview (paid=false): uses existing canvas, adds watermark
  // - Print (paid=true): re-renders with 128px tiles at target DPI resolution
  const handleDownload = useCallback(async (paid = false) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const fmt = PRINT_FORMATS[selectedFormat];

    const outCanvas = document.createElement("canvas");
    outCanvas.width = fmt.pxW;
    outCanvas.height = fmt.pxH;
    const outCtx = outCanvas.getContext("2d")!;

    if (paid && assignmentRef.current.length && validImgsRef.current.length && mosaicParamsRef.current) {
      // PRINT MODE: re-render with high-res tiles (128px per tile)
      const { cols, rows } = mosaicParamsRef.current;
      const PRINT_TILE_PX = Math.max(64, Math.floor(Math.min(fmt.pxW / cols, fmt.pxH / rows)));
      const printW = cols * PRINT_TILE_PX;
      const printH = rows * PRINT_TILE_PX;
      const printCanvas = document.createElement("canvas");
      printCanvas.width = printW; printCanvas.height = printH;
      const pCtx = printCanvas.getContext("2d")!;

      // Load hi-res tiles (400px from Picsum)
      const hiResImgs: (HTMLImageElement | null)[] = [];
      // Use DB tile IDs for print-quality loading if available
      const urlsToLoad = tileIdsRef.current.length > 0
        ? tileIdsRef.current.map(id => id > 0 ? `/api/tile/${id}?size=400` : '')
        : validImgsRef.current.map(img => toHiResUrl(img.dataset.originalSrc || img.src, 400));
      for (let i = 0; i < urlsToLoad.length; i += 20) {
        const batch = await Promise.all(urlsToLoad.slice(i, i+20).map(u => loadImageCached(u, 10000)));
        hiResImgs.push(...batch);
      }
      // Render tiles
      const assignment = assignmentRef.current;
      for (let ci = 0; ci < cols * rows; ci++) {
        const col = ci % cols, row = Math.floor(ci / cols);
        const img = hiResImgs[assignment[ci]] || validImgsRef.current[assignment[ci]];
        if (img && img.complete && img.naturalWidth > 0) pCtx.drawImage(img, col * PRINT_TILE_PX, row * PRINT_TILE_PX, PRINT_TILE_PX, PRINT_TILE_PX);
      }
      // Scale to target format
      outCtx.drawImage(printCanvas, 0, 0, fmt.pxW, fmt.pxH);
    } else {
      // PREVIEW MODE: scale existing canvas
      outCtx.drawImage(canvas, 0, 0, fmt.pxW, fmt.pxH);
    }

    if (!paid) {
      // Add watermark for preview downloads
      const wm = "MosaicPrint.ch – Vorschau";
      const fontSize = Math.max(24, Math.round(fmt.pxW * 0.025));
      outCtx.save();
      outCtx.globalAlpha = 0.28;
      outCtx.fillStyle = "#ffffff";
      outCtx.font = `bold ${fontSize}px sans-serif`;
      outCtx.textAlign = "center";
      outCtx.textBaseline = "middle";
      // Draw repeated watermark pattern diagonally
      const step = Math.round(fmt.pxW * 0.22);
      for (let y = -step; y < fmt.pxH + step; y += step) {
        for (let x = -step; x < fmt.pxW + step; x += step) {
          outCtx.save();
          outCtx.translate(x, y);
          outCtx.rotate(-Math.PI / 6);
          outCtx.fillText(wm, 0, 0);
          outCtx.restore();
        }
      }
      outCtx.restore();
    }

    // Download as PNG (RGB, Printolino-compatible)
    const formatLabel = fmt.label.replace("×", "x").replace(" ", "");
    const suffix = paid ? "druckbereit" : "vorschau";
    const link = document.createElement("a");
    link.download = `mosaicprint-${formatLabel}-${suffix}.png`;
    link.href = outCanvas.toDataURL("image/png");
    link.click();
  }, [selectedFormat]);

  const totalPrice = PRINT_FORMATS[selectedFormat].price + MATERIALS[selectedMaterial].surcharge;

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
        setPaymentError("Stripe nicht konfiguriert – direkt herunterladen.");
        handleDownload(true);
      }
    } catch {
      // Network error: allow direct download as fallback
      setPaymentError("Zahlung nicht verfügbar – direkt herunterladen.");
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
          <p className="text-gray-500">Lade dein Lieblingsfoto hoch – unsere KI baut es aus Hunderten kleiner Fotos nach.</p>
        </div>

        {/* Cache status badge */}
        {(cacheSize > 0 || dbTileCount !== null) && !userPhoto && !loading && (
          <div className="flex justify-center mb-4">
            <div className="inline-flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 text-xs font-semibold px-3 py-1.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {dbTileCount !== null
                ? `${dbTileCount.toLocaleString('de-CH')} Bilder verfügbar – schneller Start garantiert`
                : `${cacheSize} Bilder im Cache – schneller Start garantiert`}
            </div>
          </div>
        )}

        {/* Theme filter chips */}
        {!userPhoto && !loading && (
          <div className="max-w-xl mx-auto mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 text-center">Kachel-Thema wählen</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {[
                { key: 'alle', label: 'Alle', emoji: '🌈' },
                { key: 'sunset', label: 'Sunset', emoji: '🌅' },
                { key: 'nature', label: 'Natur', emoji: '🌿' },
                { key: 'urban', label: 'Urban', emoji: '🏙️' },
                { key: 'portrait', label: 'Portrait', emoji: '👤' },
                { key: 'abstract', label: 'Abstrakt', emoji: '🎨' },
                { key: 'food', label: 'Food', emoji: '🍕' },
                { key: 'travel', label: 'Reise', emoji: '✈️' },
                { key: 'ocean', label: 'Ozean', emoji: '🌊' },
                { key: 'winter', label: 'Winter', emoji: '❄️' },
              ].map(({ key, label, emoji }) => (
                <button
                  key={key}
                  onClick={() => { setSelectedTheme(key); selectedThemeRef.current = key; }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all border ${
                    selectedTheme === key
                      ? 'bg-coral-500 text-white border-coral-500 shadow-sm'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-coral-300 hover:text-coral-600'
                  }`}
                >
                  <span>{emoji}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {selectedTheme !== 'alle' && (
              <p className="text-xs text-center text-coral-600 mt-2 font-medium">
                Mosaik wird aus <strong>{selectedTheme}</strong>-Kacheln erstellt
              </p>
            )}
          </div>
        )}
        {/* Upload area (when no photo) */}
        {!userPhoto && !loading && (
          <div
            className="max-w-xl mx-auto border-2 border-dashed border-coral-200 rounded-3xl p-12 text-center cursor-pointer hover:border-coral-400 hover:bg-coral-50 transition-all group mb-8"
            onClick={() => uploadRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleUpload(f); }}
          >
            <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <div className="w-16 h-16 rounded-2xl bg-coral-100 group-hover:bg-coral-200 flex items-center justify-center mx-auto mb-4 transition-colors">
              <Upload className="w-8 h-8 text-coral-600" />
            </div>
            <p className="text-xl font-bold text-gray-800 mb-2">Foto hochladen</p>
            <p className="text-gray-500 mb-1">JPG, PNG, HEIC · Drag & Drop oder klicken</p>
            <p className="text-sm text-gray-400">Empfohlen: min. 1000×1000 px für beste Qualität</p>
          </div>
        )}

        {/* Loading progress */}
        {loading && (
          <div className="max-w-xl mx-auto bg-white rounded-2xl p-8 shadow-sm border border-gray-100 mb-8 text-center">
            <Loader2 className="w-10 h-10 text-coral-600 animate-spin mx-auto mb-4" />
            <p className="font-bold text-gray-900 mb-2">{progressMsg}</p>
            <div className="w-full bg-gray-100 rounded-full h-3 mb-2">
              <div
                className="bg-coral-500 h-3 rounded-full transition-all duration-300"
                style={{ width: `${Math.max(progress, 2)}%` }}
              />
            </div>
            <p className="text-sm text-gray-400">{progress}%</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="max-w-xl mx-auto bg-red-50 border border-red-200 rounded-2xl p-4 text-red-700 text-sm mb-6">
            {error}
          </div>
        )}

        {/* Canvas container */}
        {(ready || loading) && (
          <>
            {/* Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                {userPhoto && (
                  <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-1.5 shadow-sm">
                    <img src={userPhoto} alt="Dein Foto" className="w-8 h-8 rounded-lg object-cover" />
                    <span className="text-xs font-semibold text-gray-700">Dein Foto</span>
                    <button onClick={() => { setUserPhoto(null); setUserPhotoImg(null); setReady(false); setLoading(false); setShowOrderPanel(false); }} className="text-gray-400 hover:text-gray-700 ml-1">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {selectedTheme !== 'alle' && (
                  <div className="flex items-center gap-1.5 bg-coral-50 border border-coral-200 rounded-xl px-3 py-1.5">
                    <span className="text-xs font-semibold text-coral-700">Thema: {selectedTheme}</span>
                    <button onClick={() => { setSelectedTheme('alle'); selectedThemeRef.current = 'alle'; }} className="text-coral-400 hover:text-coral-700 ml-0.5">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setZoom(z => Math.min(8, z * 1.3))} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900">
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button onClick={() => setZoom(z => Math.max(0.2, z / 1.3))} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900">
                  <Eye className="w-4 h-4" />
                </button>
                {ready && (
                  <>
                    <button onClick={() => handleDownload(false)} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900" title="Vorschau herunterladen">
                      <Download className="w-4 h-4" />
                    </button>
                    <button onClick={() => { if (userPhotoImg) { setReady(false); setLoading(true); setProgress(0); renderMosaic(userPhotoImg); } }} className="p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all text-gray-600 hover:text-gray-900" title="Neu generieren">
                      <RefreshCw className="w-4 h-4" />
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
                <canvas
                  ref={canvasRef}
                  style={{
                    display: ready || loading ? "block" : "none",
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: "center center",
                    transition: isDragging.current ? "none" : "transform 0.1s ease",
                    imageRendering: "auto",
                    maxWidth: "none",
                  }}
                />

                {/* Hi-Res canvas overlay – rendered once when zoom crosses threshold */}
                {/* Positioned exactly over the preview canvas, fades in with sharpness slider */}
                <canvas
                  ref={hiResCanvasRef}
                  style={{
                    display: showHiRes ? "block" : "none",
                    position: "absolute",
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: "center center",
                    transition: isDragging.current ? "none" : "transform 0.1s ease",
                    maxWidth: "none",
                    opacity: hiResOpacity,
                    pointerEvents: "none",
                    imageRendering: "auto",
                  }}
                />
                {hiResLoading && showHiRes && (
                  <div style={{ position: "absolute", bottom: 8, right: 8, background: "rgba(0,0,0,0.6)", color: "white", fontSize: 11, padding: "3px 8px", borderRadius: 6, pointerEvents: "none" }}>
                    Hi-Res wird geladen...
                  </div>
                )}
              </div>

              {ready && zoom === 1 && (
                <div className="absolute bottom-3 right-3 text-xs text-white/80 bg-black/40 rounded-lg px-2 py-1 pointer-events-none">
                  Scroll zum Zoomen · Drag zum Verschieben
                </div>
              )}
            </div>

            {/* Sharpness slider */}
            {ready && (
              <div className="mb-4 bg-white rounded-2xl border border-coral-100 shadow-sm p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-bold text-gray-800">Mosaik-Schärfe</p>
                    <p className="text-xs text-gray-500">Zoom ≥ 1.5×: Regler steuert Schärfe der Tile-Fotos</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-coral-600 bg-coral-50 rounded px-2 py-0.5">{sharpness}%</span>
                    {zoom >= HI_RES_THRESHOLD ? (
                      <span className="text-xs font-semibold text-green-600 bg-green-50 rounded px-2 py-0.5">Hi-Res aktiv</span>
                    ) : (
                      <span className="text-xs text-gray-400 bg-gray-50 rounded px-2 py-0.5">Zoom in für Schärfe</span>
                    )}
                  </div>
                </div>
                <input
                  type="range" min={0} max={100} step={5} value={sharpness}
                  onChange={e => setSharpness(Number(e.target.value))}
                  className="w-full h-2 rounded-full accent-coral-500 cursor-pointer"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>Kein Hi-Res</span>
                  <span>Maximale Schärfe</span>
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
                  <button
                    onClick={() => { setCompareMode(m => !m); if (!compareMode) setComparePos(50); }}
                    className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-all ${compareMode ? "bg-coral-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                  >
                    {compareMode ? "Vergleich AN" : "Vergleich AUS"}
                  </button>
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
                        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 36, height: 36, borderRadius: "50%", background: "white", boxShadow: "0 2px 12px rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⇔</div>
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

            {/* Format selection */}
            <div className="mb-5">
              <p className="text-sm font-bold text-gray-700 mb-3">Format wählen</p>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {PRINT_FORMATS.map(({ label, price }, idx) => (
                  <button
                    key={label}
                    onClick={() => setSelectedFormat(idx)}
                    className={`relative p-2.5 rounded-xl border-2 text-center transition-all ${
                      selectedFormat === idx
                        ? "border-coral-500 bg-coral-50"
                        : "border-gray-100 hover:border-coral-200"
                    }`}
                  >
                    {idx === 1 && <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-coral-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">Top</div>}
                    <div className="text-xs font-bold text-gray-900">{label}</div>
                    <div className="text-xs text-coral-700 font-semibold">CHF {price}</div>
                    {selectedFormat === idx && <Check className="w-3 h-3 text-coral-600 absolute top-1 right-1" />}
                  </button>
                ))}
              </div>
            </div>

            {/* Material selection */}
            <div className="mb-6">
              <p className="text-sm font-bold text-gray-700 mb-3">Material wählen</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {MATERIALS.map(({ label, surcharge, icon }, idx) => (
                  <button
                    key={label}
                    onClick={() => setSelectedMaterial(idx)}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      selectedMaterial === idx
                        ? "border-coral-500 bg-coral-50"
                        : "border-gray-100 hover:border-coral-200"
                    }`}
                  >
                    <div className="text-xl mb-1">{icon}</div>
                    <div className="text-xs font-bold text-gray-900">{label}</div>
                    <div className="text-xs text-gray-500">
                      {surcharge > 0 ? `+CHF ${surcharge}` : surcharge < 0 ? `−CHF ${Math.abs(surcharge)}` : "Inklusive"}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Order summary */}
            <div className="bg-coral-50 rounded-xl p-4 mb-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-gray-900">{PRINT_FORMATS[selectedFormat].label} · {MATERIALS[selectedMaterial].label}</p>
                  <p className="text-sm text-gray-500">inkl. MwSt., Druck & Lieferung CH</p>
                </div>
                <div className="text-2xl font-extrabold text-coral-700">CHF {totalPrice}</div>
              </div>
            </div>

            {/* Printolino-Info-Box */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 text-xs text-blue-800">
              <p className="font-bold mb-0.5">Printolino-konformes Format</p>
              <p>
                Dein Mosaik wird als RGB-PNG mit {PRINT_FORMATS[selectedFormat].dpi} dpi ausgegeben
                ({PRINT_FORMATS[selectedFormat].pxW}×{PRINT_FORMATS[selectedFormat].pxH} px) –
                optimiert für {PRINT_FORMATS[selectedFormat].label} Druck bei Printolino.
              </p>
            </div>

            {/* Payment success banner */}
            {paymentSuccess && (
              <div className="mb-4 bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2 text-green-800 text-sm font-semibold">
                <Check className="w-4 h-4 text-green-600" />
                Zahlung erfolgreich! Lade jetzt deine druckbereite Datei herunter.
                <button
                  onClick={() => handleDownload(true)}
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

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => setShowPayModal(true)}
                disabled={paymentLoading}
                className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-coral-500 to-coral-600 hover:from-coral-600 hover:to-coral-700 text-white font-bold py-3.5 rounded-xl shadow-md hover:shadow-lg transition-all disabled:opacity-60"
              >
                {paymentLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                Druckbereite Datei kaufen · CHF {totalPrice}
              </button>
              <a
                href={`https://www.printolino.ch?ref=mosaicprint&format=${encodeURIComponent(PRINT_FORMATS[selectedFormat].label)}&material=${encodeURIComponent(MATERIALS[selectedMaterial].label)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 bg-white border-2 border-coral-200 text-coral-700 hover:bg-coral-50 font-semibold py-3.5 px-5 rounded-xl transition-all"
              >
                <Printer className="w-4 h-4" />
                Bei Printolino bestellen
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            <div className="flex items-center justify-between mt-3">
              <button
                onClick={() => handleDownload(false)}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Vorschau herunterladen (mit Wasserzeichen)
              </button>
              <p className="text-xs text-gray-400">
                Lade die druckbereite Datei bei Printolino.ch hoch.
              </p>
            </div>
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
              Alle Preise ansehen →
            </Link>
          </div>
        )}
      </div>

      {/* Stripe Payment Modal */}
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
                  <p className="text-sm text-gray-500">{MATERIALS[selectedMaterial].label} · Druckbereite PNG-Datei</p>
                  <p className="text-xs text-gray-400 mt-0.5">{PRINT_FORMATS[selectedFormat].pxW}×{PRINT_FORMATS[selectedFormat].pxH} px · {PRINT_FORMATS[selectedFormat].dpi} dpi · RGB</p>
                </div>
                <div className="text-2xl font-extrabold text-coral-700">CHF {totalPrice}</div>
              </div>
            </div>

            <div className="text-xs text-gray-500 mb-4 space-y-1">
              <p>✓ Sofort-Download nach Zahlung</p>
              <p>✓ Wasserzeichenfreie Druckdatei</p>
              <p>✓ Printolino-konformes Format (RGB PNG)</p>
              <p>✓ Sichere Zahlung via Stripe</p>
            </div>

            <button
              onClick={handleStripeCheckout}
              disabled={paymentLoading}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-coral-500 to-coral-600 hover:from-coral-600 hover:to-coral-700 text-white font-bold py-3.5 rounded-xl shadow-md hover:shadow-lg transition-all disabled:opacity-60 mb-3"
            >
              {paymentLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
              {paymentLoading ? "Weiterleitung..." : `CHF ${totalPrice} – Jetzt bezahlen`}
            </button>

            <p className="text-xs text-center text-gray-400">
              Gesichert durch Stripe · Kreditkarte, TWINT, PayPal
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
