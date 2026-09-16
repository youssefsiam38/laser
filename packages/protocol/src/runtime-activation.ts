import { z } from "zod";

export const UPDATE_ID_PATTERN = /^[0-9a-f]{64}$/;

export type ActivationGatePhase = "parking" | "parked" | "cancelled";

export interface ActivationBlockers {
  conversations: number;
  agents: number;
  questions: number;
  approvals: number;
  commands: number;
  mutations: number;
  workers: number;
}

export interface RuntimeActivationState {
  updateId: string;
  generationId: string;
  phase: ActivationGatePhase;
  blockers: ActivationBlockers;
}

export interface WorkerActivationState {
  updateId: string;
  generationId: string;
  parked: boolean;
  complete: boolean;
  blockers: Omit<ActivationBlockers, "mutations" | "workers">;
}

const updateId = z.string().regex(UPDATE_ID_PATTERN);
const generationId = z.string().regex(UPDATE_ID_PATTERN);

export const runtimeActivationParamsSchemas = {
  "pi/runtime/activation/prepare": z.object({ updateId, generationId }).strict(),
  "pi/runtime/activation/status": z.object({ updateId }).strict(),
  "pi/runtime/activation/cancel": z.object({ updateId }).strict(),
  "pi/worker/activation/park": z.object({ updateId, generationId }).strict(),
  "pi/worker/activation/status": z.object({ updateId }).strict(),
  "pi/worker/activation/cancel": z.object({ updateId }).strict(),
};

declare module "./messages.js" {
  interface ClientRequests {
    "pi/runtime/activation/prepare": {
      params: { updateId: string; generationId: string };
      result: RuntimeActivationState;
    };
    "pi/runtime/activation/status": {
      params: { updateId: string };
      result: RuntimeActivationState;
    };
    "pi/runtime/activation/cancel": {
      params: { updateId: string };
      result: RuntimeActivationState;
    };
    "pi/worker/activation/park": {
      params: { updateId: string; generationId: string };
      result: WorkerActivationState;
    };
    "pi/worker/activation/status": {
      params: { updateId: string };
      result: WorkerActivationState;
    };
    "pi/worker/activation/cancel": {
      params: { updateId: string };
      result: WorkerActivationState;
    };
  }
}
