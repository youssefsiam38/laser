import {
  methodPolicy,
  reachAllows,
  type ClientMethod,
  type EnvironmentCapabilities,
  type EnvironmentDescriptor,
  type MethodScope,
} from "@lasercode/protocol";

export type CapabilityState = "available" | "hidden" | "explained";
export type CapabilityPresentation = Exclude<CapabilityState, "available">;
export type EnvironmentCapability = keyof EnvironmentCapabilities;

export interface CapabilityDecision {
  state: CapabilityState;
  explanation?: string | undefined;
}

export interface CapabilityRequirements {
  presentation?: CapabilityPresentation | undefined;
  capabilities?: readonly EnvironmentCapability[] | undefined;
}

const SCOPE_EXPLANATION: Readonly<Record<MethodScope, string>> = {
  handshake: "This connection cannot finish preparing this environment.",
  read: "This environment does not allow this device to read that information.",
  session_write: "You can read conversations here, but changes must be made from a connection with editing access.",
  approval: "You can read this question here, but it must be answered from a connection allowed to approve work.",
  work_control: "You can follow this work here, but it must be started or stopped from a connection with control access.",
  execution: "This environment does not allow this device to run tools or project setup commands.",
  settings: "You can read these settings here, but changes must be made from a connection with settings access.",
  features: "This environment does not allow this device to change built-in features.",
  diagnostics: "Resource diagnostics are not available to this connection.",
  device: "This environment does not allow this device to manage notifications.",
};

const CAPABILITY_EXPLANATION: Readonly<Record<EnvironmentCapability, string>> = {
  revisions: "This environment cannot verify whether saved conversation content is current.",
  deltas: "This environment cannot update saved conversation content incrementally.",
  snapshots: "Conversation history is not available from this environment.",
  durableReads: "Saved conversations cannot be read while their worker is away in this environment.",
  search: "Saved conversation search is not available in this environment.",
  diagnostics: "Resource diagnostics are not available in this environment.",
  logs: "Logs are not available in this environment.",
  push: "Notifications are not available from this environment.",
};

const unavailable = (presentation: CapabilityPresentation, explanation: string): CapabilityDecision =>
  presentation === "hidden" ? { state: "hidden" } : { state: "explained", explanation };

/** Capability bits refine scope grants for the protocol families they describe. */
export function methodCapabilities(method: ClientMethod): readonly EnvironmentCapability[] {
  if (method === "session/revision") return ["revisions"];
  if (method === "session/search" || method === "session/search/cancel") return ["search"];
  if (method === "pi/session/entries" || method === "session/entry_range" || method === "session/entry_regions") return ["snapshots"];
  if (method.startsWith("pi/logs/")) return ["logs"];
  if (method.startsWith("resource/")) return ["diagnostics"];
  if (method.startsWith("pi/push/")) return ["push"];
  return [];
}

/**
 * Presentation and request preflight from the authenticated descriptor and the
 * protocol's compiler-complete policy table. Call sites name only the method
 * they already invoke and any product capability their surface genuinely uses;
 * the UI owns no method-to-scope or method-to-reach copy.
 */
export function capabilityFor(
  descriptor: EnvironmentDescriptor | undefined,
  method: ClientMethod,
  requirements: CapabilityRequirements = {},
): CapabilityDecision {
  const presentation = requirements.presentation ?? "hidden";
  if (!descriptor) return { state: "hidden" };
  const policy = methodPolicy(method);
  if (!policy) return unavailable(presentation, "This action is not available in this version.");

  if (descriptor.localOnly.includes(method) || !reachAllows(policy.reach, descriptor.actor.class)) {
    return unavailable(presentation, "This action is available only in the app on the host computer.");
  }
  if (!descriptor.scopes.includes(policy.scope)) {
    return unavailable(presentation, SCOPE_EXPLANATION[policy.scope]);
  }

  const required = new Set<EnvironmentCapability>([
    ...(policy.scope === "diagnostics" ? (["diagnostics"] as const) : []),
    ...methodCapabilities(method),
    ...(requirements.capabilities ?? []),
  ]);
  for (const capability of required) {
    if (!descriptor.capabilities[capability]) {
      return unavailable(presentation, CAPABILITY_EXPLANATION[capability]);
    }
  }
  return { state: "available" };
}

export function capabilityError(decision: CapabilityDecision): Error {
  return new Error(decision.explanation ?? "This action is not available in this environment.");
}
