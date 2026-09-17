import type { Unstable_TriggerMatcher } from "@assistant-ui/react";

export type ProjectPath = { ok: true; directory: string; prefix: string; head: string } | { ok: false; error: string };
const HOME_TOKENS = /^(?:~|%USERPROFILE%)(?:\/)?$/iu;
const DRIVE_RELATIVE = /^[a-z]:(?!\/)/iu;

/**
 * Split a person's path spelling without resolving it. Filesystem semantics,
 * home expansion and the final canonical path belong to the host.
 */
export function resolveProjectPath(text: string): ProjectPath {
  let query = (text.startsWith("@") ? text.slice(1) : text).replaceAll("\\", "/");
  if (/\s$/u.test(query) || /[\n\r\t\0]/u.test(query)) return { ok: false, error: "Finish the path before adding a space." };
  if (DRIVE_RELATIVE.test(query)) return { ok: false, error: "Use an absolute drive path, such as C:/." };
  if (HOME_TOKENS.test(query)) query = query.replace(/\/?$/u, "/");
  // Dot segments name directories even before their following separator.
  if (/(?:^|\/)\.{1,2}$/u.test(query)) query += "/";
  const slash = query.lastIndexOf("/");
  const head = query.slice(0, slash + 1);
  const prefix = query.slice(slash + 1);
  const directory = /^[a-z]:\/$/iu.test(head) ? head : head ? head.replace(/\/$/u, "") || "/" : ".";
  return { ok: true, directory, prefix, head };
}

export const matchProjectMention: Unstable_TriggerMatcher = (text, char, caret) => {
  const before = text.slice(0, caret);
  const offset = before.lastIndexOf(char);
  if (offset < 0 || (offset > 0 && !/\s/u.test(before[offset - 1]!))) return null;
  const query = before.slice(offset + 1);
  if (/\s$/u.test(query) || /[\n\r\t]/u.test(query)) return null;
  return { query, offset, endOffset: caret };
};

export function replaceProjectQuery(text: string, caret: number, query: string) {
  const match = matchProjectMention(text, "@", caret);
  if (!match) return null;
  const before = text.slice(0, match.offset) + "@" + query;
  return { text: before + text.slice(caret), caret: before.length };
}

/** The parent spelling for Backspace after a separator, preserving its anchor. */
export function parentProjectQuery(query: string): string | null {
  query = query.replaceAll("\\", "/");
  if (!query.endsWith("/")) return null;
  if (query === "/" || /^[a-z]:\/$/iu.test(query) || /^\/\/[^/]+\/[^/]+\/$/u.test(query) || query === "~/" || /^%USERPROFILE%\/$/iu.test(query)) return null;
  const withoutSlash = query.slice(0, -1);
  if (withoutSlash === ".." || withoutSlash.endsWith("/..")) return `${query}../`;
  const slash = withoutSlash.lastIndexOf("/");
  if (slash < 0) return "";
  return withoutSlash.slice(0, slash + 1);
}
