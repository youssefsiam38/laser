/**
 * transcribe — glue for pi-gpt-transcribe (M8-T2).
 *
 * The package refuses to start when `ctx.mode !== "tui"`. The desktop path keeps
 * its `WidgetState` as the contract, renders a native waveform, and inserts
 * phrases at the composer cursor. Detection and activation are todo until the
 * package exposes a non-tui entry point (tracked in docs/upstream.md).
 */
import type { PiorbitModule } from "./index.js";

export const transcribeModule: PiorbitModule = {
  name: "transcribe",
  detect: () => false, // TODO(M8-T2): detect the package (registered /transcribe command or exported hook)
  activate() {},
};
