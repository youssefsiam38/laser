/**
 * `new --open` and `open` print and open the URL of the host they reached,
 * not the configured port (M13-T54). A real record on an ephemeral port, a
 * fake host answering /healthz and the socket, and a CLI told `--port` for a
 * port nothing listens on.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { SessionState, SessionSummary } from "@lasercode/protocol";
import type { CommandContext } from "../src/command.js";
import { resolvePaths } from "../src/config.js";
import { processIdentity, writeHostFile } from "../src/hostfile.js";
import { Terminal } from "../src/output.js";
import { newCommand, openCommand, sessionFragment } from "../src/commands/session.js";

const opened: string[] = [];
vi.mock("../src/host-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host-control.js")>();
  return { ...actual, openBrowser: (url: string) => (opened.push(url), true) };
});

const state = (path: string): SessionState => ({
  path,
  id: "0f3a91c2-1111",
  cwd: "/w",
  model: null,
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
} as SessionState);

const summary: SessionSummary = { path: "/s/a.jsonl", id: "0f3a91c2-1111", cwd: "/w", createdAt: "2026-09-05T00:00:00.000Z", modifiedAt: "2026-09-05T00:00:00.000Z", messageCount: 1 };

/** A host on whatever port the OS hands out: /healthz plus the two RPCs these verbs make. */
async function fakeHost(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const { id, method, params } = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
      const result =
        method === "session/new"
          ? { state: state("/s/new.jsonl") }
          : method === "pi/session/list"
            ? { sessions: [summary] }
            : method === "session/load"
              ? { state: state(String(params["path"])), replayFrom: 0, seq: 0 }
              : undefined;
      socket.send(
        JSON.stringify(result ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected ${method}` } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

let dir: string;
let host: Awaited<ReturnType<typeof fakeHost>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "session-url-"));
  host = await fakeHost();
  opened.length = 0;
});
afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

function context(flags: Record<string, string | number | boolean>, positionals: string[] = []): { context: CommandContext; json: () => Record<string, unknown> } {
  const lines: string[] = [];
  const stdout = { write: (text: string) => (lines.push(text), true), isTTY: false } as unknown as NodeJS.WriteStream;
  const stderr = { write: () => true, isTTY: false } as unknown as NodeJS.WriteStream;
  const args = { flags: { json: true, "state-dir": dir, ...flags }, positionals, rest: [], hasRest: false };
  return {
    context: {
      term: new Terminal({ json: true, color: "never", stdout, stderr }),
      paths: resolvePaths(args, { HOME: dir }),
      args,
      raw: [],
      commands: [],
    },
    json: () => JSON.parse(lines.join("")) as Record<string, unknown>,
  };
}

function record(port: number): void {
  const identity = processIdentity(process.pid);
  writeHostFile(join(dir, "host.json"), {
    pid: process.pid,
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
    agentDir: dir,
    sessionDir: dir,
    stateDir: dir,
    startedAt: new Date().toISOString(),
    cliVersion: "test",
    ...(identity !== undefined ? { identity } : {}),
  });
}

describe("the URL a session verb prints and opens", () => {
  it("new --open: the recorded host's port, even when --port names another", async () => {
    record(host.port);
    const { context: ctx, json } = context({ open: true, port: 41441 }, [dir]);
    await newCommand.run(ctx);
    const expected = `http://127.0.0.1:${host.port}${sessionFragment("/s/new.jsonl")}`;
    expect(json()["url"]).toBe(expected);
    expect(opened).toEqual([expected]);
  });

  it("open: the recorded host's port, in the answer and in the browser", async () => {
    record(host.port);
    const { context: ctx, json } = context({ open: true, port: 41441 }, ["0f3a91c2"]);
    await openCommand.run(ctx);
    const expected = `http://127.0.0.1:${host.port}${sessionFragment("/s/a.jsonl")}`;
    expect(json()).toMatchObject({ url: expected, browserOpened: true });
    expect(opened).toEqual([expected]);
  });

  it("no record: --port is where it connected, so --port is what it prints", async () => {
    // A host this CLI did not start (a sandbox, the desktop app) is adopted on the
    // configured port; the printed URL is that port.
    const { context: ctx, json } = context({ open: false, port: host.port }, [dir]);
    await newCommand.run(ctx);
    expect(json()["url"]).toBe(`http://127.0.0.1:${host.port}${sessionFragment("/s/new.jsonl")}`);
    expect(opened).toEqual([]);
  });
});
