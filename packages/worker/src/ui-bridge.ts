/**
 * UI bridge — turns Pi's ExtensionUIContext calls into protocol messages.
 *
 * Status: skeleton (M0-T7). Implements the portable surface only (D-2):
 *   dialogs: select, confirm, input, editor  → ui_request, resolved by respond()
 *   fire-and-forget: notify, setStatus, setWidget(string[]), setTitle, setEditorText
 * Everything else must cancel safely (resolve undefined / false / no-op), never hang.
 *
 * Pattern to follow (from @jmfederico/pi-web): build a Proxy over Pi's own
 * no-op UI context so any method we did not override degrades exactly as Pi's
 * RPC mode does. Pi types are used internally only; nothing Pi-typed is exported.
 */

import type { UiDialogRequest, UiDialogResponse, UiFireAndForget } from "@piorbit/protocol";

export interface UiBridgeHandlers {
  onRequest: (request: UiDialogRequest) => void;
  onEvent: (event: UiFireAndForget) => void;
}

export interface UiBridge {
  /** The object to pass as `uiContext` in `session.bindExtensions({ mode: "rpc", uiContext })`. */
  readonly context: unknown;
  respond(response: UiDialogResponse): void;
  /** Number of dialogs waiting for an answer (for reattach: re-emit them). */
  pending(): UiDialogRequest[];
  dispose(): void;
}

interface Pending {
  request: UiDialogRequest;
  resolve: (value: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type UiDialogRequestInput = DistributiveOmit<UiDialogRequest, "id">;

export function createUiBridge(handlers: UiBridgeHandlers): UiBridge {
  const pending = new Map<string, Pending>();
  let counter = 0;

  function ask<T>(request: UiDialogRequestInput, onTimeout: T): Promise<T | undefined> {
    const id = `ui-${++counter}-${Date.now().toString(36)}`;
    const full = { ...request, id } as UiDialogRequest;
    return new Promise<T | undefined>((resolve) => {
      const entry: Pending = { request: full, resolve: resolve as (v: unknown) => void };
      if (full.timeoutMs) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          resolve(onTimeout);
        }, full.timeoutMs);
      }
      pending.set(id, entry);
      handlers.onRequest(full);
    });
  }

  // TODO(M0-T7): wrap Pi's noOp context in a Proxy and override the portable methods below.
  const context = {
    select: (title: string, options: string[], opts?: { timeout?: number }) =>
      ask<undefined>({ method: "select", title, options, ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) }, undefined),
    confirm: (title: string, message?: string, opts?: { timeout?: number }) =>
      ask<false>({ method: "confirm", title, ...(message ? { message } : {}), ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) }, false),
    input: (title: string, placeholder?: string, opts?: { timeout?: number }) =>
      ask<undefined>({ method: "input", title, ...(placeholder ? { placeholder } : {}), ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) }, undefined),
    editor: (title: string, prefill?: string) =>
      ask<undefined>({ method: "editor", title, ...(prefill ? { prefill } : {}) }, undefined),
    notify: (message: string, level: "info" | "warning" | "error" = "info") =>
      handlers.onEvent({ method: "notify", message, level }),
    setStatus: (key: string, text?: string) => handlers.onEvent({ method: "setStatus", key, ...(text !== undefined ? { text } : {}) }),
    setWidget: (key: string, lines?: string[] | unknown, opts?: { placement?: "aboveEditor" | "belowEditor" }) =>
      handlers.onEvent({
        method: "setWidget",
        key,
        ...(Array.isArray(lines) ? { lines: lines as string[] } : {}),
        placement: opts?.placement ?? "aboveEditor",
      }),
    setTitle: (title: string) => handlers.onEvent({ method: "setTitle", title }),
    setEditorText: (text: string) => handlers.onEvent({ method: "setEditorText", text }),
    // Non-portable surface: cancel safely.
    custom: () => undefined,
    getEditorText: () => "",
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }),
    onTerminalInput: () => () => {},
    pasteToEditor: (text: string) => handlers.onEvent({ method: "setEditorText", text }),
  };

  return {
    context,
    respond(response) {
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (entry.timer) clearTimeout(entry.timer);
      if ("cancelled" in response) {
        entry.resolve(entry.request.method === "confirm" ? false : undefined);
      } else if ("confirmed" in response) {
        entry.resolve(response.confirmed);
      } else {
        entry.resolve(response.value);
      }
    },
    pending: () => [...pending.values()].map((p) => p.request),
    dispose() {
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.resolve(p.request.method === "confirm" ? false : undefined);
      }
      pending.clear();
    },
  };
}
