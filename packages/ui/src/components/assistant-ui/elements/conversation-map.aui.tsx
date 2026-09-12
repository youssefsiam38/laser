"use client";
/**
 * Conversation map (`conversation-map`, runtime-bound): groups the thread
 * into turns (a prompt and the replies to it), tracks which turn is being
 * read from the viewport's scroll position, and jumps the viewport when a
 * tick is chosen. Mounted sticky inside the thread viewport; hides itself for
 * short threads (`minTurns`) and on narrow widths (the caller's class).
 *
 * Registry copy, unchanged in logic; `minTurns` added so a two-turn thread
 * does not carry a rail.
 */
import { useAuiState, useThreadViewport, type ThreadMessage } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { visibleMessageGeometry } from "@/components/thread/visible-message-geometry.js";

import { ConversationMap, type ConversationMapEntry } from "./conversation-map.js";

const TITLE_LENGTH = 72;
const PREVIEW_LENGTH = 240;

/** A message scrolled to the top lands a fraction of a pixel below it. */
const TOP_TOLERANCE = 1;

/**
 * The line a message has to cross to count as the one being read: the top of
 * the viewport for most of a thread, sliding to the bottom across the final
 * screenful so the last turns are reachable.
 */
const readingLine = (viewport: HTMLElement) => {
  const rect = viewport.getBoundingClientRect();
  const height = viewport.clientHeight;
  if (height <= 0) return rect.top + TOP_TOLERANCE;
  const remaining = viewport.scrollHeight - height - viewport.scrollTop;
  const descent = Math.min(1, Math.max(0, (height - remaining) / height));
  return rect.top + rect.height * descent + TOP_TOLERANCE;
};

const partsOf = (message: ThreadMessage) => [...message.content];

const textOf = (message: ThreadMessage) =>
  partsOf(message)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();

const labelOf = (message: ThreadMessage) => {
  const parts = partsOf(message);
  const tools = parts.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []));
  if (tools.length === 1) return tools[0]!;
  if (tools.length > 1) return `${tools.length} tool calls`;
  if (parts.some((part) => part.type === "reasoning")) return "Reasoning";
  const carriers = [...parts, ...(message.attachments ?? [])];
  if (carriers.some((carrier) => carrier.type === "image")) return "Image";
  if (carriers.some((carrier) => carrier.type === "file")) return "File";
  if (carriers.length > 0) return "Attachment";
  return message.role === "user" ? "Message" : "Response";
};

const cutAtWord = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const boundary = head.lastIndexOf(" ");
  return boundary > limit / 2 ? head.slice(0, boundary) : head;
};

const linesOf = (message: ThreadMessage) =>
  textOf(message)
    .split("\n")
    .map((line) => line.replace(/^[\s#>*`-]+/, "").trim())
    .filter(Boolean);

type Turn = { head: ThreadMessage; members: ThreadMessage[] };

const groupIntoTurns = (messages: readonly ThreadMessage[]) => {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const current = turns.at(-1);
    if (message.role === "user" || !current) {
      turns.push({ head: message, members: [message] });
      continue;
    }
    current.members.push(message);
  }
  return turns;
};

const describe = ({ head, members }: Turn): ConversationMapEntry => {
  const lines = linesOf(head);
  const first = lines[0] ?? "";
  const title = cutAtWord(first, TITLE_LENGTH);
  const answer = members.find((member) => member !== head && textOf(member));
  const preview = (answer ? linesOf(answer).join(" ") : [first.slice(title.length), ...lines.slice(1)].join(" ")).trim().slice(0, PREVIEW_LENGTH);
  return { id: head.id, title: title || labelOf(head), ...(preview ? { preview } : {}) };
};

export interface ConversationMapAuiProps {
  side?: "left" | "right";
  /** Below this many turns the rail is not worth its gutter. */
  minTurns?: number;
  className?: string | undefined;
}

export function ConversationMapAui({ side = "right", minTurns = 4, className }: ConversationMapAuiProps) {
  const messages = useAuiState((s) => s.thread.messages);
  const viewport = useThreadViewport((s) => s.element.viewport);
  const viewportHeight = useThreadViewport((s) => s.height.viewport);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  const scheduleRef = useRef<(() => void) | undefined>(undefined);

  const turns = useMemo(() => groupIntoTurns(messages), [messages]);
  const entries = useMemo(() => turns.map(describe), [turns]);

  const turnOf = useMemo(() => {
    const owners = new Map<string, string>();
    for (const turn of turns) for (const member of turn.members) owners.set(member.id, turn.head.id);
    return owners;
  }, [turns]);

  const turnOfRef = useRef(turnOf);
  const turnKey = turns.map((turn) => turn.head.id).join(" ");
  useEffect(() => {
    turnOfRef.current = turnOf;
  });

  useEffect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    let content: HTMLElement | null = null;
    const measure = () => {
      frame = 0;
      const nextContent = viewport.querySelector<HTMLElement>('[data-slot="thread-messages"]');
      if (content !== nextContent) {
        if (content) observer.unobserve(content);
        content = nextContent;
        if (content) observer.observe(content);
      }
      const owners = turnOfRef.current;
      const view = viewport.getBoundingClientRect();
      const line = readingLine(viewport);
      const elements = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")]
        .filter((element) => owners.has(element.dataset["messageId"] ?? ""));
      const { active, visible: onScreen } = visibleMessageGeometry(elements, owners, view.top, view.bottom, line);
      setActiveId(active);
      setVisibleIds((previous) => (previous.length === onScreen.length && previous.every((id, index) => id === onScreen[index]) ? previous : onScreen));
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    scheduleRef.current = schedule;
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    return () => {
      scheduleRef.current = undefined;
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [viewport]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [turnKey]);

  const select = useCallback(
    (id: string) => {
      if (!viewport) return;
      for (const element of viewport.querySelectorAll<HTMLElement>("[data-message-id]")) {
        if (element.dataset["messageId"] !== id) continue;
        // `scrollIntoView` aligns every scrollable ancestor; only this viewport should move.
        const top = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
        viewport.scrollTo({ top, behavior: "smooth" });
        return;
      }
    },
    [viewport],
  );

  if (entries.length < minTurns) return null;

  return (
    <div data-slot="conversation-map-rail" className={cn("pointer-events-none sticky top-0 z-10 h-0 w-full", className)}>
      <div className={cn("pointer-events-auto absolute top-0 px-2 py-10", side === "right" ? "end-0" : "start-0")} style={{ height: viewportHeight }}>
        <ConversationMap entries={entries} activeId={activeId} visibleIds={visibleIds} onSelect={select} side={side === "right" ? "left" : "right"} />
      </div>
    </div>
  );
}
