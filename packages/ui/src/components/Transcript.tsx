import { memo, useEffect, useRef, useState } from "react";
import { Markdown } from "../markdown.js";
import type { Block, SessionView } from "../store.js";

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ToolCard = memo(function ToolCard({ b }: { b: Extract<Block, { kind: "tool" }> }) {
  const [openArgs, setOpenArgs] = useState(false);
  const [openResult, setOpenResult] = useState(false);
  const out = b.done ? pretty(b.result) : (b.partial ?? "");
  const summary = summarise(b.name, b.args);
  return (
    <div className={`tool ${b.done ? (b.isError ? "tool-error" : "tool-done") : "tool-running"}`}>
      <div className="tool-head">
        <span className="tool-name">{b.name}</span>
        <span className="tool-summary" title={summary}>{summary}</span>
        <span className="tool-state">{b.done ? (b.isError ? "error" : "done") : "running"}</span>
      </div>
      <button className="link" onClick={() => setOpenArgs((v) => !v)}>{openArgs ? "hide" : "show"} arguments</button>
      {openArgs && <pre className="tool-pre">{pretty(b.args)}</pre>}
      {out && (
        <>
          <button className="link" onClick={() => setOpenResult((v) => !v)}>{openResult ? "hide" : "show"} output ({out.length} chars)</button>
          {(openResult || !b.done) && <pre className="tool-pre tool-out">{openResult ? out : out.slice(-2000)}</pre>}
        </>
      )}
    </div>
  );
});

function summarise(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const key = ["command", "path", "file_path", "pattern", "query", "url"].find((k) => typeof a[k] === "string");
  return key ? String(a[key]).slice(0, 120) : Object.keys(a).slice(0, 3).join(", ");
}

const BlockView = memo(function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case "user":
      return (
        <div className={`msg user ${b.optimistic ? "optimistic" : ""}`}>
          <div className="msg-body">{b.text}</div>
          {b.images > 0 && <span className="muted">{b.images} image{b.images > 1 ? "s" : ""}</span>}
        </div>
      );
    case "assistant":
      return (
        <div className={`msg assistant ${b.streaming ? "streaming" : ""}`}>
          {b.thinking && (
            <details className="thinking">
              <summary>Thinking</summary>
              <div className="thinking-body">{b.thinking}</div>
            </details>
          )}
          <Markdown text={b.text} streaming={b.streaming} />
        </div>
      );
    case "tool":
      return <ToolCard b={b} />;
    case "notice":
      return <div className={`notice notice-${b.level}`}>{b.text}</div>;
  }
});

export function Transcript({ view }: { view: SessionView }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view.blocks, view.running]);

  const above = Object.entries(view.widgets).filter(([, w]) => w.placement === "aboveEditor");

  return (
    <div className="transcript" ref={ref}>
      {!view.hydrated && <p className="muted">Loading…</p>}
      {view.blocks.map((b) => (
        <BlockView key={b.id} b={b} />
      ))}
      {view.running && view.blocks.at(-1)?.kind !== "assistant" && <div className="working">Working…</div>}
      {above.map(([key, w]) => (
        <pre key={key} className="widget">{w.lines.join("\n")}</pre>
      ))}
    </div>
  );
}
