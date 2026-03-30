# Bug Analysis

## Bug 1: Overlay/Farbkorrektur nicht wiederhergestellt beim Projekt-Laden

**Root Cause:** 
- `saveProject` (Zeile 4876) speichert NICHT `userOverlay` und `colorEnhance` in den Projektdaten
- Beim Laden (Zeile 5036ff) werden diese Werte daher nicht wiederhergestellt
- Die Slider stehen auf 0%/0% nach dem Laden

**Fix:**
1. In `saveProject`: `userOverlay` und `colorEnhance` zum `data`-Objekt hinzufügen
2. In `loadProject` (Zeile 5036ff): `userOverlay` und `colorEnhance` wiederherstellen
3. In `restoreProject` (Zeile 4949ff): dasselbe

## Bug 2: Pop-Out-Kacheln unscharf

**Root Cause:** Muss Pop-Out-Rendering-Code analysieren (Zeile 4584ff)
