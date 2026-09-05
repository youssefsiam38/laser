/**
 * The shell's own log.
 *
 * Separate from the host log on purpose: when the app will not start, the
 * question is almost always "did the shell fail, or did the host?", and two
 * files answer it in one glance. Kept small by truncating rather than rotating
 * — nobody has ever wanted the second-to-last piorbit desktop log.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 1_000_000;

export class DesktopLog {
  private failed = false;

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
