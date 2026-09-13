// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../src/AppErrorBoundary.js";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function Bomb({ armed }: { armed: boolean }): null {
  if (armed) throw new Error("render exploded");
  return null;
}

it("keeps a person in the app when a render throws, and offers a reload instead of a blank window", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reload = vi.fn();
  Object.defineProperty(window, "location", { value: { ...window.location, reload }, configurable: true });
  await act(async () => root.render(<AppErrorBoundary><p>fine</p><Bomb armed={false} /></AppErrorBoundary>));
  expect(container.textContent).toContain("fine");
  await act(async () => root.render(<AppErrorBoundary><p>fine</p><Bomb armed /></AppErrorBoundary>));
  // Not blank: the recovery copy says what happened and what to do next.
  expect(container.textContent).not.toBe("");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Something went wrong drawing this window.");
  expect(container.textContent).toContain("Your conversations and anything running are unaffected.");
  const button = [...container.querySelectorAll("button")].find(el => el.textContent?.trim() === "Reload");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(reload).toHaveBeenCalledTimes(1);
});
