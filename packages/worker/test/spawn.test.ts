/**
 * M0-T6 done-when: a test client spawns a real worker process, opens a
 * session, and receives events over the fd-3 pipe. Requires `pnpm build`
 * first (spawns dist/main.js); skipped with a message otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { LineDecoder, type JsonRpcMessage } from "@piorbit/protocol";

const MAIN = join(import.meta.dirname, "../dist/main.js");

let base: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "piorbit-spawn-"));
  for (const d of ["project", "agent"]) mkdirSync(join(base, d), { recursive: true });
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => child!.once("exit", r));
  }
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(MAIN))("worker process over fd 3", () => {
  it("reports ready, opens a session, and exits cleanly on pipe close", async () => {
    child = spawn(
      process.execPath,
      [MAIN, "--cwd", join(base, "project"), "--agent-dir", join(base, "agent"), "--session-dir", join(base, "sessions")],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    const pipe = child.stdio[3] as Duplex;
    const inbound: JsonRpcMessage[] = [];
    const decoder = new LineDecoder();
    const waitFor = (pred: (m: JsonRpcMessage) => boolean, ms = 30_000) =>
      new Promise<JsonRpcMessage>((resolve, reject) => {
        const found = inbound.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`timeout waiting; got ${JSON.stringify(inbound.slice(-3))}`)), ms);
        const onData = () => {
          const hit = inbound.find(pred);
          if (hit) { clearTimeout(timer); pipe.off("data", onData); resolve(hit); }
        };
        pipe.on("data", onData);
      });
    pipe.setEncoding("utf8");
    pipe.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) inbound.push(JSON.parse(line) as JsonRpcMessage);
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));

    await waitFor((m) => "method" in m && m.method === "pi/worker/status" && (m.params as { status: string }).status === "ready");

    pipe.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: join(base, "project") } })}\n`);
    const res = await waitFor((m) => "id" in m && m.id === 1);
    expect(res, stderr).toMatchObject({ result: { state: { cwd: join(base, "project"), isStreaming: false } } });

    // The companion extension's capability report crossed the pipe too.
    await waitFor((m) => "method" in m && m.method === "pi/extension/message");

    // stdout stayed clean: nothing but the protocol went over fd 3, and the
    // protocol never went to stdout.
    let stdout = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));

    pipe.end();
    const code = await new Promise<number | null>((r) => child!.once("exit", r));
    expect(code).toBe(0);
    expect(stdout).not.toContain('"jsonrpc"');
  }, 60_000);
});
