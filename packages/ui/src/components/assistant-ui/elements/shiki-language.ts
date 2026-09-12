import { bundledLanguages } from "shiki/langs";

/** Fences are often tagged with an alias or model-written wrapper; unknowns stay plain. */
export function shikiLanguage(language: string | undefined): string {
  const raw = (language ?? "").trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  const key = raw.replace(/^\{?\.?lang(?:uage)?-/, "").replace(/^\{\./, "").replace(/^\./, "").replace(/\}$/, "").replace(/:.+$/, "");
  if (!key) return "text";
  if (key in bundledLanguages) return key;
  const alias = ALIASES[key];
  return alias && alias in bundledLanguages ? alias : "text";
}

/** Infer a Shiki grammar from a file tool's target without loading file contents. */
export function shikiLanguageFromPath(path: string | undefined): string {
  const file = (path ?? "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const named = FILE_LANGUAGES[file];
  if (named) return shikiLanguage(named);
  const extension = file.includes(".") ? file.split(".").at(-1) ?? "" : "";
  return shikiLanguage(EXTENSION_LANGUAGES[extension] ?? extension);
}

const ALIASES: Record<string, string> = {
  mts: "ts",
  cts: "ts",
  mjs: "js",
  cjs: "js",
  node: "js",
  javascriptreact: "jsx",
  typescriptreact: "tsx",
  py3: "python",
  zsh: "bash",
  shellscript: "bash",
  golang: "go",
  "c++": "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  docker: "dockerfile",
  html5: "html",
  conf: "ini",
  patch: "diff",
  make: "makefile",
  txt: "text",
  plaintext: "text",
};

const FILE_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "just",
  "cmakelists.txt": "cmake",
  "meson.build": "meson",
  "package.json": "json",
  "tsconfig.json": "jsonc",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  cjs: "js",
  cts: "ts",
  htm: "html",
  json5: "json5",
  jsonl: "json",
  markdown: "md",
  mjs: "js",
  mts: "ts",
  plist: "xml",
  py: "python",
  pyw: "python",
  sh: "bash",
  shell: "bash",
  toml: "toml",
  yml: "yaml",
};

