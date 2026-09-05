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
 * Args: --cwd <dir> [--agent-dir <dir>] [--session-dir <dir>] [--subagents-temp-root <dir>]
 */
import { Socket } from "node:net";
import { LineDecoder, parseJsonLine, type JsonRpcMessage } from "@piorbit/protocol";
import { StableSdkDriver } from "./drivers/stable-sdk.js";
import { WorkerServer } from "./server.js";

const PROTOCOL_FD = Number(process.env["PIORBIT_WORKER_FD"] ?? 3);

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
  const cwd = arg("cwd") ?? process.cwd();
  const agentDir = arg("agent-dir");
  const sessionDir = arg("session-dir");
  const subagentsTempRoot = arg("subagents-temp-root");

  const transport = openTransport();
  const send = (message: JsonRpcMessage) => transport.write(`${JSON.stringify(message)}\n`);

  const server = new WorkerServer({
    cwd,
    createDriver: () => new StableSdkDriver(),
    send,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(subagentsTempRoot ? { subagentsTempRoot } : {}),
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
  console.error("piorbit worker failed:", error);
  process.exit(1);
});
