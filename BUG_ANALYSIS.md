# Bug-Analyse: Katastrophales Mosaik nach Deploy

## Symptome
- Extrem fleckig, fast schwarz-weiß
- Harte Kontraste, Gesichter kaum erkennbar
- Sieht aus wie "Noise" statt Mosaik

## Verdächtige Änderungen

### 1. White-Hair-Preset wird IMMER angewendet (vorher nur portrait)
- VORHER: `if (imageType === 'portrait') {` → Portrait-Preset
- NACHHER: Neue `isWhiteHairPortrait` Logik VOR dem Portrait-Check
- Problem: Die `_earlyHairBrightRatio` und `_earlyBrightRatio` Berechnung könnte falsch sein

### 2. Dynamische Gewichts-Anpassung zu aggressiv
- `wBrightBase *= (1 + lightFaceBoost * 0.5)` → bis 1.5× brightness
- `wLabBase *= (1 - lightFaceBoost * 0.4)` → bis 0.6× LAB
- `wSatBase *= (1 - lightFaceBoost * 0.4)` → bis 0.6× saturation
- Problem: Wenn lightFaceBoost=1.0, wird LAB fast ignoriert → Tiles werden NUR nach Helligkeit gewählt

### 3. Regionale Gewichte mit Math.max() zu hoch
- `Math.max(wLabBase * 1.2, 0.40 * ...)` → LAB kann auf 0.40 springen (von 0.15!)
- `Math.max(wBrightBase * 1.3, 0.65)` → Brightness kann auf 0.65 springen
- `Math.max(edgeWeight * 3.0, 0.30)` → Edge kann auf 0.30 springen
- `Math.max(wSatBase * 1.5, 0.45 * ...)` → Sat kann auf 0.45 springen
- Problem: Die Math.max() Werte sind ABSOLUTE Werte, nicht relative Multiplikatoren!
  → Die Gesamtsumme der Gewichte explodiert → Score-Verteilung wird komplett verzerrt

### 4. Overlay faceBoost für eye/mouth: 0.35 statt 0.25
- Stärker, aber nicht katastrophal

## Hauptursache
Die Math.max()-Aufrufe in den regionalen Gewichten setzen ABSOLUTE Mindestwerte,
die viel höher sind als die normalen Gewichte. Das verzerrt die Score-Berechnung komplett.

## Fix
ALLE Math.max() durch einfache Multiplikatoren ersetzen (wie vorher).
Die dynamische Gewichts-Anpassung sanfter machen.
