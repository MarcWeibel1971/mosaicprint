import sharp from "sharp";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const colors = [
  "#e8573a", "#3dbfb8", "#f59e0b",
  "#6366f1", "#22c55e", "#ec4899",
  "#d44228", "#2aada6", "#d97706",
];

function generateSVG(size) {
  const padding = Math.round(size * 0.12);
  const gap = Math.round(size * 0.04);
  const cornerRadius = Math.round(size * 0.18);
  const tileRadius = Math.round(size * 0.04);
  const innerSize = size - 2 * padding;
  const tileSize = (innerSize - 2 * gap) / 3;

  let tiles = "";
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = padding + col * (tileSize + gap);
      const y = padding + row * (tileSize + gap);
      const color = colors[row * 3 + col];
      tiles += `<rect x="${x}" y="${y}" width="${tileSize}" height="${tileSize}" rx="${tileRadius}" fill="${color}"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="#1a1a1a"/>
  ${tiles}
</svg>`;
}

async function main() {
  const sizes = [
    { name: "favicon.png", size: 64 },
    { name: "icon-192.png", size: 192 },
    { name: "icon-512.png", size: 512 },
    { name: "apple-touch-icon.png", size: 180 },
  ];

  const publicDir = join(__dirname, "..", "client", "public");

  for (const { name, size } of sizes) {
    const svg = generateSVG(size);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const outPath = join(publicDir, name);
    writeFileSync(outPath, png);
    console.log(`Generated ${name} (${size}x${size})`);
  }

  // Also save the SVG version
  const svgLarge = generateSVG(512);
  writeFileSync(join(publicDir, "logo.svg"), svgLarge);
  console.log("Generated logo.svg");
}

main().catch(console.error);
