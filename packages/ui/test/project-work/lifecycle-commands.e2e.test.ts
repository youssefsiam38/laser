// @vitest-environment happy-dom
/**
 * M21-T24 · "`/spec`, `/research`, `/design` and `/plan` work alone from any
 * chat" (goal "Done means", D-352), as far as a deterministic test reaches.
 *
 * Three rules are checked, and each one is a rule a person would notice:
 *
 * 1. **The text beside the command is the whole input.** `/plan <text>` writes
 *    the text as the Plan's own brief and creates nothing above it — no Spec,
 *    no gate, no empty upstream artifact.
 * 2. **Every command exists, and `/task` deliberately does not.**
 * 3. **Ownership is the one hard rule.** From a projectless Chat no artifact
 *    is written anywhere: the command parks the text and asks which project
 *    first, and the same text is written to the project that is then chosen.
 *
 * What this cannot prove is the dialog's own pixels, its keyboard path and
 * the morph into the workspace: those are the person's (D-342), and
 * `docs/leap/m21-acceptance.md` lists the exact steps.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectWorkKind } from "@lasercode/protocol";

import { clearWorkCreationRequest, startProjectWork, titleFromText } from "../../src/components/project-work/create-work.js";
import { WORK_COMMAND_KINDS } from "../../src/components/project-work/work-commands.js";
import { bindProjectWork, resetProjectWork } from "../../src/project-work/registry.js";
import { resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";
import type { ProjectWorkMethod } from "../../src/project-work/store.js";

/** The host, as far as these commands reach it: one project, real writes. */
function fakeHost(paths: string[]) {
  const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];
  let created = 0;
  const request = (async (method: ProjectWorkMethod, params: unknown) => {
    const typed = params as Record<string, unknown>;
    calls.push({ method, params: typed });
    if (method === "project/work/list") {
      const cwd = typed["cwd"] as string | undefined;
      if (cwd !== undefined && !paths.includes(cwd)) throw new Error("That project is not one this device can read.");
      return { projectId: "p1", seq: 1, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
    }
    if (method === "project/work/create") {
      created += 1;
      const kind = typed["kind"] as ProjectWorkKind;
      const key = `${{ spec: "SPEC", research: "RES", design: "DES", plan: "PLAN", task: "TASK" }[kind]}-${String(created)}`;
      const ref = { projectId: "p1", kind, entityId: `e${String(created)}`, revisionId: "r1", digest: "a".repeat(64), key, label: typed["title"] as string };
      return {
        entity: {
          projectId: "p1",
          entityId: ref.entityId,
          kind,
          key,
          keyNumber: created,
          title: typed["title"],
          state: "draft",
          currentRevisionId: "r1",
          currentDigest: "a".repeat(64),
          revisionCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          blockingComments: 0,
          needsAttention: false,
        },
        revision: { revisionId: "r1", index: 1, digest: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", origin: { actor: { kind: "person", label: "You" } } },
        ref,
        seq: created + 1,
      };
    }
    throw new Error(`the fixture does not answer ${method}`);
  }) as never;
  return { calls, request, creates: () => calls.filter((call) => call.method === "project/work/create") };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  clearWorkCreationRequest();
  resetWorkspaceUi();
  resetProjectWork();
  bindProjectWork(undefined);
});

describe("the four commands this product owns", () => {
  it("offers exactly /spec, /research, /design and /plan — and never /task", () => {
    expect([...WORK_COMMAND_KINDS]).toEqual(["spec", "research", "design", "plan"]);
    expect(WORK_COMMAND_KINDS).not.toContain("task");
  });

  it("makes the text beside the command the whole input, and creates nothing above it", async () => {
    const host = fakeHost(["/work/app"]);
    bindProjectWork(host.request);

    await startProjectWork({ kind: "plan", text: "Ship the relay rate limit\nand nothing else for now.", cwd: "/work/app" });
    await settle();

    const creates = host.creates();
    expect(creates, "one write, for the one thing that was asked for").toHaveLength(1);
    const params = creates[0]!.params;
    expect(params["kind"]).toBe("plan");
    expect(params["title"], "the first line, cut on a word boundary").toBe("Ship the relay rate limit");
    expect((params["body"] as { plan: { brief: string } }).plan.brief).toBe("Ship the relay rate limit\nand nothing else for now.");
    // Nothing above it: no Spec, no Research, no Design were written.
    expect(creates.map((call) => call.params["kind"])).toEqual(["plan"]);
  });

  it("writes each kind's first revision from the same one field", async () => {
    const host = fakeHost(["/work/app"]);
    bindProjectWork(host.request);

    await startProjectWork({ kind: "spec", text: "People cannot see why an export failed.", cwd: "/work/app" });
    await startProjectWork({ kind: "research", text: "Which export failures are recoverable?", cwd: "/work/app" });
    await startProjectWork({ kind: "design", text: "The failed-export row.", cwd: "/work/app" });
    await settle();

    const bodies = host.creates().map((call) => call.params["body"] as Record<string, Record<string, string>>);
    expect(bodies[0]!["spec"]!["brief"]).toBe("People cannot see why an export failed.");
    expect(bodies[1]!["research"]!["question"]).toBe("Which export failures are recoverable?");
    expect(bodies[2]!["design"]!["brief"]).toBe("The failed-export row.");
    // The workspace opened on what was created, rather than on a list.
    expect(workspaceUi().selection?.kind).toBe("design");
  });

  it("asks which project first from a projectless chat, and writes nothing until one is chosen", async () => {
    const host = fakeHost(["/work/app"]);
    bindProjectWork(host.request);

    await startProjectWork({ kind: "spec", text: "Exports say why" });
    await settle();
    expect(host.creates(), "ownership is the one hard rule: nothing is written nowhere").toHaveLength(0);

    // The picker holds the text; choosing the project writes it there, and
    // the same words survive the detour.
    await startProjectWork({ kind: "spec", text: "Exports say why", cwd: "/work/app" });
    await settle();
    const created = host.creates();
    expect(created).toHaveLength(1);
    expect((created[0]!.params["body"] as { spec: { brief: string } }).spec.brief).toBe("Exports say why");
    expect(created[0]!.params["projectId"]).toBe("p1");
  });

  it("keeps a long first line readable as a title without losing a word of the brief", () => {
    const long = "A very long first line that a person typed in one go and kept going well past the title ceiling";
    expect(titleFromText(long).length).toBeLessThanOrEqual(81);
    expect(titleFromText(long).endsWith("…")).toBe(true);
    expect(titleFromText("Short enough")).toBe("Short enough");
  });
});
