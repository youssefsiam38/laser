// @vitest-environment happy-dom
/**
 * The notice a person gets when this view cannot establish an environment
 * (RP-13 B).
 *
 * It replaced a one-line subtitle that was hidden below `sm` and truncated
 * above it — which meant the one state where the app keeps nothing and does
 * nothing was, on a phone, indistinguishable from an ordinary reconnect. This
 * one wraps, stays, and offers the only recovery that helps.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { EnvironmentNotice } from "../../src/components/assistant-ui/elements/connection-state.js";

const REASON = "This browser's stored data could not be cleared of other environments, so nothing is being kept on this device.";

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

const notice = () => container.querySelector<HTMLElement>('[data-slot="environment-notice"]');

it("says what happened and what to do, in words a person can read on a phone", async () => {
  let cleared = 0;
  await act(async () => root.render(<EnvironmentNotice reason={REASON} onClear={() => { cleared += 1; }} />));

  const element = notice()!;
  expect(element).toBeDefined();
  // Announced once, politely: it is a state, not an alarm, and it does not
  // re-announce itself while the socket retries behind it.
  expect(element.getAttribute("role")).toBe("status");
  expect(element.getAttribute("aria-live")).toBe("polite");

  // The whole reason is present, not an ellipsis of it, and nothing in the
  // notice clips or hides at a narrow width.
  expect(element.textContent).toContain(REASON);
  expect(element.className).toContain("flex-wrap");
  expect(element.className).not.toContain("truncate");
  for (const child of element.querySelectorAll("*")) {
    expect(child.className.toString()).not.toContain("truncate");
    expect(child.className.toString()).not.toMatch(/(^|\s)hidden(\s|$)/);
  }

  // One action, and it is the one that can actually help.
  const button = element.querySelector("button")!;
  expect(button.textContent).toMatch(/clear this browser/i);
  // A phone is the device most likely to be in this state; that this button is
  // a 44px target there is measured where CSS is real, in
  // `scripts/browser-check/test/environment-storage.mjs`.
  await act(async () => button.click());
  expect(cleared).toBe(1);
});

it("keeps saying the same thing rather than flickering with the socket", async () => {
  await act(async () => root.render(<EnvironmentNotice reason={REASON} onClear={() => {}} />));
  const first = notice()!;
  // A re-render with the same reason is the same element, so a screen reader
  // is told once however many reconnect attempts happen behind it.
  await act(async () => root.render(<EnvironmentNotice reason={REASON} onClear={() => {}} />));
  expect(notice()).toBe(first);
  expect(notice()!.textContent).toContain(REASON);
});
