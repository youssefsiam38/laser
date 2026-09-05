import { utf8Length, type StreamEncoding, type StreamPanel } from "@piorbit/protocol";
import { ArrowDownToLine, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from "react";

import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { AnsiText } from "@/components/assistant-ui/elements/ansi-text";
import { stripAnsi } from "../../ansi.js";
import { useRefContent } from "../../read.js";
import { panelKey, type PanelEntry, velocityOf } from "../../store.js";
import { formatBytes, formatRate } from "../../values.js";
import { ActionButtons } from "../ActionButtons.js";

/**
 * Where a stream was left, per panel, for the life of the tab.
 *
 * A panel is one identity across every surface it appears on (R6), but the
 * React subtree is not: a phone's sheet unmounts when it closes, and a
 * pop-out is a different document. Follow state and scroll offset live here
 * so the same stream comes back where it was rather than at the top,
 * whichever surface it comes back on.
 */
const memory = new Map<string, { following: boolean; scrollTop: number }>();

export interface StreamBodyProps {
  entry: PanelEntry;
  panel: StreamPanel;
  /** For a run's embedded output: fewer controls, a shorter block. */
  embedded?: boolean;
  onAct(actionId: string): Promise<unknown>;
}

/**
 * A ranged tail with follow / pause and an encoding switch. ANSI is
 * interpreted into spans, never passed through; JSONL becomes one row per
 * record. Dark terminal ground in both themes (DESIGN.md "Transcript").
 */
export function StreamBody({ entry, panel, embedded = false, onAct }: StreamBodyProps) {
  const key = `${panelKey(entry.path, panel.id)}${embedded ? ":embedded" : ""}`;
  const remembered = memory.get(key);
  const [encoding, setEncoding] = useState<StreamEncoding>(panel.encoding);
  const [following, setFollowing] = useState(remembered?.following ?? panel.follow !== false);
  const content = useRefContent(entry.path, panel.ref, { bytes: panel.bytes, tail: true, follow: following && panel.follow === true });
  const scroller = useRef<HTMLDivElement>(null);
  const rate = velocityOf(entry.ring, Date.now());

  // A stream that starts being written again is followed again.
  useEffect(() => {
    if (panel.follow) setFollowing(true);
  }, [panel.follow]);

  useEffect(() => {
    memory.set(key, { following, scrollTop: memory.get(key)?.scrollTop ?? 0 });
  }, [key, following]);

  // Where it was left, on a surface this stream has been on before. A follower
  // is pinned to the bottom anyway, so only a paused one has somewhere to go.
  useEffect(() => {
    const el = scroller.current;
    const top = memory.get(key)?.scrollTop ?? 0;
    if (!el || following || top <= 0) return;
    el.scrollTop = top;
    // Once, on the way in: after this the person owns the scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Follow = pinned to the bottom. Scrolling up pauses; the button resumes.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [content.text, following]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    memory.set(key, { following, scrollTop: el.scrollTop });
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && following) setFollowing(false);
    else if (atBottom && !following && panel.follow) setFollowing(true);
  };

  const describe = [
    panel.bytes !== undefined ? formatBytes(panel.bytes) : undefined,
    rate !== undefined && panel.follow ? formatRate(rate) : undefined,
    panel.truncated ? `${panel.truncated} truncated` : undefined,
    content.fromByte > 0 ? `showing the last ${formatBytes((panel.bytes ?? content.bytes ?? 0) - content.fromByte)}` : undefined,
  ].filter(Boolean);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", embedded ? "gap-1.5" : "gap-2")}>
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <EncodingSwitch value={encoding} onChange={setEncoding} />
        <span className="typed min-w-0 truncate text-ink-3" title={describe.join(" · ")}>
          {describe.join(" · ")}
        </span>
        <span className="flex-1" />
        {panel.follow !== false && (
          <TooltipIconButton
            tooltip={following ? "Pause following" : "Follow the tail"}
            size="icon-xs"
            side="left"
            aria-pressed={following}
            onClick={() => {
              setFollowing((f) => !f);
              const el = scroller.current;
              if (el && !following) el.scrollTop = el.scrollHeight;
            }}
          >
            {following ? <Pause /> : <Play />}
          </TooltipIconButton>
        )}
        {!following && (
          <TooltipIconButton
            tooltip="Jump to the end"
            size="icon-xs"
            side="left"
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
              if (panel.follow) setFollowing(true);
            }}
          >
            <ArrowDownToLine />
          </TooltipIconButton>
        )}
      </div>
      <div
        ref={scroller}
        onScroll={onScroll}
        data-island-scroll
        className={cn(
          "terminal min-h-0 flex-1 overflow-auto rounded-lg border border-terminal-line",
          embedded ? "max-h-56" : "",
        )}
        aria-live={following ? "polite" : "off"}
        aria-busy={content.loading || undefined}
      >
        {content.error ? (
          <p className="px-3 py-2 text-terminal-ink-2">{content.error}</p>
        ) : content.text === "" && content.loading ? (
          <TailLoading />
        ) : content.text === "" ? (
          <p className="px-3 py-2 text-terminal-ink-2">{panel.follow ? "Nothing written yet." : "Empty."}</p>
        ) : encoding === "jsonl" ? (
          <JsonlRows text={content.text} fromByte={content.fromByte} />
        ) : encoding === "ansi" ? (
          <pre className="px-3 py-2 wrap-break-word whitespace-pre-wrap">
            <AnsiText text={content.text} />
            {panel.follow && following ? <span aria-hidden="true" className="caret" /> : null}
          </pre>
        ) : (
          <pre className="px-3 py-2 wrap-break-word whitespace-pre-wrap text-terminal-ink-2">
            {/* Plain text still strips escapes: nothing is ever passed through. */}
            {stripAnsi(content.text)}
            {panel.follow && following ? <span aria-hidden="true" className="caret" /> : null}
          </pre>
        )}
      </div>
      {!embedded && <ActionButtons actions={panel.actions} onAct={onAct} />}
    </div>
  );
}

/**
 * The first read, before any bytes have arrived. An empty terminal block with
 * nothing but `aria-busy` reads as a bug; this says what is happening and
 * holds the shape the text will take (AGENTS.md: loading states are designed).
 */
function TailLoading() {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2" role="status">
      <p className="text-terminal-ink-2">Reading the tail…</p>
      <span aria-hidden="true" className="h-2 w-2/3 rounded-full bg-terminal-line motion-safe:animate-attention" />
      <span aria-hidden="true" className="h-2 w-5/6 rounded-full bg-terminal-line motion-safe:animate-attention" />
      <span aria-hidden="true" className="h-2 w-1/2 rounded-full bg-terminal-line motion-safe:animate-attention" />
    </div>
  );
}

const ENCODINGS: StreamEncoding[] = ["text", "ansi", "jsonl"];

function EncodingSwitch({ value, onChange }: { value: StreamEncoding; onChange(value: StreamEncoding): void }) {
  return (
    <div role="radiogroup" aria-label="Encoding" className="flex items-center rounded-md bg-surface-2 p-0.5">
      {ENCODINGS.map((encoding) => (
        <Button
          key={encoding}
          role="radio"
          aria-checked={value === encoding}
          size="xs"
          variant="ghost"
          className={cn("h-5 rounded-md px-1.5 font-mono text-xs uppercase tracking-eyebrow", value === encoding && "bg-surface text-ink shadow-float-sm")}
          onClick={() => onChange(encoding)}
        >
          {encoding}
        </Button>
      ))}
    </div>
  );
}

/**
 * One row per JSON record: a summary line, expandable to the pretty record.
 *
 * Rows are keyed by their **absolute byte offset in the stream**, never by an
 * index into the window. The window slides as the tail is trimmed and shifts
 * by one whenever the partial first line appears or disappears; keying by
 * position would let React re-use a `<details>` element — and its open state —
 * for a different record as new output arrives.
 */
function JsonlRows({ text, fromByte }: { text: string; fromByte: number }) {
  const rows = useMemo(() => {
    const out: Array<{ key: number; value: unknown; raw: string }> = [];
    let at = fromByte;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const offset = at;
      at += utf8Length(line) + 1; // the newline the split consumed
      // A tail read may begin mid-record; the first line is then not JSON.
      if (i === 0 && fromByte > 0) return;
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        out.push({ key: offset, value: JSON.parse(trimmed) as unknown, raw: trimmed });
      } catch {
        out.push({ key: offset, value: undefined, raw: trimmed });
      }
    });
    return out;
  }, [text, fromByte]);
  if (rows.length === 0) return <p className="px-3 py-2 text-terminal-ink-2">No complete records yet.</p>;
  return (
    <ul role="list" className="divide-y divide-terminal-line">
      {rows.map((row) => (
        <li key={row.key}>
          {row.value === undefined ? (
            <p className="px-3 py-1 wrap-break-word whitespace-pre-wrap text-terminal-ink-2">{row.raw}</p>
          ) : (
            <details className="group">
              <summary className="flex cursor-pointer items-baseline gap-2 px-3 py-1 text-terminal-ink outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live [&::-webkit-details-marker]:hidden">
                <span className="shrink-0 text-terminal-ink-2 tnum">{summaryKey(row.value)}</span>
                <span className="min-w-0 flex-1 truncate">{summaryOf(row.value)}</span>
              </summary>
              <pre className="px-3 pb-2 wrap-break-word whitespace-pre-wrap text-terminal-ink-2">{JSON.stringify(row.value, null, 2)}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function summaryKey(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value;
  const v = value as Record<string, unknown>;
  const t = v["type"] ?? v["kind"] ?? v["event"] ?? v["level"];
  return typeof t === "string" ? t : "record";
}

function summaryOf(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  for (const key of ["message", "msg", "text", "summary", "title", "name", "path"]) {
    if (typeof v[key] === "string") return v[key] as string;
  }
  return Object.keys(v).slice(0, 4).join(" · ");
}
