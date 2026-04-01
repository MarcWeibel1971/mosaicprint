# Bug Fixes - MosaicPrint Studio

## Bug 1: Pop-Out Tile Blurry (Tile-Detail-Dialog)

**Problem**: Wenn man auf ein Tile klickt um es im Detail-Dialog anzuzeigen, ist das Bild unscharf.

**Root Cause**:
1. Zeile 4955-4958: Der Code lädt nur 400px Tiles statt 512px
2. Keine Validierung ob `tileId` gültig ist (könnte `undefined` oder `0` sein)
3. Fallback auf 64px Thumbnail wenn tileId ungültig ist

**Fix**:
```js
// Zeile 4955-4958 VORHER:
const tileId = tileIdsRef.current[tileIdx];
if (tileId && tileId > 0) {
  tileUrl = `/api/tile/${tileId}?size=400`;
}

// NACHHER:
const tileId = tileIdsRef.current?.[tileIdx];
if (tileId && tileId > 0) {
  // Load 512px for sharp detail view (was 400px)
  tileUrl = `/api/tile/${tileId}?size=512&t=${Date.now()}`;
} else if (!tileId) {
  console.warn(`[TileDetail] Invalid tileId for tileIdx=${tileIdx}, tileIdsRef.length=${tileIdsRef.current?.length}`);
}
```

## Bug 2: Max Zoom (800%) Blurry

**Problem**: Bei maximalem Zoom (800%) sind die Tiles pixeliert/unscharf.

**Root Cause**:
1. Zeile 6305: Bei `zoom > 1` wird `imageRendering: "pixelated"` gesetzt
2. Das Hi-Res-Bild wird nur bei `zoom > 1.5` angezeigt
3. Zwischen 100% und 150% Zoom: Canvas mit 8px Tiles wird auf 8-12px CSS vergrößert → pixeliert
4. Bei 800% Zoom: Wenn `hiResReady` false ist, bleibt der pixelierte Canvas sichtbar

**Fix**:
- Option A: Hi-Res-Rendering ab `zoom > 1.0` triggern (statt 1.5)
- Option B: `imageRendering: "auto"` bis Hi-Res bereit ist (smooth upscaling)
- Option C: Hi-Res-Rendering zuverlässiger machen (immer erfolgreich)

**Empfehlung**: Option B + C kombinieren

## Bug 3: Mobile Print Crash

**Problem**: Beim Bestellen auf Mobile verschwindet das gesamte Mosaik (vermutlich Page-Reload/Crash).

**Root Cause**: TBD - muss getestet werden

**Hinweis**: Mobile-spezifischer Flow wurde bereits implementiert (commit 4ce00e8):
- Skip user-tile upload
- Flag orders mit "📱 MOBILE-BESTELLUNG"
- Admin kann Desktop-Re-Render triggern

**Nächste Schritte**: Testen ob der Bug noch existiert nach den Fixes für Bug 1+2
