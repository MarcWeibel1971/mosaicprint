import { Link } from "react-router-dom";
import { Check, ArrowRight } from "lucide-react";

const PACKAGES = [
  {
    name: "Starter",
    subtitle: "Perfekt für ein erstes Mosaik",
    price: 49,
    color: "#1a1a2e",
    highlight: false,
    tileCount: "50×50",
    tileLabel: "2’500 Tiles",
    qualityBar: 33,
    qualityLabel: "Gut",
    features: [
      "2’500 Tiles (50×50)",
      "A3-Format (30×42 cm)",
      "Fotopapier-Druck",
      "Lieferung in 5 Werktagen",
      "Kostenlose Vorschau",
    ],
    cta: "Auswählen",
    ctaStyle: "outline",
  },
  {
    name: "Premium",
    subtitle: "Das beliebteste Paket",
    price: 89,
    color: "#FF6B6B",
    highlight: true,
    badge: "BELIEBTESTE WAHL",
    tileCount: "100×100",
    tileLabel: "10’000 Tiles",
    qualityBar: 66,
    qualityLabel: "Sehr gut",
    features: [
      "10’000 Tiles (100×100)",
      "A2-Format (42×60 cm)",
      "Leinwand oder Alu-Dibond",
      "Lieferung in 48h",
      "Kostenlose Vorschau",
      "Unbegrenzte Korrekturen",
    ],
    cta: "Jetzt bestellen",
    ctaStyle: "filled",
  },
  {
    name: "Galerie",
    subtitle: "Für Kunstliebhaber & Geschenke",
    price: 149,
    color: "#6366f1",
    highlight: false,
    tileCount: "200×200",
    tileLabel: "40’000 Tiles",
    qualityBar: 100,
    qualityLabel: "Exzellent",
    features: [
      "40’000 Tiles (200×200)",
      "A1-Format (60×84 cm)",
      "Museum-Leinwand mit Rahmen",
      "Express-Lieferung in 24h",
      "Kostenlose Vorschau",
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
    <div style={{ background: "#FAFAF8", minHeight: "100vh" }}>

      {/* ── HERO: Preise ── */}
      <section style={{ background: "#FAFAF8", padding: "80px 24px 100px", textAlign: "center" }}>
        <div style={{ maxWidth: 700, margin: "0 auto" }}>
          <p style={{ color: "#FF6B6B", fontWeight: 700, letterSpacing: "3px", fontSize: 11, textTransform: "uppercase", marginBottom: 12 }}>
            PREISE
          </p>
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(2rem, 5vw, 3.2rem)", color: "#1a1a2e", marginBottom: 20, lineHeight: 1.15 }}>
            Einfache, transparente Preise
          </h1>
          <p style={{ color: "#6B7280", fontSize: 18, maxWidth: 500, margin: "0 auto", lineHeight: 1.75 }}>
            Keine versteckten Kosten. Wähle das Paket, das zu deinem Projekt passt.
          </p>
        </div>
      </section>

      {/* ── PRICING CARDS ── */}
      <section style={{ background: "#FAFAF8", padding: "0 24px 80px" }}>
        <div className="grid-1-2-3" style={{
          maxWidth: 1000,
          margin: "0 auto",
          alignItems: "start",
        }}>
          {PACKAGES.map((pkg) => (
            <div key={pkg.name} className="card-hover" style={{
              background: "white",
              border: pkg.highlight ? "2px solid rgba(255,107,107,0.4)" : "1px solid #E8E8E4",
              borderRadius: 20,
              padding: "32px 28px",
              position: "relative",
              boxShadow: pkg.highlight ? "0 8px 32px rgba(255,107,107,0.12)" : "none",
            }}>
              {pkg.badge && (
                <div style={{
                  position: "absolute",
                  top: -14,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "linear-gradient(135deg, #FF6B6B, #FF9F43)",
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

              <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, color: "#1a1a2e", marginBottom: 4 }}>
                {pkg.name}
              </h2>
              <p style={{ color: "#6B7280", fontSize: 14, marginBottom: 16 }}>
                {pkg.subtitle}
              </p>

              {/* Qualitäts-Balken: Tile-Anzahl als Qualitätsmerkmal */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#6B7280" }}>{(pkg as any).tileLabel}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: pkg.color }}>{(pkg as any).qualityLabel}</span>
                </div>
                <div style={{ height: 6, background: "#E8E8E4", borderRadius: 9999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(pkg as any).qualityBar}%`, background: pkg.highlight ? "linear-gradient(90deg, #FF6B6B, #FF9F43)" : `linear-gradient(90deg, ${pkg.color}99, ${pkg.color})`, borderRadius: 9999, transition: "width 0.6s ease" }} />
                </div>
                <p style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>Mehr Tiles = feinere Details &amp; schärfere Konturen</p>
              </div>

              <div style={{ marginBottom: 28 }}>
                <span style={{ fontSize: 42, fontWeight: 800, color: pkg.color }}>
                  CHF {pkg.price}
                </span>
                <span style={{ color: "#6B7280", fontSize: 14, marginLeft: 6 }}>pro Mosaik</span>
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
                    <span style={{ color: "#1a1a2e", fontSize: 14 }}>{f}</span>
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
                      background: "linear-gradient(135deg, #FF6B6B, #FF9F43)",
                      color: "#fff",
                      border: "none",
                      boxShadow: "0 4px 16px rgba(249,115,22,0.3)",
                    }
                  : {
                      background: "transparent",
                      color: "#1a1a2e",
                      border: "1.5px solid #E8E8E4",
                    }),
              }}>
                {pkg.cta} <ArrowRight size={15} />
              </Link>
            </div>
          ))}
        </div>

        {/* Upsell-Erklärungsbanner: Warum mehr Tiles besser sind */}
        <div style={{ maxWidth: 1000, margin: "40px auto 0", background: "linear-gradient(135deg, rgba(249,115,22,0.06), rgba(99,102,241,0.06))", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 16, padding: "24px 32px", display: "flex", gap: 32, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <p style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 6 }}>Warum sind mehr Tiles besser?</p>
            <p style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>Je mehr Tiles, desto feiner die Details und desto schärfer die Konturen. Bei 40’000 Tiles sind selbst Augen und Haare gestochen scharf erkennbar.</p>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {[
              { tiles: "2’500", detail: "Grobe Konturen", emoji: "□" },
              { tiles: "10’000", detail: "Klare Gesichter", emoji: "▣" },
              { tiles: "40’000", detail: "Haarfeine Details", emoji: "█" },
            ].map((t, i) => (
              <div key={i} style={{ textAlign: "center", minWidth: 80 }}>
                <div style={{ fontSize: 28, marginBottom: 4 }}>{t.emoji}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{t.tiles}</div>
                <div style={{ fontSize: 11, color: "#6B7280" }}>{t.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── MATERIALIEN ── dark background */}
      <section style={{
        background: "#1a1a2e",
        padding: "80px 24px",
      }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <p style={{ color: "#FF6B6B", fontWeight: 700, letterSpacing: "3px", fontSize: 11, textTransform: "uppercase", marginBottom: 12 }}>
              MATERIALIEN
            </p>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", color: "#fff", fontSize: "clamp(1.8rem, 4vw, 2.5rem)", marginBottom: 12 }}>
              Wähle dein Material
            </h2>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 16 }}>
              Alle Materialien sind UV-beständig und für die Ewigkeit gemacht.
            </p>
          </div>

          <div className="grid-1-2-4" style={{ gap: 20 }}>
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
                <p style={{ color: "#6B7280", fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>{m.desc}</p>
                <span style={{
                  color: m.price.startsWith("+") ? "#FF6B6B" : m.price.startsWith("−") ? "#6BCB77" : "#6B7280",
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
      <section style={{ background: "#FAFAF8", padding: "80px 24px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <p style={{ color: "#FF6B6B", fontWeight: 700, letterSpacing: "0.15em", fontSize: 13, textTransform: "uppercase", marginBottom: 16 }}>
              KUNDENSTIMMEN
            </p>
            <h2 style={{ fontSize: "clamp(1.8rem, 4vw, 2.5rem)", fontFamily: "'DM Serif Display', serif", color: "#1a1a2e" }}>
              Was unsere Kunden sagen
            </h2>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 24 }}>
            {TESTIMONIALS.map((t) => (
              <div key={t.name} style={{
                background: "#fff",
                border: "1px solid #E8E8E4",
                borderRadius: 16,
                padding: "28px 24px",
              }}>
                <div style={{ display: "flex", gap: 2, marginBottom: 16 }}>
                  {Array.from({ length: t.rating }).map((_, i) => (
                    <span key={i} style={{ color: "#FF6B6B", fontSize: 16 }}>★</span>
                  ))}
                </div>
                <p style={{ color: "#1a1a2e", fontSize: 15, lineHeight: 1.7, marginBottom: 20, fontStyle: "italic" }}>
                  "{t.text}"
                </p>
                <div>
                  <span style={{ fontWeight: 700, color: "#1a1a2e", fontSize: 14 }}>{t.name}</span>
                  <span style={{ color: "#6B7280", fontSize: 13, marginLeft: 6 }}>— {t.location}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── INKLUSIVE ── */}
      <section style={{ background: "#FAFAF8", padding: "60px 24px" }}>
        <div style={{ maxWidth: 700, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontFamily: "'DM Serif Display', serif", color: "#1a1a2e", marginBottom: 32 }}>
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
                  background: "linear-gradient(135deg, #FF6B6B, #FF9F43)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <Check size={12} color="#fff" strokeWidth={3} />
                </div>
                <span style={{ color: "#1a1a2e", fontSize: 14 }}>{item}</span>
              </div>
            ))}
          </div>

          <Link to="/studio" className="btn-gradient" style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            fontSize: 17,
            padding: "16px 36px", borderRadius: 50,
            textDecoration: "none",
          }}>
            Kostenlose Vorschau erstellen <ArrowRight size={18} />
          </Link>
          <p style={{ color: "#6B7280", fontSize: 13, marginTop: 12 }}>
            Keine Registrierung · Vorschau kostenlos · Erst beim Bestellen zahlen
          </p>
        </div>
      </section>

    </div>
  );
}
