import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(__dirname, "./index.html"),
    path.join(__dirname, "./src/**/*.{js,ts,jsx,tsx}"),
  ],
  theme: {
    extend: {
      colors: {
        // MosaicArt Design System – Coral + Teal + Cream
        coral: {
          50:  "#fff1ee",
          100: "#ffe0d8",
          200: "#ffc0b0",
          300: "#ff9578",
          400: "#ff6b45",
          500: "#e8573a",
          600: "#d44228",
          700: "#b0321c",
          800: "#8f2818",
          900: "#762419",
        },
        teal: {
          50:  "#edfafa",
          100: "#d5f5f6",
          200: "#a7eeee",
          300: "#6de2e2",
          400: "#3dbfb8",
          500: "#2aada6",
          600: "#1f8f89",
          700: "#1e7370",
          800: "#1e5e5c",
          900: "#1d4f4d",
        },
        cream: {
          50:  "#fefdfb",
          100: "#faf9f7",
          200: "#f5f3ef",
          300: "#ede9e3",
          400: "#e0d9d0",
          500: "#cfc6bb",
        },
        // brand = coral alias for backward compat
        brand: {
          50:  "#fff1ee",
          100: "#ffe0d8",
          200: "#ffc0b0",
          300: "#ff9578",
          400: "#ff6b45",
          500: "#e8573a",
          600: "#d44228",
          700: "#b0321c",
          800: "#8f2818",
          900: "#762419",
        },
      },
      fontFamily: {
        serif: ['"DM Serif Display"', 'Georgia', 'serif'],
        sans:  ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
