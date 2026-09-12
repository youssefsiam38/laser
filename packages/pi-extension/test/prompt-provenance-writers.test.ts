import { expect, it, vi } from "vitest";
import { INSTRUCTION_APP_ORIGIN, PRODUCT_DISPLAY_NAME, WIRE_NAMESPACE } from "@lasercode/protocol";
import type { BeforeAgentStartEvent, Extension, ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { createPromptProvenanceObserver, recordInstructionWrite } from "../src/prompt-provenance.js";
const { buildSystemPrompt } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href);

it("attributes inline writes by explicit identity, third-party writes by package directory, and unobserved overrides honestly", async () => {
  const observer = createPromptProvenanceObserver();
  const capture = vi.fn(); observer.onRequest(capture);
  const extension = (path: string, handler: (event: BeforeAgentStartEvent) => unknown, baseDir?: string) => ({ path, resolvedPath: path, sourceInfo: { baseDir }, handlers: new Map([["before_agent_start", [handler]]]) }) as unknown as Extension;
  const template = extension(`<inline:${WIRE_NAMESPACE}/instruction-template>`, () => recordInstructionWrite({ systemPrompt: "You are coordinator.\nTool instructions." }, [
    { start: 0, end: 21, source: { kind: "agent", origin: "agent", label: "Agent · coordinator", inline: true } },
    { start: 21, end: 39, source: { kind: "variable", origin: "variable", label: "Variable · Tool guidance", inline: true } },
  ]));
  const role = extension(`<inline:${WIRE_NAMESPACE}>`, event => recordInstructionWrite({ systemPrompt: event.systemPrompt + "\nRole block." }, { kind: INSTRUCTION_APP_ORIGIN, origin: INSTRUCTION_APP_ORIGIN, label: `${PRODUCT_DISPLAY_NAME} · Agent role`, inline: true }));
  const external = extension("/packages/reviewer/src/index.ts", event => ({ systemPrompt: event.systemPrompt + "\nReview carefully." }), "/packages/reviewer");
  const extensions = [template, role, external];
  observer.extensionsOverride({ extensions } as LoadExtensionsResult);
  for (const handler of external.handlers.get("session_start") ?? []) await handler();
  const systemPromptOptions = { cwd: "/project", customPrompt: "Base rules" };
  let event = { type: "before_agent_start", prompt: "hello", systemPromptOptions, systemPrompt: buildSystemPrompt(systemPromptOptions) } as BeforeAgentStartEvent;
  for (const extension of extensions) for (const handler of extension.handlers.get("before_agent_start") ?? []) {
    const result = await handler(event, {});
    if (result && typeof result === "object" && "systemPrompt" in result) event = { ...event, systemPrompt: result.systemPrompt as string };
  }
  const request = async (text: string) => {
    const payload = { instructions: text };
    for (const extension of extensions) for (const handler of extension.handlers.get("before_provider_request") ?? []) await handler({ type: "before_provider_request", payload }, { getSystemPrompt: () => text } as ExtensionContext);
    return capture.mock.calls.at(-1)![2][0];
  };
  const map = await request(event.systemPrompt);
  expect(map.spans.map((span: { source: { label: string } }) => span.source.label)).toEqual(["Agent · coordinator", "Variable · Tool guidance", `${PRODUCT_DISPLAY_NAME} · Agent role`, "reviewer"]);
  expect(map.spans.map((span: { start: number; end: number }) => event.systemPrompt.slice(span.start, span.end)).join("")).toBe(event.systemPrompt);
  expect(map.spans.every((span: { source: { origin?: string } }) => span.source.origin)).toBe(true);
  const override = await request("Unobserved direct override");
  expect(override.spans[0].source).toMatchObject({ origin: "unrecorded", label: "Not recorded" });
  expect(override.spans[0].source.detail).toContain("could not observe");
});
