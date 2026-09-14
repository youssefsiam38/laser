// @vitest-environment happy-dom
/**
 * M16-T48 / review #49: the project line said everything it had to say in
 * native `title` attributes — no keyboard, no touch, and the ahead/behind
 * counts said the same words twice, once as a title and once as an
 * `aria-label`. Each is the app's tooltip now, and each says it once.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // One stable client, as the provider gives: a fresh one per render would
  // re-run the read forever.
  stable: undefined as unknown,
  git: {
    isRepo: true,
    branch: "agents/explorer-1",
    dirty: true,
    added: 12,
    removed: 3,
    ahead: 2,
    behind: 1,
    upstream: "origin/main",
  },
}));

vi.mock("@/runtime", () => ({
  useLaserStable: () => (mocks.stable ??= { client: { request: async () => mocks.git } }),
  useLaserState: (selector: (state: unknown) => unknown) =>
    selector({ current: "/p/s.jsonl", open: { "/p/s.jsonl": { state: { cwd: "/p" } } }, connection: "open" }),
}));
vi.mock("@/components/thread/session-updates.js", () => ({ useSessionUpdates: () => undefined }));
vi.mock("../../src/components/thread/session-updates.js", () => ({ useSessionUpdates: () => undefined }));

const { ProjectLine } = await import("../../src/components/thread/ProjectLine.js");
const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

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

const tooltips = () => [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((n) => n.textContent ?? "").join(" ");

describe("the project line", () => {
  it("says the branch, the delta and the sync counts in tooltips reachable by focus", async () => {
    await act(async () => root.render(<TooltipProvider><ProjectLine /></TooltipProvider>));
    const hints = [...container.querySelectorAll<HTMLElement>('[data-slot="hint"]')];
    expect(hints).toHaveLength(3);
    for (const hint of hints) expect(hint.getAttribute("title")).toBeNull();

    const read = async (hint: HTMLElement) => {
      await act(async () => hint.focus());
      const text = tooltips();
      await act(async () => hint.blur());
      return text;
    };
    expect(await read(hints[0]!)).toContain("Branch agents/explorer-1 · uncommitted changes");
    expect(await read(hints[1]!)).toContain("Lines changed since this session opened");

    // The counts are a description, not a second name for the same element.
    const sync = hints[2]!;
    expect(sync.getAttribute("aria-label")).toBeNull();
    expect(await read(sync)).toContain("2 ahead, 1 behind origin/main");
  });
});
