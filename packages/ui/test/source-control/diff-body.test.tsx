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
  Virtualizer: ({ children }: { children: React.ReactNode }) => <div data-slot="pierre-virtualizer">{children}</div>,
}));

vi.mock("@pierre/diffs", () => ({
  registerCustomTheme: () => {},
  parsePatchFiles: () => [
    {
      files: [
        { name: "src/body-range.ts", type: "change", isPartial: true, hunks: [{ collapsedBefore: 12 }] },
      ],
    },
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
  patch: "diff --git a/src/body-range.ts b/src/body-range.ts\n@@ -1,1 +1,2 @@\n-a\n+b\n",
};

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

async function mount(adapter: Adapter): Promise<void> {
  setChangesAdapter(adapter);
  await act(async () => root.render(<DiffBody page={PAGE} scope={{ kind: "session" }} diffStyle="split" />));
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

it("never hands the renderer a partial diff and a loader, which is the dead row's only cause", async () => {
  await mount(createMockAdapter());
  expect(captured.length).toBeGreaterThan(0);
  for (const call of captured) expect(call.options).not.toHaveProperty("loadDiffFiles");
});

it("hydrates from both sides, so every gap has a real size and a live expander", async () => {
  await mount(createMockAdapter());
  expect(hydrations).toHaveLength(1);
  expect(hydrations[0]!.files).toEqual({
    oldFile: { name: "src/body-range.ts", contents: expect.any(String) },
    newFile: { name: "src/body-range.ts", contents: expect.any(String) },
  });
  expect(captured.at(-1)!.fileDiff).toMatchObject({ isPartial: false });
  expect(body().getAttribute("data-expansion")).toBe("ready");
  expect(notice()).toBeNull();
});

it("bounds one press to a screenful, never a file", async () => {
  await mount(createMockAdapter());
  const options = captured.at(-1)!.options;
  expect(options.expansionLineCount).toBe(24);
  expect(options.expandUnchanged).toBe(false);
  // The virtualizer is not optional: it is what keeps an expanded large file
  // from mounting twenty thousand line nodes.
  expect(container.querySelector('[data-slot="pierre-virtualizer"]')).toBeTruthy();
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
  await mount(createMockAdapter());
  const style = body().getAttribute("style") ?? "";
  expect(style).toContain("--diffs-font-family: var(--font-mono)");
  expect(style).toContain("--diffs-font-size: var(--text-code)");
});
