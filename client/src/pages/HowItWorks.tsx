import { Link } from "react-router-dom";
import { Zap, Printer, Clock, Heart, Star, CheckCircle, ArrowRight } from "lucide-react";

export default function HowItWorks() {
  return (
    <div style={{ background: "#fff", minHeight: "100vh" }}>

      {/* ── HERO: So einfach geht's ── dark background */}
      <section style={{
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
        padding: "80px 24px 100px",
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Decorative blobs */}
        <div style={{
          position: "absolute", top: -80, left: -80, width: 320, height: 320,
          background: "radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)",
          borderRadius: "50%", pointerEvents: "none",
        }} />
        <div style={{
          position: "absolute", bottom: -60, right: -60, width: 280, height: 280,
          background: "radial-gradient(circle, rgba(236,72,153,0.12) 0%, transparent 70%)",
          borderRadius: "50%", pointerEvents: "none",
        }} />

        <div style={{ maxWidth: 1100, margin: "0 auto", textAlign: "center", position: "relative" }}>
          <p style={{ color: "#f97316", fontWeight: 700, letterSpacing: "0.15em", fontSize: 13, textTransform: "uppercase", marginBottom: 16 }}>
            PROZESS
          </p>
          <h1 style={{ color: "#fff", fontSize: "clamp(2rem, 5vw, 3.5rem)", fontWeight: 800, marginBottom: 20, lineHeight: 1.1 }}>
            So einfach geht's
          </h1>
          <p style={{ color: "#94a3b8", fontSize: 18, maxWidth: 500, margin: "0 auto 64px" }}>
            In drei Schritten zum fertigen Kunstwerk.
          </p>

          {/* Steps */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
            {[
              {
                num: "1",
                color: "#ef4444",
                title: "Hauptfoto wählen",
                desc: "Lade das Bild hoch, das als Mosaik erscheinen soll – Portrait, Landschaft oder Tier.",
              },
              {
                num: "2",
                color: "#14b8a6",
                title: "Tile-Fotos hochladen",
                desc: "Füge die kleinen Fotos hinzu, aus denen das Mosaik zusammengesetzt wird.",
              },
              {
                num: "3",
                color: "#eab308",
                title: "KI berechnet & druckt",
                desc: "Unser Algorithmus ordnet jedes Tile optimal zu und wir drucken es für dich.",
              },
            ].map((step) => (
              <div key={step.num} style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 16,
                padding: "32px 28px",
                textAlign: "left",
                backdropFilter: "blur(10px)",
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: step.color,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 20, fontWeight: 800, color: "#fff",
                  marginBottom: 20,
                }}>
                  {step.num}
                </div>
                <h3 style={{ color: "#fff", fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
                  {step.title}
                </h3>
                <p style={{ color: "#94a3b8", fontSize: 15, lineHeight: 1.6 }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Rainbow bottom border */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: 4,
          background: "linear-gradient(90deg, #ef4444, #f97316, #eab308, #22c55e, #14b8a6, #6366f1, #ec4899)",
        }} />
      </section>

      {/* ── WARUM WIR ── light background */}
      <section style={{ background: "#f8fafc", padding: "80px 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 48,
            alignItems: "start",
            marginBottom: 64,
          }}>
            <div>
              <p style={{ color: "#14b8a6", fontWeight: 700, letterSpacing: "0.15em", fontSize: 12, textTransform: "uppercase", marginBottom: 12 }}>
                WARUM WIR
              </p>
              <h2 style={{ fontSize: "clamp(1.8rem, 4vw, 2.8rem)", fontWeight: 800, color: "#0f172a", lineHeight: 1.2 }}>
                Warum MosaicPrint?
              </h2>
            </div>
            <div style={{ paddingTop: 16 }}>
              <p style={{ color: "#475569", fontSize: 17, lineHeight: 1.7 }}>
                Wir verbinden modernste KI-Technologie mit professionellem Fotodruck – für ein Ergebnis, das begeistert und in Erinnerung bleibt.
              </p>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
            {[
              {
                icon: <Zap size={22} />,
                bg: "#fce7f3",
                iconColor: "#ec4899",
                title: "KI-gestützte Präzision",
                desc: "Unser Algorithmus wählt für jede Position das farblich perfekte Tile – automatisch und in Sekunden.",
              },
              {
                icon: <Printer size={22} />,
                bg: "#e0f2fe",
                iconColor: "#0ea5e9",
                title: "Druckfertig & hochauflösend",
                desc: "300 dpi – bereit für den Druck in Galeriequalität auf Leinwand, Alu-Dibond oder Fotopapier.",
              },
              {
                icon: <Clock size={22} />,
                bg: "#fefce8",
                iconColor: "#eab308",
                title: "Lieferung in 48h",
                desc: "Schnelle Produktion und Lieferung in der ganzen Schweiz – pünktlich zum Anlass.",
              },
              {
                icon: <Heart size={22} />,
                bg: "#fce7f3",
                iconColor: "#ec4899",
                title: "Persönliche Erinnerungen",
                desc: "Verwende deine eigenen Fotos als Tiles – jedes Mosaik erzählt eine einzigartige Geschichte.",
              },
              {
                icon: <Star size={22} />,
                bg: "#f0fdf4",
                iconColor: "#22c55e",
                title: "Schweizer Qualität",
                desc: "Produziert und versendet aus der Schweiz – mit höchsten Qualitätsstandards.",
              },
              {
                icon: <CheckCircle size={22} />,
                bg: "#f0fdf4",
                iconColor: "#22c55e",
                title: "Einfache Bedienung",
                desc: "Kein Design-Know-how nötig. Hochladen, KI rechnet, fertig – in wenigen Minuten.",
              },
            ].map((item, i) => (
              <div key={i} style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 16,
                padding: "28px 24px",
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: item.bg,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: item.iconColor,
                  marginBottom: 16,
                }}>
                  {item.icon}
                </div>
                <h3 style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>
                  {item.title}
                </h3>
                <p style={{ color: "#64748b", fontSize: 14, lineHeight: 1.6 }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── DETAILLIERTER PROZESS ── dark background */}
      <section style={{
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        padding: "80px 24px",
      }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <p style={{ color: "#f97316", fontWeight: 700, letterSpacing: "0.15em", fontSize: 13, textTransform: "uppercase", marginBottom: 16 }}>
              DETAILS
            </p>
            <h2 style={{ color: "#fff", fontSize: "clamp(1.8rem, 4vw, 2.8rem)", fontWeight: 800 }}>
              Der Prozess im Detail
            </h2>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            {[
              {
                num: "01",
                color: "#6366f1",
                title: "Foto hochladen",
                desc: "Wähle ein hochauflösendes Foto (mind. 1 MP). Portrait-Fotos eignen sich besonders gut – klare Gesichter und starke Kontraste ergeben die besten Mosaike.",
              },
              {
                num: "02",
                color: "#ec4899",
                title: "Format & Material wählen",
                desc: "Wähle zwischen 6 Grössen (20×20 bis 100×100 cm) und 4 Materialien: Leinwand, Acrylglas, Alu-Dibond oder Fotopapier.",
              },
              {
                num: "03",
                color: "#14b8a6",
                title: "KI-Matching",
                desc: "Unser Algorithmus analysiert jede Zelle deines Fotos und wählt aus 23.000+ Bildern das farblich und strukturell passendste Tile.",
              },
              {
                num: "04",
                color: "#f97316",
                title: "Vorschau & Bestellen",
                desc: "Überprüfe das Ergebnis in der Vorschau. Zufrieden? Dann direkt bestellen – wir drucken und liefern in 48h.",
              },
            ].map((step, i, arr) => (
              <div key={i} style={{ display: "flex", gap: 24 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: "50%",
                    background: step.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 800, color: "#fff",
                    flexShrink: 0,
                  }}>
                    {step.num}
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width: 2, flex: 1, background: "rgba(255,255,255,0.1)", margin: "8px 0" }} />
                  )}
                </div>
                <div style={{ paddingBottom: i < arr.length - 1 ? 32 : 0 }}>
                  <h3 style={{ color: "#fff", fontSize: 18, fontWeight: 700, marginBottom: 8, marginTop: 10 }}>
                    {step.title}
                  </h3>
                  <p style={{ color: "#94a3b8", fontSize: 15, lineHeight: 1.7 }}>
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ background: "#fff", padding: "80px 24px", textAlign: "center" }}>
        <div style={{ maxWidth: 600, margin: "0 auto" }}>
          <h2 style={{ fontSize: "clamp(1.8rem, 4vw, 2.5rem)", fontWeight: 800, color: "#0f172a", marginBottom: 16 }}>
            Bereit für dein Mosaik?
          </h2>
          <p style={{ color: "#64748b", fontSize: 17, marginBottom: 32 }}>
            Erstelle jetzt dein persönliches Kunstwerk – kostenlose Vorschau, kein Risiko.
          </p>
          <Link to="/studio" style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "linear-gradient(135deg, #f97316, #ec4899)",
            color: "#fff", fontWeight: 700, fontSize: 17,
            padding: "16px 36px", borderRadius: 50,
            textDecoration: "none",
            boxShadow: "0 8px 24px rgba(249,115,22,0.3)",
          }}>
            Mosaik erstellen <ArrowRight size={18} />
          </Link>
        </div>
      </section>

    </div>
  );
}
