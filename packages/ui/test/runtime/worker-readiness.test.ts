import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo, SessionSummary } from "@lasercode/protocol";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { canPrepareProject, createWorkerReadiness, expandedProject } from "../../src/runtime/worker-readiness.js";

afterEach(() => { vi.useRealTimers(); sessionsList.reset(); });

describe("worker readiness intent", () => {
  it("recognizes explicit expansion/filter, not catalog mount, collapse or pins", () => {
    sessionsList.reset();
    let before = sessionsList.get();
    expect(expandedProject(before, before)).toBeUndefined();
    sessionsList.toggleCollapsed("/p");
    expect(expandedProject(before, sessionsList.get())).toBeUndefined();
    before = sessionsList.get(); sessionsList.toggleCollapsed("/p");
    expect(expandedProject(before, sessionsList.get())).toBe("/p");
    before = sessionsList.get(); sessionsList.togglePinned("/s");
    expect(expandedProject(before, sessionsList.get())).toBeUndefined();
    before = sessionsList.get(); sessionsList.filter("/q");
    expect(expandedProject(before, sessionsList.get())).toBe("/q");
  });

  it("requires a present unarchived project but leaves trust admission to the host", () => {
    const project = { cwd: "/p", trust: "trusted" } as ProjectInfo;
    const sessions = [{ cwd: "/p", path: "/s" }] as SessionSummary[];
    expect(canPrepareProject("/p", [project], sessions, () => false)).toBe(true);
    expect(canPrepareProject("/p", [{ ...project, trust: "not_required" }], sessions, () => false)).toBe(true);
    for (const trust of ["unknown", "declined"] as const) expect(canPrepareProject("/p", [{ ...project, trust }], sessions, () => false)).toBe(true);
    expect(canPrepareProject("/p", [], sessions, () => false)).toBe(false);
    expect(canPrepareProject("/p", [project], [], () => false)).toBe(false);
    expect(canPrepareProject("/p", [project], sessions, () => true)).toBe(false);
  });

  it("coalesces a sweep of intents, rechecks eligibility, cancels on disposal, and swallows failures", async () => {
    vi.useFakeTimers();
    const prepare = vi.fn(async () => { throw new Error("offline"); });
    let eligible = true;
    const readiness = createWorkerReadiness(prepare, () => eligible);
    readiness.want("/p"); readiness.want("/q");
    await vi.advanceTimersByTimeAsync(149); expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(prepare).toHaveBeenCalledExactlyOnceWith("/q");
    readiness.want("/p"); eligible = false;
    await vi.advanceTimersByTimeAsync(150); expect(prepare).toHaveBeenCalledTimes(1);
    eligible = true; readiness.want("/p"); readiness.dispose();
    await vi.runAllTimersAsync(); expect(prepare).toHaveBeenCalledTimes(1);
  });
});
