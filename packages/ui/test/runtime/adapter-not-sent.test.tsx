// @vitest-environment happy-dom
/**
 * A message the worker never took goes back into the composer that sent it
 * (M13-T89 U1), over the real external-store runtime and the real thread
 * adapter, with the host replaced by a client that refuses `session/prompt`
 * the two ways the worker does: a rejection carrying its sentence, and
 * `{ accepted: false }` on a first-turn prompt.
 *
 * Every lane is covered because assistant-ui treats them differently: for
 * `queue.enqueue` and `queue.steer` the runtime never awaits the adapter, so
 * the adapter restores the draft itself; for `onNew` (a runtime without a
 * queue) the `MessageNotSentError` it rethrows is what assistant-ui's own
 * composer restoration keys on.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMemo, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  isMessageNotSentError,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ClientMethod, ClientRequests } from "@lasercode/protocol";
import { createThreadAdapter, notSentMessage, restoreUnsentMessage, type RequestClient, type UnsentMessageComposer } from "../../src/runtime/adapter.js";
import { firstTurnFromRunConfig, withFirstTurn } from "../../src/runtime/first-turn.js";
import { view as makeView } from "../agents/fixtures.js";

const PATH = "/p/pristine.jsonl";
const WORKER_REFUSAL = 'No custom agent is called "reviewer".';

interface Call {
  method: ClientMethod;
  params: unknown;
}

/** A host that answers `session/prompt` however the test decides, and everything else with `{}`. */
function fakeClient() {
  const calls: Call[] = [];
  let prompt: (params: ClientRequests["session/prompt"]["params"]) => Promise<unknown> = async () => ({ accepted: true });
  const client: RequestClient = {
    request: (<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]) => {
      calls.push({ method, params });
      if (method === "session/prompt") return prompt(params as ClientRequests["session/prompt"]["params"]);
      return Promise.resolve({});
    }) as RequestClient["request"],
  };
  return {
    client,
    calls,
    prompts: () => calls.filter((call) => call.method === "session/prompt").map((call) => call.params as ClientRequests["session/prompt"]["params"]),
    answer(next: typeof prompt) {
      prompt = next;
    },
  };
}

const handles: { aui?: ReturnType<typeof useAui> } = {};

function Probe() {
  handles.aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const attachments = useAuiState((s) => s.composer.attachments.length);
  return <span data-slot="probe" data-text={text} data-attachments={attachments} />;
}

interface HarnessProps {
  client: RequestClient;
  onError: (error: unknown) => void;
  /** Without a queue, a composer send reaches `onNew`, the one lane assistant-ui restores itself. */
  queue?: boolean;
  /** Without the getter the adapter has no composer to restore into. */
  composer?: boolean;
}

function Harness({ client, onError, queue = true, composer = true }: HarnessProps) {
  const runtimeRef = useRef<AssistantRuntime | undefined>(undefined);
  const adapter = useMemo(() => {
    const built = createThreadAdapter({
      client,
      path: PATH,
      view: makeView({ path: PATH }),
      connection: "open",
      dispatch: () => {},
      onError,
      ...(composer ? { composer: () => runtimeRef.current?.thread.composer } : {}),
    });
    if (queue) return built;
    const { queue: _lane, ...withoutQueue } = built;
    return withoutQueue;
  }, [client, composer, onError, queue]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>(adapter);
  runtimeRef.current = runtime;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input data-slot="input" />
      </ComposerPrimitive.Root>
      <Probe />
    </AssistantRuntimeProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const input = () => container.querySelector<HTMLTextAreaElement>('[data-slot="input"]')!;
const mount = async (props: Omit<HarnessProps, "onError"> & { onError?: HarnessProps["onError"] }) => {
  const onError = props.onError ?? vi.fn();
  await act(async () => root.render(<Harness {...props} onError={onError} />));
  await act(async () => settle());
  return onError;
};
const type = async (text: string) => {
  await act(async () => handles.aui!.composer.setText(text));
};
const send = async (options?: { steer?: boolean }) => {
  await act(async () => handles.aui!.composer.send(options));
  await act(async () => settle(5));
};

describe("a refused send over the real runtime", () => {
  it("puts the text back after the worker rejects the prompt on the queue lane, and the toast says so", async () => {
    const host = fakeClient();
    host.answer(() => Promise.reject(new Error(WORKER_REFUSAL)));
    const onError = await mount({ client: host.client });
    await type("Refusal retry draft");
    await send();

    expect(host.prompts()).toHaveLength(1);
    expect(input().value).toBe("Refusal retry draft");
    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0]![0];
    expect(isMessageNotSentError(error)).toBe(true);
    expect((error as Error).message).toBe(`${WORKER_REFUSAL} Your message is back in the composer — send it again when you are ready.`);
    expect((error as Error).cause).toMatchObject({ message: WORKER_REFUSAL });

    // The retry, once the worker accepts: exactly one more prompt and an empty composer.
    host.answer(async () => ({ accepted: true }));
    await send();
    expect(host.prompts()).toHaveLength(2);
    expect(host.prompts()[1]?.content).toEqual([{ type: "text", text: "Refusal retry draft" }]);
    expect(input().value).toBe("");
  });

  it("does the same on the steer lane", async () => {
    const host = fakeClient();
    host.answer(() => Promise.reject(new Error(WORKER_REFUSAL)));
    await mount({ client: host.client });
    await type("steered draft");
    await send({ steer: true });
    // Idle, so the steer lane was a plain prompt — and it came back.
    expect(host.calls.map((call) => call.method)).toEqual(["session/prompt"]);
    expect(input().value).toBe("steered draft");
  });

  it("keeps the first-turn choice for the retry when the worker answers accepted: false", async () => {
    const host = fakeClient();
    host.answer(async () => ({ accepted: false }));
    const onError = await mount({ client: host.client });
    await act(async () => handles.aui!.composer.setRunConfig(withFirstTurn({ custom: { retained: "yes" } }, { agentName: "reviewer", thinkingLevel: "high" })));
    await type("with a choice");
    await send();

    expect(host.prompts()[0]?.firstTurn).toEqual({ agentName: "reviewer", thinkingLevel: "high" });
    // Never steered without its agent, and back in the composer with the choice intact.
    expect(host.calls.map((call) => call.method)).toEqual(["session/prompt"]);
    expect(input().value).toBe("with a choice");
    expect(firstTurnFromRunConfig(handles.aui!.composer.getState().runConfig)).toEqual({ agentName: "reviewer", thinkingLevel: "high" });
    expect(handles.aui!.composer.getState().runConfig.custom?.["retained"]).toBe("yes");
    const message = (onError.mock.calls[0]![0] as Error).message;
    expect(message).toContain("started before the agent choice");
    expect(message).toContain("check the agent and thinking choice, then send it again");
  });

  it("brings an image attachment back and sends it on the retry", async () => {
    const host = fakeClient();
    host.answer(() => Promise.reject(new Error(WORKER_REFUSAL)));
    await mount({ client: host.client });
    await act(async () => handles.aui!.composer.addAttachment(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })));
    await type("see the picture");
    await send();

    const restored = handles.aui!.composer.getState().attachments;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ type: "image", name: "shot.png", status: { type: "complete" } });
    expect(restored[0]?.content?.[0]).toMatchObject({ type: "image", image: "data:image/png;base64,AQID" });
    expect(input().value).toBe("see the picture");

    host.answer(async () => ({ accepted: true }));
    await send();
    expect(host.prompts()[1]?.content).toEqual([
      { type: "text", text: "see the picture" },
      { type: "image", mimeType: "image/png", data: "AQID" },
    ]);
    expect(handles.aui!.composer.getState().attachments).toHaveLength(0);
    expect(input().value).toBe("");
  });

  it("never writes over what the person typed while the refusal was in flight", async () => {
    const host = fakeClient();
    let reject!: (error: Error) => void;
    host.answer(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onError = await mount({ client: host.client });
    await type("first draft");
    await send();
    expect(input().value).toBe("");
    await type("second thought");
    await act(async () => { reject(new Error(WORKER_REFUSAL)); await settle(5); });

    expect(input().value).toBe("second thought");
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]![0] as Error).message).toBe(WORKER_REFUSAL);
  });

  it("restores through assistant-ui's own contract on the onNew lane", async () => {
    const host = fakeClient();
    host.answer(() => Promise.reject(new Error(WORKER_REFUSAL)));
    // No queue and no composer getter: the only thing left is the
    // MessageNotSentError the adapter rethrows, which is what the composer's
    // own restoration keys on.
    const onError = await mount({ client: host.client, queue: false, composer: false });
    await type("through onNew");
    await send();
    expect(host.prompts()).toHaveLength(1);
    expect(input().value).toBe("through onNew");
    expect(isMessageNotSentError(onError.mock.calls[0]![0])).toBe(true);
  });

  it("cannot restore on a queue lane without the composer getter, which is why the runtime supplies one", async () => {
    const host = fakeClient();
    host.answer(() => Promise.reject(new Error(WORKER_REFUSAL)));
    const onError = await mount({ client: host.client, composer: false });
    await type("lost without a composer");
    await send();
    expect(input().value).toBe("");
    // The person is still told, in the worker's words, without a promise the composer cannot keep.
    expect((onError.mock.calls[0]![0] as Error).message).toBe(WORKER_REFUSAL);
  });

  it("restores nothing after the worker accepted, whatever fails later", async () => {
    const host = fakeClient();
    const onError = await mount({ client: host.client });
    await type("accepted");
    await send();
    expect(input().value).toBe("");
    // A later failure on the same thread is not a refusal of that message.
    host.answer(() => Promise.reject(new Error("The worker went away.")));
    await act(async () => { await handles.aui!.thread.cancelRun(); await settle(5); });
    expect(input().value).toBe("");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("restoreUnsentMessage", () => {
  const fakeComposer = (state: { text?: string; attachments?: unknown[]; quote?: unknown }) => {
    const composer = {
      text: state.text ?? "",
      attachments: (state.attachments ?? []) as never[],
      added: [] as unknown[],
      getState: () => ({ text: composer.text, attachments: composer.attachments, quote: state.quote }) as ReturnType<UnsentMessageComposer["getState"]>,
      setText: vi.fn((text: string) => { composer.text = text; }),
      addAttachment: vi.fn(async (attachment: unknown) => { composer.added.push(attachment); }),
    };
    return composer as typeof composer & UnsentMessageComposer;
  };
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "hello" }],
    attachments: [{ id: "a1", type: "image", name: "shot.png", contentType: "image/png", status: { type: "complete" as const }, content: [{ type: "image" as const, image: "data:image/png;base64,QUJD" }] }],
    createdAt: new Date(0),
    parentId: null,
    sourceId: null,
    runConfig: undefined,
    metadata: { custom: {} },
  } as Parameters<typeof restoreUnsentMessage>[1];

  it("puts text and attachments back into an empty composer", async () => {
    const composer = fakeComposer({});
    await expect(restoreUnsentMessage(composer, message)).resolves.toBe(true);
    expect(composer.setText).toHaveBeenCalledWith("hello");
    expect(composer.added).toEqual([{ id: "a1", type: "image", name: "shot.png", contentType: "image/png", content: [{ type: "image", image: "data:image/png;base64,QUJD" }] }]);
  });

  it("refuses a composer that holds text, an attachment or a quote, and one that does not exist", async () => {
    for (const held of [{ text: "typing" }, { attachments: [{}] }, { quote: { text: "q" } }]) {
      const composer = fakeComposer(held);
      await expect(restoreUnsentMessage(composer, message)).resolves.toBe(false);
      expect(composer.setText).not.toHaveBeenCalled();
      expect(composer.addAttachment).not.toHaveBeenCalled();
    }
    await expect(restoreUnsentMessage(undefined, message)).resolves.toBe(false);
  });
});

describe("notSentMessage", () => {
  it("adds the next step only when the message actually came back, and finishes the sentence first", () => {
    expect(notSentMessage("connection closed", { restored: false, firstTurn: true })).toBe("connection closed");
    expect(notSentMessage("connection closed", { restored: true, firstTurn: false })).toBe("connection closed. Your message is back in the composer — send it again when you are ready.");
    expect(notSentMessage(`${WORKER_REFUSAL}  `, { restored: true, firstTurn: true })).toBe(`${WORKER_REFUSAL} Your message is back in the composer — check the agent and thinking choice, then send it again.`);
  });
});
