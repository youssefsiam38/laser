/**
 * M23 review, B1 — opening a conversation that ran in the retired workspace,
 * through a real worker and a real engine.
 *
 * A machine that ran the previous generation has conversations whose session
 * header says `<state>/workspaces/beam/<id>`, and nothing ever rewrites that
 * header: the transcript is evidence. "Re-homed as Chat"
 * (`docs/plain-chat.md`, "Migration") therefore has to mean *listed and opened
 * as a Chat where it is*, not moved: the engine ensures the directory the
 * header names, so a host that moved the folder would hand the person an
 * empty working directory with their files stranded beside it, and would find
 * the retired directory grown back at the next start.
 *
 * The fixture is built by creating a genuine chat session through the host and
 * then putting it back into the old layout — a real engine-written transcript,
 * a real per-session folder with a file in it, and a pre-M23 `beam` record.
 */
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type SessionState, type SessionSummary } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer, chatWorkspaceDir, defaultWorkerMain, retiredBeamWorkspaceDir, workspacesDir } from "../../src/index.js";

function stubProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })),
  );
}

class Client {
  private ws!: WebSocket;
  readonly inbound: JsonRpcMessage[] = [];
  private nextId = 1;
  async connect(url: string) {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.ws.on("message", (data) => this.inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => this.ws.once("open", () => resolve()));
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return this.waitFor((message) => "id" in message && message.id === id).then((message) => {
      const answer = message as { result?: R; error?: { message: string } };
      if (answer.error) throw new Error(answer.error.message);
      return answer.result as R;
    });
  }
  waitFor(predicate: (message: JsonRpcMessage) => boolean, ms = 30_000): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const hit = this.inbound.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout; last: ${JSON.stringify(this.inbound.slice(-2))}`)), ms);
      const listener = () => {
        const found = this.inbound.find(predicate);
        if (found) { clearTimeout(timer); this.ws.off("message", listener); resolve(found); }
      };
      this.ws.on("message", listener);
    });
  }
  close() { this.ws.close(); }
}

let base: string;
let stateDir: string;
let host: HostServer | undefined;
let stub: Awaited<ReturnType<typeof stubProvider>>;

const chatDir = () => chatWorkspaceDir(stateDir);
const beamDir = () => retiredBeamWorkspaceDir(workspacesDir(stateDir));
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

async function startHost(): Promise<{ client: Client }> {
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir,
    log: () => {},
  });
  const client = new Client();
  await client.connect((await host.listen()).url);
  return { client };
}

async function stopHost(client: Client): Promise<void> {
  client.close();
  await host?.close();
  host = undefined;
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-retired-open-`));
  stateDir = join(base, "state");
  mkdirSync(join(base, "agent"), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  // Only the stub is offered, so the run is hermetic on a machine that has a
  // real provider configured in its environment.
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));
});

afterEach(async () => {
  await host?.close();
  host = undefined;
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("a conversation whose header names the retired workspace", () => {
  it("lists and opens as a Chat in the directory it is already in, and no start moves it", { timeout: 120_000 }, async () => {
    // 1. A genuine chat session, written by the engine, with a file of the
    //    person's in its private working directory.
    const first = await startHost();
    const created = await first.client.request<{ state: SessionState }>("session/new", { cwd: chatDir(), sessionKind: "chat" });
    const sessionPath = created.state.path;
    const folder = created.state.cwd;
    expect(folder.startsWith(`${chatDir()}/`)).toBe(true);
    writeFileSync(join(folder, "notes.md"), "the person's own file");
    await first.client.request("pi/session/detach", { path: sessionPath });
    await stopHost(first.client);

    // 2. Put it back into the layout a pre-M23 machine has: the folder under
    //    the retired directory, the header naming it, a `beam` record.
    const name = folder.slice(chatDir().length + 1);
    const oldFolder = join(beamDir(), name);
    mkdirSync(beamDir(), { recursive: true });
    renameSync(folder, oldFolder);
    const lines = readFileSync(sessionPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const entry of lines) {
      if (entry["type"] === "session") entry["cwd"] = oldFolder;
      if (entry["type"] === "custom" && entry["customType"] === SESSION_AGENT_ENTRY_TYPE) entry["data"] = { agentName: "beam", kind: "beam" };
    }
    writeFileSync(sessionPath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const transcript = readFileSync(sessionPath, "utf8");
    const before = { chat: listing(chatDir()), retired: listing(beamDir()) };
    expect(before.retired).toEqual([name]);
    expect(before.chat).toEqual([]);

    // 3. Two further host starts — the second proves a start that follows an
    //    open changes nothing either.
    for (const pass of [1, 2]) {
      const { client } = await startHost();
      try {
        const { sessions } = await client.request<{ sessions: SessionSummary[] }>("pi/session/list", {});
        const listed = sessions.find((session) => session.path === sessionPath);
        // Listed as a Chat, from the directory it is in, with no agent name.
        expect(listed?.agent, `pass ${pass}`).toEqual({ kind: "chat", sessionKind: "chat" });
        expect(listed?.cwd, `pass ${pass}`).toBe(oldFolder);

        // Opened through a real worker: the working directory is the one it
        // always had, and the person's file is in it.
        const { state } = await client.request<{ state: SessionState }>("session/load", { path: sessionPath });
        expect(state.cwd, `pass ${pass}`).toBe(oldFolder);
        expect(state.agent?.sessionKind, `pass ${pass}`).toBe("chat");
        expect(state.agent?.agentName, `pass ${pass}`).toBeUndefined();
        expect(readFileSync(join(oldFolder, "notes.md"), "utf8"), `pass ${pass}`).toBe("the person's own file");

        // Nothing was moved, nothing was created beside it, and the transcript
        // still says exactly what it said.
        expect({ chat: listing(chatDir()), retired: listing(beamDir()) }, `pass ${pass}`).toEqual(before);
        expect(readFileSync(sessionPath, "utf8"), `pass ${pass}`).toBe(transcript);
        await client.request("pi/session/detach", { path: sessionPath });
      } finally {
        await stopHost(client);
      }
    }
  });
});
