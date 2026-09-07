// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GoalRecord } from "../../src/components/thread/GoalRecord.js";

const preferences = vi.hoisted(() => ({ level: "answers" }));
vi.mock("@/runtime", () => ({ useActivityDetailLevel: () => preferences.level, useLaserState: () => "/test/session" }));
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p>{text}</p> }));
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root.render(null)); preferences.level = "answers"; });
const goal = { id: "goal", ids: ["goal"], objective: "Compare the stacks", status: "complete", startedAt: 1, continuations: 0, summary: "Development differs from CI.", moments: [{ at: 1, status: "active", objective: "Compare the stacks" }, { at: 2, status: "complete", objective: "Compare the stacks" }] };

it("starts collapsed, expands the actual summary and preserves manual choice", async () => {
  await act(async () => root.render(<GoalRecord goal={goal} />));
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.textContent).toContain("Goal completed");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain(goal.summary);
  expect(container.textContent).toContain("Goal set");
  expect(container.textContent).not.toMatch(/tokens|budget|elapsed/i);
  await act(async () => root.render(<GoalRecord goal={{ ...goal, summary: "Complete summary after a live update." }} />));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("follows the full-detail preference but still permits manual collapse", async () => {
  preferences.level = "everything";
  await act(async () => root.render(<GoalRecord goal={goal} />));
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
