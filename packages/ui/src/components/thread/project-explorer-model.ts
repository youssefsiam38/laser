import type { DirectoryEntry } from "@lasercode/protocol";
import type { Unstable_TriggerItem } from "@assistant-ui/react";
import type { PickerNavigation } from "../assistant-ui/elements/composer-trigger-popover.aui.js";
import { matchProjectMention, parentProjectQuery, replaceProjectQuery } from "./project-path.js";

export function explorerItems(entries: readonly DirectoryEntry[], root: string): Unstable_TriggerItem[] {
  const base = root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  return entries.map((entry) => {
    const absolute = entry.path.replaceAll("\\", "/");
    const path = absolute.startsWith(base) ? absolute.slice(base.length) : absolute;
    return { id: path, type: entry.kind === "directory" ? "directory" : "file", label: path,
      metadata: { icon: entry.kind === "directory" ? "directory" : "file", name: entry.name } };
  });
}

export function explorerNavigation(options: { query?: string; head: string; commonPrefix: string; loading: boolean; next?: (() => void) | undefined; previous?: (() => void) | undefined }): PickerNavigation {
  const select: PickerNavigation["select"] = (item, text, caret) => {
    if (item.type === "page") {
      if (item.id === "next") options.next?.(); else options.previous?.();
      return { text, caret };
    }
    if (item.type !== "directory") return null;
    return replaceProjectQuery(text, caret, options.head + String(item.metadata?.name) + "/");
  };
  return { select, key: (key, items, selected, text, caret) => {
    const match = matchProjectMention(text, "@", caret);
    if (!match) return null;
    if (key === "Backspace") {
      const parent = parentProjectQuery(match.query);
      return parent === null ? null : replaceProjectQuery(text, caret, parent);
    }
    if (key === "/" && selected?.type === "directory" && match.query && !/[\\/]$/u.test(match.query)) return select(selected, text, caret);
    if (key !== "Tab") return null;
    if (options.loading || (options.query !== undefined && options.query !== match.query)) return { text, caret }; // a slow listing must never select an old row
    let prefix = options.commonPrefix;
    const handles = items.filter((item) => item.type === "agent");
    if (!prefix) prefix = handles[0]?.label ?? "";
    for (const handle of handles) while (prefix && !handle.label.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix || items.length === 0) return items.length ? { text, caret } : null;
    return replaceProjectQuery(text, caret, options.head + prefix);
  } };
}
