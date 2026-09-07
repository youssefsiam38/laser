// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountAllowances } from "../../src/components/shell/AccountAllowances.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { ResetDisplay } from "../../src/components/shell/account-allowance.js";

let root: Root, container: HTMLDivElement;
const windows = [
  { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", kind: "primary" as const, usedPercent: 20, windowDurationMins: 300, resetsAt: Date.UTC(2026, 8, 7, 13) / 1000 },
  { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", kind: "secondary" as const, usedPercent: 40, windowDurationMins: 10080 },
];
function Harness() {
  const [display, setDisplay] = useState<ResetDisplay>("remaining");
  return <TooltipProvider><AccountAllowances windows={windows} display={display} onDisplayChange={setDisplay} /></TooltipProvider>;
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 7, 12));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("keeps related windows in one card, switches reset format and updates the countdown", async () => {
  await act(async () => root.render(<Harness />));
  expect(container.querySelectorAll('[data-slot="allowance-group"]')).toHaveLength(1);
  expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  expect(container.textContent).toContain("2 windows · one allowance");
  expect(container.textContent).toContain("Resets in 1h");
  await act(async () => vi.advanceTimersByTime(60000));
  expect(container.textContent).toContain("Resets in 59m");
  await act(async () => container.querySelector<HTMLButtonElement>('[role="radio"][value="time"]')!.click());
  expect(container.textContent).toContain("2026");
  expect(container.textContent).not.toContain("Resets in");
  expect(container.textContent).toContain("Reset unavailable");
});

it("opens sourced help and describes the relationship without dropping either window", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="About GPT-5.3-Codex-Spark"]')!.click());
  expect(document.body.textContent).toContain("not standard GPT-5.3-Codex");
  expect(document.body.textContent).toContain("percentages are not added");
  expect(document.querySelector('a[href="https://learn.chatgpt.com/docs/agent-configuration/speed"]')).not.toBeNull();
  expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
});

it("keeps reserve and unknown buckets out of the compact rail but renders both in the full view", async () => {
  const all = [...windows,
    { limitId: "base_model_inference", limitName: "gpt-reserve", kind: "primary" as const, usedPercent: 15 },
    { limitId: "future", limitName: "Future allowance", kind: "primary" as const, usedPercent: 0 },
  ];
  await act(async () => root.render(<TooltipProvider><AccountAllowances compact windows={all} display="remaining" onDisplayChange={() => {}} /></TooltipProvider>));
  expect(container.querySelectorAll('[data-slot="allowance-group"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("gpt-reserve");
  expect(container.textContent).not.toContain("Future allowance");
  await act(async () => root.render(<TooltipProvider><AccountAllowances windows={all} display="remaining" onDisplayChange={() => {}} /></TooltipProvider>));
  expect(container.querySelectorAll('[data-slot="allowance-group"]')).toHaveLength(3);
  expect(container.textContent).toContain("gpt-reserve");
  expect(container.textContent).toContain("Future allowance");
});
