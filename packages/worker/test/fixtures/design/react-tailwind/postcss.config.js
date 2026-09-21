// Same trap as the Tailwind config: a require of this file would write a
// marker the parse-only test looks for.
require("node:fs").writeFileSync(require("node:path").join(__dirname, "EVALUATED-postcss"), "the postcss config was executed");

module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
