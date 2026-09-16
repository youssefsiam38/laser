/**
 * Memory pressure: the vocabulary, and nothing else (RP-8).
 *
 * Three processes answer for their own memory — the host, each project worker,
 * and the window a person is looking at — and each of them runs the part of the
 * ordered response it owns: the worker clears its own caches, releases old
 * replay and compacts finished commands; the host clears its own caches, asks a
 * worker to release an idle conversation and retires an idle worker; the window
 * releases the transcripts nobody is reading and refuses a heavy read with a
 * sentence. No actor waits for another's pass, and none of them ever cancels a
 * turn, a question, an approval, a run or a command.
 *
 * This module is the contract for that, and only the contract: the levels, the
 * ordered actions, the outcomes, the reasons, the refusals, the bounded journal
 * shapes and the three wire messages. There is no scheduler, no sampler and no
 * release behaviour here, and nothing in this file reads a counter.
 *
 * Two rules are structural rather than stylistic:
 *
 * - **Enums and numbers only.** Nothing on this wire is free text. A path, a
 *   pid, a start token, an argv, an environment id, a URL, an engine's error
 *   or a fragment of a conversation cannot travel here, because there is no
 *   field one could be put in. The single identifier a row may carry is the
 *   process inventory's own opaque, salted project id (RP-1), which is not
 *   reversible to a directory.
 * - **Missing evidence is missing.** A level the sampler could not establish is
 *   `"unknown"`, never `"normal"`; a counter that could not be read is a
 *   {@link ResourceMeasure} with a reason, never a zero. Everything here is
 *   typed so that saying "nothing is wrong" requires having measured it.
 */
import { z } from "zod";
import {
  RESOURCE_UNAVAILABLE_REASONS,
  type ResourceMeasure,
  type ResourceStoreKey,
  type ResourceStoreValue,
  type ResourceUnavailableReason,
} from "./resources.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** How much memory pressure a role is under. */
export const MEMORY_PRESSURE_LEVELS = ["normal", "warning", "critical"] as const;
export type MemoryPressureLevel = (typeof MEMORY_PRESSURE_LEVELS)[number];

/**
 * A level, or the honest absence of one.
 *
 * `"unknown"` is what a role reports when it could not read what it needs. It
 * is never treated as `"normal"`: nothing is released under it, and no surface
 * may present it as "fine".
 */
export const MEMORY_PRESSURE_LEVEL_STATES = [...MEMORY_PRESSURE_LEVELS, "unknown"] as const;
export type MemoryPressureLevelState = (typeof MEMORY_PRESSURE_LEVEL_STATES)[number];

/**
 * A level that can be *asked for*. A directive exists to make something
 * happen, so `"normal"` is not one of these: the absence of pressure is not an
 * instruction.
 */
export const MEMORY_PRESSURE_DIRECTIVE_LEVELS = ["warning", "critical"] as const;
export type MemoryPressureDirectiveLevel = (typeof MEMORY_PRESSURE_DIRECTIVE_LEVELS)[number];

/**
 * Who a row is about. A subset of the process inventory's roles plus the
 * machine itself, because available memory is a fact about the computer and
 * not about any one of our processes.
 */
export const MEMORY_PRESSURE_ROLES = ["host", "project_worker", "desktop_renderer", "machine"] as const;
export type MemoryPressureRole = (typeof MEMORY_PRESSURE_ROLES)[number];

/**
 * The ordered response, as seven named steps.
 *
 * The order is the policy: everything cheap and rebuildable goes before
 * anything a person would notice, and refusing to start new heavy work is the
 * last step rather than the first. Each actor runs the subsequence it owns —
 * the worker 3 and 4 (and its own 1), the host 5, 6 and 7 (and its own 1), the
 * window 2 and 7 (and its own 1) — and never another's.
 */
export const MEMORY_PRESSURE_ACTIONS = [
  /** 1 · calculation memos and rebuildable caches, in whichever process. */
  "ephemeral_caches",
  /** 2 · transcripts nobody is reading, and the over-sized parts of one that is. */
  "renderer_views",
  /** 3 · replay suffixes a reconnecting client would resync past anyway. */
  "replay_suffixes",
  /** 4 · finished commands' in-memory records; their durable logs stay readable. */
  "task_records",
  /** 5 · an idle conversation's runtime, released by the worker that owns it. */
  "idle_session_unload",
  /** 6 · a worker nobody is using, retired by its own atomic decision. */
  "worker_retirement",
  /** 7 · new heavy work refused with something a person can act on. */
  "admission_refused",
] as const;
export type MemoryPressureAction = (typeof MEMORY_PRESSURE_ACTIONS)[number];

/** What a step did. Every step reports one of these, including doing nothing. */
export const MEMORY_PRESSURE_OUTCOMES = [
  /** It gave memory back; `released` says how much. */
  "released",
  /** It ran and had nothing releasable. */
  "nothing_to_give",
  /** Everything it could have released is held by work, and work is never taken. */
  "held",
  /** The evidence it needed could not be read. Never a zero, never a success. */
  "unavailable",
  /** A fence, a generation mismatch or an arrival stopped it before it acted. */
  "refused",
  /** The bounded work for this pass was used up; more remains for the next one. */
  "budget_reached",
] as const;
export type MemoryPressureOutcome = (typeof MEMORY_PRESSURE_OUTCOMES)[number];

/**
 * Why an outcome happened. Exhaustive on purpose: a surface maps each of these
 * to its own fixed sentence, so no explanation ever travels as text.
 */
export const MEMORY_PRESSURE_REASONS = [
  /** A conversation is holding work the worker will not release. */
  "pins_held",
  /** Somebody is still following the conversation. */
  "membership_held",
  /** The worker could not describe everything it holds, so nothing was released. */
  "safety_incomplete",
  /** A request arrived while the release was being decided. */
  "arrival_fence",
  /** The answer belonged to a process generation that is no longer live. */
  "generation_mismatch",
  /** The directive was not answered inside its bound. */
  "directive_timeout",
  /** The answer did not have a shape this version understands. */
  "malformed_answer",
  /** No sample could be read at all. */
  "sample_unavailable",
  /** The newest sample is older than this level's cadence allows. */
  "sample_stale",
  /** A pass ran recently enough that another would be churn. */
  "cooldown",
  /** The per-pass work budget was reached before this step finished. */
  "work_budget",
] as const;
export type MemoryPressureReason = (typeof MEMORY_PRESSURE_REASONS)[number];

/**
 * What a person was told "not right now" about. Exhaustive, and deliberately
 * small: everything else — sending, answering, approving, running work,
 * reconnecting, opening a conversation in a project that is already running,
 * and every bounded range read — is never refused for memory.
 */
export const MEMORY_PRESSURE_REFUSALS = [
  /** Reading a whole conversation at once. */
  "whole_transcript",
  /** Paging further back than the window already holds. */
  "older_history",
  /** Hydrating a conversation nobody is looking at. */
  "background_session",
  /** Starting a worker nothing has asked for yet. */
  "speculative_worker",
  /** Starting the first worker for another project. */
  "new_project_worker",
  /** A whole-transcript authoritative read taken without a worker. */
  "worker_free_full_read",
] as const;
export type MemoryPressureRefusal = (typeof MEMORY_PRESSURE_REFUSALS)[number];

/** What a sampled number is about. */
export const MEMORY_PRESSURE_INPUT_KINDS = ["physical", "heap", "machine_available"] as const;
export type MemoryPressureInputKind = (typeof MEMORY_PRESSURE_INPUT_KINDS)[number];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Events one journal holds at once. */
export const MEMORY_PRESSURE_EVENTS_MAX = 200;
/** How long an event stays in the journal. */
export const MEMORY_PRESSURE_EVENT_MAX_AGE_MS = 60 * 60_000;
/** Bytes of retained events, independently of their count and age. */
export const MEMORY_PRESSURE_EVENTS_MAX_BYTES = 256 * 1024;
/** Events one journal page carries. */
export const MEMORY_PRESSURE_EVENTS_PAGE = 50;
/** Sampled inputs one role row may carry. */
export const MEMORY_PRESSURE_INPUTS_MAX = 8;
/** Steps one pass may report: at most one row per action. */
export const MEMORY_PRESSURE_RESULTS_MAX = MEMORY_PRESSURE_ACTIONS.length;
/** Role rows one summary may carry: at most one per role. */
export const MEMORY_PRESSURE_ROLES_MAX = MEMORY_PRESSURE_ROLES.length;
/** Refusals one summary may list: at most one per kind. */
export const MEMORY_PRESSURE_REFUSALS_MAX = MEMORY_PRESSURE_REFUSALS.length;
/**
 * The shape of an event id: the journal's own ordinal, nothing else.
 *
 * It is generated by the journal that owns the event, so it cannot carry a
 * path, a session, a pid or anything a peer chose.
 */
export const MEMORY_PRESSURE_EVENT_ID = /^mp_[1-9]\d{0,14}$/;
/** The process inventory's opaque salted project id (RP-1): 16 hex characters. */
export const MEMORY_PRESSURE_PROJECT_ID = /^[0-9a-f]{16}$/;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A measured number, or the reason there is none — as this wire carries it.
 *
 * Narrower than RP-1's {@link ResourceMeasure} on purpose: the inventory may
 * keep a human note beside an unavailable measurement, and nothing here may
 * carry words. Every value on this wire is a count of bytes, so an available
 * one is a non-negative, exactly representable integer rather than an
 * arbitrary float. The type is assignable to `ResourceMeasure`, so a surface
 * that already renders RP-1 measurements renders these unchanged.
 */
export type MemoryPressureMeasure =
  | { status: "available"; value: number }
  | { status: "unavailable"; reason: ResourceUnavailableReason };

/** Compile-time proof of the one-way relationship above. */
type WireMeasureIsAResourceMeasure = MemoryPressureMeasure extends ResourceMeasure ? true : never;
const _wireMeasureIsAResourceMeasure: WireMeasureIsAResourceMeasure = true;
void _wireMeasureIsAResourceMeasure;

/**
 * One number a level was decided from, with the thresholds it was compared
 * against. The value is a {@link MemoryPressureMeasure}, so "we could not read
 * it" is a first-class answer with a reason, and never a zero.
 *
 * A role carries at most one input of each kind: two physical readings of the
 * same role at the same moment would be two different answers to one question.
 */
export interface MemoryPressureInput {
  kind: MemoryPressureInputKind;
  value: MemoryPressureMeasure;
  warningBytes?: number;
  criticalBytes?: number;
}

/**
 * What one step of one pass did.
 *
 * Deliberately anonymous: it names the step and the result, never the session,
 * the project, the file or the process it touched. The journal adds identity
 * when it records the event, from what the receiving process already knows.
 */
export interface MemoryPressureActionResult {
  action: MemoryPressureAction;
  outcome: MemoryPressureOutcome;
  reason?: MemoryPressureReason;
  /**
   * What was refused. Present exactly when the step is `admission_refused`:
   * that step *is* the refusal, and no other step refuses anything.
   */
  refusal?: MemoryPressureRefusal;
  /**
   * How much this step gave back. Present exactly when the outcome is
   * `released`, and never empty: a release that cannot say what it released is
   * not evidence of anything.
   */
  released?: { count?: number; bytes?: number };
}

/**
 * One recorded step, with the identity its journal gave it.
 *
 * `id`, `atMs`, `role` and `project` are assigned by the process that records
 * the event — never taken from a message a peer sent — so a worker cannot
 * choose how its own actions are attributed, and a project is named only by
 * the opaque id the inventory already mints.
 */
export interface MemoryPressureEvent extends MemoryPressureActionResult {
  id: string;
  atMs: number;
  role: MemoryPressureRole;
  level: MemoryPressureLevel;
  project?: string;
}

/**
 * A ceiling, as two separate facts.
 *
 * `configuredBytes` is what this generation asked for; `measuredLimit` is what
 * the process itself reports. They are measurably different — V8's reported
 * limit is not the flag — so they are never one field, and a process started
 * before the ceiling existed has no configured value rather than a zero.
 */
export interface MemoryPressureCeiling {
  configuredBytes?: number;
  measuredLimit?: MemoryPressureMeasure;
}

/** One role's current state: its level, what decided it, and how complete that is. */
export interface MemoryPressureRoleState {
  role: MemoryPressureRole;
  level: MemoryPressureLevelState;
  /** How old the newest sample is. A duration, never a clock reading. */
  sampleAgeMs?: number;
  inputs: MemoryPressureInput[];
  ceiling?: MemoryPressureCeiling;
  /**
   * How much of this role was actually heard from. A role aggregated across
   * live workers is incomplete when one of them did not answer, and an
   * incomplete row is never presented as a total.
   */
  coverage: { expected: number; answered: number; complete: boolean; reason?: ResourceUnavailableReason };
}

/**
 * The order every reported pass is written in.
 *
 * An actor runs the subsequence it owns, so gaps are ordinary — a worker never
 * runs step 5 — but the steps it did run are reported in the policy's order,
 * because the order *is* the policy: cheap and rebuildable before anything a
 * person would notice.
 */
export function inPolicyOrder(actions: readonly MemoryPressureAction[]): boolean {
  let previous = -1;
  for (const action of actions) {
    const index = MEMORY_PRESSURE_ACTIONS.indexOf(action);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}

/**
 * The fixed-size state of pressure right now.
 *
 * This is what a snapshot, its retained history and a diagnostic export carry:
 * a few rows and a few numbers, whose size does not grow with how much has
 * happened. The events themselves live in exactly one journal and are read
 * from it once ({@link MemoryPressureJournalPage}), so retaining N snapshots
 * cannot retain N copies of the same history.
 */
export interface MemoryPressureSummary {
  level: MemoryPressureLevelState;
  roles: MemoryPressureRoleState[];
  /** What is being refused right now, by kind. */
  refusing: MemoryPressureRefusal[];
  totals: {
    events: number;
    released: { count: number; bytes: number };
    refusals: number;
  };
  /** The newest event this summary corresponds to, for joining it to a page. */
  latestEventId?: string;
}

/** One bounded read of the journal, with the three bounds that shape it. */
export interface MemoryPressureJournalPage {
  events: MemoryPressureEvent[];
  retention: {
    maxEvents: number;
    maxAgeMs: number;
    maxBytes: number;
    events: number;
    bytes: number;
    lastEvictedBy?: "age" | "events" | "bytes";
  };
}

/** What a diagnostic export carries about pressure: the state, and one page. */
export interface MemoryPressureExportSection {
  summary: MemoryPressureSummary;
  journal: MemoryPressureJournalPage;
}

/** Retained-store counters as a process reports them beside a pass (RP-3). */
export type MemoryPressureStores = Partial<Record<ResourceStoreKey, ResourceStoreValue>>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A count or a byte figure: a real, finite, non-negative, exactly representable integer. */
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A generation or an epoch: the same, and never zero-padded into meaning. */
const ordinal = count;

export const memoryPressureLevelSchema = z.enum(MEMORY_PRESSURE_LEVELS as unknown as [MemoryPressureLevel, ...MemoryPressureLevel[]]);
export const memoryPressureLevelStateSchema = z.enum(
  MEMORY_PRESSURE_LEVEL_STATES as unknown as [MemoryPressureLevelState, ...MemoryPressureLevelState[]],
);
export const memoryPressureDirectiveLevelSchema = z.enum(
  MEMORY_PRESSURE_DIRECTIVE_LEVELS as unknown as [MemoryPressureDirectiveLevel, ...MemoryPressureDirectiveLevel[]],
);
export const memoryPressureRoleSchema = z.enum(MEMORY_PRESSURE_ROLES as unknown as [MemoryPressureRole, ...MemoryPressureRole[]]);
export const memoryPressureActionSchema = z.enum(
  MEMORY_PRESSURE_ACTIONS as unknown as [MemoryPressureAction, ...MemoryPressureAction[]],
);
export const memoryPressureOutcomeSchema = z.enum(
  MEMORY_PRESSURE_OUTCOMES as unknown as [MemoryPressureOutcome, ...MemoryPressureOutcome[]],
);
export const memoryPressureReasonSchema = z.enum(
  MEMORY_PRESSURE_REASONS as unknown as [MemoryPressureReason, ...MemoryPressureReason[]],
);
export const memoryPressureRefusalSchema = z.enum(
  MEMORY_PRESSURE_REFUSALS as unknown as [MemoryPressureRefusal, ...MemoryPressureRefusal[]],
);

/**
 * Why a number is missing, from RP-1's own list rather than a copy of it: a
 * reason the inventory adds is a reason this wire accepts, with no second
 * table to forget to update.
 */
const unavailableReasonSchema = z.enum(
  RESOURCE_UNAVAILABLE_REASONS as unknown as [ResourceUnavailableReason, ...ResourceUnavailableReason[]],
);

/**
 * A measured number, or the reason there is none.
 *
 * Written here rather than imported because RP-1 keeps its measurements as
 * types: this is the one place a measure crosses a parsed boundary, and a
 * reader of this file should be able to see that an "available" measure must
 * carry a real number and an unavailable one must carry a known reason.
 */
export const memoryPressureMeasureSchema: z.ZodType<MemoryPressureMeasure> = z.union([
  // Every value on this wire is a count of bytes, so it is a non-negative,
  // exactly representable integer rather than any finite number.
  z.object({ status: z.literal("available"), value: count }).strict(),
  // No `detail`: RP-1 may carry a human note beside an unavailable measure, and
  // this wire may not. A measure that arrives with one is refused rather than
  // quietly trimmed, because the sender should not have had text to send.
  z.object({ status: z.literal("unavailable"), reason: unavailableReasonSchema }).strict(),
]);

export const memoryPressureInputSchema = z
  .object({
    kind: z.enum(MEMORY_PRESSURE_INPUT_KINDS as unknown as [MemoryPressureInputKind, ...MemoryPressureInputKind[]]),
    value: memoryPressureMeasureSchema,
    warningBytes: count.optional(),
    criticalBytes: count.optional(),
  })
  .strict();

/** Every member of a list is distinct under `key`; the cardinality the types promise. */
function allDistinct<T>(rows: readonly T[], key: (row: T) => string): boolean {
  return new Set(rows.map(key)).size === rows.length;
}

export const memoryPressureActionResultSchema = z
  .object({
    action: memoryPressureActionSchema,
    outcome: memoryPressureOutcomeSchema,
    reason: memoryPressureReasonSchema.optional(),
    refusal: memoryPressureRefusalSchema.optional(),
    released: z.object({ count: count.optional(), bytes: count.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // A release says what it released, and nothing else claims to have released.
    if (row.outcome === "released" && row.released === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["released"], message: "a released step must say what it released" });
    }
    if (row.outcome !== "released" && row.released !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["released"], message: "only a released step may report what it released" });
    }
    if (row.released !== undefined && row.released.count === undefined && row.released.bytes === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["released"], message: "a release with no count and no bytes is not evidence" });
    }
    // Refusing is a step of its own: it is the only one that names a refusal,
    // and it always names one.
    if (row.action === "admission_refused" && row.refusal === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refusal"], message: "an admission refusal must say what was refused" });
    }
    if (row.action !== "admission_refused" && row.refusal !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refusal"], message: "only the admission step refuses anything" });
    }
  });

/**
 * The same row, with the identity its journal gave it.
 *
 * The result's own cross-field rules are re-applied here rather than extended
 * from it: a refinement is not inherited by `extend`, and an event that could
 * contradict itself would be a record of something that never happened.
 */
export const memoryPressureEventSchema = z
  .object({
    id: z.string().regex(MEMORY_PRESSURE_EVENT_ID),
    atMs: count,
    role: memoryPressureRoleSchema,
    level: memoryPressureLevelSchema,
    project: z.string().regex(MEMORY_PRESSURE_PROJECT_ID).optional(),
    action: memoryPressureActionSchema,
    outcome: memoryPressureOutcomeSchema,
    reason: memoryPressureReasonSchema.optional(),
    refusal: memoryPressureRefusalSchema.optional(),
    released: z.object({ count: count.optional(), bytes: count.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const result = memoryPressureActionResultSchema.safeParse({
      action: row.action,
      outcome: row.outcome,
      ...(row.reason !== undefined ? { reason: row.reason } : {}),
      ...(row.refusal !== undefined ? { refusal: row.refusal } : {}),
      ...(row.released !== undefined ? { released: row.released } : {}),
    });
    if (result.success) return;
    for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: issue.path });
  });

export const memoryPressureCeilingSchema = z
  .object({ configuredBytes: count.optional(), measuredLimit: memoryPressureMeasureSchema.optional() })
  .strict();

export const memoryPressureRoleStateSchema = z
  .object({
    role: memoryPressureRoleSchema,
    level: memoryPressureLevelStateSchema,
    sampleAgeMs: count.optional(),
    inputs: z
      .array(memoryPressureInputSchema)
      .max(MEMORY_PRESSURE_INPUTS_MAX)
      .refine((rows) => allDistinct(rows, (row) => row.kind), {
        message: "one input of each kind: a role cannot give two answers to one question",
      }),
    ceiling: memoryPressureCeilingSchema.optional(),
    coverage: z
      .object({ expected: count, answered: count, complete: z.boolean(), reason: unavailableReasonSchema.optional() })
      .strict()
      .superRefine((coverage, ctx) => {
        // Coverage is arithmetic, not an opinion: more answers than askings is
        // a bookkeeping error, completeness is the equality itself, and an
        // incomplete row says out loud why it is not a total.
        if (coverage.answered > coverage.expected) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answered"], message: "more answers than were asked for" });
        }
        if (coverage.complete !== (coverage.answered === coverage.expected)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["complete"], message: "complete is exactly answered === expected" });
        }
        if (coverage.complete && coverage.reason !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "a complete row has nothing to explain" });
        }
        if (!coverage.complete && coverage.reason !== "incomplete_coverage") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "an incomplete row is incomplete_coverage" });
        }
      }),
  })
  .strict();

export const memoryPressureSummarySchema = z
  .object({
    level: memoryPressureLevelStateSchema,
    roles: z
      .array(memoryPressureRoleStateSchema)
      .max(MEMORY_PRESSURE_ROLES_MAX)
      .refine((rows) => allDistinct(rows, (row) => row.role), { message: "one row per role" }),
    refusing: z
      .array(memoryPressureRefusalSchema)
      .max(MEMORY_PRESSURE_REFUSALS_MAX)
      .refine((rows) => allDistinct(rows, (row) => row), { message: "one entry per kind of refusal" }),
    totals: z
      .object({
        events: count,
        released: z.object({ count, bytes: count }).strict(),
        refusals: count,
      })
      .strict(),
    latestEventId: z.string().regex(MEMORY_PRESSURE_EVENT_ID).optional(),
  })
  .strict();

export const memoryPressureJournalPageSchema = z
  .object({
    events: z.array(memoryPressureEventSchema).max(MEMORY_PRESSURE_EVENTS_PAGE),
    retention: z
      .object({
        // The bounds are this module's, not a sender's: a page that declared
        // its own would let a producer describe a journal nobody agreed to.
        maxEvents: z.literal(MEMORY_PRESSURE_EVENTS_MAX),
        maxAgeMs: z.literal(MEMORY_PRESSURE_EVENT_MAX_AGE_MS),
        maxBytes: z.literal(MEMORY_PRESSURE_EVENTS_MAX_BYTES),
        events: count.max(MEMORY_PRESSURE_EVENTS_MAX),
        bytes: count.max(MEMORY_PRESSURE_EVENTS_MAX_BYTES),
        lastEvictedBy: z.enum(["age", "events", "bytes"]).optional(),
      })
      .strict(),
  })
  .strict();

const storeValue = z.object({ count: count.optional(), bytes: count.optional() }).strict().optional();

/**
 * Retained-store counters: only the keys RP-3 declares, only counts and bytes.
 *
 * Written key by key and checked against {@link ResourceStoreKey} by the
 * compiler, so a store added to the inventory cannot be silently missing here
 * and a key this wire does not know cannot be invented by a sender.
 */
export const memoryPressureStoresSchema = z
  .object({
    workerSessions: storeValue,
    workerReplay: storeValue,
    workerCaches: storeValue,
    taskRegistry: storeValue,
    deliveryRegistry: storeValue,
    providerQueues: storeValue,
    rendererViews: storeValue,
    deviceCache: storeValue,
  } satisfies Record<ResourceStoreKey, typeof storeValue>)
  .strict();

/** Host → one live worker. The only thing a directive carries is what and when. */
export const memoryPressureDirectiveSchema = z
  .object({
    level: memoryPressureDirectiveLevelSchema,
    /** The host's pressure epoch; an answer from an older one changes nothing. */
    epoch: ordinal,
    /** The worker generation the host believes it is talking to (RP-1 identity). */
    generation: ordinal,
  })
  .strict();

/**
 * `ran` and the rows beside it are one list told twice, so they must agree:
 * the same steps, each once, in the policy's order. A pass that reported a
 * step it has no row for — or a row for a step it says it did not run — is a
 * pass nobody can read.
 */
function refinePass(
  ran: readonly MemoryPressureAction[],
  rows: readonly { action: MemoryPressureAction }[],
  rowsKey: "events" | "results",
  ctx: z.RefinementCtx,
): void {
  if (!allDistinct(ran, (action) => action)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ran"], message: "a step is run once in a pass" });
  }
  if (!allDistinct(rows, (row) => row.action)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [rowsKey], message: "a step reports once in a pass" });
  }
  if (!inPolicyOrder(ran)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ran"], message: "steps are reported in the policy's order" });
  }
  if (!inPolicyOrder(rows.map((row) => row.action))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [rowsKey], message: "steps are reported in the policy's order" });
  }
  const reported = rows.map((row) => row.action);
  if (ran.length !== reported.length || ran.some((action, index) => action !== reported[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [rowsKey], message: "every step that ran has exactly one row, and no other" });
  }
}

export const memoryPressureDirectiveResultSchema = z
  .object({
    applied: z.boolean(),
    ran: z.array(memoryPressureActionSchema).max(MEMORY_PRESSURE_RESULTS_MAX),
    /** One row per step it ran. Anonymous results; the host records the events. */
    events: z.array(memoryPressureActionResultSchema).max(MEMORY_PRESSURE_RESULTS_MAX),
    stores: memoryPressureStoresSchema,
  })
  .strict()
  .superRefine((answer, ctx) => refinePass(answer.ran, answer.events, "events", ctx));

/**
 * Worker → host, on the pipe the host opened when it spawned that worker.
 *
 * It carries no identity of its own beyond the generation it believes it is:
 * the host binds the report to the worker that delivered it, and assigns the
 * time, the event ids and the project itself.
 */
export const memoryPressureReportSchema = z
  .object({
    generation: ordinal,
    level: memoryPressureLevelStateSchema,
    sampleAgeMs: count.optional(),
    inputs: z.array(memoryPressureInputSchema).max(MEMORY_PRESSURE_INPUTS_MAX),
    ran: z.array(memoryPressureActionSchema).max(MEMORY_PRESSURE_RESULTS_MAX),
    results: z.array(memoryPressureActionResultSchema).max(MEMORY_PRESSURE_RESULTS_MAX),
    stores: memoryPressureStoresSchema,
  })
  .strict()
  .superRefine((report, ctx) => refinePass(report.ran, report.results, "results", ctx));

/** Host → the windows on this machine. A summary, never the journal. */
export const memoryPressurePublishSchema = z
  .object({ epoch: ordinal, summary: memoryPressureSummarySchema })
  .strict();

export const memoryPressureParamsSchemas = {
  "pi/worker/pressure": memoryPressureDirectiveSchema,
};

export type MemoryPressureDirective = z.infer<typeof memoryPressureDirectiveSchema>;
export type MemoryPressureDirectiveResult = {
  applied: boolean;
  ran: MemoryPressureAction[];
  events: MemoryPressureActionResult[];
  stores: MemoryPressureStores;
};
export type MemoryPressureReport = {
  generation: number;
  level: MemoryPressureLevelState;
  sampleAgeMs?: number;
  inputs: MemoryPressureInput[];
  ran: MemoryPressureAction[];
  results: MemoryPressureActionResult[];
  stores: MemoryPressureStores;
};
export type MemoryPressurePublish = { epoch: number; summary: MemoryPressureSummary };

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * Host → an **already live** worker: give memory back, at this level.
     *
     * Never a client's call — the router refuses it before anything is
     * forwarded — and never a reason to start a worker. The worker runs only
     * the steps it owns (its own caches, its replay suffixes, its finished
     * command records), refuses nothing that is work, and answers with what
     * each step did. `applied: false` with a `generation_mismatch` row is the
     * ordinary answer to a directive that arrived for a generation this
     * process is not.
     */
    "pi/worker/pressure": {
      params: MemoryPressureDirective;
      result: MemoryPressureDirectiveResult;
    };
  }

  interface HostNotifications {
    /**
     * Worker → host only, consumed at ingress and dropped before any broadcast.
     *
     * A worker samples its own memory and acts on it without being asked; this
     * is how it says what it found and what it did. The host binds the report
     * to the worker whose pipe delivered it, checks the generation, and assigns
     * every identity in the journal itself — the message carries no session, no
     * path, no pid and no project.
     */
    "pi/resource/pressure": MemoryPressureReport;

    /**
     * Host → the windows on this machine: the current pressure summary.
     *
     * Local sockets only. A paired device's memory is its own business, and a
     * host in trouble must not make a phone release what it is showing. It is
     * safe to drop when a connection is behind, because the same summary is
     * readable from `resource/snapshot`.
     */
    "resource/pressure": MemoryPressurePublish;
  }
}

declare module "./resources.js" {
  interface ResourceSnapshot {
    /**
     * Pressure as it was when this snapshot was taken (RP-8).
     *
     * A fixed-size summary, deliberately: snapshots are retained in a bounded
     * history and copied into exports, and embedding a growing event list would
     * multiply one journal by the length of that history.
     */
    pressure?: MemoryPressureSummary;
  }
}
