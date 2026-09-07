import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/catalog.js";
import { searchSessions, searchableMessage } from "../src/session-search.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "session-search-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
function save(id: string, entries: unknown[]) {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, [{ type: "session", version: 3, id, cwd: "/project" }, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
  return path;
}
describe("full-history search", () => {
  it("finds deep history and prefers the user's excerpt over earlier reasoning and replies", async () => {
    const path = save("one", [message("user", "Start here"), message("assistant", [{ type: "thinking", thinking: "Apple internally" }, { type: "text", text: "Apple response" }]), message("user", "Please inspect Apple and APPLE")]);
    const result = await searchSessions(new SessionCatalog(dir).list(), "apple");
    expect(result.hits).toEqual([{ path, count: 4, source: "user", excerpt: "Please inspect Apple and APPLE" }]);
  });
  it("searches tools but never indexes image data or non-message metadata", () => {
    expect(searchableMessage(message("assistant", [{ type: "image", data: "secret" }, { type: "toolCall", name: "read", arguments: { path: "file.ts" } }]))).toEqual([{ source: "tool", text: 'file.ts' }]);
    expect(searchableMessage({ type: "custom", data: "secret" })).toEqual([]);
  });
  it("keeps escapes literal and tolerates torn lines", async () => {
    const path = save("escape", [message("assistant", [{ type: "text", text: String.raw`printf 'a\nb'` }])]);
    writeFileSync(path, (await import("node:fs")).readFileSync(path, "utf8") + "{broken\n");
    const result = await searchSessions(new SessionCatalog(dir).list(), String.raw`\n`);
    expect(result.hits[0]?.excerpt).toContain(String.raw`\n`);
    expect(result.unreadable).toBe(0);
  });
  it("excludes tool keys and metadata but finds command in visible input/output and unfinished calls", async () => {
    const call = (id: string, command: string) => message("assistant", [{ type: "toolCall", id, name: "bash", arguments: { command, timeout: 123456 } }]);
    save("keys-only", [call("a", "echo hello"), { type: "message", message: { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "hello" }], details: { command: "hidden command" } } }]);
    const visible = save("visible", [call("b", "command -v node"), { type: "message", message: { role: "toolResult", toolCallId: "b", toolName: "bash", content: [{ type: "text", text: "command found" }] } }, call("c", "command -v git")]);
    const sessions = new SessionCatalog(dir).list();
    expect((await searchSessions(sessions, "command")).hits).toEqual([{ path: visible, count: 3, source: "tool", excerpt: "command -v node" }]);
    expect((await searchSessions(sessions, "123456")).hits).toEqual([]);
    expect((await searchSessions(sessions, "bash")).hits).toEqual([]);
  });
  it("paginates dense results without losing sessions", async () => {
    for (let i = 0; i < 51; i++) save(String(i), [message("user", "Apple")]);
    const sessions = new SessionCatalog(dir).list();
    const first = await searchSessions(sessions, "Apple");
    expect(first.hits).toHaveLength(50);
    const last = await searchSessions(sessions, "Apple", first.nextCursor);
    expect(last.hits).toHaveLength(1);
    expect(new Set([...first.hits, ...last.hits].map(h => h.path)).size).toBe(51);
    expect(last.nextCursor).toBeUndefined();
  });
  it("reports unreadable files rather than claiming no match", async () => {
    save("missing", [message("user", "Apple")]);
    const sessions = new SessionCatalog(dir).list();
    rmSync(sessions[0]!.path);
    expect((await searchSessions(sessions, "Apple")).unreadable).toBe(1);
  });
});
