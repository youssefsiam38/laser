import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeFailure } from "@lasercode/protocol";
import { RUNTIME_REPAIR_LIMITS, RuntimeRepairLedger } from "../src/runtime-repair.js";

const roots: string[] = [];
const hostLaunchId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const successorHostLaunchId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const failure = (cwd: string, launchId = "0123456789abcdef0123456789abcdef"): RuntimeFailure => ({
  owner: { kind: "worker", launchId, cwd },
  stage: "initialize",
  category: "initialization_error",
  message: "This project's runtime did not start.",
});
const oomFailure = (cwd: string): RuntimeFailure => ({
  owner: { kind: "worker", launchId: "0123456789abcdef0123456789abcdef", cwd },
  stage: "runtime",
  category: "heap_oom",
  message: "This project's agent ran out of memory.",
});

function fixture(now = new Date("2026-09-16T12:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "runtime-repair-"));
  roots.push(root);
  const path = join(root, "runtime-repair.json");
  return { path, ledger: new RuntimeRepairLedger(path, hostLaunchId, () => now) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable runtime repair policy", () => {
  it("allows exactly two automatic retries for one unresolved fingerprint", () => {
    const { path, ledger } = fixture();
    expect(ledger.automaticRetry("/project", "normal", failure("/project"))).toMatchObject({ allowed: true, attempts: 1 });
    expect(ledger.automaticRetry("/project", "normal", failure("/project"))).toMatchObject({ allowed: true, attempts: 2 });
    expect(ledger.automaticRetry("/project", "normal", failure("/project"))).toMatchObject({ allowed: false, attempts: 2 });
    expect(ledger.status("/project", "normal", failure("/project"))).toEqual({ state: "exhausted", automaticAttempts: 2 });
    expect(JSON.stringify(ledger.snapshot())).not.toContain("/project");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.incidents).toHaveLength(1);
    expect(stored.incidents[0]).toMatchObject({ mode: "normal", hostLaunchId });
    expect(stored.incidents[0]).not.toHaveProperty("generation");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("grants an OOM a fresh automatic allowance on a new host launch", () => {
    const { path, ledger } = fixture();
    ledger.automaticRetry("/project", "normal", oomFailure("/project"));
    ledger.automaticRetry("/project", "normal", oomFailure("/project"));
    expect(ledger.status("/project", "normal", oomFailure("/project")).state).toBe("exhausted");

    const successor = new RuntimeRepairLedger(path, successorHostLaunchId);
    expect(successor.status("/project", "normal", oomFailure("/project"))).toEqual({ state: "available", automaticAttempts: 0 });
    expect(successor.automaticRetry("/project", "normal", oomFailure("/project"))).toMatchObject({ allowed: true, attempts: 1 });
  });

  it("always records and permits a person-triggered recovery", () => {
    const { ledger } = fixture();
    ledger.automaticRetry("/project", "normal", failure("/project"));
    ledger.automaticRetry("/project", "normal", failure("/project"));
    ledger.authorize("/project", "normal", failure("/project"));
    expect(ledger.status("/project", "normal", failure("/project"))).toEqual({ state: "available", automaticAttempts: 0 });
    expect(ledger.snapshot().incidents[0]).toMatchObject({ action: "try_again", automaticAttempts: 0 });
  });

  it("persists safe mode without changing identity when the host restarts", () => {
    const { path, ledger } = fixture();
    ledger.authorize("/project", "safe");
    expect(ledger.mode("/project")).toBe("safe");
    expect(new RuntimeRepairLedger(path, successorHostLaunchId).mode("/project")).toBe("safe");
    ledger.authorize("/project", "normal");
    expect(new RuntimeRepairLedger(path, successorHostLaunchId).mode("/project")).toBe("normal");
  });

  it("retains at most 64 recent incidents and prunes rows older than 30 days", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const { path, ledger } = fixture(now);
    for (let index = 0; index < 80; index += 1) {
      const cwd = `/project-${index}`;
      ledger.noteFailure(cwd, "normal", failure(cwd, index.toString(16).padStart(32, "0")));
    }
    expect(ledger.snapshot().incidents).toHaveLength(RUNTIME_REPAIR_LIMITS.incidents);

    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.incidents[0].lastAt = "2026-07-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(stored));
    expect(new RuntimeRepairLedger(path, hostLaunchId, () => now).snapshot().incidents).toHaveLength(RUNTIME_REPAIR_LIMITS.incidents - 1);
  });

  it("preserves malformed data, pauses automation, and replaces it only on explicit action", () => {
    const { path } = fixture();
    writeFileSync(path, "{broken");
    const ledger = new RuntimeRepairLedger(path, hostLaunchId, () => new Date("2026-09-16T12:00:00.000Z"));
    expect(ledger.automaticPaused).toBe(true);
    expect(ledger.automaticRetry("/project", "normal", failure("/project"))).toEqual({ allowed: false, attempts: 0, paused: true });
    expect(existsSync(`${path}.corrupt-20260916120000`)).toBe(true);
    expect(existsSync(path)).toBe(false);

    ledger.authorize("/project", "normal", failure("/project"));
    expect(ledger.automaticPaused).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
