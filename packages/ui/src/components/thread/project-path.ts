import {
  unstable_defaultDirectiveFormatter,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  type Unstable_TriggerMatcher,
} from "@assistant-ui/react";

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

const BARE_MENTION_PATH = /^[^\s@\]"'\\\u0000-\u001f\u007f]+$/u;
const ACTIVE_MENTION_QUERY = /^[^\s@"\u0000-\u001f\u007f]+$/u;

/** A picker path may stay bare only when the matcher will read it back unchanged. */
export function isBareProjectMentionPath(path: string): boolean {
  return BARE_MENTION_PATH.test(path);
}

/** JSON quoting keeps unusual paths reversible without exposing directive syntax. */
export function quotedProjectMentionPath(path: string): string {
  return `@${JSON.stringify(path)}`;
}

function readableProjectMentionPath(path: string): string {
  return isBareProjectMentionPath(path) ? `@${path}` : quotedProjectMentionPath(path);
}

function parseQuotedPath(raw: string): string | undefined {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export const matchProjectMention: Unstable_TriggerMatcher = (text, char, caret) => {
  const before = text.slice(0, caret);
  for (let offset = before.lastIndexOf(char); offset >= 0; offset = before.lastIndexOf(char, offset - 1)) {
    if (offset > 0 && !/\s/u.test(before[offset - 1]!)) continue;
    const raw = before.slice(offset + char.length);
    if (raw.startsWith('"')) {
      const query = parseQuotedPath(raw);
      return query === undefined ? null : { query, offset, endOffset: caret };
    }
    if (!ACTIVE_MENTION_QUERY.test(raw) && raw !== "") return null;
    return { query: raw, offset, endOffset: caret };
  }
  return null;
};

export function replaceProjectQuery(text: string, caret: number, query: string) {
  const match = matchProjectMention(text, "@", caret);
  if (!match) return null;
  const token = query === "" ? "@" : readableProjectMentionPath(query);
  const before = text.slice(0, match.offset) + token;
  return { text: before + text.slice(caret), caret: before.length };
}

function isPathShaped(path: string): boolean {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(path)) return false;
  return path.includes("/") || /^\.[^./]/u.test(path) || /(?:^|\/)[^/]+\.[^/]+$/u.test(path);
}

function parseReadableProjectMentions(text: string): ReturnType<Unstable_DirectiveFormatter["parse"]> {
  const segments: ReturnType<Unstable_DirectiveFormatter["parse"]>[number][] = [];
  let textStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || (index > 0 && !/\s/u.test(text[index - 1]!))) continue;
    let end = index + 1;
    let path: string | undefined;
    let quoted = false;
    if (text[end] === '"') {
      quoted = true;
      let escaped = false;
      for (end += 1; end < text.length; end += 1) {
        const char = text[end]!;
        if (!escaped && char === '"') { end += 1; break; }
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      if (end > text.length || text[end - 1] !== '"' || (end < text.length && !/\s/u.test(text[end]!))) continue;
      path = parseQuotedPath(text.slice(index + 1, end));
    } else {
      while (end < text.length && !/\s/u.test(text[end]!)) end += 1;
      const candidate = text.slice(index + 1, end);
      if (isBareProjectMentionPath(candidate)) path = candidate;
    }
    if (path === undefined || path === "" || (!quoted && !isPathShaped(path))) continue;
    if (textStart < index) segments.push({ kind: "text", text: text.slice(textStart, index) });
    segments.push({ kind: "mention", type: path.endsWith("/") ? "directory" : "file", id: path, label: path });
    textStart = end;
    index = end - 1;
  }
  if (textStart < text.length) segments.push({ kind: "text", text: text.slice(textStart) });
  return segments.length ? segments : [{ kind: "text", text }];
}

/** Readable picker tokens plus the legacy directive grammar for saved sessions. */
export const projectMentionFormatter: Unstable_DirectiveFormatter = {
  serialize: (item: Unstable_TriggerItem) => {
    if (item.type === "file" || item.type === "directory") return readableProjectMentionPath(item.label);
    if (item.type === "agent" && isBareProjectMentionPath(item.label)) return `@${item.label}`;
    return unstable_defaultDirectiveFormatter.serialize(item);
  },
  parse: (text) => parseReadableProjectMentions(text).flatMap((part) =>
    part.kind === "text" ? unstable_defaultDirectiveFormatter.parse(part.text) : [part],
  ),
};

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
