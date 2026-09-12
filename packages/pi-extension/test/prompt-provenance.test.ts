import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { BeforeAgentStartEvent, Extension, ExtensionContext, LoadExtensionsResult, Skill } from "@earendil-works/pi-coding-agent";
import { createPromptProvenanceObserver, instructionLeaves, recordBasePrompt, recordPromptChange, recordInstructionWrite } from "../src/prompt-provenance.js";

// Test against the pinned engine's actual builder, never a duplicate fixture.
const { buildSystemPrompt } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href);
const options = {
  cwd: "/project", selectedTools: ["read", "bash"],
  contextFiles: [{ path: "/AGENTS.md", content: "Root rule." }, { path: "/project/AGENTS.md", content: "Project rule 🟢." }],
  appendSystemPrompt: "Additional rule.",
  skills: [{ name: "testing", description: "Use tests <always>", filePath: "/skills/testing/SKILL.md", disableModelInvocation: false },
    { name: "hidden", description: "not exposed", filePath: "/skills/hidden/SKILL.md", disableModelInvocation: true }] as Skill[],
};
const event = (systemPromptOptions = options): BeforeAgentStartEvent => ({ type: "before_agent_start", prompt: "hello", systemPromptOptions, systemPrompt: buildSystemPrompt(systemPromptOptions) });

it.each([undefined, "Custom instructions."])("maps the exact engine-built base and files, custom=%s", customPrompt => {
  const input = event({ ...options, ...(customPrompt ? { customPrompt } : {}) });
  const trace = recordBasePrompt(input);
  expect(trace.spans.map(span => trace.text.slice(span.start, span.end)).join("")).toBe(input.systemPrompt);
  expect(trace.spans.filter(span => span.source.kind === "file").map(span => trace.text.slice(span.start, span.end))).toEqual(["Root rule.", "Project rule 🟢."]);
  expect(trace.spans.filter(span => span.source.kind === "skill").map(span => span.source.path)).toEqual(["/skills/testing/SKILL.md"]);
  expect(trace.spans.some(span => span.source.kind === "unrecorded")).toBe(false);
});

it("records loaded SYSTEM/APPEND sources and rejects an engine format drift", () => {
  const input = event({ ...options, customPrompt: "custom" } as typeof options);
  const loader = { getSystemPromptSource: () => ({ path: "/agent/SYSTEM.md" }), getAppendSystemPrompt: () => [options.appendSystemPrompt], getAppendSystemPromptSources: () => [{ path: "/agent/APPEND_SYSTEM.md" }] };
  expect(recordBasePrompt(input, loader).spans[0]?.source.path).toBe("/agent/SYSTEM.md");
  expect(recordBasePrompt(input, loader).spans.some(span => span.source.path === "/agent/APPEND_SYSTEM.md")).toBe(true);
  expect(recordBasePrompt({ ...input, systemPrompt: input.systemPrompt + "unexpected" }).spans[0]?.source.kind).toBe("unrecorded");
});

it("preserves unchanged boundaries and records edits, deletion, append and replacement", () => {
  const source = { kind: "extension" as const, label: "feature", path: "/feature.ts" };
  const initial = recordBasePrompt(event());
  const added = recordPromptChange(initial, initial.text + "\nFeature rule", source);
  expect(added.spans.at(-1)?.source).toEqual(source);
  expect(added.spans.slice(0, -1)).toEqual(initial.spans);
  expect(recordPromptChange(added, initial.text, source).spans).toEqual(initial.spans);
  const changed = recordPromptChange(initial, initial.text.replace("Root rule.", "Changed rule."), source);
  expect(changed.spans.filter(span => span.source.path === "/AGENTS.md").map(span => changed.text.slice(span.start, span.end)).join("")).not.toContain("Changed");
  expect(recordPromptChange(initial, "entirely replaced", source).spans[0]?.source).toEqual(source);
  const unicode = recordPromptChange({text:"🟢",spans:[{start:0,end:2,source}]},"🔵",source);
  expect(unicode.spans).toEqual([{start:0,end:2,source}]);
});

it("does not zip a filtered file-source list onto mixed inline/file additions", () => {
  const input = event({ ...options, appendSystemPrompt: "inline\n\nfile body" });
  const trace = recordBasePrompt(input, { getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => ["inline", "file body"], getAppendSystemPromptSources: () => [{ path: "/agent/APPEND_SYSTEM.md" }] });
  expect(trace.spans.find(span => trace.text.slice(span.start, span.end) === "inline")?.source.path).toBeUndefined();
});

it("only visits instruction fields for provider formats, not user quotations or tool descriptions", () => {
  expect(instructionLeaves({ messages: [{ role: "system", content: "rules" }, { role: "user", content: "rules" }], tools: [{ instructions: "tool" }] })).toEqual([{ path: ["messages", 0, "content"], text: "rules" }]);
  expect(instructionLeaves({ system: [{ type: "text", text: "rules" }], config: { systemInstruction: { parts: [{ text: "more" }] } } })).toHaveLength(2);
});

it("observes ordered prompt and in-place request changes, captures once at the end, and resets per turn", async () => {
  const observer = createPromptProvenanceObserver();
  const capture = vi.fn(); observer.onRequest(capture);
  const first = { path: "/first.ts", resolvedPath: "/first.ts", handlers: new Map([
    ["before_agent_start", [async (value: unknown) => ({ systemPrompt: (value as BeforeAgentStartEvent).systemPrompt + "\nFeature instruction" })]],
    ["before_provider_request", [async (value: unknown) => { ((value as { payload: { instructions: string } }).payload).instructions += "\nRequest instruction"; }]],
  ]) } as unknown as Extension;
  const last = { path: "/last.ts", resolvedPath: "/last.ts", handlers: new Map() } as unknown as Extension;
  const result = observer.extensionsOverride({ extensions: [first, last] } as LoadExtensionsResult);
  for (const handler of last.handlers.get("session_start")!) await handler();
  // Repeated startup must not duplicate wrappers or capture handlers.
  for (const handler of last.handlers.get("session_start")!) await handler();
  for (let turn = 0; turn < 2; turn++) {
    let current = event();
    for (const ext of result.extensions) for (const handler of ext.handlers.get("before_agent_start") ?? []) {
      const value = await handler(current, {});
      if ((value as { systemPrompt?: string } | undefined)?.systemPrompt) current = { ...current, systemPrompt: (value as { systemPrompt: string }).systemPrompt };
    }
    const payload = { instructions: current.systemPrompt };
    for (const ext of result.extensions) for (const handler of ext.handlers.get("before_provider_request") ?? []) {
      await handler({ type: "before_provider_request", payload }, { getSystemPrompt: () => current.systemPrompt } as ExtensionContext);
    }
    expect(capture).toHaveBeenCalledTimes(turn + 1);
    const map = capture.mock.calls.at(-1)![2][0];
    expect(map.sha256).toBe(createHash("sha256").update(payload.instructions).digest("hex"));
    expect(map.spans.at(-1).source.label).toBe("first.ts");
    expect(map.spans.some((span: { source: { path?: string } }) => span.source.path === "/project/AGENTS.md")).toBe(true);
  }
});
