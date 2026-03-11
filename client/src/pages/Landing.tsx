/**
 * Landing – MosaicPrint Landingpage
 * Design aus MosaicArt-Vorlage – bereinigt:
 *  - Eigene Navbar/Footer entfernt (globale Navbar/Footer aus App.tsx wird verwendet)
 *  - Preise korrigiert: echte Formate (20×20 CHF 29 bis 100×100 CHF 199)
 *  - Materialien-Sektion hinzugefügt
 */
import { useRef } from "react";
import { Link } from "react-router-dom";
import { motion, useInView } from "framer-motion";
import {
  Upload, Cpu, Printer, Star, ChevronRight,
  CheckCircle2, Zap, Shield, Heart
} from "lucide-react";
import MosaicGrid from "../components/MosaicGrid";

/* ─── CDN Images ─── */
const HERO_MOSAIC_IMG =
  "https://d2xsxph8kpxj0f.cloudfront.net/114467201/QGrbsY4PW2WiaY2JHQavxL/mosaicprint-hero-mosaic-gfK4Hsd5XQKfhZmjt2vAQD.webp";
const WEDDING_MOSAIC_IMG =
  "https://d2xsxph8kpxj0f.cloudfront.net/114467201/QGrbsY4PW2WiaY2JHQavxL/mosaicprint-wedding-mosaic-TspWhJgWqCZAdyuZsCLNJi.webp";
const PROCESS_BG_IMG =
  "https://d2xsxph8kpxj0f.cloudfront.net/114467201/QGrbsY4PW2WiaY2JHQavxL/mosaicprint-process-bg-3b9GzsmSNW6mCoMAqqBi3P.webp";

const STUDIO_URL = "/studio";

/* ─── Animation helper ─── */
function FadeIn({ children, delay = 0, className = "", style }: {
  children: React.ReactNode; delay?: number; className?: string; style?: React.CSSProperties;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div ref={ref} initial={{ opacity: 0, y: 28 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className} style={style}>
      {children}
    </motion.div>
  );
}

function SectionLabel({ children, color = "coral" }: { children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = { coral: "#FF6B6B", teal: "#00C9B1", purple: "#9B59B6", orange: "#FF9F43" };
  return (
    <p style={{ color: colors[color] ?? colors.coral, fontSize: 11, fontWeight: 700, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 12 }}>
      {children}
    </p>
  );
}

/* ─── HERO ─── */
function HeroSection() {
  const scrollTo = (id: string) => document.querySelector(id)?.scrollIntoView({ behavior: "smooth" });
  return (
    <section style={{ minHeight: "calc(100vh - 64px)", display: "flex", alignItems: "center", background: "#FAFAF8" }} id="hero">
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem", width: "100%" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5rem", alignItems: "center", padding: "6rem 0" }}>
          {/* Left */}
          <div>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }}>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)",
                borderRadius: 9999, padding: "6px 16px", marginBottom: 32,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FF6B6B", display: "inline-block", animation: "pulse 2s infinite" }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "#FF6B6B", letterSpacing: "1px", textTransform: "uppercase" }}>
                  Professioneller Mosaik-Druck
                </span>
              </div>
            </motion.div>

            <motion.h1
              style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(44px,6vw,72px)", lineHeight: 1.08, color: "#1a1a2e", marginBottom: 24 }}
              initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.2 }}>
              Dein Foto als{" "}
              <em style={{
                background: "linear-gradient(135deg, #FF6B6B 0%, #9B59B6 55%, #00C9B1 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                backgroundClip: "text", fontStyle: "italic",
              }}>
                lebendiges Kunstwerk
              </em>
            </motion.h1>

            <motion.p style={{ fontSize: 17, lineHeight: 1.75, color: "#6B7280", marginBottom: 40, maxWidth: 480 }}
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.3 }}>
              Lade dein Lieblingsfoto hoch. Unsere KI baut es aus{" "}
              <strong style={{ color: "#1a1a2e", fontWeight: 600 }}>Hunderten kleiner Fotos</strong>{" "}
              nach – hochauflösend, druckfertig, einzigartig.
            </motion.p>

            <motion.div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 48 }}
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.4 }}>
              <a href={STUDIO_URL} style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "linear-gradient(135deg, #FF6B6B, #FF9F43)", color: "white",
                borderRadius: 9999, padding: "0 2rem", height: 48, fontSize: 15, fontWeight: 700,
                textDecoration: "none",
              }}>
                Mosaik erstellen
              </a>
              <button onClick={() => scrollTo("#how-it-works")} style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "transparent", color: "#1a1a2e", border: "1.5px solid #E8E8E4",
                borderRadius: 9999, padding: "0 2rem", height: 48, fontSize: 15, fontWeight: 600, cursor: "pointer",
              }}>
                So funktioniert's
              </button>
            </motion.div>

            <motion.div style={{ display: "flex", gap: 32, alignItems: "center" }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.55 }}>
              {[{ val: "100×100", label: "Tiles pro Mosaik" }, { val: "300 dpi", label: "Druckauflösung" }, { val: "48h", label: "Lieferzeit CH" }].map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  {i > 0 && <div style={{ width: 1, height: 32, background: "#E8E8E4" }} />}
                  <div>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 26, color: "#1a1a2e", lineHeight: 1 }}>{s.val}</div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4, fontWeight: 500 }}>{s.label}</div>
                  </div>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Right: Hero image */}
          <motion.div style={{ position: "relative", display: "flex", justifyContent: "flex-end" }}
            initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}>
            <div style={{
              position: "absolute", top: -16, left: -16, zIndex: 10,
              background: "white", borderRadius: 16, padding: "10px 16px",
              boxShadow: "0 4px 24px rgba(0,0,0,0.1)", display: "flex", alignItems: "center", gap: 10,
              border: "1px solid #E8E8E4",
            }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#6BCB77", display: "inline-block" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>KI-Algorithmus aktiv</span>
            </div>
            <div style={{
              position: "relative", width: "100%", maxWidth: 520, aspectRatio: "1/1",
              borderRadius: 24, overflow: "hidden",
              boxShadow: "0 24px 80px rgba(0,0,0,0.15)", border: "1px solid rgba(232,232,228,0.5)",
            }}>
              <img src={HERO_MOSAIC_IMG} alt="Familienfoto als Mosaik"
                style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="eager" />
            </div>
            <div style={{
              position: "absolute", bottom: 20, right: 20, zIndex: 10,
              background: "white", borderRadius: 16, padding: "10px 16px",
              boxShadow: "0 4px 24px rgba(0,0,0,0.1)", display: "flex", alignItems: "center", gap: 10,
              border: "1px solid #E8E8E4",
            }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF6B6B", display: "inline-block" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>Druckfertig in 300 dpi</span>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ─── RAINBOW BAND ─── */
function RainbowBand() {
  return (
    <div style={{
      height: 4, width: "100%",
      background: "linear-gradient(90deg, #FF6B6B 0%, #FF9F43 20%, #FFD93D 40%, #6BCB77 60%, #00C9B1 80%, #9B59B6 100%)",
    }} />
  );
}

/* ─── USE CASES ─── */
const USE_CASES = [
  { img: "https://d2xsxph8kpxj0f.cloudfront.net/114467201/YL6EsWsmmx95KQUkpKVjVv/wedding_ff6a60a2.png", title: "Hochzeit", desc: "Das Brautpaar zusammengesetzt aus 500 Gästefotos", color: "#FF6B6B", bg: "rgba(255,107,107,0.07)", border: "rgba(255,107,107,0.2)" },
  { img: "https://d2xsxph8kpxj0f.cloudfront.net/114467201/YL6EsWsmmx95KQUkpKVjVv/family_1a305886.png", title: "Familie", desc: "Familienfoto aus unvergesslichen Urlaubserinnerungen", color: "#00C9B1", bg: "rgba(0,201,177,0.07)", border: "rgba(0,201,177,0.2)" },
  { img: "https://d2xsxph8kpxj0f.cloudfront.net/114467201/YL6EsWsmmx95KQUkpKVjVv/pet_illustration-kQ5pgG3eDh8uRYyH8atLiG.webp", title: "Haustier", desc: "Dein Liebling aus seinen schönsten Momenten", color: "#FF9F43", bg: "rgba(255,159,67,0.07)", border: "rgba(255,159,67,0.2)" },
  { img: "https://d2xsxph8kpxj0f.cloudfront.net/114467201/YL6EsWsmmx95KQUkpKVjVv/cityscape_787043fd.png", title: "Stadtbild", desc: "Skyline aus Reisefotos aus aller Welt", color: "#4A90D9", bg: "rgba(74,144,217,0.07)", border: "rgba(74,144,217,0.2)" },
];

function UseCasesSection() {
  return (
    <section style={{ padding: "6rem 0", background: "#FAFAF8" }} id="studio">
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem" }}>
        <FadeIn style={{ textAlign: "center", marginBottom: 64 }}>
          <SectionLabel color="coral">Anlässe</SectionLabel>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,48px)", color: "#1a1a2e", marginBottom: 16 }}>
            Perfekt für jeden Anlass
          </h2>
          <p style={{ fontSize: 16, color: "#6B7280", maxWidth: 480, margin: "0 auto", lineHeight: 1.75 }}>
            Von der Hochzeit bis zum Haustier – jedes Motiv wird zum einzigartigen Kunstwerk.
          </p>
        </FadeIn>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20 }}>
          {USE_CASES.map((c, i) => (
            <FadeIn key={i} delay={i * 0.08}>
              <a href={STUDIO_URL} style={{
                display: "block", borderRadius: 16, padding: "2rem", textAlign: "center",
                background: c.bg, border: `1.5px solid ${c.border}`, textDecoration: "none",
                transition: "transform 0.3s, box-shadow 0.3s",
              }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-8px)"; e.currentTarget.style.boxShadow = "0 12px 40px rgba(0,0,0,0.1)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
                <div style={{ width: 100, height: 100, borderRadius: "50%", overflow: "hidden", margin: "0 auto 20px", border: `2px solid ${c.border}` }}>
                  <img src={c.img} alt={c.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
                <h3 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, marginBottom: 8, color: "#1a1a2e" }}>{c.title}</h3>
                <p style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>{c.desc}</p>
              </a>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── GALLERY ─── */
function GallerySection() {
  return (
    <section style={{ padding: "6rem 0", background: "#FAFAF8" }} id="gallery">
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem" }}>
        <FadeIn style={{ textAlign: "center", marginBottom: 64 }}>
          <SectionLabel color="teal">Galerie</SectionLabel>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,48px)", color: "#1a1a2e", marginBottom: 16 }}>
            Meisterhafte Ergebnisse
          </h2>
          <p style={{ fontSize: 16, color: "#6B7280", maxWidth: 480, margin: "0 auto", lineHeight: 1.75 }}>
            Jedes Mosaik ist ein Unikat – zusammengesetzt aus deinen persönlichsten Momenten.
          </p>
        </FadeIn>
        <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 24, alignItems: "start" }}>
          <FadeIn delay={0.1}>
            <div style={{ position: "relative", borderRadius: 24, overflow: "hidden", boxShadow: "0 12px 48px rgba(0,0,0,0.12)", aspectRatio: "4/3" }}>
              <img src={WEDDING_MOSAIC_IMG} alt="Hochzeits-Mosaik"
                style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.7s" }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.05)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")} />
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.4), transparent)" }} />
              <div style={{ position: "absolute", bottom: 20, left: 20, background: "rgba(255,255,255,0.9)", backdropFilter: "blur(8px)", borderRadius: 12, padding: "10px 16px" }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>Hochzeits-Mosaik</p>
                <p style={{ fontSize: 11, color: "#6B7280" }}>aus 500 Gästefotos</p>
              </div>
            </div>
          </FadeIn>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <FadeIn delay={0.2}>
              <div style={{ background: "white", borderRadius: 24, padding: 24, boxShadow: "0 2px 16px rgba(0,0,0,0.06)", border: "1px solid #E8E8E4", overflow: "hidden" }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 16 }}>Live-Vorschau</p>
                <div style={{ display: "flex", justifyContent: "center", overflow: "hidden", borderRadius: 12 }}>
                  <MosaicGrid cols={14} rows={14} tileSize={22} gap={2} showHeart={true} animated={true} />
                </div>
                <p style={{ fontSize: 12, color: "#6B7280", marginTop: 16, textAlign: "center" }}>Jedes Tile ist ein echtes Foto</p>
              </div>
            </FadeIn>
            <FadeIn delay={0.3}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {[
                  { val: "10'000+", label: "Mosaike erstellt", color: "#FF6B6B" },
                  { val: "4.9 ★", label: "Kundenbewertung", color: "#FFD93D" },
                  { val: "20–100 cm", label: "Druckformate", color: "#00C9B1" },
                  { val: "CH", label: "Produktion & Versand", color: "#9B59B6" },
                ].map((s, i) => (
                  <div key={i} style={{ background: "white", borderRadius: 16, padding: 16, border: "1px solid #E8E8E4", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.04)" }}>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, fontWeight: 700, color: s.color, marginBottom: 4 }}>{s.val}</div>
                    <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 500 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </FadeIn>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── HOW IT WORKS ─── */
function HowItWorksSection() {
  const steps = [
    { num: "1", icon: Upload, title: "Foto hochladen", desc: "Lade dein Lieblingsfoto hoch – Portrait, Landschaft oder Tier. JPG, PNG, HEIC.", color: "#FF6B6B", bg: "rgba(255,107,107,0.2)" },
    { num: "2", icon: Cpu, title: "KI berechnet Mosaik", desc: "Unser Algorithmus wählt aus über 10'000 Fotos die farblich perfekten Kacheln – in Sekunden.", color: "#00C9B1", bg: "rgba(0,201,177,0.2)" },
    { num: "3", icon: Printer, title: "Bestellen & geniessen", desc: "Vorschau kostenlos. Erst beim Bestellen zahlen. Lieferung in die ganze Schweiz.", color: "#FFD93D", bg: "rgba(255,217,61,0.2)" },
  ];
  return (
    <section id="how-it-works" style={{ padding: "6rem 0", position: "relative", overflow: "hidden", background: "#1a1a2e" }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.2, backgroundImage: `url(${PROCESS_BG_IMG})`, backgroundSize: "cover", backgroundPosition: "center" }} />
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem", position: "relative", zIndex: 10 }}>
        <FadeIn style={{ textAlign: "center", marginBottom: 64 }}>
          <SectionLabel color="orange">Prozess</SectionLabel>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,48px)", color: "white", marginBottom: 16 }}>So einfach geht's</h2>
          <p style={{ fontSize: 16, color: "rgba(255,255,255,0.5)", maxWidth: 440, margin: "0 auto", lineHeight: 1.75 }}>In drei Schritten zum fertigen Kunstwerk.</p>
        </FadeIn>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, maxWidth: 960, margin: "0 auto" }}>
          {steps.map((step, i) => (
            <FadeIn key={i} delay={i * 0.12}>
              <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: "2rem", backdropFilter: "blur(8px)" }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24, background: step.bg, color: step.color, fontFamily: "'DM Serif Display', serif", fontSize: 18, fontWeight: 700 }}>
                  {step.num}
                </div>
                <h3 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "white", marginBottom: 12 }}>{step.title}</h3>
                <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.6 }}>{step.desc}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── WHY MOSAICPRINT ─── */
function WhySection() {
  const features = [
    { icon: Zap, title: "KI-gestützte Präzision", desc: "Unser Algorithmus wählt für jede Position das farblich perfekte Tile – automatisch und in Sekunden.", color: "#FF6B6B", bg: "rgba(255,107,107,0.1)" },
    { icon: Printer, title: "Druckfertig & hochauflösend", desc: "150 dpi – bereit für den Druck in Galeriequalität auf Leinwand, Alu-Dibond oder Fotopapier.", color: "#00C9B1", bg: "rgba(0,201,177,0.1)" },
    { icon: Shield, title: "Lieferung in 48h", desc: "Schnelle Produktion und Lieferung in der ganzen Schweiz – pünktlich zum Anlass.", color: "#FFD93D", bg: "rgba(255,217,61,0.1)" },
    { icon: Heart, title: "Persönliche Erinnerungen", desc: "Verwende deine eigenen Fotos als Tiles – jedes Mosaik erzählt eine einzigartige Geschichte.", color: "#FF8FB1", bg: "rgba(255,143,177,0.1)" },
    { icon: Star, title: "Schweizer Qualität", desc: "Produziert und versendet aus der Schweiz – mit höchsten Qualitätsstandards.", color: "#9B59B6", bg: "rgba(155,89,182,0.1)" },
    { icon: CheckCircle2, title: "Einfache Bedienung", desc: "Kein Design-Know-how nötig. Hochladen, KI rechnet, fertig – in wenigen Minuten.", color: "#6BCB77", bg: "rgba(107,203,119,0.1)" },
  ];
  return (
    <section style={{ padding: "6rem 0", background: "#FAFAF8" }} id="why">
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 64, alignItems: "start", marginBottom: 64 }}>
          <FadeIn>
            <SectionLabel color="teal">Warum wir</SectionLabel>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,48px)", color: "#1a1a2e" }}>Warum MosaicPrint?</h2>
          </FadeIn>
          <FadeIn delay={0.1}>
            <p style={{ fontSize: 17, color: "#6B7280", lineHeight: 1.75, marginTop: 32 }}>
              Wir verbinden modernste KI-Technologie mit professionellem Fotodruck – für ein Ergebnis, das begeistert und in Erinnerung bleibt.
            </p>
          </FadeIn>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <FadeIn key={i} delay={i * 0.07}>
                <div style={{ background: "white", border: "1px solid #E8E8E4", borderRadius: 16, padding: "1.75rem", transition: "transform 0.3s, box-shadow 0.3s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(0,0,0,0.08)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, background: f.bg }}>
                    <Icon size={22} style={{ color: f.color }} />
                  </div>
                  <h3 style={{ fontSize: 16, fontWeight: 700, color: "#1a1a2e", marginBottom: 8 }}>{f.title}</h3>
                  <p style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>{f.desc}</p>
                </div>
              </FadeIn>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─── PRICING ─── */
// Echte Formate aus Studio.tsx / Pricing.tsx
const FORMATS = [
  { label: "20×20 cm", price: "CHF 29", desc: "Ideal für Schreibtisch oder Regal", popular: false, color: "#FF9F43" },
  { label: "30×30 cm", price: "CHF 49", desc: "Bestseller – perfekt für Wohnzimmer", popular: true, color: "#FF6B6B" },
  { label: "40×40 cm", price: "CHF 69", desc: "Imposant & detailreich", popular: false, color: "#00C9B1" },
  { label: "50×70 cm", price: "CHF 99", desc: "Galerie-Format für grosse Wände", popular: false, color: "#9B59B6" },
  { label: "70×70 cm", price: "CHF 139", desc: "Maximale Wirkung", popular: false, color: "#4A90D9" },
  { label: "100×100 cm", price: "CHF 199", desc: "Statement-Piece für besondere Räume", popular: false, color: "#FF8FB1" },
];

const MATERIALS = [
  { icon: "🖼️", label: "Leinwand", note: "Inklusive", desc: "Klassisch & warm. Gespannt auf Holzrahmen." },
  { icon: "✨", label: "Acrylglas", note: "+CHF 20", desc: "Modern & glänzend. Brillante Farben." },
  { icon: "🔲", label: "Alu-Dibond", note: "+CHF 15", desc: "Zeitlos & robust. Extrem langlebig." },
  { icon: "📄", label: "Fotopapier", note: "−CHF 10", desc: "Klassischer Fotoabzug. Ideal zum Einrahmen." },
];

function PricingSection() {
  return (
    <section style={{ padding: "6rem 0", background: "#FAFAF8" }} id="pricing">
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem" }}>
        <FadeIn style={{ textAlign: "center", marginBottom: 64 }}>
          <SectionLabel color="purple">Preise</SectionLabel>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,48px)", color: "#1a1a2e", marginBottom: 16 }}>
            Transparente Preise
          </h2>
          <p style={{ fontSize: 16, color: "#6B7280", maxWidth: 480, margin: "0 auto", lineHeight: 1.75 }}>
            Keine versteckten Kosten. Vorschau immer kostenlos. Erst beim Bestellen zahlen.
          </p>
        </FadeIn>

        {/* Format grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, maxWidth: 960, margin: "0 auto 48px" }}>
          {FORMATS.map((fmt, i) => (
            <FadeIn key={i} delay={i * 0.07}>
              <div style={{
                position: "relative", background: "white", borderRadius: 20, padding: "1.75rem",
                border: fmt.popular ? "1.5px solid rgba(255,107,107,0.4)" : "1px solid #E8E8E4",
                boxShadow: fmt.popular ? "0 8px 40px rgba(255,107,107,0.1)" : "none",
                transition: "transform 0.3s, box-shadow 0.3s",
              }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-6px)"; e.currentTarget.style.boxShadow = fmt.popular ? "0 16px 60px rgba(255,107,107,0.2)" : "0 8px 32px rgba(0,0,0,0.08)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = fmt.popular ? "0 8px 40px rgba(255,107,107,0.1)" : "none"; }}>
                {fmt.popular && (
                  <div style={{ position: "absolute", top: -14, left: "50%", transform: "translateX(-50%)" }}>
                    <span style={{ background: "linear-gradient(135deg, #FF6B6B, #FF9F43)", color: "white", fontSize: 11, fontWeight: 700, padding: "6px 16px", borderRadius: 9999, letterSpacing: "1px", textTransform: "uppercase" }}>
                      Bestseller
                    </span>
                  </div>
                )}
                <h3 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a2e", marginBottom: 4 }}>{fmt.label}</h3>
                <p style={{ fontSize: 13, color: "#6B7280", marginBottom: 16 }}>{fmt.desc}</p>
                <div style={{ marginBottom: 20 }}>
                  <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, fontWeight: 700, color: fmt.color }}>{fmt.price}</span>
                </div>
                <Link to={STUDIO_URL} style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  width: "100%", height: 42, borderRadius: 9999, fontSize: 14, fontWeight: 700, textDecoration: "none",
                  ...(fmt.popular
                    ? { background: "linear-gradient(135deg, #FF6B6B, #FF9F43)", color: "white", border: "none" }
                    : { background: "transparent", color: "#1a1a2e", border: "1.5px solid #E8E8E4" }),
                }}>
                  Dieses Format wählen <ChevronRight size={15} />
                </Link>
              </div>
            </FadeIn>
          ))}
        </div>

        {/* Materials */}
        <FadeIn delay={0.1}>
          <div style={{ maxWidth: 960, margin: "0 auto", background: "white", borderRadius: 20, padding: "2rem", border: "1px solid #E8E8E4" }}>
            <h3 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, color: "#1a1a2e", marginBottom: 20 }}>Materialien</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
              {MATERIALS.map((m, i) => (
                <div key={i} style={{ background: "#FAFAF8", borderRadius: 14, padding: "1.25rem", border: "1px solid #E8E8E4" }}>
                  <div style={{ fontSize: 28, marginBottom: 10 }}>{m.icon}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e" }}>{m.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: m.note.startsWith("+") ? "#FF6B6B" : m.note.startsWith("−") ? "#6BCB77" : "#6B7280" }}>{m.note}</span>
                  </div>
                  <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.5 }}>{m.desc}</p>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #E8E8E4", display: "flex", justifyContent: "center" }}>
              <Link to="/preise" style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                fontSize: 14, fontWeight: 600, color: "#FF6B6B", textDecoration: "none",
              }}>
                Alle Preise & Details ansehen <ChevronRight size={15} />
              </Link>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ─── TESTIMONIALS ─── */
function TestimonialsSection() {
  const testimonials = [
    { name: "Sarah M.", location: "Zürich", text: "Das Hochzeitsmosaik war das schönste Geschenk, das wir bekommen haben. Alle Gäste sind begeistert!", rating: 5, emoji: "💍" },
    { name: "Thomas K.", location: "Bern", text: "Unglaubliche Qualität. Das Familienfoto aus unseren Urlaubsfotos hängt jetzt stolz im Wohnzimmer.", rating: 5, emoji: "👨‍👩‍👧‍👦" },
    { name: "Lisa R.", location: "Basel", text: "Super einfach zu bedienen und das Ergebnis hat alle Erwartungen übertroffen. Sehr empfehlenswert!", rating: 5, emoji: "⭐" },
  ];
  return (
    <section style={{ padding: "6rem 0", background: "#FAFAF8" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 1.5rem" }}>
        <FadeIn style={{ textAlign: "center", marginBottom: 64 }}>
          <SectionLabel color="coral">Kundenstimmen</SectionLabel>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,48px)", color: "#1a1a2e" }}>Was unsere Kunden sagen</h2>
        </FadeIn>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, maxWidth: 900, margin: "0 auto" }}>
          {testimonials.map((t, i) => (
            <FadeIn key={i} delay={i * 0.1}>
              <div style={{ background: "white", border: "1px solid #E8E8E4", borderRadius: 16, padding: "1.75rem" }}>
                <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
                  {Array.from({ length: t.rating }).map((_, j) => (
                    <Star key={j} size={15} fill="#FFD93D" stroke="none" />
                  ))}
                </div>
                <p style={{ fontSize: 15, color: "#1a1a2e", lineHeight: 1.7, marginBottom: 24, fontStyle: "italic" }}>"{t.text}"</p>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#FAFAF8", border: "1px solid #E8E8E4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
                    {t.emoji}
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 600, color: "#1a1a2e" }}>{t.name}</p>
                    <p style={{ fontSize: 12, color: "#6B7280" }}>{t.location}</p>
                  </div>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── CTA BANNER ─── */
function CtaSection() {
  return (
    <section style={{ padding: "2rem 1.5rem" }}>
      <FadeIn>
        <div style={{
          position: "relative", borderRadius: 24, overflow: "hidden",
          padding: "5rem 2rem", textAlign: "center",
          background: "linear-gradient(135deg, #FF6B6B 0%, #9B59B6 50%, #00C9B1 100%)",
        }}>
          <div style={{ position: "absolute", inset: 0, opacity: 0.1, backgroundImage: "radial-gradient(circle, white 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
          <div style={{ position: "relative", zIndex: 10 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "clamp(32px,4vw,52px)", color: "white", marginBottom: 16 }}>Bereit für dein Kunstwerk?</h2>
            <p style={{ fontSize: 17, color: "rgba(255,255,255,0.8)", marginBottom: 40, maxWidth: 440, margin: "0 auto 40px", lineHeight: 1.75 }}>
              Erstelle jetzt dein persönliches Mosaik – in wenigen Minuten online.
            </p>
            <a href={STUDIO_URL} style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "white", color: "#FF6B6B", borderRadius: 9999,
              padding: "0 2.5rem", height: 52, fontSize: 16, fontWeight: 700,
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)", textDecoration: "none",
              transition: "transform 0.15s, box-shadow 0.2s",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 16px 48px rgba(0,0,0,0.25)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(0,0,0,0.2)"; }}>
              Jetzt Mosaik erstellen
            </a>
          </div>
        </div>
      </FadeIn>
    </section>
  );
}

/* ─── PAGE ─── */
// Hinweis: Navbar und Footer kommen aus App.tsx (global), nicht aus dieser Datei
export default function Landing() {
  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <HeroSection />
      <RainbowBand />
      <UseCasesSection />
      <GallerySection />
      <HowItWorksSection />
      <RainbowBand />
      <WhySection />
      <PricingSection />
      <TestimonialsSection />
      <CtaSection />
    </div>
  );
}
