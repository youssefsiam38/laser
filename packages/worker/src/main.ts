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
 *       [--project-trusted yes|no]
 */
import { Socket } from "node:net";
import { ENV, FEATURE_MANIFESTS, LineDecoder, PRODUCT_NAME, parseJsonLine, type FeatureId, type JsonRpcMessage } from "@lasercode/protocol";
import { StableSdkDriver } from "./drivers/stable-sdk.js";
import { alignEngineAgentDir, extendRuntimePath } from "./runtime-env.js";
import { AgentResolutionError, assertBundledAgent } from "./resolve-pi.js";
import { WorkerServer } from "./server.js";

const PROTOCOL_FD = Number(process.env[ENV.workerFd] ?? 3);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function openTransport(): { input: NodeJS.ReadableStream; write: (line: string) => void } {
  try {
    const socket = new Socket({ fd: PROTOCOL_FD, readable: true, writable: true });
    return { input: socket, write: (line) => socket.write(line) };
  } catch {
    // No fd 3: fall back to stdio and keep the protocol stream clean.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = console.log;
    return { input: process.stdin, write: (line) => realStdoutWrite(line) };
  }
}

async function main(): Promise<void> {
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
  const send = (message: JsonRpcMessage) => transport.write(`${JSON.stringify(message)}\n`);

  const server = new WorkerServer({
    cwd,
    createDriver: () => new StableSdkDriver(),
    send,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(projectTrusted !== undefined ? { projectTrusted: projectTrusted === "yes" } : {}),
    ...(npmCommand ? { npmCommand } : {}),
    features,
  });

  const decoder = new LineDecoder();
  transport.input.setEncoding("utf8");
  transport.input.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      let raw: unknown;
      try {
        raw = parseJsonLine(line);
      } catch (error) {
        send({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: (error as Error).message } });
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
    await server.dispose();
    process.exit(code);
  }

  server.notify("pi/worker/status", { cwd, status: "ready" });
}

main().catch((error) => {
  console.error(`${PRODUCT_NAME} worker failed:`, error);
  process.exit(1);
});
