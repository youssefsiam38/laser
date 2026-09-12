import { PRODUCT_NAME } from "@lasercode/protocol";

/** A TextMate theme whose colours are the theme system's tokens. */
export const LASER_SHIKI_THEME = {
  name: PRODUCT_NAME,
  type: "dark" as const,
  fg: "var(--ink)",
  bg: "transparent",
  colors: { "editor.foreground": "var(--ink)", "editor.background": "transparent" },
  settings: [
    { settings: { foreground: "var(--ink)", background: "transparent" } },
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "var(--syntax-comment)", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "keyword.control", "keyword.operator.word", "storage", "storage.type", "storage.modifier", "meta.preprocessor", "entity.name.directive"],
      settings: { foreground: "var(--syntax-keyword)" },
    },
    {
      scope: ["string", "string.quoted", "string.template", "string.regexp", "constant.other.symbol", "constant.other.color", "markup.inline.raw"],
      settings: { foreground: "var(--syntax-string)" },
    },
    {
      scope: ["constant", "constant.numeric", "constant.language", "constant.character", "constant.character.escape", "variable.language", "entity.name.label"],
      settings: { foreground: "var(--syntax-number)" },
    },
    {
      scope: ["entity.name.function", "entity.name.method", "support.function", "support.method", "meta.function-call", "entity.name.tag", "markup.heading", "markup.heading entity.name"],
      settings: { foreground: "var(--syntax-function)" },
    },
    {
      scope: ["entity.name.type", "entity.name.class", "entity.name.interface", "entity.name.namespace", "entity.name.module", "support.type", "support.class", "support.constant", "entity.other.inherited-class"],
      settings: { foreground: "var(--syntax-type)" },
    },
    {
      scope: ["variable", "variable.parameter", "variable.other", "meta.definition.variable", "meta.object-literal.key", "variable.other.property", "support.type.property-name", "entity.other.attribute-name", "entity.name.selector"],
      settings: { foreground: "var(--syntax-variable)" },
    },
    { scope: ["markup.bold"], settings: { foreground: "var(--syntax-variable)", fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { foreground: "var(--syntax-variable)", fontStyle: "italic" } },
    { scope: ["markup.underline.link", "string.other.link", "markup.list"], settings: { foreground: "var(--syntax-type)" } },
    { scope: ["markup.inserted", "meta.diff.header.to-file"], settings: { foreground: "var(--ok)" } },
    { scope: ["markup.deleted", "meta.diff.header.from-file", "invalid"], settings: { foreground: "var(--danger)" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator", "meta.separator"], settings: { foreground: "var(--syntax-punctuation)" } },
  ],
};

/** Full TextMate-compatible regex support, lazy-loaded with the first settled fence. */
export const SHIKI_ENGINE = "oniguruma" as const;

