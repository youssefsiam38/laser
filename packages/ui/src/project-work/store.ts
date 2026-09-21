/**
 * One project's work, in this window (M21-T5).
 *
 * The host is the authority (D-331): this is a cache with three jobs, and no
 * opinions beyond them.
 *
 * 1. **Read one project, by its stable id.** The first read may name a
 *    directory (`project/work/list { cwd }`) because a session knows where it
 *    is before it knows what the project is called; every read after that
 *    names the id the host answered with. Nothing is ever stored under a path,
 *    so a relocated project, a worktree and its owner cannot alias.
 * 2. **Apply events in sequence order.** `project/work/updated` carries a
 *    project sequence number. An event at or below what we have is a replay
 *    and is dropped; the next one in line is applied; a gap means we missed
 *    something, so the cache is marked behind and reconciled rather than
 *    guessed at.
 * 3. **Reconcile instead of reloading.** `project/work/list { sinceSeq }`
 *    returns only what changed, plus `removed[]`, plus `reset: true` when the
 *    host's event window has moved past us — the one case where the cache is
 *    replaced instead of merged. A reconnect reconciles; it never empties the
 *    screen first.
 *
 * Mutations go through here too, so the optimistic-concurrency fence and the
 * idempotency key are minted in one place and a conflict or a quota refusal
 * arrives at the surfaces as one typed, person-readable answer.
 */
import {
  ErrorCodes,
  PROJECT_WORK_LIST_LIMIT_MAX,
  type ClientMethod,
  type ClientRequests,
  type ProjectWorkAttentionNotification,
  type ProjectWorkChange,
  type ProjectWorkCounts,
  type ProjectWorkKind,
  type ProjectWorkListItem,
  type ProjectWorkListParams,
  type ProjectWorkOrigin,
  type ProjectWorkQuotaRefusal,
  type ProjectWorkRef,
  type ProjectWorkUpdatedNotification,
} from "@lasercode/protocol";

import { byRecency } from "./model.js";

/** The project-work half of the client method table. */
export type ProjectWorkMethod = Extract<ClientMethod, `project/work/${string}` | `project/task/${string}`>;

/** What the store needs from a connection. `HostClient.request` satisfies it. */
export interface ProjectWorkRequest {
  <M extends ProjectWorkMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]>;
}

/** How many pages one read follows before it reports the rest as unread. */
const MAX_PAGES = 10;
/** How many changes the Recent feed keeps in this window. */
const RECENT_MAX = 200;

export type ProjectWorkPhase = "idle" | "loading" | "ready" | "unavailable";

export interface ProjectWorkAttention {
  /** Exact, even when `items` was cut: the badge never lies. */
  needsYou: number;
  /** The project sequence the count was last known good at. */
  seq: number;
}

export interface ProjectWorkSnapshot {
  /** The stable id, once the host has answered. Never derived from a path. */
  projectId: string | undefined;
  phase: ProjectWorkPhase;
  /** Why the work could not be read, in one sentence written for a person. */
  error: string | undefined;
  /**
   * The project event sequence the cached **rows** were read at. This is what
   * a reconcile asks from, so nothing an event moved optimistically can hide
   * the read that confirms it.
   */
  seq: number;
  /**
   * The highest event sequence this window has seen, which runs ahead of
   * `seq` between an event and the reconcile that confirms it. Ordering is
   * decided against this: at or below is a replay, one above is in order,
   * anything higher is a gap.
   */
  eventSeq: number;
  items: readonly ProjectWorkListItem[];
  counts: ProjectWorkCounts;
  attention: ProjectWorkAttention;
  /** Changes this window saw live, newest first. Provenance for "Recent". */
  recent: readonly ProjectWorkChange[];
  /** The cache is known to be behind the host: a gap, or a reconnect. */
  behind: boolean;
  /** True while a read is in flight. Never hides what is already on screen. */
  loading: boolean;
  /** Set when the host replaced the cache because its event window moved on. */
  resets: number;
  /** More rows exist than this window read. The backlog says so. */
  more: boolean;
}

const EMPTY_COUNTS: ProjectWorkCounts = {
  total: 0,
  needsAttention: 0,
  byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 },
};

const EMPTY: ProjectWorkSnapshot = {
  projectId: undefined,
  phase: "idle",
  error: undefined,
  seq: 0,
  eventSeq: 0,
  items: [],
  counts: EMPTY_COUNTS,
  attention: { needsYou: 0, seq: 0 },
  recent: [],
  behind: false,
  loading: false,
  resets: 0,
  more: false,
};

// ---------------------------------------------------------------------------
// Failures a person can act on
// ---------------------------------------------------------------------------

export type ProjectWorkFailure =
  | { kind: "conflict"; message: string; current: ProjectWorkRef | undefined }
  | { kind: "quota"; message: string; refusal: ProjectWorkQuotaRefusal | undefined }
  /**
   * Everything else the host refused, with whatever typed detail it attached:
   * `{ refused: "stale_upstream", upstream }` is the one that exists today
   * (M21-T15), and the Task detail decodes it rather than re-reading the graph.
   */
  | { kind: "refused"; message: string; data?: unknown };

export type ProjectWorkOutcome<T> = { ok: true; value: T } | { ok: false; failure: ProjectWorkFailure };

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "Something went wrong reading this project's work.";

/** Decode the host's three shapes (M21-T3) into one thing a surface renders. */
export function describeProjectWorkError(error: unknown): ProjectWorkFailure {
  const code = (error as { code?: unknown } | undefined)?.code;
  const data = (error as { data?: unknown } | undefined)?.data;
  if (code === ErrorCodes.ProjectWorkConflict) {
    const current = (data as { current?: ProjectWorkRef } | undefined)?.current;
    return { kind: "conflict", message: messageOf(error), current };
  }
  if (code === ErrorCodes.ProjectWorkQuota) {
    const refusal = data as ProjectWorkQuotaRefusal | undefined;
    return { kind: "quota", message: messageOf(error), refusal };
  }
  return { kind: "refused", message: messageOf(error), ...(data !== undefined ? { data } : {}) };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** How a new entity is created. The whole input is one field, by design (D-352). */
export interface CreateWorkInput {
  kind: ProjectWorkKind;
  title: string;
  /** The brief, the question or the outcome — whichever this kind's body calls it. */
  text: string;
  sessionId?: string | undefined;
  actorLabel?: string | undefined;
}

export class ProjectWorkStore {
  readonly #request: ProjectWorkRequest;
  readonly #listeners = new Set<() => void>();
  readonly #newKey: () => string;
  #snapshot: ProjectWorkSnapshot = EMPTY;
  /** Directories known to resolve to this project. Lookup only, never identity. */
  readonly #paths = new Set<string>();
  #inflight: Promise<void> | undefined;
  /** Another read was asked for while one was running; run once more after it. */
  #again = false;
  #disposed = false;

  constructor(options: { request: ProjectWorkRequest; projectId?: string; newIdempotencyKey?: () => string }) {
    this.#request = options.request;
    this.#newKey = options.newIdempotencyKey ?? defaultIdempotencyKey;
    if (options.projectId) this.#snapshot = { ...EMPTY, projectId: options.projectId };
  }

  // -- reading ---------------------------------------------------------------

  getSnapshot = (): ProjectWorkSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every directory this project has been seen at. Debugging and relocation. */
  paths(): readonly string[] {
    return [...this.#paths];
  }

  knowsPath(cwd: string): boolean {
    return this.#paths.has(cwd);
  }

  rememberPath(cwd: string): void {
    this.#paths.add(cwd);
  }

  /**
   * Read this project for the first time, or return what is already here.
   *
   * `cwd` is a lookup: the host canonicalises it, maps a worktree to its
   * owner and answers with the stable id. A second directory that resolves to
   * the same id therefore lands on this same cache.
   */
  async open(target: { cwd?: string | undefined } = {}): Promise<void> {
    if (target.cwd) this.#paths.add(target.cwd);
    if (this.#snapshot.phase === "ready" || this.#snapshot.loading) return;
    await this.refresh(target);
  }

  /** Read the whole backlog again. Keeps what is on screen until it lands. */
  async refresh(target: { cwd?: string | undefined } = {}): Promise<void> {
    await this.#read({ mode: "full", ...(target.cwd !== undefined ? { cwd: target.cwd } : {}) });
  }

  /**
   * Catch up: everything that changed after the sequence this cache holds.
   *
   * Called after a reconnect and after a gap in the event stream. With nothing
   * in the cache yet there is nothing to catch up *to*, so it reads in full.
   */
  async reconcile(target: { cwd?: string | undefined } = {}): Promise<void> {
    const mode = this.#snapshot.phase === "ready" && this.#snapshot.projectId ? "since" : "full";
    await this.#read({ mode, ...(target.cwd !== undefined ? { cwd: target.cwd } : {}) });
  }

  // -- live events -----------------------------------------------------------

  /**
   * One host notification. Anything for another project is not ours to apply.
   *
   * In-order events move the cache immediately — a renamed row should not wait
   * for a round trip — and are then confirmed by a reconcile, because an event
   * carries a summary and a row carries counts. A gap applies nothing.
   */
  observe(method: string, params: unknown): void {
    if (method === "project/work/updated") this.#observeUpdated(params as ProjectWorkUpdatedNotification);
    else if (method === "project/work/attention") this.#observeAttention(params as ProjectWorkAttentionNotification);
  }

  #observeUpdated(notification: ProjectWorkUpdatedNotification): void {
    const snapshot = this.#snapshot;
    if (!notification || notification.projectId !== snapshot.projectId) return;
    // A replay, or a second delivery of something already folded in.
    if (notification.seq <= snapshot.eventSeq) return;
    if (snapshot.phase !== "ready") {
      // Nothing to be in order with yet; the first read will carry it.
      this.#patch({ behind: true });
      void this.reconcile();
      return;
    }
    const recent = [notification.change, ...snapshot.recent].slice(0, RECENT_MAX);
    if (notification.seq > snapshot.eventSeq + 1) {
      // A gap. Keep every row, apply nothing from this event, and go and ask.
      this.#patch({ behind: true, recent, eventSeq: notification.seq });
      void this.reconcile();
      return;
    }
    this.#patch({ eventSeq: notification.seq, recent, items: applyChange(snapshot.items, notification.change) });
    // The event says what happened; the row says what the entity now *is*.
    void this.reconcile();
  }

  #observeAttention(notification: ProjectWorkAttentionNotification): void {
    const snapshot = this.#snapshot;
    if (!notification || notification.projectId !== snapshot.projectId) return;
    if (notification.seq < snapshot.attention.seq) return;
    this.#patch({ attention: { needsYou: notification.needsYou, seq: notification.seq } });
  }

  /**
   * The socket came back. The cache is not wrong, it is *old*: keep it on
   * screen, say so, and catch up from the sequence it holds.
   */
  reconnected(target: { cwd?: string | undefined } = {}): void {
    if (this.#snapshot.phase === "idle") return;
    this.#patch({ behind: true });
    void this.reconcile(target);
  }

  // -- writing ---------------------------------------------------------------

  /** Create the first revision of a new entity from one field (D-352). */
  async create(input: CreateWorkInput): Promise<ProjectWorkOutcome<ClientRequests["project/work/create"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    return this.#write("project/work/create", {
      projectId,
      kind: input.kind,
      title: input.title,
      body: firstBody(input.kind, input.text),
      idempotencyKey: this.#newKey(),
      ...origin(input),
    });
  }

  /**
   * A new revision of an entity that already exists.
   *
   * The body is whole, not a patch: a revision is immutable and complete, so
   * the caller sends what the next revision *is* and the fence
   * (`expectedRevisionId`) decides whether it may.
   */
  async revise(
    entity: { entityId: string; expectedRevisionId: string },
    body: ClientRequests["project/work/revise"]["params"]["body"],
    options: { title?: string } = {},
  ): Promise<ProjectWorkOutcome<ClientRequests["project/work/revise"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    return this.#write("project/work/revise", {
      projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.expectedRevisionId,
      body,
      ...(options.title ? { title: options.title } : {}),
      idempotencyKey: this.#newKey(),
    });
  }

  /**
   * Join a Task to the session, run or checkpoint an attempt happens in.
   *
   * The link is made *before* any prompt is sent (leap, "Execution and
   * convergence") and it moves nothing: the Task's state is never changed by
   * it, and an ended attempt writes evidence instead (M21-T15).
   */
  async linkExecution(
    entity: { entityId: string; expectedRevisionId: string },
    execution: ClientRequests["project/task/link-execution"]["params"]["execution"],
  ): Promise<ProjectWorkOutcome<ClientRequests["project/task/link-execution"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    return this.#write("project/task/link-execution", {
      projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.expectedRevisionId,
      execution,
      idempotencyKey: this.#newKey(),
    });
  }

  async archive(entity: { entityId: string; expectedRevisionId: string }, archived: boolean): Promise<ProjectWorkOutcome<ClientRequests["project/work/archive"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    return this.#write("project/work/archive", {
      projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.expectedRevisionId,
      archived,
      idempotencyKey: this.#newKey(),
    });
  }

  /**
   * Delete, in two halves. Without `confirm` the host writes nothing and
   * answers with the orphan preview the typed confirmation shows; with it, the
   * deletion happens. Both are this one call.
   */
  async remove(
    entity: { entityId: string; expectedRevisionId: string },
    options: { confirm?: boolean } = {},
  ): Promise<ProjectWorkOutcome<ClientRequests["project/work/delete"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    return this.#write("project/work/delete", {
      projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.expectedRevisionId,
      ...(options.confirm === true ? { confirm: true as const } : {}),
      idempotencyKey: this.#newKey(),
    });
  }

  async taskAction(
    entity: { entityId: string; expectedRevisionId: string },
    action: ClientRequests["project/task/action"]["params"]["action"],
    options: { note?: string; evidenceId?: string } = {},
  ): Promise<ProjectWorkOutcome<ClientRequests["project/task/action"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    return this.#write("project/task/action", {
      projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.expectedRevisionId,
      action,
      ...(options.note ? { note: options.note } : {}),
      ...(options.evidenceId ? { evidenceId: options.evidenceId } : {}),
      idempotencyKey: this.#newKey(),
    });
  }

  /** One entity at one exact revision. Reads are never cached behind a fence. */
  async get(params: Omit<ClientRequests["project/work/get"]["params"], "projectId">): Promise<ProjectWorkOutcome<ClientRequests["project/work/get"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    try {
      return { ok: true, value: await this.#request("project/work/get", { ...params, projectId }) };
    } catch (error) {
      return { ok: false, failure: describeProjectWorkError(error) };
    }
  }

  async search(query: string, options: { kinds?: ProjectWorkKind[]; limit?: number } = {}): Promise<ProjectWorkOutcome<ClientRequests["project/work/search"]["result"]>> {
    const projectId = this.#snapshot.projectId;
    if (!projectId) return { ok: false, failure: { kind: "refused", message: "This project has not been read yet." } };
    try {
      return {
        ok: true,
        value: await this.#request("project/work/search", {
          projectId,
          query,
          ...(options.kinds ? { kinds: options.kinds } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }),
      };
    } catch (error) {
      return { ok: false, failure: describeProjectWorkError(error) };
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  // -- the one read path -----------------------------------------------------

  async #read(options: { mode: "full" | "since"; cwd?: string }): Promise<void> {
    if (this.#inflight) {
      this.#again = true;
      await this.#inflight;
      return;
    }
    const run = this.#readOnce(options).finally(() => {
      this.#inflight = undefined;
      if (this.#again && !this.#disposed) {
        this.#again = false;
        void this.#read({ mode: "since" });
      }
    });
    this.#inflight = run;
    await run;
  }

  async #readOnce(options: { mode: "full" | "since"; cwd?: string }): Promise<void> {
    const before = this.#snapshot;
    const projectId = before.projectId;
    if (!projectId && !options.cwd && this.#paths.size === 0) {
      this.#patch({ phase: "unavailable", error: "This window does not know which project to read.", loading: false });
      return;
    }
    this.#patch({ loading: true, phase: before.phase === "ready" ? "ready" : "loading", error: undefined });

    const base: ProjectWorkListParams = projectId
      ? { projectId }
      : { cwd: options.cwd ?? [...this.#paths][0]! };

    try {
      const first = await this.#request("project/work/list", {
        ...base,
        includeArchived: true,
        limit: PROJECT_WORK_LIST_LIMIT_MAX,
        ...(options.mode === "since" ? { sinceSeq: before.seq } : {}),
      });
      if (this.#disposed) return;

      const pages = [first];
      let cursor = first.nextCursor;
      for (let page = 1; cursor && page < MAX_PAGES; page += 1) {
        const next = await this.#request("project/work/list", {
          projectId: first.projectId,
          includeArchived: true,
          limit: PROJECT_WORK_LIST_LIMIT_MAX,
          cursor,
          ...(options.mode === "since" && first.reset !== true ? { sinceSeq: before.seq } : {}),
        });
        if (this.#disposed) return;
        pages.push(next);
        cursor = next.nextCursor;
      }

      const incoming = pages.flatMap((page) => page.items);
      const replace = options.mode === "full" || first.reset === true;
      const kept = replace ? [] : this.#snapshot.items;
      const removed = new Set(pages.flatMap((page) => page.removed ?? []));
      const merged = merge(kept, incoming, removed);
      const last = pages[pages.length - 1]!;

      this.#patch({
        projectId: first.projectId,
        phase: "ready",
        error: undefined,
        loading: false,
        behind: false,
        seq: first.seq,
        eventSeq: Math.max(first.seq, this.#snapshot.eventSeq),
        items: merged,
        counts: last.counts,
        // The list's own count is the authority for the badge; a notification
        // only ever moves it forward between reads.
        attention: { needsYou: last.counts.needsAttention, seq: first.seq },
        more: cursor !== undefined,
        ...(first.reset === true ? { resets: this.#snapshot.resets + 1 } : {}),
      });
    } catch (error) {
      if (this.#disposed) return;
      const failure = describeProjectWorkError(error);
      // A read that fails never throws away rows that are already on screen.
      this.#patch({
        loading: false,
        error: failure.message,
        phase: this.#snapshot.phase === "ready" ? "ready" : "unavailable",
        behind: this.#snapshot.phase === "ready",
      });
    }
  }

  async #write<M extends ProjectWorkMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ProjectWorkOutcome<ClientRequests[M]["result"]>> {
    try {
      const value = await this.#request(method, params);
      // Every mutation result carries the project sequence; catching up from
      // it is cheaper and more certain than predicting the row ourselves.
      void this.reconcile();
      return { ok: true, value };
    } catch (error) {
      return { ok: false, failure: describeProjectWorkError(error) };
    }
  }

  #patch(patch: Partial<ProjectWorkSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}

// ---------------------------------------------------------------------------
// Pure folds
// ---------------------------------------------------------------------------

/**
 * Merge a page into the cache: incoming rows win, removed ids go, and the
 * result is ordered the way the backlog reads it.
 */
export function merge(
  kept: readonly ProjectWorkListItem[],
  incoming: readonly ProjectWorkListItem[],
  removed: ReadonlySet<string>,
): ProjectWorkListItem[] {
  const byId = new Map<string, ProjectWorkListItem>();
  for (const item of kept) byId.set(item.ref.entityId, item);
  for (const item of incoming) byId.set(item.ref.entityId, item);
  for (const id of removed) byId.delete(id);
  return [...byId.values()].sort(byRecency);
}

/**
 * What one event says about the rows, before the reconcile confirms it.
 *
 * Only what the event actually carries is applied: a deletion removes the row,
 * and a change to a row we hold moves its title, state and time. A `created`
 * event is *not* turned into a row here — the counts and links a row carries
 * are not in the event, and inventing them is exactly what this file is for
 * not doing. The reconcile one tick later brings the real row.
 */
export function applyChange(items: readonly ProjectWorkListItem[], change: ProjectWorkChange): ProjectWorkListItem[] {
  if (change.change === "deleted") return items.filter((item) => item.ref.entityId !== change.entityId);
  let touched = false;
  const next = items.map((item) => {
    if (item.ref.entityId !== change.entityId) return item;
    touched = true;
    return {
      ...item,
      title: change.title || item.title,
      state: change.state,
      updatedAt: change.at,
      ...(change.revisionId && change.digest
        ? { ref: { ...item.ref, revisionId: change.revisionId, digest: change.digest, label: change.title || item.ref.label } }
        : {}),
    } satisfies ProjectWorkListItem;
  });
  return touched ? next.sort(byRecency) : [...items];
}

// ---------------------------------------------------------------------------
// The first revision of each kind
// ---------------------------------------------------------------------------

/**
 * The body a brand-new entity starts with, from the one field the person
 * typed (`/spec <text>`, the Create dialog).
 *
 * Every other field of the closed body schema starts empty because it *is*
 * empty — nothing is invented to fill a shape, and the editors in M21-T7 and
 * M21-T16 are where the rest is written.
 */
export function firstBody(kind: ProjectWorkKind, text: string): ClientRequests["project/work/create"]["params"]["body"] {
  const brief = text.trim();
  switch (kind) {
    case "spec":
      return { kind, spec: { form: "brief", brief, outcomes: [], nonGoals: [], requirements: [], acceptance: [], constraints: [] } };
    case "research":
      return {
        kind,
        research: {
          question: brief,
          scope: { in: [], out: [], constraints: [] },
          status: "open",
          questions: [{ id: "q1", text: brief, state: "open", findings: [] }],
          findings: [],
          unresolved: [],
          sources: [],
        },
      };
    case "design":
      return { kind, design: { brief, screens: [], flows: [], sketches: [], fidelity: "proposed", fixtures: [] } };
    case "plan":
      return { kind, plan: { brief, phases: [], dependencies: [], boundaries: [], migrations: [], risks: [], verification: [] } };
    case "task":
      return {
        kind,
        task: {
          outcome: brief,
          nonGoals: [],
          dependencies: [],
          scope: { packages: [], repositories: [], paths: [], capabilities: [] },
          acceptance: [],
          verificationCommands: [],
          visualEvidenceRequired: false,
          assignment: { policy: "unassigned" },
        },
      };
  }
}

/**
 * Provenance, and only provenance (D-329): which conversation a revision was
 * written in. The actor's *kind* is decided by the host from the source of the
 * call and never from here, so the label is a display name and nothing more —
 * and it is only sent when there is something to say.
 */
const origin = (input: CreateWorkInput): { origin?: ProjectWorkOrigin } => {
  if (!input.sessionId && !input.actorLabel) return {};
  return {
    origin: {
      actor: { kind: "person", label: input.actorLabel ?? PERSON_LABEL },
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  };
};

/** What a person's own writes are called when the client suggests nothing. */
const PERSON_LABEL = "You";

let counter = 0;
/** Unique per call and legal for the wire (`[A-Za-z0-9_.:-]{1,80}`). */
function defaultIdempotencyKey(): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `ui-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
}
