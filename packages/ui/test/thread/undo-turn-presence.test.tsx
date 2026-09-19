// @vitest-environment happy-dom
/**
 * Undo this turn — the confirmation actually leaves the document.
 *
 * Radix keeps a closed dialog mounted until its exit animation reports
 * `animationend`. The engine creates no animation at all for a zero-duration
 * one (`--motion-instant: 0ms`, Motion reduced), while computed
 * `animation-name` still reads `exit` — so `Presence` parks in
 * `unmountSuspended` and the closed dialog stays painted over the transcript
 * for good. These tests stand in that browser: the content reports an
 * animation name that changes with `data-state`, and no animation event is
 * ever delivered. Cancel, Escape and a finished restore must each still leave
 * nothing behind.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestorePreview } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";

const restoreImpl = vi.hoisted(() => ({
  preview: undefined as RestorePreview | undefined,
  confirmed: 0,
}));

const stable = vi.hoisted(() => ({
  client: {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === "pi/project/checkpoint/list") {
        return {
          path: "/p/work.jsonl",
          retention: "200",
          checkpoints: [{ turn: 0, ref: "refs/product/checkpoints/s/0", commit: "c0", createdAt: "2026-09-19T09:00:00.000Z" }],
        };
      }
      if (method === "pi/project/changes") return { scope: "turn", repos: [] };
      if (method === "pi/project/restore") {
        const body = params as { confirm?: boolean };
        if (!body.confirm) return { preview: restoreImpl.preview };
        restoreImpl.confirmed += 1;
        return { preview: restoreImpl.preview, restored: { files: true, conversation: false, repos: [] } };
      }
      return {};
    }),
    subscribe: vi.fn(() => () => {}),
  },
  actions: {
    toast: vi.fn(),
    rereadHistory: vi.fn(async () => undefined),
  },
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useCapability: () => ({ state: "available" }),
  useLaserStable: () => stable,
}));

const { UndoTurn } = await import("../../src/components/thread/UndoTurn.js");
const { EXIT_FALLBACK_MS, EXIT_SLACK_MS } = await import("../../src/components/ui/exit-presence.js");

const SESSION = "/p/work.jsonl";

const preview = (): RestorePreview => ({
  turn: 0,
  restore: "both",
  hidden: ["conversation"],
  repos: [{ repo: "/p/app", branch: "main", files: ["src/foo.ts"], uncommittedLost: [] }],
  staging: "not_restored",
  detail: "The working tree is restored. Staging is not: a checkpoint cannot record what was staged versus unstaged.",
});

let container: HTMLDivElement;
let root: Root;
let store: StateStore;

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  await act(async () => settle(0));
  await act(async () => settle(0));
  await act(async () => settle(0));
};
/** Past the control's own exit window, with room to spare. */
const afterExit = async () => {
  await act(async () => settle(EXIT_FALLBACK_MS + EXIT_SLACK_MS + 80));
  await flush();
};

/**
 * The browser this bug lives in: `animation-name` follows `data-state`, and
 * no `animationstart`/`animationend`/`animationcancel` is ever delivered —
 * exactly what Chromium does with `animation-duration: 0s`, which is what the
 * app's `--motion-instant` token is when motion is reduced.
 */
const standInForAZeroDurationBrowser = () => {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(((element: Element, pseudo?: string | null) => {
    const styles = real(element as HTMLElement, pseudo ?? null);
    if (!(element instanceof HTMLElement) || !element.hasAttribute("data-state")) return styles;
    return new Proxy(styles, {
      get(target, property) {
        if (property === "animationName") {
          return element.getAttribute("data-state") === "closed" ? "exit" : "enter";
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle);
};

const mount = async () => {
  let state: AppState = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION }) });
  state = reduce(state, {
    type: "destination",
    destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/p", path: SESSION } },
  });
  store = createStateStore(state);
  await act(async () =>
    root.render(
      <LaserStoreProvider store={store}>
        <TooltipProvider>
          <UndoTurn turn={0} at="2026-09-19T09:05:00.000Z" />
        </TooltipProvider>
      </LaserStoreProvider>,
    ),
  );
  await flush();
};

const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const trigger = () => document.querySelector<HTMLButtonElement>('[data-slot="undo-turn"]')!;
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="undo-turn-dialog"] button')].find(
    (button) => button.textContent?.trim() === label,
  );

const openDialog = async () => {
  await act(async () => trigger().click());
  await flush();
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  restoreImpl.preview = preview();
  restoreImpl.confirmed = 0;
  stable.client.request.mockClear();
  standInForAZeroDurationBrowser();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  for (const node of dialogs()) node.remove();
});

describe("the undo confirmation leaves the document", () => {
  it("opens once the preview is in", async () => {
    await mount();
    await openDialog();
    expect(dialogs()).toHaveLength(1);
    expect(document.querySelector('[data-slot="undo-turn-dialog"]')?.textContent).toContain("Undo this turn?");
  });

  it("is gone after Cancel — no closed ghost left painted over the transcript", async () => {
    await mount();
    await openDialog();
    await act(async () => dialogButton("Cancel")!.click());
    await afterExit();
    expect(dialogs()).toEqual([]);
    expect(document.querySelectorAll('[data-slot="undo-turn-dialog"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(0);
  });

  it("is gone after Escape", async () => {
    await mount();
    await openDialog();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await afterExit();
    expect(dialogs()).toEqual([]);
  });

  it("is gone after a restore that succeeded", async () => {
    await mount();
    await openDialog();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="undo-turn-confirm"]')!.click());
    await flush();
    await afterExit();
    expect(restoreImpl.confirmed).toBe(1);
    expect(dialogs()).toEqual([]);
  });

  it("re-opens after it was closed, with one dialog and no leftovers", async () => {
    await mount();
    await openDialog();
    await act(async () => dialogButton("Cancel")!.click());
    await afterExit();
    await openDialog();
    expect(dialogs()).toHaveLength(1);
    await act(async () => dialogButton("Cancel")!.click());
    await afterExit();
    expect(dialogs()).toEqual([]);
  });
});
