# Blaustich-Analyse — Final

## Root Cause

Es gibt **zwei unabhängige Farbkorrektur-Schichten**, die sich addieren:

### Schicht 1: Haupt-Render (renderMosaicClientSide, Zeile 4304-4310)
- `AB_BLEND = 0.12 + 0.20 * blendFactor` (basiert auf histogramBlend aus Admin-Settings)
- **Minimum AB_BLEND = 0.12** — IMMER aktiv, auch bei colorEnhance=0
- Verschiebt Tile-Farben Richtung Zielfarbe (aus dem Originalfoto)
- Bei blauen Bereichen (Himmel/Wasser) → Blaustich auf allen Tiles
- MAX_BLUE_SHIFT = 10 begrenzt, aber -10 in b* ist sichtbar

### Schicht 2: Color Enhance Overlay (Zeile 6173-6198)
- CSS `<img>` mit `mix-blend-mode: color` und `opacity: colorEnhance/100`
- Zeigt die Zielfarben pro Zelle als Overlay
- Bei colorEnhance=8 → opacity=0.08 → zusätzlicher leichter Farbstich

### Zusammen: Doppelter Blaustich
1. Haupt-Render baked bereits AB_BLEND=0.12 in die Pixel → leichter Blaustich
2. Color Enhance Overlay addiert nochmal 8% → verstärkt den Blaustich

## Lösung

1. **AB_BLEND im Haupt-Render reduzieren**: Minimum von 0.12 auf 0.0 senken
   - Wenn histogramBlend=0 → kein AB-Shift → kein Blaustich
   - Die Farbkorrektur soll NUR über den colorEnhance-Slider gesteuert werden
   
2. **MAX_BLUE_SHIFT aggressiver begrenzen**: von 10 auf 5 reduzieren
   - Menschliches Auge ist extrem empfindlich auf Blaustich
   
3. **Alternativ**: AB_BLEND im Haupt-Render mit colorEnhanceRef skalieren
   - colorEnhance=0 → AB_BLEND=0
   - colorEnhance=100 → volle Stärke
