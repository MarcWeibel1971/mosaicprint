import { Link } from "react-router-dom";
import { ExternalLink, Heart } from "lucide-react";

function LogoMark() {
  const colors = ["#e8573a", "#3dbfb8", "#f59e0b", "#6366f1", "#22c55e", "#ec4899", "#d44228", "#2aada6", "#d97706"];
  return (
    <div
      className="w-7 h-7 rounded-md overflow-hidden flex-shrink-0"
      style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "2px", padding: "2px", background: "#1a1a1a" }}
    >
      {colors.map((c, i) => (
        <div key={i} style={{ backgroundColor: c, borderRadius: "1px" }} />
      ))}
    </div>
  );
}

export function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-300 py-14">
      <div className="max-w-6xl mx-auto px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-10">

          {/* Brand */}
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <LogoMark />
              <span className="font-serif text-lg text-white">MosaicPrint</span>
            </div>
            <p className="text-sm text-gray-400 leading-relaxed">
              Verwandle dein Lieblingsfoto in ein einzigartiges Mosaik-Kunstwerk –
              hochauflösend, druckfertig, unvergesslich.
            </p>
          </div>

          {/* Links */}
          <div>
            <h3 className="font-semibold text-white mb-4 text-xs uppercase tracking-widest">Produkt</h3>
            <ul className="space-y-2.5 text-sm">
              <li><Link to="/studio" className="hover:text-white transition-colors">Mosaik erstellen</Link></li>
              <li><Link to="/so-funktionierts" className="hover:text-white transition-colors">So funktioniert's</Link></li>
              <li><Link to="/preise" className="hover:text-white transition-colors">Preise & Formate</Link></li>
            </ul>
          </div>

          {/* Partner */}
          <div>
            <h3 className="font-semibold text-white mb-4 text-xs uppercase tracking-widest">Druckpartner</h3>
            <a
              href="https://www.printolino.ch"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm hover:text-white transition-colors mb-2"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Printolino.ch – Schweizer Fotodruck
            </a>
            <p className="text-xs text-gray-500 leading-relaxed">
              Professioneller Fotodruck in der Schweiz. Leinwand, Acryl, Alu-Dibond und mehr.
            </p>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-gray-500">© 2026 MosaicPrint. Alle Rechte vorbehalten.</p>
          <p className="text-xs text-gray-500 flex items-center gap-1">
            Gemacht mit <Heart className="w-3 h-3 text-coral-400 fill-coral-400" /> in der Schweiz
          </p>
        </div>
      </div>
    </footer>
  );
}
