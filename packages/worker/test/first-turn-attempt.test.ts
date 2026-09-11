import { describe, expect, it } from "vitest";
import type { SessionAppendTransaction, SessionManager } from "@earendil-works/pi-coding-agent";
import { FirstTurnAttempt } from "../src/drivers/first-turn-attempt.js";

const manager = {} as SessionManager;
const transaction = {} as SessionAppendTransaction;

describe("FirstTurnAttempt", () => {
  it("keeps one complete discriminated attempt and rejects illegal transitions", () => {
    const owner = new FirstTurnAttempt<{ before: string }, { after: string }>();
    const attempt = owner.start({ before: "a" }, manager, transaction);
    expect(attempt.phase).toBe("preparing");
    expect(() => owner.start({ before: "b" }, manager, transaction)).toThrow(/already active/);
    expect(() => owner.takeForCommit()).toThrow(/incomplete preparing/);

    owner.markPrepared({ after: "b" });
    expect(owner.takeForCommit()).toMatchObject({ phase: "prepared", prepared: { after: "b" } });
    expect(owner.active).toBeUndefined();
  });

  it("owns cancellation, late dialogs, restoration, and deferred projections", () => {
    const owner = new FirstTurnAttempt<null, true>();
    const attempt = owner.start(null, manager, transaction);
    expect(owner.ownDialog("open")).toBe(true);
    expect(owner.defer({ type: "update", update: { kind: "agent_start" } })).toBe(true);
    expect(owner.defer({ type: "ui_request", request: { id: "q", method: "input", title: "Q" } })).toBe(false);
    expect(owner.cancel()).toEqual(["open"]);
    expect(owner.ownDialog("late")).toBe(false);

    expect(owner.beginRestore()).toBe(attempt);
    expect(attempt.phase).toBe("restoring");
    expect(() => owner.beginRestore()).toThrow(/already active/);
    owner.finishRestore(attempt);
    expect(owner.active).toBeUndefined();
  });
});
