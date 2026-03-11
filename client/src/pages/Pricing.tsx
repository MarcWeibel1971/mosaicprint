import { Link } from "react-router-dom";
import { Check, ArrowRight } from "lucide-react";

const PACKAGES = [
  {
    name: "Starter",
    subtitle: "Perfekt für ein erstes Mosaik",
    price: 49,
    color: "#0f172a",
    highlight: false,
    features: [
      "50×50 Tiles",
      "A3-Format (30×42 cm)",
      "Fotopapier-Druck",
      "Lieferung in 5 Werktagen",
      "Digitale Vorschau",
    ],
    cta: "Auswählen",
    ctaStyle: "outline",
  },
  {
    name: "Premium",
    subtitle: "Das beliebteste Paket",
    price: 89,
    color: "#f97316",
    highlight: true,
    badge: "BELIEBTESTE WAHL",
    features: [
      "100×100 Tiles",
      "A2-Format (42×60 cm)",
      "Leinwand oder Alu-Dibond",
      "Lieferung in 48h",
      "Digitale Vorschau",
      "Unbegrenzte Korrekturen",
    ],
    cta: "Jetzt bestellen",
    ctaStyle: "filled",
  },
  {
    name: "Galerie",
    subtitle: "Für Kunstliebhaber",
    price: 149,
    color: "#6366f1",
    highlight: false,
    features: [
      "200×200 Tiles",
      "A1-Format (60×84 cm)",
      "Museum-Leinwand mit Rahmen",
      "Express-Lieferung in 24h",
      "Digitale Vorschau",
      "Unbegrenzte Korrekturen",
      "Persönliche Beratung",
    ],
    cta: "Auswählen",
    ctaStyle: "outline",
  },
];

const TESTIMONIALS = [
  {
    name: "Sarah M.",
    location: "Zürich",
    text: "Das Mosaik aus unseren Urlaubsfotos ist ein absolutes Highlight in unserem Wohnzimmer. Jeder Gast fragt danach!",
    rating: 5,
  },
  {
    name: "Thomas K.",
    location: "Bern",
    text: "Zum Geburtstag meiner Frau bestellt – sie war zu Tränen gerührt. Die Qualität ist aussergewöhnlich.",
    rating: 5,
  },
  {
    name: "Lisa R.",
    location: "Basel",
    text: "Schnelle Lieferung, perfekte Qualität. Das Hochzeitsmosaik ist genau so geworden wie ich es mir vorgestellt habe.",
    rating: 5,
  },
];

export default function Pricing() {
  return (
    <div style={{ background: "#fff", minHeight: "100vh" }}>

      {/* ── HERO: Preise ── light background */}
      <section style={{ background: "#f8fafc", padding: "80px 24px 100px", textAlign: "center" }}>
        <div style={{ maxWidth: 700, margin: "0 auto" }}>
          <p style={{ color: "#f97316", fontWeight: 700, letterSpacing: "0.15em", fontSize: 13, textTransform: "uppercase", marginBottom: 16 }}>
            PREISE
          </p>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.2rem)", fontWeight: 800, color: "#0f172a", marginBottom: 20, lineHeight: 1.1 }}>
            Einfache, transparente Preise
          </h1>
          <p style={{ color: "#64748b", fontSize: 18, maxWidth: 500, margin: "0 auto" }}>
            Keine versteckten Kosten. Wähle das Paket, das zu deinem Projekt passt.
          </p>
        </div>
      </section>

      {/* ── PRICING CARDS ── */}
      <section style={{ background: "#f8fafc", padding: "0 24px 80px" }}>
        <div style={{
          maxWidth: 1000,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 24,
          alignItems: "start",
        }}>
          {PACKAGES.map((pkg) => (
            <div key={pkg.name} style={{
              background: "#fff",
              border: pkg.highlight ? `2px solid ${pkg.color}` : "1px solid #e2e8f0",
              borderRadius: 20,
              padding: "32px 28px",
              position: "relative",
              boxShadow: pkg.highlight ? "0 8px 32px rgba(249,115,22,0.15)" : "none",
            }}>
              {pkg.badge && (
                <div style={{
                  position: "absolute",
                  top: -14,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "linear-gradient(135deg, #f97316, #ec4899)",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 800,
                  padding: "4px 14px",
                  borderRadius: 20,
                  letterSpacing: "0.08em",
                  whiteSpace: "nowrap",
                }}>
                  {pkg.badge}
                </div>
              )}

              <h2 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}>
                {pkg.name}
              </h2>
              <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>
                {pkg.subtitle}
              </p>

              <div style={{ marginBottom: 28 }}>
                <span style={{ fontSize: 42, fontWeight: 800, color: pkg.color }}>
                  CHF {pkg.price}
                </span>
                <span style={{ color: "#94a3b8", fontSize: 14, marginLeft: 6 }}>pro Mosaik</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
                {pkg.features.map((f) => (
                  <div key={f} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%",
                      border: `2px solid ${pkg.color}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <Check size={11} color={pkg.color} strokeWidth={3} />
                    </div>
                    <span style={{ color: "#374151", fontSize: 14 }}>{f}</span>
                  </div>
                ))}
              </div>

              <Link to="/studio" style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "14px 24px",
                borderRadius: 50,
                fontWeight: 700,
                fontSize: 15,
                textDecoration: "none",
                ...(pkg.ctaStyle === "filled"
                  ? {
                      background: "linear-gradient(135deg, #f97316, #ec4899)",
                      color: "#fff",
                      border: "none",
                      boxShadow: "0 4px 16px rgba(249,115,22,0.3)",
                    }
                  : {
                      background: "transparent",
                      color: "#0f172a",
                      border: "1.5px solid #e2e8f0",
                    }),
              }}>
                {pkg.cta} <ArrowRight size={15} />
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── MATERIALIEN ── dark background */}
      <section style={{
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        padding: "80px 24px",
      }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <p style={{ color: "#f97316", fontWeight: 700, letterSpacing: "0.15em", fontSize: 13, textTransform: "uppercase", marginBottom: 16 }}>
              MATERIALIEN
            </p>
            <h2 style={{ color: "#fff", fontSize: "clamp(1.8rem, 4vw, 2.5rem)", fontWeight: 800, marginBottom: 12 }}>
              Wähle dein Material
            </h2>
            <p style={{ color: "#94a3b8", fontSize: 16 }}>
              Alle Materialien sind UV-beständig und für die Ewigkeit gemacht.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20 }}>
            {[
              { icon: "🖼️", name: "Leinwand", desc: "Klassisch & warm. Gespannt auf Holzrahmen.", price: "Im Preis" },
              { icon: "✨", name: "Acrylglas", desc: "Modern & glänzend. Brillante Farben.", price: "+CHF 20" },
              { icon: "🔲", name: "Alu-Dibond", desc: "Zeitlos & robust. Extrem langlebig.", price: "+CHF 15" },
              { icon: "📄", name: "Fotopapier", desc: "Klassischer Fotoabzug. Ideal zum Einrahmen.", price: "−CHF 10" },
            ].map((m) => (
              <div key={m.name} style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 16,
                padding: "24px 20px",
                textAlign: "center",
              }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>{m.icon}</div>
                <h3 style={{ color: "#fff", fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{m.name}</h3>
                <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>{m.desc}</p>
                <span style={{
                  color: m.price.startsWith("+") ? "#f97316" : m.price.startsWith("−") ? "#22c55e" : "#94a3b8",
                  fontSize: 13, fontWeight: 700,
                }}>
                  {m.price}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── light background */}
      <section style={{ background: "#f8fafc", padding: "80px 24px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <p style={{ color: "#f97316", fontWeight: 700, letterSpacing: "0.15em", fontSize: 13, textTransform: "uppercase", marginBottom: 16 }}>
              KUNDENSTIMMEN
            </p>
            <h2 style={{ fontSize: "clamp(1.8rem, 4vw, 2.5rem)", fontWeight: 800, color: "#0f172a" }}>
              Was unsere Kunden sagen
            </h2>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 24 }}>
            {TESTIMONIALS.map((t) => (
              <div key={t.name} style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 16,
                padding: "28px 24px",
              }}>
                <div style={{ display: "flex", gap: 2, marginBottom: 16 }}>
                  {Array.from({ length: t.rating }).map((_, i) => (
                    <span key={i} style={{ color: "#f97316", fontSize: 16 }}>★</span>
                  ))}
                </div>
                <p style={{ color: "#374151", fontSize: 15, lineHeight: 1.7, marginBottom: 20, fontStyle: "italic" }}>
                  "{t.text}"
                </p>
                <div>
                  <span style={{ fontWeight: 700, color: "#0f172a", fontSize: 14 }}>{t.name}</span>
                  <span style={{ color: "#94a3b8", fontSize: 13, marginLeft: 6 }}>— {t.location}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── INKLUSIVE ── white */}
      <section style={{ background: "#fff", padding: "60px 24px" }}>
        <div style={{ maxWidth: 700, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 800, color: "#0f172a", marginBottom: 32 }}>
            Immer inklusive
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 48 }}>
            {[
              "Hochauflösende Mosaik-Generierung",
              "Unbegrenzte Vorschau & Anpassungen",
              "Digitaler Download (PNG) inklusive",
              "Professioneller Druck in der Schweiz",
              "Lieferung in die Schweiz, D, A",
              "30 Tage Zufriedenheitsgarantie",
            ].map((item) => (
              <div key={item} style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}>
                <div style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: "linear-gradient(135deg, #f97316, #ec4899)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <Check size={12} color="#fff" strokeWidth={3} />
                </div>
                <span style={{ color: "#374151", fontSize: 14 }}>{item}</span>
              </div>
            ))}
          </div>

          <Link to="/studio" style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "linear-gradient(135deg, #f97316, #ec4899)",
            color: "#fff", fontWeight: 700, fontSize: 17,
            padding: "16px 36px", borderRadius: 50,
            textDecoration: "none",
            boxShadow: "0 8px 24px rgba(249,115,22,0.3)",
          }}>
            Kostenlose Vorschau erstellen <ArrowRight size={18} />
          </Link>
          <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 12 }}>
            Keine Registrierung · Vorschau kostenlos · Erst beim Bestellen zahlen
          </p>
        </div>
      </section>

    </div>
  );
}
