# Empfehlung: Profil "Weisse Haare / Helle Haut"

## Kernproblem
Das Portrait-Profil ist auf low-saturation + kühle Töne optimiert — katastrophal für helle/warme Haut + weisse Haare. Es bestraft helle/warme Tiles zu hart und priorisiert graue/blaue/mitteldunkle Tiles.

## Sofort-Fix: Neues Profil "Weisse Haare"
| Parameter | Aktuell | Empfohlen |
|-----------|---------|-----------|
| Helligkeit (L) | 45% | **70%** |
| Sättigung | 40% | **20%** |
| LAB-Farbe | 30% | **30-35%** |
| Kontrast-Boost | 1.28x | **1.45x** |
| L-Blend | 0.60 | **0.35** |
| AB-Blend | 0.26 | **0.12** |
| Anti-Repetition Penalty | 280 | **160** |
| Overlay Opacity | 0.20 | **0.28** |
| Edge-Boost | 0 | **0.15** |
| Tile-Grösse | 7px | **9px** |

## Mittelfristig
- Regionale Gewichte (Face-Mesh)
- Dynamische Helligkeits-Anpassung (if avgFaceL > 70)
- Mehr helle/neutrale Tiles importieren
