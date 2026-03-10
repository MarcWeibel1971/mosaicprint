import { Link } from "react-router-dom";
import { Upload, Grid3X3, ZoomIn, Printer, Package, ArrowRight } from "lucide-react";

const STEPS = [
  {
    icon: Upload,
    step: "1",
    title: "Foto hochladen",
    desc: "Lade dein Lieblingsfoto hoch – JPG, PNG oder HEIC. Jedes Motiv funktioniert: Portraits, Landschaften, Tiere, Gruppen.",
    gradient: "linear-gradient(135deg, #3b82f6, #2a4fd4)",
  },
  {
    icon: Grid3X3,
    step: "2",
    title: "KI erstellt dein Mosaik",
    desc: "Unsere Engine analysiert jede Zelle deines Fotos und wählt aus Tausenden von Fotos das farblich passendste aus. In Sekunden.",
    gradient: "linear-gradient(135deg, #3b6bff, #2040ab)",
  },
  {
    icon: ZoomIn,
    step: "3",
    title: "Vorschau & Anpassen",
    desc: "Zoom rein und entdecke jedes einzelne Tile-Foto. Passe Schärfe und Overlay-Intensität nach deinem Geschmack an.",
    gradient: "linear-gradient(135deg, #a855f7, #2a4fd4)",
  },
  {
    icon: Printer,
    step: "4",
    title: "Format & Material wählen",
    desc: "Wähle aus verschiedenen Formaten (20×20 bis 100×100 cm) und Materialien: Leinwand, Acryl, Alu-Dibond oder Fotopapier.",
    gradient: "linear-gradient(135deg, #2a4fd4, #1d4ed8)",
  },
  {
    icon: Package,
    step: "5",
    title: "Bestellen & erhalten",
    desc: "Dein Mosaik wird von Printolino.ch in der Schweiz gedruckt und direkt zu dir nach Hause geliefert. Innerhalb von 48 Stunden.",
    gradient: "linear-gradient(135deg, #22c55e, #2a4fd4)",
  },
];

export default function HowItWorks() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-brand-50 py-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h1 className="text-4xl font-extrabold text-gray-900 mb-4">So funktioniert MosaicPrint</h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Von deinem Foto zum fertigen Kunstwerk – in wenigen Minuten.
          </p>
        </div>

        <div className="space-y-6 mb-14">
          {STEPS.map(({ icon: Icon, step, title, desc, gradient }, idx) => (
            <div key={step} className="flex gap-5 bg-white rounded-2xl p-6 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
              <div
                style={{ background: gradient }}
                className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center shadow-md"
              >
                <Icon className="w-6 h-6 text-white" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Schritt {step}</span>
                  {idx < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-100" />}
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-1">{title}</h3>
                <p className="text-gray-500 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* FAQ */}
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100 mb-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Häufige Fragen</h2>
          <div className="space-y-5">
            {[
              {
                q: "Welche Fotos eignen sich am besten?",
                a: "Fotos mit klaren Motiven und gutem Kontrast eignen sich am besten. Portraits, Tiere und Landschaften funktionieren hervorragend. Das Motiv sollte gut erkennbar sein.",
              },
              {
                q: "Wie viele Tiles hat ein Mosaik?",
                a: "Ein Standard-Mosaik besteht aus bis zu 10.000 Tiles (100×100 Raster). Jedes Tile ist ein echtes Foto, das farblich zum Bereich des Originalfotos passt.",
              },
              {
                q: "Welche Materialien sind verfügbar?",
                a: "Über unseren Partner Printolino.ch bieten wir Leinwand, Acrylglas, Alu-Dibond und hochwertiges Fotopapier an. Alle Materialien sind UV-beständig und langlebig.",
              },
              {
                q: "Wie lange dauert die Lieferung?",
                a: "In der Schweiz liefern wir innerhalb von 2-3 Werktagen. Nach Deutschland und Österreich dauert es 3-5 Werktage.",
              },
              {
                q: "Kann ich das Mosaik auch digital herunterladen?",
                a: "Ja! Die hochauflösende Datei kann als PNG heruntergeladen werden. So kannst du sie auch selbst drucken lassen oder digital verwenden.",
              },
            ].map(({ q, a }) => (
              <div key={q} className="border-b border-gray-100 pb-5 last:border-0 last:pb-0">
                <h3 className="font-bold text-gray-900 mb-2">{q}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{a}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="text-center">
          <Link
            to="/studio"
            className="inline-flex items-center gap-2 bg-gradient-to-r from-brand-500 to-brand-700 hover:from-brand-600 hover:to-brand-800 text-white font-bold text-lg px-8 py-4 rounded-2xl shadow-lg hover:shadow-xl transition-all"
          >
            <Grid3X3 className="w-5 h-5" />
            Jetzt Mosaik erstellen
            <ArrowRight className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
