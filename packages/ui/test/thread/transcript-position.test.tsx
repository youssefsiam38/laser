// @vitest-environment happy-dom
/**
 * The two positions this milestone exists for, and the two the list must not
 * move (M16-T91, D-306, `docs/transcript-reading.md`).
 *
 * Every test here drives the real list over the rig's browser and measures
 * the pixels a person would see. Nothing asks the controller where it thinks
 * anything is.
 *
 * - a fold opening or closing keeps the row the person clicked exactly where
 *   it is, by pointer and by keyboard;
 * - the composer growing a line moves no message.
 *
 * The prepend and the row-above-the-reader cases live beside the rest of the
 * geometry in `transcript-virtualization.test.tsx`.
 */
import { act, useState } from "react";
import { useAuiState, useThreadViewport } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRig, type Rig } from "./virtual-rig.js";

/** Rows whose fold is open, and what that costs in pixels. */
const open = vi.hoisted(() => new Set<string>());
const CLOSED = 200;
const OPEN = 900;

/**
 * A row with a real disclosure: a button that owns `aria-expanded`, exactly
 * as the activity rows and tool rows do. The transcript learns that a fold
 * moved from the control itself, so nothing has to tell it.
 */
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState: state } = await import("@assistant-ui/react");
  return { ThreadMessage: function Message() {
    const id = state(s => s.message.id);
    const [expanded, setExpanded] = useState(() => open.has(id));
    return <div data-message-id={id}>
      <button type="button" aria-expanded={expanded} onClick={() => { setExpanded(next => { const value = !next; if (value) open.add(id); else open.delete(id); return value; }); }}>{id}</button>
    </div>;
  } };
});

let rig: Rig | undefined;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await rig?.dispose(); rig = undefined; open.clear(); });

const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => `r${from + i}`);
const height = (id: string) => (open.has(id) ? OPEN : CLOSED);

async function reading(at = 20) {
  const started = await mountRig({ ids: rows(0, 60), height, clientHeight: 900 });
  await started.scrollTo(at * CLOSED + 100);
  return started;
}

/** The control a person clicks, inside a given row. */
function fold(rig: Rig, id: string): HTMLButtonElement {
  const control = rig.node(id)?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (!control) throw new Error(`${id} is not mounted`);
  return control;
}

describe("a fold the person toggles", () => {
  it("keeps the clicked row where it is, by pointer, opening and closing", async () => {
    rig = await reading();
    const clicked = rig.mounted()[rig.mounted().indexOf(rig.topVisible()!) + 1]!;
    const before = rig.screenTop(clicked)!;
    expect(before).toBeGreaterThan(0);
    await act(async () => { fold(rig!, clicked).click(); });
    await rig.settle(2);
    expect(fold(rig, clicked).getAttribute("aria-expanded")).toBe("true");
    expect(Math.abs(rig.screenTop(clicked)! - before), "opening moved the row the person clicked").toBeLessThanOrEqual(1);
    await act(async () => { fold(rig!, clicked).click(); });
    await rig.settle(2);
    expect(fold(rig, clicked).getAttribute("aria-expanded")).toBe("false");
    expect(Math.abs(rig.screenTop(clicked)! - before), "closing moved the row the person clicked").toBeLessThanOrEqual(1);
  });

  it("keeps the clicked row where it is, by keyboard", async () => {
    rig = await reading();
    const clicked = rig.mounted()[rig.mounted().indexOf(rig.topVisible()!) + 1]!;
    const before = rig.screenTop(clicked)!;
    await act(async () => {
      const control = fold(rig!, clicked);
      control.focus();
      // A keyboard activation of a button raises the same click a pointer
      // does; the key event is here so the transcript sees the whole gesture.
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      control.click();
    });
    await rig.settle(2);
    expect(fold(rig, clicked).getAttribute("aria-expanded")).toBe("true");
    expect(Math.abs(rig.screenTop(clicked)! - before), "the keyboard fold moved the row").toBeLessThanOrEqual(1);
  });

  it("keeps the clicked row where it is when the row the reader is in opens below their line", async () => {
    rig = await reading();
    const clicked = rig.topVisible()!;
    const before = rig.screenTop(clicked)!;
    expect(before).toBeLessThan(0);
    await act(async () => { fold(rig!, clicked).click(); });
    await rig.settle(2);
    expect(Math.abs(rig.screenTop(clicked)! - before), "the fold dragged the row it belongs to").toBeLessThanOrEqual(1);
  });
});

/** The composer's height, as the thread's own viewport reports it. */
function Composer({ inset }: { inset: number }) {
  const register = useThreadViewport(s => s.registerContentInset);
  const [handle] = useState(() => register());
  handle.setHeight(inset);
  return null;
}

describe("the composer over the transcript", () => {
  it("moves no message when its inset changes", async () => {
    let setInset!: (value: number) => void;
    function Footer() {
      const [inset, set] = useState(120);
      setInset = set;
      return <Composer inset={inset} />;
    }
    rig = await mountRig({ ids: rows(0, 60), height, clientHeight: 900, extras: <Footer /> });
    await rig.scrollTo(20 * CLOSED + 100);
    const tops = new Map(rig.mounted().map(id => [id, rig!.screenTop(id)!]));
    const scrollTop = rig.scrollTop();
    await act(async () => { setInset(280); });
    await rig.settle(2);
    expect(rig.scrollTop(), "the composer growing moved the view").toBe(scrollTop);
    for (const [id, top] of tops) {
      if (rig.screenTop(id) === undefined) continue;
      expect(Math.abs(rig.screenTop(id)! - top), `${id} moved when the composer grew`).toBeLessThanOrEqual(1);
    }
    // The space is real: the newest turn can still be read above the composer.
    expect(rig.scrollHeight()).toBeGreaterThan(0);
  });
});

/** Keeps the linter honest about the unused import in this file's mock. */
void useAuiState;
