// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ level: "high", setThinking: vi.fn() }));
const session = { cwd: "/project" };
const model = { provider: "test", id: "reasoner" };
const client = { request: async () => ({ models: [{ ...model, thinkingLevels: ["off", "low", "medium", "high", "xhigh"] }] }) };
const actions = { setThinking: mocks.setThinking };
vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ client, actions }),
  useSessionMeta: () => ({ session, model, thinkingLevel: mocks.level }),
}));
import { ThinkingEffort } from "../../src/components/assistant-ui/elements/reasoning-effort.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.level = "high"; mocks.setThinking.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("shows the current compact level without opening the picker, and updates with session state", async () => {
  const render = () => root.render(<TooltipProvider><ThinkingEffort /></TooltipProvider>);
  await act(async () => render());
  expect(container.querySelector('button')?.textContent).toBe("high");
  expect(document.querySelector('[role="radiogroup"]')).toBeNull();
  mocks.level = "medium"; await act(async () => render());
  expect(container.querySelector('button')?.textContent).toBe("med");
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe("Thinking: medium");
  await act(async () => container.querySelector('button')!.click());
  const high = document.querySelector<HTMLButtonElement>('[role="radio"][aria-label="high"]')!;
  await act(async () => high.click()); expect(mocks.setThinking).toHaveBeenCalledWith("high");
});
