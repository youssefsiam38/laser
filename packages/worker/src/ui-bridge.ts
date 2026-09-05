/**
 * UI bridge (M0-T7, extended in M1-T10) — turns Pi's ExtensionUIContext calls
 * into protocol messages.
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
 *
 * Dialog lifetime (D-17):
 *   - A dialog raised while exactly one tool call is executing is stamped with
 *     that `toolCallId` (see `UiBridgeOptions.pendingToolCallId`) so the client
 *     can render it inside the tool row. The classification is made here, on the
 *     host, at request time; clients never guess it from titles.
 *   - Every way a dialog can end WITHOUT a client answer (Pi's AbortSignal, the
 *     timeout, bridge disposal) emits `{ method: "dialogResolved", id }` so a
 *     client that is showing the dialog drops it. A client answer emits nothing:
 *     the client already knows.
 */

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  UiDialogRequest,
  UiDialogResponse,
  UiFireAndForget,
} from "./ui-types.js";

export interface UiBridgeHandlers {
  onRequest: (request: UiDialogRequest) => void;
  onEvent: (event: UiFireAndForget) => void;
}

export interface UiBridgeOptions {
  /**
   * Tool call this dialog belongs to, resolved lazily when a dialog is raised.
   * The driver returns an id only under single-tool causality (exactly one tool
   * call executing); zero or several running tools mean the dialog is
   * free-standing and no `toolCallId` is stamped.
   *
   * Lazy on purpose: the bridge is constructed before any Pi session exists.
   */
  pendingToolCallId?: () => string | undefined;
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
  /** What this dialog settles to when nobody answers (`false` for confirm). */
  fallback: unknown;
  timer?: ReturnType<typeof setTimeout>;
  detachSignal?: () => void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type UiDialogRequestInput = DistributiveOmit<UiDialogRequest, "id" | "toolCallId">;

/**
 * Pi 0.85's `ExtensionUIDialogOptions` (`{ signal?: AbortSignal; timeout?: number }`),
 * re-exported through ui-types.ts so a Pi rename surfaces there first. Both
 * fields are still read defensively at the call sites.
 */
type DialogOptions = ExtensionUIDialogOptions;

const NOT_AVAILABLE = "UI not available";

export function createUiBridge(handlers: UiBridgeHandlers, options: UiBridgeOptions = {}): UiBridge {
  const pending = new Map<string, Pending>();
  let counter = 0;
  let disposed = false;
  /**
   * Per-bridge (= per-session) nonce. A timestamp is not enough: two sessions
   * in this worker that raise their first dialog in the same millisecond would
   * mint the same id, and one client answer would settle both.
   */
  const nonce = Math.random().toString(36).slice(2, 8);

  /**
   * Settle one pending dialog. `notify` emits `dialogResolved`, which is the
   * signal for clients to drop a dialog they are showing — so it is sent for
   * abort / timeout / dispose and never for a client's own answer.
   */
  function close(id: string, value: unknown, notify: boolean): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.detachSignal?.();
    // Deliberately not routed through `emit()`: dispose() must still be able to
    // tell clients that the dialogs it is tearing down are gone.
    if (notify) handlers.onEvent({ method: "dialogResolved", id });
    entry.resolve(value);
  }

  function ask<T>(request: UiDialogRequestInput, fallback: T, opts?: DialogOptions): Promise<T | undefined> {
    if (disposed) return Promise.resolve(fallback);
    const signal = opts?.signal;
    // Already aborted: nothing was ever shown, so there is nothing to resolve.
    if (signal?.aborted) return Promise.resolve(fallback);

    const id = `ui-${nonce}-${++counter}`;
    // Attribution is a nicety; a dialog must never fail because it threw.
    let toolCallId: string | undefined;
    try {
      toolCallId = options.pendingToolCallId?.();
    } catch {
      toolCallId = undefined;
    }
    const full = {
      ...request,
      id,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    } as UiDialogRequest;

    return new Promise<T | undefined>((resolve) => {
      const entry: Pending = { request: full, resolve: resolve as (v: unknown) => void, fallback };
      if (full.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => close(id, fallback, true), full.timeoutMs);
      }
      if (signal) {
        const onAbort = (): void => close(id, fallback, true);
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detachSignal = () => signal.removeEventListener("abort", onAbort);
      }
      pending.set(id, entry);
      // Last: a handler may answer synchronously, and `close` needs the entry.
      handlers.onRequest(full);
    });
  }

  const emit = (event: UiFireAndForget): void => {
    if (!disposed) handlers.onEvent(event);
  };

  const timeoutOf = (opts?: DialogOptions): { timeoutMs?: number } =>
    opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {};

  /** Members we implement. Anything absent is handled by the Proxy below. */
  const impl: Partial<Record<keyof ExtensionUIContext, unknown>> = {
    // --- dialogs (round-trip) ---
    select: (title: string, choices: string[], opts?: DialogOptions) =>
      ask<string>({ method: "select", title, options: choices, ...timeoutOf(opts) }, undefined as unknown as string, opts),
    confirm: (title: string, message: string, opts?: DialogOptions) =>
      ask<boolean>({ method: "confirm", title, message, ...timeoutOf(opts) }, false, opts).then((v) => v ?? false),
    input: (title: string, placeholder?: string, opts?: DialogOptions) =>
      ask<string>(
        {
          method: "input",
          title,
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...timeoutOf(opts),
        },
        undefined as unknown as string,
        opts,
      ),
    // Pi 0.85 gives `editor` no options object; accept one anyway so a future
    // release that adds `{ signal, timeout }` is honoured without a change here.
    editor: (title: string, prefill?: string, opts?: DialogOptions) =>
      ask<string>(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...timeoutOf(opts) },
        undefined as unknown as string,
        opts,
      ),

    // --- fire-and-forget ---
    notify: (message: string, type: "info" | "warning" | "error" = "info") =>
      emit({ method: "notify", message, level: type }),
    setStatus: (key: string, text: string | undefined) =>
      emit({ method: "setStatus", key, ...(text !== undefined ? { text } : {}) }),
    setWidget: (key: string, content: unknown, opts?: { placement?: "aboveEditor" | "belowEditor" }) =>
      emit({
        method: "setWidget",
        key,
        // Component factories cannot cross the wire; only string lines are forwarded.
        ...(Array.isArray(content) ? { lines: content as string[] } : {}),
        placement: opts?.placement ?? "aboveEditor",
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

  return {
    context,
    respond(response) {
      const entry = pending.get(response.id);
      if (!entry) return;
      const value =
        "cancelled" in response ? entry.fallback : "confirmed" in response ? response.confirmed : response.value;
      // The client answered, so it already knows: no `dialogResolved`.
      close(response.id, value, false);
    },
    pending: () => [...pending.values()].map((p) => p.request),
    dispose() {
      for (const [id, entry] of [...pending]) close(id, entry.fallback, true);
      pending.clear();
      disposed = true;
    },
  };
}
