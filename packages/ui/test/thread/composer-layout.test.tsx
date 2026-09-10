// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  ComposerActions,
  ComposerToolbar,
} from "../../src/components/assistant-ui/elements/composer.js";

let container: HTMLDivElement;
let root: Root;

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

it("wraps a full-width recording row while the action group owns the right edge", async () => {
  await act(async () => root.render(
    <ComposerToolbar>
      <button data-control="attach" />
      <span data-control="recording" className="order-first basis-full" />
      <ComposerActions>
        <button data-control="agent" />
        <button data-control="model" />
        <button data-control="thinking" />
        <button data-control="context" />
        <button data-control="send" />
      </ComposerActions>
    </ComposerToolbar>,
  ));

  const toolbar = container.querySelector<HTMLElement>('[data-slot="composer-toolbar"]')!;
  const actions = container.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
  expect(toolbar.classList).toContain("flex-wrap");
  expect(actions.classList).toContain("min-w-0");
  expect(actions.classList).toContain("flex-1");
  expect(actions.classList).toContain("justify-end");
  expect([...actions.querySelectorAll("[data-control]")].map((control) => control.getAttribute("data-control")))
    .toEqual(["agent", "model", "thinking", "context", "send"]);
});
