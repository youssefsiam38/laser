import { describe, expect, it } from "vitest";
import type { ProjectChanges, TelemetryContext, TelemetryHistory, TelemetrySpend } from "@lasercode/protocol";

import {
  autoCompactText,
  autoCompactThresholdUnknownText,
  noApiCostText,
  pathDisplay,
  compositionMissingText,
  contextHeader,
  contextLiveOnlyText,
  count,
  fileTotals,
  filesHeader,
  hasApiCost,
  historyHeader,
  plural,
  repoLabel,
  scopeBarText,
  spendHeader,
  workDurationText,
  workHeader,
} from "../../src/components/telemetry/format.js";

const GROUP = "\u202f";

describe("telemetry format", () => {
  it("groups counts with a narrow space", () => {
    expect(count(2795)).toBe(`2${GROUP}795`);
    expect(count(6)).toBe("6");
    expect(plural(1, "record", "records")).toBe("1 record");
    expect(plural(2795, "record", "records")).toBe(`2${GROUP}795 records`);
  });

  it("states whole-session coverage on the scope bar only when history arrived", () => {
    expect(scopeBarText(undefined, "loading")).toBe("Reading session…");
    expect(scopeBarText(undefined, "idle")).toBe("Reading session…");
    expect(scopeBarText(undefined, "error")).toBe("Could not read this session's totals.");
    expect(scopeBarText(undefined, "ready")).toBe("Session totals unavailable");
    expect(scopeBarText({ prompts: 10, records: 2795, compactions: 6, branches: 2 })).toBe(
      `Whole session · 2${GROUP}795 records · 6 compactions`,
    );
  });

  it("qualifies a held-count on that figure, never as a blanket line", () => {
    const history: TelemetryHistory = { prompts: 4, records: 100, compactions: 1, branches: 0 };
    expect(historyHeader(history, 10)).toBe("10 of 100");
    expect(historyHeader(history, 100)).toBe("100");
    expect(historyHeader(undefined, 12)).toBe("12 loaded");
    expect(historyHeader(history, 100, 45)).toBe("100");
    expect(historyHeader(history, 50, 45)).toBe("45 of 100");
  });

  it("names a missing context composition on that figure", () => {
    expect(compositionMissingText()).toMatch(/not in this snapshot/i);
    expect(contextLiveOnlyText()).toMatch(/live window only/i);
    expect(contextHeader(undefined)).toBe("Live only");
    const context: TelemetryContext = {
      tokens: 1200,
      contextWindow: 200_000,
      percent: 12,
      autoCompact: { enabled: true, thresholdTokens: 160_000, state: "idle" },
    };
    expect(contextHeader(context)).toBe("12%");
    expect(autoCompactText(context.autoCompact)).toBe("Auto-compact on · 160k");
  });

  it("never prints an unreported auto-compact threshold as zero", () => {
    const unknown = `Auto-compact on · ${autoCompactThresholdUnknownText()}`;
    expect(autoCompactText({ enabled: true, state: "idle" })).toBe(unknown);
    expect(autoCompactText({ enabled: true, thresholdTokens: 0, state: "idle" })).toBe(unknown);
    expect(autoCompactText({ enabled: true, thresholdTokens: 160_000, state: "idle" })).toBe("Auto-compact on · 160k");
    expect(autoCompactText({ enabled: false, state: "off" })).toBe("Auto-compact off");
    expect(autoCompactText({ enabled: true, state: "compacting" })).toBe("Compacting");
  });

  it("treats a settled zero API cost as no API cost", () => {
    const zero: TelemetrySpend = {
      billing: "api",
      api: {
        totals: { input: 40, output: 48, cacheRead: 0, cacheWrite: 0, total: 88, cost: 0, turns: 6 },
        byModel: [{ model: "stub/stub-1", input: 40, output: 48, cost: 0 }],
        series: [0, 0],
      },
    };
    expect(hasApiCost(zero)).toBe(false);
    expect(spendHeader(zero)).toBe("None");
    expect(spendHeader({ ...zero, billing: "mixed" })).toBe("Account");
    expect(noApiCostText(zero)).toBe("No API cost");
    expect(noApiCostText({ ...zero, billing: "mixed" })).toBe("No API cost — account billed");
  });

  it("truncates the middle of a path and never its name", () => {
    expect(pathDisplay("packages/ui/src/components/telemetry/files-section.tsx")).toEqual({
      dir: "pack…lemetry/",
      name: "files-section.tsx",
    });
    expect(pathDisplay("src/a.ts")).toEqual({ dir: "src/", name: "a.ts" });
    expect(pathDisplay("README.md")).toEqual({ dir: "", name: "README.md" });
    // A name that fills the budget on its own keeps its own middle cut.
    const long = pathDisplay("a/b/c/an-extremely-long-file-name-that-fills-the-row.tsx");
    expect(long.dir).toBe("…/");
    expect(long.name).toContain("…");
    expect(long.name.endsWith(".tsx")).toBe(true);
  });

  it("shows one spend header for no API cost", () => {
    expect(spendHeader(undefined)).toBe("None");
    expect(spendHeader({ billing: "none" })).toBe("None");
    expect(hasApiCost({ billing: "none" })).toBe(false);
    expect(hasApiCost({ billing: "account" })).toBe(false);
    const api: TelemetrySpend = {
      billing: "api",
      api: {
        totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 1.25, turns: 3 },
        byModel: [{ model: "anthropic/opus", input: 1, output: 1, cost: 1.25 }],
        series: [1.25],
      },
    };
    expect(spendHeader(api)).toBe("$1.25");
    expect(hasApiCost(api)).toBe(true);
  });

  it("sums git file totals without inventing binary churn", () => {
    const changes: ProjectChanges = {
      scope: "session",
      repos: [
        {
          repo: "/p/app",
          branch: "main",
          files: [
            { path: "a.ts", status: "modified", added: 10, removed: 2 },
            { path: "b.bin", status: "added", added: null, removed: null },
          ],
        },
        {
          repo: "/p/other",
          branch: "agents/x",
          files: [{ path: "c.ts", status: "deleted", added: 0, removed: 4 }],
        },
      ],
    };
    const totals = fileTotals(changes);
    expect(totals).toEqual({ files: 3, added: 10, removed: 6 });
    expect(filesHeader(totals)).toBe("+10 −6");
    expect(filesHeader({ files: 0, added: 0, removed: 0 }, "idle")).toBe("—");
    expect(filesHeader({ files: 0, added: 0, removed: 0 }, "loading")).toBe("—");
    expect(filesHeader({ files: 0, added: 0, removed: 0 }, "error")).toBe("Failed");
    expect(workHeader({ turns: 48, durationMs: 0, tools: { total: 0, ranked: [], other: 0, failed: [] } })).toBe("48 turns");
    expect(workDurationText({ turns: 48, durationMs: 0, tools: { total: 0, ranked: [], other: 0, failed: [] } })).toBe(
      "No timestamps",
    );
    expect(repoLabel("/home/a/app")).toBe("a/app");
    expect(repoLabel("/home/b/app")).toBe("b/app");
  });
});
