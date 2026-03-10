import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X, Settings } from "lucide-react";

// Mosaic-grid logo mark
function LogoMark() {
  const colors = ["#e8573a", "#3dbfb8", "#f59e0b", "#6366f1", "#22c55e", "#ec4899", "#d44228", "#2aada6", "#d97706"];
  return (
    <div
      className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0"
      style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "2px", padding: "3px", background: "#1a1a1a" }}
    >
      {colors.map((c, i) => (
        <div key={i} style={{ backgroundColor: c, borderRadius: "2px" }} />
      ))}
    </div>
  );
}

const NAV_LINKS = [
  { to: "/studio", label: "Studio" },
  { to: "/so-funktionierts", label: "So funktioniert's" },
  { to: "/preise", label: "Preise" },
];

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const isActive = (to: string) => pathname === to || pathname.startsWith(to + "/");

  return (
    <nav className="sticky top-0 z-50 bg-cream-100/95 backdrop-blur-sm border-b border-cream-300">
      <div className="max-w-6xl mx-auto px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <Link to="/" className="flex items-center gap-2.5 flex-shrink-0">
            <LogoMark />
            <div>
              <div className="font-serif text-lg text-gray-900 leading-none">MosaicPrint</div>
              <div className="text-[10px] text-gray-400 leading-none tracking-wider uppercase">Dein Foto als Kunstwerk</div>
            </div>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-7">
            {NAV_LINKS.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`text-sm font-medium transition-colors ${
                  isActive(to)
                    ? "text-coral-600"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>

          {/* Desktop CTA */}
          <div className="hidden md:flex items-center gap-3">
            <Link
              to="/admin"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-coral-500 transition-colors px-2 py-1.5 rounded-lg hover:bg-cream-200"
              title="Admin-Bereich"
            >
              <Settings className="w-3.5 h-3.5" />
              Admin
            </Link>
            <Link
              to="/studio"
              className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full shadow-md hover:shadow-lg transition-all duration-200"
            >
              Mosaik erstellen
            </Link>
          </div>

          {/* Mobile menu button */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-cream-200 transition-colors"
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-cream-300 bg-cream-100 px-6 py-4 space-y-1">
          {NAV_LINKS.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setMenuOpen(false)}
              className={`block px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                isActive(to) ? "bg-coral-50 text-coral-700" : "text-gray-700 hover:bg-cream-200"
              }`}
            >
              {label}
            </Link>
          ))}
          <div className="pt-3 border-t border-cream-300 space-y-2">
            <Link
              to="/admin"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-500 hover:bg-cream-200 transition-colors"
            >
              <Settings className="w-4 h-4" />
              Admin-Bereich
            </Link>
            <Link
              to="/studio"
              onClick={() => setMenuOpen(false)}
              className="block text-center bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-3 rounded-full transition-all"
            >
              Mosaik erstellen
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
