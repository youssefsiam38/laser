// @vitest-environment happy-dom
/**
 * The connection line's phases and its one action (M18-T3/T13 acceptance).
 *
 * The line is a quiet status row until the host is actually gone, and then it
 * offers the way back. Its size on a touch screen is CSS under a `pointer:
 * coarse` media query, so that is measured in the browser —
 * `scripts/browser-check/test/environment-storage.mjs` drops a real socket at
 * 390px and asserts the retry is a 44px target sitting inside the line. What
 * is asserted here is which phase says what, and that the action is the
 * caller's.
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

const strip = () => container.querySelector<HTMLElement>('[data-slot="connection-state"]');

it("offers the way back only when the host is really gone, and it is the caller's", async () => {
  const retry = vi.fn();
  await act(async () => root.render(<ConnectionState phase="dropped" onRetry={retry} />));

  const line = strip()!;
  expect(line.getAttribute("data-phase")).toBe("dropped");
  expect(line.getAttribute("role")).toBe("status");
  expect(line.textContent).toContain("Disconnected from the host");
  const button = line.querySelector("button")!;
  expect(button.textContent).toBe("Reconnect now");
  await act(async () => button.click());
  expect(retry).toHaveBeenCalledOnce();
});

it("stays a quiet line in the phases with nothing to do", async () => {
  await act(async () => root.render(<ConnectionState phase="reconnecting" attempt={2} onRetry={() => {}} />));
  expect(strip()!.getAttribute("data-phase")).toBe("reconnecting");
  expect(strip()!.textContent).toContain("attempt 2");
  expect(strip()!.querySelector("button")).toBeNull();

  await act(async () => root.render(<ConnectionState phase="resumed" onRetry={() => {}} />));
  expect(strip()!.textContent).toContain("Back online");
  expect(strip()!.querySelector("button")).toBeNull();

  // Connected is not a state with a line in it at all.
  await act(async () => root.render(<ConnectionState phase="online" onRetry={() => {}} />));
  expect(strip()).toBeNull();
});
