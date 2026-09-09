/**
 * Questions an extension asks the person (`pi/ui/request`).
 *
 * Pi hands every extension its own `ctx.ui`, so the only place that sees all of
 * them is the worker's UI bridge; the client derives the form from the
 * `pi/ui/*` stream it already receives. Four methods, one form:
 *
 *   select   → one choice
 *   confirm  → yes / no, with a reason field behind "No"
 *   input    → one line
 *   editor   → many lines
 *
 * This is a UI-owned model, not a wire type. It used to be the panel contract's
 * `decision` payload; when the panels came out the *shape* of a question
 * stayed, because a question is not a panel — it is a thing blocking on you.
 *
 * Invariant 6 is absolute: anything not answerable cancels safely and never
 * hangs. {@link cancelResponse} is the answer for a dialog whose method we
 * cannot render at all.
 */
import type { UiDialogRequest, UiDialogResponse } from "@lasercode/protocol";

export type DialogFieldType = "choice" | "text" | "longtext" | "confirm";

export interface DialogField {
  id: string;
  label: string;
  type: DialogFieldType;
  options?: string[];
  default?: string;
  required?: boolean;
}

/** What the question blocks while it is open. Decides where it is drawn. */
export type DialogBlocking = "tool" | "turn";

export interface DialogForm {
  /** The dialog id the answer travels back with. */
  id: string;
  method: UiDialogRequest["method"];
  /** Who is asking. Always shown, so a question is never anonymous. */
  source: string;
  title: string;
  message?: string;
  blocking: DialogBlocking;
  /** Renders inside that tool's row, when the row is on screen. */
  toolCallId?: string;
  fields: DialogField[];
  /** "No" is never a dead end: declining opens this field. */
  rejection?: { label: string; field: string };
  timeoutMs?: number;
}

export const DIALOG_SOURCE = "extension";

/** Field ids the form uses; the answer is mapped back by them. */
export const DIALOG_FIELD = { choice: "choice", confirmed: "confirmed", value: "value", feedback: "feedback" } as const;

/** Every method we can draw. Anything else is cancelled rather than shown. */
const RENDERABLE: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

export function isRenderableDialog(request: Pick<UiDialogRequest, "method">): boolean {
  return RENDERABLE.has(request.method);
}

/**
 * The form for one request. `hasToolRow` says whether the tool call it named
 * is actually on screen — "inline, in its tool row" is only correct when there
 * is a row, and a question with nowhere to live must not disappear.
 */
export function dialogFormOf(dialog: UiDialogRequest, hasToolRow: boolean): DialogForm {
  const fields: DialogField[] = [];
  let rejection: DialogForm["rejection"] | undefined;
  switch (dialog.method) {
    case "select":
      fields.push({ id: DIALOG_FIELD.choice, label: dialog.title, type: "choice", options: [...dialog.options], required: true });
      break;
    case "confirm":
      fields.push({ id: DIALOG_FIELD.confirmed, label: dialog.title, type: "confirm", required: true });
      // "No" is never a dead end: the note travels to the agent as a follow-up.
      rejection = { label: "No", field: DIALOG_FIELD.feedback };
      fields.push({ id: DIALOG_FIELD.feedback, label: "Tell the agent what to do instead", type: "longtext" });
      break;
    case "input":
      fields.push({ id: DIALOG_FIELD.value, label: dialog.placeholder ?? dialog.title, type: "text", required: true });
      break;
    case "editor":
      fields.push({
        id: DIALOG_FIELD.value,
        label: dialog.title,
        type: "longtext",
        ...(dialog.prefill !== undefined ? { default: dialog.prefill } : {}),
        required: true,
      });
      break;
  }
  const tool = dialog.toolCallId !== undefined && hasToolRow;
  return {
    id: dialog.id,
    method: dialog.method,
    source: DIALOG_SOURCE,
    title: dialog.title,
    ...(dialog.method === "confirm" && dialog.message !== undefined ? { message: dialog.message } : {}),
    blocking: tool ? "tool" : "turn",
    ...(tool && dialog.toolCallId !== undefined ? { toolCallId: dialog.toolCallId } : {}),
    fields,
    ...(rejection ? { rejection } : {}),
    ...(dialog.timeoutMs !== undefined ? { timeoutMs: dialog.timeoutMs } : {}),
  };
}

/**
 * Turn an answer into the `pi/ui/response` the worker's UI bridge expects.
 * `values` are keyed by field id; a cancel carries none.
 */
export function uiResponseFor(
  dialogId: string,
  method: UiDialogRequest["method"],
  values: Readonly<Record<string, string | boolean>> | undefined,
): UiDialogResponse {
  if (values === undefined) return cancelResponse(dialogId);
  switch (method) {
    case "confirm":
      return { id: dialogId, confirmed: values[DIALOG_FIELD.confirmed] === true };
    case "select": {
      const choice = values[DIALOG_FIELD.choice];
      return typeof choice === "string" ? { id: dialogId, value: choice } : cancelResponse(dialogId);
    }
    case "input":
    case "editor": {
      const value = values[DIALOG_FIELD.value];
      return typeof value === "string" ? { id: dialogId, value } : cancelResponse(dialogId);
    }
  }
}

/** The safe answer. Never a hang (AGENTS.md invariant 6). */
export function cancelResponse(dialogId: string): UiDialogResponse {
  return { id: dialogId, cancelled: true };
}

/**
 * "Always allow", "Allow for this session", "Don't ask again": choosing one
 * changes the session's behaviour from now on, so the control says so under
 * the label instead of letting it look like a one-off (M7-T4).
 */
export function isModeChangingOption(option: string): boolean {
  return /\b(always|all(ow)? (for )?(this )?session|for this session|every time|don'?t ask|never ask|remember|from now on|auto[- ]?approve)\b/i.test(
    option,
  );
}

/** What the question is holding up, in words. */
export function blockingWords(blocking: DialogBlocking): string {
  return blocking === "tool" ? "blocks one tool" : "blocks this turn";
}

/** One line for a minimal surface: the question, truncated by the renderer. */
export function dialogSummary(title: string): string {
  return title.replace(/\s+/g, " ").trim() || "Needs you";
}
