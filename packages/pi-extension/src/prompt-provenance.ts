/**
 * Read-only provenance observer for Pi's public ResourceLoader extension seam.
 * No files are reread and no instructions are injected. The small assembly
 * adapter below is pinned to Pi 0.85's system-prompt format and verifies its
 * entire resource suffix before attributing it. An engine-format change fails
 * closed, rather than assigning somebody else's words to an AGENTS.md file.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { formatSkillsForPrompt, type BeforeAgentStartEvent, type BeforeProviderRequestEvent, type ExtensionContext, type LoadExtensionsResult, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { InstructionSource, InstructionSourceMap, InstructionSourceSpan } from "@lasercode/protocol";

type Trace = { text: string; spans: InstructionSourceSpan[] };
type Sources = Pick<ResourceLoader, "getSystemPromptSource" | "getAppendSystemPrompt" | "getAppendSystemPromptSources">;
type Capture = (event: BeforeProviderRequestEvent, ctx: ExtensionContext, sources: InstructionSourceMap[]) => void;
const agent: InstructionSource = { kind: "agent", label: "Agent instructions and tool guidance" };
const unknown: InstructionSource = { kind: "unrecorded", label: "Source not recorded" };
const whole = (text: string, source: InstructionSource): Trace => ({ text, spans: text ? [{ start: 0, end: text.length, source }] : [] });

export function recordBasePrompt(event: BeforeAgentStartEvent, loader?: Sources): Trace {
  const options = event.systemPromptOptions;
  const parts: Array<{ text: string; source: InstructionSource }> = [];
  const append = (text: string, source: InstructionSource) => { if (text) parts.push({ text, source }); };
  if (options.appendSystemPrompt) {
    append("\n\n", agent);
    const values = loader?.getAppendSystemPrompt();
    const paths = loader?.getAppendSystemPromptSources();
    if (values?.join("\n\n") === options.appendSystemPrompt) {
      values.forEach((value, index) => {
        if (index) append("\n\n", agent);
        // Pi's source list omits inline inputs; unequal lengths cannot be zipped.
        const path = paths?.length === values.length ? paths[index]?.path : undefined;
        append(value, { kind: path ? "file" : "agent", label: path ? basename(path) : "Additional instructions", ...(path ? { path } : {}) });
      });
    } else append(options.appendSystemPrompt, { kind: "agent", label: "Additional instructions" });
  }
  if (options.contextFiles?.length) {
    append("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n", agent);
    for (const file of options.contextFiles) {
      append(`<project_instructions path="${file.path}">\n`, agent);
      append(file.content, { kind: "file", label: basename(file.path), path: file.path });
      append("\n</project_instructions>\n\n", agent);
    }
    append("</project_context>\n", agent);
  }
  const readTool = ["read", "bash"].find(tool => (options.selectedTools ?? ["read", "bash", "edit", "write"]).includes(tool));
  if (readTool && options.skills?.length) {
    const catalog = formatSkillsForPrompt(options.skills, readTool as "read" | "bash");
    // The engine's formatter owns XML escaping and disabled-skill filtering.
    let cursor = 0;
    for (const skill of options.skills.filter(skill => !skill.disableModelInvocation)) {
      const formatted = formatSkillsForPrompt([skill], readTool as "read" | "bash");
      const start = formatted.indexOf("  <skill>");
      const block = formatted.slice(start, formatted.lastIndexOf("\n</available_skills>"));
      const at = catalog.indexOf(block, cursor);
      if (start < 0 || at < cursor) return whole(event.systemPrompt, unknown);
      append(catalog.slice(cursor, at), { kind: "agent", label: "Skill discovery instructions" });
      append(block, { kind: "skill", label: skill.name, path: skill.filePath });
      cursor = at + block.length;
    }
    append(catalog.slice(cursor), { kind: "agent", label: "Skill discovery instructions" });
  }
  append(`\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}${options.customPrompt ? "\n" : ""}`, { kind: "environment", label: "Session environment" });
  const suffix = parts.map(part => part.text).join("");
  if (!event.systemPrompt.endsWith(suffix)) return whole(event.systemPrompt, unknown);
  const prefix = event.systemPrompt.slice(0, event.systemPrompt.length - suffix.length);
  if (options.customPrompt && prefix !== options.customPrompt) return whole(event.systemPrompt, unknown);
  const path = loader?.getSystemPromptSource()?.path;
  const source: InstructionSource = options.customPrompt
    ? { kind: path ? "file" : "agent", label: path ? basename(path) : "Custom agent instructions", ...(path ? { path } : {}) } : agent;
  const trace = whole(prefix, source);
  for (const part of parts) {
    trace.spans.push({ start: trace.text.length, end: trace.text.length + part.text.length, source: part.source });
    trace.text += part.text;
  }
  return trace;
}

/** Preserve unchanged boundaries; the returned replacement interval belongs to
 * the observed writer. Never infer an extension's identity from its wording. */
export function recordPromptChange(before: Trace, text: string, source: InstructionSource): Trace {
  if (before.text === text) return before;
  let start = 0;
  while (start < Math.min(before.text.length, text.length) && before.text[start] === text[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]!) && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
  let suffix = 0;
  while (suffix < Math.min(before.text.length, text.length) - start && before.text[before.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - suffix]!) && /[\uD800-\uDBFF]/.test(text[text.length - suffix - 1] ?? "")) suffix--;
  const spans = sliceSpans(before.spans, 0, start);
  if (text.length - suffix > start) spans.push({ start, end: text.length - suffix, source });
  spans.push(...sliceSpans(before.spans, before.text.length - suffix, before.text.length).map(span => ({ ...span, start: span.start + text.length - suffix, end: span.end + text.length - suffix })));
  return { text, spans };
}

function sliceSpans(spans: InstructionSourceSpan[], start: number, end: number): InstructionSourceSpan[] {
  return spans.filter(span => span.start < end && span.end > start).map(span => ({ ...span, start: Math.max(start, span.start) - start, end: Math.min(end, span.end) - start }));
}

/** Only instruction-bearing fields qualify, never a matching user quotation. */
export function instructionLeaves(payload: unknown): Array<{ path: Array<string | number>; text: string }> {
  const leaves: Array<{ path: Array<string | number>; text: string }> = [];
  const visit = (value: unknown, path: Array<string | number>, instruction = false) => {
    if (typeof value === "string") { if (instruction) leaves.push({ path, text: value }); return; }
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, [...path, i], instruction)); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    const system = object.role === "system" || object.role === "developer";
    for (const [key, child] of Object.entries(object)) {
      const isInstruction = ["system", "instructions", "systemInstruction", "system_instruction", "systemPrompt"].includes(key);
      if (isInstruction || ["body", "request", "config", "messages", "input", "contents", "conversation"].includes(key) || ((instruction || system) && ["text", "content", "parts"].includes(key))) {
        visit(child, [...path, key], isInstruction || ((instruction || system) && ["text", "content", "parts"].includes(key)));
      }
    }
  };
  visit(payload, []);
  return leaves;
}

function projectInstruction(text: string, trace: Trace): Trace {
  if (text === trace.text) return trace;
  // Providers can add preambles or split the system prompt into text blocks.
  const at = trace.text ? text.indexOf(trace.text) : -1;
  if (at >= 0 && text.indexOf(trace.text, at + 1) < 0) {
    const result = whole(text, { kind: "agent", label: "Provider adapter instructions" });
    result.spans = [...sliceSpans(result.spans, 0, at), ...trace.spans.map(span => ({ ...span, start: span.start + at, end: span.end + at })), ...sliceSpans(result.spans, at + trace.text.length, text.length).map(span => ({ ...span, start: span.start + at + trace.text.length, end: span.end + at + trace.text.length }))];
    return result;
  }
  const offset = text ? trace.text.indexOf(text) : -1;
  return offset >= 0 && trace.text.indexOf(text, offset + 1) < 0
    ? { text, spans: sliceSpans(trace.spans, offset, offset + text.length) } : whole(text, unknown);
}

export function createPromptProvenanceObserver() {
  let trace = whole("", unknown);
  let loader: Sources | undefined;
  let capture: Capture | undefined;
  const instrumented = new WeakSet<object>();
  return {
    setResourceLoader(value: Sources) { loader = value; },
    onRequest(listener: Capture) { capture = listener; },
    extensionsOverride(result: LoadExtensionsResult): LoadExtensionsResult {
      const last = result.extensions.at(-1);
      if (!last || instrumented.has(result)) return result;
      instrumented.add(result);
      // Run after all session_start registrations, including companion modules.
      const starts = last.handlers.get("session_start") ?? [];
      let installed = false;
      starts.push(async () => {
        if (installed) return;
        installed = true;
        for (const ext of result.extensions) {
          const source: InstructionSource = { kind: "extension", label: "Extension modification", path: ext.resolvedPath || ext.path };
          const handlers = ext.handlers.get("before_agent_start") ?? [];
          ext.handlers.set("before_agent_start", handlers.map(handler => async (...args: unknown[]) => {
            const event = args[0] as BeforeAgentStartEvent;
            if (trace.text !== event.systemPrompt) trace = whole(event.systemPrompt, unknown);
            const returned = await handler(...args);
            const changed = (returned as { systemPrompt?: unknown } | undefined)?.systemPrompt;
            if (typeof changed === "string") trace = recordPromptChange(trace, changed, source);
            return returned;
          }));
        }
        const first = result.extensions[0]!;
        first.handlers.get("before_agent_start")!.unshift(async (...args: unknown[]) => {
          trace = whole((args[0] as BeforeAgentStartEvent).systemPrompt, unknown);
          trace = recordBasePrompt(args[0] as BeforeAgentStartEvent, loader);
        });
        let requestTraces = new Map<string, Trace>();
        for (const ext of result.extensions) {
          const handlers = ext.handlers.get("before_provider_request") ?? [];
          ext.handlers.set("before_provider_request", handlers.map(handler => async (...args: unknown[]) => {
            const returned = await handler(...args);
            const payload = returned === undefined ? (args[0] as BeforeProviderRequestEvent).payload : returned;
            const source: InstructionSource = { kind: "extension", label: "Request modification", path: ext.resolvedPath || ext.path };
            requestTraces = new Map(instructionLeaves(payload).map(leaf => {
              const key = JSON.stringify(leaf.path);
              return [key, recordPromptChange(requestTraces.get(key) ?? whole("", unknown), leaf.text, source)];
            }));
            return returned;
          }));
        }
        first.handlers.get("before_provider_request")!.unshift(async (...args: unknown[]) => {
          const ctx = args[1] as ExtensionContext;
          const prompt = ctx.getSystemPrompt();
          // Covers tool-loop rebuilds, resumed turns and direct prompt overrides.
          const current = trace.text === prompt ? trace : whole(prompt, unknown);
          requestTraces = new Map(instructionLeaves((args[0] as BeforeProviderRequestEvent).payload).map(leaf => [JSON.stringify(leaf.path), projectInstruction(leaf.text, current)]));
        });
        last.handlers.get("before_provider_request")!.push(async (...args: unknown[]) => {
          const event = args[0] as BeforeProviderRequestEvent;
          const sources = instructionLeaves(event.payload).map(leaf => {
            const value = requestTraces.get(JSON.stringify(leaf.path));
            return { path: leaf.path, sha256: createHash("sha256").update(leaf.text).digest("hex"), spans: value?.text === leaf.text ? value.spans : whole(leaf.text, unknown).spans };
          });
          capture?.(event, args[1] as ExtensionContext, sources);
        });
      });
      last.handlers.set("session_start", starts);
      return result;
    },
  };
}
export type PromptProvenanceObserver = ReturnType<typeof createPromptProvenanceObserver>;
