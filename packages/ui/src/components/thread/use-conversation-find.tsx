import { useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationSearch, type SearchHit } from "@/components/assistant-ui/elements/conversation-search";
import { motionMs } from "@/motion";
import { matchExcerpt, partSearchText, textMatches } from "./search-text.js";
import type { SearchSource } from "./search-state.js";

/** Build ranges across markup boundaries without changing React-owned DOM. */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  let next: Node | null;
  while ((next = walker.nextNode())) {
    const parent = next.parentElement;
    if (!parent || parent.closest("button, [hidden], [aria-hidden=true], textarea, script, style")) continue;
    const value = next.textContent ?? "";
    nodes.push({ node: next as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  return textMatches(text, query).flatMap(m => {
    const first = nodes.find(n => n.end > m.start);
    const last = nodes.find(n => n.end >= m.end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, m.start - first.start);
    range.setEnd(last.node, m.end - last.start);
    return [range];
  });
}

export function useConversationFind() {
  const messages = useAuiState(s => s.thread.messages);
  const threadId = useAuiState(s => s.threads.mainThreadId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const previousThread = useRef(threadId);
  const preferredSource = useRef<SearchSource | undefined>(undefined);
  const hits = useMemo(() => {
    if (!open || !query.trim()) return [];
    return messages.flatMap(message => {
      let occurrence = 0;
      return message.content.flatMap((part, partIndex) => {
        const text = partSearchText(part as unknown as { type: string; [key: string]: unknown });
        const source = part.type === "reasoning" ? "reasoning" : part.type === "tool-call" ? "tool" : message.role === "user" ? "user" : "assistant";
        return textMatches(text, query).map((m): SearchHit => ({ id: `${message.id}:${partIndex}:${m.start}`, messageId: message.id, source, occurrence: occurrence++, ...matchExcerpt(text, m) }));
      });
    });
  }, [messages, query, open]);
  useEffect(() => {
    if (!preferredSource.current || !hits.length) return;
    const preferred = hits.findIndex(hit => hit.source === preferredSource.current);
    preferredSource.current = undefined;
    if (preferred >= 0) setIndex(preferred);
  }, [hits]);
  const activeIndex = Math.min(index, Math.max(0, hits.length - 1));
  const active = hits[activeIndex];
  const close = useCallback(() => {
    setOpen(false);
    (restoreFocus.current?.isConnected ? restoreFocus.current : root.current?.querySelector<HTMLElement>("textarea"))?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (previousThread.current !== threadId) { setOpen(false); setQuery(""); setIndex(0); previousThread.current = threadId; }
  }, [threadId]);
  useEffect(() => {
    const show = (value?: string, source?: SearchSource) => {
      if (!root.current?.getClientRects().length || document.querySelector('[aria-label="Workbench screens"]')) return;
      if (!open) restoreFocus.current = document.activeElement as HTMLElement;
      if (value !== undefined) { setQuery(value); setIndex(0); }
      preferredSource.current = source;
      setOpen(true);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f" && !document.querySelector('[role="dialog"]')) {
        if (!root.current?.getClientRects().length || document.querySelector('[aria-label="Workbench screens"]')) return;
        e.preventDefault(); show();
      }
    };
    const event = (e: Event) => {
      const { query, source } = (e as CustomEvent<{ query?: string; source?: SearchSource }>).detail;
      show(query, source);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("conversation-find", event);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("conversation-find", event); };
  }, [open]);
  // Update highlights as Markdown/Shiki and streaming content settle. Navigating
  // scrolls only this viewport, never the sidebar, composer or page.
  useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>('[data-slot="thread-viewport"]');
    if (!viewport || !open || !query.trim()) return;
    let frame = 0;
    const paint = () => {
      if (!("highlights" in CSS) || typeof Highlight === "undefined") return;
      const ranges: Range[] = [];
      let selected: Range | undefined;
      for (const message of viewport.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const found = findTextRanges(message, query);
        ranges.push(...found);
        if (active && message.dataset.messageId === active.messageId) selected = found[active.occurrence] ?? found[0];
      }
      CSS.highlights.set("conversation-matches", new Highlight(...ranges));
      CSS.highlights.set("conversation-current", new Highlight(...(selected ? [selected] : [])));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); };
    const observer = new MutationObserver(schedule);
    observer.observe(viewport, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "data-state"] });
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); viewport.removeEventListener("scroll", schedule); CSS.highlights?.delete("conversation-matches"); CSS.highlights?.delete("conversation-current"); };
  }, [open, query, active?.id, active?.messageId, active?.occurrence]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      const viewport = root.current?.querySelector<HTMLElement>('[data-slot="thread-viewport"]');
      const message = [...(viewport?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].find(n => n.dataset.messageId === active.messageId);
      if (!viewport || !message) return;
      const ranges = findTextRanges(message, query);
      const rect = (ranges[active.occurrence] ?? ranges[0])?.getBoundingClientRect() ?? message.getBoundingClientRect();
      const footer = viewport.querySelector<HTMLElement>('[data-slot="thread-footer"]')?.getBoundingClientRect().height ?? 0;
      viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - Math.max(0, viewport.clientHeight - footer) / 3;
    }, motionMs("--motion-fast") + 32);
    return () => clearTimeout(timer);
  }, [active?.id, query]);
  return {
    root, open, selectedMessage: active?.messageId,
    bar: open ? <ConversationSearch inputRef={input} query={query} hits={hits} activeIndex={activeIndex}
      onQueryChange={value => { setQuery(value); setIndex(0); }}
      onStep={delta => setIndex(hits.length ? (activeIndex + delta + hits.length) % hits.length : 0)} onClose={close} /> : null,
  };
}
