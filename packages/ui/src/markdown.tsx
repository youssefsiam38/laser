/**
 * Streaming-safe markdown (M1-T4).
 *
 * Split into top-level blocks with marked's lexer, render each block through a
 * memoised component keyed by index (never by content: a content key would
 * remount on every token), and sanitise every block's HTML with DOMPurify.
 * Agent output is untrusted data (AGENTS.md invariant 9); nothing bypasses the
 * sanitiser. An unclosed code fence in the last block renders as plain
 * preformatted text until it closes, so no half-highlighted flicker.
 */
import DOMPurify from "dompurify";
import { marked, type Token } from "marked";
import { memo, useMemo } from "react";

marked.use({ gfm: true, breaks: false });

const PURIFY = { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"], ADD_ATTR: ["target"] };

function renderBlock(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html, PURIFY);
}

function hasOpenFence(raw: string): boolean {
  const fences = raw.match(/^\s{0,3}(`{3,}|~{3,})/gm);
  return !!fences && fences.length % 2 === 1;
}

const Block = memo(function Block({ raw, streaming }: { raw: string; streaming: boolean }) {
  if (streaming && hasOpenFence(raw)) {
    const body = raw.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n?/, "");
    return (
      <pre className="md-pre md-pre-open">
        <code>{body}</code>
      </pre>
    );
  }
  const html = useMemo(() => renderBlock(raw), [raw]);
  return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => {
    const tokens = marked.lexer(text) as Token[];
    return tokens.map((t) => t.raw).filter((r) => r.trim().length > 0);
  }, [text]);
  return (
    <div className="md">
      {blocks.map((raw, i) => (
        <Block key={i} raw={raw} streaming={streaming && i === blocks.length - 1} />
      ))}
    </div>
  );
}
