import { Link } from "react-router-dom";
import { Check, Printer, Download, ArrowRight, ExternalLink, Grid3X3 } from "lucide-react";

const FORMATS = [
  {
    size: "20×20 cm",
    pixels: "2362×2362 px",
    price: 29,
    popular: false,
    desc: "Ideal für Schreibtisch oder Regal",
  },
  {
    size: "30×30 cm",
    pixels: "3543×3543 px",
    price: 49,
    popular: true,
    desc: "Bestseller – perfekt für Wohnzimmer",
  },
  {
    size: "40×40 cm",
    pixels: "4724×4724 px",
    price: 69,
    popular: false,
    desc: "Imposant & detailreich",
  },
  {
    size: "50×70 cm",
    pixels: "5906×8268 px",
    price: 99,
    popular: false,
    desc: "Galerie-Format für grosse Wände",
  },
  {
    size: "70×70 cm",
    pixels: "8268×8268 px",
    price: 139,
    popular: false,
    desc: "Maximale Wirkung",
  },
  {
    size: "100×100 cm",
    pixels: "11811×11811 px",
    price: 199,
    popular: false,
    desc: "Statement-Piece für besondere Räume",
  },
];

const MATERIALS = [
  {
    name: "Leinwand",
    desc: "Klassisch & warm. Gespannt auf Holzrahmen, bereit zum Aufhängen.",
    surcharge: 0,
    icon: "🖼️",
  },
  {
    name: "Acrylglas",
    desc: "Modern & glänzend. Brillante Farben, tiefe Kontraste, premium Auftritt.",
    surcharge: 20,
    icon: "✨",
  },
  {
    name: "Alu-Dibond",
    desc: "Zeitlos & robust. Matte oder glänzende Oberfläche, extrem langlebig.",
    surcharge: 15,
    icon: "🔲",
  },
  {
    name: "Fotopapier",
    desc: "Klassischer Fotoabzug. Ideal zum Einrahmen oder als Poster.",
    surcharge: -10,
    icon: "📄",
  },
];

const INCLUDED = [
  "Hochauflösende Mosaik-Generierung",
  "Unbegrenzte Vorschau & Anpassungen",
  "Digitaler Download (PNG) inklusive",
  "Professioneller Druck durch Printolino.ch",
  "Lieferung in die Schweiz, D, A",
  "30 Tage Zufriedenheitsgarantie",
];

export default function Pricing() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-brand-50 py-16">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h1 className="text-4xl font-extrabold text-gray-900 mb-4">Preise & Formate</h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Transparente Preise, keine versteckten Kosten. Vorschau immer kostenlos.
          </p>
        </div>

        {/* Format grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-14">
          {FORMATS.map(({ size, pixels, price, popular, desc }) => (
            <div
              key={size}
              className={`relative bg-white rounded-2xl p-6 border-2 transition-all hover:shadow-lg ${
                popular ? "border-brand-500 shadow-md" : "border-gray-100 hover:border-brand-200"
              }`}
            >
              {popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-600 text-white text-xs font-bold px-3 py-1 rounded-full">
                  Bestseller
                </div>
              )}
              <div className="text-2xl font-extrabold text-gray-900 mb-1">{size}</div>
              <div className="text-xs text-gray-400 mb-3 font-mono">{pixels}</div>
              <div className="text-3xl font-extrabold text-brand-700 mb-1">CHF {price}</div>
              <div className="text-sm text-gray-500 mb-4">{desc}</div>
              <Link
                to="/studio"
                className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm transition-all ${
                  popular
                    ? "bg-gradient-to-r from-brand-500 to-brand-700 text-white hover:from-brand-600 hover:to-brand-800 shadow-sm"
                    : "bg-brand-50 text-brand-700 hover:bg-brand-100"
                }`}
              >
                <Printer className="w-4 h-4" />
                Dieses Format wählen
              </Link>
            </div>
          ))}
        </div>

        {/* Materials */}
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100 mb-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Materialien</h2>
          <p className="text-gray-500 mb-6">Wähle das Material, das zu deinem Raum passt.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {MATERIALS.map(({ name, desc, surcharge, icon }) => (
              <div key={name} className="flex gap-4 p-4 rounded-xl border border-gray-100 hover:border-brand-200 transition-colors">
                <div className="text-3xl">{icon}</div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-gray-900">{name}</span>
                    <span className={`text-sm font-semibold ${surcharge > 0 ? "text-orange-600" : surcharge < 0 ? "text-green-600" : "text-gray-500"}`}>
                      {surcharge > 0 ? `+CHF ${surcharge}` : surcharge < 0 ? `−CHF ${Math.abs(surcharge)}` : "Inklusive"}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* What's included */}
        <div className="bg-gradient-to-br from-brand-50 to-blue-50 rounded-2xl p-8 border border-brand-100 mb-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Immer inklusive</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {INCLUDED.map((item) => (
              <div key={item} className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0">
                  <Check className="w-3 h-3 text-white" />
                </div>
                <span className="text-gray-700 text-sm">{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Digital download option */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 mb-10 flex items-center gap-5">
          <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center flex-shrink-0">
            <Download className="w-6 h-6 text-green-600" />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-gray-900 mb-1">Nur digitaler Download</h3>
            <p className="text-sm text-gray-500">Möchtest du das Mosaik selbst drucken? Lade die hochauflösende PNG-Datei für CHF 9.90 herunter.</p>
          </div>
          <Link
            to="/studio"
            className="flex-shrink-0 bg-green-50 text-green-700 hover:bg-green-100 font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
          >
            CHF 9.90
          </Link>
        </div>

        {/* Printolino partner */}
        <div className="bg-gray-900 rounded-2xl p-6 text-white flex items-center gap-5 mb-10">
          <div className="text-4xl">🇨🇭</div>
          <div className="flex-1">
            <h3 className="font-bold mb-1">Druckpartner: Printolino.ch</h3>
            <p className="text-sm text-gray-300">Schweizer Qualität, produziert in der Schweiz. Printolino.ch ist einer der führenden Fotodruck-Anbieter der Schweiz.</p>
          </div>
          <a
            href="https://www.printolino.ch"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            printolino.ch
          </a>
        </div>

        <div className="text-center">
          <Link
            to="/studio"
            className="inline-flex items-center gap-2 bg-gradient-to-r from-brand-500 to-brand-700 hover:from-brand-600 hover:to-brand-800 text-white font-bold text-lg px-8 py-4 rounded-2xl shadow-lg hover:shadow-xl transition-all"
          >
            <Grid3X3 className="w-5 h-5" />
            Kostenlose Vorschau erstellen
            <ArrowRight className="w-5 h-5" />
          </Link>
          <p className="text-gray-400 text-sm mt-3">Keine Registrierung · Vorschau kostenlos · Erst beim Bestellen zahlen</p>
        </div>
      </div>
    </div>
  );
}
