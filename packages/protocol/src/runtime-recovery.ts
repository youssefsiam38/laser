import { z } from "zod";

/** A launcher identity is exactly 128 random bits rendered as lowercase hex. */
export const LAUNCH_ID_PATTERN = /^[0-9a-f]{32}$/;
export const launchIdSchema = z.string().regex(LAUNCH_ID_PATTERN);

/** Every reviewed in-process module has one stable owner name. */
export const RUNTIME_MODULE_NAMES = [
  "provider-log",
  "account-usage",
  "subagents",
  "background-work",
  "file-freshness",
  "transcribe",
  "web-access",
  "goal",
  "mcp",
] as const;
export type RuntimeModuleName = (typeof RUNTIME_MODULE_NAMES)[number];

export const WORKER_MODES = ["normal", "safe"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];
export const workerModeSchema = z.enum(WORKER_MODES);

/** Where a failure happened. Closed so repair never depends on parsing prose. */
export const RUNTIME_FAILURE_STAGES = [
  "spawn",
  "announce",
  "initialize",
  "register",
  "detect",
  "activate",
  "runtime",
  "park",
  "migrate",
  "restore",
] as const;
export type RuntimeFailureStage = (typeof RUNTIME_FAILURE_STAGES)[number];

/** Why a failure happened. Logs may add detail; policy acts only on these values. */
export const RUNTIME_FAILURE_CATEGORIES = [
  "spawn_error",
  "launch_identity_missing",
  "launch_identity_mismatch",
  "feature_generation_mismatch",
  "initialization_error",
  "registration_error",
  "detection_error",
  "activation_error",
  "process_exit",
  "heap_oom",
  "transport_fault",
  "repair_exhausted",
  "repair_record_corrupt",
  "runtime_drift",
  "park_failed",
  "migration_failed",
  "restore_failed",
] as const;
export type RuntimeFailureCategory = (typeof RUNTIME_FAILURE_CATEGORIES)[number];

export type RuntimeFailureOwner =
  | { kind: "host"; launchId: string }
  | { kind: "worker"; launchId: string; cwd: string }
  | { kind: "module"; module: RuntimeModuleName; sessionPath?: string | undefined };

/** Structured ownership first; the bounded message is only person-facing copy. */
export interface RuntimeFailure {
  owner: RuntimeFailureOwner;
  stage: RuntimeFailureStage;
  category: RuntimeFailureCategory;
  message: string;
}

export interface RuntimeRecoveryState {
  status: "starting" | "ready" | "crashed" | "retired";
  mode: WorkerMode;
  failure?: RuntimeFailure | undefined;
  repair?: { state: "available" | "exhausted" | "paused"; automaticAttempts: number } | undefined;
}

export interface RuntimeRecoveryCopy {
  title: string;
  detail: string;
  kind: "paused" | "launch-failed" | "runtime-stopped" | "exhausted";
}

/** One person-facing vocabulary for host errors, the recovery notice and the status chip. */
export function runtimeRecoveryCopy(state: RuntimeRecoveryState): RuntimeRecoveryCopy {
  if (state.repair?.state === "paused") {
    return {
      kind: "paused",
      title: "Automatic repair is paused",
      detail: "The recovery record could not be read. Your sessions and settings are unchanged.",
    };
  }
  const launchFailure = state.failure?.stage === "spawn"
    || state.failure?.stage === "announce"
    || state.failure?.stage === "initialize";
  if (state.repair?.state === "exhausted") {
    return launchFailure
      ? {
          kind: "exhausted",
          title: "This project's agent couldn't start",
          detail: "Your Feature choices and conversations are unchanged.",
        }
      : {
          kind: "exhausted",
          title: "This project's agent couldn't recover",
          detail: "Your conversation is saved. Try again, or start with optional Features off.",
        };
  }
  if (launchFailure) {
    return {
      kind: "launch-failed",
      title: "The project runtime didn't start",
      detail: "Check the app installation, then try again. Your conversations and Feature choices are unchanged.",
    };
  }
  return {
    kind: "runtime-stopped",
    title: state.failure?.category === "heap_oom" ? "This project's agent ran out of memory" : "Worker crashed",
    detail: "Your conversation is saved. Try again to continue from it.",
  };
}

const runtimeFailureOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host"), launchId: launchIdSchema }).strict(),
  z.object({ kind: z.literal("worker"), launchId: launchIdSchema, cwd: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("module"), module: z.enum(RUNTIME_MODULE_NAMES), sessionPath: z.string().min(1).optional() }).strict(),
]);

export const runtimeFailureSchema: z.ZodType<RuntimeFailure> = z.object({
  owner: runtimeFailureOwnerSchema,
  stage: z.enum(RUNTIME_FAILURE_STAGES),
  category: z.enum(RUNTIME_FAILURE_CATEGORIES),
  message: z.string().min(1).max(4_000),
}).strict();
