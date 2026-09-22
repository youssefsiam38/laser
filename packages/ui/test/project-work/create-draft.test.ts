import { describe, expect, it } from "vitest";
import { PROJECT_WORK_MARKDOWN_MAX, projectWorkBodySchema } from "@lasercode/protocol";

import { bodyFromCreateDraft, createDraftId, newCreateDrafts, validateCreateDraft } from "../../src/project-work/create-draft.js";
import { item } from "./fixture.js";

const markdown = "  # Keep these bytes\n\n```ts\nconst x = 1;\n```\n  ";

describe("typed creation drafts", () => {
  it("preserves exact Spec Markdown and maps its structured contract", () => {
    const draft = newCreateDrafts().spec;
    const body = bodyFromCreateDraft({
      ...draft,
      title: "Typed spec",
      primary: markdown,
      form: "full",
      problem: markdown,
      outcomes: [{ id: createDraftId(), text: "Less waiting" }],
      requirements: [{ id: "req-1", text: markdown, level: "must" }],
      acceptance: [{ id: "acc-1", text: markdown, machineVerifiable: true }],
      document: markdown,
    });
    expect(body).toEqual({
      kind: "spec",
      spec: {
        form: "full",
        brief: markdown,
        problem: markdown,
        outcomes: ["Less waiting"],
        nonGoals: [],
        requirements: [{ id: "req-1", text: markdown, level: "must" }],
        acceptance: [{ id: "acc-1", text: markdown, machineVerifiable: true }],
        constraints: [],
        document: markdown,
      },
    });
    expect(projectWorkBodySchema.safeParse(body).success).toBe(true);
  });

  it("creates only open Research questions and never findings, sources, or answers", () => {
    const draft = newCreateDrafts().research;
    const body = bodyFromCreateDraft({
      ...draft,
      title: "Investigate latency",
      primary: markdown,
      inScope: [{ id: "scope-1", text: "Official telemetry" }],
      followUps: [{ id: "q-child", text: "Which stage is slow?" }],
    });
    expect(body.kind).toBe("research");
    if (body.kind !== "research") return;
    expect(body.research.question).toBe(markdown);
    expect(body.research.questions).toEqual([
      { id: draft.rootId, text: markdown, state: "open", findings: [] },
      { id: "q-child", text: "Which stage is slow?", parent: draft.rootId, state: "open", findings: [] },
    ]);
    expect(body.research.findings).toEqual([]);
    expect(body.research.sources).toEqual([]);
    expect(body.research.questions.every((question) => question.answer === undefined)).toBe(true);
    expect(projectWorkBodySchema.safeParse(body).success).toBe(true);
  });

  it("records Design intent without fabricating visual artifacts or grounding", () => {
    const draft = newCreateDrafts().design;
    const body = bodyFromCreateDraft({ ...draft, title: "Compose settings", primary: markdown, principles: [{ id: "p1", text: "Keyboard first" }], notes: markdown });
    expect(body).toEqual({
      kind: "design",
      design: {
        brief: markdown,
        foundation: { principles: ["Keyboard first"], notes: markdown, status: "proposed" },
        screens: [], flows: [], sketches: [], fidelity: "proposed", fixtures: [],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/designIndexRef|hostPage|evidence|approval/);
    expect(projectWorkBodySchema.safeParse(body).success).toBe(true);
  });

  it("maps Plan phases, graph edges, boundaries, risks, verification, and document", () => {
    const draft = newCreateDrafts().plan;
    const taskA = item({ entityId: "ta", kind: "task", number: 1 });
    const taskB = item({ entityId: "tb", kind: "task", number: 2 });
    const next = {
      ...draft,
      title: "Ship it",
      primary: markdown,
      phases: [{ id: "phase-1", name: "Foundation", summary: markdown, taskKeys: [taskA.key, taskB.key] }],
      dependencies: [{ id: "edge-1", from: taskB.key, to: taskA.key, reason: "Schema first" }],
      boundaries: [{ id: "bound-1", scope: "Protocol", rule: markdown }],
      risks: [{ id: "risk-1", summary: "Skew", control: markdown, severity: "high" as const }],
      verification: [{ id: "verify-1", text: "pnpm verify" }],
      document: markdown,
    };
    const checked = validateCreateDraft(next, [taskA, taskB]);
    expect(checked.details).toBeUndefined();
    expect(checked.body).toMatchObject({
      kind: "plan",
      plan: {
        brief: markdown,
        phases: [{ id: "phase-1", name: "Foundation", summary: markdown, taskKeys: ["TASK-1", "TASK-2"] }],
        dependencies: [{ from: "TASK-2", to: "TASK-1", reason: "Schema first" }],
        boundaries: [{ scope: "Protocol", rule: markdown }],
        risks: [{ summary: "Skew", control: markdown, severity: "high" }],
        verification: ["pnpm verify"],
        document: markdown,
      },
    });
  });

  it("maps Task scope and acceptance without fabricating attempts or evidence", () => {
    const draft = newCreateDrafts().task;
    const body = bodyFromCreateDraft({
      ...draft,
      title: "Implement form",
      primary: markdown,
      dependencies: ["TASK-1"],
      scope: [
        { id: "s1", type: "package", text: "@lasercode/ui" },
        { id: "s2", type: "repository", text: "workspace" },
        { id: "s3", type: "path", text: "packages/ui" },
      ],
      acceptance: [{ id: "a1", text: markdown, machineVerifiable: true, command: "pnpm test" }],
      verificationCommands: [{ id: "v1", text: "pnpm verify" }],
      visualEvidenceRequired: true,
      assignment: "agent:builder",
      planKey: "PLAN-1",
      notes: markdown,
    });
    expect(body).toMatchObject({
      kind: "task",
      task: {
        outcome: markdown,
        dependencies: ["TASK-1"],
        scope: { packages: ["@lasercode/ui"], repositories: ["workspace"], paths: ["packages/ui"], capabilities: [] },
        acceptance: [{ id: "a1", text: markdown, machineVerifiable: true, command: "pnpm test" }],
        verificationCommands: ["pnpm verify"],
        visualEvidenceRequired: true,
        assignment: { policy: "agent", agentName: "builder" },
        planKey: "PLAN-1",
        notes: markdown,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/attempt|evidence|checkpoint/);
    expect(projectWorkBodySchema.safeParse(body).success).toBe(true);
  });

  it("keeps a protocol-limit Markdown document exact without a second transformed copy", () => {
    const source = "x".repeat(PROJECT_WORK_MARKDOWN_MAX);
    const draft = newCreateDrafts().spec;
    const body = bodyFromCreateDraft({ ...draft, title: "Long document", primary: "Brief", document: source });
    expect(body.kind === "spec" ? body.spec.document : undefined).toBe(source);
    expect(projectWorkBodySchema.safeParse(body).success).toBe(true);
  });

  it("uses person-written errors for incomplete structured Plan rows", () => {
    const plan = newCreateDrafts().plan;
    const first = item({ entityId: "t1", kind: "task", number: 1 });
    const cases = [
      {
        draft: { ...plan, title: "Plan", primary: "Plan it", phases: [{ id: "p", name: "", summary: "", taskKeys: [first.key] }] },
        message: "Name every phase that has selected Tasks or a summary.",
      },
      {
        draft: { ...plan, title: "Plan", primary: "Plan it", boundaries: [{ id: "b", scope: "", rule: "Do not cross this." }] },
        message: "Complete both the scope and rule for every boundary.",
      },
      {
        draft: { ...plan, title: "Plan", primary: "Plan it", risks: [{ id: "r", summary: "", control: "Contain it.", severity: "high" as const }] },
        message: "Complete both the summary and control for every risk.",
      },
    ];

    for (const testCase of cases) {
      const checked = validateCreateDraft(testCase.draft, [first]);
      expect(checked.details).toBe(testCase.message);
      expect(checked.details).not.toContain("String must contain");
    }
  });

  it("uses trim only to test emptiness and rejects incomplete graph rows", () => {
    const design = newCreateDrafts().design;
    const body = bodyFromCreateDraft({ ...design, primary: markdown, principles: [], notes: markdown });
    expect(body.kind === "design" ? body.design.foundation : undefined).toBeUndefined();

    const plan = newCreateDrafts().plan;
    const checked = validateCreateDraft({ ...plan, title: "Plan", primary: "Plan it", dependencies: [{ id: "e", from: "TASK-1", to: "TASK-2", reason: "" }] }, []);
    expect(checked.details).toBeTruthy();

    const first = item({ entityId: "t1", kind: "task", number: 1 });
    const second = item({ entityId: "t2", kind: "task", number: 2 });
    const cyclic = validateCreateDraft({
      ...plan,
      title: "Cyclic",
      primary: "Plan it",
      phases: [{ id: "p", name: "Both", summary: "", taskKeys: [first.key, second.key] }],
      dependencies: [
        { id: "e1", from: first.key, to: second.key, reason: "" },
        { id: "e2", from: second.key, to: first.key, reason: "" },
      ],
    }, [first, second]);
    expect(cyclic.details).toContain("TASK-1 → TASK-2 → TASK-1");
  });
});
