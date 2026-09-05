/**
 * subagents — the in-process half of laser's pi-subagents support (M3-T1).
 *
 * ## The division of labour
 *
 * pi-subagents 0.65 has no sockets and no IPC, so almost everything a person
 * wants to see lives in files under `$PI_SUBAGENTS_TEMP_ROOT`. Those are read
 * by `@lasercode/host` (`src/subagents/`), not here, because a session started
 * from a terminal has no worker and no extension and must still be visible
 * (AGENTS.md invariant 1: "nothing that reads files lives here").
 *
 * What only this module can do, because it is inside the Pi process:
 *
 *   1. **Probe what actually works** — the `subagents:rpc:v1` bus answers
 *      `ping` with its own method list and capability map. That is R11 made
 *      literal: ask what works, never what version it is, and always with a
 *      timeout, because a session that filtered the extension out looks
 *      exactly like the extension being absent.
 *   2. **Resume** — the only control that cannot be reached from a file. The
 *      control inbox carries steer, stop and interrupt; resume goes only
 *      through the owning session's bus (docs/research/findings.md).
 *   3. **External runs** — other extensions register runs in an in-process
 *      registry on a `globalThis` symbol. No file ever mentions them, so
 *      without this module they simply do not exist.
 *   4. **Take completions immediately** — `subagent:async-complete` and
 *      `subagent:foreground-complete` fire the instant a child finishes,
 *      ~1 s before the next status poll. Consuming them here is what R12
 *      ("consume results promptly") asks for.
 *
 * ## It dogfoods the declared protocol
 *
 * Every panel this module produces is emitted on `laser:panel` — the same
 * public bus event any third-party extension would use (docs/ux-panels.md,
 * "The contract", way 2). It gets no private path into the host, so if the
 * declared protocol is not good enough for pi-subagents it is not good enough
 * for anyone, and we find that out in our own code.
 *
 * ## Panel ids are shared with the host on purpose
 *
 * `runPanelId` and friends below produce byte-identical ids to
 * `@lasercode/host` `src/subagents/panels.ts`. That is what makes "a child seen
 * by both paths appears exactly once" true by construction: two producers, one
 * id, one panel, replaced in place (R6/R9). They are duplicated rather than
 * imported because this package may only depend on `@lasercode/protocol`; the
 * REQUEST to move them into the protocol package is in the lane report.
 *
 * The rule that keeps it true: this module emits a panel only when it can
 * derive the *same* id the file layer will. Where the bus does not carry the
 * identity the file layer keys on — a completion covering several children —
 * it emits nothing rather than an id nobody else writes
 * ({@link completionEvent}).
 */
import { WIRE_NAMESPACE } from "@lasercode/protocol";
import {
  PANEL_ACTION_EVENT,
  PANEL_CLOSE_EVENT,
  PANEL_EVENT,
  type PanelEvent,
  type RunLifecycle,
} from "@lasercode/protocol";
import type { ModuleContext, LaserModule } from "./index.js";

// ---------------------------------------------------------------------------
// pi-subagents' public in-process surface, as constants (never an import)
// ---------------------------------------------------------------------------

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_READY = "subagents:rpc:v1:ready";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE = "subagent:async-complete";
const FOREGROUND_COMPLETE = "subagent:foreground-complete";
const CHILD_STATUS = "subagent:child-status";

/**
 * Registry symbols pi-subagents publishes. Only present once something has
 * touched the registry, so they are a positive signal and never a negative
 * one — absence proves nothing, which is why the probe below exists.
 */
const REGISTRY_KEYS = [
  "pi-subagents.background-work.v1",
  "pi-subagents.external-runs.v2",
  "pi-subagents.external-runs.v1",
  "pi-subagents.external-job-provider.v1",
  "pi-subagents.completion-owner-id",
];

/** How long discovery waits for a `ping` before deciding nobody is there (R11). */
const PROBE_TIMEOUT_MS = 750;
/** How often the external-run registry is re-read. It changes only when another extension writes it. */
const EXTERNAL_POLL_MS = 2000;

export const PANEL_SOURCE = "pi-subagents";
const PREFIX = "subagents:";

export const runPanelId = (runId: string): string => `${PREFIX}run:${runId}`;
export const childPanelId = (runId: string, childKey: string): string => `${PREFIX}child:${runId}:${childKey}`;
export const foregroundPanelId = (runId: string, index: number | undefined): string =>
  `${PREFIX}fg:${runId}${index === undefined ? "" : `:${index}`}`;
export const externalPanelId = (source: string, id: string): string => `${PREFIX}external:${source}:${id}`;

/** `subagents:run:<runId>` / `subagents:child:<runId>:<key>` → the run id inside. */
export function runIdOfPanel(panelId: string): string | undefined {
  if (panelId.startsWith(`${PREFIX}run:`)) return panelId.slice(`${PREFIX}run:`.length);
  // `child:<runId>:<key>` and `nested:<runId>:<i>:<childId>` both name the run
  // that owns them first. A nested child has no control path of its own, so
  // its Resume is the owning run's Resume (docs/ux-agent-work.md).
  for (const prefix of [`${PREFIX}child:`, `${PREFIX}nested:`]) {
    if (!panelId.startsWith(prefix)) continue;
    const rest = panelId.slice(prefix.length);
    const colon = rest.indexOf(":");
    return colon === -1 ? rest : rest.slice(0, colon);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

interface EventBusLike {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

interface RpcReply {
  requestId?: unknown;
  success?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface PingData {
  version?: number;
  methods?: string[];
  capabilities?: Record<string, unknown>;
  session?: { cwd?: string; sessionId?: string; sessionFile?: string | null };
}

let requestCounter = 0;

/**
 * One request on the bus. Every call has a timeout: pi-subagents may be
 * installed, filtered out of this session, or mid-reload, and all three look
 * identical from here.
 */
function rpc(events: EventBusLike, method: string, params: unknown, timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown> {
  const requestId = `${WIRE_NAMESPACE}-${Date.now().toString(36)}-${(requestCounter += 1)}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const off = events.on(`${RPC_REPLY_PREFIX}${requestId}`, (raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      const reply = (raw ?? {}) as RpcReply;
      if (reply.success === true) resolve(reply.data);
      else reject(new Error(typeof reply.error?.message === "string" ? reply.error.message : `subagents ${method} failed`));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off?.();
      reject(new Error(`pi-subagents did not answer ${method} in time`));
    }, timeoutMs);
    timer.unref?.();
    try {
      events.emit(RPC_REQUEST, { version: 1, requestId, method, params, source: { extension: WIRE_NAMESPACE } });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const registryPresent = (): boolean => {
  const g = globalThis as Record<PropertyKey, unknown>;
  return REGISTRY_KEYS.some((key) => g[Symbol.for(key)] !== undefined);
};

// ---------------------------------------------------------------------------
// External runs (in-process only — no file ever mentions them)
// ---------------------------------------------------------------------------

interface ExternalRun {
  id: string;
  sessionId: string;
  source: string;
  label: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  currentAction?: string;
  preview?: string;
  transcriptPath?: string;
  reportPath?: string;
}

const EXTERNAL_LIFECYCLE: Readonly<Record<ExternalRun["state"], RunLifecycle>> = {
  queued: "queued",
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "cancelled",
};

function readExternalRuns(sessionId: string | undefined): ExternalRun[] {
  if (!sessionId) return [];
  const g = globalThis as Record<PropertyKey, unknown>;
  const out: ExternalRun[] = [];
  for (const key of ["pi-subagents.external-runs.v2", "pi-subagents.external-runs.v1"]) {
    const registry = g[Symbol.for(key)] as { runs?: Map<string, unknown> } | undefined;
    const runs = registry?.runs;
    if (!(runs instanceof Map)) continue;
    for (const value of runs.values()) {
      const run = value as Partial<ExternalRun>;
      if (typeof run.id !== "string" || typeof run.source !== "string" || run.sessionId !== sessionId) continue;
      if (typeof run.label !== "string" || typeof run.startedAt !== "number") continue;
      const state = run.state;
      if (state === undefined || !(state in EXTERNAL_LIFECYCLE)) continue;
      out.push(run as ExternalRun);
    }
    if (out.length > 0) break;
  }
  return out.slice(0, 64);
}

/**
 * An external run, read-only by contract: we did not start it and cannot
 * touch it, so it declares no actions at all (R2). Its usage is `null` with a
 * reason rather than zero, because nobody measured it.
 */
function externalRunEvent(run: ExternalRun): PanelEvent {
  return {
    v: 1,
    id: externalPanelId(run.source, run.id),
    kind: "run",
    intent: "follow",
    title: run.label,
    source: PANEL_SOURCE,
    data: {
      lifecycle: EXTERNAL_LIFECYCLE[run.state],
      origin: `${run.source} (another extension)`,
      ...(run.currentAction !== undefined ? { activity: run.currentAction } : run.preview !== undefined ? { activity: run.preview } : {}),
      startedAt: new Date(run.startedAt).toISOString(),
      ...(run.endedAt !== undefined ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
      usage: { costUsd: null, unavailableReason: `${run.source} reports no token accounting` },
      ...(run.transcriptPath !== undefined ? { output: { ref: `file:${run.transcriptPath}` } } : {}),
      ...(run.reportPath !== undefined ? { artifacts: [{ label: "Report", ref: `file:${run.reportPath}` }] } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Completions (R12)
// ---------------------------------------------------------------------------

interface CompletionEvent {
  runId?: unknown;
  state?: unknown;
  agent?: unknown;
  summary?: unknown;
  success?: unknown;
  exitCode?: unknown;
  taskIndex?: unknown;
  /** One entry per child of a multi-child run; absent or empty for a single one. */
  results?: unknown;
  /** "workflow" for a run whose panels are a plan plus children, never one run. */
  mode?: unknown;
  source?: unknown;
  timedOut?: unknown;
  stopped?: unknown;
  interrupted?: unknown;
}

const COMPLETION_LIFECYCLE: Readonly<Record<string, RunLifecycle>> = {
  complete: "done",
  completed: "done",
  partial: "done",
  failed: "failed",
  stopped: "cancelled",
  paused: "paused",
  detached: "running",
};

/**
 * A finished child, the instant pi-subagents says so. Deliberately thin: the
 * host's file layer holds the same id and far more detail, and it replaces
 * this in place within the second (R6). What this buys is the second in
 * between, which is exactly the second a person is looking at the dot.
 *
 * ## Why a multi-child completion emits nothing
 *
 * `subagent:async-complete` fires once per *run*, and for a run with several
 * children it carries them in `results[]`. The file layer gives such a run a
 * `subagents:plan:<runId>` plus one `subagents:child:<runId>:<key>` per step,
 * where the key is `childId ?? workflowKey ?? index` — and the bus event
 * carries none of those three for its children. Claiming
 * `subagents:run:<runId>` anyway (which is what this did) mints a panel id
 * nothing on the disk path ever upserts or closes, so a workflow left a
 * permanent extra island beside its real children, each child overwriting the
 * last. There is no id here that is provably the file layer's, so this path
 * stands down for those runs and the poll a second later owns them. R9's "one
 * id, one panel" is worth more than one second of latency.
 */
function completionEvent(event: CompletionEvent, foreground: boolean): PanelEvent | undefined {
  const runId = typeof event.runId === "string" ? event.runId : undefined;
  if (!runId) return undefined;
  if (!foreground && multiChild(event)) return undefined;
  const state = typeof event.state === "string" ? event.state : event.success === true ? "complete" : "failed";
  const lifecycle = COMPLETION_LIFECYCLE[state] ?? "done";
  const agent = typeof event.agent === "string" ? event.agent : "child";
  const index = typeof event.taskIndex === "number" ? event.taskIndex : undefined;
  const summary = typeof event.summary === "string" ? event.summary.split("\n").find((l) => l.trim().length > 0)?.trim() : undefined;
  const reason = event.timedOut === true
    ? "it ran out of time"
    : event.stopped === true
      ? "you stopped it"
      : event.interrupted === true
        ? "it was interrupted"
        : undefined;
  return {
    v: 1,
    id: foreground ? foregroundPanelId(runId, index) : runPanelId(runId),
    kind: "run",
    intent: "follow",
    title: index === undefined ? agent : `${agent}#${index + 1}`,
    source: PANEL_SOURCE,
    data: {
      lifecycle,
      handle: `@${agent}`,
      ...(reason !== undefined ? { terminalReason: reason } : {}),
      ...(summary !== undefined ? { activity: summary } : {}),
      origin: foreground ? "a parent agent (foreground)" : "a parent agent",
      endedAt: new Date().toISOString(),
      usage: null,
    },
  };
}

/**
 * A completion that covers several children: `results[]` with more than one
 * entry, or a workflow run, which always has a plan panel rather than a run
 * panel on the disk path.
 */
function multiChild(event: CompletionEvent): boolean {
  if (event.mode === "workflow") return true;
  return Array.isArray(event.results) && event.results.length > 1;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

interface Probe {
  methods: string[];
  sessionId: string | undefined;
}

/** One probe, shared between `detect` and `activate` so the bus is pinged once. */
let lastProbe: { at: number; probe: Probe | undefined } | undefined;

async function probe(events: EventBusLike): Promise<Probe | undefined> {
  if (lastProbe && Date.now() - lastProbe.at < 5000) return lastProbe.probe;
  let result: Probe | undefined;
  try {
    const data = (await rpc(events, "ping", {})) as PingData;
    result = {
      methods: Array.isArray(data?.methods) ? data.methods.filter((m): m is string => typeof m === "string") : [],
      sessionId: typeof data?.session?.sessionId === "string" ? data.session.sessionId : undefined,
    };
  } catch {
    result = undefined;
  }
  lastProbe = { at: Date.now(), probe: result };
  return result;
}

export const subagentsModule: LaserModule = {
  name: "subagents",

  /**
   * Present if the bus answers, or if a registry symbol exists. The ping is
   * the authority — a registry symbol can be left behind by another package —
   * but it is tried second so an installed-and-idle pi-subagents that has not
   * built its bridge yet is still detected.
   */
  async detect({ pi }: ModuleContext) {
    if (await probe(pi.events as unknown as EventBusLike)) return true;
    return registryPresent();
  },

  activate({ pi, send, panels }: ModuleContext) {
    // Steer, stop and resume can land on a run the host discovered on disk and
    // this module never emitted. Claiming the namespace is what lets the
    // `panels` module replay those actions here instead of dropping them.
    const releaseClaim = panels?.claim(PREFIX);
    const events = pi.events as unknown as EventBusLike;
    const disposers: Array<(() => void) | void> = [];
    /** id → last emitted panel, so the bus carries changes, not heartbeats (R9). */
    const emitted = new Map<string, string>();
    let session: string | undefined;
    let methods: string[] = [];

    const emit = (event: PanelEvent): void => {
      const serialized = JSON.stringify(event);
      if (emitted.get(event.id) === serialized) return;
      emitted.set(event.id, serialized);
      events.emit(PANEL_EVENT, event);
    };

    const log = (level: "info" | "warn" | "error", message: string): void =>
      send({ type: "piorbit/module/log", module: "subagents", level, message });

    /**
     * Tell the host what this bus can do, so the UI shows exactly those
     * controls (R2) — in practice this is what makes Resume appear at all.
     */
    const announce = (found: Probe | undefined): void => {
      methods = found?.methods ?? [];
      session = found?.sessionId;
      send({
        type: "piorbit/subagents/event",
        event: { type: "bus", reachable: found !== undefined, methods, ...(session !== undefined ? { sessionId: session } : {}) },
      });
    };

    void probe(events).then(announce);
    disposers.push(
      events.on(RPC_READY, () => {
        lastProbe = undefined;
        void probe(events).then(announce);
      }),
    );

    // --- completions, taken the moment they fire (R12) ---------------------
    // These handlers are synchronous and do no I/O: `pi.events.emit` is
    // synchronous, and pi-subagents' completion observer runs inside it. A
    // handler that awaited anything here would hold up the parent's turn.
    disposers.push(
      events.on(ASYNC_COMPLETE, (raw) => {
        const event = completionEvent((raw ?? {}) as CompletionEvent, false);
        if (event) emit(event);
      }),
    );
    disposers.push(
      events.on(FOREGROUND_COMPLETE, (raw) => {
        const event = completionEvent((raw ?? {}) as CompletionEvent, true);
        if (event) emit(event);
      }),
    );
    disposers.push(
      events.on(CHILD_STATUS, (raw) => {
        const data = (raw ?? {}) as { runId?: unknown; childId?: unknown; status?: unknown; agent?: unknown };
        if (typeof data.runId !== "string" || typeof data.childId !== "string") return;
        if (data.status !== "stopping" && data.status !== "stopped") return;
        emit({
          v: 1,
          id: childPanelId(data.runId, data.childId),
          kind: "run",
          intent: "follow",
          title: typeof data.agent === "string" ? data.agent : data.childId,
          source: PANEL_SOURCE,
          data: {
            lifecycle: data.status === "stopped" ? "cancelled" : "running",
            terminalReason: data.status === "stopped" ? "you stopped it" : undefined,
            activity: data.status === "stopping" ? "stopping…" : undefined,
            usage: null,
          },
        });
      }),
    );

    // --- external runs -----------------------------------------------------
    const known = new Set<string>();
    const sweepExternal = (): void => {
      const runs = readExternalRuns(session);
      const present = new Set<string>();
      for (const run of runs) {
        const id = externalPanelId(run.source, run.id);
        present.add(id);
        known.add(id);
        emit(externalRunEvent(run));
      }
      for (const id of [...known]) {
        if (present.has(id)) continue;
        known.delete(id);
        emitted.delete(id);
        events.emit(PANEL_CLOSE_EVENT, { v: 1, id, reason: "the extension that owned it let it go" });
      }
    };
    const externalTimer = setInterval(sweepExternal, EXTERNAL_POLL_MS);
    externalTimer.unref?.();
    disposers.push(() => clearInterval(externalTimer));

    // --- actions the files cannot perform ----------------------------------
    disposers.push(
      events.on(PANEL_ACTION_EVENT, (raw) => {
        const action = (raw ?? {}) as { id?: unknown; actionId?: unknown; value?: unknown };
        if (typeof action.id !== "string" || typeof action.actionId !== "string") return;
        if (!action.id.startsWith(PREFIX)) return;
        const runId = runIdOfPanel(action.id);
        if (!runId) return;
        const message = typeof action.value === "string" ? action.value.trim() : "";
        void handle(action.actionId, runId, message);
      }),
    );

    const handle = async (actionId: string, runId: string, message: string): Promise<void> => {
      if (actionId === "resume") {
        if (!methods.includes("resume")) {
          log("warn", "this pi-subagents build does not expose resume on its bus");
          return;
        }
        if (!message) {
          log("warn", "resume needs something to say; the host should have asked first");
          return;
        }
        try {
          await rpc(events, "resume", { runId, message }, 30_000);
        } catch (error) {
          log("error", `resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      // steer / stop / interrupt normally travel through the control inbox in
      // the host, which works for terminal-started runs too. Answering them
      // here as well costs nothing and covers a run whose temp directory this
      // process can reach but the host cannot (a different uid's root).
      if (actionId === "steer" && message && methods.includes("steer")) {
        await rpc(events, "steer", { runId, message }, 10_000).catch((error: unknown) =>
          log("error", `steer failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    };

    log("info", "pi-subagents bridged; runs and plans come from the panel contract");

    return () => {
      releaseClaim?.();
      for (const dispose of disposers) dispose?.();
      emitted.clear();
      known.clear();
      lastProbe = undefined;
    };
  },
};
