import { describe, expect, it } from "vitest";
import type { UiDialogRequest, UiFireAndForget } from "@piorbit/protocol";
import { createUiBridge } from "../src/ui-bridge.js";

type Ctx = {
  select: (title: string, options: string[], opts?: { timeout?: number }) => Promise<string | undefined>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  custom: () => Promise<unknown>;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
};

describe("ui bridge", () => {
  it("select round-trips and confirm cancels to false", async () => {
    const requests: UiDialogRequest[] = [];
    const events: UiFireAndForget[] = [];
    const bridge = createUiBridge({ onRequest: (r) => requests.push(r), onEvent: (e) => events.push(e) });
    const ctx = bridge.context as Ctx;

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
    const requests: UiDialogRequest[] = [];
    const bridge = createUiBridge({ onRequest: (r) => requests.push(r), onEvent: () => {} });
    const ctx = bridge.context as Ctx & {
      input: (title: string, placeholder?: string) => Promise<string | undefined>;
      editor: (title: string, prefill?: string) => Promise<string | undefined>;
      someFutureMethod?: () => unknown;
    };

    const i = ctx.input("Name?", "type here");
    expect(requests[0]).toMatchObject({ method: "input", title: "Name?", placeholder: "type here" });
    bridge.respond({ id: requests[0]!.id, value: "piorbit" });
    await expect(i).resolves.toBe("piorbit");

    const e = ctx.editor("Edit", "line1\nline2");
    expect(requests[1]).toMatchObject({ method: "editor", prefill: "line1\nline2" });
    bridge.respond({ id: requests[1]!.id, value: "edited" });
    await expect(e).resolves.toBe("edited");

    // A member added by a future Pi release must not throw inside an extension.
    expect(typeof ctx.someFutureMethod).toBe("function");
    expect(ctx.someFutureMethod?.()).toBeUndefined();

    // Pending dialogs are visible for reattach, and dispose settles them safely.
    const p = ctx.select("Pick", ["a"]);
    expect(bridge.pending()).toHaveLength(1);
    bridge.dispose();
    await expect(p).resolves.toBeUndefined();
    expect(bridge.pending()).toHaveLength(0);
  });

  it("times out to the safe default", async () => {
    const bridge = createUiBridge({ onRequest: () => {}, onEvent: () => {} });
    const ctx = bridge.context as Ctx;
    await expect(ctx.select("Pick", ["a"], { timeout: 5 })).resolves.toBeUndefined();
    expect(bridge.pending()).toHaveLength(0);
  });
});
