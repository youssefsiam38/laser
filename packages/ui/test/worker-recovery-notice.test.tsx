// @vitest-environment happy-dom
import type { WorkerInfo } from "@lasercode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerRecoveryNotice } from "../src/components/worker-recovery-notice.js";

let container: HTMLDivElement;
let root: Root;

const worker = (overrides: Partial<WorkerInfo> = {}): WorkerInfo => ({
  cwd: "/project",
  status: "crashed",
  mode: "normal",
  restarts: 0,
  since: "2026-09-16T00:00:00.000Z",
  canRestart: true,
  failure: {
    owner: { kind: "worker", launchId: "0123456789abcdef0123456789abcdef", cwd: "/project" },
    stage: "runtime",
    category: "process_exit",
    message: "stopped",
  },
  repair: { state: "available", automaticAttempts: 0 },
  ...overrides,
});

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

it("renders one shared crash recovery surface and wires both explicit actions", async () => {
  const onRestart = vi.fn();
  await act(async () => root.render(<WorkerRecoveryNotice worker={worker()} onRestart={onRestart} />));
  expect(container.textContent).toContain("Worker crashed");
  expect(container.textContent).not.toContain("couldn't start");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Try again", "Start in safe mode"]);
  await act(async () => buttons[0]!.click());
  await act(async () => buttons[1]!.click());
  expect(onRestart.mock.calls).toEqual([[], ["safe"]]);
});

it("shows couldn't-start copy only after launch repair is exhausted", async () => {
  await act(async () => root.render(<WorkerRecoveryNotice
    worker={worker({
      failure: {
        owner: { kind: "worker", launchId: "0123456789abcdef0123456789abcdef", cwd: "/project" },
        stage: "initialize",
        category: "initialization_error",
        message: "failed",
      },
      repair: { state: "exhausted", automaticAttempts: 2 },
    })}
    onRestart={() => undefined}
  />));
  expect(container.textContent).toContain("This project's agent couldn't start");
});

it("does not duplicate the neutral safe-mode status outside its chip", async () => {
  await act(async () => root.render(<WorkerRecoveryNotice worker={worker({ status: "ready", mode: "safe" })} onRestart={() => undefined} />));
  expect(container.textContent).toBe("");
});
