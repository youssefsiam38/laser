import { describe, expect, it } from "vitest";
import type { SessionAppendTransaction, SessionManager } from "@earendil-works/pi-coding-agent";
import { FirstTurnAttempt } from "../src/drivers/first-turn-attempt.js";

const manager = {} as SessionManager;
const transaction = {} as SessionAppendTransaction;

describe("FirstTurnAttempt", () => {
  it("keeps phase-required prepared data and rejects double or illegal transitions", () => {
    const coordinator = new FirstTurnAttempt<{ before: string }, { after: string }>();
    const owner = coordinator.start({ before: "a" }, manager, transaction);
    expect(coordinator.active).toBe(true);
    expect(() => coordinator.start({ before: "b" }, manager, transaction)).toThrow(/already active/);
    expect(() => coordinator.takeForCommit()).toThrow(/incomplete preparing/);

    coordinator.markPrepared(owner, { after: "b" });
    expect(() => coordinator.markPrepared(owner, { after: "again" })).toThrow(/prepared first-turn attempt/);

    const committed = coordinator.takeForCommit();
    expect(committed.phase).toBe("prepared");
    expect(committed.prepared).toEqual({ after: "b" });
    expect(coordinator.active).toBe(false);
    expect(() => coordinator.takeForCommit()).toThrow(/without an active/);
  });

  it("rejects stale async preparation after dispose and a new start", () => {
    const coordinator = new FirstTurnAttempt<string, string>();
    const stale = coordinator.start("old", manager, transaction);
    expect(coordinator.takeForDispose()).toMatchObject({ phase: "preparing", previous: "old" });
    expect(coordinator.active).toBe(false);

    const current = coordinator.start("new", manager, transaction);
    expect(coordinator.owns(stale)).toBe(false);
    expect(coordinator.owns(current)).toBe(true);
    expect(() => coordinator.markPrepared(stale, "stale result")).toThrow(/stale first-turn attempt ownership/);
    coordinator.markPrepared(current, "current result");
    expect(coordinator.takeForCommit()).toMatchObject({ previous: "new", prepared: "current result" });
  });

  it("rejects cancelled preparation and commit while restoration retains ownership", () => {
    const preparing = new FirstTurnAttempt<null, true>();
    const preparingOwner = preparing.start(null, manager, transaction);
    expect(preparing.cancel()).toEqual([]);
    expect(() => preparing.markPrepared(preparingOwner, true)).toThrow(/cancelled.*prepared/);
    const restoringPreparing = preparing.beginRestore(preparingOwner)!;
    expect(restoringPreparing.phase).toBe("restoring");
    preparing.finishRestore(restoringPreparing);

    const prepared = new FirstTurnAttempt<null, true>();
    const preparedOwner = prepared.start(null, manager, transaction);
    prepared.markPrepared(preparedOwner, true);
    prepared.cancel();
    expect(() => prepared.takeForCommit()).toThrow(/commit a cancelled/);
    const restoringPrepared = prepared.beginRestore(preparedOwner)!;
    prepared.finishRestore(restoringPrepared);
  });

  it("owns cancellation, late dialogs, restoration, and deferred projections", () => {
    const coordinator = new FirstTurnAttempt<null, true>();
    const owner = coordinator.start(null, manager, transaction);
    expect(coordinator.ownDialog("open")).toBe(true);
    expect(coordinator.defer({ type: "update", update: { kind: "agent_start" } })).toBe(true);
    expect(coordinator.defer({ type: "ui_request", request: { id: "q", method: "input", title: "Q" } })).toBe(false);
    expect(coordinator.cancel()).toEqual(["open"]);
    expect(coordinator.ownDialog("late")).toBe(false);

    const restoring = coordinator.beginRestore(owner)!;
    expect(restoring.phase).toBe("restoring");
    expect(() => coordinator.beginRestore(owner)).toThrow(/already active/);
    coordinator.finishRestore(restoring);
    expect(coordinator.active).toBe(false);
    expect(() => coordinator.finishRestore(restoring)).toThrow(/without an active/);
  });
});
