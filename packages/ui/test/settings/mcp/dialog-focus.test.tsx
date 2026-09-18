// @vitest-environment happy-dom
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../../../src/components/ui/dialog.js";
import {
  createMcpDialogFocusTarget,
  restoreMcpDialogFocusFallback,
  useMcpDialogFocusReturn,
  type McpDialogFocusTarget,
} from "../../../src/components/settings/mcp/dialog-focus.js";
import { clickElement, render } from "./harness.js";

let root: Root;
let closeDialog: (() => void) | undefined;
let focusTarget: McpDialogFocusTarget | undefined;

function Fixture() {
  const [open, setOpen] = useState(false);
  const restoreFocus = useMcpDialogFocusReturn(open, focusTarget);
  closeDialog = () => setOpen(false);
  return <>
    <button type="button" onClick={(event) => {
      focusTarget = createMcpDialogFocusTarget(event.currentTarget, () => true);
      setOpen(true);
    }}>Open form</button>
    <button type="button">Successor action</button>
    <button type="button">Fallback action</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent onCloseAutoFocus={restoreFocus}>
        <DialogTitle>Owned form</DialogTitle>
      </DialogContent>
    </Dialog>
  </>;
}

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  closeDialog = undefined;
  focusTarget = undefined;
});

it("does not restore focus to an opener whose target departed", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ root } = await render(<Fixture />));
  const origin = document.querySelector<HTMLButtonElement>("button")!;
  await clickElement(origin);
  focusTarget!.invalidate();

  await act(async () => closeDialog!());
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });

  expect(document.activeElement).not.toBe(origin);
});

it("does not restore a disconnected opener after its target departs", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ root } = await render(<Fixture />));
  const fallback = [...document.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
  const disconnected = document.createElement("button");
  const target = createMcpDialogFocusTarget(disconnected, () => true);
  target.invalidate();

  expect(restoreMcpDialogFocusFallback(target, fallback)).toBe(false);
  expect(document.activeElement).toBe(document.body);
});

it("does not let a disconnected opener fallback steal focus from a successor", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ root } = await render(<Fixture />));
  const [, successor, fallback] = [...document.querySelectorAll<HTMLButtonElement>("button")];
  const disconnected = document.createElement("button");
  const target = createMcpDialogFocusTarget(disconnected, () => true);
  successor!.focus();

  expect(restoreMcpDialogFocusFallback(target, fallback!)).toBe(false);
  expect(document.activeElement).toBe(successor);
});
