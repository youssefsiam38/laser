/**
 * RP-7, the worker's own end of the link: a message past the transport ceiling
 * is a fault, not something to resynchronise past, and it ends the process
 * rather than leaving the app waiting for an answer that will never come.
 *
 * Spawns the real worker, so the pipe, the decoder and the shutdown path are
 * the shipped ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { FRAME_MAX_BYTES, LineDecoder, PRODUCT_NAME, type JsonRpcMessage } from "@lasercode/protocol";

const MAIN = join(import.meta.dirname, "../dist/main.js");

let base: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-frames-`));
  for (const d of ["project", "agent"]) mkdirSync(join(base, d), { recursive: true });
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((r) => child!.once("exit", r));
  }
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(MAIN))("the worker's frame ceiling", () => {
  it("answers a normal request, then ends on a message past the ceiling", async () => {
    child = spawn(
      process.execPath,
      [MAIN, "--cwd", join(base, "project"), "--launch-id", "00112233445566778899aabbccddeeff", "--worker-mode", "normal", "--agent-dir", join(base, "agent"), "--session-dir", join(base, "sessions")],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    const pipe = child.stdio[3] as Duplex;
    // The worker ends mid-write, so the writing side sees EPIPE/ECONNRESET.
    // The host tolerates exactly this on its own pipe; so does this test.
    pipe.on("error", () => {});
    const inbound: JsonRpcMessage[] = [];
    const decoder = new LineDecoder();
    pipe.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) inbound.push(JSON.parse(line) as JsonRpcMessage);
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    const exited = new Promise<number | null>((resolve) => child!.once("exit", resolve));

    await expect
      .poll(
        () => inbound.some((m) => "method" in m && m.method === "pi/worker/status" && (m.params as { status: string }).status === "ready"),
        { timeout: 60_000 },
      )
      .toBe(true);

    // One oversize message, written as one frame with no newline until its end.
    pipe.write(`{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"`);
    const chunk = "x".repeat(1024 * 1024);
    for (let sent = 0; sent < FRAME_MAX_BYTES + 2 * 1024 * 1024; sent += chunk.length) pipe.write(chunk);
    pipe.write(`"}}\n`);

    const code = await exited;
    expect(code).not.toBe(0);
    expect(stderr).toContain("past the limit for one message");
    // It never answered the impossible request, and it never pretended to.
    expect(inbound.some((m) => "id" in m && m.id === 1)).toBe(false);
  }, 120_000);
});
