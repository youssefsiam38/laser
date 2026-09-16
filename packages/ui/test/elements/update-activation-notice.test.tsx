// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeUpdatePresentation, type ActivationBlockers, type RuntimeUpdateNoticeState } from "@lasercode/protocol";
import { VersionNotice } from "../../src/components/assistant-ui/elements/connection-state.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const notice = (state: RuntimeUpdateNoticeState, blockers?: ActivationBlockers) => {
  const presentation = runtimeUpdatePresentation(state, blockers);
  return {
    state, updateId: "update-1", version: "1.1.0",
    title: presentation.title, message: presentation.detail,
    action: presentation.action, actionLabel: presentation.actionLabel,
    secondaryAction: presentation.secondaryAction, secondaryActionLabel: presentation.secondaryActionLabel,
  };
};

it("offers non-destructive prepare and exact keep-working cancellation", async () => {
  const prepare = vi.fn();
  const cancel = vi.fn();
  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={notice("downloaded")}
    onRefresh={() => {}}
    onPrepare={prepare}
  />));
  expect(container.textContent).toContain("Update downloaded.");
  expect(container.textContent).toContain("Prepare a restart when your current work is finished.");
  await act(async () => container.querySelector("button")!.click());
  expect(prepare).toHaveBeenCalledOnce();

  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={notice("parking", { conversations: 1, agents: 2, questions: 1, approvals: 1, commands: 3, mutations: 0, workers: 1 })}
    onRefresh={() => {}}
    onCancel={cancel}
  />));
  expect(container.textContent).toContain("Waiting for current work to finish.");
  expect(container.textContent).toContain("1 conversation · 2 agents · 2 questions or approvals · 3 commands");
  expect(container.textContent).not.toContain("active work will stop");
  await act(async () => container.querySelector("button")!.click());
  expect(cancel).toHaveBeenCalledOnce();
});

it("only offers activation after the durable gate is ready", async () => {
  const restart = vi.fn();
  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={notice("ready")}
    onRefresh={() => {}}
    onRestart={restart}
  />));
  expect(container.textContent).toContain("The update is ready to activate.");
  expect(container.textContent).toContain("Saved sessions are kept. No active work will be stopped.");
  expect(container.querySelector("button")?.textContent).toBe("Restart and update");
  await act(async () => container.querySelector("button")!.click());
  expect(restart).toHaveBeenCalledOnce();

  restart.mockClear();
  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={notice("failed")}
    onRefresh={() => {}}
    onRestart={restart}
  />));
  expect(container.textContent).toContain("available to restore");
  expect(container.textContent).not.toContain("previous verified version");
  expect(container.querySelector("button")?.textContent).toBe("Try again");
  await act(async () => container.querySelector("button")!.click());
  expect(restart).toHaveBeenCalledOnce();
});

it("keeps migration failure retry and exact snapshot restore as separate actions", async () => {
  const retry = vi.fn();
  const restore = vi.fn();
  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={notice("migration-failed")}
    onRefresh={() => {}}
    onPrepare={retry}
    onRestore={restore}
  />));
  expect(container.textContent).toContain("The update could not be finished.");
  expect(container.textContent).toContain("Your previous data snapshot is intact.");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Try again", "Restore previous data"]);
  expect(buttons[0]!.className).not.toBe(buttons[1]!.className);
  expect(buttons[1]!.hasAttribute("data-secondary-action")).toBe(false);
  await act(async () => buttons[0]!.click());
  await act(async () => buttons[1]!.click());
  expect(retry).toHaveBeenCalledOnce();
  expect(restore).toHaveBeenCalledOnce();
});
