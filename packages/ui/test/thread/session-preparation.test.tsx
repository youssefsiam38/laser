// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { SessionPreparationProvider, useSessionPreparation } from "../../src/components/thread/session-preparation.js";

let release: (() => void) | undefined;
function Probe() {
  const { pending, begin } = useSessionPreparation();
  const [, render] = useState(0);
  return <>
    <span data-state>{pending ? "locked" : "ready"}</span>
    <button onClick={() => { release = begin(); }}>Begin</button>
    <button onClick={() => { release?.(); render((value) => value + 1); }}>Finish</button>
  </>;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  release = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SessionPreparationProvider><Probe /></SessionPreparationProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps its composer locked until the matching preparation finishes", async () => {
  const buttons = container.querySelectorAll("button");
  expect(container.querySelector("[data-state]")?.textContent).toBe("ready");
  await act(async () => buttons[0]!.click());
  expect(container.querySelector("[data-state]")?.textContent).toBe("locked");
  await act(async () => buttons[1]!.click());
  expect(container.querySelector("[data-state]")?.textContent).toBe("ready");
  await act(async () => buttons[1]!.click());
  expect(container.querySelector("[data-state]")?.textContent).toBe("ready");
});
