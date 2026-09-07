import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bundledLanguages } from "shiki";

import { PlainCodeDiffRows } from "../../src/components/assistant-ui/elements/code-diff.js";
import { SHIKI_ENGINE, shikiLanguage, shikiLanguageFromPath } from "../../src/components/assistant-ui/elements/shiki-highlighter.js";

describe("Markdown syntax highlighting", () => {
  it("uses the full TextMate-compatible engine", () => {
    expect(SHIKI_ENGINE).toBe("oniguruma");
  });

  it("accepts every language and official alias in Shiki's full bundle", () => {
    const ids = Object.keys(bundledLanguages);
    expect(ids.length).toBeGreaterThan(300);
    expect(ids.filter((id) => shikiLanguage(id) === "text")).toEqual([]);
  });

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
