/**
 * UI bridge (M0-T7) — turns Pi's ExtensionUIContext calls into protocol messages.
 *
 * Portable surface only (D-2): select, confirm, input, editor round-trip to the
 * client; notify, setStatus, setWidget(string[]), setTitle, setEditorText are
 * fire-and-forget. Everything else must degrade safely and never hang, which is
 * what Pi's own RPC mode does.
 *
 * Two layers of safety:
 *   1. Explicit implementations for every member we support or must neutralise.
 *   2. A Proxy fallback, so a member Pi adds in a future release returns a
 *      harmless no-op function instead of `undefined` (which would throw inside
 *      the extension and take the turn down).
 */

import type { ExtensionUIContext, UiDialogRequest, UiDialogResponse, UiFireAndForget } from "./ui-types.js";

export interface UiBridgeHandlers {
  onRequest: (request: UiDialogRequest) => void;
  onEvent: (event: UiFireAndForget) => void;
}

export interface UiBridge {
  /** Pass as `uiContext` to `session.bindExtensions({ mode: "rpc", uiContext })`. */
  readonly context: ExtensionUIContext;
  respond(response: UiDialogResponse): void;
  /** Dialogs still waiting for an answer; re-emit these when a client reattaches. */
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

const NOT_AVAILABLE = "UI not available";

export function createUiBridge(handlers: UiBridgeHandlers): UiBridge {
  const pending = new Map<string, Pending>();
  let counter = 0;
  let disposed = false;

  function ask<T>(request: UiDialogRequestInput, onTimeout: T): Promise<T | undefined> {
    if (disposed) return Promise.resolve(onTimeout);
    const id = `ui-${++counter}-${Date.now().toString(36)}`;
    const full = { ...request, id } as UiDialogRequest;
    return new Promise<T | undefined>((resolve) => {
      const entry: Pending = { request: full, resolve: resolve as (v: unknown) => void };
      if (full.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          resolve(onTimeout);
        }, full.timeoutMs);
      }
      pending.set(id, entry);
      handlers.onRequest(full);
    });
  }

  const emit = (event: UiFireAndForget): void => {
    if (!disposed) handlers.onEvent(event);
  };

  /** Members we implement. Anything absent is handled by the Proxy below. */
  const impl: Partial<Record<keyof ExtensionUIContext, unknown>> = {
    // --- dialogs (round-trip) ---
    select: (title: string, options: string[], opts?: { timeout?: number }) =>
      ask<string>(
        { method: "select", title, options, ...(opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {}) },
        undefined as unknown as string,
      ),
    confirm: (title: string, message: string, opts?: { timeout?: number }) =>
      ask<boolean>(
        { method: "confirm", title, message, ...(opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {}) },
        false,
      ).then((v) => v ?? false),
    input: (title: string, placeholder?: string, opts?: { timeout?: number }) =>
      ask<string>(
        {
          method: "input",
          title,
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...(opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
        },
        undefined as unknown as string,
      ),
    editor: (title: string, prefill?: string) =>
      ask<string>(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}) },
        undefined as unknown as string,
      ),

    // --- fire-and-forget ---
    notify: (message: string, type: "info" | "warning" | "error" = "info") =>
      emit({ method: "notify", message, level: type }),
    setStatus: (key: string, text: string | undefined) =>
      emit({ method: "setStatus", key, ...(text !== undefined ? { text } : {}) }),
    setWidget: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) =>
      emit({
        method: "setWidget",
        key,
        // Component factories cannot cross the wire; only string lines are forwarded.
        ...(Array.isArray(content) ? { lines: content as string[] } : {}),
        placement: options?.placement ?? "aboveEditor",
      }),
    setTitle: (title: string) => emit({ method: "setTitle", title }),
    setEditorText: (text: string) => emit({ method: "setEditorText", text }),
    pasteToEditor: (text: string) => emit({ method: "setEditorText", text }),

    // --- not portable: cancel safely, never hang ---
    custom: () => Promise.resolve(undefined),
    getEditorText: () => "",
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: NOT_AVAILABLE }),
    onTerminalInput: () => () => {},
    addAutocompleteProvider: () => {},
  };

  const context = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof ExtensionUIContext];
      // Unknown member (e.g. added by a newer Pi): a no-op function is the only
      // safe answer. Returning undefined would throw inside the extension.
      return () => undefined;
    },
    has: () => true,
  }) as unknown as ExtensionUIContext;

  const settle = (entry: Pending): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(entry.request.method === "confirm" ? false : undefined);
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
      disposed = true;
      for (const entry of pending.values()) settle(entry);
      pending.clear();
    },
  };
}
