/**
 * The project environment command, worker side (M16-T17).
 *
 * One worker serves one project directory, so the resolved environment is a
 * per-worker fact: a second project runs in a second process and cannot see
 * this one's values. Child agents and worktrees of this project share this
 * worker deliberately, which is exactly what "a worktree keeps its owning
 * project's environment" means in practice.
 *
 * The values are held here, in memory, and injected where a process is
 * created. They are never written to `process.env`, and that is not an
 * incidental choice: the worker's own environment is what Pi reads to
 * authenticate to a model provider, so writing project values there would let
 * a project silently repoint the agent's own credentials. Keeping the two
 * apart makes that impossible rather than merely discouraged.
 */
import { spawn } from "node:child_process";
import {
  PROJECT_ENV_FD,
  PROJECT_ENV_MAX_BYTES,
  PROJECT_ENV_TIMEOUT_MS,
  parseProjectEnvDocument,
  projectEnvResolution,
  type ProjectEnvResolution,
  type ProjectEnvWorkerConfig,
} from "@lasercode/protocol";

/** How long a finished hook's payload pipe may still be delivering. */
const PAYLOAD_GRACE_MS = 2_000;

export interface ProjectEnvSnapshot {
  state: "off" | "needs-approval" | "ready" | "failed";
  names: string[];
  unsetNames: string[];
  refused: Array<{ name: string; reason: string }>;
  resolvedAt?: string;
  error?: string;
}

export interface ProjectEnvironmentOptions {
  cwd: string;
  config: ProjectEnvWorkerConfig | undefined;
  /** Injectable for tests. */
  now?: () => Date;
  /** Injectable for tests; defaults to the real child process. */
  run?: (options: RunOptions) => Promise<RunResult>;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
}

export interface RunResult {
  /** Bytes the hook wrote to the private descriptor. */
  payload: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the output exceeded the bound and the process was killed. */
  overflowed: boolean;
  timedOut: boolean;
  spawnError?: Error;
}

export class ProjectEnvironment {
  private resolution: ProjectEnvResolution | undefined;
  private snapshot: ProjectEnvSnapshot;
  private inFlight: Promise<ProjectEnvSnapshot> | undefined;
  private readonly now: () => Date;
  private readonly runner: (options: RunOptions) => Promise<RunResult>;

  constructor(private options: ProjectEnvironmentOptions) {
    this.now = options.now ?? (() => new Date());
    this.runner = options.run ?? runHook;
    this.snapshot = initialSnapshot(options.config);
  }

  status(): ProjectEnvSnapshot {
    return { ...this.snapshot, names: [...this.snapshot.names], unsetNames: [...this.snapshot.unsetNames] };
  }

  /** True when a command must not run because the hook has not produced an environment. */
  get blocking(): boolean {
    const config = this.options.config;
    if (!config?.enabled || !config.required) return false;
    return this.snapshot.state !== "ready";
  }

  /** The sentence a person reads when execution is refused. */
  blockingReason(): string {
    const config = this.options.config;
    if (!config?.enabled) return "";
    if (!config.approved) {
      return (
        "This project's environment command has changed since it was approved, so nothing has run. " +
        "Review it in Settings → Projects → Environment and approve it again."
      );
    }
    return (
      `This project's environment could not be prepared, so commands are not running with it. ` +
      `${this.snapshot.error ?? ""} Open Settings → Projects → Environment to test or refresh it.`
    ).trim();
  }

  /**
   * Resolve once per worker lifetime, or again on an explicit refresh.
   * Concurrent callers share one run: two tools starting at once must not
   * spawn the hook twice.
   */
  async ensure(): Promise<ProjectEnvSnapshot> {
    const config = this.options.config;
    if (!config?.enabled) return this.status();
    if (!config.approved) return this.status();
    if (this.snapshot.state === "ready") return this.status();
    if (this.inFlight) return this.inFlight;
    const run = this.resolve();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  /** Re-run the hook. Commands already running keep the environment they started with. */
  async refresh(): Promise<ProjectEnvSnapshot> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.snapshot = initialSnapshot(this.options.config);
    this.resolution = undefined;
    return this.ensure();
  }

  /** Replace the configuration (a settings change) without restarting the worker. */
  reconfigure(config: ProjectEnvWorkerConfig | undefined): void {
    this.options = { ...this.options, config };
    this.resolution = undefined;
    this.snapshot = initialSnapshot(config);
  }

  /**
   * The environment a child process of this project should get.
   *
   * `unset` is honoured by deletion, so a credential inherited from the
   * terminal that launched the app does not survive into a project that did
   * not ask for it.
   */
  apply(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!this.resolution) return base;
    const next: NodeJS.ProcessEnv = { ...base };
    for (const name of this.resolution.unset) delete next[name];
    for (const [name, value] of Object.entries(this.resolution.set)) next[name] = value;
    return next;
  }

  private async resolve(): Promise<ProjectEnvSnapshot> {
    const config = this.options.config;
    if (!config) return this.status();

    let result: RunResult;
    try {
      result = await this.runner({
        command: config.command,
        args: config.args,
        cwd: this.options.cwd,
        // The hook inherits the worker's environment, which is the app's, not a
        // project's: it needs PATH and HOME to find its own credentials.
        env: process.env,
        timeoutMs: PROJECT_ENV_TIMEOUT_MS,
        maxBytes: PROJECT_ENV_MAX_BYTES,
      });
    } catch (error) {
      return this.fail(describeSpawnFailure(error, config.command));
    }

    if (result.spawnError) return this.fail(describeSpawnFailure(result.spawnError, config.command));
    if (result.timedOut) {
      return this.fail(`It did not finish within ${Math.round(PROJECT_ENV_TIMEOUT_MS / 1000)} seconds.`);
    }
    if (result.overflowed) return this.fail("It returned more data than an environment can hold.");
    if (result.code !== 0) {
      // The hook's own stderr may contain secrets, so it is never quoted here.
      const how = result.signal ? `was stopped by ${result.signal}` : `exited with code ${result.code ?? "unknown"}`;
      return this.fail(`The command ${how}.`);
    }

    const parsed = parseProjectEnvDocument(result.payload);
    if ("error" in parsed) return this.fail(parsed.error);

    const resolution = projectEnvResolution(parsed.document, { allowProviderKeys: config.allowProviderKeys });
    this.resolution = resolution;
    this.snapshot = {
      state: "ready",
      names: Object.keys(resolution.set).sort(),
      unsetNames: [...resolution.unset],
      refused: resolution.refused,
      resolvedAt: this.now().toISOString(),
    };
    return this.status();
  }

  private fail(error: string): ProjectEnvSnapshot {
    this.resolution = undefined;
    this.snapshot = {
      state: "failed",
      names: [],
      unsetNames: [],
      refused: [],
      error,
      resolvedAt: this.now().toISOString(),
    };
    return this.status();
  }
}

function initialSnapshot(config: ProjectEnvWorkerConfig | undefined): ProjectEnvSnapshot {
  if (!config?.enabled) return { state: "off", names: [], unsetNames: [], refused: [] };
  if (!config.approved) return { state: "needs-approval", names: [], unsetNames: [], refused: [] };
  return { state: "failed", names: [], unsetNames: [], refused: [], error: "Not resolved yet." };
}

function describeSpawnFailure(error: unknown, command: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `“${command}” was not found on this machine.`;
  if (code === "EACCES") return `“${command}” is not executable.`;
  return "The environment command could not be started.";
}

/**
 * Run the hook with a private descriptor for its answer.
 *
 * stdout and stderr are drained and discarded: the contract treats them as
 * potentially sensitive, so they are never captured into a message, a log or
 * a diagnostic. Only fd 3 carries data we read.
 */
export function runHook(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "ignore", "ignore", "pipe"],
        // Its own process group, so a hook that leaves a child behind can be
        // ended as a tree rather than orphaned still holding the pipe.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ payload: "", code: null, signal: null, overflowed: false, timedOut: false, spawnError: error as Error });
      return;
    }

    let payload = "";
    let bytes = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;

    const pipe = child.stdio[PROJECT_ENV_FD] as NodeJS.ReadableStream | null;
    pipe?.setEncoding?.("utf8");
    pipe?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > options.maxBytes) {
        overflowed = true;
        payload = "";
        kill();
        return;
      }
      payload += chunk;
    });
    pipe?.on("error", () => {});
    // The payload is only whole once the pipe itself ends. `exit` can arrive
    // first, and one `setImmediate` is not enough under load: a busy machine
    // delivers the last chunk a tick later and the project would start with a
    // half-read — or empty — environment.
    let pipeEnded = pipe === null || pipe === undefined;
    const endPipe = (): void => {
      pipeEnded = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (exited) settle();
    };
    pipe?.on("end", endPipe);
    pipe?.on("close", endPipe);

    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        // Negative pid: the whole group, so a grandchild dies with its parent.
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    timer.unref?.();

    let exited = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    const settle = (): void => finish(exit);
    const finish = (result: Omit<RunResult, "payload" | "overflowed" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, payload, overflowed, timedOut });
    };

    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error }));
    // `exit`, not `close`: a hook that leaves a long-lived grandchild holding
    // the descriptor would otherwise keep the project waiting for it. The
    // payload still has to be whole, so settle when the pipe has also ended —
    // or, if the grandchild is holding it open, after one turn of the loop.
    child.on("exit", (code, signal) => {
      exited = true;
      exit = { code, signal };
      if (pipeEnded) { settle(); return; }
      // The hook has gone but its last write may still be in flight. Wait for
      // the pipe to end, bounded: a grandchild holding the descriptor open
      // must not make the project wait for it.
      graceTimer = setTimeout(settle, PAYLOAD_GRACE_MS);
      graceTimer.unref?.();
    });
  });
}
