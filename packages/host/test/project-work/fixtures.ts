/**
 * Bodies and origins the project-work store tests write. Not a test file.
 */
import type { ProjectWorkBody, ProjectWorkOrigin } from "@lasercode/protocol";

export const person: ProjectWorkOrigin = { actor: { kind: "person", label: "You" } };
export const agent: ProjectWorkOrigin = { actor: { kind: "agent", label: "Builder" }, sessionId: "ses_1" };

export function specBody(brief = "People cannot review a design from their phone."): ProjectWorkBody {
  return {
    kind: "spec",
    spec: {
      form: "brief",
      brief,
      outcomes: ["A person can approve a design on a phone."],
      nonGoals: [],
      requirements: [{ id: "r1", text: "The review footer is reachable with one thumb.", level: "must" }],
      acceptance: [{ id: "a1", text: "A gate can be approved at 320px.", machineVerifiable: false }],
      constraints: [],
    },
  };
}

export function planBody(brief = "Ship phone review."): ProjectWorkBody {
  return {
    kind: "plan",
    plan: {
      brief,
      phases: [{ id: "p1", name: "Spine", taskKeys: [] }],
      dependencies: [],
      boundaries: [],
      migrations: [],
      risks: [],
      verification: ["pnpm verify"],
    },
  };
}

export function designBody(brief = "The review footer."): ProjectWorkBody {
  return {
    kind: "design",
    design: {
      brief,
      screens: [
        {
          id: "s1",
          name: "Review",
          content: {
            tree: {
              rootNodeId: "n1",
              nodes: [{ id: "n1", component: { primitive: "stack" }, fidelity: "mapped", props: {}, children: [] }],
            },
          },
          states: [],
          fidelity: "mapped",
        },
      ],
      flows: [],
      sketches: [],
      fidelity: "mapped",
      fixtures: [],
    },
  };
}

export function taskBody(outcome = "The review footer is sticky on a phone.", dependencies: string[] = []): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome,
      nonGoals: [],
      dependencies,
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [{ id: "a1", text: "Approve is reachable at 320px.", machineVerifiable: false }],
      verificationCommands: [],
      visualEvidenceRequired: false,
      assignment: { policy: "unassigned" },
    },
  };
}
