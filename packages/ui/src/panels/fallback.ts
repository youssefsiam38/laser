/**
 * The fallback (docs/ux-panels.md, "The contract", way 4): an extension that
 * knows nothing about piorbit still lands in the panel system.
 *
 *   setWidget(key, lines)  → a `stream` panel keyed by the widget key, text
 *                            encoding, content served client-side (`inline:`)
 *   setStatus(key, text)   → an ambient entry (state, not content)
 *   select/confirm/input/editor → a `decision` panel; blocking scope is
 *                            `tool` when the worker stamped a toolCallId and
 *                            that tool row is on screen, else `turn`
 *
 * Pure, derived from the `SessionView` the app store already holds. The ids
 * are namespaced `ui:` so the provider knows to answer them through
 * `pi/ui/response` rather than `pi/panel/action`.
 */
import type { DecisionField, DecisionPanel, Panel, StreamPanel, UiDialogRequest, UiDialogResponse } from "@lasercode/protocol";
import type { SessionView } from "../store.js";

export const FALLBACK_SOURCE = "extension";
export const WIDGET_ID_PREFIX = "ui:widget:";
export const DIALOG_ID_PREFIX = "ui:dialog:";
export const INLINE_REF_PREFIX = "inline:widget:";

/** Field ids the fallback decision uses; the answer is mapped back by them. */
export const FALLBACK_FIELD = { choice: "choice", confirmed: "confirmed", value: "value", feedback: "feedback" } as const;

export const isFallbackId = (id: string): boolean => id.startsWith("ui:");
export const isFallbackDialogId = (id: string): boolean => id.startsWith(DIALOG_ID_PREFIX);
export const dialogIdOf = (panelId: string): string => panelId.slice(DIALOG_ID_PREFIX.length);

const utf8Length = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
};

export function widgetPanel(key: string, lines: readonly string[], follow: boolean): StreamPanel {
  const text = lines.join("\n");
  return {
    kind: "stream",
    id: `${WIDGET_ID_PREFIX}${key}`,
    source: FALLBACK_SOURCE,
    title: key,
    intent: "follow",
    encoding: "text",
    ref: `${INLINE_REF_PREFIX}${key}`,
    bytes: utf8Length(text),
    follow,
  };
}

/** Client-local content behind an `inline:` ref, or undefined when it is not a widget of this view. */
export function inlineContent(view: SessionView | undefined, ref: string): string | undefined {
  if (!view || !ref.startsWith(INLINE_REF_PREFIX)) return undefined;
  const widget = view.widgets[ref.slice(INLINE_REF_PREFIX.length)];
  return widget ? widget.lines.join("\n") : undefined;
}

export function dialogPanel(dialog: UiDialogRequest, hasToolRow: boolean): DecisionPanel {
  const fields: DecisionField[] = [];
  let rejection: DecisionPanel["rejection"] | undefined;
  switch (dialog.method) {
    case "select":
      fields.push({ id: FALLBACK_FIELD.choice, label: dialog.title, type: "choice", options: [...dialog.options], required: true });
      break;
    case "confirm":
      fields.push({ id: FALLBACK_FIELD.confirmed, label: dialog.title, type: "confirm", required: true });
      // "No" is never a dead end: the note travels to the agent as a follow-up.
      rejection = { label: "No", field: FALLBACK_FIELD.feedback };
      fields.push({ id: FALLBACK_FIELD.feedback, label: "Tell the agent what to do instead", type: "longtext" });
      break;
    case "input":
      fields.push({
        id: FALLBACK_FIELD.value,
        label: dialog.placeholder ?? dialog.title,
        type: "text",
        required: true,
      });
      break;
    case "editor":
      fields.push({
        id: FALLBACK_FIELD.value,
        label: dialog.title,
        type: "longtext",
        ...(dialog.prefill !== undefined ? { default: dialog.prefill } : {}),
        required: true,
      });
      break;
  }
  const tool = dialog.toolCallId !== undefined && hasToolRow;
  return {
    kind: "decision",
    id: `${DIALOG_ID_PREFIX}${dialog.id}`,
    source: FALLBACK_SOURCE,
    title: dialog.title,
    intent: "inspect",
    ...(dialog.method === "confirm" && dialog.message !== undefined ? { message: dialog.message } : {}),
    blocking: tool ? "tool" : "turn",
    ...(tool && dialog.toolCallId !== undefined ? { toolCallId: dialog.toolCallId } : {}),
    fields,
    ...(rejection ? { rejection } : {}),
    ...(dialog.timeoutMs !== undefined ? { timeoutMs: dialog.timeoutMs } : {}),
  };
}

/** The panels a session view implies. Dialogs already rendered in a tool row are left to that row. */
export function fallbackPanels(view: SessionView): Panel[] {
  const panels: Panel[] = [];
  for (const [key, widget] of Object.entries(view.widgets)) panels.push(widgetPanel(key, widget.lines, view.running));
  const toolRows = new Set(view.blocks.filter((b) => b.kind === "tool").map((b) => b.id));
  for (const dialog of view.dialogs) {
    const hasToolRow = dialog.toolCallId !== undefined && toolRows.has(dialog.toolCallId);
    if (hasToolRow) continue;
    panels.push(dialogPanel(dialog, false));
  }
  return panels;
}

/** One ambient entry per `setStatus` key. */
export function ambientStatuses(view: SessionView | undefined): Array<{ key: string; text: string }> {
  if (!view) return [];
  return Object.entries(view.statuses).map(([key, text]) => ({ key, text }));
}

/**
 * Turn a decision answer into the `pi/ui/response` the worker's UI bridge
 * expects. `values` are keyed by field id; a cancel carries none.
 */
export function uiResponseFor(
  dialogId: string,
  method: UiDialogRequest["method"],
  values: Readonly<Record<string, string | boolean>> | undefined,
): UiDialogResponse {
  if (values === undefined) return { id: dialogId, cancelled: true };
  switch (method) {
    case "confirm":
      return { id: dialogId, confirmed: values[FALLBACK_FIELD.confirmed] === true };
    case "select": {
      const choice = values[FALLBACK_FIELD.choice];
      return typeof choice === "string" ? { id: dialogId, value: choice } : { id: dialogId, cancelled: true };
    }
    case "input":
    case "editor": {
      const value = values[FALLBACK_FIELD.value];
      return typeof value === "string" ? { id: dialogId, value } : { id: dialogId, cancelled: true };
    }
  }
}
