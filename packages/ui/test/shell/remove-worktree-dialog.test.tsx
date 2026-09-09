// @vitest-environment happy-dom
/**
 * "Remove {agent}'s worktree?" — the person's escape hatch when the parent that
 * owns a worktree never got to it (M13-T42, D-157).
 *
 * What has to hold: it says what the worktree holds before asking; the safe
 * verb owns the first Enter; the host's refusal over unmerged work appears
 * inside the dialog and turns the verb into a deliberate second press; and the
 * session is never deleted by any of it.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorktreeStatus } from "@lasercode/protocol";

import { RemoveWorktreeDialog } from "../../src/components/agents/RemoveWorktreeDialog.js";
import { clearRemoveWorktreeRequest, requestRemoveWorktree } from "../../src/agents/worktree.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";

const stable = vi.hoisted(() => ({ actions: { toast: vi.fn(), agents: { worktreeStatus: vi.fn(), removeWorktree: vi.fn() } } }));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

const CHILD = "/p/child.jsonl";
const status = (over: Partial<AgentWorktreeStatus> = {}): AgentWorktreeStatus => ({
  path: "/p/.worktrees/explorer-1",
  branch: "agents/explorer-1",
  exists: true,
  unmergedCommits: 0,
  uncommittedFiles: 0,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
let store: StateStore;
const mount = async (node: ReactNode = <LaserStoreProvider store={store}><RemoveWorktreeDialog /></LaserStoreProvider>) => act(async () => root.render(node));
const dialog = () => document.querySelector<HTMLElement>('[data-slot="remove-worktree-dialog"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="remove-worktree-dialog"] button')].find((b) => b.textContent?.trim() === text);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const ask = async () => {
  await act(async () => requestRemoveWorktree(CHILD, "explorer"));
  await settle();
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  stable.actions.toast.mockReset();
  stable.actions.agents.worktreeStatus.mockReset();
  stable.actions.agents.removeWorktree.mockReset();
  clearRemoveWorktreeRequest();
  store = createStateStore(initialState);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearRemoveWorktreeRequest();
});

describe("RemoveWorktreeDialog", () => {
  it("names the branch and what it holds, and keeps Enter on the safe verb", async () => {
    stable.actions.agents.worktreeStatus.mockResolvedValue(status());
    await mount();
    expect(dialog()).toBeNull();
    await ask();
    expect(dialog()?.textContent).toContain("Remove explorer's worktree?");
    expect(dialog()?.textContent).toContain("The conversation stays");
    expect(dialog()?.textContent).toContain("agents/explorer-1");
    expect(dialog()?.textContent).toContain("Nothing in it is unmerged");
    expect(document.activeElement).toBe(button("Keep it"));

    stable.actions.agents.removeWorktree.mockResolvedValue({ removed: true, worktree: status({ exists: false }) });
    await act(async () => button("Remove worktree")!.click());
    await settle();
    expect(stable.actions.agents.removeWorktree).toHaveBeenCalledWith(CHILD, false);
    expect(stable.actions.toast).toHaveBeenCalledWith("info", "Removed explorer's worktree");
    expect(dialog()).toBeNull();
  });

  it("shows the host's refusal over unmerged work and only removes on a second, deliberate press", async () => {
    stable.actions.agents.worktreeStatus.mockResolvedValue(status({ unmergedCommits: 2 }));
    stable.actions.agents.removeWorktree.mockResolvedValueOnce({ removed: false, worktree: status({ unmergedCommits: 2, uncommittedFiles: 1 }) });
    await mount();
    await ask();
    expect(dialog()?.textContent).toContain("2 commits your project does not have");

    await act(async () => button("Remove worktree")!.click());
    await settle();
    expect(stable.actions.agents.removeWorktree).toHaveBeenLastCalledWith(CHILD, false);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Not removed.");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("2 commits your project does not have and 1 uncommitted file");
    expect(stable.actions.toast).not.toHaveBeenCalled();

    stable.actions.agents.removeWorktree.mockResolvedValueOnce({ removed: true, worktree: status({ exists: false }) });
    await act(async () => button("Remove anyway")!.click());
    await settle();
    expect(stable.actions.agents.removeWorktree).toHaveBeenLastCalledWith(CHILD, true);
    expect(dialog()).toBeNull();
  });

  it("offers nothing to remove when the worktree is already gone, or was never there", async () => {
    stable.actions.agents.worktreeStatus.mockResolvedValue(null);
    await mount();
    await ask();
    expect(dialog()?.getAttribute("data-gone")).toBe("true");
    expect(dialog()?.textContent).toContain("explorer has no worktree");
    expect(dialog()?.textContent).toContain("Its conversation is untouched");
    expect(button("Remove worktree")).toBeUndefined();
    await act(async () => button("Close")!.click());
    await settle();
    expect(stable.actions.agents.removeWorktree).not.toHaveBeenCalled();
  });

  it("says it could not read what the worktree holds, without hiding the control", async () => {
    stable.actions.agents.worktreeStatus.mockRejectedValue(new Error("the host is not answering"));
    await mount();
    await ask();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Could not read what it holds");
    expect(button("Remove worktree")).toBeDefined();
  });

  it("keeps a failure inside the dialog rather than closing on it", async () => {
    stable.actions.agents.worktreeStatus.mockResolvedValue(status());
    stable.actions.agents.removeWorktree.mockRejectedValueOnce(new Error("git is busy in that repository"));
    await mount();
    await ask();
    await act(async () => button("Remove worktree")!.click());
    await settle();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("git is busy in that repository");
    expect(dialog()).not.toBeNull();
    expect(stable.actions.toast).not.toHaveBeenCalled();
  });
});
