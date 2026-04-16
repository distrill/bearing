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
          bg: "#0f1117",
          surface: "#161821",
          border: "#2a2d3a",
          muted: "#6b7280",
          text: "#e5e7eb",
          accent: "#60a5fa",
        },
      },
    },
  },
  plugins: [],
};
