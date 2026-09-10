// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/store.js";
import { view as sessionView } from "../agents/fixtures.js";

const laser = vi.hoisted(() => ({
  view: undefined as SessionView | undefined,
  defaultAgent: "default" as string | undefined,
}));
const composer = vi.hoisted(() => ({
  runConfig: {} as { custom?: Record<string, unknown> },
  listeners: new Set<() => void>(),
}));

vi.mock("../../src/runtime/LaserProvider.js", () => ({
  useLaserView: () => laser.view,
  useLaserState: () => laser.defaultAgent,
}));

vi.mock("@assistant-ui/react", async (original) => {
  const actual = await original<typeof import("@assistant-ui/react")>();
  const React = await import("react");
  const client = {
    composer: {
      getState: () => ({ runConfig: composer.runConfig }),
      setRunConfig: (runConfig: typeof composer.runConfig) => {
        composer.runConfig = runConfig;
        composer.listeners.forEach((listener) => listener());
      },
    },
  };
  return {
    ...actual,
    useAui: () => client,
    useAuiState: (selector: (state: { composer: { runConfig: typeof composer.runConfig } }) => unknown) => React.useSyncExternalStore(
      (listener) => { composer.listeners.add(listener); return () => composer.listeners.delete(listener); },
      () => selector({ composer: { runConfig: composer.runConfig } }),
    ),
  };
});

import { SessionPreparationProvider, useSessionPreparation } from "../../src/components/thread/session-preparation.js";
import { firstTurnFromRunConfig } from "../../src/runtime/first-turn.js";

let release: (() => void) | undefined;
function Probe() {
  const { pending, begin, firstTurn, chooseAgent, chooseThinking } = useSessionPreparation();
  const [, render] = useState(0);
  return <>
    <span data-state>{pending ? "locked" : "ready"}</span>
    <span data-agent>{firstTurn?.agentName ?? "none"}</span>
    <span data-thinking>{firstTurn?.thinkingLevel ?? "none"}</span>
    <button onClick={() => { release = begin(); }}>Begin</button>
    <button onClick={() => { release?.(); render((value) => value + 1); }}>Finish</button>
    <button onClick={() => chooseAgent("reviewer")}>Reviewer</button>
    <button onClick={() => chooseThinking("high")}>High</button>
  </>;
}

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => root.render(<SessionPreparationProvider><Probe /></SessionPreparationProvider>));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  release = undefined;
  laser.view = undefined;
  laser.defaultAgent = "default";
  composer.runConfig = { custom: { retained: "yes" } };
  composer.listeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps its composer locked until the matching preparation finishes", async () => {
  const buttons = container.querySelectorAll("button");
  expect(container.querySelector("[data-state]")?.textContent).toBe("ready");
  await act(async () => buttons[0]!.click());
  expect(container.querySelector("[data-state]")?.textContent).toBe("locked");
  await act(async () => buttons[1]!.click());
  expect(container.querySelector("[data-state]")?.textContent).toBe("ready");
  await act(async () => buttons[1]!.click());
  expect(container.querySelector("[data-state]")?.textContent).toBe("ready");
});

it("keeps agent and thinking on this composer's run config without replacing other custom data", async () => {
  const buttons = container.querySelectorAll("button");
  await act(async () => buttons[2]!.click());
  await act(async () => buttons[3]!.click());

  expect(container.querySelector("[data-agent]")?.textContent).toBe("reviewer");
  expect(container.querySelector("[data-thinking]")?.textContent).toBe("high");
  expect(firstTurnFromRunConfig(composer.runConfig)).toEqual({ agentName: "reviewer", thinkingLevel: "high" });
  expect(composer.runConfig.custom?.retained).toBe("yes");
});

it("clears a consumed choice when the session is no longer pristine", async () => {
  await act(async () => container.querySelectorAll("button")[2]!.click());
  laser.view = sessionView({ path: "/created.jsonl", state: { ...sessionView({ path: "/created.jsonl" }).state, messageCount: 1 } });
  await render();

  expect(container.querySelector("[data-agent]")?.textContent).toBe("none");
  expect(firstTurnFromRunConfig(composer.runConfig)).toBeUndefined();
  expect(composer.runConfig.custom?.retained).toBe("yes");
});
