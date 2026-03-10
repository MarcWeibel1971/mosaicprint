/**
 * MosaicGrid – Interaktives Mosaikgitter für den Hero-Bereich
 * Zeigt ein animiertes Farbgitter, das das Produkt visuell kommuniziert
 * Exakt aus MosaicArt-Vorlage übernommen
 */
import { useEffect, useRef, useState } from "react";

const COLORS = [
  "#FF6B6B","#FF8C8C","#FF4444",
  "#00C9B1","#00A896","#00DFC0",
  "#FFD93D","#FFC107","#FFE066",
  "#9B59B6","#8E44AD","#BF7FD4",
  "#4A90D9","#2980B9","#74B3E8",
  "#FF8FB1","#FF6B9D","#FFB3CC",
  "#6BCB77","#4CAF50","#8FD9A0",
  "#FF9F43","#E67E22","#FFB870",
];

function isInHeart(col: number, row: number, cols: number, rows: number): boolean {
  const nx = (col - cols / 2) / (cols / 2.5);
  const ny = -(row - rows / 2) / (rows / 2.5);
  return Math.pow(nx * nx + ny * ny - 1, 3) - nx * nx * ny * ny * ny <= 0;
}

interface MosaicGridProps {
  cols?: number;
  rows?: number;
  tileSize?: number;
  gap?: number;
  showHeart?: boolean;
  animated?: boolean;
}

export default function MosaicGrid({
  cols = 18,
  rows = 18,
  tileSize = 28,
  gap = 3,
  showHeart = true,
  animated = true,
}: MosaicGridProps) {
  const [tiles, setTiles] = useState<string[]>([]);
  const [visible, setVisible] = useState<boolean[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const total = cols * rows;
    const initialTiles = Array.from({ length: total }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const inHeart = showHeart && isInHeart(col, row, cols, rows);
      const palette = inHeart
        ? COLORS.filter((_, idx) => idx < 9)   // warm colors for heart
        : COLORS.filter((_, idx) => idx >= 9);  // cool colors for bg
      return palette[Math.floor(Math.random() * palette.length)];
    });
    setTiles(initialTiles);

    if (animated) {
      const vis = new Array(total).fill(false);
      setVisible([...vis]);
      const indices = Array.from({ length: total }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      let idx = 0;
      const revealInterval = setInterval(() => {
        if (idx >= total) { clearInterval(revealInterval); return; }
        const batch = Math.min(8, total - idx);
        setVisible((prev) => {
          const next = [...prev];
          for (let b = 0; b < batch; b++) {
            if (idx + b < total) next[indices[idx + b]] = true;
          }
          return next;
        });
        idx += batch;
      }, 20);

      // Color cycling after reveal
      setTimeout(() => {
        intervalRef.current = setInterval(() => {
          const numToChange = Math.floor(total * 0.05);
          setTiles((prev) => {
            const next = [...prev];
            for (let k = 0; k < numToChange; k++) {
              const i = Math.floor(Math.random() * total);
              const col = i % cols;
              const row = Math.floor(i / cols);
              const inHeart = showHeart && isInHeart(col, row, cols, rows);
              const palette = inHeart
                ? COLORS.filter((_, idx) => idx < 9)
                : COLORS.filter((_, idx) => idx >= 9);
              next[i] = palette[Math.floor(Math.random() * palette.length)];
            }
            return next;
          });
        }, 800);
      }, total * 20 + 500);
    } else {
      setVisible(new Array(total).fill(true));
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [cols, rows, showHeart, animated]);

  const gridWidth = cols * tileSize + (cols - 1) * gap;
  const gridHeight = rows * tileSize + (rows - 1) * gap;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${tileSize}px)`,
        gridTemplateRows: `repeat(${rows}, ${tileSize}px)`,
        gap: `${gap}px`,
        width: gridWidth,
        height: gridHeight,
      }}
    >
      {tiles.map((color, i) => (
        <div
          key={i}
          style={{
            backgroundColor: color,
            borderRadius: 4,
            opacity: visible[i] ? 1 : 0,
            transform: visible[i] ? "scale(1)" : "scale(0.6)",
            transition: "opacity 0.3s ease, transform 0.3s ease, background-color 0.8s ease",
          }}
        />
      ))}
    </div>
  );
}
