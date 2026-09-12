// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ConversationLoadingGate } from "../../src/components/assistant-ui/elements/loading-state.js";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const render = async (active: boolean) => act(async () => root.render(<ConversationLoadingGate active={active}><p>Loaded history</p></ConversationLoadingGate>));
const advance = async (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

it("never flashes placeholders for a fast load or reveals the empty child while waiting", async () => {
  await render(true);
  await advance(149);
  expect(container.textContent).toBe("");
  await render(false);
  await advance(500);
  expect(container.textContent).toBe("Loaded history");
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it.each(["0ms", "75ms"])("keeps the 150/300ms readability floor with fast motion set to %s", async (duration) => {
  document.documentElement.style.setProperty("--motion-fast", duration);
  await render(true);
  await advance(150);
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading the conversation");
  expect(container.querySelector(".motion-reduce\\:animate-none")).not.toBeNull();
  await advance(10);
  await render(false);
  await advance(289);
  expect(container.textContent).not.toContain("Loaded history");
  await advance(1);
  expect(container.textContent).toBe("Loaded history");
  document.documentElement.style.removeProperty("--motion-fast");
});
it("a second load during the minimum hold does not let the first timer reveal stale content", async () => {
  await render(true); await advance(150); await render(false); await advance(50);
  await render(true); await advance(400);
  expect(container.textContent).not.toContain("Loaded history");
  await render(false); await advance(0);
  expect(container.textContent).toBe("Loaded history");
});
