import {
  projectWorkBodySchema,
  validatePlanGraph,
  type ProjectWorkBody,
  type ProjectWorkKind,
  type ProjectWorkListItem,
  type SpecForm,
} from "@lasercode/protocol";

export interface DraftRow {
  id: string;
  text: string;
}

export interface SpecCreateDraft {
  kind: "spec";
  title: string;
  primary: string;
  form: SpecForm;
  problem: string;
  outcomes: DraftRow[];
  nonGoals: DraftRow[];
  requirements: Array<DraftRow & { level: "must" | "should" | "may" }>;
  acceptance: Array<DraftRow & { machineVerifiable: boolean }>;
  constraints: DraftRow[];
  document: string;
}

export interface ResearchCreateDraft {
  kind: "research";
  title: string;
  primary: string;
  rootId: string;
  inScope: DraftRow[];
  outOfScope: DraftRow[];
  constraints: DraftRow[];
  followUps: DraftRow[];
}

export interface DesignCreateDraft {
  kind: "design";
  title: string;
  primary: string;
  principles: DraftRow[];
  notes: string;
}

export interface PlanCreateDraft {
  kind: "plan";
  title: string;
  primary: string;
  phases: Array<{ id: string; name: string; summary: string; taskKeys: string[] }>;
  dependencies: Array<{ id: string; from: string; to: string; reason: string }>;
  boundaries: Array<{ id: string; scope: string; rule: string }>;
  risks: Array<{ id: string; summary: string; control: string; severity: "low" | "medium" | "high" }>;
  verification: DraftRow[];
  document: string;
}

export interface TaskCreateDraft {
  kind: "task";
  title: string;
  primary: string;
  nonGoals: DraftRow[];
  dependencies: string[];
  scope: Array<{ id: string; type: "package" | "repository" | "path"; text: string }>;
  acceptance: Array<DraftRow & { machineVerifiable: boolean; command: string }>;
  verificationCommands: DraftRow[];
  visualEvidenceRequired: boolean;
  assignment: "unassigned" | "person" | `agent:${string}`;
  planKey: string;
  notes: string;
}

export type CreateDraft = SpecCreateDraft | ResearchCreateDraft | DesignCreateDraft | PlanCreateDraft | TaskCreateDraft;
export type CreateDrafts = { [K in ProjectWorkKind]: Extract<CreateDraft, { kind: K }> };

let fallbackId = 0;
export function createDraftId(prefix = "row"): string {
  fallbackId += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${fallbackId.toString(36)}`;
}

export const emptyRow = (prefix?: string): DraftRow => ({ id: createDraftId(prefix), text: "" });

export function newCreateDrafts(): CreateDrafts {
  return {
    spec: {
      kind: "spec",
      title: "",
      primary: "",
      form: "brief",
      problem: "",
      outcomes: [],
      nonGoals: [],
      requirements: [],
      acceptance: [],
      constraints: [],
      document: "",
    },
    research: {
      kind: "research",
      title: "",
      primary: "",
      rootId: createDraftId("question"),
      inScope: [],
      outOfScope: [],
      constraints: [],
      followUps: [],
    },
    design: { kind: "design", title: "", primary: "", principles: [], notes: "" },
    plan: {
      kind: "plan",
      title: "",
      primary: "",
      phases: [],
      dependencies: [],
      boundaries: [],
      risks: [],
      verification: [],
      document: "",
    },
    task: {
      kind: "task",
      title: "",
      primary: "",
      nonGoals: [],
      dependencies: [],
      scope: [],
      acceptance: [],
      verificationCommands: [],
      visualEvidenceRequired: false,
      assignment: "unassigned",
      planKey: "",
      notes: "",
    },
  };
}

const present = (value: string): boolean => value.trim().length > 0;
const values = (rows: readonly DraftRow[]): string[] => rows.filter((row) => present(row.text)).map((row) => row.text);
const optional = (value: string): string | undefined => (present(value) ? value : undefined);

export function bodyFromCreateDraft(draft: CreateDraft): ProjectWorkBody {
  switch (draft.kind) {
    case "spec":
      return {
        kind: "spec",
        spec: {
          form: draft.form,
          brief: draft.primary,
          ...(optional(draft.problem) !== undefined ? { problem: draft.problem } : {}),
          outcomes: values(draft.outcomes),
          nonGoals: values(draft.nonGoals),
          requirements: draft.requirements.filter((row) => present(row.text)).map(({ id, text, level }) => ({ id, text, level })),
          acceptance: draft.acceptance.filter((row) => present(row.text)).map(({ id, text, machineVerifiable }) => ({ id, text, machineVerifiable })),
          constraints: values(draft.constraints),
          ...(optional(draft.document) !== undefined ? { document: draft.document } : {}),
        },
      };
    case "research": {
      const followUps = draft.followUps.filter((row) => present(row.text));
      return {
        kind: "research",
        research: {
          question: draft.primary,
          scope: { in: values(draft.inScope), out: values(draft.outOfScope), constraints: values(draft.constraints) },
          status: "open",
          questions: [
            { id: draft.rootId, text: draft.primary, state: "open", findings: [] },
            ...followUps.map((row) => ({ id: row.id, text: row.text, parent: draft.rootId, state: "open" as const, findings: [] })),
          ],
          findings: [],
          unresolved: [],
          sources: [],
        },
      };
    }
    case "design": {
      const principles = values(draft.principles);
      const notes = optional(draft.notes);
      return {
        kind: "design",
        design: {
          brief: draft.primary,
          ...(principles.length > 0 ? { foundation: { principles, ...(notes !== undefined ? { notes } : {}), status: "proposed" as const } } : {}),
          screens: [],
          flows: [],
          sketches: [],
          fidelity: "proposed",
          fixtures: [],
        },
      };
    }
    case "plan":
      return {
        kind: "plan",
        plan: {
          brief: draft.primary,
          phases: draft.phases
            .filter((phase) => present(phase.name) || present(phase.summary) || phase.taskKeys.length > 0)
            .map(({ id, name, summary, taskKeys }) => ({ id, name, ...(optional(summary) !== undefined ? { summary } : {}), taskKeys })),
          dependencies: draft.dependencies
            .filter((edge) => present(edge.from) || present(edge.to) || present(edge.reason))
            .map(({ from, to, reason }) => ({ from, to, ...(optional(reason) !== undefined ? { reason } : {}) })),
          boundaries: draft.boundaries
            .filter((row) => present(row.scope) || present(row.rule))
            .map(({ scope, rule }) => ({ scope, rule })),
          migrations: [],
          risks: draft.risks
            .filter((row) => present(row.summary) || present(row.control))
            .map(({ summary, control, severity }) => ({ summary, control, severity })),
          verification: values(draft.verification),
          ...(optional(draft.document) !== undefined ? { document: draft.document } : {}),
        },
      };
    case "task": {
      const packages: string[] = [];
      const repositories: string[] = [];
      const paths: string[] = [];
      for (const row of draft.scope) {
        if (!present(row.text)) continue;
        if (row.type === "package") packages.push(row.text);
        else if (row.type === "repository") repositories.push(row.text);
        else paths.push(row.text);
      }
      return {
        kind: "task",
        task: {
          outcome: draft.primary,
          nonGoals: values(draft.nonGoals),
          dependencies: draft.dependencies,
          scope: { packages, repositories, paths, capabilities: [] },
          acceptance: draft.acceptance
            .filter((row) => present(row.text) || present(row.command))
            .map(({ id, text, machineVerifiable, command }) => ({
              id,
              text,
              machineVerifiable,
              ...(optional(command) !== undefined ? { command } : {}),
            })),
          verificationCommands: values(draft.verificationCommands),
          visualEvidenceRequired: draft.visualEvidenceRequired,
          assignment: draft.assignment === "person"
            ? { policy: "person" }
            : draft.assignment === "unassigned"
              ? { policy: "unassigned" }
              : { policy: "agent", agentName: draft.assignment.slice("agent:".length) },
          ...(present(draft.planKey) ? { planKey: draft.planKey } : {}),
          ...(optional(draft.notes) !== undefined ? { notes: draft.notes } : {}),
        },
      };
    }
  }
}

export interface CreateDraftValidation {
  body?: ProjectWorkBody;
  title?: string;
  primary?: string;
  details?: string;
}

export function validateCreateDraft(draft: CreateDraft, items: readonly ProjectWorkListItem[] = []): CreateDraftValidation {
  if (!present(draft.title)) return { title: "Give this work a title." };
  if (!present(draft.primary)) return { primary: `Write the ${draft.kind === "task" ? "outcome" : draft.kind === "research" ? "question" : "brief"}.` };
  if (draft.kind === "design" && present(draft.notes) && !draft.principles.some((row) => present(row.text))) {
    return { details: "Add at least one principle to start a proposed foundation, or clear the direction notes." };
  }
  if (draft.kind === "plan") {
    if (draft.phases.some((phase) => !present(phase.name) && (present(phase.summary) || phase.taskKeys.length > 0))) {
      return { details: "Name every phase that has selected Tasks or a summary." };
    }
    if (draft.dependencies.some((edge) => (present(edge.from) || present(edge.to) || present(edge.reason)) && (!present(edge.from) || !present(edge.to)))) {
      return { details: "Choose both the waiting Task and prerequisite Task for every dependency." };
    }
    if (draft.boundaries.some((row) => present(row.scope) !== present(row.rule))) {
      return { details: "Complete both the scope and rule for every boundary." };
    }
    if (draft.risks.some((row) => present(row.summary) !== present(row.control))) {
      return { details: "Complete both the summary and control for every risk." };
    }
  }
  if (draft.kind === "task" && draft.acceptance.some((row) => present(row.command) && !present(row.text))) {
    return { details: "Write the acceptance criterion before adding its command." };
  }

  const body = bodyFromCreateDraft(draft);
  const parsed = projectWorkBodySchema.safeParse(body);
  if (!parsed.success) {
    const label = draft.kind === "task" ? "Task" : `${draft.kind[0]!.toUpperCase()}${draft.kind.slice(1)}`;
    return { details: `Check the ${label} details. One field is incomplete or longer than its allowed limit.` };
  }

  if (draft.kind === "plan" && body.kind === "plan") {
    const known = new Map(items.map((item) => [item.key, { kind: item.kind, state: item.state, entityId: item.ref.entityId, title: item.title }]));
    const graph = validatePlanGraph({ phases: body.plan.phases, dependencies: body.plan.dependencies, known });
    if (!graph.ok) return { details: graph.problems[0]?.message ?? "Check the dependency graph." };
  }
  return { body };
}
