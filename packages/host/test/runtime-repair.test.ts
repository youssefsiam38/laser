import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeFailure } from "@lasercode/protocol";
import { RUNTIME_REPAIR_LIMITS, RuntimeRepairLedger } from "../src/runtime-repair.js";

const roots: string[] = [];
const failure = (cwd: string, launchId = "0123456789abcdef0123456789abcdef"): RuntimeFailure => ({
  owner: { kind: "worker", launchId, cwd },
  stage: "initialize",
  category: "initialization_error",
  message: "This project's runtime did not start.",
});

function fixture(now = new Date("2026-09-16T12:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "runtime-repair-"));
  roots.push(root);
  const path = join(root, "runtime-repair.json");
  return { path, ledger: new RuntimeRepairLedger(path, () => now) };
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
    expect(JSON.stringify(ledger.snapshot())).not.toContain("/project");
    expect(JSON.parse(readFileSync(path, "utf8")).incidents).toHaveLength(1);
  });

  it("persists safe mode without changing identity when the host restarts", () => {
    const { path, ledger } = fixture();
    ledger.authorize("/project", "safe");
    expect(ledger.mode("/project")).toBe("safe");
    expect(new RuntimeRepairLedger(path).mode("/project")).toBe("safe");
    ledger.authorize("/project", "normal");
    expect(new RuntimeRepairLedger(path).mode("/project")).toBe("normal");
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
    expect(new RuntimeRepairLedger(path, () => now).snapshot().incidents).toHaveLength(RUNTIME_REPAIR_LIMITS.incidents - 1);
  });

  it("preserves malformed data, pauses automation, and replaces it only on explicit action", () => {
    const { path } = fixture();
    writeFileSync(path, "{broken");
    const ledger = new RuntimeRepairLedger(path, () => new Date("2026-09-16T12:00:00.000Z"));
    expect(ledger.automaticPaused).toBe(true);
    expect(ledger.automaticRetry("/project", "normal", failure("/project"))).toEqual({ allowed: false, attempts: 0, paused: true });
    expect(existsSync(`${path}.corrupt-20260916120000`)).toBe(true);
    expect(existsSync(path)).toBe(false);

    ledger.authorize("/project", "normal");
    expect(ledger.automaticPaused).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
