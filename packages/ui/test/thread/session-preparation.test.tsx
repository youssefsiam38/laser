// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const laser = vi.hoisted(() => ({
  currentProject: "/project" as string | undefined,
  view: undefined as { path: string; state: { agent?: { agentName: string } } } | undefined,
  defaultAgent: "default" as string | undefined,
}));

vi.mock("../../src/runtime/LaserProvider.js", () => ({
  useLaserStable: () => ({ currentProject: laser.currentProject }),
  useLaserView: () => laser.view,
  useLaserState: () => laser.defaultAgent,
}));

import { SessionPreparationProvider, useSessionPreparation } from "../../src/components/thread/session-preparation.js";
import { moveTentativeFirstTurn, readTentativeFirstTurn, writeTentativeFirstTurn } from "../../src/runtime/first-turn.js";

let release: (() => void) | undefined;
function Probe() {
  const { pending, begin, firstTurn, chooseAgent } = useSessionPreparation();
  const [, render] = useState(0);
  return <>
    <span data-state>{pending ? "locked" : "ready"}</span>
    <span data-agent>{firstTurn?.agentName ?? "none"}</span>
    <button onClick={() => { release = begin(); }}>Begin</button>
    <button onClick={() => { release?.(); render((value) => value + 1); }}>Finish</button>
    <button onClick={() => chooseAgent("reviewer")}>Reviewer</button>
  </>;
}

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => root.render(<SessionPreparationProvider><Probe /></SessionPreparationProvider>));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  release = undefined;
  laser.currentProject = "/project";
  laser.view = undefined;
  laser.defaultAgent = "default";
  writeTentativeFirstTurn("/project", undefined);
  writeTentativeFirstTurn("/created.jsonl", undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  writeTentativeFirstTurn("/project", undefined);
  writeTentativeFirstTurn("/created.jsonl", undefined);
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

it("follows a refused landing choice onto the created session for retry", async () => {
  const reviewer = container.querySelectorAll("button")[2]!;
  await act(async () => reviewer.click());
  const choice = readTentativeFirstTurn("/project")!;
  moveTentativeFirstTurn("/project", "/created.jsonl", choice);
  laser.view = { path: "/created.jsonl", state: { agent: { agentName: "default" } } };
  await render();

  expect(container.querySelector("[data-agent]")?.textContent).toBe("reviewer");
  expect(readTentativeFirstTurn("/project")).toBeUndefined();
  expect(readTentativeFirstTurn("/created.jsonl")).toBe(choice);
});

it("discards a tentative choice on ordinary navigation", async () => {
  await act(async () => container.querySelectorAll("button")[2]!.click());
  laser.view = { path: "/created.jsonl", state: { agent: { agentName: "default" } } };
  await render();

  expect(container.querySelector("[data-agent]")?.textContent).toBe("none");
  expect(readTentativeFirstTurn("/project")).toBeUndefined();
  expect(readTentativeFirstTurn("/created.jsonl")).toBeUndefined();
});
