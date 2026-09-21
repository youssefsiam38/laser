"use client";
/**
 * Mentioning project work from the composer (M21-T9).
 *
 * One adapter, not two: `@` still answers with this session's child handles
 * and the host's directory listing, and this module is what adds project work
 * beside them. The rules are the leap's ("Cross-session mentions and context"):
 *
 * - `@TASK-44` finds it by key, `@spec:phone` narrows by kind, and anything
 *   else searches titles.
 * - **This project ranks first.** Every other project a person can read here
 *   is grouped under its own name, because a key is only unique inside one
 *   project and a row that does not say where it is from is a trap.
 * - **Picking pins an identity.** The draft gets the human form
 *   (`@TASK-44 "Rework the picker"`); the ref the row was built from is kept
 *   beside it, and the send path writes it into the message
 *   (`withProjectWorkMentions`, in the protocol, is the one spelling both the
 *   composer and the host read).
 * - **Nothing is copied.** A pinned mention is a reference: the bounded
 *   projection the model reads is built by the host at send time, from the
 *   exact revision the message names.
 *
 * Every function here is pure except the pin registry, which is one small
 * module-level map for the same reason the project-work registry is one: the
 * composer that inserts and the send path that expands are far apart in the
 * tree, and the answer is per label, not per component.
 */
import {
  PROJECT_WORK_KINDS,
  isProjectWorkKeyString,
  parseProjectWorkKey,
  projectWorkMentionLabel,
  projectWorkMentionSpans,
  projectWorkMentionToken,
  projectWorkMentionUrl,
  withProjectWorkMentions,
  type ProjectWorkKind,
  type ProjectWorkListItem,
  type ProjectWorkRef,
  type ProjectWorkSearchResult,
  type ProjectWorkState,
} from "@lasercode/protocol";

import { useEffect, useState, useSyncExternalStore } from "react";

import { parseWorkLink, type WorkLinkTarget } from "./deep-link.js";
import { resolveProjectWork } from "./registry.js";
import type { ProjectWorkStore } from "./store.js";
import { KIND_LABEL } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/** `@spec:`, `@research:`, `@design:`, `@plan:`, `@task:` — the kind filters. */
export const WORK_MENTION_PREFIXES: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "spec:",
  research: "research:",
  design: "design:",
  plan: "plan:",
  task: "task:",
};

export interface WorkMentionQuery {
  /** The kinds the query narrows to. Empty means every kind. */
  kinds: ProjectWorkKind[];
  /** What is left to search for: a key, or words from a title. */
  text: string;
  /** The exact key the person typed, when they typed one. */
  key: string | undefined;
}

/**
 * What the typed `@…` asks project work for, or `undefined` when it asks it
 * nothing.
 *
 * A path is never a project-work query (`@./server/` belongs to the explorer),
 * and neither is an empty `@`: an empty picker shows this session's handles and
 * its folder, as it always did. A bare `@t` is a title search, not a key.
 */
export function parseWorkMentionQuery(query: string, options: { freeText?: boolean } = {}): WorkMentionQuery | undefined {
  // A composer query is one word: `@` closes at a space (D-304). A search
  // field is not a composer, so it may ask in a sentence.
  if (query === "" || /[/\\~"]/u.test(query) || (/\s/u.test(query) && options.freeText !== true)) return undefined;
  for (const kind of PROJECT_WORK_KINDS) {
    const prefix = WORK_MENTION_PREFIXES[kind];
    if (query.toLowerCase().startsWith(prefix)) {
      const text = query.slice(prefix.length);
      return { kinds: [kind], text, key: keyOf(text) };
    }
  }
  const key = keyOf(query);
  return { kinds: [], text: query, key };
}

function keyOf(text: string): string | undefined {
  const upper = text.toUpperCase();
  return parseProjectWorkKey(upper) ? upper : undefined;
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** One project the picker may read, with the name a person calls it. */
export interface MentionProject {
  projectId: string;
  name: string;
  /** True for the project this conversation is in. */
  current: boolean;
}

/** One row of project work in the `@` picker. */
export interface WorkMentionCandidate {
  ref: ProjectWorkRef;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  state: ProjectWorkState;
  project: MentionProject;
  /** True when the person typed this exact key. */
  exactKey: boolean;
  /** The host's score for a body match, or 0 for a row matched locally. */
  score: number;
}

/** A cached row and a search hit are the same candidate once they carry a ref. */
export function candidateOfListItem(item: ProjectWorkListItem, project: MentionProject, key: string | undefined): WorkMentionCandidate {
  return {
    ref: item.ref,
    kind: item.kind,
    key: item.key,
    title: item.title,
    state: item.state,
    project,
    exactKey: key !== undefined && item.key === key,
    score: 0,
  };
}

export function candidateOfSearchResult(result: ProjectWorkSearchResult, project: MentionProject): WorkMentionCandidate {
  return {
    ref: result.ref,
    kind: result.kind,
    key: result.key,
    title: result.title,
    state: result.state,
    project,
    exactKey: result.exactKey,
    score: result.score,
  };
}

/**
 * The order the picker draws.
 *
 * The exact key first — typing `TASK-44` means TASK-44 — then this project's
 * rows, then every other project, each in one block under its own name so the
 * eye reads "these are from elsewhere" once rather than per row. Inside a
 * block it is the host's score, then the key, so two runs of the same query
 * never reshuffle.
 */
export function rankWorkMentions(candidates: readonly WorkMentionCandidate[], limit = 12): WorkMentionCandidate[] {
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const identity = `${candidate.ref.projectId}\u0000${candidate.ref.entityId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const projects: string[] = [];
  for (const candidate of unique) if (!projects.includes(candidate.project.projectId)) projects.push(candidate.project.projectId);
  const projectRank = (candidate: WorkMentionCandidate): number =>
    candidate.project.current ? -1 : projects.indexOf(candidate.project.projectId);
  return unique
    .slice()
    .sort((a, b) => {
      if (a.exactKey !== b.exactKey) return a.exactKey ? -1 : 1;
      const byProject = projectRank(a) - projectRank(b);
      if (byProject !== 0) return byProject;
      if (a.score !== b.score) return b.score - a.score;
      return a.key.localeCompare(b.key, undefined, { numeric: true });
    })
    .slice(0, limit);
}

/** The line under a row: what it is, where it is, and what state it is in. */
export function mentionRowDescription(candidate: WorkMentionCandidate): string {
  const where = candidate.project.current ? "" : ` · ${candidate.project.name}`;
  return `${KIND_LABEL[candidate.kind]}${where}`;
}

// ---------------------------------------------------------------------------
// Picker identity
// ---------------------------------------------------------------------------

const ITEM_PREFIX = "work:";

/** A DOM-safe, injective id for one row: the identity, hex-encoded. */
export function workMentionItemId(ref: ProjectWorkRef): string {
  const identity = `${ref.projectId}/${ref.kind}/${ref.entityId}/${ref.revisionId}/${ref.digest}/${ref.key}`;
  let encoded = "";
  for (let index = 0; index < identity.length; index += 1) encoded += identity.charCodeAt(index).toString(16).padStart(4, "0");
  return `${ITEM_PREFIX}${encoded}`;
}

export function isWorkMentionItemId(id: string): boolean {
  return id.startsWith(ITEM_PREFIX);
}

/**
 * The identity back out of a row's id, with the title the row displayed.
 *
 * The id is the only field a picker hands back untouched, so it carries the
 * whole identity; the title comes from the row's label (`KEY title`), which
 * is what the person just read and therefore what the draft should say.
 */
export function decodeWorkMentionItemId(id: string, label?: string): ProjectWorkRef | undefined {
  if (!isWorkMentionItemId(id)) return undefined;
  const hex = id.slice(ITEM_PREFIX.length);
  if (hex.length % 4 !== 0) return undefined;
  let identity = "";
  for (let at = 0; at < hex.length; at += 4) {
    const code = Number.parseInt(hex.slice(at, at + 4), 16);
    if (!Number.isFinite(code)) return undefined;
    identity += String.fromCharCode(code);
  }
  const [projectId, kind, entityId, revisionId, digest, key] = identity.split("/");
  if (!projectId || !kind || !entityId || !revisionId || !digest || !key) return undefined;
  if (!isProjectWorkKeyString(key) || parseProjectWorkKey(key)?.kind !== kind) return undefined;
  const title = label && label.startsWith(`${key} `) ? label.slice(key.length + 1) : "";
  return { projectId, kind: kind as ProjectWorkKind, entityId, revisionId, digest, key, label: title };
}

/**
 * What a transcript chip carries: the link it opens and the key it says.
 *
 * The renderer's segment is a label and an id, so the id *is* the identity —
 * the same work link the workspace opens, with the key beside it. Nothing is
 * looked up to draw a chip, and nothing is guessed: a chip with no link is
 * plain text, not a chip pointing at whatever is current.
 */
export function workMentionSegmentId(ref: Pick<ProjectWorkRef, "projectId" | "kind" | "entityId" | "revisionId" | "key">): string {
  return `${projectWorkMentionUrl(ref)}?key=${encodeURIComponent(ref.key)}`;
}

export function parseWorkMentionSegment(id: string): { target: WorkLinkTarget; key: string; kind: ProjectWorkKind } | undefined {
  const target = parseWorkLink(id);
  if (!target?.entityId || !target.kind) return undefined;
  const key = decodeURIComponent(id.split("?key=")[1] ?? "");
  if (!isProjectWorkKeyString(key) || parseProjectWorkKey(key)?.kind !== target.kind) return undefined;
  return { target, key, kind: target.kind };
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

/** How many pins one window remembers. Older ones fall off, never the newest. */
const PIN_MAX = 64;
const pins = new Map<string, ProjectWorkRef>();

/**
 * Remember the identity behind a label the composer just wrote.
 *
 * A pin is the answer to "which revision was on screen when this was picked",
 * and it is kept until the message is sent. It is *not* authority: the host
 * re-reads every mention at send time and re-pins it when the digest differs.
 */
export function pinWorkMention(label: string, ref: ProjectWorkRef): void {
  pins.delete(label);
  pins.set(label, ref);
  while (pins.size > PIN_MAX) {
    const oldest = pins.keys().next().value;
    if (oldest === undefined) break;
    pins.delete(oldest);
  }
}

export function pinnedWorkMentions(): ReadonlyMap<string, ProjectWorkRef> {
  return pins;
}

/** Test seam, and what a reset environment does to identities it can no longer trust. */
export function clearWorkMentionPins(): void {
  pins.clear();
}

/**
 * The label this insertion should use: the key, unless this draft already
 * names that key at a different revision — then `TASK-44#2`, so both survive.
 */
export function nextWorkMentionLabel(text: string, ref: ProjectWorkRef): string {
  const taken = new Set(projectWorkMentionSpans(text).map((span) => span.label));
  for (let occurrence = 1; occurrence <= 20; occurrence += 1) {
    const label = projectWorkMentionLabel(ref.key, occurrence);
    const pinned = pins.get(label);
    if (!taken.has(label) || (pinned && pinned.revisionId === ref.revisionId)) return label;
  }
  return ref.key;
}

/** `@TASK-44 "Rework the picker"` — the text a pick writes into the draft. */
export function workMentionToken(ref: ProjectWorkRef, label: string): string {
  const token = projectWorkMentionToken(ref, 1);
  return label === ref.key ? token : token.replace(`@${ref.key}`, `@${label}`);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** What the send path can look a hand-typed key up in: this window's caches. */
export interface MentionResolver {
  /** The ref for a key in the project this message is being sent from. */
  byKey(key: string): ProjectWorkRef | undefined;
}

/**
 * The message as it goes out: the prose the person wrote, plus the identity of
 * everything it mentions (M21-T9).
 *
 * Two sources, in order. A **pin** is what the picker recorded, so a mention
 * picked from another project keeps that project's identity. A key somebody
 * simply typed is resolved against the project they are writing in, at the
 * revision this window has read — which is what `@TASK-44` means when nobody
 * opened a picker. A key neither can answer stays plain text, because a
 * mention nobody can resolve is a sentence, not a broken chip.
 */
export function expandWorkMentions(text: string, resolver?: MentionResolver): string {
  const wanted = new Map<string, ProjectWorkRef>();
  for (const span of projectWorkMentionSpans(text)) {
    if (span.ref) continue;
    const pinned = pins.get(span.label);
    if (pinned && pinned.key === span.key) {
      wanted.set(span.label, pinned);
      continue;
    }
    const resolved = resolver?.byKey(span.key);
    if (resolved) wanted.set(span.label, resolved);
  }
  return withProjectWorkMentions(text, wanted);
}

// ---------------------------------------------------------------------------
// Reading the projects
// ---------------------------------------------------------------------------

/** One project the `@` picker may look in: where it is, and what it is called. */
export interface MentionProjectSource {
  cwd: string;
  name: string;
}

/** How many other projects one query reads. The current one is always read. */
export const MENTION_PROJECT_LIMIT = 6;
const MENTION_DEBOUNCE_MS = 160;

export interface WorkMentionResults {
  candidates: WorkMentionCandidate[];
  /** True while the host is answering. The rows already found stay readable. */
  loading: boolean;
  /** The first refusal, in the host's own words, or nothing. */
  error: string | undefined;
}

const IDLE: WorkMentionResults = { candidates: [], loading: false, error: undefined };

/**
 * The project work the typed `@…` finds (M21-T9).
 *
 * The current project is read first and always; the other projects this device
 * knows are read through **their own** `project/work/search`, because a key is
 * only unique inside one project and nothing here merges two projects' stores.
 * Rows from this window's cache appear immediately — a key it already holds
 * does not wait for a round trip — and the host's answer joins them.
 */
export function useWorkMentions(
  query: string,
  open: boolean,
  options: { currentCwd: string | undefined; projects: readonly MentionProjectSource[]; freeText?: boolean },
): WorkMentionResults {
  const [results, setResults] = useState<WorkMentionResults>(IDLE);
  const freeText = options.freeText === true;
  const parsed = open ? parseWorkMentionQuery(query, { freeText }) : undefined;
  const text = parsed?.text ?? "";
  const kinds = parsed?.kinds.join(",") ?? "";
  const currentCwd = options.currentCwd;
  // A stable dependency: the list identity changes on every render otherwise.
  const elsewhere = options.projects
    .map((project) => project.cwd)
    .filter((cwd) => cwd !== currentCwd)
    .slice(0, MENTION_PROJECT_LIMIT)
    .join("\u0000");
  const names = options.projects.map((project) => `${project.cwd}\u0000${project.name}`).join("\u001f");

  useEffect(() => {
    if (!parsed || (text === "" && parsed.kinds.length === 0)) {
      setResults(IDLE);
      return undefined;
    }
    let live = true;
    setResults((current) => ({ ...current, loading: true }));
    const nameOf = new Map(names.split("\u001f").filter(Boolean).map((entry) => entry.split("\u0000") as [string, string]));
    const paths = [...(currentCwd ? [currentCwd] : []), ...elsewhere.split("\u0000").filter(Boolean)];
    const timer = setTimeout(() => {
      void (async () => {
        const found: WorkMentionCandidate[] = [];
        let error: string | undefined;
        for (const cwd of paths) {
          const store = await resolveProjectWork(cwd);
          if (!live) return;
          if (!store) continue;
          const project: MentionProject = {
            projectId: store.getSnapshot().projectId ?? cwd,
            name: nameOf.get(cwd) ?? cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd,
            current: cwd === currentCwd,
          };
          found.push(...cachedCandidates(store, { ...parsed, text }, project));
          const outcome = await store.search(text === "" ? parsed.kinds.map((kind) => KIND_LABEL[kind]).join(" ") : text, {
            ...(parsed.kinds.length > 0 ? { kinds: parsed.kinds } : {}),
            limit: 10,
          });
          if (!live) return;
          if (outcome.ok) {
            for (const result of outcome.value.results) {
              if (parsed.kinds.length > 0 && !parsed.kinds.includes(result.kind)) continue;
              found.push(candidateOfSearchResult(result, project));
            }
          } else if (!error) error = outcome.failure.message;
        }
        if (!live) return;
        setResults({ candidates: rankWorkMentions(found), loading: false, ...(error ? { error } : { error: undefined }) });
      })();
    }, MENTION_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query is carried by `text`/`kinds`; `parsed` is derived from them
  }, [text, kinds, currentCwd, elsewhere, names, freeText]);

  return results;
}

/** The rows this window already holds: matched on what a row carries, its key and its title. */
function cachedCandidates(store: ProjectWorkStore, query: WorkMentionQuery, project: MentionProject): WorkMentionCandidate[] {
  const needle = query.text.toLocaleLowerCase();
  return store
    .getSnapshot()
    .items.filter((item) => {
      if (query.kinds.length > 0 && !query.kinds.includes(item.kind)) return false;
      if (item.archived) return false;
      if (needle === "") return true;
      return item.key.toLocaleLowerCase().startsWith(needle) || item.title.toLocaleLowerCase().includes(needle);
    })
    .slice(0, 20)
    .map((item) => candidateOfListItem(item, project, query.key));
}

// ---------------------------------------------------------------------------
// The sessions sidebar's TASK chip
// ---------------------------------------------------------------------------

/** A conversation that is an attempt at a Task, and the Task it is attempting. */
export interface SessionTaskLink {
  key: string;
  target: WorkLinkTarget;
  entityId: string;
  attempt: number;
}

/** How many Tasks one project reads execution links for. Bounded on purpose. */
const TASK_LINK_SCAN_MAX = 30;

interface TaskLinkCache {
  seq: number;
  reading: boolean;
  links: Map<string, SessionTaskLink>;
}

const taskLinks = new Map<string, TaskLinkCache>();
const taskLinkListeners = new Set<() => void>();
let taskLinkGeneration = 0;

const publishTaskLinks = (): void => {
  taskLinkGeneration += 1;
  for (const listener of [...taskLinkListeners]) listener();
};

/** Test seam, and what a different host does to links it can no longer trust. */
export function clearSessionTaskLinks(): void {
  taskLinks.clear();
  publishTaskLinks();
}

/**
 * Which conversation is an attempt at which Task, for one project (M21-T9).
 *
 * A backlog row says *how many* execution links a Task has, never which; the
 * links themselves live on the entity. So the Tasks that have any are read
 * once per project sequence — a bounded number of them — and the answer is
 * shared by every row that asks, rather than read per row. A project whose
 * work this window has not read yet simply has no chips; nothing blocks, and
 * nothing is guessed from a title.
 */
function readTaskLinks(store: ProjectWorkStore): void {
  const snapshot = store.getSnapshot();
  const projectId = snapshot.projectId;
  if (!projectId || snapshot.phase !== "ready") return;
  const cached = taskLinks.get(projectId);
  if (cached && (cached.reading || cached.seq === snapshot.seq)) return;
  const entry: TaskLinkCache = { seq: snapshot.seq, reading: true, links: cached?.links ?? new Map() };
  taskLinks.set(projectId, entry);
  const tasks = snapshot.items
    .filter((item) => item.kind === "task" && item.linkCounts.execution > 0)
    .slice(0, TASK_LINK_SCAN_MAX);
  void (async () => {
    const links = new Map<string, SessionTaskLink>();
    for (const task of tasks) {
      const outcome = await store.get({ entityId: task.ref.entityId, body: { mode: "none" }, include: { links: true, comments: false, approvals: false, evidence: false } });
      if (!outcome.ok) continue;
      for (const link of outcome.value.executionLinks) {
        if (link.kind !== "session") continue;
        const existing = links.get(link.targetId);
        // The newest attempt wins: a session reused for a second attempt is
        // still one row, and it names what it is doing now.
        if (existing && existing.attempt >= link.attempt) continue;
        links.set(link.targetId, {
          key: task.key,
          entityId: task.ref.entityId,
          attempt: link.attempt,
          target: { projectId, kind: "task", entityId: task.ref.entityId, revisionId: task.ref.revisionId },
        });
      }
    }
    taskLinks.set(projectId, { seq: entry.seq, reading: false, links });
    publishTaskLinks();
  })();
}

/**
 * The Task this conversation is an attempt at, if it is one.
 *
 * Read from the project the session belongs to, by the session's own opaque
 * id — never by its path, which moves, and never by its title, which is
 * whatever somebody called it.
 */
export function useSessionTaskLink(sessionId: string | undefined, store: ProjectWorkStore | undefined): SessionTaskLink | undefined {
  const generation = useSyncExternalStore(subscribeTaskLinks, () => taskLinkGeneration, () => taskLinkGeneration);
  const snapshot = store?.getSnapshot();
  useEffect(() => {
    if (store) readTaskLinks(store);
  }, [store, snapshot?.seq, snapshot?.phase, generation]);
  const projectId = snapshot?.projectId;
  if (!sessionId || !projectId) return undefined;
  return taskLinks.get(projectId)?.links.get(sessionId);
}

function subscribeTaskLinks(listener: () => void): () => void {
  taskLinkListeners.add(listener);
  return () => {
    taskLinkListeners.delete(listener);
  };
}
