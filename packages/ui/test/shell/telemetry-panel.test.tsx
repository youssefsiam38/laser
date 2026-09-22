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
import {
  autoCompactText,
  autoCompactThresholdUnknownText,
  compositionMissingText,
  contextLiveOnlyText,
  count,
  filesErrorText,
  filesHeader,
  filesIdleText,
  hasApiCost,
  pathDisplay,
  scopeBarText,
  spendHeader,
} from "../../src/components/telemetry/format.js";

const openChanges = vi.hoisted(() => vi.fn());
const sessionMeta = vi.hoisted(() => ({
  contextUsage: {
    tokens: 12_000,
    contextWindow: 200_000,
    percent: 42,
  } as { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
  running: false,
  compacting: false,
  model: { provider: "anthropic", id: "claude-opus-4" } as { provider: string; id: string } | null,
}));

vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ actions: { compact: async () => {} } }),
  useSessionMeta: () => sessionMeta,
}));

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
  sessionMeta.contextUsage = { tokens: 12_000, contextWindow: 200_000, percent: 42 };
  sessionMeta.running = false;
  sessionMeta.compacting = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
});

const render = async (node: ReactNode): Promise<void> => {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
};

const trigger = (id: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-section="${id}"] [data-slot="telemetry-section-trigger"]`)!;

const numberOf = (id: string): string =>
  container.querySelector(`[data-section="${id}"] [data-slot="telemetry-section-number"]`)?.textContent ?? "";

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

  it("collapses and expands from the keyboard", async () => {
    await render(
      <OpenHarness>
        {(open, setOpen) => <WorkSection work={work()} open={open} onOpenChange={setOpen} />}
      </OpenHarness>,
    );
    const button = trigger("work");
    await act(async () => button.focus());
    expect(document.activeElement).toBe(button);
    // A native button: Enter activates it.
    const press = async (key: string) => {
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        const before = trigger("work").getAttribute("aria-expanded");
        button.dispatchEvent(event);
        if (trigger("work").getAttribute("aria-expanded") === before) button.click();
      });
    };
    await press("Enter");
    expect(trigger("work").getAttribute("aria-expanded")).toBe("false");
    expect(numberOf("work")).toBe("48 turns");
    expect(container.querySelector("[data-slot='telemetry-tool-ranks']")).toBeNull();
    await press(" ");
    expect(trigger("work").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("read");
  });

  it("section triggers are focusable native buttons; click activates them", async () => {
    await render(
      <OpenHarness>
        {(open, setOpen) => <WorkSection work={work()} open={open} onOpenChange={setOpen} />}
      </OpenHarness>,
    );
    const button = trigger("work");
    expect(button.tagName).toBe("BUTTON");
    await act(async () => button.focus());
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(numberOf("work")).toBe("48 turns");
  });

  it("shows one line when there is no API cost", async () => {
    await render(<SpendSection spend={{ billing: "none" }} open onOpenChange={() => {}} onOpenUsage={() => {}} />);
    expect(container.querySelector("[data-slot='telemetry-no-api-cost']")?.textContent).toBe("No API cost");
    expect(container.querySelector("[data-slot='cost-meter']")).toBeNull();
    expect(container.querySelector("[data-slot='account-usage']")).toBeNull();
    expect(numberOf("spend")).toBe("None");
  });

  it("shows one line for a session whose API cost settled at zero", async () => {
    const zero: TelemetrySpend = {
      billing: "api",
      api: {
        totals: { input: 40, output: 48, cacheRead: 0, cacheWrite: 0, total: 88, cost: 0, turns: 6 },
        byModel: [{ model: "stub/stub-1", input: 40, output: 48, cost: 0 }],
        series: [0, 0],
      },
    };
    await render(<SpendSection spend={zero} open onOpenChange={() => {}} onOpenUsage={() => {}} />);
    const body = container.querySelector("[data-section='spend'] [data-slot='collapsible-content']")!;
    // One line, not five: no meter, no per-model roll-up, no per-turn zero.
    expect(body.textContent?.trim()).toBe("No API cost");
    expect(body.textContent).not.toContain("$0");
    expect(container.querySelector("[data-slot='cost-meter']")).toBeNull();
    expect(hasApiCost(zero)).toBe(false);
    expect(spendHeader(zero)).toBe("None");
  });

  it("shows incomplete zero and nonzero spend as partial in both collapsed and expanded figures", async () => {
    const incompleteZero: TelemetrySpend = {
      billing: "account",
      coverage: { knownChildren: 2, includedChildren: 1, unavailableChildren: 1 },
    };
    await render(<SpendSection spend={incompleteZero} open onOpenChange={() => {}} onOpenUsage={() => {}} />);
    expect(numberOf("spend")).toBe("Account · partial");
    expect(container.querySelector("[data-slot='telemetry-no-api-cost']")?.textContent).toBe(
      "Partial · API cost is incomplete · 1 child session unavailable.",
    );
    expect(container.textContent).not.toContain("No API cost");
    expect(container.querySelector("[data-slot='account-usage']")).not.toBeNull();

    await render(
      <SpendSection
        spend={{
          billing: "mixed",
          coverage: { knownChildren: 3, includedChildren: 1, unavailableChildren: 2 },
          api: {
            totals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 2, turns: 1 },
            byModel: [{ model: "anthropic/opus", input: 10, output: 5, cost: 2 }],
            series: [2],
          },
        }}
        open
        onOpenChange={() => {}}
        onOpenUsage={() => {}}
      />,
    );
    expect(numberOf("spend")).toBe("$2.00 · partial");
    expect(container.querySelector("[data-slot='telemetry-partial-spend']")?.textContent).toBe(
      "Partial · Known API subtotal · 2 child sessions unavailable.",
    );
    expect(container.querySelector("[data-slot='cost-meter']")).not.toBeNull();
    expect(container.querySelector("[data-slot='account-usage']")).not.toBeNull();
  });

  it("keeps the tail of a long model id in the spend roll-up", async () => {
    const long = "anthropic/claude-opus-4-20250514-preview";
    await render(
      <SpendSection
        spend={{
          billing: "api",
          api: {
            totals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 2, turns: 1 },
            byModel: [{ model: long, input: 10, output: 5, cost: 2 }],
            series: [2],
          },
        }}
        open
        onOpenChange={() => {}}
        onOpenUsage={() => {}}
      />,
    );
    const line = container.querySelector("[data-slot='cost-meter'] [title]")!;
    expect(line.textContent).toContain("…");
    expect(line.textContent?.endsWith("preview")).toBe(true);
    expect(line.getAttribute("title")).toBe(long);
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

  it("says an unreported auto-compact threshold is unknown instead of printing zero", async () => {
    for (const autoCompact of [
      { enabled: true, state: "idle" } as const,
      { enabled: true, thresholdTokens: 0, state: "idle" } as const,
    ]) {
      await render(
        <ContextSection
          context={context({ autoCompact })}
          busy={false}
          compacting={false}
          open
          onOpenChange={() => {}}
          onCompact={() => {}}
        />,
      );
      const line = container.querySelector("[data-slot='telemetry-auto-compact']")!;
      expect(line.textContent).toBe(`Auto-compact on · ${autoCompactThresholdUnknownText()}`);
      expect(line.textContent).not.toMatch(/·\s*0$/);
      expect(autoCompactText(autoCompact)).toBe(line.textContent);
    }
    await render(
      <ContextSection context={context()} busy={false} compacting={false} open onOpenChange={() => {}} onCompact={() => {}} />,
    );
    expect(container.querySelector("[data-slot='telemetry-auto-compact']")?.textContent).toBe("Auto-compact on · 160k");
  });

  it("names a zero composition category in the legend and gives it no tile of its own", async () => {
    await render(
      <ContextSection
        context={context({ composition: { tools: 400, chat: 800, thinking: 0, system: 0 } })}
        busy={false}
        compacting={false}
        open
        onOpenChange={() => {}}
        onCompact={() => {}}
      />,
    );
    const figure = container.querySelector("[data-slot='telemetry-composition']")!;
    // One bar and one legend row: the whole figure.
    expect(figure.children).toHaveLength(2);
    const legend = container.querySelector("[data-slot='telemetry-composition-legend']")!;
    expect(legend.children).toHaveLength(4);
    const zero = legend.querySelector("[data-part='thinking']")!;
    expect(zero.textContent).toBe("Thinking0");
    // The bar carries only what was measured; a zero is not a segment either.
    expect(container.querySelectorAll("[data-slot='telemetry-composition-bar'] [data-part]")).toHaveLength(2);
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
    sessionMeta.contextUsage = undefined;
    await render(
      <ContextSection context={undefined} busy={false} compacting={false} open onOpenChange={() => {}} onCompact={() => {}} />,
    );
    expect(container.querySelector("[data-slot='telemetry-context-live-only']")?.textContent).toBe(contextLiveOnlyText());
    expect(numberOf("context")).toBe("Live only");
  });

  it("opens the window-health inspector from the context ring", async () => {
    await render(
      <ContextSection context={context()} busy={false} compacting={false} open onOpenChange={() => {}} onCompact={() => {}} />,
    );
    const ring = container.querySelector<HTMLButtonElement>("[data-slot='context-display-trigger']")!;
    expect(ring.tagName).toBe("BUTTON");
    await act(async () => ring.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Context window");
    expect(dialog?.textContent).toMatch(/Window health|filled/i);
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

  it("file rows are focusable native buttons; click activates them", async () => {
    await render(
      <FilesSection changes={changes()} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />,
    );
    const row = container.querySelector<HTMLButtonElement>("[data-slot='telemetry-file-row'][data-path='src/index.ts']")!;
    expect(row.tagName).toBe("BUTTON");
    await act(async () => row.focus());
    expect(document.activeElement).toBe(row);
    await act(async () => row.click());
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

  it("collapsed Files figure is unknown while idle or loading, and Failed on error", async () => {
    await render(<FilesSection status="idle" sessionKey="/s.jsonl" open onOpenChange={() => {}} />);
    expect(numberOf("files")).toBe("—");
    expect(container.querySelector("[data-slot='telemetry-files-idle']")?.textContent).toBe(filesIdleText());
    expect(filesHeader({ files: 0, added: 0, removed: 0 }, "idle")).toBe("—");

    await render(<FilesSection status="loading" sessionKey="/s.jsonl" open onOpenChange={() => {}} />);
    expect(numberOf("files")).toBe("—");
    expect(container.textContent).toContain("Reading changes");
    expect(filesHeader({ files: 0, added: 0, removed: 0 }, "loading")).toBe("—");

    await render(
      <FilesSection status="error" message={filesErrorText()} sessionKey="/s.jsonl" open onOpenChange={() => {}} />,
    );
    expect(numberOf("files")).toBe("Failed");
    expect(container.querySelector("[data-slot='telemetry-files-error']")?.textContent).toBe(filesErrorText());
    expect(container.textContent).not.toContain("this worker serves");
    expect(filesHeader({ files: 0, added: 0, removed: 0 }, "error")).toBe("Failed");
  });

  it("keeps the filename when a Files path is truncated", async () => {
    const path = "packages/ui/src/components/telemetry/files-section.tsx";
    await render(
      <FilesSection
        changes={{
          scope: "session",
          repos: [{ repo: "/p/app", branch: "main", files: [{ path, status: "modified", added: 1, removed: 0 }] }],
        }}
        status="ready"
        sessionKey="/s.jsonl"
        open
        onOpenChange={() => {}}
      />,
    );
    const row = container.querySelector("[data-slot='telemetry-file-row']")!;
    expect(row.textContent).toContain("files-section.tsx");
    expect(row.textContent).not.toMatch(/packages\/ui\/src\/comp/);
  });

  it("truncates a Files path in its middle, never its name", async () => {
    const path = "packages/ui/src/components/telemetry/files-section.tsx";
    await render(
      <FilesSection
        changes={{
          scope: "session",
          repos: [{ repo: "/p/app", branch: "agents/telemetry-9aeac6c4", files: [{ path, status: "modified", added: 1, removed: 0 }] }],
        }}
        status="ready"
        sessionKey="/s.jsonl"
        open
        onOpenChange={() => {}}
      />,
    );
    const shown = container.querySelector("[data-slot='telemetry-file-path']")!;
    const { dir, name } = pathDisplay(path);
    expect(name).toBe("files-section.tsx");
    expect(dir.startsWith("pack")).toBe(true);
    expect(dir).toContain("…");
    expect(dir.endsWith("/")).toBe(true);
    expect(shown.textContent).toBe(`${dir}${name}`);
    // The row still carries the whole path for a reader and a screen reader.
    expect(container.querySelector("[data-slot='telemetry-file-row']")?.getAttribute("aria-label")).toContain(path);
    expect(container.querySelector("[data-slot='telemetry-repo-branch']")?.textContent).toContain("9aeac6c4");
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

  it("caps the token sparkline at 64 bars", async () => {
    const tokenSeries = Array.from({ length: 80 }, (_, i) => i + 1);
    await render(
      <ModelSection
        model={{ provider: "anthropic", id: "claude-opus-4", thinkingLevel: "medium", contextWindow: 200_000, tokenSeries }}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(container.textContent).toContain("last 64");
    expect(container.querySelectorAll("[data-slot='chart'] rect")).toHaveLength(64);
  });

  it("puts whole-session coverage on the scope bar", async () => {
    const text = scopeBarText({ prompts: 12, records: 2795, compactions: 6, branches: 1 });
    await render(<ScopeBar text={text} />);
    expect(container.querySelector("[data-slot='telemetry-scope']")?.textContent).toBe(
      `Whole session · ${count(2795)} records · 6 compactions`,
    );
  });
});
