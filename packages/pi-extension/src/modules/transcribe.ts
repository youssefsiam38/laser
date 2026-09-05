/**
 * transcribe — the pi-gpt-transcribe seam (M8-T2).
 *
 * The package is a terminal program. `start()` refuses unless
 * `ctx.mode === "tui"`, because it opens the microphone from the Pi process,
 * draws a TUI component as its widget, and writes into Pi's own editor with
 * `pasteToEditor`. A browser has none of those. So piorbit does not drive the
 * package: it reimplements the same contract natively — microphone and level
 * meter in the browser, key and network call in the worker
 * (`packages/worker/src/transcribe.ts`) — and this module does the two things
 * that can only be done from inside the Pi process.
 *
 * 1. **Detection.** The affordance exists only where the package does. A
 *    session without pi-gpt-transcribe installed shows no microphone at all
 *    (M8-T1), rather than a button that explains itself after you press it.
 *    Detection reads Pi's own command registry, so a package the user filtered
 *    out of this project reads as absent — which is exactly what it is (R11).
 *
 * 2. **The pre-send transform.** A phrase still being transcribed when you
 *    press Enter belongs to the prompt you just sent. Pi awaits its `input`
 *    handlers before the prompt is delivered, so this hook is the only place
 *    that can hold the prompt open for the last phrase. Upstream does the same
 *    thing in the same hook; this is that behaviour, kept.
 *
 * Why a globalThis symbol and not an import: `@piorbit/worker` depends on this
 * package, so this package cannot depend on it. The worker's `TranscribeService`
 * publishes a two-method handle under `Symbol.for("piorbit.transcribe.v1")` and
 * this module looks it up. Same shape pi-subagents uses for its in-process
 * registries. Missing symbol → no dictation is running → `continue`, never a
 * hang.
 */

import type { ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { PiorbitModule } from "./index.js";

/** The npm/git package id, as it appears in `sourceInfo.source` and `sourceInfo.path`. */
const PACKAGE_ID = "pi-gpt-transcribe";
/** The slash command the package registers (`src/command.ts`, `COMMAND_NAME`). */
const COMMAND_NAME = "transcribe";

/** Mirrors `packages/worker/src/transcribe.ts`. Both sides declare it; neither imports the other. */
const BRIDGE_SYMBOL = Symbol.for("piorbit.transcribe.v1");

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

/**
 * True when `info` came from the named package. Matches the settings entry
 * (`npm:pi-gpt-transcribe`, `git:github.com/youssefsiam38/pi-gpt-transcribe`)
 * and the resolved path, because a package installed from git, from npm, or
 * from a local checkout writes a different `source` each time and only the path
 * is common to all three.
 */
function fromPackage(info: SlashCommandInfo["sourceInfo"] | undefined, id: string): boolean {
  if (!info) return false;
  return info.source.includes(id) || info.path.includes(id);
}

/** "already typed" + "new phrase", exactly one space between. */
function joinWithSpace(existing: string, addition: string): string {
  if (existing === "" || /\s$/.test(existing)) return `${existing}${addition}`;
  return `${existing} ${addition}`;
}

export const transcribeModule: PiorbitModule = {
  name: "transcribe",

  detect({ pi }) {
    try {
      return pi
        .getCommands()
        .some((command) => command.name === COMMAND_NAME && fromPackage(command.sourceInfo, PACKAGE_ID));
    } catch {
      // `getCommands` needs a bound runner. If it is not ready, the honest
      // answer is "not detected" — the capability report is re-sent on the next
      // session_start, and a wrong "yes" would offer a microphone that fails.
      return false;
    }
  },

  activate({ pi, send }) {
    send({
      type: "piorbit/module/log",
      module: "transcribe",
      level: "info",
      message:
        "pi-gpt-transcribe detected. piorbit dictates natively (browser microphone, worker transcription) and reads the package's config.json; its terminal path stays unused.",
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
