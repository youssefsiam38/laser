// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it("offers non-destructive prepare and exact keep-working cancellation", async () => {
  const prepare = vi.fn();
  const cancel = vi.fn();
  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={{ state: "downloaded", updateId: "update-1", version: "1.1.0" }}
    onRefresh={() => {}}
    onPrepare={prepare}
  />));
  expect(container.textContent).toContain("Update downloaded.");
  expect(container.textContent).toContain("Prepare a restart when your current work is finished.");
  await act(async () => container.querySelector("button")!.click());
  expect(prepare).toHaveBeenCalledOnce();

  await act(async () => root.render(<VersionNotice
    desktopVersion="1.0.0"
    update={{
      state: "parking", updateId: "update-1", version: "1.1.0",
      blockers: { conversations: 1, agents: 2, questions: 1, approvals: 1, commands: 3, mutations: 0, workers: 1 },
    }}
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
    update={{ state: "ready", updateId: "update-1", version: "1.1.0" }}
    onRefresh={() => {}}
    onRestart={restart}
  />));
  expect(container.textContent).toContain("The update is ready to activate.");
  expect(container.textContent).toContain("Saved sessions are kept. No active work will be stopped.");
  expect(container.querySelector("button")?.textContent).toBe("Restart and update");
  await act(async () => container.querySelector("button")!.click());
  expect(restart).toHaveBeenCalledOnce();
});
