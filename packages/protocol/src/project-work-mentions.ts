/**
 * Mentioning project work from a conversation (M21-T9).
 *
 * The leap's contract is two sentences: *the stored message carries the typed
 * `ProjectWorkRef`, while the visible and copied text uses a stable human
 * form*, and *at send time the host validates the project, revision, digest
 * and read scope, then supplies the exact bounded projection to the worker*.
 *
 * A conversation stores text and images and nothing else, so "the stored
 * message carries the ref" has exactly one honest spelling: the identity is
 * written **into the message**, in a place a person never reads and a machine
 * always can — a Markdown link-reference definition at the foot of the
 * message:
 *
 * ```text
 * Compare @TASK-44 "Rework the picker" with the spec.
 *
 * [TASK-44]: laser://work/p_a1/task/e_9/r_3 "sha256-8f1c…"
 * ```
 *
 * The prose carries the human form and nothing else, so what a person sees,
 * selects and copies is `@TASK-44 "Rework the picker"`; the transcript renders
 * that span as one chip and drops the definitions entirely. The foot of the
 * message carries the four parts of the identity plus the digest the client
 * pinned, so the mention survives a reload, an edit, a fork and a second
 * device — none of which can carry a side-channel.
 *
 * Both sides read this module: the composer writes the tokens, the transcript
 * parses them, the host validates them and the search projection collapses
 * them, so a mention can never mean one thing in one surface and another
 * somewhere else.
 */
import { z } from "zod";

import { URL_SCHEME_PREFIX } from "./identity.js";
import {
  PROJECT_WORK_LABEL_MAX,
  isProjectWorkKind,
  parseProjectWorkKey,
  projectWorkRefSchema,
  type ProjectWorkKind,
  type ProjectWorkRef,
  type ProjectWorkState,
} from "./project-work.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How many project-work mentions one message may carry. */
export const PROJECT_WORK_MENTION_MAX = 20;
/** The longest bounded body excerpt one projection carries, in characters. */
export const PROJECT_WORK_MENTION_EXCERPT_MAX = 1200;
/** The longest single summary value a projection carries. */
export const PROJECT_WORK_MENTION_SUMMARY_MAX = 400;
/** How many summary fields a projection carries for one entity. */
export const PROJECT_WORK_MENTION_SUMMARY_FIELDS_MAX = 8;

// ---------------------------------------------------------------------------
// The token grammar
// ---------------------------------------------------------------------------

/** `laser://work/<projectId>/<kind>/<entityId>/<revisionId>` — the same link the workspace opens. */
export function projectWorkMentionUrl(ref: Pick<ProjectWorkRef, "projectId" | "kind" | "entityId" | "revisionId">): string {
  return `${URL_SCHEME_PREFIX}work/${encodeURIComponent(ref.projectId)}/${ref.kind}/${encodeURIComponent(ref.entityId)}/${encodeURIComponent(ref.revisionId)}`;
}

/**
 * The label a prose token and its definition share. The key alone, except
 * when one message mentions the same key twice at two different revisions —
 * then the second is `TASK-44#2`, and stays readable.
 */
export function projectWorkMentionLabel(key: string, occurrence = 1): string {
  return occurrence > 1 ? `${key}#${occurrence}` : key;
}

/** `@TASK-44 "Rework the picker"` — what a person sees, selects and copies. */
export function projectWorkMentionToken(ref: Pick<ProjectWorkRef, "key" | "label">, occurrence = 1): string {
  const label = ref.label.trim();
  return label ? `@${projectWorkMentionLabel(ref.key, occurrence)} ${JSON.stringify(label)}` : `@${projectWorkMentionLabel(ref.key, occurrence)}`;
}

/** `[TASK-44]: laser://work/… "sha256-…"` — the identity, at the foot of the message. */
export function projectWorkMentionDefinition(label: string, ref: ProjectWorkRef): string {
  return `[${label}]: ${projectWorkMentionUrl(ref)} "sha256-${ref.digest}"`;
}

const DEFINITION_RE = /^\[([A-Z]+-\d{1,7}(?:#\d{1,2})?)\]:[ \t]+(\S+)(?:[ \t]+"sha256-([0-9a-f]{64})")?[ \t]*$/u;
const TOKEN_LABEL_RE = /^([A-Z]+-\d{1,7})(?:#(\d{1,2}))?$/u;

/** A mention definition found at the foot of a message. */
export interface ProjectWorkMentionDefinition {
  /** `TASK-44`, or `TASK-44#2` for a second pin of the same key. */
  label: string;
  key: string;
  ref: ProjectWorkRef;
  /** Where the whole line sits in the text, so a renderer can drop it. */
  start: number;
  end: number;
}

/** One `@KEY "title"` span in the prose. */
export interface ProjectWorkMentionSpan {
  start: number;
  end: number;
  /** The definition label this token names (`TASK-44`, `TASK-44#2`). */
  label: string;
  key: string;
  kind: ProjectWorkKind;
  /** The title as the person sees it, when the token carries one. */
  title: string | undefined;
  /** The pinned identity, when the message defines one for this label. */
  ref: ProjectWorkRef | undefined;
}

function opensWord(text: string, at: number): boolean {
  return at === 0 || /\s/u.test(text[at - 1]!);
}

function parseUrl(url: string): Pick<ProjectWorkRef, "projectId" | "kind" | "entityId" | "revisionId"> | undefined {
  if (!url.toLowerCase().startsWith(`${URL_SCHEME_PREFIX}work/`)) return undefined;
  const segments = url.slice(URL_SCHEME_PREFIX.length).split("/");
  if (segments.length !== 5 || segments[0] !== "work") return undefined;
  const [, rawProject, kind, rawEntity, rawRevision] = segments;
  if (!isProjectWorkKind(kind)) return undefined;
  try {
    const projectId = decodeURIComponent(rawProject!);
    const entityId = decodeURIComponent(rawEntity!);
    const revisionId = decodeURIComponent(rawRevision!);
    if (!projectId || !entityId || !revisionId) return undefined;
    return { projectId, kind, entityId, revisionId };
  } catch {
    return undefined;
  }
}

/**
 * Every definition at the foot of a message, in the order they appear.
 *
 * A malformed line is not a definition and stays ordinary text: nothing here
 * repairs a link into a plausible one, because a repaired identity would point
 * at whatever happens to be current.
 */
export function projectWorkMentionDefinitions(text: string): ProjectWorkMentionDefinition[] {
  const found: ProjectWorkMentionDefinition[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const start = at;
    at += line.length + 1;
    const match = DEFINITION_RE.exec(line.trim());
    if (!match) continue;
    const [, label, url, digest] = match;
    const parts = parseUrl(url!);
    if (!parts || !digest) continue;
    const keyMatch = TOKEN_LABEL_RE.exec(label!);
    const key = keyMatch?.[1];
    if (!key || parseProjectWorkKey(key)?.kind !== parts.kind) continue;
    const ref: ProjectWorkRef = { ...parts, digest, key, label: "" };
    found.push({ label: label!, key, ref, start, end: start + line.length });
  }
  return found;
}

/**
 * Every `@KEY` token in the prose, with the identity its message pins for it.
 *
 * Reading the definitions is what makes a token a mention: `@TASK-44` typed
 * into a sentence with nothing at the foot of the message is a key a person
 * wrote, and it is answered by the surfaces that can resolve a key, never by
 * inventing a revision here.
 */
export function projectWorkMentionSpans(text: string): ProjectWorkMentionSpan[] {
  const definitions = new Map<string, ProjectWorkMentionDefinition>();
  const defined: ProjectWorkMentionDefinition[] = projectWorkMentionDefinitions(text);
  for (const definition of defined) if (!definitions.has(definition.label)) definitions.set(definition.label, definition);
  const inDefinition = (index: number): boolean => defined.some((definition) => index >= definition.start && index < definition.end);

  const spans: ProjectWorkMentionSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || !opensWord(text, index) || inDefinition(index)) continue;
    let end = index + 1;
    while (end < text.length && /[A-Za-z0-9#-]/u.test(text[end]!)) end += 1;
    const raw = text.slice(index + 1, end);
    const match = TOKEN_LABEL_RE.exec(raw);
    const key = match?.[1];
    const parsed = key ? parseProjectWorkKey(key) : undefined;
    if (!match || !key || !parsed) continue;
    let title: string | undefined;
    if (text[end] === " " && text[end + 1] === '"') {
      const quoted = readQuoted(text, end + 1);
      if (quoted) {
        title = quoted.value;
        end = quoted.end;
      }
    }
    // A token has to close a word, exactly as a path mention does, so
    // `@TASK-44x` and an email-shaped `a@TASK-44` are never mentions.
    if (end < text.length && !/[\s.,;:!?)\]}]/u.test(text[end]!)) continue;
    const label = raw;
    const definition = definitions.get(label);
    const ref = definition ? { ...definition.ref, label: title ?? definition.ref.label } : undefined;
    spans.push({ start: index, end, label, key, kind: parsed.kind, title, ref });
    index = end - 1;
  }
  return spans;
}

function readQuoted(text: string, at: number): { value: string; end: number } | undefined {
  let end = at + 1;
  let escaped = false;
  for (; end < text.length; end += 1) {
    const char = text[end]!;
    if (char === "\n") return undefined;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') {
      try {
        const value: unknown = JSON.parse(text.slice(at, end + 1));
        return typeof value === "string" ? { value, end: end + 1 } : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The message as it is sent: the person's prose, plus one definition per
 * mention at the foot of it.
 *
 * Idempotent, because a message can be sent twice — edited, forked, restored
 * from the tray — and a second pass must not stack a second copy of the same
 * identity. A ref whose label the text already defines is left exactly as it
 * was: what was sent once is what is sent again.
 */
export function withProjectWorkMentions(text: string, pinned: ReadonlyMap<string, ProjectWorkRef>): string {
  if (pinned.size === 0) return text;
  const existing = new Set(projectWorkMentionDefinitions(text).map((definition) => definition.label));
  const lines: string[] = [];
  for (const span of projectWorkMentionSpans(text)) {
    if (span.ref || existing.has(span.label)) continue;
    const ref = pinned.get(span.label);
    if (!ref || ref.key !== span.key) continue;
    existing.add(span.label);
    lines.push(projectWorkMentionDefinition(span.label, ref));
    if (lines.length >= PROJECT_WORK_MENTION_MAX) break;
  }
  if (lines.length === 0) return text;
  const body = text.replace(/\s+$/u, "");
  return `${body}\n\n${lines.join("\n")}`;
}

/**
 * The message without its definitions: what a person reads, and the one text
 * a search index stores. The identity lines are never indexed and never
 * duplicated beside the prose that already carries the key.
 */
export function projectWorkMentionProse(text: string): string {
  const definitions = projectWorkMentionDefinitions(text);
  if (definitions.length === 0) return text;
  let out = "";
  let at = 0;
  for (const definition of definitions) {
    out += text.slice(at, definition.start);
    at = Math.min(text.length, definition.end + 1);
  }
  out += text.slice(at);
  return out.replace(/\n{3,}$/u, "\n").replace(/\s+$/u, "");
}

// ---------------------------------------------------------------------------
// What the host validates, and what it hands the worker
// ---------------------------------------------------------------------------

/** One field of the bounded projection: a label a person would recognise, and its value. */
export interface ProjectWorkMentionField {
  label: string;
  value: string;
}

/**
 * Why a mention could not be read as it was pinned. The chip keeps its
 * identity in every one of these; only the body is missing.
 */
export type ProjectWorkMentionProblem =
  | "unreadable"
  | "unknown_project"
  | "unknown_entity"
  | "unknown_revision"
  | "released";

/** What the host hands the worker for one mention: bounded, and never the whole body. */
export interface ProjectWorkMentionProjection {
  /** The identity as the host read it — re-pinned when the client's digest was stale. */
  ref: ProjectWorkRef;
  key: string;
  kind: ProjectWorkKind;
  title: string;
  state: ProjectWorkState;
  /** `[from Acme TASK-44@3]` — on every projection, so nothing is quoted without its source. */
  provenance: string;
  /** The kind's own summary fields, bounded. */
  fields: ProjectWorkMentionField[];
  /** A bounded excerpt of the body, chosen by kind. Absent when there is none to give. */
  excerpt?: string;
  /** True when the excerpt was cut. */
  truncated?: boolean;
  /** Set when the body could not be supplied; the identity above still stands. */
  unavailable?: { reason: ProjectWorkMentionProblem; detail: string };
}

/** What the sender is told about one mention it pinned. */
export interface ProjectWorkMentionOutcome {
  /** The identity as the host read it. */
  ref: ProjectWorkRef;
  status: "sent" | "repinned" | "unavailable";
  /** One sentence for a person, when there is something to say. */
  note?: string;
}

export const projectWorkMentionFieldSchema = z
  .object({ label: z.string().min(1).max(80), value: z.string().max(PROJECT_WORK_MENTION_SUMMARY_MAX) })
  .strict();

export const projectWorkMentionProjectionSchema = z
  .object({
    ref: projectWorkRefSchema,
    key: z.string().max(40),
    kind: z.enum(["spec", "research", "design", "plan", "task"]),
    title: z.string().max(PROJECT_WORK_LABEL_MAX),
    state: z.string().max(40),
    provenance: z.string().max(200),
    fields: z.array(projectWorkMentionFieldSchema).max(PROJECT_WORK_MENTION_SUMMARY_FIELDS_MAX),
    excerpt: z.string().max(PROJECT_WORK_MENTION_EXCERPT_MAX).optional(),
    truncated: z.boolean().optional(),
    unavailable: z
      .object({
        reason: z.enum(["unreadable", "unknown_project", "unknown_entity", "unknown_revision", "released"]),
        detail: z.string().max(400),
      })
      .strict()
      .optional(),
  })
  .strict();

export const projectWorkMentionOutcomeSchema = z
  .object({
    ref: projectWorkRefSchema,
    status: z.enum(["sent", "repinned", "unavailable"]),
    note: z.string().max(400).optional(),
  })
  .strict();
