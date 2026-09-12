import { useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationSearch } from "@/components/assistant-ui/elements/conversation-search";
import { motionMs } from "@/motion";
import { Button } from "@/components/ui/button";
import { matchExcerpt, textMatches } from "./search-text.js";
import { createConversationSearch, createMessageRangeCache } from "./conversation-search-cache.js";
import type { SearchSource } from "./search-state.js";

/** Build ranges across markup boundaries without changing React-owned DOM. */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  return findTextMatches(root, query).map(match => match.range);
}

/** Diagnostics opt into literal JSON; chat keeps its value-only display policy. */
export function findTextMatches(root: HTMLElement, query: string, mode: "conversation" | "literal" = "conversation") {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  type TextRun = { text: string; nodes: Array<{ node: Text; start: number; end: number }> };
  const runs: TextRun[] = [];
  let region: Element | null = null;
  let run: TextRun | undefined;
  let next: Node | null;
  while ((next = walker.nextNode())) {
    const parent = next.parentElement;
    const content = mode === "conversation" ? parent?.closest("[data-search-content]") ?? null : null;
    // Tool bodies are opt-in. JSON keys, status labels, gutters and transport
    // wrappers must never consume the occurrence assigned to a real value.
    const button = parent?.closest("button");
    const authoredFileLabel = mode === "conversation" && content && button?.matches('[data-slot="file-chip"]');
    if (!parent || (button && !authoredFileLabel) || parent.closest("[hidden], [aria-hidden=true], [data-search-exclude], textarea, script, style") ||
      (mode === "conversation" && parent.closest('[data-search-tool], [data-slot="json-viewer"]') && !content)) {
      run = undefined;
      continue;
    }
    const nextRegion = content ?? root;
    if (!run || region !== nextRegion) { run = { text: "", nodes: [] }; runs.push(run); region = nextRegion; }
    const value = next.textContent ?? "";
    run.nodes.push({ node: next as Text, start: run.text.length, end: run.text.length + value.length });
    run.text += value;
  }
  return runs.flatMap(({ text, nodes }) => textMatches(text, query).flatMap(m => {
    const first = nodes.find(n => n.end > m.start);
    const last = nodes.find(n => n.end >= m.end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, m.start - first.start);
    range.setEnd(last.node, m.end - last.start);
    return [{ range, ...matchExcerpt(text, m) }];
  }));
}

export function useConversationFind({ partial = false, loadAll }: { partial?: boolean; loadAll?: () => Promise<boolean> } = {}) {
  const messages = useAuiState(s => s.thread.messages);
  const threadId = useAuiState(s => s.threads.mainThreadId);
  const [loadingAll, setLoadingAll] = useState(false);
  const loadingRef = useRef(false);
  const focusAfterLoad = useRef<Element | null>(null);
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const loadHistory = useCallback(async () => {
    if (!partial || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingAll(true);
    focusAfterLoad.current = document.activeElement;
    try { await loadAll?.(); }
    finally { if (currentThread.current === threadId) {
      loadingRef.current = false; setLoadingAll(false);
    } }
  }, [loadAll, partial, threadId]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (loadingAll) return;
    const focused = focusAfterLoad.current;
    focusAfterLoad.current = null;
    if (focused && !focused.isConnected && document.activeElement === document.body) input.current?.focus({ preventScroll: true });
  }, [loadingAll, partial]);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const previousThread = useRef(threadId);
  const preferredSource = useRef<SearchSource | undefined>(undefined);
  const search = useMemo(() => createConversationSearch(), []);
  const hits = useMemo(() => open && !loadingAll ? search(messages, query) : [], [messages, query, open, loadingAll, search]);
  useEffect(() => {
    if (!preferredSource.current || !hits.length) return;
    const preferred = hits.findIndex(hit => hit.source === preferredSource.current);
    preferredSource.current = undefined;
    if (preferred >= 0) setIndex(preferred);
  }, [hits]);
  const activeIndex = Math.min(index, Math.max(0, hits.length - 1));
  const active = hits[activeIndex];
  const activeRef = useRef(active);
  activeRef.current = active;
  const schedulePaint = useRef<(() => void) | undefined>(undefined);
  const close = useCallback(() => {
    setOpen(false);
    (restoreFocus.current?.isConnected ? restoreFocus.current : root.current?.querySelector<HTMLElement>("textarea"))?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (previousThread.current !== threadId) { setOpen(false); setQuery(""); setIndex(0); setLoadingAll(false); loadingRef.current = false; previousThread.current = threadId; }
  }, [threadId]);
  useEffect(() => {
    const show = (value?: string, source?: SearchSource) => {
      if (!root.current?.getClientRects().length || document.querySelector('[aria-label="Workbench screens"]')) return;
      if (!open) restoreFocus.current = document.activeElement as HTMLElement;
      if (value !== undefined) { setQuery(value); setIndex(0); void loadHistory(); }
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
  }, [open, loadHistory]);
  // Update highlights as Markdown/Shiki and streaming content settle. Navigating
  // scrolls only this viewport, never the sidebar, composer or page.
  useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>('[data-slot="thread-viewport"]');
    if (!viewport || !open || !query.trim()) return;
    let frame = 0;
    const cache = createMessageRangeCache(message => findTextRanges(message, query));
    const paint = () => {
      if (!("highlights" in CSS) || typeof Highlight === "undefined") return;
      const ranges: Range[] = [];
      let selected: Range | undefined;
      const active = activeRef.current;
      const messages = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")];
      cache.retain(messages);
      for (const message of messages) {
        const found = cache.get(message);
        ranges.push(...found);
        if (active && message.dataset.messageId === active.messageId) selected = found[active.occurrence] ?? found[0];
      }
      CSS.highlights.set("conversation-matches", new Highlight(...ranges));
      CSS.highlights.set("conversation-current", new Highlight(...(selected ? [selected] : [])));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); };
    const observer = new MutationObserver(records => { cache.invalidate(records); schedule(); });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "data-state", "data-search-content", "data-search-exclude"] });
    schedulePaint.current = schedule;
    schedule();
    return () => { schedulePaint.current = undefined; cancelAnimationFrame(frame); observer.disconnect(); CSS.highlights?.delete("conversation-matches"); CSS.highlights?.delete("conversation-current"); };
  }, [open, query]);
  useEffect(() => { schedulePaint.current?.(); }, [active?.id, active?.messageId, active?.occurrence]);
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
      aria-busy={loadingAll} status={loadingAll ? "Loading…" : undefined}
      toolbar={partial ? <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-ink-2">
        <span>Only loaded messages are searched.</span>
        <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={loadingAll} onClick={() => void loadHistory()}>{loadingAll ? "Loading messages…" : "Load all messages"}</Button>
      </div> : undefined}
      onQueryChange={value => { setQuery(value); setIndex(0); }}
      onStep={delta => setIndex(hits.length ? (activeIndex + delta + hits.length) % hits.length : 0)} onClose={close} /> : null,
  };
}
