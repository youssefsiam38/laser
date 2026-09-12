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
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
  document.documentElement.style.removeProperty("--motion-fast");
});
const render = async (active: boolean, hasContent = false) => act(async () => root.render(
  <ConversationLoadingGate active={active} hasContent={hasContent}><p>{hasContent ? "Arrived history" : "Empty destination"}</p></ConversationLoadingGate>,
));
const advance = async (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

it("never flashes placeholders for a fast load or reveals the empty child while waiting", async () => {
  await render(true); await advance(149);
  expect(container.textContent).toBe("");
  await render(false, true);
  expect(container.textContent).toBe("Arrived history");
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it.each(["0ms", "75ms"])("keeps the 150/300ms floor only while nothing has arrived (%s motion)", async duration => {
  document.documentElement.style.setProperty("--motion-fast", duration);
  await render(true); await advance(150);
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading the conversation");
  await advance(10); await render(false); await advance(289);
  expect(container.textContent).not.toContain("Empty destination");
  await advance(1);
  expect(container.textContent).toBe("Empty destination");
});
it.each([true, false])("arriving content immediately replaces the skeleton even if the transaction is still active: %s", async active => {
  await render(true); await advance(150);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await render(active, true);
  expect(container.textContent).toBe("Arrived history");
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it("a second load during the hold cannot reveal the previous empty destination", async () => {
  await render(true); await advance(150); await render(false); await advance(50);
  await render(true); await advance(400);
  expect(container.textContent).not.toContain("Empty destination");
  await render(false); await advance(0);
  expect(container.textContent).toBe("Empty destination");
});
