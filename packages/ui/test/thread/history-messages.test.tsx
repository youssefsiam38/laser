// @vitest-environment happy-dom
/**
 * A row keeps its identity — and everything local to it — when earlier
 * messages arrive above it.
 *
 * Rewritten for M16-T87: the transcript is mounted over a real scroller
 * (`virtual-rig.tsx`), because the rows it mounts are now chosen from a real
 * scroll position. The guarantee is unchanged: the prepend must not remount
 * the row the person is in, so its focus and its own disclosure state survive.
 */
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountRig, type Rig } from "./virtual-rig.js";

// Isolate row rendering, not the message-id provider/runtime boundary under test.
// Local disclosure state must remain with its message when earlier rows arrive.
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  const { useState } = await import("react");
  return { ThreadMessage: function Message() {
    const id = useAuiState(s => s.message.id);
    const [open, setOpen] = useState(false);
    return <button aria-label={`${id} details`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{id}</button>;
  } };
});

let rig: Rig | undefined;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await rig?.dispose(); rig = undefined; });

it("keeps focus and a manual disclosure on the same message across an asynchronous prepend", async () => {
  rig = await mountRig({ ids: ["tail"], height: () => 120, clientHeight: 900 });
  const tail = rig.container.querySelector<HTMLButtonElement>('[aria-label="tail details"]')!;
  await act(async () => { tail.focus(); tail.click(); });
  expect(tail.getAttribute("aria-expanded")).toBe("true");
  await rig.setIds(["older", "tail"]);
  expect(rig.container.querySelector('[aria-label="tail details"]')).toBe(tail);
  expect(document.activeElement).toBe(tail);
  expect(tail.getAttribute("aria-expanded")).toBe("true");
  expect(rig.container.querySelector('[aria-label="older details"]')?.getAttribute("aria-expanded")).toBe("false");
});
