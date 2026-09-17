/**
 * RP-5b item 7, the premise test, against the real pinned engine.
 *
 * A body too large for this surface to hold is shown as an excerpt with a
 * reference to where the rest is, and that reference needs the entry the engine
 * wrote it into. For a user message the driver already proves this works: it
 * holds `message_end` for one microtask and reads back the entry whose
 * `message` is the very object the event carried.
 *
 * This asks the same question of an assistant reply and a tool result: by the
 * time that microtask runs, has the engine persisted them, and is the persisted
 * entry's `message` the same object? If it is not, nothing downstream of this
 * can be built on it — and the answer belongs in a test, not in an assumption.
 */
import { PRODUCT_NAME, type JsonRpcMessage } from "@lasercode/protocol";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { WorkerServer } from "../src/server.js";
import { startStubProvider, toolNamesOf, writeStubModels, type StubProvider, type StubRequest } from "./agents/stub-provider.js";

let base: string;
let stub: StubProvider;

const REPLY = "答".repeat(200_000); // 600 KB of UTF-8: an excerpt plus a reference

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-settled-`));
  mkdirSync(join(base, "project"), { recursive: true });
  // Multi-byte and longer than a read returns, so the result carries details.
  writeFileSync(join(base, "project", "README.md"), Array.from({ length: 3000 }, (_, index) => `${index} héllo 😀 ✓`).join("\n") + "\n");
  mkdirSync(join(base, "sessions"), { recursive: true });
  stub = await startStubProvider((request: StubRequest) => {
    const sawToolResult = request.messages.some((message) => message.role === "tool");
    if (!sawToolResult && toolNamesOf(request).includes("read")) {
      return { toolCall: { name: "read", args: { path: join(base, "project", "README.md") } } };
    }
    return { text: REPLY };
  });
  writeStubModels(join(base, "agent"), stub.url);
});

afterEach(async () => {
  await stub.close();
  rmSync(base, { recursive: true, force: true });
});

it("persists an assistant reply and a tool result by the time their message_end is delivered", async () => {
  const out: JsonRpcMessage[] = [];
  const server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => new StableSdkDriver(),
    send: (message) => out.push(message),
    features: [],
    projectTrusted: true,
  });
  try {
    const call = async (id: number, method: string, params?: unknown) => {
      await server.handle({ jsonrpc: "2.0", id, method, params });
      return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { message: string } };
    };
    const created = await call(1, "session/new", { cwd: join(base, "project") });
    expect(created.error).toBeUndefined();
    const path = (created.result as { state: { path: string } }).state.path;
    const prompted = await call(2, "session/prompt", { path, content: [{ type: "text", text: "Read the file and answer." }] });
    expect(prompted.result).toEqual({ accepted: true, queued: false });

    const updates = () => out
      .filter((message) => "method" in message && message.method === "session/update")
      .map((message) => (message as { params: { update: { kind: string; role?: string; entry?: { id: string } } } }).params.update);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !updates().some(update => update.kind === "agent_settled")) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const ends = updates().filter(update => update.kind === "message_end") as Array<{
      kind: string; role?: string;
      entry?: { id: string; parentId: string | null; revision?: string; omitted?: number; truncated?: true;
        bodies?: Array<{ component: { kind: string; index?: number }; totalBytes: number; contentDigest: string }> };
    }>;
    const roles = ends.map(end => end.role);
    // The turn happened at all: a user prompt, a tool result, an assistant reply.
    expect(roles, JSON.stringify({ roles, updates: updates().map(u => u.kind) })).toContain("assistant");
    // The user message carries its entry today; that is the rule this asks about.
    const user = ends.find(end => end.role === "user");
    expect(user?.entry?.id, "the proven case: a user message_end carries its entry").toBeDefined();

    // The premise: the engine has written the assistant reply and the tool
    // result by the time their `message_end` reaches a listener, so the same
    // read-back can name their entries. Proven here through the session file,
    // which is what the driver reads back from `sessionManager`.
    const stored = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } });
    const assistantEntries = stored.filter(entry => entry.type === "message" && entry.message?.role === "assistant");
    const toolEntries = stored.filter(entry => entry.type === "message" && entry.message?.role === "toolResult");
    expect(assistantEntries.length, "the engine persisted the assistant reply").toBeGreaterThan(0);
    expect(toolEntries.length, "the engine persisted the tool result").toBeGreaterThan(0);
    // And the assistant entry holds the large body this surface cannot keep.
    expect(JSON.stringify(assistantEntries.at(-1)).length).toBeGreaterThan(100_000);

    // The premise holds, so the settle carries canonical identity: the entry
    // the engine wrote, the revision that state has, and the exact size and
    // digest of each body — enough to read the rest without reopening.
    const assistantEnd = ends.findLast(end => end.role === "assistant");
    expect(assistantEnd?.entry?.id, JSON.stringify(ends.map(e => [e.role, e.entry?.id]))).toBeDefined();
    expect(assistantEnd!.entry!.revision, `revision was ${assistantEnd!.entry!.revision}`).toBeTypeOf("string");
    const text = assistantEnd!.entry!.bodies?.find(body => body.component.kind === "assistant_text");
    expect(text?.totalBytes).toBe(Buffer.byteLength(REPLY, "utf8"));
    expect(text?.contentDigest).toBe(createHash("sha256").update(REPLY, "utf8").digest("hex"));
    // Bounded metadata: a handful of components, never an unbounded frame.
    expect(assistantEnd!.entry!.bodies!.length).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(assistantEnd!.entry!.bodies), "utf8")).toBeLessThanOrEqual(4096);

    // A tool result is named the same way, while the turn continues.
    const toolEnd = ends.find(end => end.role === "tool" || end.role === "toolResult" as string);
    expect(toolEnd?.entry?.id, JSON.stringify(ends.map(e => [e.role, e.entry?.id]))).toBeDefined();
    expect(toolEnd!.entry!.bodies?.some(body => body.component.kind === "tool_result")).toBe(true);
    // Ordering is unchanged: every message_end still precedes what follows it.
    const kinds = updates().map(update => update.kind);
    expect(kinds.indexOf("agent_settled")).toBeGreaterThan(kinds.lastIndexOf("message_end"));

    // And the identity is usable as it stands: the reply is read back at that
    // exact revision, from this worker, with no reopen and no second read of
    // the conversation to discover what to ask for.
    // The revision it was written at is reported, and the conversation has
    // moved on since — so the reader asks for the current one, exactly as the
    // viewer does, and the digest is what proves the bytes are this body.
    const now = (await call(3, "session/revision", { path })).result as { environmentKey: string; revision: string };
    expect(typeof assistantEnd!.entry!.revision).toBe("string");
    const read = await call(4, "session/entry_range", {
      path, environmentKey: now.environmentKey, revision: now.revision,
      entryId: assistantEnd!.entry!.id, component: { kind: "assistant_text" }, offset: 0, limit: 64 * 1024,
    });
    expect(read.error?.message).toBeUndefined();
    const slice = read.result as { text: string; totalBytes: number; contentDigest: string; authority: string };
    expect(slice.authority).toBe("live");
    expect(slice.totalBytes).toBe(text!.totalBytes);
    expect(slice.contentDigest).toBe(text!.contentDigest);
    expect(REPLY.startsWith(slice.text)).toBe(true);

    // D-275: the tool's output is addressable as plain text from the live
    // authority, whatever details the result carries, and the settle names it
    // with exactly the size and digest a reader reassembles.
    const toolLive = updates().find(update => update.kind === "tool_execution_end") as unknown as { result: { content: Array<{ type: string; text?: string }>; details?: unknown } };
    const output = toolLive.result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("");
    expect(output).toContain("héllo 😀");
    expect(toolLive.result.details, "the read was truncated, so the result carries details").toBeDefined();
    const named = toolEnd!.entry!.bodies!.find(body => body.component.kind === "tool_output");
    expect(named).toEqual({ component: { kind: "tool_output" }, totalBytes: Buffer.byteLength(output, "utf8"), contentDigest: createHash("sha256").update(output, "utf8").digest("hex") });
    let offset: number | undefined = 0;
    let whole = "";
    for (let id = 10; offset !== undefined && id < 200; id++) {
      const part = await call(id, "session/entry_range", {
        path, environmentKey: now.environmentKey, revision: now.revision,
        entryId: toolEnd!.entry!.id, component: { kind: "tool_output" }, offset, limit: 4093,
      });
      expect(part.error?.message).toBeUndefined();
      const got = part.result as { text: string; next?: number; contentDigest: string; authority: string };
      expect(got.authority).toBe("live");
      expect(got.contentDigest).toBe(named!.contentDigest);
      whole += got.text;
      offset = got.next;
    }
    expect(whole).toBe(output);
  } finally {
    await server.dispose();
  }
}, 60_000);
