// If anything ever evaluated this file, the line below would leave a trace in
// the fixture directory. The parse-only test asserts it never appears.
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "EVALUATED-tailwind"), "the tailwind config was executed");

const generated = require("./scripts/palette.js");

module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          500: "#3b82f6",
          600: "#2563eb"
        },
        ink: "#111827",
        generated: generated.palette
      },
      spacing: {
        gutter: "24px",
        section: "64px"
      },
      borderRadius: {
        card: "12px"
      },
      fontFamily: {
        sans: "Inter, system-ui, sans-serif"
      },
      transitionDuration: {
        quick: "160ms"
      }
    },
    screens: {
      md: "768px",
      lg: "1024px"
    }
  }
};
