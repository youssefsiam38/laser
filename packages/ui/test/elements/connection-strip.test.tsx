// @vitest-environment happy-dom
/**
 * The connection line's one action, on a touch screen (M18-T3/T13 acceptance).
 *
 * The line is 32px by design, and "Reconnect now" was a 24px target inside it.
 * A coarse pointer gets a 44px control and the line grows to hold it — only in
 * the phase that has the control, so the other phases stay the quiet line they
 * are. happy-dom does not evaluate `pointer: coarse`, so the measurement lives
 * in `scripts/browser-check/test/environment-storage.mjs`; the contract is here.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/runtime/index.js", () => ({ useLaserStable: vi.fn(), useLaserState: vi.fn() }));

import { ConnectionState } from "../../src/components/assistant-ui/elements/connection-state.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const strip = () => container.querySelector<HTMLElement>('[data-slot="connection-state"]')!;

it("gives the retry a coarse-pointer target and the room to sit in", async () => {
  const retry = vi.fn();
  await act(async () => root.render(<ConnectionState phase="dropped" onRetry={retry} />));

  const line = strip();
  expect(line.className).toContain("min-h-8");
  expect(line.className).not.toMatch(/(^|\s)h-8(\s|$)/);
  expect(line.className).toContain("pointer-coarse:min-h-14");
  const button = line.querySelector("button")!;
  expect(button.textContent).toBe("Reconnect now");
  expect(button.className).toContain("pointer-coarse:min-h-11");
  await act(async () => button.click());
  expect(retry).toHaveBeenCalledOnce();
});

it("leaves the phases without an action as the quiet line they are", async () => {
  await act(async () => root.render(<ConnectionState phase="reconnecting" attempt={2} onRetry={() => {}} />));
  expect(strip().className).not.toContain("pointer-coarse:min-h-14");
  expect(strip().querySelector("button")).toBeNull();

  await act(async () => root.render(<ConnectionState phase="resumed" />));
  expect(strip().className).not.toContain("pointer-coarse:min-h-14");
});
