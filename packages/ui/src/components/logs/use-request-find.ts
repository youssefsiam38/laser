import { useEffect, useRef, useState } from "react";
import { findTextMatches } from "@/components/thread/use-conversation-find";
import type { SearchHit } from "@/components/assistant-ui/elements/conversation-search";

/** Search the rendered section, not duplicate previews or hidden field metadata.
 * Full-request mode renders the complete retained JSON as one literal region.
 * Native highlights leave React and Markdown/Shiki's text nodes untouched. */
export function useRequestFind(query: string, viewKey: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState(0);
  const [matches, setMatches] = useState<Array<SearchHit & { range: Range }>>([]);
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    setIndex(0);
    const scan = () => {
      const next = [...root.querySelectorAll<HTMLElement>("[data-request-search-content]")].flatMap((region, regionIndex) =>
        findTextMatches(region, query, "literal").map((match, occurrence) => ({
          ...match, id: `${regionIndex}:${occurrence}`, messageId: String(regionIndex), occurrence,
        })));
      setMatches(next);
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [query, viewKey]);
  const activeIndex = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => {
    const current = matches[activeIndex]?.range;
    if (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined") {
      if(matches.length){
        CSS.highlights.set("request-matches", new Highlight(...matches.map(m => m.range)));
        CSS.highlights.set("request-current", new Highlight(...(current ? [current] : [])));
      } else { CSS.highlights.delete("request-matches"); CSS.highlights.delete("request-current"); }
    }
    // Scroll only the inspector, never the underlying session or the document.
    const frame = requestAnimationFrame(() => {
      const root = viewport.current;
      if (!root || !current?.startContainer.isConnected) return;
      const box = root.getBoundingClientRect();
      const rect = current.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) root.scrollTop += rect.top - box.top - box.height / 3;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (typeof CSS !== "undefined") { CSS.highlights?.delete("request-matches"); CSS.highlights?.delete("request-current"); }
    };
  }, [matches, activeIndex]);
  return { viewport, input, matches, activeIndex,
    step: (delta: number) => setIndex(matches.length ? (activeIndex + delta + matches.length) % matches.length : 0),
  };
}
