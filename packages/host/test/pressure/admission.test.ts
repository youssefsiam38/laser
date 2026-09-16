import { describe, expect, it } from "vitest";
import type { MemoryPressureLevelState } from "@lasercode/protocol";
import { createPressureAdmission, workerReservationWouldOverflow } from "../../src/pressure/admission.js";

function fixture(overrides: Partial<{
  host: MemoryPressureLevelState;
  workers: Record<string, MemoryPressureLevelState>;
  globalWorker: MemoryPressureLevelState;
  /** null means the first probe has not completed. */
  machineKnown: boolean | null;
  total: number;
  reserved: number;
  now: number;
}> = {}) {
  let now = overrides.now ?? 0;
  const rows: Array<{ refusal: string; level: string; reason?: string; cwd?: string }> = [];
  let suppressed = 0;
  const admission = createPressureAdmission({
    hostLevel: () => overrides.host ?? "normal",
    workerLevel: (cwd) => cwd === undefined ? (overrides.globalWorker ?? "normal") : (overrides.workers?.[cwd] ?? "normal"),
    machineAvailabilityKnown: () => overrides.machineKnown === null ? undefined : (overrides.machineKnown ?? true),
    totalMemoryBytes: () => overrides.total ?? 16 * 1024 ** 3,
    reservedWorkerCount: () => overrides.reserved ?? 0,
    now: () => now,
    onRefusal: (row) => rows.push(row),
    onSuppressed: () => { suppressed += 1; },
  });
  return { admission, rows, suppressed: () => suppressed, advance: (ms: number) => { now += ms; } };
}

describe("pressure admission", () => {
  it("applies only the four approved thresholds", () => {
    const warning = fixture({ host: "warning" });
    expect(warning.admission.admits("whole_transcript", "/a")).toBe(false);
    expect(warning.admission.admits("speculative_worker", "/a")).toBe(false);
    expect(warning.admission.admits("worker_free_full_read", "/a")).toBe(true);
    expect(warning.admission.admits("new_project_worker", "/a")).toBe(true);

    const critical = fixture({ host: "critical" });
    expect(critical.admission.admits("worker_free_full_read", "/a")).toBe(false);
    expect(critical.admission.admits("new_project_worker", "/a")).toBe(false);
  });

  it("uses exact project evidence for path-scoped reads and global evidence otherwise", () => {
    const subject = fixture({
      workers: { "/hot": "critical", "/calm": "normal", "/missing": "unknown" },
      globalWorker: "critical",
    });
    expect(subject.admission.admits("whole_transcript", "/hot")).toBe(false);
    expect(subject.admission.admits("whole_transcript", "/calm")).toBe(true);
    expect(subject.admission.admits("whole_transcript", "/missing")).toBe(true);
    expect(subject.admission.admits("speculative_worker", "/calm")).toBe(false);
  });

  it("never turns unknown evidence into a pressure refusal", () => {
    const subject = fixture({ host: "unknown", globalWorker: "unknown", workers: { "/a": "unknown" } });
    expect(subject.admission.admits("whole_transcript", "/a")).toBe(true);
    expect(subject.admission.admits("worker_free_full_read", "/a")).toBe(true);
    expect(subject.admission.refusing()).toEqual([]);
    expect(subject.rows).toEqual([]);
  });

  it("coalesces each refusal kind for five seconds and counts every suppression", () => {
    const subject = fixture({ host: "critical" });
    expect(subject.admission.admits("whole_transcript", "/a")).toBe(false);
    expect(subject.admission.admits("whole_transcript", "/b")).toBe(false);
    subject.advance(4_999);
    expect(subject.admission.admits("whole_transcript", "/a")).toBe(false);
    expect(subject.rows).toHaveLength(1);
    expect(subject.suppressed()).toBe(2);
    subject.advance(1);
    expect(subject.admission.admits("whole_transcript", "/b")).toBe(false);
    expect(subject.rows).toHaveLength(2);
    expect(subject.rows[1]).toEqual({ refusal: "whole_transcript", level: "critical", cwd: "/b" });
  });

  it("reports the active refusal lifecycle without adding journal rows", () => {
    const subject = fixture({ host: "critical" });
    expect(subject.admission.refusing()).toEqual([
      "whole_transcript",
      "speculative_worker",
      "new_project_worker",
      "worker_free_full_read",
    ]);
    expect(subject.rows).toEqual([]);
  });
});

describe("worker reservation fallback", () => {
  it("uses the approved half-capacity/system-reserve budget and strict overflow", () => {
    const gib = 1024 ** 3;
    expect(workerReservationWouldOverflow(8 * gib, 2)).toBe(false); // 3.75 GiB <= 4 GiB
    expect(workerReservationWouldOverflow(8 * gib, 3)).toBe(true); // 5 GiB > 4 GiB
    expect(workerReservationWouldOverflow(4 * gib, 0)).toBe(false);
    expect(workerReservationWouldOverflow(4 * gib, 1)).toBe(true);
  });

  it("is inert for unreadable capacity or counts", () => {
    expect(workerReservationWouldOverflow(0, 100)).toBe(false);
    expect(workerReservationWouldOverflow(Number.NaN, 100)).toBe(false);
    expect(workerReservationWouldOverflow(8 * 1024 ** 3, -1)).toBe(false);
  });

  it("supplements rather than replaces pressure policy when machine availability is unavailable", () => {
    const critical = fixture({ machineKnown: false, host: "critical", total: 32 * 1024 ** 3, reserved: 0 });
    expect(critical.admission.admits("speculative_worker")).toBe(false);
    expect(critical.admission.admits("new_project_worker")).toBe(false);
    expect(critical.rows.map(({ level, reason }) => ({ level, reason }))).toEqual([
      { level: "critical", reason: undefined },
      { level: "critical", reason: undefined },
    ]);

    const allowed = fixture({ machineKnown: false, host: "normal", total: 8 * 1024 ** 3, reserved: 2 });
    expect(allowed.admission.admits("speculative_worker")).toBe(true);
    expect(allowed.admission.admits("new_project_worker")).toBe(true);

    const refused = fixture({ machineKnown: false, host: "normal", total: 8 * 1024 ** 3, reserved: 3 });
    expect(refused.admission.admits("speculative_worker")).toBe(false);
    expect(refused.admission.admits("new_project_worker")).toBe(false);
    expect(refused.admission.refusing()).toEqual(["speculative_worker", "new_project_worker"]);
    expect(refused.rows.map(({ level, reason }) => ({ level, reason }))).toEqual([
      { level: "normal", reason: "work_budget" },
      { level: "normal", reason: "work_budget" },
    ]);
  });

  it("does not treat an unfinished first probe as an unsupported machine", () => {
    const fresh = fixture({ machineKnown: null, host: "unknown", total: 4 * 1024 ** 3, reserved: 10 });
    expect(fresh.admission.admits("speculative_worker")).toBe(true);
    expect(fresh.admission.admits("new_project_worker")).toBe(true);
    expect(fresh.rows).toEqual([]);
  });
});
