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
import { dedupeDiffLineMatches, overlayFindStatus } from "./overlay-find-model.js";

const MUTATION_PAINT_MS = 80;

function publishOverlayHighlights(matches: RootMatch[], index: number, scroll: boolean): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  if (!matches.length) {
    CSS.highlights.delete(OVERLAY_FIND_HIGHLIGHTS.matches);
    CSS.highlights.delete(OVERLAY_FIND_HIGHLIGHTS.current);
    return;
  }
  const current = matches[index];
  const rest = matches.filter((_, i) => i !== index).map((match) => match.range);
  CSS.highlights.set(OVERLAY_FIND_HIGHLIGHTS.matches, new Highlight(...rest));
  CSS.highlights.set(OVERLAY_FIND_HIGHLIGHTS.current, new Highlight(...(current ? [current.range] : [])));
  if (scroll) current?.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "auto" });
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
  const [matches, setMatches] = useState<RootMatch[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const paint = useCallback(
    (scroll: boolean) => {
      const node = host.current;
      if (!node || !open) {
        setMatches([]);
        publishOverlayHighlights([], 0, false);
        return;
      }
      for (const root of collectOpenShadowRoots(node)) adoptOverlayFindStyles(root);
      const next = query.trim()
        ? dedupeDiffLineMatches(findTextMatchesAcrossRoots(node, query, DIFF_LINE_FIND_POLICY))
        : [];
      setMatches(next);
      const at = Math.min(index, Math.max(0, next.length - 1));
      publishOverlayHighlights(next, at, scroll);
    },
    [host, index, open, query],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setIndex(0);
      setMatches([]);
      publishOverlayHighlights([], 0, false);
      return;
    }
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    paint(true);
  }, [open, paint]);

  useEffect(() => {
    if (!open) return;
    const node = host.current;
    if (!node || typeof MutationObserver !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => paint(false), MUTATION_PAINT_MS);
    });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [host, open, paint]);

  useEffect(() => () => publishOverlayHighlights([], 0, false), []);

  const modelCount = open && query.trim() ? patchValueMatches(modelText, query) : 0;
  const status = overlayFindStatus(query, index, matches.length, modelCount);

  const bar = open ? (
    <ConversationSearch
      inputRef={input}
      query={query}
      hits={matches.map((match, i) => ({
        id: String(i),
        messageId: "overlay",
        occurrence: i,
        before: match.before,
        match: match.match,
        after: match.after,
      }))}
      activeIndex={Math.min(index, Math.max(0, matches.length - 1))}
      status={status}
      label="Find in this file"
      onQueryChange={(value) => {
        setQuery(value);
        setIndex(0);
      }}
      onStep={(delta) => {
        const total = matches.length;
        if (!total) return;
        setIndex((current) => (current + delta + total) % total);
      }}
      onClose={onClose}
    />
  ) : null;

  return { bar, query };
}
