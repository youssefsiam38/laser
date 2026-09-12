// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolsSection } from "../../src/components/shell/TelemetryPanel.js";

const mocks = vi.hoisted(() => ({ loadAllEntries: vi.fn(async () => true) }));
vi.mock("../../src/runtime/index.js", () => ({
  useLaserView: () => ({ history: { complete: false, branchesUnloaded: false } }),
  useLaserStable: () => ({ actions: mocks }),
}));
vi.mock("../../src/components/shell/shell-context.js", async () => {
  const { useState } = await import("react");
  return { useShell: () => { const [toolsOpen, setToolsOpen] = useState(false); return { toolsOpen, setToolsOpen }; } };
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.loadAllEntries.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("opens loaded tool activity without downloading the rest of the transcript", async () => {
  function Fixture() {
    const messages: ThreadMessageLike[] = [{ id: "tool", role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "bash", args: { command: "echo loaded" }, argsText: '{"command":"echo loaded"}', result: "loaded" }] }];
    const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><ToolsSection /></AssistantRuntimeProvider>;
  }
  await act(async () => root.render(<Fixture />));
  const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  await act(async () => disclosure.click());
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("echo loaded");
  expect(mocks.loadAllEntries).not.toHaveBeenCalled();
});
