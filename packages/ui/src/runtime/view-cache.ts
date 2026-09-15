/**
 * The bound on what the renderer keeps of the conversations it has shown (RP-5).
 *
 * Every session the app has opened keeps a **light record** in the store: its
 * identity and environment, its questions, its tray and queue, its title, the
 * durable revision it was last valid at, and the few words its row needs. What
 * a session's *transcript* costs — raw entries, derived blocks, the images they
 * hold and the assistant-ui projection built from them — lives only inside this
 * bounded cache. Outside it, a view is dormant: the record stays, the
 * transcript is released, and the next time a person opens that conversation it
 * is read again from its authoritative host.
 *
 * What is never released:
 *
 * - the session a person is looking at, the Beam bubble, and every scope;
 * - a session with a question, an approval or anything else waiting for them;
 * - a session with work running: a turn, a queue, an agent run, a command;
 * - a session holding words they wrote and nobody else has yet — a composer
 *   draft, an attachment, a message edit, a prompt in flight;
 * - anything canonical. Eviction deletes no history, answers no question,
 *   cancels no work and writes nothing to the host.
 *
 * When the pinned set alone is over budget, nothing is evicted and the counters
 * say so: an honest overflow rather than a released conversation somebody is
 * using.
 *
 * Pure of React. The provider owns one instance and feeds it the store.
 */
import type { Action, AppState, EvictionReason, SessionView } from "../store.js";
import { hasUnsentWork, isDormantView } from "../view-summary.js";
import { captureViewTail, VIEW_TAIL_MAX_BYTES, viewTailRetainedBytes, viewTailSink, type ViewTailDto, type ViewTailSink } from "./view-tail.js";
import { byteLength, EMPTY_MEASURE, measureView, type ViewMeasure } from "./view-measure.js";
import { isTerminalRunStatus, type SessionUpdate } from "@lasercode/protocol";
import { mainPath, pendingSessionPath } from "./main-destination.js";
import { anchoredMessages } from "./anchored-messages.js";

/**
 * The bounds. Calibrated against measured renderer heap, not guessed from
 * serialized size: `docs/resource-view-budget.md` records the run, the fitted
 * model and why these three numbers are what they are.
 */
export interface ViewCacheLimits {
  /** Hydrated transcripts kept beside the pinned ones. */
  views: number;
  /** Total hydrated transcript bytes, exact UTF-8. */
  bytes: number;
  /** One transcript's share. A dormant view over this is released even under the count. */
  viewBytes: number;
}

export const VIEW_CACHE_LIMITS: ViewCacheLimits = Object.freeze({
  views: 6,
  bytes: 4 * 1024 * 1024,
  viewBytes: 1_572_864,
});

/** Why a view is pinned. Reported by `releaseUnder`, so a refusal has words. */
export type PinReason =
  | "current"
  | "destination"
  | "scope"
  | "question"
  | "running"
  | "queued"
  | "agent-run"
  | "task"
  | "unstarted"
  | "loading"
  | "draft"
  | "unsent"
  /** A person's action is holding room in this view (an edit being rebuilt). */
  | "action";

export interface ReleasedView {
  path: string;
  bytes: number;
  reason: EvictionReason;
}

export interface ReleaseOutcome {
  released: readonly ReleasedView[];
  bytesReleased: number;
  /** Candidates that were over budget but held by somebody, and why. */
  refused: readonly { path: string; pin: PinReason }[];
}

const NOTHING_RELEASED: ReleaseOutcome = Object.freeze({ released: Object.freeze([]), bytesReleased: 0, refused: Object.freeze([]) });

/** The renderer's own retained-state counters (RP-3's `rendererViews`). */
export interface RendererViewCounters {
  /** Light records: every session this window has opened. */
  readonly views: number;
  readonly hydrated: number;
  readonly pinned: number;
  readonly dormant: number;
  readonly entriesBytes: number;
  readonly blocksBytes: number;
  readonly imagesBytes: number;
  /** Images charged a declared floor because their size could not be read. */
  readonly imagesEstimated: number;
  /** The budgeted total: what the limits below are compared against. */
  readonly bytes: number;
  /** What that is worth in retained heap, through the calibrated model. */
  readonly heapEquivalentBytes: number;
  /**
   * The largest hydrated view; the largest single block (every body of it
   * together, which is what one message renders); and the largest single body
   * inside any block, which is what one part of a message renders.
   */
  readonly largestViewBytes: number;
  readonly largestBlockBytes: number;
  readonly largestBodyBytes: number;
  /** Canonical bytes the views point at and do not hold (RP-5b). */
  readonly referencedBytes: number;
  /** Decoded image surface those references imply, reported beside the budget. */
  readonly referencedImageBytes: number;
  /** Views whose older settled part was released to stay inside the bound. */
  readonly trims: number;
  /** Threads holding words a person wrote and nobody else has. */
  readonly drafts: number;
  readonly evictions: number;
  /**
   * Records waiting for the next frame, and the exact UTF-8 bytes holding all
   * of them costs — whole records, not only the entries they carry. Bounded
   * (see {@link PENDING_TAIL_MAX_ENTRIES} and {@link PENDING_TAIL_MAX_BYTES}).
   */
  readonly tailsPending: number;
  readonly tailsPendingBytes: number;
  /** Records shed because the queue was full. Best-effort data, said out loud. */
  readonly tailsDropped: number;
  readonly limits: ViewCacheLimits;
  /**
   * A state in passing, never a settled one (RP-5b): a pass has not brought
   * every view inside the bounds yet, and the next one continues. No view ever
   * settles above its bound, so there is no value here that means "allowed to
   * hold more" — the old `pinned`/`drafts` overflow was exactly that, and it
   * is gone.
   */
  readonly overflow?: "transition";
  readonly calibration: { model: string; fittedAt: string };
}

/**
 * The calibrated relation between the serialized bytes measured here and the
 * renderer heap they actually cost, fitted from the RP-2 soak
 * (`docs/resource-view-budget.md`). Published beside every byte number so
 * nobody reads a serialized size as a memory size.
 */
export const VIEW_HEAP_MODEL = Object.freeze({
  /** Heap a light record costs, measured after this fix. */
  lightBytes: 2_500,
  /** Heap one hydrated transcript costs before its content. */
  hydratedBytes: 13_000,
  /** Heap per serialized byte of entries and blocks. */
  contentFactor: 28,
  model: "light + hydrated + 28x content + images (RP-2 full run A)",
  fittedAt: "2026-09-15",
});

/** What the cache needs from the surfaces it cannot see from the store. */
export interface ViewCacheEnvironment {
  /** Sessions a `LaserThreadScope` is showing right now (the Beam bubble). */
  scoped(): Iterable<string>;
  /**
   * This session's composer holds a person's unsent words: non-empty text, an
   * attachment, a tentative first-turn choice, or a message edit in progress.
   * An empty composer is not a draft and pins nothing.
   */
  hasDraft(path: string): boolean;
}

export interface ViewCacheOptions {
  read(): AppState;
  dispatch(action: Action): void;
  environment: ViewCacheEnvironment;
  /**
   * Where a released transcript's bounded tail goes. Omitted — the ordinary
   * case — the process-wide installed sink is read at delivery time, so RP-10
   * can install and remove its cache without this cache knowing.
   */
  sink?: ViewTailSink;
  limits?: ViewCacheLimits;
  now?: () => Date;
  /** Run a maintenance pass later, coalesced. */
  defer?: (run: () => void, delayMs?: number) => (() => void);
  /**
   * Hand a captured tail over after the release has been published and
   * painted. Returns a cancel, so a reset or a disposal drops what it was
   * about to hand over.
   */
  deliver?: (run: () => void) => (() => void);
  /** Called when a transcript is released, so its reads stop being resumed. */
  onRelease?: (paths: readonly string[]) => void;
}

/**
 * The shortest gap between two passes caused by content alone.
 *
 * Growth always schedules a pass — one large tool result is one transaction and
 * must not wait for a second — but a streamed turn produces a transaction per
 * token, and measuring on each of them would cost the transcript per frame. So
 * the first growth since the last pass schedules one, and the ones behind it
 * wait for this gap. A change to what is *pinned* never waits: it schedules
 * immediately, because that is when a view stops being held.
 */
const GROWTH_PASS_INTERVAL_MS = 250;

const defaultDefer = (run: () => void, delayMs = 0): (() => void) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Hand the tail over after the frame that shows the release.
 *
 * A frame callback plus a task is the real post-paint point on a visible page;
 * a hidden or throttled page never paints, so a bounded timer runs it anyway
 * rather than letting captured records pile up behind a frame that will not
 * come. Whichever arrives first runs, exactly once.
 */
const defaultDeliver = (run: () => void): (() => void) => {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    if (frame !== undefined) cancelAnimationFrame(frame);
    run();
  };
  const fallback = setTimeout(once, DELIVERY_FALLBACK_MS);
  const frame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => { setTimeout(once, 0); })
    : undefined;
  return () => {
    done = true;
    clearTimeout(fallback);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
};

/** How long a page that never paints may hold a captured record. */
export const DELIVERY_FALLBACK_MS = 250;

/**
 * Records that may wait for the next frame at once, and their bytes.
 *
 * A hydrate/evict loop can release faster than a page paints, and a tail is a
 * hint a cache may keep, not something anybody is waiting for. So the queue is
 * bounded on both axes and sheds its oldest records rather than growing: eight
 * full tails' worth of bytes, thirty-two records, counted when they go.
 *
 * The byte bound is measured over the *whole* retained record
 * ({@link viewTailRetainedBytes}), not the content bytes RP-10 reads, so the
 * ceiling is the memory this queue actually holds.
 */
export const PENDING_TAIL_MAX_ENTRIES = 32;
export const PENDING_TAIL_MAX_BYTES = 8 * VIEW_TAIL_MAX_BYTES;

export interface ViewCache {
  /**
   * Fold one store transaction. Directed by the action, not by a scan: it
   * touches the path the action names and the pin sources the action moved,
   * and a streamed delta adds its own bytes without measuring anything.
   */
  observeTransaction(action: Action, before: AppState, after: AppState): void;
  /** A person opened, selected or read this session. */
  touch(path: string): void;
  /** Bring the cache inside its bounds now. */
  maintain(): ReleaseOutcome;
  /** RP-8: release under memory pressure. Never a pinned view, never work. */
  releaseUnder(pressure: "warning" | "critical"): ReleaseOutcome;
  counters(): RendererViewCounters;
  /**
   * Hold room for something a person is about to do (RP-5b §2).
   *
   * Rebuilding an oversized prompt so it can be edited puts its whole body in
   * the renderer, and that has to fit — beside this view's own bound and
   * beside every other view's. The room is taken **before** the body is read,
   * counted while it is held, released when the action ends, and never quietly
   * exceeded: a token that no longer belongs to this cache's generation gives
   * its bytes back to nobody.
   *
   * Dormant views are released first, so an action is refused only when the
   * room really is not there.
   */
  reserveAction(path: string, bytes: number): ActionReservation | undefined;
  /** Measurement of one view, for tests and counters. */
  measure(path: string): ViewMeasure;
  /**
   * Something outside the store changed what is held: a composer draft was
   * written or cleared, a scope took or let go of a session. Neither moves the
   * reducer, so neither can be observed — they are said here.
   */
  notifyPins(): void;
  /**
   * A new environment: recency, counters and any captured tail that has not
   * been handed over belong to the one this device just left (RP-13).
   */
  reset(): void;
  dispose(): void;
}

/** Room held for one action in flight. */
export interface ActionReservation {
  readonly path: string;
  readonly bytes: number;
  /** Grow or shrink what is held; false when the larger size does not fit. */
  resize(bytes: number): boolean;
  /** Give it back. Safe to call more than once, and after a reset. */
  release(): void;
}

/** What this cache keeps about one path, so a pass never walks the others. */
interface Owned {
  /** The measure as of the last full measurement of this path. */
  measure: ViewMeasure;
  /** Exact UTF-8 bytes appended since then by deltas alone. */
  appended: number;
  /** The next pass must measure this path again. */
  dirty: boolean;
  hydrated: boolean;
}

/**
 * The sessions live work is happening in, built once per pass rather than by
 * looping the two registries for every view that might be held.
 */
export interface LiveWork {
  runs: ReadonlySet<string>;
  tasks: ReadonlySet<string>;
}

export function liveWorkOf(state: AppState): LiveWork {
  const runs = new Set<string>();
  const tasks = new Set<string>();
  for (const run of Object.values(state.agents.runs)) if (!isTerminalRunStatus(run.status)) runs.add(run.sessionPath);
  for (const task of Object.values(state.tasks.tasks)) if (task.status === "running") tasks.add(task.sessionPath);
  return { runs, tasks };
}

/**
 * Which pin holds this view, or `undefined` when nothing does. Reads scalars
 * and, for live work, a set the caller built once; it never walks a transcript.
 */
export function pinReason(state: AppState, path: string, environment: ViewCacheEnvironment, live?: LiveWork): PinReason | undefined {
  const view = state.open[path];
  if (state.current === path) return "current";
  // The destination a switch is moving to is pinned from the moment it is
  // chosen, before anything fetches or paints it.
  if (mainPath(state.destination) === path || pendingSessionPath(state.destination) === path) return "destination";
  for (const scoped of environment.scoped()) if (scoped === path) return "scope";
  if (environment.hasDraft(path)) return "draft";
  if (state.sessionLoads[path]?.phase === "opening") return "loading";
  if (view === undefined) return undefined;
  if (view.dialogs.length > 0) return "question";
  if (view.running || view.state.isStreaming || view.state.isCompacting) return "running";
  if (view.pending.length > 0 || view.queue.steering.length > 0 || view.queue.followUp.length > 0) return "queued";
  if (view.historyPending !== undefined) return "loading";
  // A session nobody has written to yet costs nothing and is what the landing
  // thread, session reuse and the "New session" row are built on.
  if (view.state.messageCount === 0 && view.state.pendingMessageCount === 0) return "unstarted";
  const work = live ?? liveWorkOf(state);
  if (work.runs.has(path)) return "agent-run";
  if (work.tasks.has(path)) return "task";
  return undefined;
}

export function createViewCache(options: ViewCacheOptions): ViewCache {
  const limits = options.limits ?? VIEW_CACHE_LIMITS;
  const now = options.now ?? (() => new Date());
  const defer = options.defer ?? defaultDefer;
  const deliver = options.deliver ?? defaultDeliver;
  const sink = options.sink;

  const used = new Map<string, number>();
  /** What this cache knows about each path, kept up to date by the actions. */
  const owned = new Map<string, Owned>();
  /** Room held for actions in flight, by token (RP-5b §2). */
  const reservations = new Map<symbol, { path: string; bytes: number }>();
  let reservedBytes = 0;
  /** Bumped by `reset`/`dispose`: tokens from before belong to nobody. */
  let actionGeneration = 0;

  /** Counted here so nothing has to add up the paths to answer `counters()`. */
  const totals = { entriesBytes: 0, blocksBytes: 0, imagesBytes: 0, imagesEstimated: 0, bytes: 0, hydrated: 0 };
  /**
   * Records waiting for the next frame, newest per session and keyed by that
   * session's identity, oldest first, each with what holding the whole record
   * costs — not only its content bytes.
   */
  const pending = new Map<string, { tail: ViewTailDto; retained: number }>();
  let pendingBytes = 0;
  let tailsDropped = 0;
  let cancelDelivery: (() => void) | undefined;
  let clock = 0;
  let cancelPass: (() => void) | undefined;
  /** The frozen answer `counters()` gives until one of its numbers moves. */
  let snapshot: RendererViewCounters | undefined;
  let passAt = 0;
  let evictions = 0;
  let trims = 0;
  let overflow: RendererViewCounters["overflow"];
  let disposed = false;
  /** Everything captured in one environment; a reset abandons that generation. */
  let generation = 0;

  /**
   * Run a pass. `urgency: "pins"` is something that stopped holding a view and
   * never waits; `"growth"` is content, and waits out the gap that keeps a
   * streamed turn from measuring itself on every frame.
   */
  const schedule = (urgency: "pins" | "growth"): void => {
    if (disposed) return;
    const wait = urgency === "pins" ? 0 : Math.max(0, passAt + GROWTH_PASS_INTERVAL_MS - Date.now());
    if (cancelPass) {
      // A pin change overtakes a pass that was waiting out the content gap.
      if (urgency !== "pins" || wait > 0) return;
      cancelPass();
    }
    cancelPass = defer(() => {
      cancelPass = undefined;
      maintain();
    }, wait);
  };

  const holdsTranscript = (view: SessionView): boolean =>
    view.dormant === undefined && (view.hydrated || view.blocks.length > 0 || view.entries.length > 0);

  const add = (measure: ViewMeasure, sign: 1 | -1, appended = 0): void => {
    totals.entriesBytes += sign * measure.entriesBytes;
    totals.blocksBytes += sign * (measure.blocksBytes + appended);
    totals.imagesBytes += sign * measure.imagesBytes;
    totals.imagesEstimated += sign * measure.imagesEstimated;
    totals.bytes += sign * (measure.bytes + appended);
    snapshot = undefined;
  };

  /** Stop keeping anything about this path. */
  const forget = (path: string): void => {
    const row = owned.get(path);
    if (!row) return;
    add(row.measure, -1, row.appended);
    if (row.hydrated) totals.hydrated -= 1;
    owned.delete(path);
    snapshot = undefined;
  };

  /** Measure one path now, and only that one. */
  const remeasure = (state: AppState, path: string): void => {
    const view = state.open[path];
    if (!view || !holdsTranscript(view)) {
      forget(path);
      return;
    }
    const row = owned.get(path);
    if (row) add(row.measure, -1, row.appended);
    const measure = measureView(view);
    const hydrated = view.hydrated;
    if (row) {
      if (row.hydrated !== hydrated) totals.hydrated += hydrated ? 1 : -1;
      row.measure = measure; row.appended = 0; row.dirty = false; row.hydrated = hydrated;
    } else {
      owned.set(path, { measure, appended: 0, dirty: false, hydrated });
      if (hydrated) totals.hydrated += 1;
    }
    add(measure, 1);
  };

  /** What this path costs right now, without measuring it again. */
  const known = (path: string): { bytes: number; measure: ViewMeasure; appended: number } | undefined => {
    const row = owned.get(path);
    return row ? { bytes: row.measure.bytes + row.appended, measure: row.measure, appended: row.appended } : undefined;
  };

  /** Bring every path the actions marked back to a measured truth. */
  const settle = (state: AppState): void => {
    for (const [path, row] of [...owned]) if (row.dirty) remeasure(state, path);
  };

  const measureOf = (view: SessionView): ViewMeasure =>
    holdsTranscript(view) ? measureView(view) : EMPTY_MEASURE;

  const release = (candidates: readonly { path: string; bytes: number; reason: EvictionReason }[]): ReleaseOutcome => {
    if (candidates.length === 0) return NOTHING_RELEASED;
    const state = options.read();
    const at = now().toISOString();
    // Only what the store will actually release. The reducer refuses a view
    // that is already dormant, holds an unsent prompt, or has nothing to give
    // up; reporting one of those as released would be a lie, and handing over
    // its tail would cache a transcript that is still on screen.
    const paths = candidates.filter(({ path }) => {
      const view = state.open[path];
      return view !== undefined && !isDormantView(view) && !hasUnsentWork(view)
        && (view.hydrated || view.blocks.length > 0 || view.entries.length > 0);
    });
    if (paths.length === 0) return NOTHING_RELEASED;
    // Captured before the release, from bytes that are still here; the record
    // shares nothing with the view it was taken from.
    const tails: ViewTailDto[] = [];
    for (const { path } of paths) {
      const view = state.open[path];
      if (view) tails.push(captureViewTail(view, at));
    }
    const released = paths.map(({ path }) => path);
    // Each record says why it was released, so a mixed pass does not stamp one
    // reason on views that were let go of for another.
    for (const reason of new Set(paths.map((row) => row.reason))) {
      const group = paths.filter((row) => row.reason === reason).map((row) => row.path);
      options.dispatch({ type: "views/evict", paths: group, reason, at });
    }
    // The dispatch above already told this cache to forget them; recency goes
    // with them, so a conversation opened again starts as newly used.
    for (const path of released) used.delete(path);
    evictions += released.length;
    snapshot = undefined;
    options.onRelease?.(released);
    // Into the one queue waiting for the next frame, never a timer and a
    // closure per release: a fast hydrate/evict loop must not turn best-effort
    // cache data into unbounded memory of its own.
    for (const tail of tails) enqueueTail(tail);
    scheduleDelivery();
    return {
      released: paths.map(({ path, bytes, reason }) => ({ path, bytes, reason })),
      bytesReleased: paths.reduce((sum, row) => sum + row.bytes, 0),
      refused: [],
    };
  };

  /**
   * Take one record into the queue, newest per session, inside hard bounds.
   *
   * This is a cache hint and nothing depends on it, so when it is full the
   * oldest records go, deterministically, and are counted. A record for a
   * session already waiting replaces it: two tails of one conversation are
   * the same conversation, and only the later one is true.
   */
  const enqueueTail = (tail: ViewTailDto): void => {
    // A conversation is its session, not the file it happens to live at: a
    // move or a rename changes the path and keeps the identity, and two
    // records for one session are the same record (RP-10 §3.2). A record
    // with no identity is refused outright rather than keyed by its path.
    if (tail.omitted !== undefined || tail.sessionId === "" || tail.environmentKey === "") {
      tailsDropped += 1;
      snapshot = undefined;
      return;
    }
    const key = `${tail.environmentKey}\u0000${tail.sessionId}`;
    // The whole record, not only the entries in it: the bound is on memory
    // this queue holds, and identity, cursors and structure are memory too.
    const cost = viewTailRetainedBytes(tail);
    const existing = pending.get(key);
    if (existing) pendingBytes -= existing.retained;
    pending.delete(key);
    // A single record larger than the whole queue is refused outright rather
    // than emptying the queue for itself.
    if (cost > PENDING_TAIL_MAX_BYTES) {
      tailsDropped += 1;
      snapshot = undefined;
      return;
    }
    pending.set(key, { tail, retained: cost });
    pendingBytes += cost;
    snapshot = undefined;
    while (pending.size > PENDING_TAIL_MAX_ENTRIES || pendingBytes > PENDING_TAIL_MAX_BYTES) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      const dropped = pending.get(oldest.value)!;
      pending.delete(oldest.value);
      pendingBytes -= dropped.retained;
      tailsDropped += 1;
    }
  };

  /** One scheduler for the whole queue, whatever it holds. */
  const scheduleDelivery = (): void => {
    if (disposed || cancelDelivery || pending.size === 0) return;
    const captured = generation;
    cancelDelivery = deliver(() => {
      cancelDelivery = undefined;
      const waiting = [...pending.values()].map((row) => row.tail);
      pending.clear();
      pendingBytes = 0;
      snapshot = undefined;
      if (disposed || captured !== generation) return;
      // Read now, not when the release was decided: a cache installed in the
      // meantime receives these tails, and one that has gone never does.
      const target = sink ?? viewTailSink();
      for (const tail of waiting) {
        try {
          target.release(tail);
        } catch {
          // A cache that cannot take a tail changes nothing here: the memory
          // is already released and the conversation is read from its host.
        }
      }
    });
  };

  const clearPending = (): void => {
    cancelDelivery?.();
    cancelDelivery = undefined;
    pending.clear();
    pendingBytes = 0;
  };

  /** Bytes held for actions on one path. */
  const heldForAction = (path: string): number => {
    let bytes = 0;
    for (const row of reservations.values()) if (row.path === path) bytes += row.bytes;
    return bytes;
  };

  /** Everything the pass needs, from what is already measured. */
  const survey = (state: AppState) => {
    settle(state);
    const live = liveWorkOf(state);
    const held: Array<{ path: string; bytes: number; measure: ViewMeasure; appended: number; pin: PinReason | undefined }> = [];
    let bytes = 0;
    let pinnedBytes = 0;
    let drafts = 0;
    for (const [path, row] of owned) {
      const view = state.open[path];
      if (!view) continue;
      // A prompt this surface sent and the engine has not persisted is the
      // person's words; nothing else holds them.
      const unsent = view.blocks.some((block) => block.kind === "user" && block.optimistic === true);
      // A view holding room for an action a person started is never a
      // candidate, and never trimmed out from under the draft it is building.
      const acting = heldForAction(path);
      const pin = acting ? ("action" as const) : unsent ? ("unsent" as const) : pinReason(state, path, options.environment, live);
      const cost = row.measure.bytes + row.appended + acting;
      held.push({ path, bytes: cost, measure: row.measure, appended: row.appended, pin });
      bytes += cost;
      if (pin) pinnedBytes += cost;
    }
    for (const path of Object.keys(state.open)) if (options.environment.hasDraft(path)) drafts += 1;
    // Room held for an action on a view this cache has not measured yet is
    // still room held: it is counted, or a reservation would be free.
    for (const row of reservations.values()) {
      if (!owned.has(row.path)) bytes += row.bytes;
    }
    return { held, bytes, pinnedBytes, drafts };
  };

  const plan = (state: AppState, effective: ViewCacheLimits): { paths: Array<{ path: string; bytes: number; reason: EvictionReason }>; trims: Map<string, number>; refused: Array<{ path: string; pin: PinReason }>; overflow: RendererViewCounters["overflow"] } => {
    const { held, bytes, pinnedBytes, drafts } = survey(state);
    // RP-5b: the per-view bound is a bound, not a trigger. Every hydrated view
    // over it — pinned, current, running, holding a draft — releases its older
    // settled turns. Nothing is evicted for it and no work is touched.
    const trims = new Map<string, number>();
    for (const row of held) if (row.bytes > effective.viewBytes) trims.set(row.path, effective.viewBytes);
    const candidates = held
      .filter((row) => row.pin === undefined)
      .sort((a, b) => (used.get(a.path) ?? 0) - (used.get(b.path) ?? 0));
    const chosen: Array<{ path: string; bytes: number; reason: EvictionReason }> = [];
    const taken = new Set<string>();
    let total = bytes;
    // The count bound is on the cache, not on the conversations a person is
    // using: six transcripts beside whatever is pinned (approved plan §6.1).
    let count = candidates.length;

    // One transcript over its own share goes first, whatever the count says —
    // and so does one holding an image whose decoded size could not be read.
    // A few encoded kilobytes can be an enormous surface once decoded, and a
    // number nobody could measure must not buy a conversation a place here.
    for (const row of candidates) {
      if (row.bytes <= effective.viewBytes && row.measure.imagesEstimated === 0) continue;
      chosen.push({ path: row.path, bytes: row.bytes, reason: "bytes" });
      taken.add(row.path);
      total -= row.bytes;
      count -= 1;
    }
    for (const row of candidates) {
      if (count <= effective.views) break;
      if (taken.has(row.path)) continue;
      chosen.push({ path: row.path, bytes: row.bytes, reason: "count" });
      taken.add(row.path);
      total -= row.bytes;
      count -= 1;
    }
    for (const row of candidates) {
      if (total <= effective.bytes) break;
      if (taken.has(row.path)) continue;
      chosen.push({ path: row.path, bytes: row.bytes, reason: "bytes" });
      taken.add(row.path);
      total -= row.bytes;
      count -= 1;
    }

    // The total binds every view too, pinned or not. What eviction cannot
    // reach — a conversation somebody is using — is brought inside it by
    // releasing its older settled turns, largest first.
    let projected = 0;
    for (const row of held) if (!taken.has(row.path)) projected += Math.min(row.bytes, trims.get(row.path) ?? row.bytes);
    if (projected > effective.bytes) {
      for (const row of [...held].sort((a, b) => b.bytes - a.bytes)) {
        if (projected <= effective.bytes) break;
        if (taken.has(row.path)) continue;
        const current = Math.min(row.bytes, trims.get(row.path) ?? row.bytes);
        const target = Math.max(0, current - (projected - effective.bytes));
        trims.set(row.path, target);
        projected -= current - target;
      }
    }
    for (const path of taken) trims.delete(path);

    // The total and the per-view share still count everything hydrated,
    // pinned or not: they are about memory, not about the cache's own slots.
    const over = total > effective.bytes || count > effective.views || trims.size > 0;
    const refused = over
      ? held.filter((row) => row.pin !== undefined).map((row) => ({ path: row.path, pin: row.pin! }))
      : [];
    // Being over is a state in passing: this pass releases and trims, and the
    // next one measures what it left. `drafts`/`pinnedBytes` are still surveyed
    // for the counters, never as permission to stay over.
    void drafts; void pinnedBytes;
    return {
      paths: chosen,
      trims,
      refused,
      overflow: over ? "transition" : undefined,
    };
  };

  function maintain(): ReleaseOutcome {
    if (disposed) return NOTHING_RELEASED;
    passAt = Date.now();
    const state = options.read();
    const { paths, trims: overSized, refused, overflow: over } = plan(state, limits);
    const outcome = release(paths);
    // Views the release did not let go of are brought inside the per-view
    // bound in the same pass, so nothing settles above it.
    const trimmed = trim(overSized);
    if (trimmed) {
      const after = plan(options.read(), limits);
      overflow = after.overflow;
      snapshot = undefined;
    } else {
      if (over !== overflow) snapshot = undefined;
      overflow = over;
    }
    return refused.length === 0 ? outcome : { ...outcome, refused };
  }

  /** Release the older settled part of each named view. Returns what moved. */
  const trim = (targets: ReadonlyMap<string, number>): boolean => {
    let moved = false;
    const at = now().toISOString();
    for (const [path, keepBytes] of targets) {
      const view = options.read().open[path];
      if (!view || isDormantView(view)) continue;
      const before = options.read().open[path];
      // The rows the transcript is standing on travel with the transaction, so
      // the reducer stays a function of its action (RP-5b).
      const anchored = anchoredMessages(path);
      options.dispatch({ type: "views/trim", paths: [path], keepBytes, at, ...(anchored.length > 0 ? { anchored } : {}) });
      if (options.read().open[path] === before) continue;
      moved = true;
      trims += 1;
      remeasure(options.read(), path);
    }
    if (moved) snapshot = undefined;
    return moved;
  };

  const markDirty = (path: string): void => {
    const row = owned.get(path);
    if (row) { row.dirty = true; snapshot = undefined; }
  };

  return {
    observeTransaction(action, before, after) {
      if (disposed) return;
      let pins = false;
      let grew = false;
      const dirty = (path: string | undefined): void => {
        if (path === undefined) return;
        const view = after.open[path];
        if (!view) { forget(path); pins = true; return; }
        if (owned.has(path)) markDirty(path);
        else if (holdsTranscript(view)) { remeasure(after, path); pins = true; }
        if (before.open[path] !== view) pins = true;
      };

      switch (action.type) {
        case "notification": {
          const params = action.params as { sessionPath?: string; path?: string; update?: SessionUpdate };
          const path = params.sessionPath ?? params.path;
          if (path === undefined) break;
          const view = after.open[path];
          // A streamed token is not simply added any more: the live body it
          // lands in is capped, so it drops as many bytes as it takes and the
          // old incremental shortcut would grow this accounting without bound
          // while the view itself stayed flat (RP-5b §4.2). The path is marked
          // instead, and the next pass measures what is actually held — the
          // per-block measures are memoised, so that costs the live tail.
          if (before.open[path] !== view) { dirty(path); grew = true; }
          break;
        }
        case "views/evict":
          for (const path of action.paths) forget(path);
          pins = true;
          break;
        case "closeView":
          forget(action.path);
          pins = true;
          break;
        case "forked":
          forget(action.from);
          dirty(action.state.path);
          used.set(action.state.path, ++clock);
          pins = true;
          break;
        case "opened":
          dirty(action.state.path);
          used.set(action.state.path, ++clock);
          break;
        case "hydrate":
        case "entries":
        case "historySnapshot":
        case "historyPrepend":
        case "historyMetadata":
        case "historyReset":
        case "historyBegin":
        case "historyEnd":
        case "goal":
        case "pending":
        case "resync":
        case "optimisticUser":
        case "optimisticFailed":
        case "dialogAnswered":
        case "editorTextTaken":
          // A read a person asked for, a message they sent, a question they
          // answered: this conversation is the one they are using. An action
          // the reducer refused changed nothing and counts as nothing.
          if ("path" in action && typeof action.path === "string") {
            const changed = before.open[action.path] !== after.open[action.path];
            dirty(action.path);
            if (changed && action.type !== "historyBegin" && action.type !== "historyEnd") used.set(action.path, ++clock);
          }
          pins = true;
          break;
        case "resetEnvironment":
          for (const path of [...owned.keys()]) forget(path);
          used.clear();
          pins = true;
          break;
        case "destination":
        case "sessionLoad":
        case "agents/run":
        case "agents/runs/loaded":
        case "tasks/update":
        case "tasks/loaded":
          pins = true;
          break;
        default:
          break;
      }
      // Anything the store dropped or added without naming it here.
      if (before.open !== after.open && !pins) {
        for (const path of [...owned.keys()]) if (!after.open[path]) { forget(path); pins = true; }
      }
      if (pins) schedule("pins");
      else if (grew) schedule("growth");
    },
    notifyPins() {
      // A draft written or cleared, a scope taking or letting go of a session:
      // the store did not move, so nothing could have observed it.
      snapshot = undefined;
      schedule("pins");
    },
    touch(path) {
      used.set(path, ++clock);
    },
    maintain,
    releaseUnder(pressure) {
      if (disposed) return NOTHING_RELEASED;
      // One step down, and a second call at the same pressure with nothing new
      // hydrated releases nothing: this is not a ratchet.
      const factor = pressure === "critical" ? 4 : 2;
      const effective: ViewCacheLimits = {
        views: Math.max(0, Math.floor(limits.views / factor)),
        bytes: Math.max(0, Math.floor(limits.bytes / factor)),
        viewBytes: Math.max(0, Math.floor(limits.viewBytes / factor)),
      };
      const state = options.read();
      const { paths, trims: overSized, refused, overflow: over } = plan(state, effective);
      const outcome = release(paths.map((row) => ({ ...row, reason: "pressure" as const })));
      // Under pressure the per-view share is tighter, and it still binds every
      // view: a conversation somebody is reading keeps its newest turns.
      if (trim(overSized)) {
        overflow = plan(options.read(), effective).overflow;
        snapshot = undefined;
      } else {
        if (over !== overflow) snapshot = undefined;
        overflow = over;
      }
      return { ...outcome, refused };
    },
    reserveAction(path, bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
      // Give back what can be given back before refusing anybody.
      maintain();
      const generation = actionGeneration;
      const fits = (want: number, ignore?: symbol): boolean => {
        const state = options.read();
        const { held, bytes: total } = survey(state);
        // `survey` already counts every reservation, here and elsewhere. Take
        // them back out first, then add the ones that will still be held —
        // every one exactly once — plus what is being asked for now.
        const row = held.find((entry) => entry.path === path);
        // A view this cache has not measured contributes nothing but its
        // reservations; one it has measured contributes its own bytes only.
        const measuredHere = row ? Math.max(0, row.bytes - heldForAction(path)) : 0;
        let reservedHere = 0;
        let reservedAnywhere = 0;
        for (const [token, row] of reservations) {
          if (token === ignore) continue;
          if (row.path === path) reservedHere += row.bytes;
          reservedAnywhere += row.bytes;
        }
        if (measuredHere + reservedHere + want > limits.viewBytes) return false;
        return (total - reservedBytes) + reservedAnywhere + want <= limits.bytes;
      };
      if (!fits(bytes)) return undefined;
      const token = Symbol("action");
      reservations.set(token, { path, bytes });
      reservedBytes += bytes;
      snapshot = undefined;
      const reservation: ActionReservation = {
        path,
        get bytes() { return reservations.get(token)?.bytes ?? 0; },
        resize(next: number) {
          if (!Number.isSafeInteger(next) || next < 0) return false;
          if (generation !== actionGeneration) return false;
          const row = reservations.get(token);
          if (!row) return false;
          if (next > row.bytes && !fits(next, token)) return false;
          reservedBytes += next - row.bytes;
          reservations.set(token, { path, bytes: next });
          snapshot = undefined;
          return true;
        },
        release() {
          const row = reservations.get(token);
          if (!row) return;
          reservations.delete(token);
          reservedBytes -= row.bytes;
          snapshot = undefined;
        },
      };
      return reservation;
    },
    counters() {
      // The same frozen answer until one of its numbers moves: a diagnostics
      // surface polling this must not make the renderer do work to say so.
      if (snapshot) return snapshot;
      const state = options.read();
      const { held, bytes, drafts } = survey(state);
      const paths = Object.keys(state.open);
      const pinned = held.filter((row) => row.pin !== undefined).length;
      let largestViewBytes = 0;
      let largestBlockBytes = 0;
      let largestBodyBytes = 0;
      let referencedBytes = 0;
      let referencedImageBytes = 0;
      for (const row of held) {
        largestViewBytes = Math.max(largestViewBytes, row.bytes);
        largestBlockBytes = Math.max(largestBlockBytes, row.measure.largestBlockBytes);
        largestBodyBytes = Math.max(largestBodyBytes, row.measure.largestBodyBytes);
        referencedBytes += row.measure.referencedBytes;
        referencedImageBytes += row.measure.referencedImageBytes;
      }
      const heap = VIEW_HEAP_MODEL.lightBytes * paths.length
        + VIEW_HEAP_MODEL.hydratedBytes * held.length
        + VIEW_HEAP_MODEL.contentFactor * (totals.entriesBytes + totals.blocksBytes)
        + totals.imagesBytes;
      let dormant = 0;
      for (const path of paths) if (state.open[path]!.dormant !== undefined) dormant += 1;
      return snapshot = Object.freeze({
        views: paths.length,
        hydrated: held.length,
        pinned,
        dormant,
        entriesBytes: totals.entriesBytes,
        blocksBytes: totals.blocksBytes,
        imagesBytes: totals.imagesBytes,
        imagesEstimated: totals.imagesEstimated,
        bytes,
        heapEquivalentBytes: heap,
        largestViewBytes,
        largestBlockBytes,
        largestBodyBytes,
        referencedBytes,
        referencedImageBytes,
        trims,
        drafts,
        evictions,
        tailsPending: pending.size,
        tailsPendingBytes: pendingBytes,
        tailsDropped,
        limits,
        ...(overflow ? { overflow } : {}),
        calibration: { model: VIEW_HEAP_MODEL.model, fittedAt: VIEW_HEAP_MODEL.fittedAt },
      });
    },
    measure(path) {
      const view = options.read().open[path];
      return view ? measureOf(view) : EMPTY_MEASURE;
    },
    reset() {
      generation += 1;
      // Room held for an action in the environment this device just left is
      // given back here, once; the tokens for it can do nothing afterwards.
      actionGeneration += 1;
      reservations.clear();
      reservedBytes = 0;
      cancelPass?.();
      cancelPass = undefined;
      // A record captured in the environment this device just left is never
      // handed to the cache of the one it is in now.
      clearPending();
      tailsDropped = 0;
      used.clear();
      for (const path of [...owned.keys()]) forget(path);
      passAt = 0;
      evictions = 0;
      trims = 0;
      overflow = undefined;
      snapshot = undefined;
    },
    dispose() {
      disposed = true;
      generation += 1;
      actionGeneration += 1;
      reservations.clear();
      reservedBytes = 0;
      cancelPass?.();
      cancelPass = undefined;
      clearPending();
      used.clear();
      owned.clear();
      snapshot = undefined;
    },
  };
}

/** The `rendererViews` entry of RP-3's retained-store counters. */
export function rendererViewsStore(counters: RendererViewCounters): { count: number; bytes: number } {
  return { count: counters.hydrated, bytes: counters.bytes };
}
