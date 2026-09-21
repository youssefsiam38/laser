/**
 * M21-T17: the four lifecycle tools, against the scripted host authority.
 *
 * What is proved here is what the model meets: the contract lint on every
 * spec, the capability gating (a projectless chat gets one tool), summaries
 * by default with bodies only by projection, the typed refusals a stale
 * revision and a wrong-project write come back as, the preview that writes
 * nothing, and the two rules a report may not break — a task is never done by
 * a report alone, and an attempt's identity is the session's, not the
 * model's.
 */
import { describe, expect, it } from "vitest";
import { toolContract, type ProjectWorkBody } from "@lasercode/protocol";
import { ScriptedProjectWorkWorld } from "../../src/tool-eval/project-work-world.js";
import { ProjectWorkSession } from "../../src/project-work/session.js";
import { ProjectWorkToolFailure, projectWorkFailure } from "../../src/project-work/bridge.js";
import {
  PROJECT_WORK_TOOL_SPECS,
  inspectProjectWork,
  reportProjectTask,
  requestProjectReview,
  writeProjectArtifact,
} from "../../src/project-work/tools.js";

function specBody(brief = "People cannot tell a failed export from a slow one."): ProjectWorkBody {
  return {
    kind: "spec",
    spec: {
      form: "brief",
      brief,
      outcomes: ["A failed export says what failed."],
      nonGoals: [],
      requirements: [{ id: "r1", text: "The reason is written for a person.", level: "must" }],
      acceptance: [{ id: "a1", text: "A failed row shows the reason.", machineVerifiable: true }],
      constraints: [],
    },
  };
}

function taskBody(): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: "The export list says why an export failed.",
      nonGoals: [],
      dependencies: [],
      scope: { packages: ["exports"], repositories: [], paths: ["src/exports/list.ts"], capabilities: [] },
      acceptance: [{ id: "a1", text: "A failed row shows the reason.", machineVerifiable: true }],
      verificationCommands: ["pnpm -F exports test"],
      visualEvidenceRequired: false,
      assignment: { policy: "agent", agentName: "worker" },
    },
  };
}

function world(options: ConstructorParameters<typeof ScriptedProjectWorkWorld>[0] = {}): ScriptedProjectWorkWorld {
  return new ScriptedProjectWorkWorld(options);
}

async function refused(run: () => Promise<unknown>): Promise<ProjectWorkToolFailure["toolError"]> {
  try {
    await run();
  } catch (error) {
    expect(error, "every refusal is the contract's shape").toBeInstanceOf(ProjectWorkToolFailure);
    return (error as ProjectWorkToolFailure).toolError;
  }
  throw new Error("that call should have been refused");
}

describe("the four specs", () => {
  it("obey the tool contract", () => {
    for (const spec of PROJECT_WORK_TOOL_SPECS) expect(toolContract(spec), spec.name).toEqual([]);
  });

  it("are the four the leap names, with honest annotations", () => {
    expect(PROJECT_WORK_TOOL_SPECS.map((spec) => spec.name)).toEqual([
      "inspect_project_work",
      "write_project_artifact",
      "request_project_review",
      "report_project_task",
    ]);
    expect(PROJECT_WORK_TOOL_SPECS[0]?.annotations).toEqual({ readOnly: true, idempotent: true, destructive: false, external: false });
    for (const spec of PROJECT_WORK_TOOL_SPECS.slice(1)) {
      expect(spec.annotations.readOnly, spec.name).toBe(false);
      expect(spec.annotations.idempotent, spec.name).toBe(true);
      expect(spec.annotations.destructive, spec.name).toBe(false);
      expect(spec.annotations.external, spec.name).toBe(false);
    }
    for (const spec of PROJECT_WORK_TOOL_SPECS) expect(spec.label).toBe("injected");
  });

  it("carries expected_revision_id and an idempotency key on every writer", () => {
    for (const spec of PROJECT_WORK_TOOL_SPECS.slice(2)) {
      const required = (spec.input as { required: string[] }).required;
      expect(required, spec.name).toContain("expected_revision_id");
      expect(required, spec.name).toContain("idempotency_key");
    }
  });
});

describe("capability gating", () => {
  it("gives a projectless chat the read tool alone, for cross-project reads", () => {
    const session = new ProjectWorkSession({ bridge: world({ hasProject: false }) });
    expect(session.lifecycleTools().map((binding) => binding.spec.name)).toEqual(["inspect_project_work"]);
    expect(session.designTools()).toEqual([]);
    expect(session.researchTools()).toEqual([]);
  });

  it("gives a project session all four, and nothing it has no bridge for", () => {
    const session = new ProjectWorkSession({ bridge: world() });
    expect(session.lifecycleTools().map((binding) => binding.spec.name)).toEqual([
      "inspect_project_work",
      "write_project_artifact",
      "request_project_review",
      "report_project_task",
    ]);
    expect(session.designTools(), "no design index, no design tools").toEqual([]);
  });

  it("registers nothing at all without a bridge to the host", () => {
    const session = new ProjectWorkSession({});
    expect([...session.lifecycleTools(), ...session.designTools(), ...session.researchTools()]).toEqual([]);
  });
});

describe("inspect_project_work", () => {
  it("answers a list with identity and a line, and no body", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const answer = await inspectProjectWork(scripted, { action: "list" });
    expect(answer["items"]).toHaveLength(1);
    const [row] = answer["items"] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ key: "SPEC-1", kind: "spec", title: "Failed exports say why" });
    expect(row?.["revision_id"], "a row carries the revision a write has to quote").toBeTypeOf("string");
    expect(JSON.stringify(answer), "a list never carries a body").not.toContain("People cannot tell");
  });

  it("reads a body only when asked, as a bounded page that says where to continue", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const summary = await inspectProjectWork(scripted, { action: "get", key: "SPEC-1" });
    expect(summary["body"]).toBeUndefined();
    const page = await inspectProjectWork(scripted, { action: "get", key: "SPEC-1", include: ["body"], body_limit: 120 });
    const body = page["body"] as Record<string, unknown>;
    expect(body["bytes"]).toBe(120);
    expect(body["next_offset"]).toBe(120);
    expect(page["advice"], "a cut answer says how to read the rest").toContain("body_offset");
  });

  it("returns comments only by projection, with who wrote them", async () => {
    const scripted = world({
      items: [{ kind: "spec", title: "Failed exports say why", body: specBody(), comments: [{ text: "Name the file.", blocking: true }] }],
    });
    const answer = await inspectProjectWork(scripted, { action: "get", key: "SPEC-1", include: ["comments"] });
    const comments = answer["comments"] as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ text: "Name the file.", blocking: true, state: "open" });
  });

  it("refuses a list from a session with no project, and says what to do instead", async () => {
    const error = await refused(() => inspectProjectWork(world({ hasProject: false }), { action: "list" }));
    expect(error.code).toBe("no_project");
    expect(error.committed).toBe(false);
    expect(error.next).toContain("search");
  });
});

describe("write_project_artifact", () => {
  it("creates an artifact from a typed body and answers with the revision to quote next", async () => {
    const scripted = world();
    const answer = await writeProjectArtifact(scripted, {
      action: "create",
      kind: "spec",
      title: "Failed exports say why",
      body_json: JSON.stringify(specBody()),
      idempotency_key: "c1",
    });
    expect(answer).toMatchObject({ key: "SPEC-1", kind: "spec", state: "draft" });
    expect(answer["revision_id"]).toBeTypeOf("string");
    expect(answer["note"]).toContain("request_project_review");
  });

  it("accepts the bare body of a kind by wrapping it, because that is the mistake a model makes first", async () => {
    const scripted = world();
    const bare = (specBody() as { spec: unknown }).spec;
    const answer = await writeProjectArtifact(scripted, {
      action: "create",
      kind: "spec",
      title: "Failed exports say why",
      body_json: JSON.stringify(bare),
      idempotency_key: "c2",
    });
    expect(answer["kind"]).toBe("spec");
  });

  it("refuses a body that is not JSON, and one that is not this kind's shape", async () => {
    const scripted = world();
    const notJson = await refused(() =>
      writeProjectArtifact(scripted, { action: "create", kind: "spec", title: "X", body_json: "{oops", idempotency_key: "c3" }),
    );
    expect(notJson.code).toBe("body_not_json");
    const wrongShape = await refused(() =>
      writeProjectArtifact(scripted, { action: "create", kind: "spec", title: "X", body_json: JSON.stringify({ hello: 1 }), idempotency_key: "c4" }),
    );
    expect(wrongShape.code).toBe("body_invalid");
    expect(wrongShape.next).toContain("inspect_project_work");
  });

  it("turns a stale revision into the conflict that names the revision to read", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const error = await refused(() =>
      writeProjectArtifact(scripted, {
        action: "revise",
        key: "SPEC-1",
        expected_revision_id: "rev_nope",
        body_json: JSON.stringify(specBody("Changed")),
        idempotency_key: "r1",
      }),
    );
    expect(error.code).toBe("stale_revision");
    expect(error.committed).toBe(false);
    expect(error.next).toMatch(/expected_revision_id rev_/);
  });

  it("replays an idempotency key instead of writing twice", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const current = scripted.entity("SPEC-1")!.entity.currentRevisionId;
    const first = await writeProjectArtifact(scripted, {
      action: "revise",
      key: "SPEC-1",
      expected_revision_id: current,
      body_json: JSON.stringify(specBody("Changed")),
      idempotency_key: "same",
    });
    const again = await writeProjectArtifact(scripted, {
      action: "revise",
      key: "SPEC-1",
      expected_revision_id: current,
      body_json: JSON.stringify(specBody("Changed")),
      idempotency_key: "same",
    });
    expect(again["revision_id"]).toBe(first["revision_id"]);
  });

  it("refuses to write from a session with no project of its own", async () => {
    const error = await refused(() =>
      writeProjectArtifact(world({ hasProject: false }), { action: "create", kind: "spec", title: "X", body_json: JSON.stringify(specBody()), idempotency_key: "c5" }),
    );
    expect(error.code).toBe("no_project");
  });

  it("refuses a write to another project by naming the owner and offering a session there", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Theirs", body: specBody() }] });
    const error = await refused(() =>
      inspectAndWriteElsewhere(scripted),
    );
    expect(error.code).toBe("wrong_project");
    expect(error.next).toContain("open a session there");
  });
});

/** A write whose params name a project this session does not belong to. */
async function inspectAndWriteElsewhere(scripted: ScriptedProjectWorkWorld): Promise<unknown> {
  try {
    return await scripted.call("project/work/create", {
      projectId: "prj_other",
      kind: "spec",
      title: "Elsewhere",
      body: specBody(),
      idempotencyKey: "elsewhere",
    });
  } catch (error) {
    // The bridge is what turns the host's refusal into the tool's own shape;
    // the scripted world answers exactly as the host does.
    throw projectWorkFailure(error, "project/work/create");
  }
}

describe("request_project_review", () => {
  it("previews a gate-affecting request without writing, in the shape the transcript draws", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const current = scripted.entity("SPEC-1")!.entity.currentRevisionId;
    const preview = await requestProjectReview(scripted, {
      action: "request_review",
      key: "SPEC-1",
      expected_revision_id: current,
      preview: true,
      idempotency_key: "p1",
    });
    expect(preview).toMatchObject({ preview: true, confirmWith: "request_project_review" });
    expect(preview["digest"]).toMatch(/^[0-9a-f]{16}$/);
    expect(scripted.entity("SPEC-1")!.entity.state, "a preview writes nothing").toBe("draft");
  });

  it("leaves a blocking comment and says what it blocks", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const current = scripted.entity("SPEC-1")!.entity.currentRevisionId;
    const answer = await requestProjectReview(scripted, {
      action: "comment",
      key: "SPEC-1",
      expected_revision_id: current,
      text: "The reason must name the file.",
      blocking: true,
      idempotency_key: "cm1",
    });
    expect(answer["comment_state"]).toBe("open");
    expect(answer["blocking_comments"]).toBe(1);
    expect(answer["note"]).toContain("blocks approval");
  });

  it("marks a comment addressed and says only a person resolves one", async () => {
    const scripted = world({
      items: [{ kind: "spec", title: "Failed exports say why", body: specBody(), comments: [{ text: "Name the file." }] }],
    });
    const stored = scripted.entity("SPEC-1")!;
    const answer = await requestProjectReview(scripted, {
      action: "mark_comment_addressed",
      key: "SPEC-1",
      expected_revision_id: stored.entity.currentRevisionId,
      comment_id: stored.comments[0]!.commentId,
      idempotency_key: "cm2",
    });
    expect(answer["comment_state"]).toBe("addressed");
    expect(answer["note"]).toContain("Only a person resolves");
  });

  it("refuses an anchored comment that names no anchor", async () => {
    const scripted = world({ items: [{ kind: "spec", title: "Failed exports say why", body: specBody() }] });
    const current = scripted.entity("SPEC-1")!.entity.currentRevisionId;
    const error = await refused(() =>
      requestProjectReview(scripted, {
        action: "comment",
        key: "SPEC-1",
        expected_revision_id: current,
        anchor_target: "section",
        text: "This section is wrong.",
        idempotency_key: "cm3",
      }),
    );
    expect(error.code).toBe("no_anchor");
  });
});

describe("report_project_task", () => {
  function taskWorld(): ScriptedProjectWorkWorld {
    return world({ items: [{ kind: "task", title: "Failed export rows say why", body: taskBody(), state: "in_progress" }] });
  }

  it("refuses to mark a task done on a report alone", async () => {
    const scripted = taskWorld();
    const current = scripted.entity("TASK-1")!.entity.currentRevisionId;
    const error = await refused(() =>
      reportProjectTask(scripted, { action: "complete", key: "TASK-1", expected_revision_id: current, idempotency_key: "d1" }),
    );
    expect(error.code).toBe("no_acceptance_evidence");
    expect(error.next).toContain("record_evidence");
    expect(scripted.entity("TASK-1")!.entity.state).toBe("in_progress");
  });

  it("records evidence without moving the task", async () => {
    const scripted = taskWorld();
    const current = scripted.entity("TASK-1")!.entity.currentRevisionId;
    const answer = await reportProjectTask(scripted, {
      action: "record_evidence",
      key: "TASK-1",
      expected_revision_id: current,
      evidence_kind: "test",
      evidence_role: "acceptance",
      evidence_outcome: "passed",
      evidence_summary: "pnpm -F exports test: 42 passed.",
      idempotency_key: "e1",
    });
    expect(answer["evidence_id"]).toBeTypeOf("string");
    expect(answer["note"]).toContain("does not move the task");
    expect(scripted.entity("TASK-1")!.entity.state).toBe("in_progress");
  });

  it("completes only once acceptance evidence that passed is on the record", async () => {
    const scripted = taskWorld();
    const current = scripted.entity("TASK-1")!.entity.currentRevisionId;
    const answer = await reportProjectTask(scripted, {
      action: "complete",
      key: "TASK-1",
      expected_revision_id: current,
      evidence_kind: "test",
      evidence_role: "acceptance",
      evidence_outcome: "passed",
      evidence_summary: "pnpm -F exports test: 42 passed.",
      idempotency_key: "d2",
    });
    expect(answer["state"]).toBe("done");
    expect(answer["evidence_id"]).toBeTypeOf("string");
  });

  it("links this session as the attempt, with the identity the worker knows and not the model's", async () => {
    const scripted = taskWorld();
    const current = scripted.entity("TASK-1")!.entity.currentRevisionId;
    const answer = await reportProjectTask(scripted, {
      action: "link_execution",
      key: "TASK-1",
      expected_revision_id: current,
      idempotency_key: "x1",
    });
    expect(answer["attempt"]).toBe(1);
    const link = scripted.entity("TASK-1")!.executions[0] as Record<string, unknown>;
    expect(link["targetId"], "the run is the session's own, never something the model said").toBe("run_eval");
    expect(link["kind"]).toBe("agent_run");
    expect(link["branch"]).toBe("agents/eval");
    expect(link["baseCommitObjectId"]).toBe("0123abc");
  });

  it("closes an attempt with evidence and says a run ending never marks the task done", async () => {
    const scripted = taskWorld();
    const current = scripted.entity("TASK-1")!.entity.currentRevisionId;
    await reportProjectTask(scripted, { action: "link_execution", key: "TASK-1", expected_revision_id: current, idempotency_key: "x2" });
    const ended = await reportProjectTask(scripted, {
      action: "link_execution",
      key: "TASK-1",
      expected_revision_id: current,
      outcome: "completed",
      idempotency_key: "x3",
    });
    expect(ended["note"]).toContain("never marks the task done");
    expect(scripted.entity("TASK-1")!.entity.state).toBe("in_progress");
  });
});
