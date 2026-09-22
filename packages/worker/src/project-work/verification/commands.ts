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
 *   moment a signal was sent, and never on a timer — and it is made exactly
 *   once. No clock can stand in for that close: a grandchild that inherited
 *   the pipe is still this command's output, and a record made while it is
 *   still writing would release the session's pin under live work and then
 *   have its own byte count and digest changed behind it. If the process tree
 *   could not be ended at all, or its output stays open, no record is
 *   invented: the run stays unsettled, which is what keeps its session pinned
 *   and its row honest, and one bounded line says why.
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
 * How long after a command's process has gone this waits quietly for its
 * output to close before doing something about it.
 *
 * It is **not** a deadline for the record: nothing is settled on this timer.
 * A pipe still open after a child exited belongs to something that child
 * started and left behind, so what the timer does is ask for the owned tree
 * to be cleaned up once — the group signal closes the descendants that are
 * holding it — and say, in one bounded line, that this run is waiting. If the
 * output never closes, the run never settles, its row keeps saying there is
 * work here and its conversation stays pinned. That is the truth, and a
 * fabricated ending would not be.
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
  /**
   * End the process tree. `onProblem` is how a refusal that only shows up
   * later is reported: on Windows the kill is another process, so its failure
   * arrives after this function has returned, and a callback that dropped it
   * would turn "the app could not end this" into silence.
   */
  killTree?: (child: ChildProcess, onProblem: (code: string) => void) => void;
  /** One bounded diagnostic line. Never the command, never its output. */
  log?: (line: string) => void;
  /**
   * Something a person watching this run should be told while it is still
   * happening: the tree would not end, or its output has not closed.
   *
   * A sentence, bounded and written here — never a command line, a path, a
   * byte of output or an error's own words. It is deliberately *not* an
   * ending: this command is still unsettled, its session is still pinned and
   * its record will still be made from the close when the close comes. An
   * observer that throws changes none of that (see {@link RunCommandOptions.log}):
   * a diagnostic does not decide whether work settles.
   */
  onProblem?: (problem: string) => void;
}

/**
 * What a person is told while a command this app asked to end is still there.
 *
 * Two sentences, and both of them true of a run that has *not* finished: what
 * the app could not do, and what it is now waiting for. Neither carries the
 * command, its output, a path or an error's message — the platform's own short
 * code is the most a refusal says, because a code is a fact and a message is
 * a sentence somebody else wrote about this machine.
 */
export const COMMAND_STILL_RUNNING_PROBLEM = {
  cannotEnd: (code: string) =>
    `This run's command could not be stopped (${code}), so it is still running. The run stays open until that process closes — nothing has been recorded for it.`,
  lingering:
    "This command has ended, but something it started still has its output open. The run stays open until that closes — nothing has been recorded for it.",
} as const;

/** One command, as a run records it. A seam, so a test can script pass/fail. */
export type VerificationCommandRunner = (options: RunCommandOptions) => Promise<VerificationCommandRun>;

/** The bytes a record keeps of one command, with the exact count and digest. */
class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private total = 0;
  private readonly hash = createHash("sha256");
  /**
   * The count, the digest and the tail, fixed at the one moment the record is
   * made.
   *
   * Computed once and kept: a digest is a claim about exactly the bytes it
   * covers, so a second call must answer the same thing rather than hashing
   * again, and a chunk that somehow arrives after the record exists may not
   * quietly change what that record says.
   */
  private finalized: { bytes: number; digest: string; tail: string; truncated: boolean } | undefined;

  add(chunk: Buffer): void {
    if (this.finalized !== undefined) return;
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
    if (this.finalized !== undefined) return this.finalized;
    const buffer = Buffer.concat(this.chunks);
    const tail = buffer.subarray(Math.max(0, buffer.byteLength - VERIFICATION_COMMAND_TAIL_BYTES)).toString("utf8");
    this.finalized = {
      bytes: this.total,
      digest: this.hash.digest("hex"),
      tail,
      truncated: this.total > Buffer.byteLength(tail, "utf8"),
    };
    return this.finalized;
  }
}

/**
 * What one refusal to end a process tree is allowed to say.
 *
 * A system's own code (`EPERM`, `ESRCH`, an exit status) and nothing else: the
 * error's message can name the command, a path or a machine's user, and this
 * line travels to a log. Bounded, because a code is short and anything long
 * is not a code.
 */
function terminationCode(error: unknown): string {
  const known = error as (NodeJS.ErrnoException & { status?: unknown }) | undefined;
  // A killer that ran and refused reports an exit status rather than an errno.
  const status = typeof known?.status === "number" ? `exit ${String(known.status)}` : undefined;
  const code = known?.code ?? status ?? (error instanceof Error ? error.name : undefined);
  return String(code ?? "an error").slice(0, 40);
}

/**
 * `taskkill`'s own status for "there is no such process".
 *
 * Windows has no `ESRCH` to give: the kill is another program, so it answers
 * by exiting, and `execFile` hands that exit status back as a **number** in
 * `error.code`. 128 is the one `taskkill` uses for a pid it cannot find, which
 * is the ordinary outcome of stopping a run whose tree has already ended by
 * itself — the commonest stop there is.
 */
const TASKKILL_NOT_FOUND = 128;

/**
 * Was the tree already gone when the kill got there?
 *
 * Both spellings of the same news: the errno a system call gives, and the exit
 * status `taskkill` gives. Neither is a failure to end a process tree, so
 * neither reaches the person as one. Every other refusal still does.
 */
function treeAlreadyGone(error: unknown): boolean {
  const known = error as { code?: unknown; status?: unknown } | undefined;
  if (known?.code === "ESRCH") return true;
  return known?.code === TASKKILL_NOT_FOUND || known?.status === TASKKILL_NOT_FOUND;
}

/**
 * The parts of the platform this kill uses, so a test can drive the Windows
 * path on any machine without a real process anywhere near it.
 *
 * Production passes none of them.
 */
export interface KillTreeSeams {
  platform?: NodeJS.Platform;
  runTaskkill?: (arguments_: string[], done: (error: unknown) => void) => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * End a whole process tree, the way this worker already ends the ones it owns
 * (`agents/worktrees.ts`, `project-env.ts`): the process group on POSIX, and
 * `taskkill /T` on Windows, where there is no group to signal and killing the
 * shell alone would leave the test runner it started behind.
 *
 * Both halves of a refusal reach the caller, because a caller may not record
 * an exit it did not see. On POSIX the system answers immediately and this
 * throws. On Windows the kill is *another process*, so its refusal arrives
 * later — through `onProblem`, which is the same news by the only route it
 * can take. Dropping it would leave a tree this app could not end looking
 * exactly like one it ended.
 */
export function killVerificationTree(child: ChildProcess, onProblem?: (code: string) => void, seams: KillTreeSeams = {}): void {
  if (child.pid === undefined) return;
  const platform = seams.platform ?? process.platform;
  if (platform === "win32") {
    const run =
      seams.runTaskkill ??
      ((arguments_: string[], done: (error: unknown) => void) => {
        execFile("taskkill", arguments_, (error) => done(error));
      });
    // A synchronous throw here is the caller's to handle, exactly like the
    // POSIX branch's: it is the same refusal, arriving sooner.
    run(["/pid", String(child.pid), "/T", "/F"], (error) => {
      if (error === null || error === undefined) return;
      // The process is gone already: `taskkill` says so with its own exit
      // status, and "already ended" is not a failure to end it — exactly as
      // `ESRCH` is not one on POSIX. Saying otherwise would tell a person a
      // run they stopped is still running, in the most ordinary stop there is.
      if (treeAlreadyGone(error)) return;
      onProblem?.(terminationCode(error));
    });
    return;
  }
  try {
    // Negative pid: the whole group, so a grandchild dies with its parent.
    (seams.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal)))(-child.pid, "SIGKILL");
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
  /**
   * Say one bounded line, and survive a sink that cannot take it.
   *
   * Every caller of this is somewhere a failure has *already* happened: a
   * kill that was refused, or output that will not close. Those places run
   * inside an abort listener and inside an asynchronous kill callback, where a
   * throw has nobody to catch it — it would escape as a worker-wide unhandled
   * error, and the run it was about would be left with no record made and no
   * one waiting on its promise. So the observer is guarded, exactly as the
   * registry's is: a diagnostic never decides whether work settles.
   */
  const note = (line: string): void => {
    try {
      (options.log ?? ((text: string) => console.error(text)))(line);
    } catch {
      // Nothing left to say it with, and nothing here depends on having said
      // it. The command's own lifecycle is untouched.
    }
  };
  /** Tell whoever is watching, and survive them too. Same rule as `note`. */
  const raise = (problem: string): void => {
    try {
      options.onProblem?.(problem);
    } catch {
      // An observer that threw has lost this sentence, not this run.
    }
  };

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
    let waiting: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    /** Why this command was asked to end, if it was. */
    let ending: { status: VerificationCommandRun["status"]; detail: string } | undefined;
    /** What the child's own `error` event said, for a process that had started. */
    let spawnProblem: string | undefined;
    /** The system refused to end the tree. No exit may be claimed after this. */
    let terminationProblem: string | undefined;
    /** The process had gone and its output was still open past the wait. */
    let lingered = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    /**
     * Everything this command is still attached to, let go of at once.
     *
     * The output listeners go with the rest: past the record, a late chunk
     * would be counted into a byte total and a digest that have already been
     * published as facts. (`BoundedOutput` refuses it too — two locks on the
     * same door, because this one is the one a future edit can forget.)
     */
    const detach = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      child?.stdout?.removeAllListeners("data");
      child?.stderr?.removeAllListeners("data");
    };
    const finish = (status: VerificationCommandRun["status"], exitCode?: number, detail?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (waiting !== undefined) clearTimeout(waiting);
      detach();
      resolve(record(status, exitCode, detail));
    };

    /**
     * The process has gone **and** its output is closed. This is the only
     * place a record is made from a process that really ran, and `close` is
     * the only event that reaches it.
     */
    const settleFrom = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      // It took asking twice, or waiting past the point where this run said so
      // out loud. The bytes are all here — that is what the waiting was for —
      // so the record says what happened rather than hedging about its own
      // completeness.
      const late = lingered ? " Its output stayed open after it ended, and this record waited for it." : "";
      if (ending !== undefined) {
        finish(ending.status, undefined, `${ending.detail}${late}`);
        return;
      }
      if (spawnProblem !== undefined) {
        finish("unavailable", undefined, spawnProblem);
        return;
      }
      if (signal !== null) {
        finish("stopped", undefined, `The command ended on ${signal}.${late}`);
        return;
      }
      const exitCode = code ?? 1;
      finish(exitCode === 0 ? "passed" : "failed", exitCode, late === "" ? undefined : late.trim());
    };

    /**
     * Ask the tree to end, and remember why. Deliberately does **not** settle:
     * a signal sent is not a process gone, and a record written here would be
     * a confirmation nobody witnessed.
     */
    /**
     * The tree would not end — now, or later, because on Windows the answer
     * comes back from another process long after the call returned.
     *
     * No record is made either way: the run stays unsettled, so its row keeps
     * saying there is work here and its conversation stays pinned — which is
     * the truth. One bounded line, with the system's code and nothing the
     * command read, says why that is. Said once: a second attempt on the same
     * tree is the same refusal, not news.
     */
    const cannotEnd = (error: unknown): void => {
      if (settled || terminationProblem !== undefined) return;
      terminationProblem = terminationCode(error);
      note(`a verification command's process tree could not be ended (${terminationProblem}); the run stays unsettled until it closes`);
      // And to the person watching, not only to a log they will never open: a
      // run that sits there with a live line and no explanation is the app
      // knowing something and not saying it.
      raise(COMMAND_STILL_RUNNING_PROBLEM.cannotEnd(terminationProblem));
    };

    const kill = (): void => {
      if (child === undefined) return;
      try {
        (options.killTree ?? killVerificationTree)(child, (code) => cannotEnd({ code }));
      } catch (error) {
        cannotEnd(error);
      }
    };

    const end = (status: VerificationCommandRun["status"], detail: string): void => {
      if (settled || child === undefined) return;
      ending ??= { status, detail };
      kill();
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
      if (settled || waiting !== undefined) return;
      // The process has gone; its output has not closed yet. Whatever is still
      // holding that pipe is something this command started, so after a short
      // wait the owned tree is asked to go — once — and this run says out loud
      // that it is waiting. It does **not** settle here: a record written now
      // would release this session's pin while a descendant is still writing
      // into the very bytes that record counts.
      waiting = setTimeout(() => {
        if (settled) return;
        lingered = true;
        kill();
        note(
          `a verification command's output was still open ${String(graceMs)}ms after it ended; the run stays unsettled until it closes`,
        );
        raise(COMMAND_STILL_RUNNING_PROBLEM.lingering);
      }, graceMs);
      waiting.unref?.();
    });
    child.on("close", (code, signal) => {
      settleFrom(code ?? exit?.code ?? null, signal ?? exit?.signal ?? null);
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
