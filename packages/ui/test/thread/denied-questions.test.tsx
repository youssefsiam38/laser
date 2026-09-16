// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

const calls = vi.hoisted(() => ({ request: vi.fn(), answerDialog: vi.fn(), send: vi.fn() }));
vi.mock("@/runtime", async (original) => ({
  ...(await original<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ client: { request: calls.request }, actions: { answerDialog: calls.answerDialog, send: calls.send } }),
}));
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useToolCallElapsed: () => undefined,
}));
vi.mock("@/agents/hooks", () => ({ useNamerLabel: () => undefined, useSessionMcpServers: () => [] }));

import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

let root: Root;
let container: HTMLDivElement;
let store: StateStore;

function Runtime({ children }: { children: React.ReactNode }) {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: true, onNew: async () => {} });
  return <LaserStoreProvider store={store}><AssistantRuntimeProvider runtime={runtime}><TooltipProvider>{children}</TooltipProvider></AssistantRuntimeProvider></LaserStoreProvider>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.request.mockReset(); calls.answerDialog.mockReset(); calls.send.mockReset();
  store = createStateStore({ ...initialState, environment: testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"] }) });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it.each([
  testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"] }),
  testDescriptor({ actor: { class: "local_browser", id: "browser" }, localOnly: ["pi/ui/response"] }),
])("keeps an approval readable while replacing its answer footer", async (environment) => {
  store.dispatch({ type: "environment", environment });
  const respond = vi.fn(); const resume = vi.fn();
  await act(async () => root.render(<Runtime><ToolRow toolCallId="approval" toolName="read" args={{ path: "notes.md" }} argsText='{"path":"notes.md"}' status={{ type: "requires-action", reason: "tool-calls" }} approval={{ id: "approval", prompt: "Allow reading notes?" }} addResult={vi.fn()} resume={resume} respondToApproval={respond} /></Runtime>));
  expect(container.textContent).toContain("Allow reading notes?");
  expect(container.textContent).toContain("This decision must be made elsewhere");
  expect(container.textContent).toContain("notes.md");
  expect(container.textContent).not.toContain("Deny");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(respond).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(calls.request).not.toHaveBeenCalled();
});

it("keeps an extension question readable while replacing its answer footer", async () => {
  const resume = vi.fn();
  await act(async () => root.render(<Runtime><ToolRow toolCallId="question" toolName="extension" args={{}} argsText="{}" status={{ type: "requires-action", reason: "interrupt" }} interrupt={{ type: "human", payload: { requestId: "q1", method: "input", title: "Choose a branch", message: "Which branch should continue?" } }} addResult={vi.fn()} resume={resume} respondToApproval={vi.fn()} /></Runtime>));
  expect(container.textContent).toContain("Choose a branch");
  expect(container.textContent).toContain("Which branch should continue?");
  expect(container.textContent).toContain("This question must be answered elsewhere");
  expect(container.querySelector("input,textarea,select")).toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(resume).not.toHaveBeenCalled(); expect(calls.answerDialog).not.toHaveBeenCalled(); expect(calls.request).not.toHaveBeenCalled();
});
