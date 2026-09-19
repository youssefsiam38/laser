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

/**
 * A mention opens a word: it is at the start of the text, or whitespace is in
 * front of its `@`. One spelling of the rule, read by the matcher, by the
 * scanner and by the composer's record of finished mentions — otherwise a
 * draft can show a tag over something the transcript renders as prose
 * (`hi@./server/index.ts`).
 */
export function opensProjectMention(text: string, start: number): boolean {
  return start === 0 || /\s/u.test(text[start - 1]!);
}

/**
 * …and it closes one: the token runs to whitespace or to the end of the text,
 * with only sentence punctuation (which the scanner trims) allowed in between.
 * `@./a.ts@./b.ts` closes neither.
 */
export function closesProjectMention(text: string, end: number): boolean {
  let at = end;
  while (at < text.length && TRAILING_SENTENCE_PUNCTUATION.test(text[at]!)) at += 1;
  return at === text.length || /\s/u.test(text[at]!);
}

/**
 * Where a bare `@token` that opens at `start` ends: at whitespace or the end of
 * the text, minus the sentence punctuation that belongs to the sentence rather
 * than to the name.
 */
export function bareMentionEnd(text: string, start: number): number {
  let end = start + 1;
  while (end < text.length && !/\s/u.test(text[end]!)) end += 1;
  while (end > start + 1 && TRAILING_SENTENCE_PUNCTUATION.test(text[end - 1]!)) end -= 1;
  return end;
}

/**
 * A handle as the picker writes one: a bare word, never a path. D-284 keeps
 * handles out of the transcript's chips, so `projectMentionSpans` never yields
 * one; a draft that arrives whole still carries them, and the composer has to
 * know that `@audit` in it is a mention someone already chose.
 */
export function isBareMentionHandle(token: string): boolean {
  return isBareProjectMentionPath(token) && !/[/\\:~]/u.test(token) && !token.startsWith(".");
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
/**
 * A query whose spaces are inside a quoted segment the person has opened and
 * not yet closed: `@~/projects/"my pro`. Escapes count, so `\\"` is a literal
 * quote and does not close anything.
 */
function hasOpenQuote(query: string): boolean {
  let open = false;
  let escaped = false;
  for (const char of query) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') open = !open;
  }
  return open;
}

export const matchProjectMention: Unstable_TriggerMatcher = (text, char, caret) => {
  const before = text.slice(0, caret);
  const offset = before.lastIndexOf(char);
  if (offset < 0 || !opensProjectMention(before, offset)) return null;
  const query = before.slice(offset + char.length);
  if (/[\n\r\t\0\u007f]/u.test(query)) return null;
  // A closed quoted form is a completed insertion, never a picker query; an
  // open one is the person writing a name that has spaces in it.
  if (query.startsWith('"') && !hasOpenQuote(query)) return null;
  // A space ends the query unless the person opened a quote for a name that
  // has one (`@~/projects/"my project` …). Without this rule an ordinary
  // sentence — or a pasted log with `console.error @ 696-…js:1` in it — keeps
  // the picker open over text that was never a path (D-304).
  if (/\s/u.test(query) && !hasOpenQuote(query)) return null;
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
    if (text[index] !== "@" || !opensProjectMention(text, index)) continue;
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
      if (text[end - 1] !== '"' || !closesProjectMention(text, end)) continue;
      path = parseQuotedPath(text.slice(index + 1, end));
    } else {
      end = bareMentionEnd(text, index);
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

