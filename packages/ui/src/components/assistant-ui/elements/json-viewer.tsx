"use client";

import { ChevronRight } from "lucide-react";
import { jsonSearchString } from "@lasercode/protocol";
import { useState, type ReactNode } from "react";
import { useSearchReveal } from "@/components/thread/search-state";

import { cn } from "@/lib/utils";

export interface JsonViewerProps {
  value: unknown;
  className?: string;
  /** Object levels expanded on first paint. */
  expandedDepth?: number;
  tone?: "surface" | "terminal";
}

/** Syntax-coloured JSON with independently collapsible objects and arrays. */
export function JsonViewer({ value, className, expandedDepth = 2, tone = "surface" }: JsonViewerProps) {
  return (
    <div
      data-slot="json-viewer"
      className={cn(
        "max-h-[60vh] min-w-0 overflow-auto rounded-lg border p-3 font-mono text-xs leading-sm",
        tone === "terminal" ? "border-terminal-line bg-terminal text-terminal-ink-2" : "border-line bg-surface-2 text-ink-2",
        className,
      )}
    >
      <JsonNode value={value} depth={0} expandedDepth={expandedDepth} tone={tone} />
    </div>
  );
}

export function parseJsonText(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function JsonNode({ name, value, depth, expandedDepth, tone, comma = false }: { name?: string; value: unknown; depth: number; expandedDepth: number; tone: "surface" | "terminal"; comma?: boolean }) {
  const structured = value !== null && typeof value === "object";
  const entries = structured ? Object.entries(value as Record<string, unknown>) : [];
  const array = Array.isArray(value);
  const reveal = useSearchReveal();
  const [userOpen, setOpen] = useState(depth < expandedDepth);
  const open = reveal || userOpen;
  const key = name === undefined ? null : <><span className={tone === "terminal" ? "text-terminal-ink" : "text-ink"}>{JSON.stringify(name)}</span><span className="text-ink-3">: </span></>;

  if (!structured) {
    return <div className="whitespace-pre-wrap wrap-break-word">{key}<JsonPrimitive value={value} />{comma && <span className="text-ink-3">,</span>}</div>;
  }

  const opener = array ? "[" : "{";
  const closer = array ? "]" : "}";
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-full cursor-pointer items-center rounded-sm text-start outline-none hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
      >
        <ChevronRight aria-hidden="true" className={cn("rtl:-scale-x-100", "me-1 size-3 shrink-0 transition-transform duration-(--motion-instant)", open && "rotate-90 rtl:-rotate-90")} />
        <span className="min-w-0 truncate">{key}{opener}{!open && <span className="text-ink-3"> {entries.length} {array ? "items" : "keys"} </span>}{!open && closer}{!open && comma ? "," : ""}</span>
      </button>
      {open && (
        <div className={cn("ms-1.5 border-s ps-3", tone === "terminal" ? "border-terminal-line" : "border-line")}>
          {entries.map(([entryKey, entryValue], index) => (
            <JsonNode
              key={`${entryKey}-${index}`}
              {...(!array ? { name: entryKey } : {})}
              value={entryValue}
              depth={depth + 1}
              expandedDepth={expandedDepth}
              tone={tone}
              comma={index < entries.length - 1}
            />
          ))}
          <div>{closer}{comma ? "," : ""}</div>
        </div>
      )}
    </div>
  );
}

function JsonPrimitive({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span data-search-content className="text-ink-3">null</span>;
  if (typeof value === "string") return <span className="text-live">{"\""}<span data-search-content>{jsonSearchString(value)}</span>{"\""}</span>;
  if (typeof value === "number") return <span data-search-content className="text-attention">{String(value)}</span>;
  if (typeof value === "boolean") return <span data-search-content className="text-ok">{String(value)}</span>;
  return <span className="text-ink-3">{JSON.stringify(value) ?? String(value)}</span>;
}
