/** Provider-neutral views over captured JSON. No reconstruction or dropped fields. */
export interface RequestField { path: string; value: unknown }
export interface RequestView {
  instructions: RequestField[];
  conversation: RequestField[];
  tools: RequestField[];
  parameters: RequestField[];
  model?: string;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const INSTRUCTIONS = new Set(["system", "instructions", "systemInstruction", "system_instruction", "systemPrompt"]);
const MESSAGES = new Set(["messages", "input", "contents", "prompt", "conversation"]);
const TOOLS = new Set(["tools", "functions", "toolConfig", "tool_config", "functionDeclarations"]);

/**
 * Anthropic's mid-conversation effort protocol: the engine puts a `system`
 * message with no content and an `output_config.effort` into `messages[]`
 * before each assistant turn whose effort is known, and one at the end for the
 * current turn. It is a setting, not an instruction — listing it under
 * Instructions read as a duplicated empty system prompt.
 */
const isEffortMarker = (message: Record<string, unknown>): boolean => {
  const content = message.content;
  const empty = content === undefined || content === "" || (Array.isArray(content) && content.length === 0);
  return (message.role === "system" || message.role === "developer") && empty && record(message.output_config) !== undefined;
};

export function inspectRequest(payload: unknown): RequestView {
  const view: RequestView = { instructions: [], conversation: [], tools: [], parameters: [] };
  const visit = (value: unknown, prefix = "") => {
    const object = record(value);
    if (!object) { view.parameters.push({ path: prefix || "$", value }); return; }
    for (const [key, child] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (key === "model" && typeof child === "string") view.model = child;
      // SDK envelopes (including Gemini's config) are presentation paths only;
      // Full JSON below is always the untouched captured object.
      if (["body", "request", "config"].includes(key) && record(child)) { visit(child, path); continue; }
      if (INSTRUCTIONS.has(key)) view.instructions.push({ path, value: child });
      else if (MESSAGES.has(key)) {
        if (Array.isArray(child)) child.forEach((message, index) => {
          const object = record(message);
          const role = object?.role;
          const field = { path: `${path}[${index}]`, value: message };
          if (object && isEffortMarker(object)) view.parameters.push(field);
          else (role === "system" || role === "developer" ? view.instructions : view.conversation).push(field);
        });
        else view.conversation.push({ path, value: child });
      } else if (TOOLS.has(key)) {
        if (Array.isArray(child)) child.forEach((tool, index) => view.tools.push({path:`${path}[${index}]`,value:tool}));
        else view.tools.push({path,value:child});
      } else view.parameters.push({ path, value: child });
    }
  };
  visit(payload);
  return view;
}

export function requestFieldLabel(field: RequestField): string {
  const object = record(field.value);
  if (object && isEffortMarker(object)) {
    const effort = record(object.output_config)?.effort;
    return typeof effort === "string" ? `effort · ${effort}` : "effort";
  }
  const fn = record(object?.function) ?? record(object?.toolSpec);
  const label = object?.role ?? object?.name ?? fn?.name ?? object?.type;
  return typeof label === "string" ? label : field.path;
}

export function requestFieldText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts = value.map(requestFieldText).filter((text): text is string => text !== undefined);
    return texts.length ? texts.join("\n\n") : undefined;
  }
  const object = record(value);
  if (typeof object?.text === "string") return object.text;
  const content = object?.content ?? object?.parts;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => requestFieldText(part)).filter((part): part is string => part !== undefined);
    return text.length ? text.join("\n\n") : undefined;
  }
  return undefined;
}
