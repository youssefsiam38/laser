/**
 * transcribe — the pi-gpt-transcribe seam (M8-T2).
 *
 * The package is a terminal program. `start()` refuses unless
 * `ctx.mode === "tui"`, because it opens the microphone from the Pi process,
 * draws a TUI component as its widget, and writes into Pi's own editor with
 * `pasteToEditor`. A browser has none of those. So laser does not drive the
 * package: it reimplements the same contract natively — microphone and level
 * meter in the browser, key and network call in the worker
 * (`packages/worker/src/transcribe.ts`) — and this module does the two things
 * that can only be done from inside the Pi process.
 *
 * 1. **Availability.** Dictation is an always-present Laser capability. Its
 *    reusable backend is pinned in the worker; there is no package detection
 *    or installation state in the product.
 *
 * 2. **The pre-send transform.** A phrase still being transcribed when you
 *    press Enter belongs to the prompt you just sent. Pi awaits its `input`
 *    handlers before the prompt is delivered, so this hook is the only place
 *    that can hold the prompt open for the last phrase. Upstream does the same
 *    thing in the same hook; this is that behaviour, kept.
 *
 * Why a globalThis symbol and not an import: `@lasercode/worker` depends on this
 * package, so this package cannot depend on it. The worker's `TranscribeService`
 * publishes a two-method handle under `Symbol.for("lasercode.transcribe.v1")` and
 * this module looks it up. Missing symbol → no dictation is running →
 * `continue`, never a hang.
 */

import { PRODUCT_NAME, symbolKey } from "@lasercode/protocol";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LaserModule } from "./index.js";

/** Mirrors `packages/worker/src/transcribe.ts`. Both sides declare it; neither imports the other. */
const BRIDGE_SYMBOL = Symbol.for(symbolKey("transcribe.v1"));

interface TranscribeBridge {
  isActive(sessionPath: string): boolean;
  drain(sessionPath: string, timeoutMs?: number): Promise<string>;
}

function bridge(): TranscribeBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[BRIDGE_SYMBOL];
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<TranscribeBridge>;
  return typeof candidate.isActive === "function" && typeof candidate.drain === "function"
    ? (candidate as TranscribeBridge)
    : undefined;
}

/** "already typed" + "new phrase", exactly one space between. */
function joinWithSpace(existing: string, addition: string): string {
  if (existing === "" || /\s$/.test(existing)) return `${existing}${addition}`;
  return `${existing} ${addition}`;
}

export const transcribeModule: LaserModule = {
  name: "transcribe",

  detect: () => true,

  activate({ pi, send }) {
    send({
      type: "lasercode/module/log",
      module: "transcribe",
      level: "info",
      message:
        `${PRODUCT_NAME} dictation is ready. The browser owns capture and the worker uses the pinned transcription core; terminal presentation stays unused.`,
    });

    // Pi has no `off`: handlers live as long as the extension runner, which is
    // the session. Nothing to dispose.
    pi.on("input", async (event, ctx: ExtensionContext) => {
      // The package's own `input` hook is registered too. It returns
      // `continue` here because its session never starts outside a TUI, so the
      // two hooks do not fight; Pi chains transforms in load order anyway.
      const handle = bridge();
      if (!handle) return { action: "continue" as const };
      const sessionPath = sessionFileOf(ctx);
      if (!sessionPath || !handle.isActive(sessionPath)) return { action: "continue" as const };

      let tail = "";
      try {
        tail = await handle.drain(sessionPath);
      } catch {
        // A drain that fails must not swallow the prompt. Whatever was
        // captured is reported through the dictation error state instead.
        return { action: "continue" as const };
      }
      if (tail === "") return { action: "continue" as const };
      return { action: "transform" as const, text: joinWithSpace(event.text, tail) };
    });
  },
};

/**
 * The session's file path — the id everything above the worker keys sessions
 * by. Undefined before Pi has written the file (a brand-new session that has
 * had no message yet), which is also a session nobody can have dictated into.
 */
function sessionFileOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile();
  } catch {
    return undefined;
  }
}
