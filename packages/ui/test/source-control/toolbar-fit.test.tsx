// @vitest-environment happy-dom
/**
 * The toolbar degrades by dropping content, never by shrinking type.
 *
 * Two halves: the plan is arithmetic (`overlayToolbarPlan` /
 * `overlayToolbarCost`), so the 288px claim is proved rather than asserted;
 * and the header really obeys the plan it is handed, so the arithmetic is not
 * describing a toolbar nobody drew.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  OVERLAY_TOOLBAR_MIN_PX,
  overlayChromeLayout,
  overlayToolbarCost,
  overlayToolbarPlan,
  type OverlayToolbarPlan,
} from "../../src/source-control/classify.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { ChangedRepo } from "../../src/source-control/contract.js";
import { resetChangesAdapter, setChangesAdapter } from "../../src/source-control/data.js";
import { createMockAdapter } from "../../src/source-control/mock.js";
import { ChangesToolbar } from "../../src/source-control/toolbar.js";
import { resetChangesUi } from "../../src/source-control/store.js";

const ROOT_FONT = 16;

const REPOS: ChangedRepo[] = [
  { repo: "/p/app", branch: "main", files: [{ path: "src/a.ts", status: "modified", added: 1204, removed: 318 }] },
  { repo: "/p/lib", branch: "main", files: [{ path: "src/b.ts", status: "modified", added: 3, removed: 0 }] },
];

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

async function renderToolbar(width: number): Promise<HTMLElement> {
  const plan = overlayToolbarPlan(width, ROOT_FONT);
  // The overlay carries the provider for the real mount (overlay-chrome.test);
  // here one sub-component is under test, so the test supplies it.
  await act(async () =>
    root.render(
      <TooltipProvider>
      <ChangesToolbar
        scope={{ kind: "session" }}
        repos={REPOS}
        workspaceRepos={[
          { root: "/p/app", name: "app", projectRoot: true, gitDir: "/p/app/.git", insideWorkTree: true },
          { root: "/p/lib", name: "lib", projectRoot: false, gitDir: "/p/lib/.git", insideWorkTree: true },
        ]}
        repoFilter={null}
        totals={{ added: 1204, removed: 318 }}
        rangeFrom="HEAD"
        rangeTo=""
        canTurn={false}
        canAgent={false}
        plan={plan}
        diffStyle="split"
        unifiedFallback={false}
        onScope={() => {}}
        onRepoFilter={() => {}}
        onRange={() => {}}
        onDiffStyle={() => {}}
        onClose={() => {}}
        onOpenTree={() => {}}
      />
      </TooltipProvider>,
    ),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container.querySelector<HTMLElement>('[data-slot="changes-toolbar"]')!;
}

it("plans a row that fits 288px of content, and richer rows as width arrives", () => {
  const tight = overlayToolbarPlan(OVERLAY_TOOLBAR_MIN_PX, ROOT_FONT);
  expect(tight.tier).toBe("tight");
  const cost = overlayToolbarCost(tight, { repos: true, git: true });
  expect(cost.row).toBeLessThanOrEqual(OVERLAY_TOOLBAR_MIN_PX);
  expect(cost.secondRow).toBeLessThanOrEqual(OVERLAY_TOOLBAR_MIN_PX);

  for (const width of [288, 320, 360, 480, 640, 768, 1024, 1440]) {
    const plan = overlayToolbarPlan(width, ROOT_FONT);
    const each = overlayToolbarCost(plan, { repos: true, git: true });
    expect({ width, row: each.row <= width, second: each.secondRow <= width }).toEqual({
      width,
      row: true,
      second: true,
    });
  }

  expect(overlayToolbarPlan(480, ROOT_FONT).tier).toBe("compact");
  expect(overlayToolbarPlan(640, ROOT_FONT).tier).toBe("medium");
  expect(overlayToolbarPlan(1024, ROOT_FONT).tier).toBe("wide");
  // An unmeasured box plans the finished toolbar rather than a phone one.
  expect(overlayToolbarPlan(0, 0).tier).toBe("wide");
});

it("sheds labels, then secondary controls, and never the four things that matter", async () => {
  const shown = async (width: number) => {
    const header = await renderToolbar(width);
    const text = header.textContent ?? "";
    const labels = [...header.querySelectorAll("button")].map(
      (button) => `${button.textContent ?? ""}|${button.getAttribute("aria-label") ?? ""}`,
    );
    return {
      tier: header.getAttribute("data-tier"),
      title: text.includes("Changes"),
      scopeLong: labels.some((label) => label.includes("This session")),
      scopeShort: labels.some((label) => label.startsWith("Session")),
      repoFilter: Boolean(header.querySelector('[data-slot="changes-repo-filter"]')),
      totals: header.querySelector('[data-slot="changes-totals"]')?.textContent ?? "",
      commit: labels.some((label) => label.includes("Commit")),
      gitMenu: labels.some((label) => label.includes("Git")),
      esc: text.includes("Esc"),
      files: labels.some((label) => label.includes("Files") || label.includes("Changed files")),
    };
  };

  const tight = await shown(288);
  expect(tight.tier).toBe("tight");
  expect(tight.title).toBe(false);
  expect(tight.scopeLong).toBe(false);
  expect(tight.scopeShort).toBe(true);
  expect(tight.repoFilter).toBe(true);
  expect(tight.totals).toContain("1\u00a0204");
  expect(tight.totals).toContain("318");
  expect(tight.commit).toBe(false);
  expect(tight.gitMenu).toBe(true);
  expect(tight.esc).toBe(false);
  expect(tight.files).toBe(true);

  const compact = await shown(480);
  expect(compact.tier).toBe("compact");
  expect(compact.scopeShort).toBe(true);
  expect(compact.commit).toBe(false);
  expect(compact.repoFilter).toBe(true);

  const medium = await shown(640);
  expect(medium.tier).toBe("medium");
  expect(medium.title).toBe(true);
  expect(medium.scopeLong).toBe(true);
  expect(medium.commit).toBe(false);
  expect(medium.files).toBe(false);

  const wide = await shown(1024);
  expect(wide.tier).toBe("wide");
  expect(wide.commit).toBe(true);
  expect(wide.esc).toBe(true);
});

it("keeps every toolbar value at or above the 12px floor, and the totals tabular", async () => {
  const header = await renderToolbar(288);
  const classes = [...header.querySelectorAll<HTMLElement>("*")].flatMap((node) =>
    typeof node.className === "string" ? node.className.split(/\s+/) : [],
  );
  // `text-2xs` is the 11px eyebrow, and an eyebrow is a category, never a value.
  expect(classes).not.toContain("text-2xs");
  expect(classes.filter((name) => /^text-\[/.test(name))).toEqual([]);
  expect(classes.filter((name) => /^\[?font-size/.test(name))).toEqual([]);

  const totals = header.querySelector<HTMLElement>('[data-slot="changes-totals"]')!;
  // `typed` is the mono face at the floor with tabular figures.
  expect(totals.className).toContain("typed");
});

it("paints its controls at the full size a whole-window surface deserves", async () => {
  // Measured before this landed: 28px boxes with 12px labels on a surface
  // that takes the whole window — the primary actions read as an
  // afterthought. `default` is `h-8` with a 13px label; `icon` is `size-8`.
  // The small steps are what this toolbar must never go back to.
  const small = new Set(["sm", "xs", "icon-sm", "icon-xs"]);
  for (const width of [288, 480, 640, 1024]) {
    const header = await renderToolbar(width);
    const sizes = [...header.querySelectorAll<HTMLElement>("button")].map((node) => node.getAttribute("data-size"));
    expect(sizes.length).toBeGreaterThan(0);
    expect({ width, small: sizes.filter((size) => size !== null && small.has(size)) }).toEqual({ width, small: [] });
    // Coarse pointers get the 44px target whatever the paint is.
    for (const node of header.querySelectorAll<HTMLElement>("button")) {
      expect({
        width,
        label: node.getAttribute("aria-label") ?? node.textContent,
        touch: /pointer-coarse:(?:min-h-11|size-11)/.test(node.className),
      }).toMatchObject({ touch: true });
    }
  }
});

it("puts the toolbar's plan in one place, so the header cannot disagree with it", () => {
  const plans: OverlayToolbarPlan[] = [288, 480, 640, 1024].map((width) => overlayToolbarPlan(width, ROOT_FONT));
  // Totals never vanish; they move to their own line only at the tightest tier.
  expect(plans.map((plan) => plan.totals)).toEqual(["second-row", "row", "row", "row"]);
  // The tree control exists exactly while the tree is a sheet, and at full
  // control size neither narrow tier can afford its label.
  expect(plans.map((plan) => plan.tree)).toEqual(["icon", "icon", "hidden", "hidden"]);
  // … and "while the tree is a sheet" means the same width the layout means.
  for (const width of [288, 480, 639, 640, 1024]) {
    expect({
      width,
      control: overlayToolbarPlan(width, ROOT_FONT).tree !== "hidden",
    }).toEqual({ width, control: overlayChromeLayout(width, ROOT_FONT) === "phone" });
  }
});
