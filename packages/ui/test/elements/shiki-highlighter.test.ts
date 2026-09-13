import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bundledLanguages, bundledThemes, getSingletonHighlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { PlainCodeDiffRows } from "../../src/components/assistant-ui/elements/code-diff.js";
import { LASER_SHIKI_THEME, SHIKI_ENGINE, shikiLanguage, shikiLanguageFromPath } from "../../src/components/assistant-ui/elements/shiki-highlighter.js";

describe("Markdown syntax highlighting", () => {
  it("uses the full TextMate-compatible engine", () => {
    expect(SHIKI_ENGINE).toBe("oniguruma");
  });

  it("accepts every language and official alias in Shiki's full bundle", () => {
    const ids = Object.keys(bundledLanguages);
    expect(ids.length).toBeGreaterThan(300);
    expect(ids.filter((id) => shikiLanguage(id) === "text")).toEqual([]);
  });

  /**
   * The full catalog is kept, and it costs a map of loaders rather than the
   * grammars themselves: each entry is a function the bundler turns into its
   * own chunk, fetched the first time a fence asks for that language (M16-T31).
   */
  it("keeps the whole catalog as loaders, so a grammar arrives with its first fence", () => {
    const entries = Object.entries(bundledLanguages);
    expect(entries.filter(([, load]) => typeof load !== "function")).toEqual([]);
    expect(Object.entries(bundledThemes).filter(([, load]) => typeof load !== "function")).toEqual([]);
  });

  /**
   * One highlighter for the whole app, however many fences are on screen: the
   * engine and the grammars already loaded are shared, and asking for a new
   * language teaches the same instance instead of building a second one.
   */
  it("serves every fence from one highlighter that learns languages as they appear", async () => {
    const options = { themes: [LASER_SHIKI_THEME], engine: await createOnigurumaEngine(import("shiki/wasm")) };
    const first = await getSingletonHighlighter({ ...options, langs: ["ts"] });
    const second = await getSingletonHighlighter({ ...options, langs: ["python"] });
    expect(second).toBe(first);
    expect(second.getLoadedLanguages()).toEqual(expect.arrayContaining(["ts", "python"]));
    expect(second.getLoadedThemes()).toEqual([LASER_SHIKI_THEME.name]);
    // The instance really highlights with our theme's tokens, not a copy of it.
    expect(second.codeToHtml("const x = 1;", { lang: "ts", theme: LASER_SHIKI_THEME.name })).toContain("var(--syntax-keyword)");
  }, 30_000);

  it("normalizes common model-written fence labels", () => {
    expect(shikiLanguage("language-tsx")).toBe("tsx");
    expect(shikiLanguage("{.python}")).toBe("python");
    expect(shikiLanguage("typescriptreact title=App.tsx")).toBe("tsx");
    expect(shikiLanguage("console")).toBe("console");
    expect(shikiLanguage("made-up-language")).toBe("text");
  });

  it("infers file-tool grammars from paths and special filenames", () => {
    expect(shikiLanguageFromPath("src/components/Button.tsx")).toBe("tsx");
    expect(shikiLanguageFromPath("scripts/release.py")).toBe("python");
    expect(shikiLanguageFromPath("infra/Dockerfile")).toBe("dockerfile");
    expect(shikiLanguageFromPath("config/settings.yml")).toBe("yaml");
    expect(shikiLanguageFromPath("notes.unknown-extension")).toBe("text");
  });

  it("layers syntax tokens inside diff lines without replacing diff semantics", () => {
    const html = renderToStaticMarkup(createElement(PlainCodeDiffRows, {
      hunks: [{
        header: "@@ -1,1 +1,1 @@",
        lines: [
          { kind: "del", text: "const answer = 0;", oldNo: 1 },
          { kind: "add", text: "const answer = 42;", newNo: 1 },
        ],
      }],
      tokens: [
        [{ content: "const", color: "var(--syntax-keyword)" }, { content: " answer = 0;" }],
        [{ content: "const", color: "var(--syntax-keyword)" }, { content: " answer = 42;" }],
      ],
    }));

    expect(html).toContain('data-kind="del"');
    expect(html).toContain('data-kind="add"');
    expect(html.match(/data-search-content/g)).toHaveLength(2);
    expect(html.match(/color:var\(--syntax-keyword\)/g)).toHaveLength(2);
    expect(html).toContain("−");
    expect(html).toContain("+");
  });
});
