import type { Unstable_TriggerMatcher } from "@assistant-ui/react";

export type ProjectPath = { directory: string; prefix: string; head: string; error?: never } | { error: string; directory?: never; prefix?: never; head?: never };
const absolute = (path: string) => path.startsWith("/") || /^[a-z]:\//iu.test(path);

/** Renderer-safe path arithmetic. The host still owns IO and permissions. */
function normalized(path: string): string {
  const anchor = /^[a-z]:\//iu.exec(path)?.[0] ?? /^\/\/[^/]+\/[^/]+\//u.exec(path)?.[0] ?? "/";
  const parts: string[] = [];
  for (const part of path.slice(anchor.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return anchor + parts.join("/");
}

/** Absolute paths are machine paths; relative paths use the session directory.
 * Backslashes are typed separators, not escapes. Home expansion is deliberately
 * unsupported rather than guessing the host's home in the renderer.
 */
export function resolveProjectPath(text: string, cwd: string): ProjectPath {
  let query = (text.startsWith("@") ? text.slice(1) : text).replaceAll("\\", "/");
  cwd = normalized(cwd.replaceAll("\\", "/") || "/");
  if (/\s$/u.test(query) || /[\n\r\t\0]/u.test(query)) return { error: "Finish the path before adding a space." };
  if (query.startsWith("~")) return { error: "Home shortcuts aren’t supported here. Type an absolute path instead." };
  if (/^[a-z]:(?!\/)/iu.test(query)) return { error: "Use an absolute drive path, such as C:/." };
  // Dot segments name directories even before their following separator.
  if (/(?:^|\/)\.{1,2}$/u.test(query)) query += "/";
  const slash = query.lastIndexOf("/");
  const head = query.slice(0, slash + 1);
  const prefix = query.slice(slash + 1);
  return { directory: normalized(absolute(head) ? head : cwd + (cwd.endsWith("/") ? "" : "/") + head), prefix, head };
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

export function parentProjectQuery(query: string, cwd = "/"): string | null {
  query = query.replaceAll("\\", "/");
  if (!query.endsWith("/")) return null;
  const current = resolveProjectPath(query, cwd);
  if (current.error) return null;
  const parent = normalized(current.directory! + "/..");
  if (absolute(query)) return parent.endsWith("/") ? parent : parent + "/";
  const base = normalized(cwd.replaceAll("\\", "/")).split("/");
  const target = parent.split("/");
  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared]) shared++;
  const path = [...base.slice(shared).filter(Boolean).map(() => ".."), ...target.slice(shared).filter(Boolean)].join("/");
  return (query.startsWith("./") ? "./" : "") + (path ? path + "/" : "");
}
