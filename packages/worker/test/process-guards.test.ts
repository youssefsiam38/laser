/**
 * The worker's unhandled-rejection guard (review findings #2 and #12).
 *
 * Node ends a process on an unhandled rejection, and this process is every
 * conversation in one project. The guard turns that into a log line.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installUnhandledRejectionGuard, UNHANDLED_REJECTION_MESSAGE } from "../src/process-guards.js";

describe("installUnhandledRejectionGuard", () => {
  it("logs the reason and leaves the process running", () => {
    const target = new EventEmitter();
    const logged: Array<[string, unknown]> = [];
    installUnhandledRejectionGuard(target, (message, detail) => logged.push([message, detail]));

    // Node emits this instead of ending the process once a listener exists.
    expect(target.listenerCount("unhandledRejection")).toBe(1);
    target.emit("unhandledRejection", new Error("the session driver was being replaced"));

    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toBe(UNHANDLED_REJECTION_MESSAGE);
    expect(String(logged[0]![1])).toContain("the session driver was being replaced");
  });

  it("reports a rejection that is not an error, and can be removed again", () => {
    const target = new EventEmitter();
    const logged: unknown[] = [];
    const remove = installUnhandledRejectionGuard(target, (_message, detail) => logged.push(detail));

    target.emit("unhandledRejection", "no reason given");
    expect(logged).toEqual(["no reason given"]);

    remove();
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });
});
