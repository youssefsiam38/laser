/**
 * RP-4 end to end, with a real worker and a real engine: a conversation whose
 * runtime is released comes back exactly as it was, and one that is holding
 * work is not released at all.
 *
 * The strongest statement available is the durable revision (RP-9): it is bound
 * to the session's identity and its visible history, and it is stable across a
 * restart when the canonical content has not changed. If the revision, the
 * branch leaf and the entries all come back equal, the release cost the person
 * nothing but a reload.
 */
import { ErrorCodes, PRODUCT_NAME, isSessionRevision, isSessionWorkPin, type SessionState, type SessionUpdateParams } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

function stubProvider(): Promise<{ server: Server; url: string; requests: number }> {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      state.requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (const piece of ["Hello ", "from ", "the stub"]) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, get requests() { return state.requests; }, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }),
    ),
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
  updates(): SessionUpdateParams[] {
    return this.inbound
      .filter((message) => "method" in message && message.method === "session/update")
      .map((message) => (message as { params: SessionUpdateParams }).params);
  }
  close() { this.ws.close(); }
}

let base: string;
let host: HostServer;
let stub: Awaited<ReturnType<typeof stubProvider>>;

/** The same host, started again over the same directories. */
function restartedHost(options: ConstructorParameters<typeof HostServer>[0] = {}): HostServer {
  return new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    workerIdleMs: 600_000,
    workerSweepMs: 0,
    log: () => {},
    ...options,
  });
}

/**
 * One request, one socket, closed before the answer is used — the shape the
 * resource soak's product RPCs have, and the reason a session between two calls
 * has no holder at all.
 */
function oneShot<R>(url: string, method: string, params: unknown): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${method} timed out`));
    }, 60_000);
    socket.on("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: R; error?: { code: number; message: string } };
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) {
        const error = new Error(message.error.message) as Error & { code?: number };
        error.code = message.error.code;
        reject(error);
      } else resolve(message.result as R);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The person's own messages in the canonical record, counted from the file. */
function userMessages(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as { message?: { role?: string } };
      } catch {
        return {};
      }
    })
    .filter((entry) => entry.message?.role === "user").length;
}

/** Record every host → worker request this client sends from now on. */
function recordWorkerRequests(worker: { request: (method: string, params?: unknown) => Promise<unknown> }): string[] {
  const sent: string[] = [];
  const real = worker.request.bind(worker);
  worker.request = (method: string, params?: unknown) => {
    sent.push(method);
    return real(method, params);
  };
  return sent;
}

/** Poll a condition that another task settles, with a bound and no fixed sleep. */
async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Wait for a session to stop streaming, the way the soak does: by polling. */
async function settled(url: string, path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const loaded = await oneShot<{ state: SessionState }>(url, "session/load", { path });
    await oneShot(url, "pi/session/detach", { path }).catch(() => {});
    if (!loaded.state.isStreaming) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`session ${path} never settled`);
}

/** Naming is separate work from the turn and appends one durable record. */
async function named(path: string): Promise<void> {
  await until(() => readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        return (JSON.parse(line) as { type?: string }).type === "session_info";
      } catch {
        return false;
      }
    }), "the session name to become durable");
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-unload-`));
  for (const dir of ["project", "agent"]) mkdirSync(join(base, dir), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    // Long enough that nothing retires underneath these tests: the releases
    // here are asked for explicitly, which is what the policy does on a timer.
    workerIdleMs: 600_000,
    workerSweepMs: 0,
    log: () => {},
  });
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("releasing a session's runtime, end to end", () => {
  it("brings the same conversation back: same revision, same branch, same durable records", async () => {
    let client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "hello" }] });
      await client.waitFor((message) => "method" in message && message.method === "session/update"
        && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled");
      // The Namer is independent of the turn: agent_settled does not mean its
      // session_info append is done. Take the revision only after that intended
      // durable change, so release/reopen compares one canonical state.
      await named(state.path);

      const before = await client.request<{ revision: string; environmentKey: string; authority: string }>("session/revision", { path: state.path });
      expect(isSessionRevision(before.revision)).toBe(true);
      expect(before.authority).toBe("live");
      const entriesBefore = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: state.path });
      expect(entriesBefore.entries.length).toBeGreaterThan(0);
      const bytesBefore = readFileSync(state.path, "utf8");
      const seqBefore = client.updates().at(-1)!.seq;
      const epochBefore = client.updates().at(-1)!.epoch;
      const messagesBefore = client.updates()
        .map((params) => (params.update.kind === "state" ? params.update.state.messageCount : undefined))
        .filter((count): count is number => count !== undefined)
        .at(-1)!;
      expect(messagesBefore).toBeGreaterThan(0);

      // The person leaves: the membership authority (RP-6) stops holding it,
      // and only then may the runtime go.
      await client.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);

      // The turn is over and nothing else is holding the conversation, so the
      // release goes through on the first ask.
      const released0 = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(released0).toEqual({ unloaded: true, pins: [] });

      // And the same conversation comes back through a new host and a new
      // worker, which is how a person returns to it after a restart.
      client.close();
      await host.close();
      host = restartedHost();
      const second = new Client();
      await second.connect((await host.listen()).url);
      await second.request("session/load", { path: state.path });
      await second.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);
      const released = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(released).toEqual({ unloaded: true, pins: [] });
      client = second;
      expect(host.pool.openSessions(cwd)).toEqual([]);
      // Nothing was written, moved or deleted by the release itself.
      expect(readFileSync(state.path, "utf8")).toBe(bytesBefore);

      // Coming back re-opens it from the canonical record.
      const reopened = await client.request<{ state: SessionState; seq: number; replayFrom: number; revision?: string }>("session/load", {
        path: state.path,
        fromSeq: seqBefore,
      });
      expect(reopened.state.path).toBe(state.path);
      expect(reopened.state.messageCount).toBe(messagesBefore);
      // A fresh generation numbers from zero and says so, which is the client's
      // signal to re-read rather than believe it missed nothing.
      expect(reopened.replayFrom).not.toBe(seqBefore);
      expect(reopened.revision).toBe(before.revision);

      const after = await client.request<{ revision: string; environmentKey: string }>("session/revision", { path: state.path });
      expect(after.revision).toBe(before.revision);
      expect(after.environmentKey).toBe(before.environmentKey);
      const entriesAfter = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: state.path });
      expect(entriesAfter.leafId).toBe(entriesBefore.leafId);
      expect(entriesAfter.entries).toEqual(entriesBefore.entries);

      // And it is a working conversation again, on a new epoch.
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "again" }] });
      const settled = await client.waitFor((message) => "method" in message && message.method === "session/update"
        && (message as { params: SessionUpdateParams }).params.sessionPath === state.path
        && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled"
        && (message as { params: SessionUpdateParams }).params.epoch !== epochBefore);
      expect(settled).toBeDefined();
    } finally {
      client.close();
    }
  }, 120_000);

  it("releases a conversation nothing can name, on the first ask, with its record intact", async () => {
    // Deterministically Namer-less, and not by what a model answers: this
    // fixture connects no provider credential at all, so the host's benchmark
    // stops before it runs (`configured.length === 0` in `qualifyNamer`) and
    // the worker's naming model stays null for the whole test. A first prompt's
    // words are then parked in case one ever appears — a retained record, which
    // the diagnostics count, and not a hold on the runtime (RP-4, M18-T17).
    writeFileSync(
      join(base, "agent", "models.json"),
      JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
    );
    const client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      // The person's words go in. Whether the turn can run without a
      // credential is not what this test is about — naming them is the intent
      // that gets parked, and it is parked before the engine is asked.
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "explore the repo" }] }).catch(() => {});
      const before = await client.request<{ revision: string; authority: string }>("session/revision", { path: state.path });
      expect(isSessionRevision(before.revision)).toBe(true);
      const entriesBefore = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: state.path });
      const bytesBefore = readFileSync(state.path, "utf8");

      // The parked prompt exists, said as a count by the surface that is
      // already allowed to say it: no session path, no words, no new seam.
      const { snapshot } = await client.request<{
        snapshot: { stores?: { entries: Record<string, { count?: number }>; coverage: { complete: boolean } } };
      }>("resource/snapshot", { refresh: true });
      expect(snapshot.stores?.coverage.complete).toBe(true);
      // Exactly one: this worker holds no tray message and no tool label, so
      // the one retained record is the prompt waiting for a model.
      expect(snapshot.stores?.entries.workerCaches?.count).toBe(1);

      // The person leaves, and the first ask releases the runtime.
      await client.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);
      const released = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(released).toEqual({ unloaded: true, pins: [] });
      expect(host.pool.openSessions(cwd)).toEqual([]);

      // Nothing was written, moved or deleted by the release, and the
      // conversation comes back from its record exactly as it was.
      expect(readFileSync(state.path, "utf8")).toBe(bytesBefore);
      const reopened = await client.request<{ state: SessionState; revision?: string }>("session/load", { path: state.path });
      expect(reopened.state.path).toBe(state.path);
      expect(reopened.revision).toBe(before.revision);
      const entriesAfter = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: state.path });
      expect(entriesAfter.leafId).toBe(entriesBefore.leafId);
      expect(entriesAfter.entries).toEqual(entriesBefore.entries);
    } finally {
      client.close();
    }
  }, 120_000);

  it("refuses while a client is following it, and while a message waits in the tray", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      // A followed session is never even asked about: membership decides that.
      expect(host.sessionMembership().holders(state.path)).toBeGreaterThan(0);

      await client.request("session/pending/add", { path: state.path, content: [{ type: "text", text: "later" }] });
      await client.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);

      const refused = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(refused.unloaded).toBe(false);
      expect(refused.pins.map((pin) => pin.kind)).toContain("pending_tray");
      expect(host.pool.openSessions(cwd)).toEqual([state.path]);

      // The tray is memory only, so the refusal is what keeps the message.
      const tray = await client.request<{ messages: unknown[] }>("session/pending/list", { path: state.path });
      expect(tray.messages).toHaveLength(1);
    } finally {
      client.close();
    }
  }, 120_000);

  it("refuses a client's own attempt to manage runtimes", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    try {
      await expect(client.request("pi/session/unload", { path: join(base, "sessions", "nothing.jsonl") })).rejects.toThrow(
        /app manages its own session runtimes/,
      );
      await expect(client.request("pi/worker/safety", {})).rejects.toThrow(/app manages its own session runtimes/);
    } finally {
      client.close();
    }
  }, 60_000);
});

/**
 * RP-4c · path-routed mutation authority, at the real boundary.
 *
 * A release lets a *runtime* go; it must never let the host's authority over
 * that conversation go with it. These run a real host and the built worker, and
 * they send their mutations the way the resource soak does: one socket per call,
 * so between two calls nothing is holding the session at all.
 */
describe.skipIf(!existsSync(defaultWorkerMain()))("routing a mutation while a runtime is released", () => {
  /** A promise the test settles by hand, so ordering is asserted, not timed. */
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** Create one session, leave it, and answer with what a routed call needs. */
  async function idleSession(url: string, cwd: string): Promise<SessionState> {
    const client = new Client();
    await client.connect(url);
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "hello" }] });
      await client.waitFor((message) => "method" in message && message.method === "session/update"
        && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled");
      // `agent_settled` covers the answer, not the independent Namer append.
      // Every revision assertion after this helper needs both durable writes.
      await named(state.path);
      await client.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);
      return state;
    } finally {
      client.close();
    }
  }

  it("delivers a prompt issued while the release is in flight exactly once", async () => {
    const url = (await host.listen()).url;
    const cwd = join(base, "project");
    const state = await idleSession(url, cwd);
    const before = userMessages(state.path);

    // The sweep's release and the person's next message, in the same tick.
    const release = host.pool.unloadSession(cwd, state.path, "idle");
    const accepted = await oneShot<{ accepted: boolean }>(url, "session/prompt", {
      path: state.path,
      content: [{ type: "text", text: "while releasing" }],
    });
    expect(accepted.accepted).toBe(true);
    const outcome = await release;
    if (outcome.unloaded) {
      // The release won: the routed prompt reopened the durable session.
      expect(outcome.pins).toEqual([]);
    } else {
      // The prompt reached the worker first: unload correctly refused work in
      // flight rather than tearing its runtime away. This is the other valid
      // ordering of the race, not a failed release.
      expect(outcome.pins.some((pin) => isSessionWorkPin(pin.kind))).toBe(true);
    }
    await settled(url, state.path);
    expect(host.pool.openSessions(cwd)).toContain(state.path);

    // Both orderings deliver once: not lost to a worker that had let go, and
    // not resent after a refusal.
    expect(userMessages(state.path)).toBe(before + 1);
    expect(readFileSync(state.path, "utf8")).toContain("while releasing");
  }, 120_000);

  it("refuses when the release fails, on the failure itself, with nothing written to the worker", async () => {
    const url = (await host.listen()).url;
    const cwd = join(base, "project");
    const state = await idleSession(url, cwd);
    const before = userMessages(state.path);
    const revisionBefore = await oneShot<{ revision: string }>(url, "session/revision", { path: state.path });

    // Every host → worker request from here on, at the real boundary: the
    // acceptance criterion is zero writes, and a `session/load` appends no user
    // message, so counting bytes cannot prove it.
    const worker = await host.pool.get(cwd);
    const sent = recordWorkerRequests(worker);

    // A release that really drops the runtime and then fails, leaving the host
    // unable to prove whose bookkeeping is right: the worker has let go and the
    // pool still believes it holds the session.
    const dropped = deferred();
    const fail = deferred();
    const release = host.routeLeases.release(state.path, async () => {
      const answer = await worker.request<{ unloaded: boolean }>("pi/session/unload", { path: state.path, reason: "idle" });
      expect(answer.unloaded).toBe(true);
      dropped.resolve();
      await fail.promise;
      throw new Error("the host lost the release answer");
    });
    await dropped.promise;

    const startedAt = Date.now();
    const answer = oneShot(url, "session/prompt", { path: state.path, content: [{ type: "text", text: "refused" }] })
      .then(() => undefined, (error: Error & { code?: number }) => error);
    // Fail the release while the prompt is parked on its gate, so the refusal
    // is the gate's "failed" outcome and not the route's bound.
    await until(() => host.routeLeases.waitingRoutes(state.path) === 1, "the prompt to park on the release");
    fail.resolve();
    await expect(release).rejects.toThrow(/lost the release answer/);

    const refused = await answer;
    expect(refused?.code).toBe(ErrorCodes.SessionBusy);
    expect(refused?.message).toMatch(/being put to sleep/);
    expect(refused?.message).toMatch(/Nothing was sent/);
    // The failure, not the ten-second bound.
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    // Zero writes at the boundary itself, and nothing in the record either.
    expect(sent.filter((method) => method === "session/load" || method === "session/prompt")).toEqual([]);
    expect(userMessages(state.path)).toBe(before);
    expect(readFileSync(state.path, "utf8")).not.toContain("refused");

    // The host does not repair the divergence a failed release leaves — its
    // record of who holds the runtime and the worker's disagree, and until they
    // are reconciled even a read routed to that worker is refused by it. The
    // paths that own convergence do the repair; replacing the worker is one of
    // them, and after it the conversation is whole again and the same message
    // lands exactly once.
    await host.pool.restart(cwd);
    const revisionAfter = await oneShot<{ revision: string }>(url, "session/revision", { path: state.path });
    expect(revisionAfter.revision).toBe(revisionBefore.revision);
    const accepted = await oneShot<{ accepted: boolean }>(url, "session/prompt", {
      path: state.path,
      content: [{ type: "text", text: "sent again" }],
    });
    expect(accepted.accepted).toBe(true);
    await settled(url, state.path);
    expect(userMessages(state.path)).toBe(before + 1);
  }, 120_000);

  it("refuses on the bound when a release never finishes letting go", async () => {
    const url = (await host.listen()).url;
    const cwd = join(base, "project");
    const state = await idleSession(url, cwd);
    const before = userMessages(state.path);

    const sent = recordWorkerRequests(await host.pool.get(cwd));
    const never = deferred();
    const release = host.routeLeases.release(state.path, async () => {
      await never.promise;
      return { unloaded: false, pins: [] };
    });

    const refused = await oneShot(url, "session/prompt", { path: state.path, content: [{ type: "text", text: "over the bound" }] })
      .then(() => undefined, (error: Error & { code?: number }) => error);
    expect(refused?.code).toBe(ErrorCodes.SessionBusy);
    expect(refused?.message).toMatch(/being put to sleep/);
    expect(sent.filter((method) => method === "session/load" || method === "session/prompt")).toEqual([]);
    expect(userMessages(state.path)).toBe(before);
    expect(readFileSync(state.path, "utf8")).not.toContain("over the bound");

    never.resolve();
    await release;
    const accepted = await oneShot<{ accepted: boolean }>(url, "session/prompt", {
      path: state.path,
      content: [{ type: "text", text: "after the wait" }],
    });
    expect(accepted.accepted).toBe(true);
    await settled(url, state.path);
    expect(userMessages(state.path)).toBe(before + 1);
  }, 120_000);

  it("survives a worker that keeps releasing underneath it: every message lands, exactly once", async () => {
    // The soak's shape, small and deterministic: one loaded conversation per
    // worker, swept constantly, prompted round-robin on one-shot sockets.
    await host.close();
    host = restartedHost({ sessionLifetime: { sessionIdleMs: 1, sweepMs: 10, maxLoadedPerWorker: 1 } });
    const url = (await host.listen()).url;
    const cwd = join(base, "project");

    const states: SessionState[] = [];
    for (let index = 0; index < 3; index += 1) states.push(await idleSession(url, cwd));
    const before = states.map((state) => userMessages(state.path));

    const rounds = 6;
    for (let round = 0; round < rounds; round += 1) {
      for (const state of states) {
        const accepted = await oneShot<{ accepted: boolean }>(url, "session/prompt", {
          path: state.path,
          content: [{ type: "text", text: `round-${round}` }],
        });
        expect(accepted.accepted).toBe(true);
        await settled(url, state.path);
      }
    }

    for (const [index, state] of states.entries()) {
      expect(userMessages(state.path)).toBe(before[index]! + rounds);
    }
    // And the race was real: runtimes were actually released under the loop.
    expect(host.sessionLifetime.counts().unloaded).toBeGreaterThan(0);
  }, 180_000);

  it("keeps the deleted, zero-byte and corrupt guards closed after a release", async () => {
    const url = (await host.listen()).url;
    const cwd = join(base, "project");
    const state = await idleSession(url, cwd);
    expect((await host.pool.unloadSession(cwd, state.path, "idle")).unloaded).toBe(true);

    // Deleted between the release and the next message: refused, not recreated.
    unlinkSync(state.path);
    await expect(oneShot(url, "session/prompt", { path: state.path, content: [{ type: "text", text: "gone" }] })).rejects.toThrow(
      /no saved transcript|no project known|no longer|not a valid/,
    );
    expect(existsSync(state.path)).toBe(false);

    const zero = await idleSession(url, cwd);
    expect((await host.pool.unloadSession(cwd, zero.path, "idle")).unloaded).toBe(true);
    truncateSync(zero.path, 0);
    await expect(oneShot(url, "session/prompt", { path: zero.path, content: [{ type: "text", text: "zero" }] })).rejects.toThrow();
    expect(readFileSync(zero.path, "utf8")).toBe("");

    const corrupt = await idleSession(url, cwd);
    expect((await host.pool.unloadSession(cwd, corrupt.path, "idle")).unloaded).toBe(true);
    writeFileSync(corrupt.path, "not json\n");
    await expect(oneShot(url, "session/prompt", { path: corrupt.path, content: [{ type: "text", text: "corrupt" }] })).rejects.toThrow();
    expect(readFileSync(corrupt.path, "utf8")).toBe("not json\n");
  }, 180_000);
});
