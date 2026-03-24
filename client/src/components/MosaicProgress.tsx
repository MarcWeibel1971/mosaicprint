/**
 * MosaicProgress – Animierte Fortschrittsanzeige für die Mosaic-Berechnung
 * Zeigt: animierter Balken, Phasen-Label, Mini-Tile-Grid das sich füllt
 */
import { useRef, useEffect } from "react";
import gsap from "gsap";

interface MosaicProgressProps {
  progress: number;       // 0–100
  message: string;        // aktueller Statustext
  renderPass?: number;    // 1 = Schnellvorschau, 2 = Präzision
}

const PHASE_LABELS: { min: number; max: number; label: string; icon: string }[] = [
  { min: 0,  max: 10,  label: "Foto analysieren",        icon: "🔍" },
  { min: 10, max: 25,  label: "Kacheln laden",           icon: "📦" },
  { min: 25, max: 55,  label: "Farben abgleichen",       icon: "🎨" },
  { min: 55, max: 80,  label: "Mosaik zusammensetzen",   icon: "🧩" },
  { min: 80, max: 95,  label: "Qualität optimieren",     icon: "✨" },
  { min: 95, max: 100, label: "Fertigstellen",           icon: "🖼️" },
];

function getPhase(progress: number) {
  return PHASE_LABELS.find(p => progress >= p.min && progress <= p.max) ?? PHASE_LABELS[0];
}

// Mini-Tile-Grid: 8×5 = 40 Tiles, die sich progressiv füllen
const GRID_COLS = 10;
const GRID_ROWS = 4;
const TOTAL_TILES = GRID_COLS * GRID_ROWS;

const TILE_COLORS = [
  "#FF6B6B","#FF9F43","#FFD93D","#6BCB77","#4A90D9",
  "#9B59B6","#00C9B1","#E74C3C","#F39C12","#2ECC71",
  "#3498DB","#8E44AD","#1ABC9C","#FF8FB1","#74B3E8",
  "#FFB870","#8FD9A0","#BF7FD4","#FFE066","#00DFC0",
];

export default function MosaicProgress({ progress, message, renderPass }: MosaicProgressProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const barInnerRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const prevProgressRef = useRef(0);

  // Balken-Animation mit GSAP
  useEffect(() => {
    if (!barInnerRef.current) return;
    gsap.to(barInnerRef.current, {
      width: `${Math.max(progress, 2)}%`,
      duration: 0.6,
      ease: "power2.out",
    });
  }, [progress]);

  // Tile-Grid füllen
  useEffect(() => {
    const filledCount = Math.round((progress / 100) * TOTAL_TILES);
    const prevFilled = Math.round((prevProgressRef.current / 100) * TOTAL_TILES);
    prevProgressRef.current = progress;

    for (let i = prevFilled; i < filledCount; i++) {
      const el = tileRefs.current[i];
      if (!el) continue;
      const color = TILE_COLORS[i % TILE_COLORS.length];
      gsap.fromTo(el,
        { scale: 0, opacity: 0, backgroundColor: "#e5e7eb" },
        {
          scale: 1,
          opacity: 1,
          backgroundColor: color,
          duration: 0.35,
          ease: "back.out(1.4)",
          delay: (i - prevFilled) * 0.04,
        }
      );
    }
    // Leere Tiles zurücksetzen wenn Progress zurückgesetzt wird
    if (progress === 0) {
      tileRefs.current.forEach(el => {
        if (el) gsap.set(el, { scale: 1, opacity: 1, backgroundColor: "#e5e7eb" });
      });
    }
  }, [progress]);

  const phase = getPhase(progress);

  return (
    <div className="max-w-xl mx-auto bg-white rounded-2xl p-8 shadow-sm border border-gray-100 mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            {phase.icon} {phase.label}
          </p>
          <p className="font-semibold text-gray-800 text-sm leading-snug">{message || "Verarbeite..."}</p>
        </div>
        <div className="text-right">
          <span className="text-3xl font-bold text-coral-600">{progress}</span>
          <span className="text-sm text-gray-400 ml-0.5">%</span>
        </div>
      </div>

      {/* Fortschrittsbalken */}
      <div ref={barRef} className="w-full bg-gray-100 rounded-full h-2.5 mb-5 overflow-hidden">
        <div
          ref={barInnerRef}
          className="h-2.5 rounded-full"
          style={{
            width: "2%",
            background: "linear-gradient(90deg, #FF6B6B 0%, #FF9F43 50%, #FFD93D 100%)",
            boxShadow: "0 0 8px rgba(255, 107, 107, 0.4)",
          }}
        />
      </div>

      {/* Phasen-Schritte */}
      <div className="flex justify-between mb-5">
        {PHASE_LABELS.map((p, i) => {
          const done = progress > p.max;
          const active = progress >= p.min && progress <= p.max;
          return (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className={`w-2 h-2 rounded-full transition-all duration-300 ${
                done ? "bg-coral-500 scale-100" :
                active ? "bg-coral-400 scale-125 ring-2 ring-coral-200" :
                "bg-gray-200"
              }`} />
            </div>
          );
        })}
      </div>

      {/* Mini-Tile-Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
          gap: "3px",
        }}
      >
        {Array.from({ length: TOTAL_TILES }, (_, i) => (
          <div
            key={i}
            ref={el => { tileRefs.current[i] = el; }}
            style={{
              aspectRatio: "1",
              borderRadius: 3,
              backgroundColor: "#e5e7eb",
            }}
          />
        ))}
      </div>

      {/* Render-Pass Badge */}
      {renderPass && (
        <div className="mt-4 flex items-center justify-center">
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${
            renderPass === 1
              ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-coral-50 border-coral-200 text-coral-700"
          }`}>
            {renderPass === 1 ? "⚡ Pass 1: Schnellvorschau" : "🎯 Pass 2: Präzisions-Matching"}
          </span>
        </div>
      )}
    </div>
  );
}
