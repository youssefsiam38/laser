// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectChanges, TelemetryContext, TelemetrySpend, TelemetryWork } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ContextSection } from "../../src/components/telemetry/context-section.js";
import { FilesSection } from "../../src/components/telemetry/files-section.js";
import { ModelSection } from "../../src/components/telemetry/model-section.js";
import { ScopeBar } from "../../src/components/telemetry/section.js";
import { SpendSection } from "../../src/components/telemetry/spend-section.js";
import { WorkSection } from "../../src/components/telemetry/work-section.js";
import { compositionMissingText, contextLiveOnlyText, count, scopeBarText } from "../../src/components/telemetry/format.js";

const openChanges = vi.hoisted(() => vi.fn());

vi.mock("@/source-control/store.js", () => ({
  openChanges: (...args: unknown[]) => openChanges(...args),
}));

vi.mock("../../src/components/shell/AccountUsage.js", () => ({
  AccountUsage: ({ state }: { state?: { status?: string } }) => (
    <div data-slot="account-usage">{state ? "allowance" : "no allowance"}</div>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  openChanges.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (node: ReactNode): Promise<void> => {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
};

const trigger = (id: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-section="${id}"] [data-slot="telemetry-section-trigger"]`)!;

const numberOf = (id: string): string =>
  container.querySelector(`[data-section="${id}"] [data-slot="telemetry-section-number"]`)?.textContent ?? "";

const pressEnter = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
};

function OpenHarness({
  children,
}: {
  children: (open: boolean, setOpen: (open: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return children(open, setOpen);
}

const context = (over: Partial<TelemetryContext> = {}): TelemetryContext => ({
  tokens: 12_000,
  contextWindow: 200_000,
  percent: 42,
  autoCompact: { enabled: true, thresholdTokens: 160_000, state: "idle" },
  ...over,
});

const spendApi = (): TelemetrySpend => ({
  billing: "mixed",
  api: {
    totals: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 1.5, turns: 2 },
    byModel: [
      { model: "anthropic/opus", input: 80, output: 40, cost: 1.2 },
      { model: "anthropic/sonnet", input: 20, output: 10, cost: 0.3 },
    ],
    series: [0.8, 1.5],
  },
  account: { provider: "openai-codex", status: "ready" },
});

const work = (): TelemetryWork => ({
  turns: 48,
  durationMs: 125_000,
  tools: {
    total: 20,
    ranked: [
      { name: "read", count: 10 },
      { name: "edit", count: 6 },
    ],
    other: 4,
    failed: [{ name: "bash", count: 2 }],
  },
});

const changes = (): ProjectChanges => ({
  scope: "session",
  repos: [
    {
      repo: "/p/app",
      branch: "main",
      files: [
        { path: "packages/ui/src/a.ts", status: "modified", added: 12, removed: 3 },
        { path: "packages/ui/src/b.ts", status: "added", added: 4, removed: 0 },
      ],
    },
    {
      repo: "/p/connecting",
      branch: "agents/long-branch-name-6a5fb144",
      files: [{ path: "src/index.ts", status: "deleted", added: 0, removed: 8 }],
    },
  ],
});

describe("telemetry sections", () => {
  it("collapses and expands by pointer and keeps the header number", async () => {
    await render(
      <OpenHarness>
        {(open, setOpen) => <WorkSection work={work()} open={open} onOpenChange={setOpen} />}
      </OpenHarness>,
    );
    expect(trigger("work").getAttribute("aria-expanded")).toBe("true");
    expect(numberOf("work")).toBe("48 turns");
    expect(container.textContent).toContain("read");
    await act(async () => trigger("work").click());
    expect(trigger("work").getAttribute("aria-expanded")).toBe("false");
    expect(numberOf("work")).toBe("48 turns");
    expect(container.querySelector("[data-slot='telemetry-tool-ranks']")).toBeNull();
    await act(async () => trigger("work").click());
    expect(trigger("work").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("read");
  });

  it("collapses and expands by keyboard", async () => {
    await render(
      <OpenHarness>
        {(open, setOpen) => <WorkSection work={work()} open={open} onOpenChange={setOpen} />}
      </OpenHarness>,
    );
    await pressEnter(trigger("work"));
    expect(trigger("work").getAttribute("aria-expanded")).toBe("false");
    expect(numberOf("work")).toBe("48 turns");
    await pressEnter(trigger("work"));
    expect(trigger("work").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows one line when there is no API cost", async () => {
    await render(<SpendSection spend={{ billing: "none" }} open onOpenChange={() => {}} onOpenUsage={() => {}} />);
    expect(container.querySelector("[data-slot='telemetry-no-api-cost']")?.textContent).toBe("No API cost");
    expect(container.querySelector("[data-slot='cost-meter']")).toBeNull();
    expect(container.querySelector("[data-slot='account-usage']")).toBeNull();
    expect(numberOf("spend")).toBe("None");
  });

  it("shows per-model spend and account allowance together", async () => {
    await render(<SpendSection spend={spendApi()} open onOpenChange={() => {}} onOpenUsage={() => {}} />);
    expect(container.querySelector("[data-slot='cost-meter']")).not.toBeNull();
    expect(container.textContent).toContain("anthropic/opus");
    expect(container.textContent).toContain("anthropic/sonnet");
    expect(container.querySelector("[data-slot='account-usage']")?.textContent).toBe("allowance");
    expect(container.querySelector("[data-slot='telemetry-no-api-cost']")).toBeNull();
  });

  it("names a missing composition on that figure and not as a blanket apology", async () => {
    await render(
      <ContextSection context={context()} busy={false} compacting={false} open onOpenChange={() => {}} onCompact={() => {}} />,
    );
    expect(container.querySelector("[data-slot='telemetry-composition-missing']")?.textContent).toBe(compositionMissingText());
    expect(container.textContent).not.toMatch(/loaded so far/i);
    expect(numberOf("context")).toBe("42%");
  });

  it("renders composition when the authority supplies it", async () => {
    await render(
      <ContextSection
        context={context({ composition: { tools: 400, chat: 800, thinking: 200, system: 100 } })}
        busy={false}
        compacting={false}
        open
        onOpenChange={() => {}}
        onCompact={() => {}}
      />,
    );
    expect(container.querySelector("[data-slot='telemetry-composition-missing']")).toBeNull();
    expect(container.textContent).toContain("Tools");
    expect(container.textContent).toContain("Chat");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("System");
  });

  it("says live-only on the context figure when the snapshot has none", async () => {
    await render(
      <ContextSection context={undefined} busy={false} compacting={false} open onOpenChange={() => {}} onCompact={() => {}} />,
    );
    expect(container.querySelector("[data-slot='telemetry-context-live-only']")?.textContent).toBe(contextLiveOnlyText());
    expect(numberOf("context")).toBe("Live only");
  });

  it("ranks tools with bars and names failed calls", async () => {
    await render(<WorkSection work={work()} open onOpenChange={() => {}} />);
    expect(container.textContent).toContain("read");
    expect(container.textContent).toContain("edit");
    expect(container.textContent).toContain("other");
    expect(container.querySelector("[data-slot='telemetry-failed-tools']")?.textContent).toContain("bash");
  });

  it("groups files by repository and opens the overlay from a row", async () => {
    await render(
      <FilesSection changes={changes()} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />,
    );
    expect(container.querySelectorAll("[data-slot='telemetry-repo']")).toHaveLength(2);
    expect(container.textContent).toContain("app");
    expect(container.textContent).toContain("connecting");
    const row = container.querySelector<HTMLButtonElement>("[data-slot='telemetry-file-row'][data-path='packages/ui/src/a.ts']")!;
    await act(async () => row.click());
    expect(openChanges).toHaveBeenCalledWith({
      scope: { kind: "session" },
      repo: "/p/app",
      path: "packages/ui/src/a.ts",
      sessionKey: "/s.jsonl",
    });
  });

  it("opens a files row from the keyboard", async () => {
    await render(
      <FilesSection changes={changes()} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />,
    );
    const row = container.querySelector<HTMLButtonElement>("[data-slot='telemetry-file-row'][data-path='src/index.ts']")!;
    await pressEnter(row);
    expect(openChanges).toHaveBeenCalledWith({
      scope: { kind: "session" },
      repo: "/p/connecting",
      path: "src/index.ts",
      sessionKey: "/s.jsonl",
    });
  });

  it("names a pruned files scope on that figure", async () => {
    await render(
      <FilesSection
        changes={{ scope: "session", repos: [], pruned: { detail: "The starting checkpoint was pruned." } }}
        status="ready"
        sessionKey="/s.jsonl"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(container.querySelector("[data-slot='telemetry-files-pruned']")?.textContent).toContain("pruned");
  });

  it("draws a per-turn token sparkline on the model section", async () => {
    await render(
      <ModelSection
        model={{ provider: "anthropic", id: "claude-opus-4", thinkingLevel: "medium", contextWindow: 200_000, tokenSeries: [100, 400, 250] }}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(numberOf("model")).toBe("claude-opus-4");
    expect(container.textContent).toContain("anthropic");
    expect(container.textContent).toContain("medium");
    expect(container.querySelector("[data-slot='chart']")).not.toBeNull();
  });

  it("puts whole-session coverage on the scope bar", async () => {
    const text = scopeBarText({ prompts: 12, records: 2795, compactions: 6, branches: 1 });
    await render(<ScopeBar text={text} />);
    expect(container.querySelector("[data-slot='telemetry-scope']")?.textContent).toBe(
      `Whole session · ${count(2795)} records · 6 compactions`,
    );
  });
});
