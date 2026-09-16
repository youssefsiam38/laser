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

/**
 * The steps a **worker** owns, in the policy's order (RP-8 §2, actor-local).
 *
 * A worker clears its own caches, lets go of old replay suffixes and asks its
 * own finished commands to keep less. It does not release a renderer's views,
 * unload a conversation's runtime, retire itself or refuse admission: those
 * belong to the window and to the host, and a message claiming one of them is
 * a worker describing work it cannot do. Both worker-facing shapes — the
 * answer to a directive and the report a worker sends unasked — accept only
 * these three.
 */
export const MEMORY_PRESSURE_WORKER_ACTIONS = ["ephemeral_caches", "replay_suffixes", "task_records"] as const;
export type MemoryPressureWorkerAction = (typeof MEMORY_PRESSURE_WORKER_ACTIONS)[number];

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

/** A type-level assertion: `Assert<false>` does not compile. */
type Assert<T extends true> = T;

/** Compile-time proof of the one-way relationship above. */
export type MemoryPressureMeasureIsAResourceMeasure = MemoryPressureMeasure extends ResourceMeasure ? true : never;
type _MeasureIsAResourceMeasure = Assert<MemoryPressureMeasureIsAResourceMeasure>;

/**
 * The thresholds a sample was compared against: both, or neither.
 *
 * One alone says nothing — a number is above a line only when there is a line
 * — so the pair travels together, and its direction belongs to the kind:
 * physical and heap grow into trouble, while available machine memory falls
 * into it. The schema enforces the direction; the type enforces the pair.
 */
export type MemoryPressureThresholds = { warningBytes: number; criticalBytes: number } | { warningBytes?: never; criticalBytes?: never };

/**
 * One number a level was decided from, with the thresholds it was compared
 * against. The value is a {@link MemoryPressureMeasure}, so "we could not read
 * it" is a first-class answer with a reason, and never a zero.
 *
 * A role carries at most one input of each kind: two physical readings of the
 * same role at the same moment would be two different answers to one question.
 */
export type MemoryPressureInput = { kind: MemoryPressureInputKind; value: MemoryPressureMeasure } & MemoryPressureThresholds;

/**
 * What a step gave back. Never empty: a release that cannot say what it
 * released is not evidence of anything.
 */
export type MemoryPressureReleased = { count: number; bytes?: number } | { count?: number; bytes: number };

/**
 * Releasing, in the type as well as the schema: a step that reports what it
 * released *is* a release, and no other step may carry the field.
 */
type MemoryPressureReleaseFields =
  | { outcome: "released"; released: MemoryPressureReleased }
  | { outcome: Exclude<MemoryPressureOutcome, "released">; released?: never };

/**
 * Refusing, likewise: the admission step is the only one that refuses, and it
 * always names what it refused.
 */
type MemoryPressureRefusalFields =
  | { action: "admission_refused"; refusal: MemoryPressureRefusal }
  | { action: Exclude<MemoryPressureAction, "admission_refused">; refusal?: never };

/**
 * What one step of one pass did.
 *
 * Deliberately anonymous: it names the step and the result, never the session,
 * the project, the file or the process it touched. The journal adds identity
 * when it records the event, from what the receiving process already knows.
 */
export type MemoryPressureActionResult = { reason?: MemoryPressureReason } & MemoryPressureReleaseFields & MemoryPressureRefusalFields;

/** The same row, restricted to the steps a worker owns. */
export type MemoryPressureWorkerActionResult = MemoryPressureActionResult & { action: MemoryPressureWorkerAction };

/**
 * One recorded step, with the identity its journal gave it.
 *
 * `id`, `atMs`, `role` and `project` are assigned by the process that records
 * the event — never taken from a message a peer sent — so a worker cannot
 * choose how its own actions are attributed, and a project is named only by
 * the opaque id the inventory already mints.
 */
export type MemoryPressureEvent = MemoryPressureActionResult & {
  id: string;
  atMs: number;
  role: MemoryPressureRole;
  level: MemoryPressureLevel;
  project?: string;
};

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

/**
 * How much of a role was actually heard from.
 *
 * Arithmetic, not an opinion: `complete` is exactly `answered === expected`,
 * an incomplete row says so with `incomplete_coverage`, and a complete one has
 * nothing to explain. The schema enforces all three, which is why a validated
 * row is branded.
 */
export interface MemoryPressureCoverage {
  expected: number;
  answered: number;
  complete: boolean;
  reason?: ResourceUnavailableReason;
}

/**
 * One role's current state: its level, what decided it, and how complete that
 * is.
 *
 * A known level needs evidence: `warning` and `critical` need at least one
 * reading they could take, and `normal` needs that *and* complete coverage —
 * except for an aggregate role with nothing in it at all (no live worker),
 * which is genuinely calm with nothing to measure. Everything else is
 * `unknown`, which is never presented as calm.
 */
export interface MemoryPressureRoleState {
  role: MemoryPressureRole;
  level: MemoryPressureLevelState;
  /** How old the newest sample is. A duration, never a clock reading. */
  sampleAgeMs?: number;
  inputs: MemoryPressureInput[];
  ceiling?: MemoryPressureCeiling;
  coverage: MemoryPressureCoverage;
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

/** The aggregate level of a set of role rows: the worst thing any of them knows. */
export function aggregateMemoryPressureLevel(
  levels: readonly MemoryPressureLevelState[],
): MemoryPressureLevelState {
  if (levels.includes("critical")) return "critical";
  if (levels.includes("warning")) return "warning";
  if (levels.includes("unknown")) return "unknown";
  return "normal";
}

/**
 * The fixed-size state of pressure right now.
 *
 * This is what a snapshot, its retained history and a diagnostic export carry:
 * four role rows and a few numbers, whose size does not grow with how much has
 * happened. The events themselves live in exactly one journal and are read
 * from it once ({@link MemoryPressureJournalPage}), so retaining N snapshots
 * cannot retain N copies of the same history.
 *
 * Every role appears exactly once, so a role left out cannot read as calm, and
 * `level` is the aggregate of those rows rather than a second opinion beside
 * them.
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

/**
 * One bounded read of the journal, newest first.
 *
 * Newest first is the canonical order, and the page proves it: ids strictly
 * descend by ordinal and times never go forward, so a page can be joined to
 * `latestEventId` and audited. Its retention counters describe the journal it
 * came from, with this module's bounds rather than a sender's.
 */
export interface MemoryPressureJournalPage {
  events: MemoryPressureEvent[];
  retention: {
    maxEvents: typeof MEMORY_PRESSURE_EVENTS_MAX;
    maxAgeMs: typeof MEMORY_PRESSURE_EVENT_MAX_AGE_MS;
    maxBytes: typeof MEMORY_PRESSURE_EVENTS_MAX_BYTES;
    events: number;
    bytes: number;
    lastEvictedBy?: "age" | "events" | "bytes";
  };
}

/**
 * The mark a validated value carries.
 *
 * Several of this module's rules are relations between fields — coverage
 * equality, a role's evidence, a summary's aggregate, a page's ordering, a
 * pass's set and order — and TypeScript cannot express them. So the shapes
 * above stay readable, and the *validated* forms are branded: the only way to
 * obtain one is to parse, which is what makes the boundary between a producer
 * and this contract explicit.
 *
 * The mark is a required property keyed by a `unique symbol` that exists only
 * in the type system. Required and symbol-keyed on purpose: an optional mark
 * would make the brand a weak type, and an object that merely has no property
 * in common with it would be accepted — which is exactly the hole a nominal
 * boundary exists to close. Nothing writes the key at runtime, no encoder ever
 * sees it, and a message that carries a property of its own is refused by the
 * strict schemas regardless.
 */
declare const memoryPressureValidated: unique symbol;
export type MemoryPressureValidated<T> = T & { readonly [memoryPressureValidated]: true };

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
export const memoryPressureWorkerActionSchema = z.enum(
  MEMORY_PRESSURE_WORKER_ACTIONS as unknown as [MemoryPressureWorkerAction, ...MemoryPressureWorkerAction[]],
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

export const memoryPressureMeasureSchema: z.ZodType<MemoryPressureMeasure> = z.union([
  // Every value on this wire is a count of bytes, so it is a non-negative,
  // exactly representable integer rather than any finite number.
  z.object({ status: z.literal("available"), value: count }).strict(),
  // No `detail`: RP-1 may carry a human note beside an unavailable measure, and
  // this wire may not. A measure that arrives with one is refused rather than
  // quietly trimmed, because the sender should not have had text to send.
  z.object({ status: z.literal("unavailable"), reason: unavailableReasonSchema }).strict(),
]);

/** Every member of a list is distinct under `key`; the cardinality the types promise. */
function allDistinct<T>(rows: readonly T[], key: (row: T) => string): boolean {
  return new Set(rows.map(key)).size === rows.length;
}

export const memoryPressureInputSchema = z
  .object({
    kind: z.enum(MEMORY_PRESSURE_INPUT_KINDS as unknown as [MemoryPressureInputKind, ...MemoryPressureInputKind[]]),
    value: memoryPressureMeasureSchema,
    warningBytes: count.optional(),
    criticalBytes: count.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const has = { warning: input.warningBytes !== undefined, critical: input.criticalBytes !== undefined };
    if (has.warning !== has.critical) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criticalBytes"], message: "thresholds travel as a pair or not at all" });
      return;
    }
    if (!has.warning || input.warningBytes === undefined || input.criticalBytes === undefined) return;
    // Direction belongs to the kind: memory in use grows into trouble, memory
    // still available falls into it.
    const grows = input.kind !== "machine_available";
    const ordered = grows ? input.warningBytes < input.criticalBytes : input.criticalBytes < input.warningBytes;
    if (!ordered) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criticalBytes"],
        message: grows ? "warning comes before critical as memory in use grows" : "critical comes before warning as memory available falls",
      });
    }
  });

/** The cross-field rules a row must keep, wherever it is carried. */
function refineActionRow(
  row: { action: MemoryPressureAction; outcome: MemoryPressureOutcome; refusal?: MemoryPressureRefusal | undefined; released?: { count?: number | undefined; bytes?: number | undefined } | undefined },
  ctx: z.RefinementCtx,
): void {
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
}

const actionRowFields = {
  outcome: memoryPressureOutcomeSchema,
  reason: memoryPressureReasonSchema.optional(),
  refusal: memoryPressureRefusalSchema.optional(),
  released: z.object({ count: count.optional(), bytes: count.optional() }).strict().optional(),
};

export const memoryPressureActionResultSchema = z
  .object({ action: memoryPressureActionSchema, ...actionRowFields })
  .strict()
  .superRefine(refineActionRow);

/** The same row, accepted only for a step a worker owns. */
export const memoryPressureWorkerActionResultSchema = z
  .object({ action: memoryPressureWorkerActionSchema, ...actionRowFields })
  .strict()
  .superRefine(refineActionRow);

/**
 * The same row, with the identity its journal gave it.
 *
 * The row's own rules are re-applied rather than extended from the schema
 * above: a refinement is not inherited by `extend`, and an event that could
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
    ...actionRowFields,
  })
  .strict()
  .superRefine(refineActionRow);

export const memoryPressureCeilingSchema = z
  .object({ configuredBytes: count.optional(), measuredLimit: memoryPressureMeasureSchema.optional() })
  .strict();

/** One input per kind: a role cannot give two answers to one question. */
const inputsSchema = z
  .array(memoryPressureInputSchema)
  .max(MEMORY_PRESSURE_INPUTS_MAX)
  .refine((rows) => allDistinct(rows, (row) => row.kind), { message: "one input of each kind" });

const hasAvailableInput = (inputs: readonly { value: MemoryPressureMeasure }[]): boolean =>
  inputs.some((input) => input.value.status === "available");

const memoryPressureRoleStateShape = z
  .object({
    role: memoryPressureRoleSchema,
    level: memoryPressureLevelStateSchema,
    sampleAgeMs: count.optional(),
    inputs: inputsSchema,
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
  .strict()
  .superRefine((role, ctx) => {
    // A known level is a claim about evidence, so it needs some. The one
    // exception is an aggregate with nothing in it: no live worker is not a
    // missing reading, it is genuinely nothing to read.
    const nothingToMeasure = role.coverage.expected === 0 && role.coverage.answered === 0 && role.inputs.length === 0;
    if (role.level === "normal" && !role.coverage.complete) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["level"], message: "normal needs complete coverage; anything else is unknown" });
    }
    if (role.level !== "unknown" && !hasAvailableInput(role.inputs) && !(role.level === "normal" && nothingToMeasure)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["level"], message: "a known level needs at least one reading it could take" });
    }
  });

export const memoryPressureRoleStateSchema = memoryPressureRoleStateShape;

const memoryPressureSummaryShape = z
  .object({
    level: memoryPressureLevelStateSchema,
    roles: z
      .array(memoryPressureRoleStateShape)
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
  .strict()
  .superRefine((summary, ctx) => {
    // Every role, every time: a row left out must not read as calm.
    const present = new Set(summary.roles.map((row) => row.role));
    for (const role of MEMORY_PRESSURE_ROLES) {
      if (!present.has(role)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles"], message: `every role is reported, including ${role}` });
      }
    }
    if (present.size !== MEMORY_PRESSURE_ROLES.length) return;
    // And the aggregate is those rows, not a second opinion beside them.
    const derived = aggregateMemoryPressureLevel(summary.roles.map((row) => row.level));
    if (summary.level !== derived) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["level"], message: "the level is the worst thing its roles know" });
    }
  });

const memoryPressureJournalPageShape = z
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
  .strict()
  .superRefine((page, ctx) => {
    const ordinals = page.events.map((row) => Number(row.id.slice(3)));
    if (!allDistinct(page.events, (row) => row.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: "one row per event" });
    }
    // Newest first is the canonical order: ids descend and time never moves
    // forward, so a page can be joined to `latestEventId` and audited.
    if (ordinals.some((value, index) => index > 0 && value >= ordinals[index - 1]!)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: "a page is newest first, by event id" });
    }
    if (page.events.some((row, index) => index > 0 && row.atMs > page.events[index - 1]!.atMs)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: "a page is newest first, by time" });
    }
    // A page cannot carry events the journal says it does not retain.
    if (page.events.length > page.retention.events) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: "a page cannot hold more than the journal retains" });
    }
    if (page.retention.events === 0 && (page.retention.bytes !== 0 || page.events.length !== 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retention", "bytes"], message: "an empty journal retains no bytes and no rows" });
    }
    if (page.retention.events > 0 && page.retention.bytes === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retention", "bytes"], message: "retained rows cost bytes" });
    }
  });

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

const memoryPressureDirectiveResultShape = z
  .object({
    applied: z.boolean(),
    ran: z.array(memoryPressureWorkerActionSchema).max(MEMORY_PRESSURE_WORKER_ACTIONS.length),
    /** One row per step it ran. Anonymous results; the host records the events. */
    events: z.array(memoryPressureWorkerActionResultSchema).max(MEMORY_PRESSURE_WORKER_ACTIONS.length),
    stores: memoryPressureStoresSchema,
  })
  .strict()
  .superRefine((answer, ctx) => refinePass(answer.ran, answer.events, "events", ctx));

/**
 * Worker → host, on the pipe the host opened when it spawned that worker.
 *
 * It carries no identity of its own beyond the generation it believes it is:
 * the host binds the report to the worker that delivered it, and assigns the
 * time, the event ids and the project itself. A report at `normal` or
 * `unknown` has run nothing — pressure that is absent or unproven acts on
 * nothing — and a report that claims a level has at least one reading it
 * could take.
 */
const memoryPressureReportShape = z
  .object({
    generation: ordinal,
    level: memoryPressureLevelStateSchema,
    sampleAgeMs: count.optional(),
    inputs: inputsSchema,
    ran: z.array(memoryPressureWorkerActionSchema).max(MEMORY_PRESSURE_WORKER_ACTIONS.length),
    results: z.array(memoryPressureWorkerActionResultSchema).max(MEMORY_PRESSURE_WORKER_ACTIONS.length),
    stores: memoryPressureStoresSchema,
  })
  .strict()
  .superRefine((report, ctx) => {
    refinePass(report.ran, report.results, "results", ctx);
    if (report.level !== "unknown" && !hasAvailableInput(report.inputs)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["level"], message: "a known level needs at least one reading it could take" });
    }
    if ((report.level === "normal" || report.level === "unknown") && (report.ran.length > 0 || report.results.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ran"], message: "nothing is released at normal, and nothing at all under unproven evidence" });
    }
  });

// ---------------------------------------------------------------------------
// Validated forms — the only way past the relations TypeScript cannot express
// ---------------------------------------------------------------------------

export type ValidatedMemoryPressureSummary = MemoryPressureValidated<MemoryPressureSummary>;
export type ValidatedMemoryPressureJournalPage = MemoryPressureValidated<MemoryPressureJournalPage>;
export interface MemoryPressureDirectiveResultShape {
  applied: boolean;
  ran: MemoryPressureWorkerAction[];
  events: MemoryPressureWorkerActionResult[];
  stores: MemoryPressureStores;
}
export interface MemoryPressureReportShape {
  generation: number;
  level: MemoryPressureLevelState;
  sampleAgeMs?: number;
  inputs: MemoryPressureInput[];
  ran: MemoryPressureWorkerAction[];
  results: MemoryPressureWorkerActionResult[];
  stores: MemoryPressureStores;
}
export type ValidatedMemoryPressureDirectiveResult = MemoryPressureValidated<MemoryPressureDirectiveResultShape>;
export type ValidatedMemoryPressureReport = MemoryPressureValidated<MemoryPressureReportShape>;

export const memoryPressureSummarySchema = memoryPressureSummaryShape.transform(
  (value) => value as unknown as ValidatedMemoryPressureSummary,
);
export const memoryPressureJournalPageSchema = memoryPressureJournalPageShape.transform(
  (value) => value as unknown as ValidatedMemoryPressureJournalPage,
);
export const memoryPressureDirectiveResultSchema = memoryPressureDirectiveResultShape.transform(
  (value) => value as unknown as ValidatedMemoryPressureDirectiveResult,
);
export const memoryPressureReportSchema = memoryPressureReportShape.transform(
  (value) => value as unknown as ValidatedMemoryPressureReport,
);

/**
 * Host → the windows on this machine. A summary, never the journal.
 *
 * The whole payload is validated, not only the summary inside it: an epoch is
 * a number a producer chooses, and a fractional or unsafe one would be a
 * generation nothing can compare. So the outer object is branded too, and the
 * notification carries that form rather than a raw `{ epoch, summary }`.
 */
const memoryPressurePublishShape = z.object({ epoch: ordinal, summary: memoryPressureSummarySchema }).strict();

export interface MemoryPressurePublishShape {
  epoch: number;
  summary: ValidatedMemoryPressureSummary;
}
export type ValidatedMemoryPressurePublish = MemoryPressureValidated<MemoryPressurePublishShape>;

export const memoryPressurePublishSchema = memoryPressurePublishShape.transform(
  (value) => value as unknown as ValidatedMemoryPressurePublish,
);

export const memoryPressureParamsSchemas = {
  "pi/worker/pressure": memoryPressureDirectiveSchema,
};

/**
 * The parse boundary.
 *
 * A producer inside the app holds ordinary objects and turns them into wire
 * values here; there is no other way to obtain a validated one, which is what
 * keeps the relations above from being bypassed by a cast.
 */
export const parseMemoryPressureSummary = (value: unknown): ValidatedMemoryPressureSummary => memoryPressureSummarySchema.parse(value);
export const parseMemoryPressureJournalPage = (value: unknown): ValidatedMemoryPressureJournalPage =>
  memoryPressureJournalPageSchema.parse(value);
export const parseMemoryPressureDirectiveResult = (value: unknown): ValidatedMemoryPressureDirectiveResult =>
  memoryPressureDirectiveResultSchema.parse(value);
export const parseMemoryPressureReport = (value: unknown): ValidatedMemoryPressureReport => memoryPressureReportSchema.parse(value);
export const parseMemoryPressurePublish = (value: unknown): ValidatedMemoryPressurePublish => memoryPressurePublishSchema.parse(value);

/** What a diagnostic export carries about pressure: the state, and one page. */
export interface MemoryPressureExportSection {
  summary: ValidatedMemoryPressureSummary;
  journal: ValidatedMemoryPressureJournalPage;
}

// The wire types are the schemas' own outputs, so a shape and its parser can
// never drift apart; the `Input` aliases are what a producer may hand to the
// parser before it is one of ours.
export type MemoryPressureDirective = z.infer<typeof memoryPressureDirectiveSchema>;
export type MemoryPressureDirectiveResult = z.infer<typeof memoryPressureDirectiveResultSchema>;
export type MemoryPressureReport = z.infer<typeof memoryPressureReportSchema>;
export type MemoryPressurePublish = z.infer<typeof memoryPressurePublishSchema>;
export type MemoryPressureSummaryInput = z.input<typeof memoryPressureSummarySchema>;
// The readable shapes and the parser's input agree, so neither can drift.
type _SummaryParses = Assert<MemoryPressureSummary extends MemoryPressureSummaryInput ? true : never>;
type _ValidatedSummaryIsASummary = Assert<ValidatedMemoryPressureSummary extends MemoryPressureSummary ? true : never>;
type _JournalParses = Assert<MemoryPressureJournalPage extends z.input<typeof memoryPressureJournalPageSchema> ? true : never>;
export type MemoryPressureJournalPageInput = z.input<typeof memoryPressureJournalPageSchema>;
export type MemoryPressureDirectiveResultInput = z.input<typeof memoryPressureDirectiveResultSchema>;
export type MemoryPressureReportInput = z.input<typeof memoryPressureReportSchema>;

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
      result: ValidatedMemoryPressureDirectiveResult;
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
    "pi/resource/pressure": ValidatedMemoryPressureReport;

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
     * multiply one journal by the length of that history. It is the *validated*
     * summary, so a producer cannot attach one this module has not checked.
     */
    pressure?: ValidatedMemoryPressureSummary;
  }
}
