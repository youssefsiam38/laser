import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ContentBlock } from "@lasercode/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DriverUnavailableError,
  type DriverInvocationRef,
  type ExtensionModelAdmission,
  type ExtensionModelExecution,
  type ExtensionModelWorkHandler,
  type ExtensionModelWorkRequest,
  type SessionAdmissionLease,
} from "../driver.js";

type PiPromptOptions = NonNullable<Parameters<AgentSession["prompt"]>[1]>;
type PiCustomMessage = Parameters<AgentSession["sendCustomMessage"]>[0];
type PiCustomOptions = Parameters<AgentSession["sendCustomMessage"]>[1];

export interface StableInvocation {
  ref: DriverInvocationRef;
  generation: number;
  origin: "agent" | "user";
  task: string;
  admissionLease?: SessionAdmissionLease;
  started: boolean;
  /** Async resources stop carrying admission authority when this invocation drains. */
  active: boolean;
  originClaimed: boolean;
  accept(): void;
  readonly children: Set<Promise<void>>;
}

interface NativeMethods {
  prompt: AgentSession["prompt"];
  custom: AgentSession["sendCustomMessage"];
}

class ExtensionAdmissionRefusedError extends Error {
  override readonly name = "ExtensionAdmissionRefusedError";
}

/**
 * The pinned Pi adapter's extension-to-model transaction boundary.
 *
 * This owns original-method preservation, runtime generations, invocation
 * capabilities and A/C separation. StableSdkDriver owns the public session
 * lifecycle and delegates only this narrow admission concern here.
 *
 * A = the admission promise handed back to the extension. It settles exactly
 * once: accepted when the engine takes the message, refused by every failure
 * that happens before that. Acceptance is monotonic — a failure after it
 * rejects only C. C = the completion the worker retains: the native
 * invocation plus its drained causal children.
 *
 * Attribution is causal, never textual. The only identity a late callback can
 * carry is the invocation of the async context it was registered in, which is
 * what `AsyncLocalStorage` propagates through promise reactions. The engine's
 * own send diagnostics (`bindCore.sendMessage` / `sendUserMessage` in the
 * pinned patch) attach their `.then(undefined, …)` at the extension's call
 * site, so they run in the caller's context: a causal parent invocation when
 * the extension sent from inside one, otherwise none. Nothing here maps an
 * error message to an invocation; two refusals with the same text can never
 * swap identities because they never had one to take.
 */
export class StableExtensionAdmission {
  private generation = 0;
  private serial = 0;
  private readonly invocation = new AsyncLocalStorage<StableInvocation>();
  private handler: ExtensionModelWorkHandler | undefined;
  private native: NativeMethods | undefined;

  setHandler(handler: ExtensionModelWorkHandler | undefined): void {
    this.handler = handler;
  }

  /** Install once for each replacement Pi session, before its extensions bind. */
  install(session: AgentSession): number {
    const generation = ++this.generation;
    const native: NativeMethods = {
      prompt: session.prompt.bind(session) as AgentSession["prompt"],
      custom: session.sendCustomMessage.bind(session) as AgentSession["sendCustomMessage"],
    };
    this.native = native;
    const mutable = session as AgentSession & {
      prompt: AgentSession["prompt"];
      sendCustomMessage: AgentSession["sendCustomMessage"];
    };
    mutable.prompt = ((text: string, options?: PiPromptOptions) => {
      if (options?.source !== "extension") return native.prompt(text, options);
      if (generation !== this.generation) return staleExecutionError().admission;
      return this.interceptUser(session, native.prompt, generation, text, options);
    }) as AgentSession["prompt"];
    mutable.sendCustomMessage = ((message: PiCustomMessage, options?: PiCustomOptions) => {
      if (!customMessageTriggersModel(session.isStreaming, options)) return native.custom(message, options);
      if (generation !== this.generation) return staleExecutionError().admission;
      return this.interceptCustom(session, native.custom, generation, message, options);
    }) as AgentSession["sendCustomMessage"];
    return generation;
  }

  /**
   * Retire the installed runtime (fork, dispose). Nothing here outlives a
   * generation: the only association an invocation has is its own async
   * context, which carries the generation it was minted in, so a later
   * generation can never consume it.
   */
  invalidate(): void {
    this.generation += 1;
    this.native = undefined;
  }

  nativePrompt(session: AgentSession): AgentSession["prompt"] {
    return this.native?.prompt ?? session.prompt.bind(session);
  }

  /**
   * The invocation an engine diagnostic belongs to: the invocation of the
   * async context it was emitted from, for this generation, or none. A
   * diagnostic emitted outside any invocation's context — the engine's own
   * rejection observer for a top-level extension send — is unowned. It is
   * never inferred from the error text.
   */
  diagnosticInvocation(generation = this.generation): DriverInvocationRef | undefined {
    return this.eventInvocation(generation)?.ref;
  }

  createInvocation(input: {
    ownerRunId?: string;
    origin: "agent" | "user";
    task: string;
    admissionLease?: SessionAdmissionLease;
    accept: () => void;
  }): StableInvocation {
    const id = `${this.generation}:${++this.serial}`;
    return {
      ref: { id, ...(input.ownerRunId ? { runId: input.ownerRunId } : {}) },
      generation: this.generation,
      origin: input.origin,
      task: input.task,
      ...(input.admissionLease ? { admissionLease: input.admissionLease } : {}),
      started: false,
      active: true,
      originClaimed: false,
      accept: once(input.accept),
      children: new Set(),
    };
  }

  /** Active-only capability for a new extension admission. */
  currentInvocation(generation = this.generation): StableInvocation | undefined {
    const current = this.invocation.getStore();
    return current?.active && current.generation === generation ? current : undefined;
  }

  /** Event attribution remains available to late callbacks after admission authority expires. */
  eventInvocation(generation = this.generation): StableInvocation | undefined {
    const current = this.invocation.getStore();
    return current?.generation === generation ? current : undefined;
  }

  async runInvocation(context: StableInvocation, operation: () => Promise<void>, drainChildren: boolean): Promise<void> {
    return this.invocation.run(context, async () => {
      let failure: unknown;
      try {
        try {
          await operation();
        } catch (error) {
          failure = error;
        }
        if (drainChildren) {
          try {
            await drainInvocationChildren(context.children);
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure !== undefined) throw failure;
      } finally {
        context.active = false;
      }
    });
  }

  private interceptUser(
    session: AgentSession,
    nativePrompt: AgentSession["prompt"],
    generation: number,
    text: string,
    options: PiPromptOptions,
  ): Promise<void> {
    const parent = this.currentInvocation(generation);
    const content = extensionUserContent(text, options.images);
    const origin = extensionOrigin(parent);
    return this.handleWork({
      kind: "user",
      content,
      task: parent && !parent.ref.runId ? parent.task : text,
      origin,
      ...(parent ? { parent: parent.ref, parentStarted: parent.started } : {}),
      ...(parent?.admissionLease?.active ? { admissionLease: parent.admissionLease } : {}),
      start: onceStart((ownerRunId, onInvocation) => this.startUser(
        session,
        nativePrompt,
        generation,
        parent,
        origin,
        ownerRunId,
        onInvocation,
        text,
        options,
      )),
    }, parent);
  }

  private startUser(
    session: AgentSession,
    nativePrompt: AgentSession["prompt"],
    generation: number,
    parent: StableInvocation | undefined,
    origin: "agent" | "user",
    ownerRunId: string | undefined,
    onInvocation: ((ref: DriverInvocationRef) => void) | undefined,
    text: string,
    options: PiPromptOptions,
  ): ExtensionModelExecution {
    if (generation !== this.generation) return staleExecutionError();
    const admission = admissionGate();
    let preflight: boolean | undefined;
    const wasStreaming = session.isStreaming;
    const context = this.createInvocation({
      ...(ownerRunId ? { ownerRunId } : {}),
      origin,
      task: text,
      accept: () => {},
    });
    onInvocation?.(context.ref);
    const raw = this.runInvocation(context, () => nativePrompt(text, {
      ...options,
      preflightResult: (accepted: boolean) => {
        if (preflight !== undefined) return;
        preflight = accepted;
        try {
          options.preflightResult?.(accepted);
        } catch {
          // A native observer cannot revoke the engine decision.
        }
        if (accepted) {
          parent?.accept();
          admission.accept();
        }
      },
    }), true);
    const completion = raw.then(
      () => {
        // A false preflight is a refusal even when the engine then resolves:
        // the message was never taken, so A must say so, not hang.
        if (preflight === undefined) {
          throw admission.refuse(new ExtensionAdmissionRefusedError("The engine resolved an extension prompt without reporting preflight acceptance."));
        }
        if (!preflight) {
          throw admission.refuse(new ExtensionAdmissionRefusedError("The extension message was refused before model ownership."));
        }
        return { disposition: wasStreaming ? "queued" as const : context.started ? "started" as const : "consumed" as const };
      },
      (error: unknown) => {
        // Before acceptance the failure is the refusal; after it, A stays
        // resolved and only C carries the failure.
        throw admission.refuse(error);
      },
    );
    void completion.catch(() => undefined);
    return { admission: admission.promise, completion };
  }

  private interceptCustom(
    session: AgentSession,
    nativeCustom: AgentSession["sendCustomMessage"],
    generation: number,
    message: PiCustomMessage,
    options: PiCustomOptions,
  ): Promise<void> {
    const parent = this.currentInvocation(generation);
    const content = extensionCustomContent(message);
    const origin = extensionOrigin(parent);
    return this.handleWork({
      kind: "custom",
      content,
      task: contentTask(content),
      origin,
      ...(parent ? { parent: parent.ref, parentStarted: parent.started } : {}),
      ...(parent?.admissionLease?.active ? { admissionLease: parent.admissionLease } : {}),
      start: onceStart((ownerRunId, onInvocation) => this.startCustom(
        session,
        nativeCustom,
        generation,
        parent,
        origin,
        ownerRunId,
        onInvocation,
        message,
        options,
      )),
    }, parent);
  }

  private startCustom(
    session: AgentSession,
    nativeCustom: AgentSession["sendCustomMessage"],
    generation: number,
    parent: StableInvocation | undefined,
    origin: "agent" | "user",
    ownerRunId: string | undefined,
    onInvocation: ((ref: DriverInvocationRef) => void) | undefined,
    message: PiCustomMessage,
    options: PiCustomOptions,
  ): ExtensionModelExecution {
    if (generation !== this.generation) return staleExecutionError();
    const admission = admissionGate();
    const wasStreaming = session.isStreaming;
    const context = this.createInvocation({
      ...(ownerRunId ? { ownerRunId } : {}),
      origin,
      task: contentTask(extensionCustomContent(message)),
      accept: () => {},
    });
    onInvocation?.(context.ref);
    const raw = this.runInvocation(context, async () => {
      await nativeCustom(message, options);
      // The engine took the message — queued behind the running turn, or as
      // the turn it started. Acceptance precedes the causal-child drain, so
      // a child that fails afterwards reaches only C.
      if (wasStreaming || context.started || session.isStreaming) {
        parent?.accept();
        admission.accept();
      }
    }, true);
    if (!wasStreaming && session.isStreaming) {
      context.started = true;
      parent?.accept();
      admission.accept();
    }
    const completion = raw.then(
      () => {
        if (!admission.accepted) {
          throw admission.refuse(new ExtensionAdmissionRefusedError("The engine did not start the triggering extension message."));
        }
        return { disposition: wasStreaming ? "queued" as const : "started" as const };
      },
      (error: unknown) => {
        // Whether the trigger arrived idle or streaming, a native failure
        // before acceptance refuses A; a failure after it reaches only C.
        throw admission.refuse(error);
      },
    );
    void completion.catch(() => undefined);
    return { admission: admission.promise, completion };
  }

  private handleWork(request: ExtensionModelWorkRequest, parent: StableInvocation | undefined): Promise<void> {
    let result: ExtensionModelAdmission;
    try {
      result = this.handler ? this.handler(request) : directExtensionAdmission(request);
    } catch (error) {
      return observedRejected(error);
    }
    void result.admission.catch(() => undefined);
    if (result.joinsParent) {
      const completion = result.completion.finally(() => {
        parent?.children.delete(completion);
      });
      void completion.catch(() => undefined);
      parent?.children.add(completion);
    } else {
      void result.completion.catch(() => undefined);
    }
    return result.admission;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * The extension-visible admission A, as its own state rather than something
 * inferred from streaming or start flags. It settles exactly once, and
 * acceptance is monotonic: `accept()` after any settle is a no-op, and
 * `refuse()` after acceptance leaves A resolved and only hands the error
 * back for C. `refuse()` always returns the error so a caller can `throw`
 * it in one step.
 */
interface AdmissionGate {
  readonly promise: Promise<void>;
  readonly accepted: boolean;
  readonly settled: boolean;
  accept(): void;
  refuse(error: unknown): unknown;
}

function admissionGate(): AdmissionGate {
  const gate = deferred<void>();
  void gate.promise.catch(() => undefined);
  let state: "open" | "accepted" | "refused" = "open";
  return {
    promise: gate.promise,
    get accepted() {
      return state === "accepted";
    },
    get settled() {
      return state !== "open";
    },
    accept() {
      if (state !== "open") return;
      state = "accepted";
      gate.resolve();
    },
    refuse(error) {
      if (state === "open") {
        state = "refused";
        gate.reject(error);
      }
      return error;
    },
  };
}

function once(operation: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    operation();
  };
}

function onceStart(
  start: (ownerRunId?: string, onInvocation?: (ref: DriverInvocationRef) => void) => ExtensionModelExecution,
): ExtensionModelWorkRequest["start"] {
  let called = false;
  return (ownerRunId, onInvocation) => {
    if (called) return staleExecutionError("An extension admission transaction was started twice.");
    called = true;
    return start(ownerRunId, onInvocation);
  };
}

function observedRejected(error: unknown): Promise<never> {
  const rejected = Promise.reject(error);
  void rejected.catch(() => undefined);
  return rejected;
}

function staleExecutionError(message = "The session runtime changed before extension model work could start."): ExtensionModelExecution {
  const admission = observedRejected(new DriverUnavailableError("stable-sdk", message));
  const completion = admission.then(() => ({ disposition: "consumed" as const }));
  void completion.catch(() => undefined);
  return { admission, completion };
}

function directExtensionAdmission(request: ExtensionModelWorkRequest): ExtensionModelAdmission {
  const execution = request.start(request.parent?.runId);
  const completion = execution.completion.then(() => undefined);
  void completion.catch(() => undefined);
  return { admission: execution.admission, completion, joinsParent: true };
}

async function drainInvocationChildren(children: Set<Promise<void>>): Promise<void> {
  let firstFailure: unknown;
  while (children.size > 0) {
    const settled = await Promise.allSettled([...children]);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected && firstFailure === undefined) firstFailure = rejected.reason;
  }
  if (firstFailure !== undefined) throw firstFailure;
}

function extensionOrigin(parent: StableInvocation | undefined): "agent" | "user" {
  if (!parent) return "agent";
  if (parent.ref.runId) return parent.origin;
  if (parent.origin !== "user" || parent.originClaimed) return "agent";
  parent.originClaimed = true;
  return "user";
}

function customMessageTriggersModel(streaming: boolean, options: PiCustomOptions): boolean {
  if (options?.deliverAs === "nextTurn") return false;
  return streaming ? options?.triggerTurn !== false : options?.triggerTurn === true;
}

function extensionUserContent(text: string, images: PiPromptOptions["images"]): ContentBlock[] {
  return [
    { type: "text", text },
    ...((images ?? []) as ContentBlock[]).filter((block) => block.type === "image"),
  ];
}

function extensionCustomContent(message: PiCustomMessage): ContentBlock[] {
  const value = (message as { content?: unknown }).content;
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block): ContentBlock[] => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") return [{ type: "text", text: candidate.text }];
    if (candidate.type === "image" && typeof candidate.mimeType === "string" && typeof candidate.data === "string") {
      return [{ type: "image", mimeType: candidate.mimeType, data: candidate.data }];
    }
    return [];
  });
}

function contentTask(content: ContentBlock[]): string {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "Extension model work";
}
