# MosaicPrint - Analyse der Qualitätsprobleme (Desktop Digital/Print)

## Datum: 2026-04-02
## Kontext: Schritt 2 - Verbesserung der digitalen Datei- und Druckqualität auf Desktop

---

## 1. AKTUELLE SITUATION

### Digital Download (DIGITAL_FORMATS)
```typescript
const DIGITAL_FORMATS = [
  { label: "HD", desc: "Hochauflösend (ca. 10.000×12.000 px)", tilePx: 100, price: 19, format: 'jpg' },
  { label: "Ultra HD", desc: "Maximale Auflösung (1cm@400PPI)", tilePx: 157, price: 29, format: 'jpg' },
  { label: "PNG Lossless", desc: "Verlustfrei, maximale Qualität", tilePx: 157, price: 39, format: 'png' },
];
```

**Rendering-Pfad:** `handleDigitalDownload()` → `renderMosaicClientSide()`
- **Client-seitig** (im Browser)
- Verwendet `tilePx: 100` (HD) oder `tilePx: 157` (Ultra HD/PNG)
- **Clamping:** `SERVER_MAX_DIM = 16000` → bei großen Mosaiken wird `tilePx` reduziert

### Print Order (Printolino)
```typescript
const TILE_PX_400DPI = 157; // 1 cm @ 400 DPI = 157 px
```

**Rendering-Pfad:** `handlePrintolinoOrder()` → Bestellung in DB → Admin rendert server-seitig
- **Server-seitig** (via `/api/admin/orders/:id/render`)
- Verwendet `tilePx: 157` (400 DPI Standard)
- **Clamping:** `SERVER_MAX_DIM = 16000` → bei großen Mosaiken wird `tilePx` reduziert
- **Strip-basiert:** `STRIP_ROWS = 4` (reduziert von 8 wegen CPU-Timeout)

---

## 2. IDENTIFIZIERTE QUALITÄTSPROBLEME

### Problem 1: Tile-Auflösung bei Print-Rendering (Server)
**Ort:** `server/index.ts` → `loadTileBuffer()`

**Aktuelles Verhalten:**
```typescript
// loadTileBuffer() - URL-Auswahl für Tile-Größe
if (size <= 128) {
  url = tileUrls.tile128Url || tileUrls.sourceUrl;
} else if (hasExternalSource) {
  url = tileUrls.sourceUrl || tileUrls.tile128Url;  // ✅ OK: Pexels/Unsplash ~940px
} else if (tileUrls.tile256Url) {
  url = tileUrls.tile256Url;  // ✅ OK: R2 mit 256px
} else {
  url = tileUrls.tile128Url || tileUrls.sourceUrl;  // ⚠️ PROBLEM: 128px → 157px = 1.2x upscale
}
```

**Problem:**
- Bei `tilePx = 157` (400 DPI) werden R2-Tiles ohne `tile256_url` von 128px auf 157px hochskaliert
- **1.2x Upscale** ist akzeptabel, aber nicht optimal für Druckqualität
- Bei größeren Formaten (z.B. 100x100 cm mit reduzierten `tilePx`) kann die Qualität leiden

**Betroffene Tiles:**
- R2-Tiles ohne `tile256_url` (ältere Imports)
- User-uploaded Tiles (werden mit 512px hochgeladen, aber nicht in DB gespeichert)

### Problem 2: Tile-Auflösung bei Digital Download (Client)
**Ort:** `client/src/pages/Studio.tsx` → `renderMosaicClientSide()`

**Aktuelles Verhalten:**
```typescript
// Hi-Res Reload: Lädt DB-Tiles via source_url (Pexels/Unsplash ~940px)
const hiResNeeded = uniqueIdxs.filter(idx => {
  const dbId = tileIds[idx];
  return dbId && dbId > 0; // reload all DB tiles, skip user tiles
});

// User tiles: verwendet hiResImgs (512px) oder validImgs (128px thumbnail)
const hiImg = reloadedImg || hiResImgs[idx];
const img = (hiImg && hiImg.complete && hiImg.naturalWidth > 0) ? hiImg : validImgs[idx];
```

**Problem:**
- **DB-Tiles:** ✅ Werden mit `source_url` (940px) geladen → gute Qualität
- **User-Tiles:** ⚠️ Verwenden `hiResImgs` (512px) → bei `tilePx = 157` ist das ausreichend, aber bei HD (`tilePx = 100`) könnte es besser sein
- **Fallback:** ❌ Wenn `hiResImgs` fehlt (GC'd), wird `validImgs` (128px thumbnail) verwendet → schlechte Qualität

### Problem 3: Canvas Memory Limits (Desktop vs. Mobile)
**Ort:** `client/src/pages/Studio.tsx` → `renderMosaicClientSide()`

**Aktuelles Verhalten:**
```typescript
const SERVER_MAX_DIM = 16000;
let TILE_PX = Math.min(Math.max(digFmt.tilePx, 32), 256);
if (cols * TILE_PX > SERVER_MAX_DIM || rows * TILE_PX > SERVER_MAX_DIM) {
  TILE_PX = Math.min(Math.floor(SERVER_MAX_DIM / cols), Math.floor(SERVER_MAX_DIM / rows), TILE_PX);
  TILE_PX = Math.max(32, TILE_PX);
}
```

**Problem:**
- **Desktop:** `SERVER_MAX_DIM = 16000` → bei 100x100 Tiles wird `tilePx` auf 160 reduziert (statt 157)
- **Große Mosaiken:** Bei 150x150 Tiles wird `tilePx` auf 106 reduziert (statt 157) → **32% Qualitätsverlust**
- **Mobile:** Gleiche Limits, aber mobile Geräte haben zusätzlich Canvas-Memory-Limits (~16 MP)

**Beispiel-Rechnung:**
- 100x100 Tiles @ 157px/tile = 15700x15700 px = 246 MP ❌ Überschreitet 16000px Limit
- 100x100 Tiles @ 160px/tile = 16000x16000 px = 256 MP ✅ Innerhalb Limit (aber knapp)
- 150x150 Tiles @ 157px/tile = 23550x23550 px = 555 MP ❌ Weit über Limit
- 150x150 Tiles @ 106px/tile = 15900x15900 px = 253 MP ✅ Innerhalb Limit (aber 32% Qualitätsverlust)

### Problem 4: Farbkorrektur-Parameter (LAB)
**Ort:** `client/src/pages/Studio.tsx` → `renderMosaicClientSide()` + `server/index.ts` → `/api/admin/orders/:id/render`

**Aktuelles Verhalten:**
```typescript
// Client (renderMosaicClientSide)
const AB_BLEND_BASE = 0.12 + 0.20 * blendFactor;  // 0.12..0.32
const AB_BLEND = AB_BLEND_BASE * colorEnhanceVal;  // 0 at colorEnhance=0
const MAX_COLOR_SHIFT = 15;
const MAX_BLUE_SHIFT = 5;

// Server (admin render)
const AB_BLEND = 0.15 * (colorEnhance / 100);  // ⚠️ UNTERSCHIED: 0.15 statt 0.12-0.32
const MAX_COLOR_SHIFT = 15;
const MAX_BLUE_SHIFT = 5;
```

**Problem:**
- **Inkonsistenz:** Server verwendet festen `AB_BLEND_BASE = 0.15`, Client verwendet `0.12 + 0.20 * blendFactor`
- **Fehlende Parameter:** Server berücksichtigt `histogramBlend` nicht → `blendFactor` fehlt
- **Resultat:** Server-Render (Print) sieht anders aus als Client-Render (Digital Download)

### Problem 5: Overlay-Anwendung (Foto-Overlay Slider)
**Ort:** `client/src/pages/Studio.tsx` → `renderMosaicClientSide()` + `server/index.ts` → `/api/admin/orders/:id/render`

**Aktuelles Verhalten:**
```typescript
// Client: Overlay wird NACH allen Tiles auf gesamtes Canvas angewendet
if (userOverlay > 0 && userPhotoImg && userPhotoImg.complete && userPhotoImg.naturalWidth > 0) {
  ctx.save();
  ctx.globalAlpha = userOverlay / 100;
  ctx.drawImage(userPhotoImg, 0, 0, W, H);
  ctx.restore();
}

// Server: Overlay wird PER-TILE in LAB-Schleife angewendet (softLight blend)
if (applyOl) {
  nr = Math.round(nr*(1-str) + softLightAdmin(nr,tR)*str);
  ng = Math.round(ng*(1-str) + softLightAdmin(ng,tG)*str);
  nb = Math.round(nb*(1-str) + softLightAdmin(nb,tBv)*str);
}
```

**Problem:**
- **Unterschiedliche Methoden:** Client = globalAlpha auf gesamtes Bild, Server = softLight per Pixel
- **Resultat:** Server-Render (Print) sieht anders aus als Client-Render (Digital Download)

---

## 3. EMPFOHLENE FIXES (Priorisiert)

### Fix 1: Tile-Auflösung für Print erhöhen (Server)
**Priorität:** 🔴 HOCH
**Ort:** `server/index.ts` → `loadTileBuffer()`

**Lösung:**
1. **Neue Spalte:** `tile256_url` in `mosaic_images` Tabelle (bereits vorhanden)
2. **Import-Update:** Bei neuem Import immer `tile256_url` speichern (256px Version für Print)
3. **loadTileBuffer-Update:**
   ```typescript
   if (size <= 128) {
     url = tileUrls.tile128Url || tileUrls.sourceUrl;
   } else if (size <= 256 && tileUrls.tile256Url) {
     url = tileUrls.tile256Url;  // ✅ NEU: Verwende 256px für Print
   } else if (hasExternalSource) {
     url = tileUrls.sourceUrl;  // ✅ Pexels/Unsplash ~940px
   } else {
     url = tileUrls.tile256Url || tileUrls.tile128Url;  // Fallback
   }
   ```

**Erwartete Verbesserung:**
- R2-Tiles: 256px statt 128px → **2x bessere Auflösung** für Print
- Keine Upscaling-Artefakte mehr bei `tilePx = 157`

### Fix 2: SERVER_MAX_DIM erhöhen (Desktop)
**Priorität:** 🟡 MITTEL
**Ort:** `client/src/pages/Studio.tsx` → `renderMosaicClientSide()`

**Lösung:**
```typescript
// Desktop: Erhöhe Limit auf 20000px (400 MP statt 256 MP)
// Mobile: Behalte 16000px (256 MP) wegen Canvas-Memory-Limits
const isMobileDevice = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
const SERVER_MAX_DIM = isMobileDevice ? 16000 : 20000;
```

**Erwartete Verbesserung:**
- 100x100 Tiles @ 157px/tile = 15700x15700 px ✅ Kein Clamping mehr
- 127x127 Tiles @ 157px/tile = 19939x19939 px ✅ Innerhalb neuem Limit
- 150x150 Tiles @ 157px/tile = 23550x23550 px ❌ Immer noch über Limit (aber seltener Fall)

**Risiko:**
- Desktop-Browser können 400 MP Canvas handhaben (getestet in Chrome/Firefox)
- Mobile bleibt bei 16 MP Limit (iOS Safari)

### Fix 3: LAB-Parameter synchronisieren (Client ↔ Server)
**Priorität:** 🟡 MITTEL
**Ort:** `server/index.ts` → `/api/admin/orders/:id/render`

**Lösung:**
```typescript
// Server: Übernehme Client-Parameter aus render_params
const histogramBlend = renderParams.histogramBlend ?? 0.0;
const blendFactor = Math.min(1.0, histogramBlend / 0.10);
const AB_BLEND_BASE = 0.12 + 0.20 * blendFactor;  // ✅ Gleich wie Client
const AB_BLEND = AB_BLEND_BASE * (colorEnhance / 100);
```

**Erwartete Verbesserung:**
- Server-Render (Print) sieht identisch aus wie Client-Render (Digital Download)
- Keine Farbabweichungen mehr zwischen Preview und Print

### Fix 4: Overlay-Methode vereinheitlichen (Client ↔ Server)
**Priorität:** 🟢 NIEDRIG
**Ort:** `server/index.ts` → `/api/admin/orders/:id/render`

**Lösung:**
```typescript
// Server: Verwende globalAlpha-Methode wie Client (einfacher + konsistent)
// NACH allen Tiles: Overlay-Bild mit globalAlpha auf gesamtes Canvas zeichnen
if (userOverlay > 0 && overlayBase64) {
  const overlayBuf = Buffer.from(overlayBase64, 'base64');
  const overlayResized = await sharp(overlayBuf)
    .resize(outW, outH, { fit: 'fill' })
    .ensureAlpha()
    .toBuffer();
  // Apply alpha via Sharp composite
  const overlayWithAlpha = await sharp(overlayResized)
    .composite([{ input: Buffer.alloc(outW * outH, Math.round(userOverlay * 2.55)), raw: { width: outW, height: outH, channels: 1 } }])
    .png()
    .toBuffer();
  baseBuf = await sharp(baseBuf)
    .composite([{ input: overlayWithAlpha, blend: 'over' }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
```

**Erwartete Verbesserung:**
- Server-Render (Print) sieht identisch aus wie Client-Render (Digital Download)
- Overlay-Effekt ist konsistent

### Fix 5: Hi-Res Fallback verbessern (Client)
**Priorität:** 🟢 NIEDRIG
**Ort:** `client/src/pages/Studio.tsx` → `renderMosaicClientSide()`

**Lösung:**
```typescript
// Wenn hiResImgs fehlt (GC'd), verwende snapshot statt validImgs (128px)
const img = (hiImg && hiImg.complete && hiImg.naturalWidth > 0) ? hiImg : validImgs[idx];
if (!img || !img.complete || img.naturalWidth === 0) {
  // Fallback: Verwende snapshot-Region (preview-Qualität) statt flat color
  if (snapCtx && snapshot && snapshot.width > 0 && snapshot.height > 0) {
    const snapTileW = snapshot.width / cols;
    const snapTileH = snapshot.height / rows;
    ctx.drawImage(snapCanvas, col * snapTileW, row * snapTileH, snapTileW, snapTileH, x, y, actualTile, actualTile);
  }
}
```

**Erwartete Verbesserung:**
- Wenn Tiles fehlen (GC'd), wird snapshot verwendet → bessere Qualität als 128px thumbnail

---

## 4. IMPLEMENTIERUNGS-REIHENFOLGE

1. **Fix 1** (Tile-Auflösung Server) → Größte Qualitätsverbesserung
2. **Fix 2** (SERVER_MAX_DIM Desktop) → Verhindert Clamping bei großen Mosaiken
3. **Fix 3** (LAB-Parameter) → Konsistenz Client ↔ Server
4. **Fix 4** (Overlay-Methode) → Optional, nur wenn Inkonsistenzen auffallen
5. **Fix 5** (Hi-Res Fallback) → Optional, nur wenn GC-Probleme auftreten

---

## 5. TESTING-PLAN

### Test 1: Kleine Mosaiken (50x50 Tiles)
- **Digital Download:** HD (100px/tile) → 5000x5000 px
- **Digital Download:** Ultra HD (157px/tile) → 7850x7850 px
- **Print Order:** 50x50 cm @ 157px/tile → 7850x7850 px
- **Erwartung:** Keine Qualitätsunterschiede, kein Clamping

### Test 2: Mittlere Mosaiken (100x100 Tiles)
- **Digital Download:** HD (100px/tile) → 10000x10000 px
- **Digital Download:** Ultra HD (157px/tile) → 15700x15700 px
- **Print Order:** 100x100 cm @ 157px/tile → 15700x15700 px
- **Erwartung:** Nach Fix 2 kein Clamping mehr auf Desktop

### Test 3: Große Mosaiken (150x150 Tiles)
- **Digital Download:** HD (100px/tile) → 15000x15000 px
- **Digital Download:** Ultra HD (157px/tile) → 23550x23550 px → **Clamping auf 20000px** (nach Fix 2)
- **Print Order:** 150x150 cm @ 157px/tile → 23550x23550 px → **Clamping auf 20000px**
- **Erwartung:** Clamping reduziert `tilePx` auf 133px (statt 106px vorher) → **25% besser**

### Test 4: Farbgenauigkeit (LAB)
- **Vergleich:** Client-Render (Digital Download) vs. Server-Render (Print Order)
- **Erwartung:** Nach Fix 3 identische Farben

### Test 5: Overlay-Konsistenz
- **Vergleich:** Client-Render (Digital Download) vs. Server-Render (Print Order) mit `userOverlay = 50%`
- **Erwartung:** Nach Fix 4 identischer Overlay-Effekt

---

## 6. NÄCHSTE SCHRITTE

1. ✅ Analyse abgeschlossen
2. ⏳ Fixes implementieren (Fix 1-3)
3. ⏳ Testen (Test 1-5)
4. ⏳ Deployen
5. ⏳ Nutzer-Feedback einholen
