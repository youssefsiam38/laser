import type { ExplorerEntry } from "@lasercode/protocol";
import { unstable_defaultDirectiveFormatter, type Unstable_DirectiveFormatter, type Unstable_TriggerItem } from "@assistant-ui/react";
import type { PickerNavigation } from "../assistant-ui/elements/composer-trigger-popover.aui.js";
import type { ExplorerNavigationState } from "./use-directory-page.js";
import { matchProjectMention, parentProjectQuery, replaceProjectQuery } from "./project-path.js";

/**
 * Explorer choices are path references, not uploaded contents. A selected
 * folder keeps a trailing `/` in its directory directive; attachments.ts only
 * unwraps `<attached-file>` payloads, so the agent receives this path intact
 * and can inspect it with `ls` instead of Laser reading a directory as a file.
 */

/** Injective typed UI identity, including arbitrary UTF-16 names; no whitespace in DOM IDs. */
export function mentionItemId(type: "file" | "directory" | "agent" | "action", identity: string): string {
  let encoded = "";
  for (let i = 0; i < identity.length; i++) encoded += identity.charCodeAt(i).toString(16).padStart(4, "0");
  return `${type}:${encoded}`;
}
export function explorerItems(entries: readonly ExplorerEntry[], cwd: string): Unstable_TriggerItem[] {
  const base = cwd.replaceAll("\\", "/").replace(/\/$/u, "") + "/";
  return entries.map((entry) => {
    const absolute = entry.path.replaceAll("\\", "/");
    const identity = entry.kind === "directory" && !absolute.endsWith("/") ? `${absolute}/` : absolute;
    const relative = absolute.startsWith(base) ? absolute.slice(base.length) : absolute;
    const label = entry.kind === "directory" && !relative.endsWith("/") ? `${relative}/` : relative;
    return { id: mentionItemId(entry.kind, identity), type: entry.kind, label,
      metadata: { icon: entry.kind, name: entry.name, identity } };
  });
}
export function explorerPageItem(direction: "next" | "previous"): Unstable_TriggerItem {
  return { id: mentionItemId("action", direction), type: "action", label: direction === "next" ? "More entries…" : "Previous entries",
    metadata: { countable: false, icon: direction, direction } };
}

/** Keep UI keys separate from the existing wire/display directive identities. */
function directive(item: Unstable_TriggerItem): string | undefined {
  const identity = item.metadata?.identity;
  if (typeof identity !== "string" || /[\r\n]/u.test(identity)) return undefined;
  const serialized = unstable_defaultDirectiveFormatter.serialize({ ...item, id: identity });
  const parts = unstable_defaultDirectiveFormatter.parse(serialized);
  const part = parts[0];
  return parts.length === 1 && part?.kind === "mention" && part.id === identity && part.label === item.label && part.type === item.type ? serialized : undefined;
}
/** A quoted, reversible plain path. Escaped colons prevent embedded directive syntax. */
export const quotedMentionPath = (identity: string): string => JSON.stringify(identity).replaceAll(":", "\\u003a");
export const mentionFormatter: Unstable_DirectiveFormatter = {
  parse: unstable_defaultDirectiveFormatter.parse,
  serialize: (item) => directive(item) ?? quotedMentionPath(typeof item.metadata?.identity === "string" ? item.metadata.identity : item.label),
};

export function explorerNavigation(options: ExplorerNavigationState): PickerNavigation {
  const select: PickerNavigation["select"] = (item, text, caret) => {
    if (item.metadata?.countable === false) {
      if (item.metadata.direction === "next") options.next?.();
      else if (item.metadata.direction === "previous") options.previous?.();
      return { text, caret };
    }
    return null; // formatter owns file, folder and agent insertion, including plain-path fallback
  };
  return { select, key: (key, items, selected, text, caret) => {
    const match = matchProjectMention(text, "@", caret);
    if (!match) return null;
    if (key === "Backspace") {
      const parent = parentProjectQuery(match.query);
      return parent === null || parent === match.query ? null : replaceProjectQuery(text, caret, parent);
    }
    if (key === "/" && selected?.type === "directory" && match.query && !/(?:[\\/]$|(?:^|[\\/])\.{1,2}$)/u.test(match.query)) {
      const name = selected.metadata?.name;
      if (typeof name !== "string" || !name || /[\r\n\0/]/u.test(name)) return { text, caret };
      return replaceProjectQuery(text, caret, options.head + name + "/");
    }
    if (key !== "Tab") return null;
    if (options.loading || options.query !== match.query) return { text, caret };
    let prefix = options.commonPrefix;
    const handles = items.filter((item) => item.type === "agent");
    if (!prefix) prefix = handles[0]?.label ?? "";
    for (const handle of handles) while (prefix && !handle.label.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix || /[\r\n]/u.test(prefix) || items.length === 0) return items.length ? { text, caret } : null;
    return replaceProjectQuery(text, caret, options.head + prefix);
  } };
}
