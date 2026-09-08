// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DEFAULT_TOOLS, type AgentDefinition, type AgentDefinitionInput, type AgentIssue, type AgentsSnapshot, type NamerState } from "@lasercode/protocol";

import { initialState, reduce, type AppState } from "../../../src/store.js";
import { agent, snapshot } from "../fixtures.js";

/**
 * The state hooks run over a real store (`LaserStoreProvider`); only the
 * stable half of the provider — the client and the actions — is a fake, so
 * every host answer is scripted here and every mutation folds a new snapshot
 * into the store the way the real actions do.
 */
const mocks = vi.hoisted(() => {
  const state = { store: undefined as undefined | { dispatch(action: unknown): void; getSnapshot(): unknown }, issues: [] as AgentIssue[] };
  const current = (): AgentsSnapshot => (state.store!.getSnapshot() as { agents: { snapshot: AgentsSnapshot } }).agents.snapshot;
  const publish = (next: AgentsSnapshot) => state.store!.dispatch({ type: "agents/updated", snapshot: next });
  const agents = {
    refresh: vi.fn(async () => undefined),
    validate: vi.fn(async (_input: AgentDefinitionInput) => state.issues),
    save: vi.fn(async (input: AgentDefinitionInput): Promise<AgentDefinition> => {
      const snap = current();
      const saved: AgentDefinition = { ...input, kind: "custom", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" };
      publish({ ...snap, revision: snap.revision + 1, agents: [...snap.agents.filter((a) => a.name !== input.name), saved] });
      return saved;
    }),
    remove: vi.fn(async (name: string) => {
      const snap = current();
      publish({ ...snap, revision: snap.revision + 1, agents: snap.agents.filter((a) => a.name !== name) });
    }),
    setDefault: vi.fn(async (name: string) => {
      const snap = current();
      publish({ ...snap, revision: snap.revision + 1, defaultAgent: name });
    }),
    setPolicy: vi.fn(async () => undefined),
    skills: vi.fn(async () => ({ skills: [{ name: "review", path: "/p/skills/review/SKILL.md", scope: "project" as const }], roots: [{ path: "/p/skills", scope: "project" as const, exists: true }] })),
    engineInstructions: vi.fn(async () => "You are the engine's default agent."),
    runs: vi.fn(async () => undefined),
    stopRun: vi.fn(),
    setBeamModel: vi.fn(async () => undefined),
    setNamerModel: vi.fn(async () => undefined),
    qualifyNamer: vi.fn(async (): Promise<NamerState> => ({ status: "ready", model: { provider: "openai", id: "mini" }, candidates: [{ model: { provider: "openai", id: "mini" }, latencyMs: 300, valid: true }] })),
    dismissBeamChoice: vi.fn(),
  };
  const request = vi.fn(async (method: string) => {
    if (method === "pi/models/catalog") return { models: [{ provider: "openai", id: "gpt-5", name: "GPT-5", thinkingLevels: ["off", "low", "high"], enabled: true }], enabledPatterns: null, refreshedAt: "", errors: [] };
    if (method === "feature/list") return { features: [{ manifest: { id: "web-search" }, enabled: false }] };
    throw new Error(`unexpected ${method}`);
  });
  const stable = { client: { request }, currentProject: "/p", actions: { agents, toast: vi.fn(), newSession: vi.fn(async () => "/p/new.jsonl") } };
  return { state, agents, request, stable };
});

vi.mock("../../../src/runtime/LaserProvider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/runtime/LaserProvider.js")>()),
  useLaserStable: () => mocks.stable,
}));

import { AgentsScreen } from "../../../src/components/agents/page/AgentsScreen.js";
import { AgentsButton } from "../../../src/components/agents/page/AgentsButton.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { WorkbenchProvider, useWorkbench, type AgentsTarget } from "../../../src/components/workbench/index.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../../src/runtime/LaserProvider.js";

let container: HTMLDivElement;
let root: Root;
let store: StateStore;

const seed = (snap: AgentsSnapshot): AppState => reduce(initialState, { type: "agents/loaded", snapshot: snap });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store = createStateStore(seed(snapshot()));
  mocks.state.store = store;
  mocks.state.issues = [];
  for (const fn of Object.values(mocks.agents)) fn.mockClear();
  mocks.request.mockClear();
  mocks.stable.actions.toast.mockClear();
  mocks.stable.actions.newSession.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

let workbench: ReturnType<typeof useWorkbench> | undefined;
function WorkbenchProbe() {
  workbench = useWorkbench();
  return null;
}

async function mount(props: { cwd?: string | undefined; target?: AgentsTarget | undefined } = {}) {
  await act(async () =>
    root.render(
      <LaserStoreProvider store={store}>
        <TooltipProvider>
          <WorkbenchProvider>
            <WorkbenchProbe />
            <AgentsScreen cwd={"cwd" in props ? props.cwd : "/p"} target={props.target} />
          </WorkbenchProvider>
        </TooltipProvider>
      </LaserStoreProvider>,
    ),
  );
}

const q = <T extends Element = HTMLElement>(selector: string): T => {
  const el = container.querySelector<T>(selector) ?? document.body.querySelector<T>(selector);
  if (!el) throw new Error(`Nothing matches ${selector}`);
  return el;
};
const qa = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const button = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
};
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const blur = (el: Element) => act(async () => el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const settle = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const row = (name: string) => q(`[data-slot="agent-row"][data-agent="${name}"]`);

describe("Agents page", () => {
  it("lists your agents first and the built-ins at the bottom, with the default and warning badges", async () => {
    store = createStateStore(seed(snapshot({ warnings: [{ agentName: "reviewer", field: "skills", target: "deploy", message: "The skill deploy could not be found.", since: "2026-09-08T00:00:00.000Z" }] })));
    mocks.state.store = store;
    await mount();
    expect(qa('[data-slot="agent-row"]').map((r) => r.dataset.agent)).toEqual(["default", "reviewer", "beam", "chat", "namer"]);
    expect(row("default").querySelector('[data-slot="agent-default-badge"]')?.textContent).toBe("Default");
    expect(row("reviewer").querySelector('[data-slot="agent-warning-badge"]')?.textContent).toBe("1");
    expect(row("beam").querySelector('[data-slot="agent-warning-badge"]')).toBeNull();
    const builtin = q('[data-slot="agent-group"][aria-label="Built in"]');
    expect([...builtin.querySelectorAll('[data-slot="agent-row"]')].map((r) => (r as HTMLElement).dataset.agent)).toEqual(["beam", "chat", "namer"]);
    // The overview stands in for the editor until something is chosen; it names the default and the warning.
    expect(q('[data-slot="agents-overview"]').textContent).toContain("Default agent");
    expect(q('[data-slot="overview-warning"]').textContent).toContain("deploy");
    expect(q('[role="listbox"][aria-label="Agents"]')).toBeTruthy();
  });

  it("moves between rows with the arrow keys and selects with Enter", async () => {
    await mount();
    const first = row("default");
    first.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(row("reviewer"));
    await act(async () => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(q('[data-slot="harness-row"]'));
    await click(row("reviewer"));
    expect(row("reviewer").getAttribute("aria-selected")).toBe("true");
    expect(q('[data-slot="agent-editor"]').dataset.agent).toBe("reviewer");
  });

  it("creates an agent from the form and sends the definition to save", async () => {
    await mount();
    await click(q('[data-slot="agents-new"]'));
    const editor = q<HTMLFormElement>('[data-slot="agent-editor"]');
    expect(editor.dataset.agent).toBe("");
    await type(editor.querySelector<HTMLInputElement>('input[name="name"]')!, "Code Reviewer");
    expect(editor.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe("code-reviewer");
    await type(editor.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!, "Reviews a diff");
    await type(editor.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!, "Read every changed file.");
    // "Can start other agents" reveals the definitions it may start.
    expect(editor.querySelector('[data-slot="allowed-agents"]')).toBeNull();
    await click(q('[role="switch"][aria-label="Can start other agents"]'));
    const allowed = editor.querySelector('[data-slot="allowed-agents"]')!;
    expect([...allowed.querySelectorAll<HTMLInputElement>("input")].map((i) => i.name)).toEqual(["allowed:default", "allowed:reviewer"]);
    await click(allowed.querySelector<HTMLInputElement>('input[name="allowed:default"]')!);
    // Web search is off, so the tool says what it needs.
    await settle();
    expect(editor.querySelector('input[name="tool:web_search"]')!.closest("label")!.textContent).toContain("Needs the Web search feature");
    // The host is asked on blur; with no issues the form can be saved.
    await blur(editor.querySelector('textarea[name="instructions"]')!);
    await settle();
    expect(mocks.agents.validate).toHaveBeenCalled();
    const save = button("Create agent");
    expect(save.disabled).toBe(false);
    await click(save);
    await settle();
    expect(mocks.agents.save).toHaveBeenCalledTimes(1);
    const input = mocks.agents.save.mock.calls[0]![0];
    expect(input).toMatchObject({
      name: "code-reviewer",
      description: "Reviews a diff",
      instructions: "Read every changed file.",
      engineInstructions: false,
      supportsSubagents: true,
      allowedAgents: ["reviewer"],
      scopedSkills: false,
      skills: [],
      model: null,
      runTimeoutMinutes: null,
    });
    expect(input.tools).toEqual([...AGENT_DEFAULT_TOOLS]);
    // The saved agent is now selected and listed among yours.
    expect(q('[data-slot="agent-editor"]').dataset.agent).toBe("code-reviewer");
    expect(qa('[data-slot="agent-row"]').map((r) => r.dataset.agent)).toEqual(["default", "code-reviewer", "reviewer", "beam", "chat", "namer"]);
    expect(mocks.stable.actions.toast).toHaveBeenCalledWith("info", "code-reviewer saved.");
  });

  it("blocks save on a validation issue and shows it at the field", async () => {
    mocks.state.issues = [{ field: "name", message: "An agent with this name already exists." }];
    await mount();
    await click(q('[data-slot="agents-new"]'));
    const editor = q<HTMLFormElement>('[data-slot="agent-editor"]');
    const name = editor.querySelector<HTMLInputElement>('input[name="name"]')!;
    await type(name, "reviewer");
    await blur(name);
    await settle();
    const issue = editor.querySelector("#agent-field-name [data-slot='agent-field-issue']");
    expect(issue?.textContent).toContain("An agent with this name already exists.");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(button("Create agent").disabled).toBe(true);
    // Cmd+S does nothing while the issue stands.
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true })));
    expect(mocks.agents.save).not.toHaveBeenCalled();
    // Once the host is happy, it saves.
    mocks.state.issues = [];
    await type(name, "reviewer-2");
    await blur(name);
    await settle();
    expect(editor.querySelector("[data-slot='agent-field-issue']")).toBeNull();
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true })));
    await settle();
    expect(mocks.agents.save).toHaveBeenCalledTimes(1);
  });

  it("maps a rejected save back to its field, or shows the message inline", async () => {
    await mount();
    await click(row("reviewer"));
    const editor = q<HTMLFormElement>('[data-slot="agent-editor"]');
    await type(editor.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!, "Changed");
    await blur(editor.querySelector('textarea[name="description"]')!);
    await settle();
    // The host refuses with a field: the message lands there, not in a toast.
    mocks.agents.save.mockRejectedValueOnce(Object.assign(new Error("That agent definition is not valid."), { data: { issues: [{ field: "description", message: "Too long." }] } }));
    await click(button("Save"));
    await settle();
    expect(editor.querySelector("#agent-field-description [data-slot='agent-field-issue']")?.textContent).toContain("Too long.");
    // A plain failure shows inline with a retry.
    mocks.state.issues = [];
    await type(editor.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!, "Changed again");
    await settle(400);
    mocks.agents.save.mockRejectedValueOnce(new Error("Not connected to the host."));
    await click(button("Save"));
    await settle();
    expect(editor.querySelector('[data-slot="agent-editor-footer"] [role="alert"]')?.textContent).toContain("Not connected to the host.");
    expect(mocks.stable.actions.toast).not.toHaveBeenCalledWith("error", expect.anything());
  });

  it("keeps the default agent undeletable with the reason, until another agent is the default", async () => {
    await mount();
    await click(row("default"));
    const del = button("Delete");
    expect(del.disabled).toBe(true);
    expect(q('[data-slot="agent-delete-reason"]').textContent).toContain("Make another agent the default first");
    // The default toggle is on and cannot be switched off here.
    const toggle = q<HTMLButtonElement>('[role="switch"][aria-label="Default for new sessions"]');
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(true);
    // Elsewhere, reviewer becomes the default.
    await act(async () => store.dispatch({ type: "agents/updated", snapshot: { ...snapshot(), revision: 2, defaultAgent: "reviewer" } }));
    expect(button("Delete").disabled).toBe(false);
    expect(container.querySelector('[data-slot="agent-delete-reason"]')).toBeNull();
    expect(row("reviewer").querySelector('[data-slot="agent-default-badge"]')).not.toBeNull();
    expect(row("default").querySelector('[data-slot="agent-default-badge"]')).toBeNull();
    await click(button("Delete"));
    const dialog = q('[data-slot="delete-agent-dialog"]');
    expect(dialog.textContent).toContain("Delete Default agent?");
    expect(dialog.textContent).toContain("Sessions that used it keep their history.");
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete")!);
    await settle();
    expect(mocks.agents.remove).toHaveBeenCalledWith("default");
    expect(qa('[data-slot="agent-row"]').map((r) => r.dataset.agent)).toEqual(["reviewer", "beam", "chat", "namer"]);
    expect(q('[data-slot="agents-overview"]')).toBeTruthy();
  });

  it("makes an agent the default from its editor", async () => {
    await mount();
    await click(row("reviewer"));
    const toggle = q<HTMLButtonElement>('[role="switch"][aria-label="Default for new sessions"]');
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    await settle();
    expect(mocks.agents.setDefault).toHaveBeenCalledWith("reviewer");
    expect(q<HTMLButtonElement>('[role="switch"][aria-label="Default for new sessions"]').getAttribute("aria-checked")).toBe("true");
  });

  it("opens a deep link at the skills section and focuses the missing skill notice", async () => {
    const warning = { agentName: "reviewer", field: "skills" as const, target: "deploy", message: "The skill deploy could not be found.", since: "2026-09-08T00:00:00.000Z" };
    const reviewer = agent({ name: "reviewer", scopedSkills: true, skills: [{ name: "deploy", path: "/p/skills/deploy/SKILL.md", scope: "project" }] });
    store = createStateStore(seed(snapshot({ warnings: [warning], agents: [agent({ name: "default" }), reviewer, agent({ name: "beam", kind: "builtin" }), agent({ name: "chat", kind: "builtin" }), agent({ name: "namer", kind: "builtin" })] })));
    mocks.state.store = store;
    await mount({ target: { agent: "reviewer", field: "skills" } });
    await settle(50);
    expect(q('[data-slot="agent-editor"]').dataset.agent).toBe("reviewer");
    const section = q("#agent-field-skills");
    const notice = section.querySelector<HTMLElement>('[data-slot="agent-field-notice"]')!;
    expect(notice.textContent).toContain("deploy");
    expect(notice.textContent).toContain("could not be found");
    expect(document.activeElement).toBe(notice);
    // The picker lists what the engine finds and flags the chosen skill it cannot.
    const missing = section.querySelector('[data-slot="skill-missing"][data-skill="deploy"]')!;
    expect(missing.textContent).toContain("Choose it again or remove it");
    expect(section.querySelector('input[name="skill:/p/skills/review/SKILL.md"]')).not.toBeNull();
    expect(q('[data-slot="agent-editor"] [data-slot="agent-warning-badge"]').textContent).toBe("1 warning");
    // Removing it clears the missing row and makes the form dirty, so it can be saved.
    expect(button("Save").disabled).toBe(true);
    await click([...missing.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Remove")!);
    expect(section.querySelector('[data-slot="skill-missing"]')).toBeNull();
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    await settle();
    expect(mocks.agents.save.mock.calls[0]?.[0].skills).toEqual([]);
  });

  it("asks before leaving an editor with unsaved changes", async () => {
    await mount();
    await click(row("reviewer"));
    await type(q<HTMLTextAreaElement>('textarea[name="description"]'), "Edited");
    await click(row("default"));
    const dialog = q('[data-slot="discard-changes-dialog"]');
    expect(dialog.textContent).toContain("Discard changes?");
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Keep editing")!);
    expect(q('[data-slot="agent-editor"]').dataset.agent).toBe("reviewer");
    expect(q<HTMLTextAreaElement>('textarea[name="description"]').value).toBe("Edited");
    await click(row("default"));
    await click([...q('[data-slot="discard-changes-dialog"]').querySelectorAll("button")].find((b) => b.textContent?.trim() === "Discard")!);
    expect(q('[data-slot="agent-editor"]').dataset.agent).toBe("default");
  });

  it("edits the default agent from the engine's instructions", async () => {
    await mount();
    await click(row("default"));
    const editor = q<HTMLFormElement>('[data-slot="agent-editor"]');
    await settle();
    expect(editor.querySelector('[data-slot="engine-instructions"]')?.textContent).toContain("You are the engine's default agent.");
    expect(mocks.agents.engineInstructions).toHaveBeenCalledWith("/p");
    await click(button("Customize"));
    const instructions = editor.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!;
    expect(instructions.value).toBe("You are the engine's default agent.");
    expect(button("Use the built-in instructions again")).toBeTruthy();
    await click(button("Use the built-in instructions again"));
    expect(editor.querySelector('[data-slot="engine-instructions"]')).not.toBeNull();
  });

  it("starts a chat with an agent in the open project and closes the workbench", async () => {
    await mount();
    await act(async () => workbench!.open("agents"));
    await click(row("reviewer"));
    await click(button("Start chat"));
    await settle();
    expect(mocks.stable.actions.newSession).toHaveBeenCalledWith("/p", { agentName: "reviewer" });
    expect(workbench?.page).toBeNull();
  });

  it("disables Start chat with a reason when no project is open, and still reads the catalog through the Beam workspace", async () => {
    await mount({ cwd: undefined });
    await click(row("reviewer"));
    expect(button("Start chat").disabled).toBe(true);
    expect(button("Start chat").getAttribute("aria-describedby")).toBeTruthy();
    await settle();
    expect(mocks.request).toHaveBeenCalledWith("pi/models/catalog", { cwd: "/state/beam" });
  });

  it("shows Namer's qualification states and runs the check", async () => {
    await mount();
    await click(row("namer"));
    const card = () => q('[data-slot="agent-card"][data-agent="namer"]');
    expect(card().dataset.namerStatus).toBe("unqualified");
    expect(card().textContent).toContain("Not qualified yet");
    await act(async () => store.dispatch({ type: "agents/updated", snapshot: { ...snapshot(), revision: 2, namer: { status: "qualifying", model: null, candidates: [] } } }));
    expect(card().dataset.namerStatus).toBe("qualifying");
    expect(card().textContent).toContain("Qualifying…");
    await act(async () =>
      store.dispatch({
        type: "agents/updated",
        snapshot: {
          ...snapshot(),
          revision: 3,
          namer: {
            status: "ready",
            model: { provider: "openai", id: "mini" },
            qualifiedAt: "2026-09-08T10:00:00.000Z",
            candidates: [
              { model: { provider: "openai", id: "mini" }, latencyMs: 312, valid: true },
              { model: { provider: "anthropic", id: "haiku" }, latencyMs: 1480, valid: false, error: "Name too long" },
            ],
          },
        },
      }),
    );
    expect(card().dataset.namerStatus).toBe("ready");
    expect(card().textContent).toContain("openai/mini");
    expect(card().textContent).toContain("312 ms on the check");
    const rows = [...card().querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("312 ms");
    expect(rows[0]?.textContent).toContain("Yes");
    expect(rows[1]?.textContent).toContain("1.5 s");
    expect(rows[1]?.textContent).toContain("No");
    await act(async () => store.dispatch({ type: "agents/updated", snapshot: { ...snapshot(), revision: 4, namer: { status: "unavailable", model: null, candidates: [], reason: "No provider is connected." } } }));
    expect(card().textContent).toContain("Unavailable");
    expect(card().textContent).toContain("No provider is connected.");
    await click(button("Run qualification again"));
    await settle();
    expect(mocks.agents.qualifyNamer).toHaveBeenCalledWith("/p");
    expect(card().textContent).toContain("openai/mini");
  });

  it("changes Beam's model through the provider-first picker", async () => {
    await mount();
    await click(row("beam"));
    const card = q('[data-slot="agent-card"][data-agent="beam"]');
    expect(card.textContent).toContain("Not chosen yet");
    await click(button("Choose a model"));
    const dialog = q('[data-slot="beam-model-dialog"]');
    expect(dialog.textContent).toContain("Beam's model");
    await settle();
    // The same provider-first picker every agent uses, empty until a model is picked.
    expect(dialog.querySelector('[data-slot="model-selector-trigger"]')?.textContent).toContain("Choose a model");
    expect([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Use this model")?.disabled).toBe(true);
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel")!);
    expect(document.body.querySelector('[data-slot="beam-model-dialog"]')).toBeNull();
  });

  it("saves the harness limits when a field is committed, and refuses a value out of range", async () => {
    await mount();
    await click(q('[data-slot="harness-row"]'));
    const depth = q<HTMLInputElement>('input[data-policy="maxDepth"]');
    await type(depth, "9");
    await act(async () => depth.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(q('#agent-field-policy-maxDepth [data-slot="agent-field-issue"]').textContent).toContain("Between 1 and 6");
    expect(mocks.agents.setPolicy).not.toHaveBeenCalled();
    await type(depth, "4");
    await act(async () => depth.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(mocks.agents.setPolicy).toHaveBeenCalledWith({ maxDepth: 4 });
  });

  it("marks the rail button with the warning count and opens the page", async () => {
    store = createStateStore(seed(snapshot({ warnings: [{ agentName: "reviewer", field: "model", message: "The model is gone.", since: "2026-09-08T00:00:00.000Z" }] })));
    mocks.state.store = store;
    await act(async () =>
      root.render(
        <LaserStoreProvider store={store}>
          <TooltipProvider>
            <WorkbenchProvider>
              <WorkbenchProbe />
              <AgentsButton side="right" />
            </WorkbenchProvider>
          </TooltipProvider>
        </LaserStoreProvider>,
      ),
    );
    const btn = q<HTMLButtonElement>('[data-slot="agents-button"]');
    expect(btn.getAttribute("aria-label")).toBe("Agents · 1 warning");
    expect(btn.dataset.warnings).toBe("1");
    expect(btn.querySelector('[data-slot="agents-warning-mark"]')).not.toBeNull();
    await click(btn);
    expect(workbench?.page).toBe("agents");
    expect(btn.getAttribute("aria-current")).toBe("page");
  });

  it("shows the first-run card when only the default agent exists, and a retryable error when the list failed", async () => {
    store = createStateStore(seed(snapshot({ agents: [agent({ name: "default" }), agent({ name: "beam", kind: "builtin" }), agent({ name: "chat", kind: "builtin" }), agent({ name: "namer", kind: "builtin" })] })));
    mocks.state.store = store;
    await mount();
    expect(q('[data-slot="agents-overview"]').dataset.firstRun).toBe("true");
    await click(q('[data-slot="overview-new"]'));
    expect(q('[data-slot="agent-editor"]').dataset.agent).toBe("");
    await act(async () => root.unmount());
    root = createRoot(container);
    store = createStateStore(reduce(initialState, { type: "agents/error", error: "Not connected to the host." }));
    mocks.state.store = store;
    await mount();
    expect(q('[data-slot="agents-screen"]').dataset.state).toBe("error");
    expect(q('[role="alert"]').textContent).toContain("Not connected to the host.");
    await click(button("Retry"));
    expect(mocks.agents.refresh).toHaveBeenCalled();
  });
});
