/**
 * subagents — in-process bridge to pi-subagents (M3-T1).
 *
 * Detection: pi-subagents 0.65 publishes its registries on globalThis symbols
 * (`pi-subagents.background-work.v1`, external-runs, external-job-provider) and
 * speaks `subagents:rpc:v1` over `pi.events`. Any of those present = installed.
 *
 * Activation (todo): subscribe to lifecycle events on `pi.events`, consume the
 * background-work snapshot, forward as `piorbit/subagents/event`; accept steer,
 * stop, resume requests from the worker and replay them on the bus.
 */
import type { PiorbitModule } from "./index.js";

const REGISTRY_SYMBOLS = [
  "pi-subagents.background-work.v1",
  "pi-subagents.external-runs.v1",
  "pi-subagents.external-job-provider.v1",
];

export const subagentsModule: PiorbitModule = {
  name: "subagents",
  detect() {
    const g = globalThis as Record<PropertyKey, unknown>;
    return REGISTRY_SYMBOLS.some((key) => g[Symbol.for(key)] !== undefined);
  },
  activate({ send }) {
    // TODO(M3-T1): wire pi.events subscriptions and the rpc bus.
    send({ type: "piorbit/module/log", module: "subagents", level: "info", message: "pi-subagents detected; bridge not wired yet (M3-T1)" });
  },
};
