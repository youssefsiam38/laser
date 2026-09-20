// @vitest-environment happy-dom
/**
 * What the overlay hands the renderer.
 *
 * The dead "More unchanged context may be available" row has exactly one
 * cause: a patch-parsed (`isPartial`) diff handed over *together with* a
 * `loadDiffFiles` promise. So the fix is not a nicer sentence, it is never
 * being in that state — we fetch both sides ourselves and hand over a
 * hydrated, non-partial diff, or we hand over the patch alone and say in our
 * own words why the surrounding lines are closed.
 *
 * `@pierre/diffs` is mocked at its own edge: this is about the arguments that
 * cross the boundary, and mounting a Shiki-backed custom element in a
 * headless DOM would prove nothing about them.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captured: { options: Record<string, unknown>; fileDiff: Record<string, unknown> }[] = [];
const hydrations: { fileDiff: Record<string, unknown>; files: Record<string, unknown> }[] = [];

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { options: Record<string, unknown>; fileDiff: Record<string, unknown> }) => {
    captured.push({ options: props.options, fileDiff: props.fileDiff });
    return <div data-slot="pierre-file-diff" />;
  },
  Virtualizer: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    <div data-pierre="virtualizer" data-slot="pierre-virtualizer" className={className}>{children}</div>,
}));

/**
 * The parsed patch is the real shape, not a stub: the overlay now verifies
 * the fetched sides against these hunks before hydrating, so a partial with
 * no content to check would prove nothing.
 */
function partialFor(name: string) {
  return {
    name,
    type: "change",
    isPartial: true,
    // `@@ -1,1 +1,2 @@` over a two-line file: one context line, one addition.
    hunks: [
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 2,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 1,
        deletionLineIndex: 0,
        hunkContent: [
          { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
          { type: "change", additions: 1, deletions: 0, additionLineIndex: 1, deletionLineIndex: 1 },
        ],
      },
    ],
    deletionLines: ["a\n"],
    additionLines: ["a\n", "b\n"],
  };
}

/** The two ends that partial was computed from. */
const OLD_TEXT = "a\n";
const NEW_TEXT = "a\nb\n";

vi.mock("@pierre/diffs", () => ({
  registerCustomTheme: () => {},
  parsePatchFiles: (patch: string) => [
    { files: [partialFor(patch.includes("other.ts") ? "src/other.ts" : "src/body-range.ts")] },
  ],
  hydratePartialDiff: (_type: string, fileDiff: Record<string, unknown>, files: Record<string, unknown>) => {
    hydrations.push({ fileDiff, files });
    return { ...fileDiff, isPartial: false };
  },
}));

const { DiffBody } = await import("../../src/source-control/diff-body.js");
const { resetChangesAdapter, setChangesAdapter } = await import("../../src/source-control/data.js");
const { createMockAdapter } = await import("../../src/source-control/mock.js");

type Adapter = Parameters<typeof setChangesAdapter>[0];

let root: Root;
let container: HTMLDivElement;

const PAGE = {
  repo: "app",
  path: "src/body-range.ts",
  status: "modified" as const,
  added: 3,
  removed: 1,
  patch: "diff --git a/src/body-range.ts b/src/body-range.ts\n@@ -1,1 +1,2 @@\n a\n+b\n",
};

/** A second file, opened in the same overlay while the first is mounted. */
const OTHER_PAGE = {
  ...PAGE,
  path: "src/other.ts",
  patch: "diff --git a/src/other.ts b/src/other.ts\n@@ -1,1 +1,2 @@\n a\n+b\n",
};

/** An adapter whose sides really are the two ends of the patch above. */
function sidesAdapter(overrides?: Partial<Record<"old" | "new", string>>): Adapter {
  return {
    ...createMockAdapter(),
    getFileSource: async (_scope: unknown, repo: string, path: string, side: "old" | "new") => ({
      repo,
      path,
      ref: side,
      contents: overrides?.[side] ?? (side === "old" ? OLD_TEXT : NEW_TEXT),
    }),
  } as unknown as Adapter;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  captured.length = 0;
  hydrations.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetChangesAdapter();
});

async function mount(adapter: Adapter, page: typeof PAGE = PAGE): Promise<void> {
  setChangesAdapter(adapter);
  await act(async () => root.render(<DiffBody page={page} scope={{ kind: "session" }} diffStyle="split" />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Select another file without unmounting: the rail and the tab strip do this. */
async function select(page: typeof PAGE): Promise<void> {
  await act(async () => root.render(<DiffBody page={page} scope={{ kind: "session" }} diffStyle="split" />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function body(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="changes-diff"]')!;
}

function notice(): string | null {
  return container.querySelector('[data-slot="changes-expansion-notice"]')?.textContent ?? null;
}

/**
 * Pierre's `Virtualizer` is the scroll container: it renders one plain div
 * and listens for `scroll` on it. Handed no overflow of its own, inside a
 * host that clips, a long file cannot be scrolled at all — which is exactly
 * what shipped.
 *
 * The class string is a proxy: this file mocks the renderer, so it cannot
 * read `scrollHeight` / `clientHeight`. The real proof is the browser check
 * (`scripts/browser-check/test/changes-overlay-scroll.mjs`), which opens a
 * file taller and wider than the overlay and asserts wheel, keyboard and
 * touch actually move `scrollTop` / `scrollLeft`.
 */
it("gives the renderer a scroll container, so a file longer than the overlay can be read", async () => {
  await mount(sidesAdapter());
  const virtualizer = container.querySelector<HTMLElement>('[data-pierre="virtualizer"]')!;
  expect(virtualizer.className).toMatch(/\boverflow-(auto|y-auto)\b/);
  expect(virtualizer.className).toMatch(/\bmin-h-0\b/);
  expect(virtualizer.className).toMatch(/\bflex-1\b/);
  expect(body().className).toContain("overflow-hidden");
  expect(body().className).toMatch(/\bflex\b/);
  // Keyboard path: Tab into the region, then PageDown/End/arrows. Pierre
  // does not forward tabIndex, so the chrome pass stamps it.
  expect(virtualizer.getAttribute("data-slot")).toBe("changes-diff-scroll");
  expect(virtualizer.tabIndex).toBe(0);
  expect(virtualizer.getAttribute("role")).toBe("region");
  expect(virtualizer.getAttribute("aria-label")).toBe("src/body-range.ts diff");
});

it("never hands the renderer a partial diff and a loader, which is the dead row's only cause", async () => {
  await mount(sidesAdapter());
  expect(captured.length).toBeGreaterThan(0);
  for (const call of captured) expect(call.options).not.toHaveProperty("loadDiffFiles");
});

it("hydrates from both sides, so every gap has a real size and a live expander", async () => {
  await mount(sidesAdapter());
  expect(hydrations).toHaveLength(1);
  expect(hydrations[0]!.files).toEqual({
    oldFile: { name: "src/body-range.ts", contents: OLD_TEXT },
    newFile: { name: "src/body-range.ts", contents: NEW_TEXT },
  });
  expect(captured.at(-1)!.fileDiff).toMatchObject({ isPartial: false });
  expect(body().getAttribute("data-expansion")).toBe("ready");
  expect(notice()).toBeNull();
});

it("refuses sides that are not the two ends this patch spans, and says so", async () => {
  // What the overlay used to fetch: the working tree on both sides. This is
  // the pair that made the renderer throw mid-render and took the window down.
  await mount(sidesAdapter({ old: NEW_TEXT }));
  expect(hydrations).toHaveLength(0);
  expect(captured.at(-1)!.fileDiff).toMatchObject({ isPartial: true });
  expect(body().getAttribute("data-expansion")).toBe("mismatched");
  expect(body().getAttribute("data-expansion-detail")).toMatch(/old side/);
  expect(notice()).toMatch(/no longer matches this diff/);
  expect(notice()).not.toMatch(/may be available/);
});

it("never hydrates one file's patch with another file's sides when the selection changes", async () => {
  // Selecting a file re-renders this component with the new patch while the
  // previous file's sides are still in state. Hydrating across that seam is a
  // guaranteed mismatch, which is why switching files crashed the window as
  // reliably as opening one did.
  const seen: string[] = [];
  const adapter = {
    ...createMockAdapter(),
    getFileSource: async (_scope: unknown, repo: string, path: string, side: "old" | "new") => {
      seen.push(`${path}:${side}`);
      return { repo, path, ref: side, contents: side === "old" ? OLD_TEXT : NEW_TEXT };
    },
  } as unknown as Adapter;
  await mount(adapter);
  expect(hydrations).toHaveLength(1);
  await select(OTHER_PAGE);
  // Two hydrations, each with its own file's name on both sides, and never
  // one of them hydrated while the other's sides were still held.
  expect(hydrations).toHaveLength(2);
  expect(hydrations[1]!.files).toEqual({
    oldFile: { name: "src/other.ts", contents: OLD_TEXT },
    newFile: { name: "src/other.ts", contents: NEW_TEXT },
  });
  // Nothing was ever hydrated under the wrong file's name.
  for (const call of hydrations) {
    expect((call.files as { newFile: { name: string } }).newFile.name).toBe(
      (call.fileDiff as { name: string }).name,
    );
  }
  expect(seen).toEqual([
    "src/body-range.ts:old",
    "src/body-range.ts:new",
    "src/other.ts:old",
    "src/other.ts:new",
  ]);
});

it("holds the previous file's sides back while the next file's are in flight", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let loads = 0;
  const adapter = {
    ...createMockAdapter(),
    getFileSource: async (_scope: unknown, repo: string, path: string, side: "old" | "new") => {
      loads += 1;
      if (path === "src/other.ts") await gate;
      return { repo, path, ref: side, contents: side === "old" ? OLD_TEXT : NEW_TEXT };
    },
  } as unknown as Adapter;
  await mount(adapter);
  expect(body().getAttribute("data-expansion")).toBe("ready");
  await select(OTHER_PAGE);
  // The second file is painted from its patch alone while its sides load —
  // not from the first file's text.
  expect(body().getAttribute("data-expansion")).toBe("loading");
  expect(captured.at(-1)!.fileDiff).toMatchObject({ name: "src/other.ts", isPartial: true });
  expect(notice()).toBeNull();
  release?.();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(body().getAttribute("data-expansion")).toBe("ready");
  expect(loads).toBe(4);
});

it("bounds one press to a screenful, never a file", async () => {
  await mount(sidesAdapter());
  const options = captured.at(-1)!.options;
  expect(options.expansionLineCount).toBe(24);
  expect(options.expandUnchanged).toBe(false);
  // The virtualizer is not optional: it is what keeps an expanded large file
  // from mounting twenty thousand line nodes.
  expect(container.querySelector('[data-pierre="virtualizer"]')).toBeTruthy();
});

it("says so plainly when the surrounding lines cannot be read", async () => {
  const adapter = { ...createMockAdapter(), getFileSource: async () => null };
  await mount(adapter);
  expect(hydrations).toHaveLength(0);
  expect(body().getAttribute("data-expansion")).toBe("unavailable");
  expect(notice()).toMatch(/could not be read/);
  expect(notice()).not.toMatch(/may be available/);
  expect(captured.at(-1)!.fileDiff).toMatchObject({ isPartial: true });
});

it("refuses a side the authority could only send in part, and says why", async () => {
  const adapter = {
    ...createMockAdapter(),
    getFileSource: async (_scope: unknown, repo: string, path: string, ref: "old" | "new") => ({
      repo,
      path,
      ref,
      contents: "half of the file",
      truncated: true,
    }),
  };
  await mount(adapter as unknown as Adapter);
  expect(hydrations).toHaveLength(0);
  expect(body().getAttribute("data-expansion")).toBe("too-large");
  expect(notice()).toMatch(/too large to read whole/);
});

it("carries our type into the light-DOM host, before any observer runs", async () => {
  await mount(sidesAdapter());
  const style = body().getAttribute("style") ?? "";
  expect(style).toContain("--diffs-font-family: var(--font-mono)");
  expect(style).toContain("--diffs-font-size: var(--text-code)");
});
