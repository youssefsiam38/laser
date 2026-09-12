import type { ThreadMessage } from "@assistant-ui/react";
import type { SearchHit } from "../assistant-ui/elements/conversation-search.js";
import { matchExcerpt, partSearchContent, textMatches } from "./search-text.js";

/** Immutable runtime identities own the cache. One query per message, not an
 * unbounded query history; changed live messages leave no strong retainers.
 */
export function createConversationSearch(project = partSearchContent) {
  const content = new WeakMap<object, string[]>();
  const matches = new WeakMap<ThreadMessage, { query: string; hits: SearchHit[] }>();
  return (messages: readonly ThreadMessage[], query: string): SearchHit[] => {
    if (!query.trim()) return [];
    return messages.flatMap((message) => {
      const previous = matches.get(message);
      if (previous?.query === query) return previous.hits;
      let occurrence = 0;
      const hits = message.content.flatMap((part, partIndex) => {
        let fields = content.get(part);
        if (!fields) {
          fields = project(part as unknown as { type: string; [key: string]: unknown });
          content.set(part, fields);
        }
        const source = part.type === "reasoning" ? "reasoning" : part.type === "tool-call" ? "tool" : message.role === "user" ? "user" : "assistant";
        return fields.flatMap((text, fieldIndex) => textMatches(text, query).map((m): SearchHit => ({
          id: `${message.id}:${partIndex}:${fieldIndex}:${m.start}`, messageId: message.id,
          source, occurrence: occurrence++, ...matchExcerpt(text, m),
        })));
      });
      matches.set(message, { query, hits });
      return hits;
    });
  };
}

/** Native ranges move with scrolling. Only a changed message needs another
 * text traversal; a remounted root gets a new identity automatically.
 */
export function createMessageRangeCache(find: (root: HTMLElement) => Range[]) {
  const cache = new Map<HTMLElement, Range[]>();
  return {
    get(root: HTMLElement) {
      let ranges = cache.get(root);
      if (!ranges) { ranges = find(root); cache.set(root, ranges); }
      return ranges;
    },
    retain(roots: readonly HTMLElement[]) {
      const mounted = new Set(roots);
      for (const root of cache.keys()) if (!mounted.has(root)) cache.delete(root);
    },
    invalidate(records: readonly MutationRecord[]) {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const root = target?.closest<HTMLElement>("[data-message-id]");
        if (root) cache.delete(root);
        // A disclosure outside a message can hide whole roots. Structural
        // insertion outside a root changes no existing text/ranges.
        else if (record.type === "attributes") {
          for (const element of cache.keys()) if (target?.contains(element)) cache.delete(element);
        }
      }
    },
  };
}
