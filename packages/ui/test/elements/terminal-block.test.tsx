// @vitest-environment happy-dom
/**
 * M13-T60 — the terminal block's three opt-ins, each off by default.
 *
 * `follow` keeps the end of a running command in view as it prints, gives a
 * reader who scrolled up their place, and never moves a command that has
 * ended. `truncatedHead` is the one-line caption for a tail served by the
 * caller, in place of the block's own elision. `ansi` decodes colour escapes.
 * Without any of them the block is the transcript's `bash` body, unchanged.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TerminalBlock, type TerminalBlockProps } from "../../src/components/assistant-ui/elements/terminal-block.js";
import { ELISION_HEAD_LINES, ELISION_TAIL_LINES } from "../../src/components/thread/tool-summary.js";

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

const render = async (props: Partial<TerminalBlockProps> = {}): Promise<void> => {
  await act(async () => root.render(<TerminalBlock command="pnpm vite dev" output="" running isError={false} {...props} />));
};
const block = (): HTMLElement => container.querySelector<HTMLElement>('[data-slot="terminal-block"]')!;
const pre = (): HTMLPreElement => block().querySelector("pre")!;

/**
 * happy-dom lays nothing out, so the scroller's geometry is stated: a tall
 * body in a short box, and a `scrollTop` that remembers what it was set to.
 */
const geometry = (el: HTMLElement, scrollHeight: number, clientHeight: number): { top: () => number; set: (top: number) => void } => {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => (top = value) });
  return { top: () => top, set: (value) => (top = value) };
};
const scrolled = async (el: HTMLElement): Promise<void> => {
  await act(async () => el.dispatchEvent(new Event("scroll")));
};

describe("follow", () => {
  it("keeps the end in view while a running command prints", async () => {
    await render({ follow: true, output: "line 1\n" });
    const scroll = geometry(pre(), 500, 100);
    await render({ follow: true, output: "line 1\nline 2\n" });
    expect(scroll.top()).toBe(500);
    expect(pre().getAttribute("data-follow")).toBe("true");
  });

  it("leaves a reader who scrolled up where they are, and picks them up again at the bottom", async () => {
    await render({ follow: true, output: "line 1\n" });
    const scroll = geometry(pre(), 500, 100);
    // They scrolled up to read something.
    scroll.set(120);
    await scrolled(pre());
    await render({ follow: true, output: "line 1\nline 2\n" });
    expect(scroll.top()).toBe(120);
    // Back at the bottom, the next chunk follows again.
    scroll.set(400);
    await scrolled(pre());
    await render({ follow: true, output: "line 1\nline 2\nline 3\n" });
    expect(scroll.top()).toBe(500);
  });

  it("never moves a command that has ended", async () => {
    await render({ follow: true, output: "line 1\n" });
    const scroll = geometry(pre(), 500, 100);
    // The last chunk lands with the exit: no jump.
    await render({ follow: true, running: false, exitCode: 0, output: "line 1\nline 2\n" });
    expect(scroll.top()).toBe(0);
    expect(pre().getAttribute("data-follow")).toBeNull();
    // Nor when a finished command is re-read later.
    await render({ follow: true, running: false, exitCode: 0, output: "line 1\nline 2\nline 3\n" });
    expect(scroll.top()).toBe(0);
  });

  it("is off by default: the transcript's block does not scroll itself", async () => {
    await render({ output: "line 1\n" });
    const scroll = geometry(pre(), 500, 100);
    await render({ output: "line 1\nline 2\n" });
    expect(scroll.top()).toBe(0);
    expect(pre().getAttribute("data-follow")).toBeNull();
  });
});

describe("truncatedHead", () => {
  const long = Array.from({ length: ELISION_HEAD_LINES + ELISION_TAIL_LINES + 10 }, (_, i) => `line ${i}`).join("\n");

  it("says the output is a tail, and does not elide a tail a second time", async () => {
    await render({ truncatedHead: true, running: false, exitCode: 0, output: long });
    expect(block().querySelector('[data-slot="terminal-truncated-head"]')?.textContent).toBe("Showing the end of the output.");
    expect([...block().querySelectorAll("button")].some((b) => b.textContent?.includes("Show all"))).toBe(false);
    expect(pre().textContent).toContain("line 2005");
  });

  it("is silent by default, where the block's own elision applies", async () => {
    await render({ running: false, exitCode: 0, output: long });
    expect(block().querySelector('[data-slot="terminal-truncated-head"]')).toBeNull();
    expect([...block().querySelectorAll("button")].some((b) => b.textContent?.includes("Show all"))).toBe(true);
    expect(pre().textContent).not.toContain("line 2005");
  });
});

describe("ansi", () => {
  const coloured = "  \u001b[32m→\u001b[0m  Local: http://localhost:5173/";

  it("decodes colour escapes into styled text", async () => {
    await render({ ansi: true, output: coloured });
    expect(pre().textContent).not.toContain("\u001b");
    expect(pre().textContent).toContain("→  Local: http://localhost:5173/");
    expect(pre().querySelector("span[style]")).not.toBeNull();
  });

  it("shows the output as it is by default", async () => {
    await render({ output: coloured });
    expect(pre().textContent).toContain("\u001b[32m");
  });
});

describe("the header", () => {
  it("carries the command and the exit code, so nothing else has to", async () => {
    await render({ running: false, exitCode: 1, output: "1 failing" });
    expect(block().getAttribute("data-exit")).toBe("1");
    expect(block().textContent).toContain("pnpm vite dev");
    expect(block().textContent).toContain("exit 1");
  });

  it("says a finished command printed nothing", async () => {
    await render({ running: false, exitCode: 0, output: "" });
    expect(block().textContent).toContain("no output");
    expect(block().querySelector("pre")).toBeNull();
  });
});
