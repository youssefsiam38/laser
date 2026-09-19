import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { ConversationSearch } from "@/components/assistant-ui/elements/conversation-search";
import {
  DIFF_LINE_FIND_POLICY,
  OVERLAY_FIND_HIGHLIGHTS,
  adoptOverlayFindStyles,
  collectOpenShadowRoots,
  findTextMatchesAcrossRoots,
  type RootMatch,
} from "@/components/thread/find-ranges.js";

import { patchValueMatches } from "./classify.js";

function publishOverlayHighlights(matches: RootMatch[], index: number): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  if (!matches.length) {
    CSS.highlights.delete(OVERLAY_FIND_HIGHLIGHTS.matches);
    CSS.highlights.delete(OVERLAY_FIND_HIGHLIGHTS.current);
    return;
  }
  const current = matches[index];
  const rest = matches.filter((_, i) => i !== index).map(match => match.range);
  CSS.highlights.set(OVERLAY_FIND_HIGHLIGHTS.matches, new Highlight(...rest));
  CSS.highlights.set(OVERLAY_FIND_HIGHLIGHTS.current, new Highlight(...(current ? [current.range] : [])));
  current?.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "auto" });
}

export function useOverlayFind({
  host,
  open,
  modelText,
  onClose,
}: {
  host: RefObject<HTMLElement | null>;
  open: boolean;
  modelText: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<RootMatch[]>([]);

  const paint = useCallback(() => {
    const node = host.current;
    if (!node || !open) {
      matchesRef.current = [];
      publishOverlayHighlights([], 0);
      return;
    }
    for (const root of collectOpenShadowRoots(node)) adoptOverlayFindStyles(root);
    const matches = query.trim() ? findTextMatchesAcrossRoots(node, query, DIFF_LINE_FIND_POLICY) : [];
    matchesRef.current = matches;
    const at = Math.min(index, Math.max(0, matches.length - 1));
    publishOverlayHighlights(matches, at);
  }, [host, index, open, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setIndex(0);
      matchesRef.current = [];
      publishOverlayHighlights([], 0);
      return;
    }
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    paint();
    const node = host.current;
    if (!node) return;
    const observer = typeof MutationObserver === "function" ? new MutationObserver(() => paint()) : undefined;
    observer?.observe(node, { childList: true, subtree: true, characterData: true });
    return () => observer?.disconnect();
  }, [open, paint]);

  useEffect(() => () => publishOverlayHighlights([], 0), []);

  const rendered = matchesRef.current;
  const modelCount = open && query.trim() ? patchValueMatches(modelText, query) : 0;
  const hidden = Math.max(0, modelCount - rendered.length);
  const status = !query.trim()
    ? "0 / 0"
    : rendered.length
      ? `${Math.min(index, rendered.length - 1) + 1} / ${rendered.length}${hidden ? ` · ${hidden} in collapsed context` : ""}`
      : modelCount
        ? `Collapsed · ${modelCount} in this file`
        : "No matches";

  const bar = open ? (
    <ConversationSearch
      inputRef={input}
      query={query}
      hits={rendered.map((match, i) => ({
        id: String(i),
        messageId: "overlay",
        occurrence: i,
        before: match.before,
        match: match.match,
        after: match.after,
      }))}
      activeIndex={Math.min(index, Math.max(0, rendered.length - 1))}
      status={status}
      label="Find in this file"
      onQueryChange={value => {
        setQuery(value);
        setIndex(0);
      }}
      onStep={delta => {
        const total = matchesRef.current.length;
        if (!total) return;
        setIndex(current => (current + delta + total) % total);
      }}
      onClose={onClose}
    />
  ) : null;

  return { bar, query };
}
