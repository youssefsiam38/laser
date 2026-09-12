// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { MESSAGE_METADATA_NS } from "@lasercode/protocol";
import { MessageTiming } from "../../src/components/assistant-ui/elements/message-timing.aui.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { projectMessages } from "../../src/runtime/projection.js";

it("reads persisted projected usage and stamped elapsed without a live clock", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { messages } = projectMessages({ running: false, dialogs: [], blocks: [
    { id: "saved", kind: "assistant", text: "Saved reply", thinking: "", streaming: false, usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140 } },
  ] });
  const message = messages[0]!;
  message.metadata = { custom: { [MESSAGE_METADATA_NS]: {
    ...message.metadata?.custom?.[MESSAGE_METADATA_NS] as object,
    timing: { elapsedMs: 2_000 },
  } } };
  function Fixture() {
    const runtime = useExternalStoreRuntime({ messages, isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><ThreadPrimitive.Messages components={{ AssistantMessage: MessageTiming }} /></TooltipProvider></AssistantRuntimeProvider>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Fixture />));
    expect(container.textContent).toBe("2.0s · 40 tokens · 20.0 tok/s");
    expect(container.querySelector('[data-slot="message-timing"]')?.getAttribute("aria-label")).toContain("Input 100");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
