/**
 * Running a Task's declared verification commands, bounded and stoppable
 * (M21-T19).
 *
 * This is the only part of a verification run that executes anything, and it
 * is in the worker because the worker is what owns a checkout. Four rules, all
 * of them the ones `docs/agents.md` §6 already holds a background command to:
 *
 * - **Bounded output.** The bytes are counted exactly and digested exactly;
 *   what is kept is the tail, and a record whose bytes were cut says
 *   `truncated` rather than implying the output was complete.
 * - **Stoppable.** A person's stop kills the process tree, and the command's
 *   record says `stopped` — not `failed`, because nothing failed.
 * - **Exit codes are facts.** A command that is not there is `unavailable`
 *   with the sentence that says so; a command that ran is its exit code and
 *   nothing more. Nothing here decides what an exit code *means*: that is the
 *   host's, from the criteria it derived.
 * - **No shell interpolation of anything but the declared line.** The command
 *   is the exact string the Task's own revision declares, run in the Task's
 *   own checkout, with the environment the project already uses.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  VERIFICATION_COMMAND_TAIL_BYTES,
  VERIFICATION_COMMAND_TIMEOUT_MS,
  type VerificationCommandRun,
} from "@lasercode/protocol";

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Resolves when a person stops the run; the process tree is killed. */
  signal?: AbortSignal;
  now?: () => Date;
}

/** One command, as a run records it. A seam, so a test can script pass/fail. */
export type VerificationCommandRunner = (options: RunCommandOptions) => Promise<VerificationCommandRun>;

/** The bytes a record keeps of one command, with the exact count and digest. */
class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private total = 0;
  private readonly hash = createHash("sha256");

  add(chunk: Buffer): void {
    this.total += chunk.byteLength;
    this.hash.update(chunk);
    this.chunks.push(chunk);
    this.kept += chunk.byteLength;
    // Keep a rolling tail: the end of a failing run is what says why.
    while (this.kept > VERIFICATION_COMMAND_TAIL_BYTES * 2 && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.kept -= dropped?.byteLength ?? 0;
    }
  }

  done(): { bytes: number; digest: string; tail: string; truncated: boolean } {
    const buffer = Buffer.concat(this.chunks);
    const tail = buffer.subarray(Math.max(0, buffer.byteLength - VERIFICATION_COMMAND_TAIL_BYTES)).toString("utf8");
    return {
      bytes: this.total,
      digest: this.hash.digest("hex"),
      tail,
      truncated: this.total > Buffer.byteLength(tail, "utf8"),
    };
  }
}

/**
 * The real runner.
 *
 * `spawn` with the platform shell, detached so the whole tree can be ended by
 * one signal: a verification command is usually a package script, and killing
 * only the script leaves the test runner behind.
 */
export const runVerificationCommand: VerificationCommandRunner = async (options) => {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const output = new BoundedOutput();
  const timeoutMs = options.timeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS;

  return await new Promise<VerificationCommandRun>((resolve) => {
    let settled = false;
    const finish = (status: VerificationCommandRun["status"], exitCode?: number, detail?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const bounded = output.done();
      resolve({
        command: options.command,
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        startedAt,
        endedAt: clock().toISOString(),
        outputBytes: bounded.bytes,
        outputDigest: bounded.digest,
        tail: bounded.tail,
        ...(bounded.truncated ? { truncated: true } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, {
        cwd: options.cwd,
        shell: true,
        detached: process.platform !== "win32",
        env: { ...process.env, ...options.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish("unavailable", undefined, error instanceof Error ? error.message : "The command could not be started.");
      return;
    }

    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone. Nothing to end.
      }
    };
    const onAbort = (): void => {
      kill();
      finish("stopped", undefined, "You stopped this verification run.");
    };
    const timer = setTimeout(() => {
      kill();
      finish("stopped", undefined, `This command was still running after ${String(Math.round(timeoutMs / 60_000))} minutes and was ended.`);
    }, timeoutMs);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => output.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.add(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        "unavailable",
        undefined,
        error.code === "ENOENT" ? "That command is not on this machine's PATH." : error.message,
      );
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        finish("stopped", undefined, `The command ended on ${signal}.`);
        return;
      }
      const exit = code ?? 1;
      finish(exit === 0 ? "passed" : "failed", exit);
    });
  });
};

/** The record a command that never ran gets, so a report is never silent. */
export function notRun(command: string, at: string, detail: string): VerificationCommandRun {
  return {
    command,
    status: "not_run",
    startedAt: at,
    endedAt: at,
    outputBytes: 0,
    outputDigest: createHash("sha256").digest("hex"),
    tail: "",
    detail,
  };
}
