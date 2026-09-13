/**
 * Math typesetting, loaded by the message that has math in it (M16-T31).
 *
 * KaTeX is the single largest module a conversation used to download: 586 KiB
 * of JavaScript plus its stylesheet and font faces, in the first chunk, for a
 * feature most conversations never use. It is the same shape as the Shiki
 * engine and the Mermaid renderer, so it gets the same treatment — the
 * renderer is a chunk of its own, asked for by the first message whose source
 * actually carries math, and kept for the rest of the session.
 *
 * Detection is a scan of the message source, not a parse: three `includes`
 * calls decide whether a regular expression runs at all, and every delimiter
 * `remark-math`/`rehype-katex` honour is covered — `$…$`, `$$…$$`, the LaTeX
 * `\(…\)` and `\[…\]` that the markdown package normalises into dollars, and
 * a ` ```math ` fence, which `rehype-katex` renders from its `language-math`
 * class. It errs towards loading: a `$5` price costs one cached fetch and
 * renders the same either way, while a missed formula would not.
 */
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";

/** `$x$` and `$$…$$`, including a formula that spans lines. */
const DOLLAR_MATH = /\$\$|\$[^$]{0,4000}\$/;
/** ` ```math ` / ` ~~~math ` — a fence `rehype-katex` typesets by class. */
const FENCED_MATH = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*math\b/;

/** Does this message source contain anything the math renderer would typeset? */
export function hasMathDelimiters(text: string): boolean {
  if (text.includes("$") && DOLLAR_MATH.test(text)) return true;
  if (text.includes("\\(") || text.includes("\\[")) return true;
  return text.includes("math") && FENCED_MATH.test(text);
}

/** The loaded plugin, shared by every message for the rest of the session. */
type RehypeKatex = typeof import("./markdown-katex.js")["default"];
let katex: RehypeKatex | undefined;
let loading: Promise<RehypeKatex> | undefined;

/** One import for the whole app; a second message with math renders typeset at once. */
const loadKatex = (): Promise<RehypeKatex> =>
  (loading ??= import("./markdown-katex.js").then((module) => {
    katex = module.default;
    return module.default;
  }));

/**
 * The math plugin for the message currently being rendered, or `null` while it
 * is on its way. Running it on a message without math is a no-op, so once it
 * is here it stays in the pipeline: no plugin churn when the reader scrolls
 * from a formula to a paragraph.
 */
export function useMathRehypePlugin(): RehypeKatex | null {
  // A boolean selector: the scan re-runs per delta, the component re-renders
  // only when the answer changes (M16-T11 keeps streaming free of wide renders).
  const wanted = useAuiState((s) => {
    const part = s.optional.part;
    return part?.type === "text" && hasMathDelimiters(part.text);
  });
  const [plugin, setPlugin] = useState<RehypeKatex | null>(katex ?? null);
  useEffect(() => {
    if (!wanted || plugin) return;
    let alive = true;
    void loadKatex().then((loaded) => {
      if (alive) setPlugin(() => loaded);
    });
    return () => {
      alive = false;
    };
  }, [wanted, plugin]);
  return plugin;
}
