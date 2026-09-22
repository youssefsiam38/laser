/**
 * M21-T24 · the two lifecycle legs the host cannot reach.
 *
 * The host owns the artifacts; the worker owns the two steps that read the
 * project itself and the one that puts a mention in front of a model. So this
 * file proves, for the same acceptance scenarios the host file runs:
 *
 * - **Scenario 1, the Design leg of an established React project.** The Design
 *   Index is built from a real copy of the React fixture, parse-only — the
 *   fixture's `tailwind.config.js` and `postcss.config.js` write marker files
 *   when they are executed, and the markers never appear — and a Sketch
 *   grounds into a Tree whose Mapped nodes name entries that build really
 *   produced, with nothing executable surviving.
 * - **Scenario 2, the Design leg of an established non-React project.** The
 *   same build on a Rails fixture reports Rails, not React, names the
 *   project's own templates, and neither the index nor a grounded Tree
 *   invents a React component.
 * - **Scenario 7, the model's half of a cross-project mention.** A real
 *   `WorkerServer` carries the host's projection to the driver, and the
 *   session's mention context renders it as a provenance-labelled block
 *   beside that exact message — which is the packet the model reads.
 *
 * No model runs, no process is started and nothing leaves the machine.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DESIGN_KIT_PRIMITIVES,
  validateDesignBody,
  type ContentBlock,
  type DesignIndex,
  type DesignIndexEntry,
  type JsonRpcMessage,
  type ProjectWorkMentionProjection,
  type SessionState,
} from "@lasercode/protocol";
import { groundSketch } from "../../src/design/sketch/ground.js";
import { groundHostPage } from "../../src/design/host/ground.js";
import { scanHostFiles } from "../../src/design/host/files.js";
import { WorkerServer } from "../../src/server.js";
import type { DriverEvent, DriverListener, PromptOptions, QueuedSendOptions, SessionDriver } from "../../src/driver.js";
import type { SessionMentionContext } from "../../src/project-work/mentions.js";
import { buildFixture, cleanupFixtures, FIXTURE_ROOT } from "../design/helpers.js";

afterAll(cleanupFixtures);

const componentsOf = (index: DesignIndex): DesignIndexEntry[] => index.entries.filter((entry) => entry.kind === "component");

// ===========================================================================
// 1 · the Design leg of an established React project
// ===========================================================================

describe("1 · an established React project indexes parse-only and grounds a sketch", () => {
  it("reads the real project, runs none of it, and produces a Tree whose Mapped nodes name real entries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { index, projectCwd } = await buildFixture("react-tailwind");

    // Parse-only, by the fixture's own side-effect markers (D-353).
    expect(existsSync(join(projectCwd, "EVALUATED-tailwind")), "the Tailwind config was read, never run").toBe(false);
    expect(existsSync(join(projectCwd, "EVALUATED-postcss")), "the PostCSS config was read, never run").toBe(false);
    expect(fetchSpy, "the Design phase never leaves the machine").not.toHaveBeenCalled();

    // The stack is what the manifest says, and the entries are this project's.
    expect(index.stack.frameworks).toContain("React");
    const button = componentsOf(index).find((entry) => entry.name === "Button");
    expect(button, "the project's own Button is in the index").toBeDefined();
    expect(button!.sources[0]?.path).toBe("src/components/Button.tsx");

    // A Sketch — untrusted text, script and all — grounds into a Tree.
    const sketch = `<!doctype html><html><body>
      <main class="page">
        <h1>Orders</h1>
        <button class="Button">Refresh</button>
        <canvas id="sparkline"></canvas>
      </main>
      <script>document.querySelector('.Button').addEventListener('click', () => location.reload());</script>
    </body></html>`;
    const grounded = groundSketch({ document: sketch, index });
    const nodes = "tree" in grounded.screen.content ? grounded.screen.content.tree.nodes : [];
    const mapped = nodes.filter((node) => "indexEntryId" in node.component);
    expect(mapped.map((node) => ("indexEntryId" in node.component ? node.component.indexEntryId : "")), "Mapped means an entry this build produced").toContain(
      button!.id,
    );
    expect(mapped.every((node) => node.fidelity === "mapped")).toBe(true);
    // What the index cannot account for is Proposed and listed, never quietly
    // presented as the project's own.
    expect(nodes.filter((node) => "primitive" in node.component).every((node) => node.fidelity === "proposed")).toBe(true);
    expect(grounded.unmapped.some((part) => part.what === "<canvas>")).toBe(true);
    // Nothing executable survives the climb from Sketch to Tree (D-354).
    const serialized = JSON.stringify(grounded);
    expect(serialized).not.toContain("addEventListener");
    expect(serialized).not.toContain("<script");

    const validation = validateDesignBody(
      { brief: "The orders page", screens: [grounded.screen], flows: [], sketches: [], fidelity: grounded.screen.fidelity, fixtures: [] },
      { primitives: DESIGN_KIT_PRIMITIVES, entryIds: index.entries.map((entry) => entry.id) },
    );
    expect(validation.issues, "the Tree the product's own renderer would accept").toEqual([]);
  });
});

// ===========================================================================
// 2 · the Design leg of an established non-React project
// ===========================================================================

describe("2 · an established non-React project is reported honestly", () => {
  it("names Rails and its real templates, and neither index nor Tree invents a React component", async () => {
    const { index, projectCwd } = await buildFixture("rails-templates");

    expect(index.stack.frameworks).toContain("Rails");
    expect(index.stack.frameworks, "no framework this project does not ship").not.toContain("React");
    expect(index.eras[0]?.roots).toContain("app/views");
    expect(componentsOf(index).every((entry) => !entry.sources.some((source) => source.path.endsWith(".tsx")))).toBe(true);
    expect(existsSync(join(projectCwd, "EVALUATED-tailwind"))).toBe(false);

    // Static host grounding on the same kind of project: the page is the
    // template git holds, and the stack it reports is the one it found.
    const grounded = groundHostPage(scanHostFiles(join(FIXTURE_ROOT, "host-rails")).files, { routeOrPath: "/invoices" });
    expect(grounded.hostPage?.stack).toBe("rails");
    expect(grounded.hostPage?.templatePath).toBe("app/views/invoices/index.html.erb");
    expect(grounded.hostPage?.fidelity, "an outline parsed from real templates is Mapped").toBe("mapped");
    expect(JSON.stringify(grounded.hostPage)).not.toMatch(/\.tsx|react/i);

    // A sketch grounded against this index has nothing to map onto, so every
    // node is Proposed and says so — the honest answer, not a fabrication.
    const sketchTree = groundSketch({ document: "<main><h1>Invoices</h1><button class='Button'>New</button></main>", index });
    const nodes = "tree" in sketchTree.screen.content ? sketchTree.screen.content.tree.nodes : [];
    expect(nodes.every((node) => node.fidelity === "proposed")).toBe(true);
    expect(nodes.every((node) => "primitive" in node.component), "no invented component reference").toBe(true);
  });
});

// ===========================================================================
// 7 · the model's half of a mention
// ===========================================================================

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

function projection(key: string, project: string): ProjectWorkMentionProjection {
  const kind = key.startsWith("SPEC") ? ("spec" as const) : ("task" as const);
  return {
    ref: {
      projectId: `p_${project}`,
      entityId: `e_${key.replace("-", "_")}`,
      revisionId: "r_3",
      kind,
      key,
      label: `${key} title`,
      digest: "8f1c".padEnd(64, "0"),
    },
    key,
    kind,
    title: `${key} title`,
    state: "in_progress",
    provenance: `[from ${project} ${key}@3]`,
    fields: [{ label: "Outcome", value: `${key} outcome` }],
    excerpt: `${key} excerpt`,
  };
}

/** The smallest driver a session opens on, keeping its mention context. */
class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  mentions: SessionMentionContext | undefined;
  private listeners = new Set<DriverListener>();
  private st: SessionState;

  constructor(path: string) {
    this.st = {
      path,
      id: path,
      cwd: "/tmp/fake",
      model: null,
      profile: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }

  async open(options: { mentionContext?: SessionMentionContext }) {
    this.mentions = options.mentionContext;
    return this.st;
  }
  state() {
    return this.st;
  }
  subscribe(listener: DriverListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  /** Exactly the real driver's order: take the identity, then send. */
  private note(route: "direct" | "steer" | "followUp", options?: { projectWork?: readonly ProjectWorkMentionProjection[] }): void {
    const projectWork = options?.projectWork;
    if (!projectWork?.length || !this.mentions) return;
    const id = this.mentions.reserve(projectWork);
    this.mentions.admitted(id, route);
    this.mentions.activate(id);
  }
  async prompt(_content: ContentBlock[], options?: PromptOptions) {
    this.note("direct", options);
    options?.onAccepted?.();
    this.emit({ type: "update", update: { kind: "agent_settled" } });
    return { accepted: true, queued: false };
  }
  async steer(_content: ContentBlock[], options?: QueuedSendOptions) {
    this.note("steer", options);
  }
  async followUp(_content: ContentBlock[], options?: QueuedSendOptions) {
    this.note("followUp", options);
  }
  async clearQueue() {
    return { steering: [], followUp: [] };
  }
  async abort() {}
  async listModels() {
    return [{ provider: "p", id: "m" }];
  }
  async setModel() {
    return this.st;
  }
  async setProfile() {
    return this.st;
  }
  async setThinkingLevel(level: SessionState["thinkingLevel"]) {
    this.st = { ...this.st, thinkingLevel: level };
    return this.st;
  }
  async rename() {}
  async compact() {}
  async navigateTree() {
    return { cancelled: false };
  }
  async fork() {
    return { state: this.st, editorText: "" };
  }
  respondToUi() {}
  async entries() {
    return { entries: [], leafId: null };
  }
  sessionHeader() {
    return null;
  }
  async goalState() {
    return null;
  }
  async commands() {
    return [];
  }
  async prompts() {
    return [];
  }
  async dispose() {
    this.emit({ type: "closed", reason: "disposed" });
  }
}

describe("7 · a mention reaches the packet the model reads", () => {
  it("carries the host's projection, from another project, beside the message that mentioned it", async () => {
    const out: JsonRpcMessage[] = [];
    const drivers: FakeDriver[] = [];
    const server = new WorkerServer({
      cwd: "/tmp/fake",
      createDriver: () => {
        const driver = new FakeDriver(`/tmp/fake/s${String(drivers.length + 1)}.jsonl`);
        drivers.push(driver);
        return driver;
      },
      send: (message) => out.push(message),
    });
    const call = async (id: number, method: string, params?: unknown): Promise<void> => {
      await server.handle({ jsonrpc: "2.0", id, method, params });
    };

    await call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = drivers[0]!;
    const path = driver.state().path;

    // One message mentioning this project's Task and another project's Spec,
    // exactly as the host supplies them after validating both.
    await call(2, "session/prompt", {
      path,
      content: text("Finish @TASK-44 the way @SPEC-7 describes."),
      projectWork: [projection("TASK-44", "acme"), projection("SPEC-7", "beta")],
    });
    // A second message with nothing pinned to it.
    await call(3, "session/prompt", { path, content: text("and nothing else") });

    const blocks = driver.mentions!.blocks([{ role: "user" }, { role: "assistant" }]);
    expect(blocks, "the mention context is what the engine is handed").toHaveLength(1);
    const packet = blocks[0]!.text;
    expect(packet).toContain("[from acme TASK-44@3]");
    expect(packet).toContain("[from beta SPEC-7@3]");
    expect(packet).toContain("TASK-44 outcome");
    // Identity and a bounded projection, never a whole body or an opaque id.
    expect(packet).not.toContain("e_TASK_44");
    expect(packet).not.toContain("8f1c0000");
  });
});
