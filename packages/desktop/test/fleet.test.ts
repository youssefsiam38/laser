/**
 * M5-T1/M5-T4: the model behind the tray counts and the notification gate.
 *
 * Tested because it is a state machine whose bugs are invisible in a screenshot
 * and expensive in practice: a reconnect that fires a banner per session, or a
 * count that keeps saying "2 running" after the host went away.
 */
import { describe, expect, it } from "vitest";
import type { ProjectInfo, SessionSummary } from "@lasercode/protocol";
import { FleetModel, shouldNotify, type AttentionChange } from "../src/fleet.js";

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "path" | "cwd">): SessionSummary {
  return {
    id: overrides.path,
    createdAt: "2026-09-05T10:00:00.000Z",
    modifiedAt: "2026-09-05T10:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

function project(cwd: string, name: string): ProjectInfo {
  return { cwd, name, addedAt: "2026-09-01T00:00:00.000Z", trust: "not_required", pinned: true, sessionCount: 1 };
}

describe("FleetModel", () => {
  it("counts running and needs-you per project, and totals them", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setProjects([project("/w/alpha", "alpha"), project("/w/beta", "beta")]);
    model.setSessions([
      summary({ path: "/s/a1", cwd: "/w/alpha", attention: "working" }),
      summary({ path: "/s/a2", cwd: "/w/alpha", attention: "waiting_for_input" }),
      summary({ path: "/s/a3", cwd: "/w/alpha", attention: "idle" }),
      summary({ path: "/s/b1", cwd: "/w/beta", attention: "working" }),
    ]);

    const snapshot = model.snapshot();
    expect(snapshot.running).toBe(2);
    expect(snapshot.waiting).toBe(1);
    // The project that wants a person sorts first, whatever its name.
    expect(snapshot.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(snapshot.projects[0]).toMatchObject({ running: 1, waiting: 1 });
    // Inside a project: waiting, then working, then idle.
    expect(snapshot.projects[0]?.sessions.map((s) => s.path)).toEqual(["/s/a2", "/s/a1", "/s/a3"]);
  });

  it("counts an errored session as needing a person", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setSessions([summary({ path: "/s/a", cwd: "/w/a", attention: "error" })]);
    expect(model.snapshot().waiting).toBe(1);
  });

  it("names a project from its path when the registry has not caught up", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setSessions([summary({ path: "/s/a", cwd: "/home/me/my-app", attention: "working" })]);
    expect(model.snapshot().projects[0]?.name).toBe("my-app");
  });

  it("reports every session as initial on first sight, so a reconnect is silent", () => {
    const model = new FleetModel();
    model.setConnected(true);
    const changes = model.setSessions([
      summary({ path: "/s/a", cwd: "/w/a", attention: "waiting_for_input" }),
      summary({ path: "/s/b", cwd: "/w/a", attention: "finished_unread" }),
    ]);
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.initial)).toBe(true);
    expect(changes.some(shouldNotify)).toBe(false);
  });

  it("reports a real edge when attention changes", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setSessions([summary({ path: "/s/a", cwd: "/w/a", name: "Refactor", attention: "working" })]);
    const change = model.applyAttention({
      path: "/s/a",
      cwd: "/w/a",
      attention: "waiting_for_input",
      at: "2026-09-05T10:05:00.000Z",
    });
    expect(change).toMatchObject({ from: "working", to: "waiting_for_input", initial: false });
    expect(shouldNotify(change as AttentionChange)).toBe(true);
    // An attention event carries no name; the one from the listing survives.
    expect(change?.session.name).toBe("Refactor");
  });

  it("uses the first prompt as the display name when a session was not explicitly renamed", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setSessions([
      summary({ path: "/s/a", cwd: "/w/a", firstMessage: "Fix the native notification title", attention: "working" }),
    ]);
    const change = model.applyAttention({
      path: "/s/a",
      cwd: "/w/a",
      attention: "finished_unread",
      at: "2026-09-05T10:05:00.000Z",
    });
    expect(change?.session.name).toBe("Fix the native notification title");
    expect(shouldNotify(change as AttentionChange)).toBe(true);
  });

  it("says nothing when attention is re-announced unchanged", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setSessions([summary({ path: "/s/a", cwd: "/w/a", attention: "working" })]);
    const at = "2026-09-05T10:05:00.000Z";
    expect(model.applyAttention({ path: "/s/a", cwd: "/w/a", attention: "working", at })).toBeUndefined();
  });

  it("drops sessions the host no longer lists", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setSessions([
      summary({ path: "/s/a", cwd: "/w/a", attention: "working" }),
      summary({ path: "/s/b", cwd: "/w/a", attention: "working" }),
    ]);
    model.setSessions([summary({ path: "/s/a", cwd: "/w/a", attention: "working" })]);
    expect(model.snapshot().running).toBe(1);
  });

  it("stops claiming anything is running once the host goes away", () => {
    const model = new FleetModel();
    model.setConnected(true);
    model.setProjects([project("/w/a", "alpha")]);
    model.setSessions([summary({ path: "/s/a", cwd: "/w/a", attention: "working" })]);
    expect(model.snapshot().running).toBe(1);

    model.setConnected(false);
    const snapshot = model.snapshot();
    expect(snapshot.connected).toBe(false);
    expect(snapshot.running).toBe(0);
    // The projects survive, so the tray does not empty itself while reconnecting.
    expect(snapshot.projects.map((p) => p.name)).toEqual(["alpha"]);
  });
});

describe("shouldNotify", () => {
  const change = (from: AttentionChange["from"], to: AttentionChange["to"], initial = false): AttentionChange => ({
    session: { path: "/s/a", cwd: "/w/a", name: "s", attention: to, modifiedAt: "2026-09-05T10:00:00.000Z" },
    from,
    to,
    initial,
  });

  it("fires on the edges that mean a person is needed", () => {
    expect(shouldNotify(change("working", "waiting_for_input"))).toBe(true);
    expect(shouldNotify(change("working", "finished_unread"))).toBe(true);
    expect(shouldNotify(change("working", "error"))).toBe(true);
  });

  it("stays quiet for states nobody needs to be interrupted for", () => {
    expect(shouldNotify(change("waiting_for_input", "working"))).toBe(false);
    expect(shouldNotify(change("finished_unread", "idle"))).toBe(false);
  });

  it("stays quiet on the first sighting of a session", () => {
    expect(shouldNotify(change(undefined, "waiting_for_input", true))).toBe(false);
  });

  it("does not repeat news you already have", () => {
    // Already unread, and now also finished again: nothing new to say.
    expect(shouldNotify(change("finished_unread", "error"))).toBe(false);
    expect(shouldNotify(change("waiting_for_input", "waiting_for_input"))).toBe(false);
  });

  it("still interrupts when an already-unread session starts blocking on you", () => {
    expect(shouldNotify(change("finished_unread", "waiting_for_input"))).toBe(true);
  });
});
