import { PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import type { UiDialogRequest, UiFireAndForget } from "@lasercode/protocol";
import { createUiBridge } from "../src/ui-bridge.js";

type DialogOptions = { signal?: AbortSignal; timeout?: number };

type Ctx = {
  select: (title: string, options: string[], opts?: DialogOptions) => Promise<string | undefined>;
  confirm: (title: string, message?: string, opts?: DialogOptions) => Promise<boolean>;
  input: (title: string, placeholder?: string, opts?: DialogOptions) => Promise<string | undefined>;
  editor: (title: string, prefill?: string) => Promise<string | undefined>;
  custom: () => Promise<unknown>;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
};

/** Test harness: a bridge plus the requests and fire-and-forget events it produced. */
function harness(options?: Parameters<typeof createUiBridge>[1]) {
  const requests: UiDialogRequest[] = [];
  const events: UiFireAndForget[] = [];
  const bridge = createUiBridge(
    { onRequest: (r) => requests.push(r), onEvent: (e) => events.push(e) },
    options ?? {},
  );
  return { bridge, requests, events, ctx: bridge.context as unknown as Ctx };
}

const resolved = (events: UiFireAndForget[]): string[] =>
  events.filter((e): e is { method: "dialogResolved"; id: string } => e.method === "dialogResolved").map((e) => e.id);

describe("ui bridge", () => {
  // Ids used to be `ui-<counter>-<ms base36>`, so two sessions in one worker
  // that raised their first dialog in the same millisecond minted the same id
  // and one answer settled both.
  it("mints ids that are unique per bridge, not per millisecond", () => {
    const a = harness();
    const b = harness();
    void a.ctx.confirm("A?");
    void b.ctx.confirm("B?");
    void a.ctx.confirm("A2?");
    expect(a.requests.map((r) => r.id)).not.toContain(b.requests[0]!.id);
    expect(new Set([...a.requests, ...b.requests].map((r) => r.id)).size).toBe(3);
  });

  it("select round-trips and confirm cancels to false", async () => {
    const { bridge, requests, events, ctx } = harness();

    const p = ctx.select("Pick", ["a", "b"]);
    expect(requests).toHaveLength(1);
    bridge.respond({ id: requests[0]!.id, value: "b" });
    await expect(p).resolves.toBe("b");

    const c = ctx.confirm("Sure?");
    bridge.respond({ id: requests[1]!.id, cancelled: true });
    await expect(c).resolves.toBe(false);

    await expect(ctx.custom()).resolves.toBeUndefined();
    ctx.notify("hi", "warning");
    expect(events).toEqual([{ method: "notify", message: "hi", level: "warning" }]);
  });

  it("input and editor round-trip; unknown members are safe no-ops", async () => {
    const { bridge, requests, ctx } = harness();
    const extended = ctx as Ctx & { someFutureMethod?: () => unknown };

    const i = ctx.input("Name?", "type here");
    expect(requests[0]).toMatchObject({ method: "input", title: "Name?", placeholder: "type here" });
    bridge.respond({ id: requests[0]!.id, value: PRODUCT_NAME });
    await expect(i).resolves.toBe(PRODUCT_NAME);

    const e = ctx.editor("Edit", "line1\nline2");
    expect(requests[1]).toMatchObject({ method: "editor", prefill: "line1\nline2" });
    bridge.respond({ id: requests[1]!.id, value: "edited" });
    await expect(e).resolves.toBe("edited");

    // A member added by a future Pi release must not throw inside an extension.
    expect(typeof extended.someFutureMethod).toBe("function");
    expect(extended.someFutureMethod?.()).toBeUndefined();

    // Pending dialogs are visible for reattach, and dispose settles them safely.
    const p = ctx.select("Pick", ["a"]);
    expect(bridge.pending()).toHaveLength(1);
    bridge.dispose();
    await expect(p).resolves.toBeUndefined();
    expect(bridge.pending()).toHaveLength(0);
  });

  it("times out to the safe default", async () => {
    const { bridge, ctx } = harness();
    await expect(ctx.select("Pick", ["a"], { timeout: 5 })).resolves.toBeUndefined();
    expect(bridge.pending()).toHaveLength(0);
  });

  // ----------------------------------------------------- tool-call stamping

  it("stamps toolCallId when exactly one tool call is executing", () => {
    let current: string | undefined;
    const { requests, ctx } = harness({ pendingToolCallId: () => current });

    // Free-standing: nothing executing.
    ctx.select("Pick", ["a"]);
    expect(requests[0]).not.toHaveProperty("toolCallId");

    // Tool-associated: the driver reports single-tool causality.
    current = "call-7";
    void ctx.confirm("Run it?", "rm -rf /tmp/x");
    expect(requests[1]).toMatchObject({ method: "confirm", toolCallId: "call-7" });

    // Back to free-standing: two tools running ⇒ the driver returns undefined.
    current = undefined;
    void ctx.input("Name?");
    expect(requests[2]).not.toHaveProperty("toolCallId");

    // The getter is consulted per dialog, never cached.
    current = "call-9";
    void ctx.editor("Edit", "x");
    expect(requests[3]).toMatchObject({ method: "editor", toolCallId: "call-9" });
  });

  it("does not stamp toolCallId when no getter is supplied", () => {
    const { requests, ctx } = harness();
    void ctx.select("Pick", ["a"]);
    expect(requests[0]).not.toHaveProperty("toolCallId");
    expect(Object.keys(requests[0]!)).toEqual(["method", "title", "options", "id"]);
  });

  it("a throwing getter degrades to a free-standing dialog", async () => {
    const { bridge, requests, ctx } = harness({
      pendingToolCallId: () => {
        throw new Error("Pi state moved");
      },
    });
    const p = ctx.select("Pick", ["a"]);
    expect(requests[0]).not.toHaveProperty("toolCallId");
    bridge.respond({ id: requests[0]!.id, value: "a" });
    await expect(p).resolves.toBe("a");
  });

  // ---------------------------------------------------- dialogResolved rules

  it("abort settles with the safe default and emits dialogResolved", async () => {
    const { bridge, requests, events, ctx } = harness();
    const controller = new AbortController();

    const p = ctx.select("Pick", ["a", "b"], { signal: controller.signal });
    expect(bridge.pending()).toHaveLength(1);
    expect(events).toHaveLength(0);

    controller.abort();
    await expect(p).resolves.toBeUndefined();
    expect(resolved(events)).toEqual([requests[0]!.id]);
    expect(bridge.pending()).toHaveLength(0);

    // confirm's safe default is `false`, not undefined.
    const second = new AbortController();
    const c = ctx.confirm("Sure?", "really", { signal: second.signal });
    second.abort();
    await expect(c).resolves.toBe(false);
    expect(resolved(events)).toEqual([requests[0]!.id, requests[1]!.id]);
  });

  it("an already-aborted signal never raises a dialog", async () => {
    const { bridge, requests, events, ctx } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(ctx.select("Pick", ["a"], { signal: controller.signal })).resolves.toBeUndefined();
    await expect(ctx.confirm("Sure?", "really", { signal: controller.signal })).resolves.toBe(false);
    expect(requests).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(bridge.pending()).toHaveLength(0);
  });

  it("timeout emits dialogResolved so clients drop the dialog", async () => {
    const { bridge, requests, events, ctx } = harness();
    await expect(ctx.input("Name?", undefined, { timeout: 5 })).resolves.toBeUndefined();
    expect(resolved(events)).toEqual([requests[0]!.id]);
    expect(bridge.pending()).toHaveLength(0);
  });

  it("dispose emits dialogResolved for every dialog still waiting", async () => {
    const { bridge, requests, events, ctx } = harness();
    const a = ctx.select("Pick", ["a"]);
    const b = ctx.confirm("Sure?", "really");
    expect(bridge.pending()).toHaveLength(2);

    bridge.dispose();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBe(false);
    expect(resolved(events)).toEqual([requests[0]!.id, requests[1]!.id]);

    // After dispose, dialogs settle immediately and emit nothing.
    events.length = 0;
    await expect(ctx.select("Pick", ["a"])).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(events).toHaveLength(0);
  });

  it("a client answer never emits dialogResolved", async () => {
    const { bridge, requests, events, ctx } = harness();

    const a = ctx.select("Pick", ["a"], { timeout: 1000 });
    bridge.respond({ id: requests[0]!.id, value: "a" });
    await expect(a).resolves.toBe("a");

    const b = ctx.confirm("Sure?", "really");
    bridge.respond({ id: requests[1]!.id, confirmed: true });
    await expect(b).resolves.toBe(true);

    const c = ctx.input("Name?");
    bridge.respond({ id: requests[2]!.id, cancelled: true });
    await expect(c).resolves.toBeUndefined();

    expect(resolved(events)).toEqual([]);
    // The answered timeout dialog must not fire later either.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved(events)).toEqual([]);
  });

  it("an abort after the client answered changes nothing", async () => {
    const { bridge, requests, events, ctx } = harness();
    const controller = new AbortController();

    const p = ctx.select("Pick", ["a"], { signal: controller.signal });
    bridge.respond({ id: requests[0]!.id, value: "a" });
    await expect(p).resolves.toBe("a");

    controller.abort();
    expect(resolved(events)).toEqual([]);
  });
});
