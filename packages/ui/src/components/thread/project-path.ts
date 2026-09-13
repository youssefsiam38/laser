import type { Unstable_TriggerMatcher } from "@assistant-ui/react";

export type ProjectPath = { directory: string; prefix: string; head: string; error?: never } | { error: string; directory?: never; prefix?: never; head?: never };

/** `/` alone means project root. Other absolute paths must name this project.
 * Backslashes are typed separators, not escapes. Home expansion is deliberately
 * unavailable: this picker never leaves the project. Whitespace ends a query.
 */
export function resolveProjectPath(text: string, root: string): ProjectPath {
  let query = text.startsWith("@") ? text.slice(1) : text;
  query = query.replaceAll("\\", "/");
  root = root.replaceAll("\\", "/").replace(/\/$/, "") || "/";
  if (/\s$/u.test(query) || /[\n\r\t\0]/u.test(query)) return { error: "Finish the path before adding a space." };
  if (query.startsWith("~")) return { error: "Choose a path inside this project; home paths are not available here." };
  if (query === "/") query = "";
  else if (query.startsWith("/") || /^[a-z]:/iu.test(query)) {
    if (root === "/" && query.startsWith("/")) query = query.slice(1);
    else if (query === root) query = "";
    else if (query.startsWith(root + "/")) query = query.slice(root.length + 1);
    else return { error: "Choose a path inside this project." };
  }
  const slash = query.lastIndexOf("/");
  const head = query.slice(0, slash + 1);
  const prefix = query.slice(slash + 1);
  const parts: string[] = [];
  for (const part of head.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return { error: "Choose a path inside this project." };
      parts.pop();
    } else parts.push(part);
  }
  if (prefix === ".." && !parts.length) return { error: "Choose a path inside this project." };
  return { directory: root + (parts.length ? (root.endsWith("/") ? "" : "/") + parts.join("/") : ""), prefix, head };
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

export function parentProjectQuery(query: string): string | null {
  query = query.replaceAll("\\", "/");
  if (!query.endsWith("/") || query === "/" || query === "./") return null;
  const without = query.slice(0, -1);
  return without.slice(0, without.lastIndexOf("/") + 1);
}
