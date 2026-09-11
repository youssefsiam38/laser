// @vitest-environment happy-dom
/**
 * M13-T89, over the real provider, the real thread runtimes, the real
 * composer with its preparation provider and pickers, and a host replaced by
 * an in-memory peer that refuses `session/prompt` the way the worker does.
 *
 * U1 — a first-turn prompt the worker refuses leaves the person exactly what
 * they had: the text, the attachments and the tentative agent and thinking
 * choice, in the composer that sent, so one correction and one Send finish
 * the job. U2 — leaving a pristine session discards only that tentative
 * choice; the draft and the rest of the run config stay. And the two together:
 * a refusal that lands after the person moved on restores nothing into the
 * session they arrived at.
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

vi.mock("../../src/components/shell/shell-context.js", async (original) => ({
  ...(await original<typeof import("../../src/components/shell/shell-context.js")>()),
  useShell: () => ({ newSession: async () => {}, canCreate: true }),
}));

import { useAui, useAuiState } from "@assistant-ui/react";
import { agentDisplayName } from "../../src/agents/index.js";
import { beamWorkspace, isBeamSession } from "../../src/components/beam/beam-model.js";
import { Composer } from "../../src/components/thread/Composer.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, LaserThreadScope, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { firstTurnFromRunConfig, mergeRunConfigCustom } from "../../src/runtime/first-turn.js";
import type { AppState } from "../../src/store.js";
import { addSession, BEAM_CWD, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

const A = `${PROJECT_CWD}/a.jsonl`;
const B = `${PROJECT_CWD}/b.jsonl`;
const BEAM = `${BEAM_CWD}/beam.jsonl`;
const WORKER_REFUSAL = 'No custom agent is called "reviewer".';
const DEFAULT_AGENT_LABEL = `Agent: ${agentDisplayName("default")}`;

/** A listed, loadable session with nothing in it yet, on a model that reasons. */
function pristine(world: World, path: string): void {
  addSession(world, path, PROJECT_CWD);
  const agent = { agentName: "default", kind: "root" as const };
  world.states[path] = { ...world.states[path]!, messageCount: 0, model: { provider: "openai", id: "gpt-fast" }, agent };
  const index = world.sessions.findIndex((session) => session.path === path);
  world.sessions[index] = { ...world.sessions[index]!, messageCount: 0, agent };
}

type Handle = { aui: ReturnType<typeof useAui>; actions: ReturnType<typeof useLaserStable>["actions"] };
const handles: Record<string, Handle> = {};

function Probe({ id }: { id: string }) {
  const aui = useAui();
  const { actions } = useLaserStable();
  handles[id] = { aui, actions };
  const messages = useAuiState((s) => s.thread.messages.length);
  const current = useLaserState((s) => s.current);
  const toasts = useLaserState((s) => s.toasts.map((toast) => `${toast.level}:${toast.text}`).join("\n"));
  return <span data-slot={`probe-${id}`} data-messages={messages} data-current={current ?? ""} data-toasts={toasts} />;
}

function Open({ path }: { path: string }) {
  const { actions } = useLaserStable();
  useEffect(() => {
    void actions.openSession(path);
  }, [actions, path]);
  return null;
}

const filter = (session: { cwd: string; agent?: AppState["sessions"][number]["agent"] }, state: AppState) => isBeamSession(session, state.agents.snapshot);
const createIn = (state: AppState) => beamWorkspace(state.agents.snapshot);

function Harness({ withBeam = false }: { withBeam?: boolean }) {
  return (
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <Open path={A} />
        <div data-tree="main">
          <Probe id="main" />
          <Composer />
        </div>
        {withBeam && (
          <LaserThreadScope path={BEAM} onPathChange={() => {}} filter={filter} createIn={createIn} unavailable="Beam is still connecting.">
            <div data-tree="beam">
              <Probe id="beam" />
              <Composer />
            </div>
          </LaserThreadScope>
        )}
      </TooltipProvider>
    </LaserProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;
let prompt: (params: { path: string }) => unknown;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  pristine(world, A);
  pristine(world, B);
  addSession(world, BEAM, BEAM_CWD);
  world.snapshot = {
    ...world.snapshot,
    agents: world.snapshot.agents.map((agent) => agent.name === "reviewer"
      ? { ...agent, model: { provider: "openai", id: "gpt-big" }, thinkingLevel: "high" }
      : agent),
  };
  prompt = () => ({ accepted: true });
  world.overrides["session/prompt"] = ((params: { path: string }) => prompt(params)) as never;
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async (props: { withBeam?: boolean } = {}) => {
  await act(async () => root.render(<Harness {...props} />));
  await act(async () => settle(20));
};
const tree = (name: string) => container.querySelector<HTMLElement>(`[data-tree="${name}"]`)!;
const probe = (name: string) => container.querySelector<HTMLElement>(`[data-slot="probe-${name}"]`)!;
const input = (name: string) => tree(name).querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const agentLabel = (name: string) => tree(name).querySelector('button[aria-label^="Agent:"]')?.getAttribute("aria-label");
const thinkingLabel = (name: string) => tree(name).querySelector('button[aria-label^="Thinking:"]')?.getAttribute("aria-label");
const modelLabel = (name: string) => tree(name).querySelector('button[aria-label^="Model:"]')?.getAttribute("aria-label");
const composerState = (name: string) => handles[name]!.aui.composer.getState();
const calls = (method: string) => world.calls.filter((call) => call.method === method);
const prompts = (path?: string) => calls("session/prompt").map((call) => call.params as { path: string; content: unknown; firstTurn?: unknown }).filter((params) => !path || params.path === path);
const refuse = () => Promise.reject(new Error(WORKER_REFUSAL));

const chooseAgent = async (name: string, label: string) => {
  await act(async () => tree(name).querySelector<HTMLButtonElement>('button[aria-label^="Agent:"]')!.click());
  await act(async () => settle(0));
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((candidate) => candidate.textContent?.includes(label))!;
  expect(item).toBeTruthy();
  await act(async () => item.click());
  await act(async () => settle(0));
};
const chooseThinking = async (name: string, level: string) => {
  await act(async () => tree(name).querySelector<HTMLButtonElement>('button[aria-label^="Thinking:"]')!.click());
  await act(async () => settle(0));
  await act(async () => document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${level}"]`)!.click());
  await act(async () => settle(0));
};
const chooseModel = async (name: string, label: string) => {
  await act(async () => tree(name).querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')!.click());
  await act(async () => settle(0));
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((candidate) => candidate.textContent?.includes(label))!;
  expect(item).toBeTruthy();
  await act(async () => item.click());
  await act(async () => settle(0));
};
const type = async (name: string, text: string) => {
  const field = input(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
};
const pressSend = async (name: string) => {
  await act(async () => tree(name).querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await act(async () => settle(10));
};
const pressEnter = async (name: string) => {
  await act(async () => input(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(async () => settle(10));
};
const switchTo = async (path: string) => {
  await act(async () => { void handles["main"]!.actions.openSession(path); });
  await act(async () => settle(20));
  expect(probe("main").dataset["current"]).toBe(path);
};

/** The person's tentative choice on a pristine session: reviewer, thinking high. */
const chooseReviewerHigh = async (name = "main") => {
  await chooseAgent(name, "reviewer");
  await chooseThinking(name, "high");
  expect(agentLabel(name)).toBe("Agent: reviewer");
  expect(modelLabel(name)).toBe("Model: gpt-big");
  expect(thinkingLabel(name)).toBe("Thinking: high");
};

describe("a refused first-turn prompt (U1)", () => {
  it("keeps model intent absent when only thinking was chosen", async () => {
    world.states[A] = { ...world.states[A]!, model: { provider: "openai", id: "gpt-big" } };
    await mount();
    await chooseThinking("main", "high");
    const firstTurn = firstTurnFromRunConfig(composerState("main").runConfig);
    expect(firstTurn).toEqual({ agentName: "default", thinkingLevel: "high" });
    expect(Object.hasOwn(firstTurn!, "model")).toBe(false);
    expect(modelLabel("main")).toBe("Model: gpt-big");
  });

  it("shows the selected agent model immediately, lets a later model win, and resets it on another agent choice", async () => {
    world.overrides["pi/model/list"] = (() => ({ models: [
      { provider: "openai", id: "gpt-fast", name: "GPT Fast" },
      { provider: "openai", id: "gpt-big", name: "GPT Big" },
    ] })) as never;
    await mount();
    expect(modelLabel("main")).toBe("Model: gpt-fast");

    await chooseAgent("main", "reviewer");
    expect(modelLabel("main")).toBe("Model: gpt-big");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({ agentName: "reviewer", model: null });

    await chooseModel("main", "GPT Fast");
    expect(modelLabel("main")).toBe("Model: GPT Fast");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({
      agentName: "reviewer",
      model: { provider: "openai", id: "gpt-fast", name: "GPT Fast" },
    });
    expect(calls("pi/model/set")).toEqual([]);

    await chooseAgent("main", agentDisplayName("default"));
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({ agentName: "default", model: null });
    expect(modelLabel("main")).toBe("Model: GPT Fast");
  });

  it("forwards a later explicit model choice on the first request", async () => {
    world.catalog.push({ provider: "openai", id: "gpt-alt", name: "GPT Alternate", enabled: true, thinkingLevels: ["off", "high"] });
    world.overrides["pi/model/list"] = (() => ({ models: [
      { provider: "openai", id: "gpt-fast", name: "GPT Fast" },
      { provider: "openai", id: "gpt-big", name: "GPT Big" },
      { provider: "openai", id: "gpt-alt", name: "GPT Alternate" },
    ] })) as never;
    await mount();
    await chooseAgent("main", "reviewer");
    await chooseModel("main", "GPT Alternate");
    await chooseThinking("main", "high");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({
      agentName: "reviewer",
      model: { provider: "openai", id: "gpt-alt", name: "GPT Alternate" },
      thinkingLevel: "high",
    });
    await type("main", "use my later choice");
    await pressSend("main");

    expect(prompts()).toEqual([{
      path: A,
      content: [{ type: "text", text: "use my later choice" }],
      firstTurn: {
        agentName: "reviewer",
        model: { provider: "openai", id: "gpt-alt", name: "GPT Alternate" },
        thinkingLevel: "high",
      },
    }]);
  });

  it("keeps text and choice on the queue lane, and one corrected Send finishes it", async () => {
    await mount();
    await chooseReviewerHigh();
    await type("main", "Refusal retry draft");
    prompt = refuse;
    await pressSend("main");

    expect(prompts()).toEqual([{ path: A, content: [{ type: "text", text: "Refusal retry draft" }], firstTurn: { agentName: "reviewer", model: null, thinkingLevel: "high" } }]);
    expect(calls("session/new")).toEqual([]);
    expect(probe("main").dataset["messages"]).toBe("0");
    // Everything the person had is still there.
    expect(input("main").value).toBe("Refusal retry draft");
    expect(agentLabel("main")).toBe("Agent: reviewer");
    expect(thinkingLabel("main")).toBe("Thinking: high");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({ agentName: "reviewer", model: null, thinkingLevel: "high" });
    // Told what went wrong, in the worker's words, and what to do next.
    const toasts = probe("main").dataset["toasts"]!;
    expect(toasts).toContain(`error:${WORKER_REFUSAL}`);
    expect(toasts).toContain("Your message is back in the composer — check the agent and thinking choice, then send it again.");

    // The correction and the retry: exactly one more prompt, with the new choice.
    await chooseAgent("main", agentDisplayName("default"));
    expect(agentLabel("main")).toBe(DEFAULT_AGENT_LABEL);
    prompt = () => ({ accepted: true });
    await pressSend("main");
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toEqual({ path: A, content: [{ type: "text", text: "Refusal retry draft" }], firstTurn: { agentName: "default", model: null, thinkingLevel: "off" } });
    expect(calls("session/new")).toEqual([]);
    expect(input("main").value).toBe("");
    expect(composerState("main").isEmpty).toBe(true);
    expect(probe("main").dataset["messages"]).toBe("1");
  });

  it("keeps text and choice on the steer lane and through Enter", async () => {
    await mount();
    await chooseReviewerHigh();
    await type("main", "steered draft");
    prompt = refuse;
    await act(async () => handles["main"]!.aui.composer.send({ steer: true }));
    await act(async () => settle(10));
    expect(calls("pi/session/steer")).toEqual([]);
    expect(prompts()).toHaveLength(1);
    expect(input("main").value).toBe("steered draft");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({ agentName: "reviewer", model: null, thinkingLevel: "high" });

    // The keyboard path takes the queue lane; the same message comes back.
    await pressEnter("main");
    expect(prompts()).toHaveLength(2);
    expect(input("main").value).toBe("steered draft");
    expect(agentLabel("main")).toBe("Agent: reviewer");
  });

  it("brings an image attachment back with the text, and sends both on the retry", async () => {
    await mount();
    await chooseReviewerHigh();
    await act(async () => handles["main"]!.aui.composer.addAttachment(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })));
    await type("main", "see the picture");
    prompt = refuse;
    await pressSend("main");

    expect(prompts()[0]?.content).toEqual([
      { type: "text", text: "see the picture" },
      { type: "image", mimeType: "image/png", data: "AQID" },
    ]);
    const restored = composerState("main").attachments;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ type: "image", name: "shot.png", status: { type: "complete" } });
    expect(input("main").value).toBe("see the picture");
    expect(tree("main").querySelector('[data-slot="composer-attachment"], [data-slot="attachment"]')).toBeTruthy();

    prompt = () => ({ accepted: true });
    await pressSend("main");
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]?.content).toEqual(prompts()[0]?.content);
    expect(composerState("main").attachments).toHaveLength(0);
    expect(input("main").value).toBe("");
  });

  it("never writes over what the person typed while the refusal was in flight", async () => {
    await mount();
    await chooseReviewerHigh();
    await type("main", "first draft");
    let reject!: (error: Error) => void;
    prompt = () => new Promise((_resolve, fail) => { reject = fail; });
    await pressSend("main");
    expect(input("main").value).toBe("");
    await type("main", "second thought");
    await act(async () => { reject(new Error(WORKER_REFUSAL)); await settle(10); });

    expect(input("main").value).toBe("second thought");
    expect(probe("main").dataset["toasts"]).toContain(`error:${WORKER_REFUSAL}`);
    expect(probe("main").dataset["toasts"]).not.toContain("back in the composer");
    // The choice is still the person's to correct.
    expect(agentLabel("main")).toBe("Agent: reviewer");
  });

  it("restores nothing after the worker accepted, whatever goes wrong later", async () => {
    await mount();
    await chooseReviewerHigh();
    await type("main", "accepted");
    await pressSend("main");
    expect(prompts()).toHaveLength(1);
    expect(input("main").value).toBe("");
    expect(probe("main").dataset["messages"]).toBe("1");

    // The turn fails later, and so does an unrelated request: neither is a refusal of that message.
    await act(async () => {
      FakeHostClient.current.notify("session/update", { sessionPath: A, seq: 1, at: "2026-09-11T00:00:00.000Z", update: { kind: "extension_error", extension: "sandbox", message: "The provider is not reachable." } });
    });
    world.overrides["session/cancel"] = (() => Promise.reject(new Error("The worker went away."))) as never;
    await act(async () => { await handles["main"]!.aui.thread.cancelRun(); await settle(10); });
    expect(input("main").value).toBe("");
    expect(composerState("main").isEmpty).toBe(true);
    // The sent message is still in the transcript (the failed turn adds its own notice beside it).
    expect(Number(probe("main").dataset["messages"])).toBeGreaterThanOrEqual(1);
  });

  it("leaves the other mounted composer alone: the session's own and Beam's, each way round", async () => {
    await mount({ withBeam: true });
    expect(probe("beam").dataset["current"]).toBe(BEAM);
    await chooseReviewerHigh();
    await type("main", "main draft");
    await type("beam", "beam draft");

    prompt = ({ path }) => (path === A ? refuse() : { accepted: true });
    await pressSend("main");
    expect(prompts(A)).toHaveLength(1);
    expect(prompts(BEAM)).toHaveLength(0);
    expect(input("main").value).toBe("main draft");
    expect(input("beam").value).toBe("beam draft");
    expect(agentLabel("main")).toBe("Agent: reviewer");

    prompt = ({ path }) => (path === BEAM ? refuse() : { accepted: true });
    await pressSend("beam");
    expect(prompts(BEAM)).toHaveLength(1);
    expect(input("beam").value).toBe("beam draft");
    expect(input("main").value).toBe("main draft");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toEqual({ agentName: "reviewer", model: null, thinkingLevel: "high" });
    expect(firstTurnFromRunConfig(composerState("beam").runConfig)).toBeUndefined();
  });
});

describe("leaving a pristine session (U2)", () => {
  it("discards only the tentative choice on a real A→B→A switch; the draft and the rest of the run config stay", async () => {
    await mount();
    const initialThinking = thinkingLabel("main");
    expect(agentLabel("main")).toBe(DEFAULT_AGENT_LABEL);
    await chooseReviewerHigh();
    await act(async () => handles["main"]!.aui.composer.setRunConfig(mergeRunConfigCustom(composerState("main").runConfig, { retained: "yes" })));
    await type("main", "tentative draft");

    await switchTo(B);
    // The session arrived at shows its own, canonical state.
    expect(agentLabel("main")).toBe(DEFAULT_AGENT_LABEL);
    expect(thinkingLabel("main")).toBe(initialThinking);
    expect(input("main").value).toBe("");
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toBeUndefined();

    await switchTo(A);
    expect(agentLabel("main")).toBe(DEFAULT_AGENT_LABEL);
    expect(thinkingLabel("main")).toBe(initialThinking);
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toBeUndefined();
    expect(composerState("main").runConfig.custom?.["retained"]).toBe("yes");
    expect(input("main").value).toBe("tentative draft");
    expect(prompts()).toEqual([]);
  });

  it("a refusal that lands after the person moved on restores nothing into the session they arrived at", async () => {
    await mount();
    await chooseReviewerHigh();
    await type("main", "sent from A");
    let reject!: (error: Error) => void;
    prompt = () => new Promise((_resolve, fail) => { reject = fail; });
    await pressSend("main");
    expect(prompts()).toHaveLength(1);

    await switchTo(B);
    await act(async () => { reject(new Error(WORKER_REFUSAL)); await settle(10); });
    // B: untouched, canonical.
    expect(input("main").value).toBe("");
    expect(agentLabel("main")).toBe(DEFAULT_AGENT_LABEL);
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toBeUndefined();
    expect(probe("main").dataset["toasts"]).toContain(`error:${WORKER_REFUSAL}`);

    // A: the ordinary draft is where drafts live; the tentative choice is gone.
    await switchTo(A);
    expect(input("main").value).toBe("sent from A");
    expect(agentLabel("main")).toBe(DEFAULT_AGENT_LABEL);
    expect(firstTurnFromRunConfig(composerState("main").runConfig)).toBeUndefined();
    expect(prompts()).toHaveLength(1);
  });
});
