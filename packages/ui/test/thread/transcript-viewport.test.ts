// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";

describe("scoped transcript destinations", () => {
  it("settles cancellation without waiting for an unloaded-entry request", async () => {
    const controller = new TranscriptViewport(); controller.configure("/one");
    let resolve!: () => void;
    const pending = controller.ensureVisible({ messageId: "old" }, { reason: "find", locate: () => new Promise<void>(done => { resolve = done; }) });
    controller.configure("/two");
    expect(await pending).toBe("cancelled");
    resolve();
    expect(await controller.ensureVisible({ messageId: "absent" }, { reason: "map" })).toBe("missing");
  });
  it("cancels a scheduled mount/focus when its caller closes", async () => {
    const controller = new TranscriptViewport(); controller.configure("/one"); controller.setIds(["message"]);
    const abort = new AbortController();
    const pending = controller.ensureVisible({ messageId: "message" }, { reason: "focus", signal: abort.signal });
    abort.abort(); expect(await pending).toBe("cancelled");
  });
  it("keeps main and Beam intents independent even at the same canonical path", async () => {
    const main = new TranscriptViewport(), beam = new TranscriptViewport();
    main.configure("/same"); beam.configure("/same");
    let finish!: () => void;
    const mainPending = main.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(() => {}) });
    const beamPending = beam.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(done => { finish = done; }) });
    main.cancel(); expect(await mainPending).toBe("cancelled");
    finish(); expect(await beamPending).toBe("missing");
  });
});
