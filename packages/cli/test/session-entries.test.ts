import { describe, expect, it, vi } from "vitest";
import { incompleteEntriesNote, readSessionEntries } from "../src/commands/session.js";
import type { HostRpc } from "../src/rpc.js";

function rpcWith(result: unknown): { rpc: HostRpc; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => result);
  return {
    request,
    rpc: { request, close: () => undefined } as unknown as HostRpc,
  };
}

describe("session entries", () => {
  it("asks the host for exactly the bounded tail the person requested", async () => {
    const h = rpcWith({ entries: [], leafId: null, window: { complete: true } });
    await readSessionEntries(h.rpc, "/sessions/one.jsonl", 17);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("pi/session/entries", {
      path: "/sessions/one.jsonl",
      window: { tail: 17 },
    });
  });

  it("keeps even a non-positive limit bounded and explains an incomplete result", async () => {
    const h = rpcWith({ entries: [], leafId: null, window: { complete: false } });
    const result = await readSessionEntries(h.rpc, "/sessions/one.jsonl", 0);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("pi/session/entries", {
      path: "/sessions/one.jsonl",
      window: { tail: 1 },
    });
    expect(incompleteEntriesNote(result.window)).toMatch(/older entries.*increase --limit/);
    expect(incompleteEntriesNote({ complete: true } as NonNullable<typeof result.window>)).toBeUndefined();
  });
});
