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
import { EMPTY_MEASURE, measureView, type ViewMeasure } from "./view-measure.js";
import { isTerminalRunStatus } from "@lasercode/protocol";
import { mainPath, pendingSessionPath } from "./main-destination.js";

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
  | "unsent";

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
  readonly overflow?: "pinned" | "drafts";
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
  /** Fold one store publication. Cheap: reference comparisons, no measuring. */
  observe(state: AppState): void;
  /** A person opened, selected or read this session. */
  touch(path: string): void;
  /** Bring the cache inside its bounds now. */
  maintain(): ReleaseOutcome;
  /** RP-8: release under memory pressure. Never a pinned view, never work. */
  releaseUnder(pressure: "warning" | "critical"): ReleaseOutcome;
  counters(): RendererViewCounters;
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

interface Tracked {
  blocks: unknown;
  entries: unknown;
  hydrated: boolean;
  /** Everything about this view a pin is decided from, as one cheap string. */
  pins: string;
}

/**
 * What a pin is decided from, per view, without walking anything: references
 * the reducer replaces when it changes, and three lengths. Two readings with
 * the same fingerprint cannot differ in whether this view is held.
 */
const pinFingerprint = (view: SessionView): string =>
  `${view.running ? 1 : 0}${view.state.isStreaming ? 1 : 0}${view.state.isCompacting ? 1 : 0}`
  + `:${view.dialogs.length}:${view.pending.length}:${view.queue.steering.length}:${view.queue.followUp.length}`
  + `:${view.historyPending ? 1 : 0}:${view.state.messageCount}:${view.state.pendingMessageCount}`;

/**
 * Which pin holds this view, or `undefined` when nothing does. Reads scalars
 * and two registries; it never walks a transcript.
 */
export function pinReason(state: AppState, path: string, environment: ViewCacheEnvironment): PinReason | undefined {
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
  for (const run of Object.values(state.agents.runs)) {
    if (run.sessionPath !== path) continue;
    if (!isTerminalRunStatus(run.status)) return "agent-run";
  }
  for (const task of Object.values(state.tasks.tasks)) {
    if (task.sessionPath === path && task.status === "running") return "task";
  }
  return undefined;
}

export function createViewCache(options: ViewCacheOptions): ViewCache {
  const limits = options.limits ?? VIEW_CACHE_LIMITS;
  const now = options.now ?? (() => new Date());
  const defer = options.defer ?? defaultDefer;
  const deliver = options.deliver ?? defaultDeliver;
  const sink = options.sink;

  const used = new Map<string, number>();
  const tracked = new Map<string, Tracked>();
  /** One measurement per view object: an unchanged view is never walked again. */
  const measured = new WeakMap<SessionView, ViewMeasure>();
  /**
   * Records waiting for the next frame, newest per session, oldest first, each
   * with what holding the whole record costs — not only its content bytes.
   */
  const pending = new Map<string, { tail: ViewTailDto; retained: number }>();
  let pendingBytes = 0;
  let tailsDropped = 0;
  let cancelDelivery: (() => void) | undefined;
  let clock = 0;
  let lastOpen: AppState["open"] | undefined;
  /** The registries and selections a pin is decided from, as references. */
  let lastPinSources: readonly unknown[] = [];
  let cancelPass: (() => void) | undefined;
  let passAt = 0;
  let evictions = 0;
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

  const measureOf = (view: SessionView): ViewMeasure => {
    const cached = measured.get(view);
    if (cached) return cached;
    const measure = view.hydrated || view.blocks.length > 0 || view.entries.length > 0 ? measureView(view) : EMPTY_MEASURE;
    measured.set(view, measure);
    return measure;
  };

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
    for (const path of released) {
      used.delete(path);
      tracked.delete(path);
    }
    evictions += released.length;
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
    // The whole record, not only the entries in it: the bound is on memory
    // this queue holds, and identity, cursors and structure are memory too.
    const cost = viewTailRetainedBytes(tail);
    const existing = pending.get(tail.path);
    if (existing) pendingBytes -= existing.retained;
    pending.delete(tail.path);
    // A single record larger than the whole queue is refused outright rather
    // than emptying the queue for itself.
    if (cost > PENDING_TAIL_MAX_BYTES) {
      tailsDropped += 1;
      return;
    }
    pending.set(tail.path, { tail, retained: cost });
    pendingBytes += cost;
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

  /** Everything the pass needs, measured once. */
  const survey = (state: AppState) => {
    const hydrated: Array<{ path: string; view: SessionView; measure: ViewMeasure; pin: PinReason | undefined }> = [];
    let bytes = 0;
    let pinnedBytes = 0;
    let dormant = 0;
    let drafts = 0;
    const totals = { entriesBytes: 0, blocksBytes: 0, imagesBytes: 0, imagesEstimated: 0 };
    for (const [path, view] of Object.entries(state.open)) {
      if (options.environment.hasDraft(path)) drafts += 1;
      if (view.dormant !== undefined) {
        dormant += 1;
        continue;
      }
      if (!view.hydrated && view.blocks.length === 0 && view.entries.length === 0) continue;
      const measure = measureOf(view);
      // A prompt this surface sent and the engine has not persisted is the
      // person's words; nothing else holds them.
      const unsent = view.blocks.some((block) => block.kind === "user" && block.optimistic === true);
      const pin = unsent ? ("unsent" as const) : pinReason(state, path, options.environment);
      hydrated.push({ path, view, measure, pin });
      bytes += measure.bytes;
      if (pin) pinnedBytes += measure.bytes;
      totals.entriesBytes += measure.entriesBytes;
      totals.blocksBytes += measure.blocksBytes;
      totals.imagesBytes += measure.imagesBytes;
      totals.imagesEstimated += measure.imagesEstimated;
    }
    return { hydrated, bytes, pinnedBytes, dormant, drafts, totals };
  };

  const plan = (state: AppState, effective: ViewCacheLimits): { paths: Array<{ path: string; bytes: number; reason: EvictionReason }>; refused: Array<{ path: string; pin: PinReason }>; overflow: RendererViewCounters["overflow"] } => {
    const { hydrated, bytes, pinnedBytes, drafts } = survey(state);
    const candidates = hydrated
      .filter((row) => row.pin === undefined)
      .sort((a, b) => (used.get(a.path) ?? 0) - (used.get(b.path) ?? 0));
    const chosen: Array<{ path: string; bytes: number; reason: EvictionReason }> = [];
    const taken = new Set<string>();
    let total = bytes;
    let count = hydrated.length;

    // One transcript over its own share goes first, whatever the count says —
    // and so does one holding an image whose decoded size could not be read.
    // A few encoded kilobytes can be an enormous surface once decoded, and a
    // number nobody could measure must not buy a conversation a place here.
    for (const row of candidates) {
      if (row.measure.bytes <= effective.viewBytes && row.measure.imagesEstimated === 0) continue;
      chosen.push({ path: row.path, bytes: row.measure.bytes, reason: "bytes" });
      taken.add(row.path);
      total -= row.measure.bytes;
      count -= 1;
    }
    for (const row of candidates) {
      if (count <= effective.views) break;
      if (taken.has(row.path)) continue;
      chosen.push({ path: row.path, bytes: row.measure.bytes, reason: "count" });
      taken.add(row.path);
      total -= row.measure.bytes;
      count -= 1;
    }
    for (const row of candidates) {
      if (total <= effective.bytes) break;
      if (taken.has(row.path)) continue;
      chosen.push({ path: row.path, bytes: row.measure.bytes, reason: "bytes" });
      taken.add(row.path);
      total -= row.measure.bytes;
      count -= 1;
    }

    const over = total > effective.bytes || count > effective.views;
    const refused = over
      ? hydrated.filter((row) => row.pin !== undefined).map((row) => ({ path: row.path, pin: row.pin! }))
      : [];
    return {
      paths: chosen,
      refused,
      overflow: over ? (drafts > 0 && pinnedBytes >= total ? "drafts" : "pinned") : undefined,
    };
  };

  function maintain(): ReleaseOutcome {
    if (disposed) return NOTHING_RELEASED;
    passAt = Date.now();
    const state = options.read();
    const { paths, refused, overflow: over } = plan(state, limits);
    overflow = over;
    const outcome = release(paths);
    return refused.length === 0 ? outcome : { ...outcome, refused };
  }

  return {
    observe(state) {
      if (disposed) return;
      // What a pin is decided from outside a view: the selection, the two
      // registries, and the loads in flight. A run going terminal or a task
      // ending replaces its registry and nothing else, so `open` alone would
      // never notice that a view stopped being held.
      const sources = [state.current, state.destination, state.agents.runs, state.tasks.tasks, state.sessionLoads];
      const pinsChanged = sources.some((source, index) => source !== lastPinSources[index]);
      lastPinSources = sources;
      if (state.open === lastOpen && !pinsChanged) return;
      const openChanged = state.open !== lastOpen;
      lastOpen = state.open;
      let hydratedCount = 0;
      let structural = tracked.size === 0 || pinsChanged;
      let grew = false;
      const seen = new Set<string>();
      for (const [path, view] of Object.entries(state.open)) {
        seen.add(path);
        const hydrated = view.hydrated && view.dormant === undefined;
        if (hydrated) hydratedCount += 1;
        const pins = pinFingerprint(view);
        const previous = tracked.get(path);
        if (!previous) {
          tracked.set(path, { blocks: view.blocks, entries: view.entries, hydrated, pins });
          if (hydrated) structural = true;
          continue;
        }
        // A turn ending, a queue emptying, a question answered: this view may
        // have stopped being held, and that is never made to wait.
        if (previous.hydrated !== hydrated || previous.pins !== pins) structural = true;
        // A streamed token replaces the blocks array and nothing else. One such
        // transaction can also be one enormous tool result, so it schedules a
        // pass too — just one that waits out the gap between content passes.
        else if (previous.blocks !== view.blocks || previous.entries !== view.entries) grew = true;
        previous.blocks = view.blocks;
        previous.entries = view.entries;
        previous.hydrated = hydrated;
        previous.pins = pins;
      }
      if (openChanged) for (const path of [...tracked.keys()]) if (!seen.has(path)) tracked.delete(path);
      if (structural || hydratedCount > limits.views) schedule("pins");
      else if (grew) schedule("growth");
    },
    notifyPins() {
      // A draft written or cleared, a scope taking or letting go of a session:
      // the store did not move, so nothing could have observed it.
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
      const { paths, refused, overflow: over } = plan(state, effective);
      overflow = over;
      const outcome = release(paths.map((row) => ({ ...row, reason: "pressure" as const })));
      return { ...outcome, refused };
    },
    counters() {
      const state = options.read();
      const { hydrated, bytes, dormant, drafts, totals } = survey(state);
      const pinned = hydrated.filter((row) => row.pin !== undefined).length;
      const heap = VIEW_HEAP_MODEL.lightBytes * Object.keys(state.open).length
        + VIEW_HEAP_MODEL.hydratedBytes * hydrated.length
        + VIEW_HEAP_MODEL.contentFactor * (totals.entriesBytes + totals.blocksBytes)
        + totals.imagesBytes;
      return Object.freeze({
        views: Object.keys(state.open).length,
        hydrated: hydrated.length,
        pinned,
        dormant,
        entriesBytes: totals.entriesBytes,
        blocksBytes: totals.blocksBytes,
        imagesBytes: totals.imagesBytes,
        imagesEstimated: totals.imagesEstimated,
        bytes,
        heapEquivalentBytes: heap,
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
      cancelPass?.();
      cancelPass = undefined;
      // A record captured in the environment this device just left is never
      // handed to the cache of the one it is in now.
      clearPending();
      tailsDropped = 0;
      used.clear();
      tracked.clear();
      lastOpen = undefined;
      lastPinSources = [];
      passAt = 0;
      evictions = 0;
      overflow = undefined;
    },
    dispose() {
      disposed = true;
      generation += 1;
      cancelPass?.();
      cancelPass = undefined;
      clearPending();
      used.clear();
      tracked.clear();
    },
  };
}

/** The `rendererViews` entry of RP-3's retained-store counters. */
export function rendererViewsStore(counters: RendererViewCounters): { count: number; bytes: number } {
  return { count: counters.hydrated, bytes: counters.bytes };
}
