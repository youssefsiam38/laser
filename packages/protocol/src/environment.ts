import { ENV, ENV_PREFIX, FORMER_NAMES } from "./identity.js";

/** Private, memory-only desktop/CLI → host → worker environment overlay. */
export interface HostEnvironmentParams {
  variables: Record<string, string>;
}

/** Runtime/directory pins are never imported from a shell or another client. */
export function isProtectedEnvironmentKey(name: string): boolean {
  const key = name.toUpperCase();
  // readEnv also honours former prefixes: a rename must not unprotect its pins.
  const prefixes = [ENV_PREFIX, ...FORMER_NAMES.map((former) => former.envPrefix)];
  return prefixes.some((prefix) => key.startsWith(`${prefix.toUpperCase()}_`))
    || Object.values(ENV).some((value) => value === key)
    || key.startsWith("ELECTRON_") || key === "NODE_OPTIONS"
    || key === "PI_CODING_AGENT_DIR" || key === "PI_CODING_AGENT_SESSION_DIR";
}

/** Omitted keys are retained. Reject invalid names/values without exposing them. */
export function environmentOverlay(variables: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(variables).filter(([name, value]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isProtectedEnvironmentKey(name)
    && typeof value === "string" && !value.includes("\0"),
  )) as Record<string, string>;
}

/** Host → worker only; never broadcast to frontends or the relay. */
export interface WorkerNotifications {
  "pi/host/environment": HostEnvironmentParams;
}
