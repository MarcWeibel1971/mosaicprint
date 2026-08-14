# LocateAnything-Prototyp — nur interne Forschung

## Zweck und Abgrenzung

Der Prototyp übersetzt die textförmigen Bounding-Box-Ausgaben von LocateAnything in normalisierte Motivzonen und eine grobe MosaicPrint-Zellenmaske. Damit lässt sich später sichtbar vergleichen, ob eine erkannte Motivzone die Detailerhaltung eines Mosaiks verbessern würde.

Der Prototyp ist bewusst **nicht** in `server/index.ts` eingebunden. Er hat keinen Studio-Button, keine Persistenz und verarbeitet keine Kunden- oder Mitarbeitendenbilder. Er enthält zudem keine Zugangsdaten. Das begrenzt ihn auf lokale Entwicklungsarbeit.

## Aktueller Verfügbarkeitsstatus

Der Hugging-Face-Zugang wurde erfolgreich authentifiziert. Das Modell ist auf dem Hub verfügbar; der serverlose `hf-inference`-Provider führt es jedoch nicht aus. Der Versuch über die öffentliche NVIDIA-Demo wurde ebenfalls nicht als Bildanalyse freigeschaltet, weil die Demo selbst eine nicht zulässige GPU-Dauer anfordert.

| Prüfschritt | Ergebnis |
|---|---|
| Hugging-Face-Authentifizierung | Erfolgreich |
| LocateAnything-3B auf dem Hub | Verfügbar |
| Serverlose Modell-Inferenz | Nicht vom `hf-inference`-Provider unterstützt |
| Öffentliche Demo mit öffentlichem Referenzbild | Derzeit durch fehlerhafte GPU-Dauer der Demo blockiert |
| Kundenbilder an öffentliche Demo | Nicht zulässig; die Demo enthält optionale Logik zur Bildprotokollierung |

## Lokaler Prüfbaustein

`server/vision/locateAnythingPrototype.ts` enthält zwei reine Funktionen:

1. `parseLocateAnythingBoxes()` liest Ausgaben im Format `<ref>…</ref><box><x1><y1><x2><y2></box>` aus.
2. `boxesToCellMask()` übersetzt die normalisierten Boxen in eine binäre Maske für das Mosaikraster.

Der Test kann lokal mit folgendem Befehl laufen:

```bash
pnpm exec tsx scripts/test-locateanything-prototype.ts
```

## Konsequenz

Für diesen internen Forschungsprototypen ist die Auswertungslogik vorbereitet. Eine reale Modellanbindung bleibt deaktiviert, bis ein von NVIDIA schriftlich freigegebener, nicht-öffentlicher Forschungszugang oder eine zulässige Infrastruktur zur Verfügung steht. Diese Begrenzung gilt zusätzlich zur nicht-kommerziellen Modelllizenz.

## Produktionsalternative: Gemini-Motivzonen

Für die Live-Funktion wird Gemini als bevorzugte Alternative bewertet. Der Dienst ist bereits im MosaicPrint-Backend für die Bildanalyse konfiguriert. Die offizielle Gemini-Dokumentation beschreibt Objekt-Bounding-Boxen und Segmentierung mit Koordinaten im Bereich 0–1000; dieses Format passt direkt zur lokalen Maskenlogik des Prototyps. [1]

Für MosaicPrint werden ausschließlich die für das Kachel-Matching nötigen Zonen angefordert: `face`, `person`, `main subject` und, wenn vorhanden, prägende Objekte. Aus den Boxen erzeugt der Server eine temporäre Zellmaske. Sie wird nur für die laufende Mosaikberechnung genutzt und nicht in der Datenbank gespeichert.

> **Datenschutzvoraussetzung:** Für Kundenbilder aus der Schweiz oder dem EWR darf die produktive API-Verwendung nur über eine aktive Google-Cloud-Abrechnung erfolgen. Die Gemini-API-Bedingungen verlangen dort Paid Services für API-Clients. Bei Paid Services verwendet Google Prompts und Bilder nicht zur Produktverbesserung; bei unbezahlten Diensten dürfen diese Inhalte dagegen zur Verbesserung verarbeitet und von menschlichen Prüfern eingesehen werden. [2]

### Quellen

[1]: https://ai.google.dev/gemini-api/docs/image-understanding "Google Gemini API – Image understanding, Objekt- und Segmenterkennung"
[2]: https://ai.google.dev/gemini-api/terms "Google Gemini API – Additional Terms of Service"

## Deployment-Validierung

Der Commit `e65ee50` wurde in den Branch `master` übertragen. Unmittelbar während des Railway-Autodeploys lieferten zwei Aufrufe noch die vorherige Antwortform; ein weiterer Aufruf war transient mit HTTP 500 fehlgeschlagen. Nach Abschluss des Deployments lieferte die produktive API mit dem öffentlichen Referenzbild erfolgreich HTTP 200 und eine validierte `main_subject`-Zone mit normalisierten Koordinaten und einer Gewichtung zurück.

Die Anwendung der Zone im Studio wurde zusätzlich durch TypeScript-Prüfung und Produktions-Build validiert. Die Zone beeinflusst ausschließlich die Kachel-Kandidatenreihenfolge an vorhandenen, detailreichen Konturen. Sie verändert weder Quellpixel, Farben, Transparenz noch den Print-Overlay-Pfad.
