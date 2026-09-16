#!/usr/bin/env node
/**
 * Worker process entry (M0-T6). One process = one project directory.
 *
 * Protocol transport: a dedicated pipe on fd 3 (the host spawns with
 * `stdio: ["ignore", "pipe", "pipe", "pipe"]`). stdout/stderr stay free for
 * Pi's and extensions' own logging, which would otherwise corrupt a JSONL
 * stream on stdout. When fd 3 is absent (run by hand), stdio is used and
 * console output is redirected to stderr.
 *
 * Args: --cwd <dir> [--agent-dir <dir>] [--session-dir <dir>] [--state-dir <dir>]
 *       [--project-trusted yes|no] [--environment-id <id>]
 *       [--provider-payloads full|summary] [--worker-generation <n>]
 */
import { Socket } from "node:net";
import {
  ENV,
  FEATURE_MANIFESTS,
  FRAME_MAX_BYTES,
  LineDecoder,
  PRODUCT_NAME,
  configuredOldSpaceBytes,
  parseJsonLine,
  type FeatureId,
  type JsonRpcMessage,
} from "@lasercode/protocol";
import { StableSdkDriver } from "./drivers/stable-sdk.js";
import { alignEngineAgentDir, extendRuntimePath } from "./runtime-env.js";
import { installUnhandledRejectionGuard } from "./process-guards.js";
import { AgentResolutionError, assertBundledAgent } from "./resolve-pi.js";
import { WorkerServer } from "./server.js";
import { applyEnvironment } from "./environment.js";

const PROTOCOL_FD = Number(process.env[ENV.workerFd] ?? 3);

/**
 * How long an unexpected shutdown waits for handlers it had already accepted
 * (RP-4). The retirement path never uses it: the worker proved it had none
 * before the host closed the pipe.
 */
const SHUTDOWN_DRAIN_MS = 5_000;

/**
 * How long one chunk of a large capture waits for the link to move (RP-7).
 * Bounded and small: a capture may wait a little for a busy pipe, and nothing
 * else in this process waits for the capture.
 */
const DRAIN_WAIT_MS = 10;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface WorkerTransport {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  /** Complete messages accepted for the app and not yet written (RP-7). */
  pendingFrames: () => number;
  /** Bytes accepted for the host and not yet handed to the kernel (RP-7). */
  pending: () => number;
  /**
   * Let the link write what it is holding. A capture sent in bounded pieces
   * awaits this while the backlog is at its mark, so a healthy link finishes a
   * large capture and a stalled one is left holding the mark, not the capture.
   */
  drain: () => Promise<void>;
}

function openTransport(): WorkerTransport {
  try {
    const socket = new Socket({ fd: PROTOCOL_FD, readable: true, writable: true });
    let inFlight = 0;
    let gone = false;
    const settleAll = () => {
      if (gone) return;
      gone = true;
      inFlight = 0;
    };
    socket.once("error", settleAll);
    socket.once("close", settleAll);
    return {
      input: socket,
      write: (line) => {
        if (gone) return;
        inFlight += 1;
        socket.write(line, () => {
          if (!gone) inFlight = Math.max(0, inFlight - 1);
        });
      },
      pendingFrames: () => inFlight,
      pending: () => socket.writableLength,
      drain: () =>
        new Promise<void>((resolve) => {
          if (socket.writableLength === 0) {
            setImmediate(resolve);
            return;
          }
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off("drain", done);
            resolve();
          };
          // Real time, not just a turn of the loop: the app is reading this
          // pipe in another process, and a write leaves this one only when the
          // kernel takes it. A link that is moving finishes a large capture;
          // one that is not gets a bounded number of these and then an abort.
          const timer = setTimeout(done, DRAIN_WAIT_MS);
          timer.unref?.();
          socket.once("drain", done);
        }),
    };
  } catch {
    // No fd 3: fall back to stdio and keep the protocol stream clean.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = console.log;
    let stdoutInFlight = 0;
    return {
      input: process.stdin,
      write: (line) => {
        stdoutInFlight += 1;
        realStdoutWrite(line, () => {
          stdoutInFlight = Math.max(0, stdoutInFlight - 1);
        });
      },
      pendingFrames: () => stdoutInFlight,
      pending: () => process.stdout.writableLength,
      drain: () => new Promise<void>((resolve) => setImmediate(resolve)),
    };
  }
}

async function main(): Promise<void> {
  // First of all, before anything here can float a promise: a worker that
  // dies takes every conversation in its project with it.
  installUnhandledRejectionGuard();
  // Belt and braces. The desktop shell and `laser doctor` both check the pin
  // before a worker is ever spawned, so in a shipped app this cannot fail —
  // but this is the process that actually imports the agent, and a worker that
  // loads a version nobody pinned is worse than one that refuses to start.
  try {
    assertBundledAgent();
  } catch (error) {
    if (error instanceof AgentResolutionError) {
      console.error(`${PRODUCT_NAME}: ${error.message}`);
      if (error.fix) console.error(error.fix);
      process.exit(2);
    }
    throw error;
  }

  const cwd = arg("cwd") ?? process.cwd();
  const agentDir = arg("agent-dir");
  const sessionDir = arg("session-dir");
  // The host's own state directory (agents, runs, prefs), used by Beam's
  // Laser-specific instructions. Optional for callers outside the host.
  const stateDir = arg("state-dir");
  const projectTrusted = arg("project-trusted");
  // Which environment the durable revisions this worker mints belong to
  // (RP-9). Never logged, never published: only its derived key is public.
  const environmentId = arg("environment-id");
  // Which spawn this process is, as the host minted it before starting us
  // (RP-8). Only an exactly representable non-negative integer is a
  // generation; anything else is treated as none, and this worker then takes
  // no part in memory pressure rather than claiming an identity it was not
  // given. It is never logged and never leaves this process except on the
  // trusted link it came from.
  const generationArg = arg("worker-generation");
  const parsedGeneration = generationArg === undefined ? Number.NaN : Number(generationArg);
  const workerGeneration =
    Number.isSafeInteger(parsedGeneration) && parsedGeneration >= 0 ? parsedGeneration : undefined;
  // Configuration and V8's measured heap limit are separate facts. This one
  // exists only when the launcher put an explicit flag in Node's own argv.
  const configuredHeapBytes = configuredOldSpaceBytes(process.execArgv);
  // Whether this installation's log store keeps provider request bodies
  // (RP-7). `summary` means a capture is recorded without one, and the body is
  // never serialized here at all.
  const providerPayloads = arg("provider-payloads");
  alignEngineAgentDir(agentDir, sessionDir);
  extendRuntimePath();
  if (projectTrusted !== undefined && projectTrusted !== "yes" && projectTrusted !== "no") {
    console.error(`${PRODUCT_NAME} worker: --project-trusted must be "yes" or "no", got ${JSON.stringify(projectTrusted)}`);
    process.exit(2);
  }

  // The host's bundled package manager, `[command, ...args]` as JSON (M10-T5).
  // Only used when settings name none; malformed = absent.
  let npmCommand: string[] | undefined;
  try {
    const parsed: unknown = JSON.parse(process.env[ENV.npmCommand] ?? "null");
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")) npmCommand = parsed as string[];
  } catch {
    npmCommand = undefined;
  }

  let features: FeatureId[] = FEATURE_MANIFESTS.filter((feature) => feature.defaultEnabled).map((feature) => feature.id);
  try {
    const parsed: unknown = JSON.parse(process.env[ENV.features] ?? "null");
    if (Array.isArray(parsed)) {
      const known = new Set(FEATURE_MANIFESTS.map((feature) => feature.id));
      features = parsed.filter((id): id is FeatureId => typeof id === "string" && known.has(id as FeatureId));
    }
  } catch {
    // Malformed environment falls back to the product defaults.
  }

  const transport = openTransport();
  const send = (message: JsonRpcMessage) => {
    const line = `${JSON.stringify(message)}\n`;
    // Nothing we produce may be a message the host has to fault on (RP-7). A
    // frame this large can only be a bug in something that should have bounded
    // itself; refusing it here keeps the link, and every conversation on it,
    // alive. Notifications are dropped with a note on stderr, requests answer
    // with an error the caller can show.
    if (Buffer.byteLength(line, "utf8") > FRAME_MAX_BYTES) {
      const id = (message as { id?: string | number }).id;
      console.error(`${PRODUCT_NAME} worker: refused to send a ${Buffer.byteLength(line, "utf8")} byte message`);
      if (id !== undefined) {
        transport.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "that answer is too large to send" } })}\n`,
        );
      }
      return;
    }
    transport.write(line);
  };

  const server = new WorkerServer({
    cwd,
    createDriver: () => new StableSdkDriver(),
    send,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(projectTrusted !== undefined ? { projectTrusted: projectTrusted === "yes" } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(workerGeneration !== undefined ? { workerGeneration } : {}),
    ...(configuredHeapBytes !== undefined ? { configuredOldSpaceBytes: configuredHeapBytes } : {}),
    ...(npmCommand ? { npmCommand } : {}),
    features,
    transportPending: () => transport.pending(),
    transportFrames: () => transport.pendingFrames(),
    transportDrain: () => transport.drain(),
    retainProviderBodies: providerPayloads !== "summary",
  });

  let framesFaulted = false;
  const decoder = new LineDecoder({
    maxFrameBytes: FRAME_MAX_BYTES,
    onOverflow: ({ bytes }) => {
      // The host frames everything it sends us; a message this large means the
      // link is not carrying what we think it is. Continuing past a frame we
      // could not read would leave the host waiting for an answer for ever.
      framesFaulted = true;
      console.error(`${PRODUCT_NAME} worker: the app sent a ${bytes} byte message, past the limit for one message`);
      void shutdown(1);
    },
  });
  transport.input.on("data", (chunk: Buffer) => {
    if (framesFaulted) return;
    for (const line of decoder.push(chunk)) {
      let raw: unknown;
      try {
        raw = parseJsonLine(line);
      } catch (error) {
        send({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: (error as Error).message } });
        continue;
      }
      const notification = raw as { method?: unknown; params?: unknown; id?: unknown } | null;
      if (notification?.method === "pi/host/environment" && notification.id === undefined) {
        applyEnvironment(notification.params);
        continue;
      }
      void server.handle(raw);
    }
  });
  transport.input.on("end", () => void shutdown(0));
  transport.input.on("error", () => void shutdown(1));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  // A worker must never outlive its host. If the host is killed hard the pipe
  // may not signal `end`, so also watch for re-parenting (ppid becomes 1 or
  // changes) and exit.
  const parent = process.ppid;
  const watchdog = setInterval(() => {
    if (process.ppid !== parent) void shutdown(0);
  }, 2000);
  watchdog.unref();

  let closing = false;
  async function shutdown(code: number): Promise<void> {
    if (closing) return;
    closing = true;
    server.notify("pi/worker/status", { cwd, status: "retired" });
    // Handlers accepted before the pipe closed finish first (RP-4). On the
    // normal retirement path there are none — `pi/worker/retire` proved that
    // before the host ended the pipe — so this returns at once. On an
    // unexpected close (the host was killed, the parent vanished) it is a
    // bounded wait, and a wait that runs out is said out loud: work that was
    // in flight is lost with the process, and that is a harness loss, not
    // something a person did.
    const quiet = await server.drain(SHUTDOWN_DRAIN_MS);
    if (!quiet) {
      console.error(
        `${PRODUCT_NAME} worker: the connection closed while this project's worker was still working; ` +
          `it could not finish within ${SHUTDOWN_DRAIN_MS} ms and is stopping.`,
      );
    }
    await server.dispose();
    process.exit(code);
  }

  server.notify("pi/worker/status", { cwd, status: "ready" });
}

main().catch((error) => {
  console.error(`${PRODUCT_NAME} worker failed:`, error);
  process.exit(1);
});
