/**
 * WorkerClient — spawns one `laser-worker` for one cwd and speaks JSON-RPC
 * to it over the fd-3 pipe. Correlates requests by id, forwards notifications,
 * and reports exit. The host never imports Pi; it only resolves the worker's
 * entry file path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { oldSpaceBytes, oldSpaceSizeFlag } from "./heap-ceiling.js";
import {
  ENV,
  ErrorCodes,
  FRAME_MAX_BYTES,
  LineDecoder,
  isNotification,
  isResponse,
  nodeLaunchEnvironment,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcNotification,
  runtimeFailureSchema,
  type LineDecoderStats,
  type RuntimeFailure,
  type RuntimeFailureCategory,
  type WorkerMode,
  type WorkerNotifications,
} from "@lasercode/protocol";

export interface WorkerClientOptions {
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  /**
   * The host's own state directory (`agents.json`, `agent-runs.json`, the
   * workspaces beside it). The worker uses it to describe Laser's data layout;
   * a worker that does not know the flag ignores it.
   */
  stateDir?: string;
  /**
   * Whether Pi may load this project's own `.pi` resources (M2-T4). The host
   * decides (see projects.ts / trust.ts) and passes the answer down as
   * `--project-trusted yes|no`; omitting it leaves the worker on Pi's own
   * default, which is "trusted".
   */
  projectTrusted?: boolean;
  /**
   * The environment its durable revisions belong to (RP-9), so a live session
   * and the same session read from disk produce the same value. Not a secret,
   * but never published: only its derived key reaches a client.
   */
  environmentId?: string;
  /**
   * Whether this installation's log store keeps provider request bodies
   * (RP-7). `"summary"` is passed down as `--provider-payloads summary` and
   * the worker never serializes a body at all; a worker that does not know the
   * flag ignores it.
   */
  providerPayloads?: "full" | "summary";
  /**
   * This spawn's memory-pressure generation (RP-8), minted by the host with
   * {@link nextWorkerGeneration}. Omitted only by a caller that has none, and
   * the worker then refuses to report or to act on a directive.
   */
  workerGeneration?: number;
  /** Explicit V8 old-space ceiling for this exact worker spawn, in MiB. */
  oldSpaceMiB?: number;
  /** Effective feature mode for this spawn; desired preferences are never changed here. */
  mode?: WorkerMode;
  /** Path to the worker entry; defaults to the workspace `@lasercode/worker` build. */
  workerMain?: string;
  /** Node binary to run the worker with; defaults to the current one. */
  nodeBinary?: string;
  /** Memory-only shell environment, refreshed by local launchers. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Extra environment for the worker, on top of the host's own. */
  env?: Readonly<Record<string, string>>;
  onNotification: (notification: JsonRpcNotification) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null, exit: WorkerExit) => void;
  onStderr?: (text: string) => void;
}

export type WorkerExitKind = RuntimeFailureCategory;
export interface WorkerExit {
  kind: WorkerExitKind;
  code: number | null;
  signal: NodeJS.Signals | null;
  failure: RuntimeFailure;
}

const OOM_MARKER = /Reached heap limit|JavaScript heap out of memory|Allocation failed/i;
const STDERR_MARKER_WINDOW = 4096;

/** Marker plus abnormal termination: neither a SIGABRT nor a stray log line is enough alone. */
export function classifyWorkerExit(
  stderrTail: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): WorkerExitKind {
  const abnormal = signal !== null || (code !== null && code !== 0);
  return abnormal && OOM_MARKER.test(stderrTail) ? "heap_oom" : "process_exit";
}

export class WorkerRpcError extends Error {
  override readonly name = "WorkerRpcError";
  constructor(public readonly rpc: JsonRpcError) {
    super(rpc.message);
  }
}

/**
 * A request refused because this worker is being retired (RP-4).
 *
 * The important part is `written === false`: the bytes never reached the pipe,
 * so the call had no effect at all and a caller may safely send it again —
 * including a `session/prompt`, which is the one call that would be unsafe to
 * repeat if it might have been delivered. Admission is closed before the
 * retirement question is asked and, if the worker acknowledges, never reopens;
 * nothing is queued, because a queue is memory a peer controls (RP-7).
 */
export class WorkerRetiredError extends Error {
  override readonly name = "WorkerRetiredError";
  readonly written = false;
  constructor(readonly cwd: string) {
    super("This project's worker was stopped before that reached it; it will start again on the next request.");
  }
}

/**
 * The next memory-pressure generation this host process will hand to a worker
 * (RP-8).
 *
 * One counter for the life of the host, starting at 1 and only ever going up,
 * so a worker that is replaced can never be mistaken for the one that took its
 * place. It fails closed rather than wrapping: past the last integer a number
 * can represent exactly, there is no value that is still distinct, so the host
 * hands out none and the worker simply does not take part in pressure. (At one
 * spawn a millisecond that is a quarter of a million years away; the branch
 * exists because wrapping would silently make two workers equal.)
 */
let lastWorkerGeneration = 0;
export function nextWorkerGeneration(): number | undefined {
  if (lastWorkerGeneration >= Number.MAX_SAFE_INTEGER) return undefined;
  lastWorkerGeneration += 1;
  return lastWorkerGeneration;
}

export function defaultWorkerMain(): string {
  return createRequire(import.meta.url).resolve("@lasercode/worker/main");
}

export class WorkerClient {
  /**
   * This process's identity for anything the host keys by "which worker said
   * that" (RP-7 captures). Opaque and random on purpose: a pid, a start token
   * or a directory would be host-internal data with meaning elsewhere, and
   * this value is never logged, never stored and never sent to a client.
   */
  readonly generation: string = randomBytes(8).toString("hex");
  /** Exact 128-bit child identity, minted before spawn and required on its first frame. */
  readonly launchId: string = randomBytes(16).toString("hex");
  /**
   * What *this spawn* is, as a number the worker can prove it was given (RP-8).
   *
   * The worker stamps it on the memory-pressure reports it sends unasked and
   * checks it on every directive, so a message from a process the host has
   * already replaced can be refused rather than acted on. It is minted by the
   * host before the process exists and passed in argv, which is why a worker
   * can carry it truthfully from its first sample; the worker never invents,
   * echoes or derives one. Absent (a direct client in a test, a caller that
   * did not mint one) the worker fails closed and neither reports nor accepts
   * a directive.
   *
   * Deliberately not {@link generation}, which is the opaque capture identity
   * (RP-7), and deliberately not the RP-1 ownership record's generation, which
   * is keyed by pid and minted after the spawn.
   */
  readonly workerGeneration: number | undefined;
  /** What this exact child was explicitly asked to use; absent means unconfigured. */
  readonly configuredOldSpaceBytes: number | undefined;
  private readonly child: ChildProcess;
  private readonly pipe: Duplex;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private exited = false;
  /** Set when `stop()` closes the pipe, before the child has actually exited. */
  private ending = false;
  /** RP-4: closed while a retirement is being decided, so nothing is written. */
  private admissionClosed = false;
  /** Set once, so a spawn `error` followed by an `exit` reports one incident. */
  private reported = false;
  /**
   * The spawn itself failed (bad node binary, missing worker entry, EACCES).
   * Node emits `error` and never `exit` for these, so the pool needs to be able
   * to tell "never started" from "exited", and to say which in the UI.
   */
  private startError: Error | undefined;
  private decoder: LineDecoder | undefined;
  /** Complete messages handed to the pipe and not yet written. */
  private inFlightWrites = 0;
  private rejectReady: ((error: Error) => void) | undefined;
  /** Only enough stderr to recognize stable fatal markers; never surfaced as status copy. */
  private stderrMarkerTail = "";
  private announced = false;
  private becameReady = false;
  readonly ready: Promise<void>;

  constructor(private readonly options: WorkerClientOptions) {
    const args: string[] = [];
    this.configuredOldSpaceBytes = options.oldSpaceMiB === undefined ? undefined : oldSpaceBytes(options.oldSpaceMiB);
    if (options.oldSpaceMiB !== undefined) args.push(oldSpaceSizeFlag(options.oldSpaceMiB));
    args.push(
      options.workerMain ?? defaultWorkerMain(),
      "--cwd",
      options.cwd,
      "--launch-id",
      this.launchId,
      "--worker-mode",
      options.mode ?? "normal",
    );
    if (options.agentDir) args.push("--agent-dir", options.agentDir);
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.stateDir) args.push("--state-dir", options.stateDir);
    if (options.projectTrusted !== undefined) args.push("--project-trusted", options.projectTrusted ? "yes" : "no");
    if (options.environmentId) args.push("--environment-id", options.environmentId);
    if (options.providerPayloads) args.push("--provider-payloads", options.providerPayloads);
    this.workerGeneration = options.workerGeneration;
    if (options.workerGeneration !== undefined) args.push("--worker-generation", String(options.workerGeneration));

    // Node reads this before our entry exists. An inherited value could raise,
    // lower or invalidate the explicit ceiling, so no spelling reaches a child.
    const env = nodeLaunchEnvironment({ ...(options.baseEnv ?? process.env), ...options.env, [ENV.workerFd]: "3" });
    this.child = spawn(options.nodeBinary ?? process.execPath, args, {
      // --cwd configures the driver; it does not change the process directory.
      // Engine defaults and subprocesses must never inherit the host's state cwd.
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env,
    });
    this.pipe = this.child.stdio[3] as Duplex;
    // A notification can race a worker exit before the process's exit event.
    // Pending requests still settle through exit; EPIPE must not crash the host.
    this.pipe.on("error", () => {});

    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.rejectReady = rejectReady;

    // Bytes, not text: the decoder owns the UTF-8 boundary, so a frame's size
    // is its exact byte count and a multi-byte character split across two pipe
    // chunks is simply two pieces that are joined before they are decoded.
    const decoder = new LineDecoder({
      maxFrameBytes: FRAME_MAX_BYTES,
      onOverflow: ({ bytes }) => this.faultGeneration(bytes),
    });
    this.decoder = decoder;
    this.pipe.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          if (!this.announced) this.faultLaunch("launch_identity_missing");
          continue;
        }
        if (!this.announced) {
          const params = isNotification(message) && message.method === "pi/worker/status"
            ? message.params as { cwd?: unknown; status?: unknown; launchId?: unknown }
            : undefined;
          if (params?.status !== "starting" || params.cwd !== options.cwd || params.launchId !== this.launchId) {
            this.faultLaunch(params?.launchId === undefined ? "launch_identity_missing" : "launch_identity_mismatch");
            continue;
          }
          this.announced = true;
          options.onNotification(message as JsonRpcNotification);
          continue;
        }
        if (isResponse(message)) {
          const entry = this.pending.get(Number(message.id));
          if (!entry) continue;
          this.pending.delete(Number(message.id));
          if (message.error) entry.reject(new WorkerRpcError(message.error));
          else entry.resolve(message.result);
        } else if (isNotification(message)) {
          if (message.method === "pi/worker/status") {
            const params = message.params as { status?: unknown; launchId?: unknown; failure?: unknown };
            if (params.launchId !== this.launchId) {
              this.faultLaunch(params.launchId === undefined ? "launch_identity_missing" : "launch_identity_mismatch");
              continue;
            }
            if (params.status === "ready") {
              this.becameReady = true;
              resolveReady();
            } else if (params.status === "crashed" && !this.becameReady) {
              const parsed = runtimeFailureSchema.safeParse(params.failure);
              const failure = parsed.success ? parsed.data : this.failureFor("initialization_error");
              this.faultLaunch(failure.category, failure);
              continue;
            }
          }
          options.onNotification(message);
        }
      }
    });
    this.child.stderr?.on("data", (c: Buffer) => {
      const text = c.toString();
      this.stderrMarkerTail = `${this.stderrMarkerTail}${text}`.slice(-STDERR_MARKER_WINDOW);
      options.onStderr?.(text);
    });
    this.child.stdout?.on("data", () => {}); // drain; Pi/extension logs are not ours
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.settle(new Error(`worker for ${options.cwd} exited (${code ?? signal})`), rejectReady, code, signal);
    });
    this.child.on("error", (error) => {
      // No `exit` follows a failed spawn, so this is the only chance to unblock
      // `ready`, fail the pending calls, and tell the pool the worker is gone.
      this.exited = true;
      this.startError ??= error;
      this.settle(error, rejectReady, null, null, "spawn_error");
    });
  }

  /**
   * One line to the worker, counted from here until the pipe has taken it.
   * The count is what the diagnostics call a queued message; the bytes beside
   * it are the stream's own.
   */
  private writeLine(line: string): void {
    this.inFlightWrites += 1;
    this.pipe.write(line, () => {
      this.inFlightWrites = Math.max(0, this.inFlightWrites - 1);
    });
  }

  /** Fail everything in flight and report the exit, exactly once. */
  private settle(
    error: Error,
    rejectReady: (e: Error) => void,
    code: number | null,
    signal: NodeJS.Signals | null,
    kind = classifyWorkerExit(this.stderrMarkerTail, code, signal),
    failure = this.failureFor(kind),
  ): void {
    if (this.reported) return;
    this.reported = true;
    // Nothing is owed on a link that is gone, and a late callback cannot make
    // it negative or resurrect a count.
    this.inFlightWrites = 0;
    rejectReady(error);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.options.onExit(code, signal, { kind, code, signal, failure });
  }

  private failureFor(kind: WorkerExitKind): RuntimeFailure {
    const stage = kind === "spawn_error" ? "spawn" : kind.startsWith("launch_identity_") ? "announce" : kind === "initialization_error" ? "initialize" : "runtime";
    const message = kind === "heap_oom"
      ? "This project's agent ran out of memory."
      : kind === "spawn_error"
        ? "This project's runtime could not start. Check the app installation, then try again."
        : kind === "launch_identity_missing" || kind === "launch_identity_mismatch"
          ? "The app could not verify the project runtime it started. Try again; if this continues, update or reinstall the app."
          : kind === "transport_fault"
            ? "The project runtime sent an invalid message and was stopped. Try again."
            : kind === "initialization_error"
              ? "This project's runtime did not start. Try again; if this continues, update or reinstall the app."
              : "This project's runtime stopped before the work finished.";
    return {
      owner: { kind: "worker", launchId: this.launchId, cwd: this.options.cwd },
      stage,
      category: kind,
      message,
    };
  }

  /** A missing or mismatched first-frame identity can never become ready. */
  private faultLaunch(kind: WorkerExitKind, failure = this.failureFor(kind)): void {
    if (this.reported) return;
    this.exited = true;
    const error = new Error(failure.message);
    try { this.pipe.destroy(); } catch { /* already closed */ }
    try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
    this.settle(error, this.rejectReady ?? ((): void => {}), null, null, kind, failure);
  }

  /**
   * A frame crossed the transport ceiling (RP-7).
   *
   * This link is trusted and framed by us, so a frame that large means the
   * worker generation is producing something we cannot read — corruption, or a
   * bug. Skipping to the next newline would be worse than the fault: if the
   * lost frame was a response, its request would wait for ever. So the
   * generation ends here, every pending request is rejected with a reason, and
   * the pool's normal crash handling starts a fresh worker. Nothing about the
   * message is logged: it is a provider payload as far as we know.
   */
  private faultGeneration(bytes: number): void {
    if (this.reported) return;
    this.exited = true;
    const error = new Error(
      `the worker for ${this.options.cwd} sent a message of ${bytes} bytes, past the ${FRAME_MAX_BYTES} byte limit for one message`,
    );
    this.options.onStderr?.(`${error.message}\n`);
    try {
      this.pipe.destroy();
    } catch {
      // Already gone; the settle below is what matters.
    }
    this.settle(error, this.rejectReady ?? ((): void => {}), null, null, "transport_fault");
  }

  /**
   * What this link is holding right now (RP-7): the messages written to the
   * worker and not yet taken, what they weigh, and the partial frame being
   * read — which is bytes, never a message.
   */
  transportPressure(): { decoder: LineDecoderStats | undefined; pending: number; pendingFrames: number } {
    return {
      decoder: this.decoder?.stats,
      pending: this.pipe.writableLength ?? 0,
      pendingFrames: this.inFlightWrites,
    };
  }

  /** Non-undefined when the child process could not be started at all. */
  get spawnError(): Error | undefined {
    return this.startError;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /**
   * Whether this worker can still be given work.
   *
   * False from the moment `stop()` closes the pipe, not from the moment the
   * child exits: between those two there is a window where the process is
   * alive but the stream is finished, and a write into it throws
   * `ERR_STREAM_WRITE_AFTER_END` as an unhandled stream error rather than a
   * rejected request. Background work that outlives a request — Namer's
   * qualification is the one that found this — asks here before sending.
   */
  get alive(): boolean {
    return !this.exited && !this.ending;
  }

  /**
   * Stop accepting work, without ending the pipe (RP-4).
   *
   * Called before `pi/worker/retire` is asked, so nothing can be written
   * between the worker's answer and the pipe closing. Requests that arrive
   * while admission is closed are refused immediately with
   * {@link WorkerRetiredError} — never queued, never written. `reopenAdmission`
   * undoes it when the worker refuses to retire.
   */
  closeAdmission(): void {
    this.admissionClosed = true;
  }

  reopenAdmission(): void {
    this.admissionClosed = false;
  }

  get admitting(): boolean {
    return !this.admissionClosed;
  }

  /**
   * Send one request past a closed admission. Only the lifetime verbs use it:
   * they are what the closed admission exists to serve.
   */
  requestPrivileged<R = unknown>(method: string, params: unknown): Promise<R> {
    return this.send<R>(method, params);
  }

  request<R = unknown>(method: string, params: unknown): Promise<R> {
    if (this.admissionClosed) return Promise.reject(new WorkerRetiredError(this.options.cwd));
    return this.send<R>(method, params);
  }

  private send<R = unknown>(method: string, params: unknown): Promise<R> {
    if (!this.alive) return Promise.reject(new WorkerRpcError({ code: ErrorCodes.DriverUnavailable, message: "worker exited" }));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.writeLine(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        // The pipe closed between the check above and the write. The caller
        // gets a refusal it can report; the process does not get an unhandled
        // stream error.
        this.pending.delete(id);
        reject(new WorkerRpcError({ code: ErrorCodes.DriverUnavailable, message: error instanceof Error ? error.message : "worker exited" }));
      }
    });
  }

  /** Private host → worker message. Never echoed into frontend notifications. */
  notify<M extends keyof WorkerNotifications>(method: M, params: WorkerNotifications[M]): void {
    if (!this.alive) return;
    try {
      this.writeLine(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The worker closed concurrently; future workers still get the base.
    }
  }

  /** Close the pipe (worker retires itself) and wait for exit. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    // Before `end()`, so a request racing this one is refused rather than
    // written into a finished stream.
    const alreadyEnding = this.ending;
    this.ending = true;
    if (!alreadyEnding) this.pipe.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, graceMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
