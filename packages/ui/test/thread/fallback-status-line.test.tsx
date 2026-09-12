// @vitest-environment happy-dom
/**
 * M15-T3: the words above the composer while a fallback chain is moving this
 * conversation. The engine is idle between its own runs during a failover, so
 * "idle" would be a lie; the line says what is happening and which model is
 * being tried.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionState } from "@lasercode/protocol";

const app = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/runtime", () => ({
  useLaserState: (selector: (s: unknown) => unknown, equality?: (a: unknown, b: unknown) => boolean) => {
    void equality;
    return selector(app.state);
  },
}));
vi.mock("@/components/thread/thread-slots.js", () => ({ useThreadSlots: () => ({}) }));
vi.mock("@/components/thread/session-updates.js", () => ({ useSessionUpdates: () => () => () => {} }));

import { initialState } from "../../src/store.js";
import { StatusLine } from "../../src/components/thread/StatusLine.js";

let root: Root, container: HTMLDivElement;

const session = (fallback?: SessionState["fallback"], model?: { provider: string; id: string; name?: string }): SessionState => ({
  path: "/s.jsonl",
  id: "s",
  cwd: "/p",
  model: model ?? null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 2,
  pendingMessageCount: 0,
  ...(fallback ? { fallback } : {}),
});

function setSession(state: SessionState, running = false): void {
  app.state = {
    ...initialState,
    current: state.path,
    connection: "open",
    workers: { "/p": { status: "running" } },
    open: { [state.path]: { path: state.path, state, running, dialogs: [], blocks: [] } },
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const render = () => act(async () => root.render(<StatusLine />));
const words = () => container.querySelector('[role="status"]')?.textContent?.trim();

it("never calls an opening session idle, including before its view exists", async () => {
  setSession(session());
  app.state.sessionLoads = { "/s.jsonl": "opening" };
  await render();
  expect(words()).toBe("loading the conversation");
  app.state.current = undefined;
  await render();
  expect(words()).toBe("loading the conversation");
});

it("says idle when nothing is happening, as it always has", async () => {
  setSession(session());
  await render();
  expect(words()).toBe("idle");
});

it("names the model a chain is switching to, ahead of working", async () => {
  const chain = [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
    { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek V3" },
  ];
  setSession(session({ chain, position: 0, switching: true }, chain[1]));
  await render();
  expect(words()).toBe("switching to DeepSeek V3");
});

it("falls back to plain words when no model is selected yet", async () => {
  setSession(session({ chain: [{ provider: "a", id: "one" }, { provider: "b", id: "two" }], position: 0, switching: true }));
  await render();
  expect(words()).toBe("switching models");
});

it("goes back to working, then idle, once the chain has settled", async () => {
  const chain = [{ provider: "a", id: "one", name: "One" }, { provider: "b", id: "two", name: "Two" }];
  setSession(session({ chain, position: 1 }, chain[1]), true);
  await render();
  expect(words()).toBe("working");
  setSession(session({ chain, position: 1 }, chain[1]));
  await render();
  expect(words()).toBe("idle");
});
