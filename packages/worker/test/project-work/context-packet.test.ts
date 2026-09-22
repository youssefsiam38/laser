/**
 * M21-T17: the implementation context packet, and the `/design implement`
 * hand-off.
 *
 * Both are text a model reads, so the two properties that matter are the two
 * tested here: **bounds** — a project with two hundred comments costs the
 * same as one with three — and **provenance** — every line this session did
 * not write opens with `[from …]` naming the exact revision it came from.
 * The third, that they are rebuilt at every model-call boundary, is the
 * module's (`packages/pi-extension/test/project-work.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { ProjectWorkBody } from "@lasercode/protocol";
import { ScriptedProjectWorkWorld } from "../../src/tool-eval/project-work-world.js";
import {
  CONTEXT_PACKET_COMMENTS_MAX,
  CONTEXT_PACKET_MAX,
  buildContextPacket,
} from "../../src/project-work/context-packet.js";
import { buildDesignHandoff, designImplementRef } from "../../src/project-work/design-handoff.js";
import { ProjectWorkSession } from "../../src/project-work/session.js";

function taskBody(overrides: Partial<{ outcome: string; dependencies: string[]; acceptance: Array<{ id: string; text: string; machineVerifiable: boolean; command?: string }> }> = {}): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: overrides.outcome ?? "The export list says why an export failed.",
      nonGoals: ["Automatic retry."],
      dependencies: overrides.dependencies ?? ["TASK-9"],
      scope: { packages: ["exports"], repositories: [], paths: ["src/exports/list.ts"], capabilities: [] },
      acceptance: overrides.acceptance ?? [{ id: "a1", text: "A failed row shows the reason.", machineVerifiable: true, command: "pnpm -F exports test" }],
      verificationCommands: ["pnpm -F exports test"],
      visualEvidenceRequired: false,
      assignment: { policy: "agent", agentName: "worker" },
    },
  };
}

function designBody(): ProjectWorkBody {
  return {
    kind: "design",
    design: {
      brief: "The failed-export row: the reason, and the one action that fixes it.",
      designIndexRef: { indexId: "idx_1", revisionId: "rev_index", profileDigest: "a".repeat(64), eraId: "era_2026" },
      foundation: { principles: ["Errors are written for a person."] },
      screens: [
        {
          id: "s1",
          name: "Exports",
          content: { tree: { rootNodeId: "n1", nodes: [{ id: "n1", component: { primitive: "Stack" }, fidelity: "mapped", props: {}, children: [] }] } },
          states: [{ name: "failed", included: true }],
          fidelity: "mapped",
        },
      ],
      flows: [],
      sketches: [],
      hostPage: { routeOrPath: "/exports", outline: [{ id: "o1", role: "region", label: "Export list", depth: 1 }], files: ["src/exports/list.ts"], fidelity: "mapped" },
      insertionRegion: { id: "r1", templatePath: "src/exports/list.ts", structuralPath: "main>section[2]", textHash: "b".repeat(64) },
      strategy: { kind: "extend", reason: "The list already exists; the row gains a reason line.", targetFiles: ["src/exports/list.ts"], integrationContract: "The row takes a reason and an action." },
      fidelity: "mapped",
      fixtures: [{ id: "f1", name: "Three failed exports", rows: 3 }],
    },
  };
}

describe("the context packet", () => {
  it("names the exact revisions, the acceptance and the dependencies, every line labelled", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody(), state: "in_progress" }] });
    const task = world.entity("TASK-1")!;
    const packet = await buildContextPacket({ bridge: world, task: { entityId: task.entity.entityId, key: task.entity.key } });
    expect(packet.text).toContain("# TASK-1 · Failed export rows say why");
    expect(packet.text).toContain(`revision ${task.entity.currentRevisionId}`);
    expect(packet.text).toContain("[from TASK-1 acceptance] A failed row shows the reason. — pnpm -F exports test");
    expect(packet.text).toContain("[from TASK-1] TASK-9");
    expect(packet.revisions).toContain(`TASK-1@${task.entity.currentRevisionId}`);
    // Every quoted line carries its provenance; nothing borrowed is bare.
    for (const line of packet.text.split("\n")) {
      if (line.startsWith("#") || line.startsWith("##") || line.trim() === "") continue;
      if (line.startsWith("[from ")) continue;
      expect(
        ["State ", "Ready", "Not ready", "Attempt ", "This packet"].some((prefix) => line.startsWith(prefix)),
        `an unlabelled line: ${line}`,
      ).toBe(true);
    }
  });

  it("carries the unresolved comments, bounded, and says how to read the rest", async () => {
    const comments = Array.from({ length: CONTEXT_PACKET_COMMENTS_MAX + 4 }, (_unused, index) => ({ text: `Comment ${String(index + 1)} about the row.` }));
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody(), comments }] });
    const task = world.entity("TASK-1")!;
    const packet = await buildContextPacket({ bridge: world, task: { entityId: task.entity.entityId, key: task.entity.key } });
    const quoted = packet.text.split("\n").filter((line) => line.includes("[from TASK-1 comment]"));
    expect(quoted).toHaveLength(CONTEXT_PACKET_COMMENTS_MAX);
    expect(packet.truncated).toBe(true);
    expect(packet.text).toContain("4 more comments were left out");
  });

  it("stays inside its ceiling whatever the project holds", async () => {
    const long = "This task is described at great length. ".repeat(200);
    const world = new ScriptedProjectWorkWorld({
      items: [
        {
          kind: "task",
          title: "Failed export rows say why",
          body: taskBody({ outcome: long, acceptance: Array.from({ length: 40 }, (_unused, index) => ({ id: `a${String(index)}`, text: long, machineVerifiable: false })) }),
          comments: Array.from({ length: 40 }, (_unused, index) => ({ text: `${String(index)} ${long}` })),
        },
      ],
    });
    const task = world.entity("TASK-1")!;
    const packet = await buildContextPacket({ bridge: world, task: { entityId: task.entity.entityId, key: task.entity.key } });
    expect(packet.text.length).toBeLessThanOrEqual(CONTEXT_PACKET_MAX + 120);
    expect(packet.truncated).toBe(true);
  });

  it("quotes the project's instructions, labelled and bounded", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody() }] });
    const task = world.entity("TASK-1")!;
    const packet = await buildContextPacket({
      bridge: world,
      task: { entityId: task.entity.entityId, key: task.entity.key },
      projectInstructions: "Never add a dependency without asking.",
    });
    expect(packet.text).toContain("[from project instructions] Never add a dependency without asking.");
  });

  it("says what the last attempt did, and that the record stands when its session is gone", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody(), state: "in_progress" }] });
    const task = world.entity("TASK-1")!;
    await world.call("project/task/link-execution", {
      projectId: "prj_eval",
      entityId: task.entity.entityId,
      expectedRevisionId: task.entity.currentRevisionId,
      execution: { kind: "agent_run", targetId: "run_old", endedAt: "2026-01-01T09:00:00.000Z", outcome: "failed" },
      idempotencyKey: "a1",
    });
    await world.call("project/work/link", {
      projectId: "prj_eval",
      expectedRevisionId: task.entity.currentRevisionId,
      link: {
        type: "evidence",
        entityId: task.entity.entityId,
        revisionId: task.entity.currentRevisionId,
        kind: "test",
        role: "supporting",
        summary: "pnpm -F exports test: one failure in the row's reason line.",
        outcome: "failed",
      },
      idempotencyKey: "e1",
    });
    const packet = await buildContextPacket({ bridge: world, task: { entityId: task.entity.entityId, key: task.entity.key } });
    expect(packet.text).toContain("## The last attempt");
    expect(packet.text).toContain("Attempt 1 ended failed");
    expect(packet.text).toContain("[from test evidence, failed] pnpm -F exports test");
  });

  it("is nothing at all for a session with no project", async () => {
    const world = new ScriptedProjectWorkWorld({ hasProject: false });
    const packet = await buildContextPacket({ bridge: world, task: { entityId: "ent_1" } });
    expect(packet.text).toBe("");
  });
});

describe("an attempt, before the first prompt", () => {
  it("links this session to the task at the first model-call boundary, once", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody(), state: "in_progress" }] });
    const task = world.entity("TASK-1")!;
    const session = new ProjectWorkSession({ bridge: world, task: { entityId: task.entity.entityId, key: task.entity.key } });
    const packet = await session.turnContext({ prompt: "start on TASK-1" });
    expect(packet, "the turn is given the packet").toContain("# TASK-1");
    const linked = world.calls.filter((call) => call.method === "project/task/link-execution");
    expect(linked, "the attempt is linked before the model is called").toHaveLength(1);
    const execution = (linked[0]?.params as { execution: { targetId: string; kind: string; branch?: string; baseCommitObjectId?: string } }).execution;
    expect(execution).toMatchObject({ kind: "agent_run", targetId: "run_eval", branch: "agents/eval", baseCommitObjectId: "0123abc" });
    await session.turnContext({ prompt: "carry on" });
    expect(world.calls.filter((call) => call.method === "project/task/link-execution"), "one attempt, not one a turn").toHaveLength(1);
  });

  it("still gives the turn its packet when the attempt could not be linked", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody() }] });
    const task = world.entity("TASK-1")!;
    const session = new ProjectWorkSession({
      bridge: {
        ...world,
        projectId: () => world.projectId(),
        identity: () => world.identity(),
        execution: () => world.execution(),
        task: () => undefined,
        lastResearchResult: () => undefined,
        call: async (method, params) => {
          if (method === "project/task/link-execution") throw new Error("the app refused that");
          return world.call(method, params);
        },
      },
      task: { entityId: task.entity.entityId, key: task.entity.key },
    });
    const packet = await session.turnContext({ prompt: "start on TASK-1" });
    expect(packet).toContain("# TASK-1");
  });
});

describe("the /design implement hand-off", () => {
  it("recognises the command in every form the UI can send it", () => {
    expect(designImplementRef("/design implement DES-4")).toBe("DES-4");
    expect(designImplementRef("/design implement @design:DES-4")).toBe("DES-4");
    expect(designImplementRef("  /design   implement   ent_7  ")).toBe("ent_7");
    expect(designImplementRef("/design a settings screen")).toBeUndefined();
    expect(designImplementRef("implement DES-4")).toBeUndefined();
  });

  it("pulls the exact revision's tree, index entries, strategy, host region, fixtures and comments", async () => {
    const world = new ScriptedProjectWorkWorld({
      items: [{ kind: "design", title: "Failed export row", body: designBody(), comments: [{ text: "The action must be reachable by keyboard.", blocking: true }] }],
    });
    const packet = await buildDesignHandoff(world, "DES-1");
    expect(packet).toBeDefined();
    if (!packet) throw new Error("no packet");
    expect(packet.ref).toMatchObject({ key: "DES-1" });
    expect(packet.text).toContain(`[from DES-1 revision ${packet.ref.revisionId}]`);
    expect(packet.text).toContain("## Screens");
    expect(packet.text).toContain("Exports (mapped");
    expect(packet.text).toContain("nodes: n1:Stack");
    expect(packet.text).toContain("## Index entries used");
    expect(packet.text).toContain("era era_2026");
    expect(packet.text).toContain("## Strategy");
    expect(packet.text).toContain("extend:");
    expect(packet.text).toContain("## Host region");
    expect(packet.text).toContain("/exports");
    expect(packet.text).toContain("region r1 in src/exports/list.ts");
    expect(packet.text).toContain("## Fixtures");
    expect(packet.text).toContain("Three failed exports: 3 rows");
    expect(packet.text).toContain("[from DES-1 comment] blocking: The action must be reachable by keyboard.");
    expect(packet.text).toContain("expected_revision_id");
  });

  it("answers nothing for a ref that is not a design, so the turn runs as ordinary text", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "task", title: "A task", body: taskBody() }] });
    expect(await buildDesignHandoff(world, "TASK-1")).toBeUndefined();
    expect(await buildDesignHandoff(world, "DES-9")).toBeUndefined();
  });

  it("is what the session hands the model when the turn asked for it, once", async () => {
    const world = new ScriptedProjectWorkWorld({ items: [{ kind: "design", title: "Failed export row", body: designBody() }] });
    const session = new ProjectWorkSession({ bridge: world });
    const first = await session.turnContext({ prompt: "/design implement DES-1" });
    expect(first).toContain("# Implement DES-1");
    const again = await session.turnContext({ prompt: "/design implement DES-1" });
    expect(again, "the same hand-off is not repeated turn after turn").toBeUndefined();
  });
});
