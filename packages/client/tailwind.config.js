/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "SF Mono",
          "Fira Code",
          "ui-monospace",
          "monospace",
        ],
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      colors: {
        bearing: {
          bg: "#191724",
          surface: "#1f1d2e",
          overlay: "#26233a",
          border: "#403d52",
          muted: "#6e6a86",
          subtle: "#908caa",
          text: "#e0def4",
          accent: "#9ccfd8",
          red: "#eb6f92",
          yellow: "#f6c177",
          green: "#31748f",
          cyan: "#9ccfd8",
          purple: "#c4a7e7",
          pink: "#ebbcba",
        },
      },
    },
  },
  plugins: [],
};
