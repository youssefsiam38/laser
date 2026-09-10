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
 */
export class StableExtensionAdmission {
  private generation = 0;
  private serial = 0;
  private readonly invocation = new AsyncLocalStorage<StableInvocation>();
  private readonly nativeBySession = new WeakMap<AgentSession, NativeMethods>();
  private handler: ExtensionModelWorkHandler | undefined;
  /** Rejection observers in Pi core run outside our ALS scope; pair their diagnostic by message. */
  private readonly rejectedInvocations = new Map<string, DriverInvocationRef[]>();

  setHandler(handler: ExtensionModelWorkHandler | undefined): void {
    this.handler = handler;
  }

  /** Install before bindExtensions; safe to repeat for the same Pi session. */
  install(session: AgentSession): number {
    const generation = ++this.generation;
    let native = this.nativeBySession.get(session);
    if (!native) {
      native = {
        prompt: session.prompt.bind(session) as AgentSession["prompt"],
        custom: session.sendCustomMessage.bind(session) as AgentSession["sendCustomMessage"],
      };
      this.nativeBySession.set(session, native);
    }
    const mutable = session as AgentSession & {
      prompt: AgentSession["prompt"];
      sendCustomMessage: AgentSession["sendCustomMessage"];
    };
    mutable.prompt = ((text: string, options?: PiPromptOptions) => {
      if (options?.source !== "extension") return native!.prompt(text, options);
      if (generation !== this.generation) return staleExecutionError().admission;
      return this.interceptUser(session, native!.prompt, generation, text, options);
    }) as AgentSession["prompt"];
    mutable.sendCustomMessage = ((message: PiCustomMessage, options?: PiCustomOptions) => {
      if (!customMessageTriggersModel(session.isStreaming, options)) return native!.custom(message, options);
      if (generation !== this.generation) return staleExecutionError().admission;
      return this.interceptCustom(session, native!.custom, generation, message, options);
    }) as AgentSession["sendCustomMessage"];
    return generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  nativePrompt(session: AgentSession): AgentSession["prompt"] {
    return this.nativeBySession.get(session)?.prompt ?? session.prompt.bind(session);
  }

  takeRejectedInvocation(error: unknown): DriverInvocationRef | undefined {
    const key = error instanceof Error ? error.message : String(error);
    const refs = this.rejectedInvocations.get(key);
    const ref = refs?.shift();
    if (refs?.length === 0) this.rejectedInvocations.delete(key);
    return ref;
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
    const admission = deferred<void>();
    void admission.promise.catch(() => undefined);
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
          admission.resolve();
        }
      },
    }), true);
    const completion = raw.then(
      () => {
        if (preflight === undefined) {
          const error = new ExtensionAdmissionRefusedError("The engine resolved an extension prompt without reporting preflight acceptance.");
          this.rememberRejection(context.ref, error);
          admission.reject(error);
          throw error;
        }
        if (!preflight) {
          const error = new ExtensionAdmissionRefusedError("The extension message was refused before model ownership.");
          this.rememberRejection(context.ref, error);
          throw error;
        }
        return { disposition: wasStreaming ? "queued" as const : context.started ? "started" as const : "consumed" as const };
      },
      (error: unknown) => {
        this.rememberRejection(context.ref, error);
        if (preflight !== true) admission.reject(error);
        throw error;
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
    const admission = deferred<void>();
    void admission.promise.catch(() => undefined);
    const wasStreaming = session.isStreaming;
    const context = this.createInvocation({
      ...(ownerRunId ? { ownerRunId } : {}),
      origin,
      task: contentTask(extensionCustomContent(message)),
      accept: () => {},
    });
    onInvocation?.(context.ref);
    const raw = this.runInvocation(context, () => nativeCustom(message, options), true);
    if (!wasStreaming && session.isStreaming) {
      context.started = true;
      parent?.accept();
      admission.resolve();
    }
    const completion = raw.then(
      () => {
        if (wasStreaming) {
          parent?.accept();
          admission.resolve();
          return { disposition: "queued" as const };
        }
        if (context.started || session.isStreaming) {
          parent?.accept();
          admission.resolve();
          return { disposition: "started" as const };
        }
        const error = new ExtensionAdmissionRefusedError("The engine did not start the triggering extension message.");
        this.rememberRejection(context.ref, error);
        admission.reject(error);
        throw error;
      },
      (error: unknown) => {
        this.rememberRejection(context.ref, error);
        if (!wasStreaming && !context.started) admission.reject(error);
        throw error;
      },
    );
    void completion.catch(() => undefined);
    return { admission: admission.promise, completion };
  }

  private rememberRejection(ref: DriverInvocationRef, error: unknown): void {
    const key = error instanceof Error ? error.message : String(error);
    const refs = this.rejectedInvocations.get(key) ?? [];
    refs.push(ref);
    this.rejectedInvocations.set(key, refs);
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
