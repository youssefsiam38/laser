import {
  unstable_defaultDirectiveFormatter,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  type Unstable_TriggerMatcher,
} from "@assistant-ui/react";

export type ProjectPath = { ok: true; directory: string; prefix: string; head: string } | { ok: false; error: string };
type Segment = ReturnType<Unstable_DirectiveFormatter["parse"]>[number];

const HOME_TOKENS = /^(?:~|%USERPROFILE%)(?:\/)?$/iu;
const DRIVE_RELATIVE = /^[a-z]:(?!\/)/iu;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/iu;
const BARE_MENTION_PATH = /^[^\s@\]"'\\\u0000-\u001f\u007f]+$/u;
const BARE_WINDOWS_PATH = /^[a-z]:[\\/][^\s@\]"'\u0000-\u001f\u007f]+$/iu;
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?)\]}]/u;

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

/** A picker path may stay bare only when the readable scanner can recover it. */
export function isBareProjectMentionPath(path: string): boolean {
  return BARE_MENTION_PATH.test(path) || BARE_WINDOWS_PATH.test(path);
}

function hasPathAnchor(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../") || path.startsWith("/") || path.startsWith("~/") || WINDOWS_ABSOLUTE.test(path);
}

/** Add a quiet marker to in-session identities; external identities keep their anchor. */
function anchoredProjectMentionPath(path: string): string {
  if (path.startsWith("../") || path.startsWith("/") || path.startsWith("~/") || WINDOWS_ABSOLUTE.test(path)) return path;
  return `./${path}`;
}

/** JSON quoting keeps unusual anchored paths reversible without directive syntax. */
export function quotedProjectMentionPath(path: string): string {
  return `@${JSON.stringify(anchoredProjectMentionPath(path)).replaceAll(":", "\\u003a")}`;
}

function readableProjectMentionPath(path: string): string {
  const anchored = anchoredProjectMentionPath(path);
  return isBareProjectMentionPath(anchored) && !TRAILING_SENTENCE_PUNCTUATION.test(anchored.at(-1) ?? "")
    ? `@${anchored}`
    : quotedProjectMentionPath(path);
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

/**
 * The `@` query at the caret, if one is in flight. This reads text alone, so
 * it cannot tell a chosen mention from a path still being typed — a folder
 * name with a space looks exactly like a choice followed by prose. Which `@`
 * is already finished is decided beside the composer's draft, by the record in
 * `finished-mentions.ts`, and the composer uses that matcher, not this one.
 */
export const matchProjectMention: Unstable_TriggerMatcher = (text, char, caret) => {
  const before = text.slice(0, caret);
  const offset = before.lastIndexOf(char);
  if (offset < 0 || (offset > 0 && !/\s/u.test(before[offset - 1]!))) return null;
  const query = before.slice(offset + char.length);
  // Quoting is a completed insertion form, never an in-flight picker query.
  if (query.startsWith('"') || /\s$/u.test(query) || /[\n\r\t\0\u007f]/u.test(query)) return null;
  return { query, offset, endOffset: caret };
};

export function replaceProjectQuery(text: string, caret: number, query: string) {
  const match = matchProjectMention(text, "@", caret);
  if (!match) return null;
  const before = text.slice(0, match.offset) + "@" + query;
  return { text: before + text.slice(caret), caret: before.length };
}

function projectMentionIdentity(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/**
 * Where each readable picker token sits in a string, in one scan.
 *
 * The renderer needs segments and the composer needs ranges; both read this,
 * so a mention can never be a chip in the transcript and ordinary text in the
 * draft that produced it.
 */
export type ProjectMentionSpan = {
  readonly start: number;
  readonly end: number;
  readonly type: "file" | "directory";
  readonly id: string;
  readonly label: string;
};

export function projectMentionSpans(text: string): ProjectMentionSpan[] {
  const spans: ProjectMentionSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || (index > 0 && !/\s/u.test(text[index - 1]!))) continue;
    let end = index + 1;
    let path: string | undefined;
    if (text[end] === '"') {
      let escaped = false;
      for (end += 1; end < text.length; end += 1) {
        const char = text[end]!;
        if (!escaped && char === '"') { end += 1; break; }
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      if (text[end - 1] !== '"' || (end < text.length && !/\s/u.test(text[end]!) && !TRAILING_SENTENCE_PUNCTUATION.test(text[end]!))) continue;
      path = parseQuotedPath(text.slice(index + 1, end));
    } else {
      while (end < text.length && !/\s/u.test(text[end]!)) end += 1;
      while (end > index + 1 && TRAILING_SENTENCE_PUNCTUATION.test(text[end - 1]!)) end -= 1;
      const candidate = text.slice(index + 1, end);
      if (isBareProjectMentionPath(candidate)) path = candidate;
    }
    if (path === undefined || !hasPathAnchor(path)) continue;
    const identity = projectMentionIdentity(path);
    if (!identity) continue;
    spans.push({ start: index, end, type: identity.endsWith("/") ? "directory" : "file", id: identity, label: identity });
    index = end - 1;
  }
  return spans;
}

function parseReadableProjectMentions(text: string): Segment[] {
  const segments: Segment[] = [];
  let textStart = 0;
  for (const span of projectMentionSpans(text)) {
    if (textStart < span.start) segments.push({ kind: "text", text: text.slice(textStart, span.start) });
    segments.push({ kind: "mention", type: span.type, id: span.id, label: span.label });
    textStart = span.end;
  }
  if (textStart < text.length) segments.push({ kind: "text", text: text.slice(textStart) });
  return segments.length ? segments : [{ kind: "text", text }];
}

/** Read saved directives first, then readable picker tokens only inside text. */
export const projectMentionFormatter: Unstable_DirectiveFormatter = {
  serialize: (item: Unstable_TriggerItem) => {
    if (item.type === "file" || item.type === "directory") return readableProjectMentionPath(item.label);
    if (item.type === "agent") return isBareProjectMentionPath(item.label) ? `@${item.label}` : `@${JSON.stringify(item.label).replaceAll(":", "\\u003a")}`;
    return unstable_defaultDirectiveFormatter.serialize(item);
  },
  parse: (text) => unstable_defaultDirectiveFormatter.parse(text).flatMap((part) =>
    part.kind === "text" ? parseReadableProjectMentions(part.text) : [part],
  ),
};

