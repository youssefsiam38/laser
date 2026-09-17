/**
 * Activity labels (D-277). The agent says what each tool call is doing, in
 * the call itself: every tool the engine offers carries an optional `label`
 * parameter, a short present-progressive phrase ("Reading build config"),
 * and the activity row shows it while the call runs. The tool never sees the
 * parameter — the worker strips it before execution — and nothing else
 * treats it as an argument: the args disclosure hides it, search skips it,
 * provenance never records it.
 *
 * Three tools carry no label. `start_agent` already names its work
 * (`subagent_name`, which the row shows instead); `complete_agent_run` and
 * `inspect_fleet` describe nothing but themselves.
 *
 * Namer no longer labels activity; it names new sessions only.
 */

/** The parameter name every labelled tool gains. */
export const TOOL_LABEL_PARAM = "label";
/** The most characters a label may have; longer text is cut, never refused. */
export const TOOL_LABEL_MAX = 25;
/** Tools that are not given a `label` parameter. */
export const TOOL_LABEL_EXEMPT: readonly string[] = ["start_agent", "complete_agent_run", "inspect_fleet"];
/** What the model reads beside the parameter. */
export const TOOL_LABEL_DESCRIPTION =
  `What this call is doing, for the person watching: a present-progressive phrase of at most ${TOOL_LABEL_MAX} characters, like "Reading build config" or "Running unit tests". Always provide it.`;

export function isToolLabelExempt(toolName: string): boolean {
  return TOOL_LABEL_EXEMPT.includes(toolName);
}

/** Cut to the limit at a word boundary when one is near, trimmed, never empty. */
export function clampToolLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!text) return undefined;
  if (text.length <= TOOL_LABEL_MAX) return text;
  const cut = text.slice(0, TOOL_LABEL_MAX);
  const space = cut.lastIndexOf(" ");
  return (space >= TOOL_LABEL_MAX - 8 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The label a tool call carries, read from its arguments: `label` for a
 * labelled tool, `subagent_name` for `start_agent`, nothing otherwise.
 */
export function toolCallLabel(toolName: string, args: unknown): string | undefined {
  const fields = record(args);
  if (toolName === "start_agent") return clampToolLabel(fields["subagent_name"]);
  if (isToolLabelExempt(toolName)) return undefined;
  return clampToolLabel(fields[TOOL_LABEL_PARAM]);
}

/** The same arguments without the label: what the tool ran with. */
export function withoutToolLabel<T>(args: T): T {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  if (!Object.hasOwn(args as object, TOOL_LABEL_PARAM)) return args;
  const { [TOOL_LABEL_PARAM]: _label, ...rest } = args as Record<string, unknown>;
  return rest as T;
}
