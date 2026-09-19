// @vitest-environment happy-dom
/**
 * The mounted window is bounded, and it is a window onto the *canonical*
 * conversation: the runtime keeps every message, the transcript mounts a few.
 *
 * Rewritten for M16-T87: the window is chosen by the virtualizer from measured
 * rows and a real scroll position, so this mounts the transcript over the
 * rig's browser instead of asserting on a controller with no scroller. The
 * guarantee is unchanged — canonical count untouched, a handful of rows
 * mounted, and the newest turn among them when the conversation opens.
 */
import { act } from "react";
import { useAuiState } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountRig, type Rig } from "./virtual-rig.js";

// The rendering cost of a row is orthogonal to provider/canonical-data ownership.
// Keep the real external runtime and identity-keyed message providers under test.
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  return { ThreadMessage: function Message() { const id = useAuiState(s => s.message.id); return <button>{id}</button>; } };
});

let rig: Rig | undefined;
let canonical = 0;
function CanonicalCount() { canonical = useAuiState(s => s.thread.messages.length); return null; }

beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; canonical = 0; });
afterEach(async () => { await rig?.dispose(); rig = undefined; });

it.each([40, 240, 2000, 10000])("mounts a bounded window without slicing %i canonical messages", async count => {
  const ids = Array.from({ length: count }, (_, index) => `row-${index}`);
  rig = await mountRig({ ids, height: () => 100, clientHeight: 700, extras: <CanonicalCount /> });
  expect(canonical).toBe(count);
  const rows = rig.mounted();
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(40);
  expect(rows.at(-1)).toBe(`row-${count - 1}`);
  if (count > 40) expect(rows[0]).not.toBe("row-0");
});

it("keeps a row's identity, and its own state, when earlier messages arrive above it", async () => {
  rig = await mountRig({ ids: ["tail"], height: () => 100, clientHeight: 700 });
  const tail = rig.container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { tail.focus(); });
  await rig.setIds(["older", "tail"]);
  expect(rig.container.querySelectorAll("button").length).toBe(2);
  expect(document.activeElement).toBe(tail);
  expect(tail.textContent).toBe("tail");
});
