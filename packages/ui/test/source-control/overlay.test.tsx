// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import {
  ChangesOverlayHost,
  closeChanges,
  openChanges,
  resetChangesAdapter,
  resetChangesUi,
  setChangesAdapter,
} from "../../src/source-control/index.js";
import { createMockAdapter } from "../../src/source-control/mock.js";
import { attachOverlayPullRequest } from "../../src/source-control/store.js";

vi.mock("../../src/source-control/diff-body.js", () => ({
  DiffBody: ({ page }: { page: { path: string } }) => <div data-slot="diff-body">{page.path}</div>,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetChangesUi();
  resetChangesAdapter();
  setChangesAdapter(createMockAdapter());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetChangesUi();
  resetChangesAdapter();
  vi.restoreAllMocks();
});

function Fixture() {
  return (
    <TooltipProvider>
      <textarea defaultValue="keep this draft" />
      <ChangesOverlayHost />
    </TooltipProvider>
  );
}

async function mount() {
  await act(async () => root.render(<Fixture />));
}

async function open(args: Parameters<typeof openChanges>[0] = { scope: { kind: "session" } }) {
  await act(async () => {
    openChanges(args);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function overlay(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="changes-overlay"]');
  expect(node).toBeTruthy();
  return node!;
}

/**
 * The overlay is a big modal, not a second application (superseding the
 * "full-screen" wording in `docs/source-control-leap.md` §8.1). It is the
 * shared dialog surface — scrim, radius, border, elevation and the
 * exit-presence guard all come from `components/ui/dialog.tsx` — sized large.
 * Below `md` it is still full-bleed, because a gutter on a phone is worse
 * than none.
 */
it("is a large modal on top of the window, and full-bleed only on a phone width", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  const surface = overlay();
  expect(surface.dataset.slot).toBe("changes-overlay");
  // The app is still there behind it: a scrim, not a replacement.
  expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeTruthy();
  const classes = surface.className;
  // Nine tenths of the window: big, and still a modal with the app around it.
  expect(classes).toContain("h-[90dvh]");
  expect(classes).toContain("w-[90vw]");
  expect(classes).toContain("max-w-[90vw]");
  // No content cap: a diff is as wide as the window allows it to be.
  expect(classes).not.toContain("md:max-w-[calc(var(--measure-thread)");
  // The card is the shared dialog's: its radius, hairline and elevation
  // survive on the element, and the overlay restates none of them — it only
  // takes them off below `md`, where a gutter would cost more than it gives.
  expect(classes).toContain("rounded-2xl");
  expect(classes).toContain("border-line");
  expect(classes).toContain("shadow-float");
  expect(classes).not.toMatch(/(?<!max-)md:rounded-(?:md|lg|xl|2xl)/);
  expect(classes).not.toMatch(/(?<!max-)md:shadow-(?!none)/);
  expect(classes).not.toMatch(/(?<!max-)md:border(?!-0)/);
  // The dialog's own max-width for a small dialog is gone, not fought with.
  expect(classes).not.toContain("sm:max-w-sm");
  expect(classes).toContain("max-md:h-dvh");
  expect(classes).toContain("max-md:rounded-none");
  expect(classes).toContain("max-md:shadow-none");
  // One close affordance, the toolbar's; the dialog's own is off.
  expect(surface.querySelectorAll('[data-slot="dialog-close"]')).toHaveLength(0);
  const closes = [...surface.querySelectorAll("button")].filter((node) => node.getAttribute("aria-label") === "Close");
  expect(closes).toHaveLength(1);
});

it("opens over the conversation, keeps its draft, and Escape returns", async () => {
  await mount();
  const draft = container.querySelector("textarea")!;
  expect(draft.value).toBe("keep this draft");
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  expect(overlay().textContent).toContain("Changes");
  expect(container.querySelector("textarea")?.value).toBe("keep this draft");
  await act(async () => overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[data-slot="changes-overlay"]')).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe("keep this draft");
});

it("opens a file from the rail, toggles viewed with pointer and keyboard, and cycles files", async () => {
  await mount();
  await open({ scope: { kind: "session" } });
  const file = [...overlay().querySelectorAll("button")].find((button) => button.textContent?.includes("body-range.ts"));
  expect(file).toBeTruthy();
  await act(async () => file!.click());
  expect(overlay().querySelector('[data-slot="diff-body"]')?.textContent).toBe("src/body-range.ts");
  const viewed = overlay().querySelector<HTMLButtonElement>('[aria-label="Mark body-range.ts as viewed on this device"]');
  expect(viewed).toBeTruthy();
  await act(async () => viewed!.click());
  expect(overlay().textContent).toMatch(/1 of /);
  await act(async () => overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
  expect(overlay().querySelector('[aria-pressed="true"]')).toBeNull();
  await act(async () => overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
  expect(overlay().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("transcript-viewport.tsx");
});

it("closes a tab with middle click and restores the set when reopened", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/new.ts", sessionKey: "default" });
    await Promise.resolve();
  });
  expect(overlay().querySelectorAll('[role="tab"]')).toHaveLength(2);
  const tab = [...overlay().querySelectorAll('[role="tab"]')].find((node) => node.textContent?.includes("new.ts"))!;
  await act(async () => tab.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })));
  expect(overlay().querySelectorAll('[role="tab"]')).toHaveLength(1);
  await act(async () => closeChanges());
  await open({ scope: { kind: "session" } });
  expect(overlay().querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(overlay().querySelector('[role="tab"]')?.textContent).toContain("body-range.ts");
});

it("renders designed states for binary, rename, mode, huge, failed repo, empty, and a gone agent branch", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/logo.png" });
  // A changed picture is the picture and its two sizes, not the sentence
  // "Binary file" this used to assert (M20-T5, `image-diff.test.tsx`).
  expect(overlay().querySelector('[data-slot="changes-binary"]')).toBeTruthy();
  expect(overlay().textContent).toMatch(/went from 79 B to 93 B/);
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/moved.ts" });
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/is now/);
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/script.sh" });
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/executable/);
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/huge.ts" });
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/Show the changed hunks/);
  await act(async () => {
    openChanges({ scope: { kind: "range", from: "abc", to: "abc" } });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/Nothing changed/);
  await act(async () => {
    openChanges({ scope: { kind: "agent", runId: "run-gone" } });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/branch is gone/);
});

it("says when an agent is a worktree or a shared checkout, and when a removed worktree still has a branch", async () => {
  await mount();
  await open({ scope: { kind: "agent", runId: "run-worktree" } });
  expect(overlay().textContent).toMatch(/worktree/);
  await act(async () => {
    openChanges({ scope: { kind: "agent", runId: "run-shared" } });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/shared checkout/);
  await act(async () => {
    openChanges({ scope: { kind: "agent", runId: "run-removed" } });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(overlay().textContent).toMatch(/worktree was removed/);
});

it("selects a file without hiding the other repositories", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "connecting", path: "lib/client.ts" });
  expect(overlay().textContent).toContain("client.ts");
  expect(overlay().textContent).toContain("body-range.ts");
});

it("reaches AgentGoneState from the changes result without getAgentContext guessing", async () => {
  setChangesAdapter({
    listChanges: async () => ({
      scope: { kind: "agent", runId: "run-list-gone" },
      repos: [],
      agent: { runId: "run-list-gone", worktreeRemoved: true, branchGone: true },
    }),
    getFileDiff: async () => {
      throw new Error("no diff");
    },
    getAgentContext: async () => ({ runId: "run-list-gone", checkout: "worktree", worktreeRemoved: true }),
  });
  await mount();
  await open({ scope: { kind: "agent", runId: "run-list-gone" } });
  expect(overlay().textContent).toMatch(/branch is gone/);
});

it("keeps viewed ticks local until a pull request is attached, then calls the host without blocking", async () => {
  const viewed: Array<{ path: string; viewed: boolean }> = [];
  const adapter = createMockAdapter();
  adapter.gitPrViewed = async (params) => {
    viewed.push({ path: params.path, viewed: params.viewed });
    return {
      outcome: "done",
      confirmation: { repo: "app", branch: "", files: [params.path], summary: "Mark viewed." },
      path: params.path,
      viewed: params.viewed,
      message: "The mark is local-only until it syncs with GitHub.",
    };
  };
  setChangesAdapter(adapter);
  await mount();
  await open({ scope: { kind: "session" } });
  expect(overlay().textContent).toMatch(/Viewed on this device/);
  const local = overlay().querySelector<HTMLButtonElement>('[aria-label="Mark body-range.ts as viewed on this device"]');
  expect(local).toBeTruthy();
  await act(async () => local!.click());
  expect(viewed).toEqual([]);
  expect(overlay().textContent).toMatch(/1 of /);
  await act(async () => local!.click());

  await act(async () => attachOverlayPullRequest({ repo: "app", number: 12 }));
  const hostTick = overlay().querySelector<HTMLButtonElement>('[aria-label="Mark body-range.ts as viewed"]');
  expect(hostTick).toBeTruthy();
  await act(async () => {
    hostTick!.click();
    await Promise.resolve();
  });
  expect(viewed).toEqual([{ path: "src/body-range.ts", viewed: true }]);
  expect(overlay().textContent).toMatch(/local-only until it syncs/);
});

it("keeps a local tick when the viewed method fails", async () => {
  const adapter = createMockAdapter();
  adapter.gitPrViewed = async () => {
    throw new Error("network");
  };
  setChangesAdapter(adapter);
  await mount();
  await open({ scope: { kind: "session" } });
  await act(async () => attachOverlayPullRequest({ repo: "app", number: 12 }));
  const tick = overlay().querySelector<HTMLButtonElement>('[aria-label="Mark body-range.ts as viewed"]');
  await act(async () => {
    tick!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(overlay().querySelector('[aria-pressed="true"]')).toBeTruthy();
  expect(overlay().textContent).toMatch(/local-only until it syncs/);
});

it("opens find with Ctrl+F and keeps the git-action slot", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  expect(overlay().querySelector('[data-slot="changes-git-actions"]')).toBeTruthy();
  expect([...overlay().querySelectorAll("button")].some((item) => item.textContent?.includes("Commit"))).toBe(true);
  await act(async () => overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
  expect(overlay().querySelector('[data-slot="conversation-search"]')).toBeTruthy();
});
