/**
 * Running a Task's declared verification commands, bounded and stoppable
 * (M21-T19).
 *
 * This is the only part of a verification run that executes anything, and it
 * is in the worker because the worker is what owns a checkout. Five rules, all
 * of them the ones `docs/agents.md` §6 already holds a background command to:
 *
 * - **Bounded output.** The bytes are counted exactly and digested exactly;
 *   what is kept is the tail, and a record whose bytes were cut says
 *   `truncated` rather than implying the output was complete.
 * - **Stoppable.** A person's stop kills the process tree, and the command's
 *   record says `stopped` — not `failed`, because nothing failed.
 * - **A record is written when the process has really gone.** Asking a
 *   process to end is not the same as it ending, and the last thing a failing
 *   command prints is usually the line that says why. So the record is made
 *   when the child has exited *and* its output is closed — never at the
 *   moment a signal was sent — and it is made exactly once. If the process
 *   tree could not be ended at all, no record is invented for it: the run
 *   stays unsettled, which is what keeps its session pinned and its row
 *   honest, and one bounded line says why.
 * - **Exit codes are facts.** A command that is not there is `unavailable`
 *   with the sentence that says so; a command that ran is its exit code and
 *   nothing more. Nothing here decides what an exit code *means*: that is the
 *   host's, from the criteria it derived.
 * - **No shell interpolation of anything but the declared line.** The command
 *   is the exact string the Task's own revision declares, run in the Task's
 *   own checkout, with the environment the project already uses.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  VERIFICATION_COMMAND_TAIL_BYTES,
  VERIFICATION_COMMAND_TIMEOUT_MS,
  type VerificationCommandRun,
} from "@lasercode/protocol";
import { noteWorkerProcess } from "../../process-registry.js";

/**
 * How long the record waits for a command's output to close after the process
 * itself has gone.
 *
 * A grandchild that inherited the pipe and outlived its parent can hold it
 * open for ever, and a verification run that waits for ever is a session that
 * can never be released. So the wait is bounded, and a record made on that
 * bound says its output may be short rather than pretending it is whole.
 */
export const VERIFICATION_STDIO_GRACE_MS = 2_000;

/** What a person is told about the command they stopped. */
const STOPPED_DETAIL = "You stopped this verification run.";

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Resolves when a person stops the run; the process tree is killed. */
  signal?: AbortSignal;
  now?: () => Date;
  /** How long to wait for output to close after the process has gone. */
  stdioGraceMs?: number;
  /**
   * How a child is started, and how its process tree is ended.
   *
   * Seams, so the lifecycle above can be driven exactly — a close that comes
   * late, output after the exit, a stop, a timeout, a spawn that throws, a
   * tree that refuses to die — with an inert double and never a real process
   * on the machine running the tests. Production passes neither.
   */
  spawnProcess?: (command: string, options: SpawnOptions) => ChildProcess;
  killTree?: (child: ChildProcess) => void;
  /** One bounded diagnostic line. Never the command, never its output. */
  log?: (line: string) => void;
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
 * End a whole process tree, the way this worker already ends the ones it owns
 * (`agents/worktrees.ts`, `project-env.ts`): the process group on POSIX, and
 * `taskkill /T` on Windows, where there is no group to signal and killing the
 * shell alone would leave the test runner it started behind.
 *
 * It throws when the system refused, and that refusal matters: a caller may
 * not record an exit it did not see.
 */
export function killVerificationTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
    return;
  }
  try {
    // Negative pid: the whole group, so a grandchild dies with its parent.
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    // Already gone is not a failure to end it.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
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
  const graceMs = options.stdioGraceMs ?? VERIFICATION_STDIO_GRACE_MS;
  const log = options.log ?? ((line: string) => console.error(line));

  const record = (status: VerificationCommandRun["status"], exitCode?: number, detail?: string): VerificationCommandRun => {
    const bounded = output.done();
    return {
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
    };
  };

  // A run that was already stopped starts nothing. Spawning a process in
  // order to kill it immediately is work a person asked not to happen, and
  // leaves a tree to clean up that never needed to exist.
  if (options.signal?.aborted === true) return record("stopped", undefined, STOPPED_DETAIL);

  return await new Promise<VerificationCommandRun>((resolve) => {
    let settled = false;
    // Declared before anything can reach them: a spawn that throws
    // synchronously must not touch a binding that does not exist yet.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    /** Why this command was asked to end, if it was. */
    let ending: { status: VerificationCommandRun["status"]; detail: string } | undefined;
    /** What the child's own `error` event said, for a process that had started. */
    let spawnProblem: string | undefined;
    /** The system refused to end the tree. No exit may be claimed after this. */
    let terminationProblem: string | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    const detach = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (status: VerificationCommandRun["status"], exitCode?: number, detail?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      detach();
      resolve(record(status, exitCode, detail));
    };

    /**
     * The process has gone and its output is closed (or the bounded wait for
     * that close ran out). This is the only place a record is made from a
     * process that really ran.
     */
    const settleFrom = (code: number | null, signal: NodeJS.Signals | null, onGrace: boolean): void => {
      if (settled) return;
      const cut = onGrace ? " Its output was still open when it ended, so the last of it may be missing." : "";
      if (ending !== undefined) {
        finish(ending.status, undefined, `${ending.detail}${cut}`);
        return;
      }
      if (spawnProblem !== undefined) {
        finish("unavailable", undefined, spawnProblem);
        return;
      }
      if (signal !== null) {
        finish("stopped", undefined, `The command ended on ${signal}.${cut}`);
        return;
      }
      const exitCode = code ?? 1;
      finish(exitCode === 0 ? "passed" : "failed", exitCode, cut === "" ? undefined : cut.trim());
    };

    /**
     * Ask the tree to end, and remember why. Deliberately does **not** settle:
     * a signal sent is not a process gone, and a record written here would be
     * a confirmation nobody witnessed.
     */
    const end = (status: VerificationCommandRun["status"], detail: string): void => {
      if (settled || child === undefined) return;
      ending ??= { status, detail };
      try {
        (options.killTree ?? killVerificationTree)(child);
      } catch (error) {
        if (terminationProblem !== undefined) return;
        const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : "an error");
        terminationProblem = String(code).slice(0, 40);
        // No record is made: the run stays unsettled, so its row keeps saying
        // there is work here and its conversation stays pinned — which is the
        // truth. One bounded line, with the system's code and nothing the
        // command read, says why that is.
        log(
          `a verification command's process tree could not be ended (${terminationProblem}); the run stays unsettled until it closes`,
        );
      }
    };

    const onAbort = (): void => end("stopped", STOPPED_DETAIL);

    try {
      child = (options.spawnProcess ?? spawn)(options.command, {
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

    // A process this worker started on purpose, so the host's inventory can
    // name it rather than calling it an unknown descendant (RP-1).
    if (child.pid !== undefined) noteWorkerProcess({ pid: child.pid, role: "helper", label: "verification-command" });

    child.stdout?.on("data", (chunk: Buffer) => output.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.add(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      const detail = error.code === "ENOENT" ? "That command is not on this machine's PATH." : error.message;
      // A process that never started has no exit to wait for and no output to
      // drain, so this *is* its ending. One that had started keeps its
      // lifecycle: the record is still made when it closes.
      if (child?.pid === undefined) {
        finish("unavailable", undefined, detail);
        return;
      }
      spawnProblem ??= detail;
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      if (settled || grace !== undefined) return;
      // The process has gone but its last writes may still be in flight, and
      // a pipe a grandchild inherited may never close. Bounded, so a run can
      // always settle and its session can always be released.
      grace = setTimeout(() => settleFrom(code, signal, true), graceMs);
      grace.unref?.();
    });
    child.on("close", (code, signal) => {
      settleFrom(code ?? exit?.code ?? null, signal ?? exit?.signal ?? null, false);
    });

    timer = setTimeout(() => {
      end("stopped", `This command was still running after ${String(Math.round(timeoutMs / 60_000))} minutes and was ended.`);
    }, timeoutMs);
    timer.unref?.();

    options.signal?.addEventListener("abort", onAbort, { once: true });
    // A stop that landed while the child was being spawned is still a stop.
    if (options.signal?.aborted === true) onAbort();
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
