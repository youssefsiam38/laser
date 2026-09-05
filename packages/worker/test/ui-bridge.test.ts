import { describe, expect, it } from "vitest";
import type { UiDialogRequest, UiFireAndForget } from "@piorbit/protocol";
import { createUiBridge } from "../src/ui-bridge.js";

type Ctx = {
  select: (title: string, options: string[], opts?: { timeout?: number }) => Promise<string | undefined>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  custom: () => unknown;
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

    expect(ctx.custom()).toBeUndefined();
    ctx.notify("hi", "warning");
    expect(events).toEqual([{ method: "notify", message: "hi", level: "warning" }]);
  });

  it("times out to the safe default", async () => {
    const bridge = createUiBridge({ onRequest: () => {}, onEvent: () => {} });
    const ctx = bridge.context as Ctx;
    await expect(ctx.select("Pick", ["a"], { timeout: 5 })).resolves.toBeUndefined();
    expect(bridge.pending()).toHaveLength(0);
  });
});
