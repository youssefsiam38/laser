import { describe, expect, it } from "vitest";
import { bundledLanguages } from "shiki";

import { SHIKI_ENGINE, shikiLanguage } from "../../src/components/assistant-ui/elements/shiki-highlighter.js";

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
});
