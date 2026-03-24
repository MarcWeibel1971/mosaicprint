/**
 * MosaicWave – GSAP-animiertes Tile-Grid für den Hero-Bereich
 * Welleneffekt: Tiles zoomen nacheinander heraus (stagger von Mitte nach außen)
 * Endlosschleife, Pause bei Hover
 */
import { useRef, useEffect } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

// Echte Mosaikbilder von R2 / Cloudflare (Fallback: Farbkacheln)
const TILE_COLORS = [
  "#FF6B6B","#FF8C8C","#FF4444","#FF9F43","#E67E22","#FFB870",
  "#00C9B1","#00A896","#00DFC0","#4A90D9","#2980B9","#74B3E8",
  "#FFD93D","#FFC107","#FFE066","#6BCB77","#4CAF50","#8FD9A0",
  "#9B59B6","#8E44AD","#BF7FD4","#FF8FB1","#FF6B9D","#FFB3CC",
  "#F39C12","#D35400","#E74C3C","#1ABC9C","#16A085","#2ECC71",
  "#3498DB","#2C3E50","#8E44AD","#F1C40F","#E67E22","#ECF0F1",
];

function isInHeart(col: number, row: number, cols: number, rows: number): boolean {
  const nx = (col - cols / 2) / (cols / 2.5);
  const ny = -(row - rows / 2) / (rows / 2.5);
  return Math.pow(nx * nx + ny * ny - 1, 3) - nx * nx * ny * ny * ny <= 0;
}

interface MosaicWaveProps {
  cols?: number;
  rows?: number;
  tileSize?: number;
  gap?: number;
  showHeart?: boolean;
  /** Welleneffekt-Modus: 'wave' = Welle von Mitte, 'seq' = eine nach der anderen */
  mode?: "wave" | "seq";
  className?: string;
  style?: React.CSSProperties;
}

export default function MosaicWave({
  cols = 14,
  rows = 14,
  tileSize = 22,
  gap = 2,
  showHeart = true,
  mode = "wave",
  className,
  style,
}: MosaicWaveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  // Tile-Farben vorberechnen
  const tiles = Array.from({ length: cols * rows }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const inHeart = showHeart && isInHeart(col, row, cols, rows);
    const palette = inHeart
      ? TILE_COLORS.slice(0, 12)   // warme Töne für Herz
      : TILE_COLORS.slice(12);     // kühle Töne für Hintergrund
    return palette[i % palette.length];
  });

  useGSAP(
    () => {
      if (!containerRef.current) return;
      const items = gsap.utils.toArray<HTMLElement>(".mw-tile", containerRef.current);
      if (items.length === 0) return;

      // Ausgangszustand
      gsap.set(items, {
        scale: 1,
        y: 0,
        zIndex: 1,
        boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
        transformOrigin: "center center",
        opacity: 1,
      });

      if (mode === "wave") {
        // Welleneffekt: stagger von Mitte nach außen
        tlRef.current = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
        tlRef.current
          .to(items, {
            scale: 1.18,
            y: -6,
            zIndex: 2,
            boxShadow: "0 10px 28px rgba(0,0,0,0.22)",
            duration: 0.55,
            ease: "power2.out",
            stagger: {
              amount: 1.4,
              from: "center",
              grid: [rows, cols],
            },
          })
          .to(items, {
            scale: 1,
            y: 0,
            zIndex: 1,
            boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
            duration: 0.5,
            ease: "power2.inOut",
            stagger: {
              amount: 1.2,
              from: "center",
              grid: [rows, cols],
            },
          }, "+=0.1");
      } else {
        // Sequenz: eine nach der anderen
        tlRef.current = gsap.timeline({ repeat: -1, defaults: { ease: "power2.inOut" } });
        items.forEach((item) => {
          tlRef.current!
            .to(item, { scale: 1.14, y: -8, zIndex: 2, boxShadow: "0 14px 32px rgba(0,0,0,0.2)", duration: 0.7 })
            .to(item, { scale: 1, y: 0, zIndex: 1, boxShadow: "0 2px 6px rgba(0,0,0,0.12)", duration: 0.6 }, "+=0.3");
        });
      }
    },
    { scope: containerRef, dependencies: [mode, cols, rows] }
  );

  // Pause bei Hover
  const handleMouseEnter = () => tlRef.current?.pause();
  const handleMouseLeave = () => tlRef.current?.resume();

  const gridWidth = cols * tileSize + (cols - 1) * gap;
  const gridHeight = rows * tileSize + (rows - 1) * gap;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${tileSize}px)`,
        gridTemplateRows: `repeat(${rows}, ${tileSize}px)`,
        gap: `${gap}px`,
        width: gridWidth,
        height: gridHeight,
        ...style,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {tiles.map((color, i) => (
        <div
          key={i}
          className="mw-tile"
          style={{
            backgroundColor: color,
            borderRadius: 4,
            willChange: "transform",
          }}
        />
      ))}
    </div>
  );
}
