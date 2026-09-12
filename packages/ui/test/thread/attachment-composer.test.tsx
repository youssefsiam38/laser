import type { ThreadMessageLike } from "@assistant-ui/react";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type AssistantRuntime } from "@assistant-ui/react";
import { ComposerAttachmentTile } from "../../src/components/assistant-ui/elements/composer.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ConversationAttachmentAdapter } from "../../src/runtime/attachments.js";

it("stages a real text file as a named tile and removes it without sending", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let runtime!: AssistantRuntime;
  function Fixture() {
    runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages: [], onNew: async () => {}, adapters: { attachments: new ConversationAttachmentAdapter() } });
    return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><ComposerPrimitive.Root><ComposerPrimitive.Attachments>{() => <ComposerAttachmentTile />}</ComposerPrimitive.Attachments></ComposerPrimitive.Root></TooltipProvider></AssistantRuntimeProvider>;
  }
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => runtime.thread.composer.addAttachment(new File(["# Notes"], "notes.md", { type: "text/markdown" })));
    const tile = container.querySelector('[data-slot="composer-attachment"]')!;
    expect(tile.textContent).toContain("notes.md");
    expect(tile.querySelector("img")).toBeNull();
    expect(runtime.thread.composer.getState().attachments).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!.click());
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
    expect(container.querySelector('[data-slot="composer-attachment"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
