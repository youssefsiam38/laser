/**
 * The shell's own log.
 *
 * Separate from the host log on purpose: when the app will not start, the
 * question is almost always "did the shell fail, or did the host?", and two
 * files answer it in one glance. Kept small by truncating rather than rotating
 * — nobody has ever wanted the second-to-last laser desktop log.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 1_000_000;

/** Milliseconds since this process started. `performance.now()`'s origin. */
export function sinceLaunch(): number {
  return Math.round(performance.now());
}

/**
 * Every line the startup timeline can contain, in the order they happen.
 *
 * A closed vocabulary on purpose: the timeline is written to a file people
 * send to us when a launch felt slow, so nothing that could carry a path, a
 * URL, a token or a word of somebody's conversation may reach it. The type
 * makes that a compile error rather than a review note — `milestone()` takes
 * one of these names and nothing else, not even a template string.
 *
 *  - `process entered` — this file started running; everything before it is
 *    Electron's own boot.
 *  - `app ready` — Chromium is up and a window may be opened.
 *  - `window created` / `window ready to show` — the shell's own window.
 *  - `opening screen painted` — the waiting screen, shown while the host starts.
 *  - `host ready` — the agent host answered; the app can connect.
 *  - `app loaded` — the real UI finished loading in the window.
 */
export const STARTUP_MILESTONES = [
  "process entered",
  "app ready",
  "window created",
  "window ready to show",
  "opening screen painted",
  "host ready",
  "app loaded",
] as const;

export type StartupMilestone = (typeof STARTUP_MILESTONES)[number];

export class DesktopLog {
  private failed = false;
  /** Startup milestones already recorded; each one is a first, not a repeat. */
  private readonly milestones = new Set<StartupMilestone>();

  constructor(private readonly file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      this.failed = true;
    }
  }

  line(message: string): void {
    const stamped = `${new Date().toISOString()} ${message}`;
    // stderr as well as the file: `pnpm -F @lasercode/desktop dev` should show
    // everything without anyone having to find a path first.
    process.stderr.write(`${stamped}\n`);
    if (this.failed) return;
    try {
      this.rollIfHuge();
      appendFileSync(this.file, `${stamped}\n`);
    } catch {
      // A log that cannot be written must not take the app down with it.
      this.failed = true;
    }
  }

  /**
   * One line of the startup timeline: what happened, and how long after launch.
   *
   * A launch that felt slow is otherwise unanswerable — the log has the host's
   * own timings and nothing about the shell around them. Each milestone is
   * written once, so this stays a handful of lines at the top of the file
   * rather than a running commentary (a re-created window or a restarted host
   * says so in its own lines already).
   */
  milestone(name: StartupMilestone): void {
    if (this.milestones.has(name)) return;
    this.milestones.add(name);
    this.line(`startup: ${name} at ${sinceLaunch()}ms`);
  }

  /** What went wrong, on one line, with the cause when there is one. */
  error(message: string, cause?: unknown): void {
    const detail = cause instanceof Error ? cause.stack ?? cause.message : cause === undefined ? "" : String(cause);
    this.line(detail ? `${message}: ${detail}` : message);
  }

  private rollIfHuge(): void {
    try {
      if (statSync(this.file).size < MAX_BYTES) return;
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // No file yet, or a rename we are not allowed to do. Either is fine.
    }
  }
}
