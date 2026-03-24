/**
 * MosaicWave – GSAP-animiertes Tile-Grid für den Hero-Bereich
 * Welleneffekt: Tiles zoomen nacheinander heraus (stagger von Mitte nach außen)
 * Endlosschleife, Pause bei Hover
 */
import { useRef, useEffect } from "react";
import gsap from "gsap";

// Farbpalette für das Demo-Grid
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
  const tileRefsRef = useRef<HTMLDivElement[]>([]);

  // Tile-Farben vorberechnen
  const tiles = Array.from({ length: cols * rows }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const inHeart = showHeart && isInHeart(col, row, cols, rows);
    const palette = inHeart ? TILE_COLORS.slice(0, 12) : TILE_COLORS.slice(12);
    return palette[i % palette.length];
  });

  useEffect(() => {
    const items = tileRefsRef.current.filter(Boolean);
    if (items.length === 0) return;

    // Ausgangszustand setzen
    gsap.set(items, {
      scale: 1,
      y: 0,
      transformOrigin: "center center",
      willChange: "transform",
    });

    // Timeline erstellen
    if (tlRef.current) tlRef.current.kill();

    if (mode === "wave") {
      tlRef.current = gsap.timeline({ repeat: -1, repeatDelay: 1.0 })
        .to(items, {
          scale: 1.2,
          y: -5,
          duration: 0.5,
          ease: "power2.out",
          stagger: {
            amount: 1.6,
            from: "center",
            grid: [rows, cols],
          },
        })
        .to(items, {
          scale: 1,
          y: 0,
          duration: 0.45,
          ease: "power2.inOut",
          stagger: {
            amount: 1.3,
            from: "center",
            grid: [rows, cols],
          },
        }, "+=0.15");
    } else {
      tlRef.current = gsap.timeline({ repeat: -1, defaults: { ease: "power2.inOut" } });
      items.forEach((item) => {
        tlRef.current!
          .to(item, { scale: 1.15, y: -8, duration: 0.6 })
          .to(item, { scale: 1, y: 0, duration: 0.5 }, "+=0.2");
      });
    }

    return () => {
      tlRef.current?.kill();
      tlRef.current = null;
    };
  }, [mode, cols, rows]);

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
          ref={(el) => { if (el) tileRefsRef.current[i] = el; }}
          style={{
            backgroundColor: color,
            borderRadius: 4,
            width: tileSize,
            height: tileSize,
          }}
        />
      ))}
    </div>
  );
}
