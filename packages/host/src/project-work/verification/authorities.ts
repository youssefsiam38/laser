/**
 * The four authorities a verification run compares against, read from the
 * store at exact revisions (M21-T19; leap, "Execution and convergence").
 *
 * Nothing here executes anything and nothing here decides anything: it
 * *derives the question*. The Task names its Plan by key; the edges the person
 * or the model recorded name the Spec and the Design, and each edge names the
 * exact revision it was drawn against — which is what makes "from exact
 * revisions" a fact rather than a hope. An authority nobody linked simply is
 * not one, and the report says which four it had.
 *
 * The one place a judgement is made is what counts as a *criterion*:
 *
 * | Authority | Criteria |
 * | --- | --- |
 * | Spec | acceptance items, and every `must` requirement |
 * | Design | each included screen state, the tokens and components its tree uses, native visual evidence, and any declared browser matrix |
 * | Plan | boundaries (a boundary whose own scope says security or accessibility is filed as such), migrations, and the verification lines it declared |
 * | Task | its acceptance items, its declared verification commands, its review state, and visual evidence when it declared it needs some |
 */
import {
  VERIFICATION_CRITERIA_MAX,
  VERIFICATION_COMMANDS_MAX,
  VERIFICATION_MATRIX_CELLS_MAX,
  browserMatrixSteps,
  type DesignBody,
  type DesignNode,
  type PlanBody,
  type ProjectTaskBody,
  type ProjectWorkBody,
  type SpecBody,
  type VerificationAuthority,
  type VerificationBlocker,
  type VerificationCriterion,
  type VerificationPlan,
  type VerificationSourceRef,
} from "@lasercode/protocol";
import { ProjectWorkRefusedError } from "../errors.js";
import type { ProjectWorkDetail, ProjectWorkStore } from "../store.js";

/** What the gatherer needs. The store satisfies it; a test can script it. */
export interface VerificationReader {
  get(query: {
    projectId: string;
    entityId?: string | undefined;
    key?: string | undefined;
    revisionId?: string | undefined;
    body?: { mode: "full" | "none" | "range" } | undefined;
  }): ProjectWorkDetail;
}

/** Everything one run read, kept so the evaluator does not read it again. */
export interface GatheredAuthorities {
  task: ProjectWorkDetail;
  taskBody: ProjectTaskBody;
  spec?: { detail: ProjectWorkDetail; body: SpecBody };
  design?: { detail: ProjectWorkDetail; body: DesignBody };
  plan?: { detail: ProjectWorkDetail; body: PlanBody };
}

const MUST_REQUIREMENTS_MAX = 64;
const DESIGN_STATES_MAX = 64;
const DESIGN_TOKENS_MAX = 32;
const DESIGN_COMPONENTS_MAX = 32;

/** The exact revision an authority was read at, as the report records it. */
export function sourceRefOf(detail: ProjectWorkDetail, authority: VerificationAuthority): VerificationSourceRef {
  return {
    authority,
    entityId: detail.entity.entityId,
    kind: detail.entity.kind,
    key: detail.entity.key,
    revisionId: detail.revision.revisionId,
    digest: detail.revision.digest,
    title: detail.entity.title,
  };
}

function bodyOf(detail: ProjectWorkDetail): ProjectWorkBody | undefined {
  return detail.body?.body;
}

/**
 * Read the Task and everything it is answerable to.
 *
 * A Spec or a Design is found through an edge, at the revision that edge
 * names; when a gated Spec is known but nothing was linked, the gate report's
 * own Spec is read at its current revision and the report says so by carrying
 * that revision. Nothing is guessed from a title or a name.
 */
export function gatherAuthorities(reader: VerificationReader, projectId: string, entityId: string): GatheredAuthorities {
  const task = reader.get({ projectId, entityId, body: { mode: "full" } });
  if (task.entity.kind !== "task") {
    throw new ProjectWorkRefusedError(
      "Only a project task is verified: a verification run checks an implementation against the spec, design and plan behind one task.",
    );
  }
  const body = bodyOf(task);
  if (body?.kind !== "task") {
    throw new ProjectWorkRefusedError("That task's body could not be read, so there is nothing to verify it against.");
  }
  const gathered: GatheredAuthorities = { task, taskBody: body.task };

  let plan: ProjectWorkDetail | undefined;
  if (body.task.planKey) {
    try {
      plan = reader.get({ projectId, key: body.task.planKey, body: { mode: "full" } });
    } catch {
      // A Plan whose key no longer exists is not an authority. The Task keeps
      // its own criteria and the report lists three authorities, not four.
      plan = undefined;
    }
  }
  const planBody = plan ? bodyOf(plan) : undefined;
  if (plan && planBody?.kind === "plan") gathered.plan = { detail: plan, body: planBody.plan };

  const linked = linkedRevisions([task, ...(plan ? [plan] : [])]);
  const specRef = linked.get("spec") ?? (task.gates ? { entityId: task.gates.specEntityId } : undefined);
  const designRef = linked.get("design");

  const spec = readAt(reader, projectId, specRef);
  const specBody = spec ? bodyOf(spec) : undefined;
  if (spec && specBody?.kind === "spec") gathered.spec = { detail: spec, body: specBody.spec };

  const design = readAt(reader, projectId, designRef);
  const designBody = design ? bodyOf(design) : undefined;
  if (design && designBody?.kind === "design") gathered.design = { detail: design, body: designBody.design };

  return gathered;
}

function readAt(
  reader: VerificationReader,
  projectId: string,
  ref: { entityId: string; revisionId?: string } | undefined,
): ProjectWorkDetail | undefined {
  if (!ref) return undefined;
  try {
    return reader.get({
      projectId,
      entityId: ref.entityId,
      ...(ref.revisionId !== undefined ? { revisionId: ref.revisionId } : {}),
      body: { mode: "full" },
    });
  } catch {
    return undefined;
  }
}

/**
 * The Spec and Design revisions the recorded edges name.
 *
 * An edge is `subject —relation→ object`, and either end may be the artifact:
 * a Task `implements` a Design, a Design `supports` a Spec. Whichever end is
 * not the entity we started from is the one that is read, at the revision the
 * edge itself pinned.
 */
function linkedRevisions(details: readonly ProjectWorkDetail[]): Map<string, { entityId: string; revisionId: string }> {
  const found = new Map<string, { entityId: string; revisionId: string }>();
  for (const detail of details) {
    for (const edge of detail.edges) {
      for (const end of [edge.subject, edge.object]) {
        if (end.entityId === detail.entity.entityId) continue;
        if (end.kind !== "spec" && end.kind !== "design") continue;
        if (found.has(end.kind)) continue;
        found.set(end.kind, { entityId: end.entityId, revisionId: end.revisionId });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

/** Build the run's question: every criterion, and what already blocks it. */
export function planFrom(gathered: GatheredAuthorities): VerificationPlan {
  const taskRef = sourceRefOf(gathered.task, "task");
  const authorities: VerificationSourceRef[] = [taskRef];
  const criteria: VerificationCriterion[] = [];
  const truncated: string[] = [];

  const commands = gathered.taskBody.verificationCommands.slice(0, VERIFICATION_COMMANDS_MAX);
  if (gathered.taskBody.verificationCommands.length > commands.length) truncated.push(taskRef.key);

  // --- the Task's own ---
  for (const item of gathered.taskBody.acceptance) {
    criteria.push({
      id: `task:${item.id}`,
      authority: "task",
      kind: "acceptance",
      text: item.text,
      required: true,
      machineVerifiable: item.machineVerifiable,
      source: taskRef,
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.machineVerifiable && item.command === undefined
        ? { steps: [`Check "${item.text}" yourself, then record what you saw as evidence on ${taskRef.key}.`] }
        : {}),
    });
  }
  commands.forEach((command, index) => {
    criteria.push({
      id: `task:command:${String(index)}`,
      authority: "task",
      kind: "command",
      text: `${command} passes.`,
      required: true,
      machineVerifiable: true,
      source: taskRef,
      command,
    });
  });
  criteria.push({
    id: "task:review",
    authority: "task",
    kind: "review",
    text: "No blocking comment, stale approval or stale upstream is left on this task or what it implements.",
    required: true,
    machineVerifiable: true,
    source: taskRef,
  });
  if (gathered.taskBody.visualEvidenceRequired) {
    criteria.push({
      id: "task:visual",
      authority: "task",
      kind: "visual",
      text: "Native visual evidence has been accepted for this task.",
      required: true,
      machineVerifiable: false,
      source: taskRef,
    });
  }

  // --- the Spec ---
  if (gathered.spec) {
    const ref = sourceRefOf(gathered.spec.detail, "spec");
    authorities.push(ref);
    for (const item of gathered.spec.body.acceptance) {
      const bound = boundCommand(item.text, gathered.taskBody);
      criteria.push({
        id: `spec:${item.id}`,
        authority: "spec",
        kind: "acceptance",
        text: item.text,
        required: true,
        machineVerifiable: item.machineVerifiable,
        source: ref,
        ...(bound !== undefined ? { command: bound } : {}),
        ...(item.machineVerifiable && bound === undefined
          ? {
              steps: [
                `Bind a command to "${item.text}" on ${taskRef.key}, so a run can decide it.`,
                "Or check it yourself and record what you saw as evidence.",
              ],
            }
          : {}),
      });
    }
    for (const requirement of gathered.spec.body.requirements.slice(0, MUST_REQUIREMENTS_MAX)) {
      if (requirement.level !== "must") continue;
      criteria.push({
        id: `spec:req:${requirement.id}`,
        authority: "spec",
        kind: "requirement",
        text: requirement.text,
        required: true,
        machineVerifiable: false,
        source: ref,
      });
    }
  }

  // --- the Design ---
  if (gathered.design) {
    const ref = sourceRefOf(gathered.design.detail, "design");
    authorities.push(ref);
    criteria.push(...designCriteria(gathered.design.body, ref));
  }

  // --- the Plan ---
  if (gathered.plan) {
    const ref = sourceRefOf(gathered.plan.detail, "plan");
    authorities.push(ref);
    criteria.push(...planCriteria(gathered.plan.body, ref, commands));
  }

  // --- the browser matrix, declared on a Design or a Plan ---
  criteria.push(...matrixCriteria(gathered));

  const bounded = criteria.slice(0, VERIFICATION_CRITERIA_MAX);
  if (criteria.length > bounded.length) truncated.push(taskRef.key);

  return {
    task: taskRef,
    authorities,
    criteria: bounded,
    commands,
    blockers: blockersOf(gathered),
    truncated: [...new Set(truncated)],
  };
}

/** A Spec criterion is decided by a command only when the Task bound one to it. */
function boundCommand(text: string, task: ProjectTaskBody): string | undefined {
  const match = task.acceptance.find((item) => item.text.trim() === text.trim() && item.command !== undefined);
  return match?.command;
}

function designCriteria(design: DesignBody, ref: VerificationSourceRef): VerificationCriterion[] {
  const criteria: VerificationCriterion[] = [];
  let states = 0;
  const tokens = new Set<string>();
  const components = new Set<string>();
  for (const screen of design.screens) {
    for (const state of screen.states) {
      if (!state.included || states >= DESIGN_STATES_MAX) continue;
      states += 1;
      criteria.push({
        id: `design:state:${screen.id}:${state.name}`,
        authority: "design",
        kind: "design_state",
        text: `${screen.name} has its ${state.name} state.`,
        required: true,
        machineVerifiable: false,
        source: ref,
      });
    }
    if (!("tree" in screen.content)) continue;
    for (const node of screen.content.tree.nodes) collectUsage(node, tokens, components);
  }
  for (const token of [...tokens].slice(0, DESIGN_TOKENS_MAX)) {
    criteria.push({
      id: `design:token:${token}`,
      authority: "design",
      kind: "design_token",
      text: `The value for ${token} comes from the token, not from a literal.`,
      required: true,
      machineVerifiable: false,
      source: ref,
    });
  }
  for (const component of [...components].slice(0, DESIGN_COMPONENTS_MAX)) {
    criteria.push({
      id: `design:component:${component}`,
      authority: "design",
      kind: "design_component",
      text: `The design's ${component} is the component the implementation uses.`,
      required: true,
      machineVerifiable: false,
      source: ref,
    });
  }
  if (design.screens.length > 0) {
    criteria.push({
      id: "design:visual",
      authority: "design",
      kind: "visual",
      text: `Native visual evidence for ${ref.key} has been accepted.`,
      required: true,
      machineVerifiable: false,
      source: ref,
    });
  }
  return criteria;
}

function collectUsage(node: DesignNode, tokens: Set<string>, components: Set<string>): void {
  components.add("indexEntryId" in node.component ? node.component.indexEntryId : node.component.primitive);
  for (const value of Object.values(node.props)) {
    if (value.type === "token") tokens.add(value.tokenId);
  }
}

/**
 * The Plan's boundaries, migrations and verification lines.
 *
 * A boundary is filed as `security` or `accessibility` when **its own scope
 * says so**. That is a declaration the Plan's author wrote, not a guess about
 * what a rule means: no heuristic reads the rule's prose.
 */
function planCriteria(plan: PlanBody, ref: VerificationSourceRef, taskCommands: readonly string[]): VerificationCriterion[] {
  const criteria: VerificationCriterion[] = [];
  plan.boundaries.forEach((boundary, index) => {
    criteria.push({
      id: `plan:boundary:${String(index)}`,
      authority: "plan",
      kind: boundaryKind(boundary.scope),
      text: `${boundary.scope}: ${boundary.rule}`,
      required: true,
      machineVerifiable: false,
      source: ref,
    });
  });
  plan.migrations.forEach((migration, index) => {
    criteria.push({
      id: `plan:migration:${String(index)}`,
      authority: "plan",
      kind: "migration",
      text: `${migration.summary}${migration.reversible ? " (reversible)" : " (not reversible)"}`,
      required: true,
      machineVerifiable: false,
      source: ref,
    });
  });
  plan.verification.forEach((step, index) => {
    if (MATRIX_LINE.test(step)) return;
    const bound = taskCommands.find((command) => command.trim() === step.trim());
    criteria.push({
      id: `plan:verification:${String(index)}`,
      authority: "plan",
      kind: bound === undefined ? "requirement" : "command",
      text: step,
      required: true,
      machineVerifiable: bound !== undefined,
      source: ref,
      ...(bound !== undefined ? { command: bound } : {}),
    });
  });
  return criteria;
}

function boundaryKind(scope: string): VerificationCriterion["kind"] {
  const lower = scope.toLocaleLowerCase();
  if (/security|privacy|secret|credential/.test(lower)) return "security";
  if (/accessib|a11y|keyboard|screen reader/.test(lower)) return "accessibility";
  return "boundary";
}

// ---------------------------------------------------------------------------
// The browser matrix — declared, listed, never run (AGENTS.md, D-342)
// ---------------------------------------------------------------------------

/** `browser matrix: themes=light,dark; widths=narrow,wide; pointers=fine,coarse` */
const MATRIX_LINE = /^\s*browser\s+matrix\s*:/i;

interface MatrixAxes {
  themes: string[];
  widths: string[];
  pointers: string[];
}

/** Parse one declared matrix line. Anything it does not name is not checked. */
export function parseBrowserMatrix(line: string): MatrixAxes | undefined {
  if (!MATRIX_LINE.test(line)) return undefined;
  const body = line.slice(line.indexOf(":") + 1);
  const axes: MatrixAxes = { themes: [], widths: [], pointers: [] };
  for (const part of body.split(";")) {
    const [rawName, rawValues] = part.split("=");
    if (rawName === undefined || rawValues === undefined) continue;
    const name = rawName.trim().toLocaleLowerCase();
    const values = rawValues
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 8);
    if (name === "themes" || name === "theme") axes.themes = values;
    else if (name === "widths" || name === "width" || name === "viewports") axes.widths = values;
    else if (name === "pointers" || name === "pointer") axes.pointers = values;
  }
  return axes.themes.length + axes.widths.length + axes.pointers.length > 0 ? axes : undefined;
}

/**
 * Every declared browser-matrix cell, as a `needs_person` criterion carrying
 * the exact steps.
 *
 * An agent never opens a browser to check one (`AGENTS.md`; D-342): the run
 * lists the walk and hands it to the person, and the report says so where the
 * decisions are.
 */
function matrixCriteria(gathered: GatheredAuthorities): VerificationCriterion[] {
  const declarations: Array<{ axes: MatrixAxes; ref: VerificationSourceRef }> = [];
  if (gathered.plan) {
    const ref = sourceRefOf(gathered.plan.detail, "plan");
    for (const line of [...gathered.plan.body.verification, ...gathered.plan.body.boundaries.map((b) => b.rule)]) {
      const axes = parseBrowserMatrix(line);
      if (axes) declarations.push({ axes, ref });
    }
  }
  if (gathered.design) {
    const ref = sourceRefOf(gathered.design.detail, "design");
    const themes = [...new Set(gathered.design.body.screens.map((screen) => screen.theme).filter(isText))];
    const widths = [...new Set(gathered.design.body.screens.map((screen) => screen.viewport).filter(isText))];
    if (themes.length + widths.length > 0) declarations.push({ axes: { themes, widths, pointers: [] }, ref });
  }
  const criteria: VerificationCriterion[] = [];
  for (const declaration of declarations) {
    const themes = declaration.axes.themes.length > 0 ? declaration.axes.themes : [undefined];
    const widths = declaration.axes.widths.length > 0 ? declaration.axes.widths : [undefined];
    const pointers = declaration.axes.pointers.length > 0 ? declaration.axes.pointers : [undefined];
    for (const theme of themes) {
      for (const width of widths) {
        for (const pointer of pointers) {
          if (criteria.length >= VERIFICATION_MATRIX_CELLS_MAX) return criteria;
          const cell = [theme, width, pointer].filter(isText);
          criteria.push({
            id: `matrix:${declaration.ref.key}:${cell.join("-") || "default"}`,
            authority: declaration.ref.authority,
            kind: "browser_matrix",
            text: `Checked in ${cell.join(", ") || "the declared browser matrix"}.`,
            required: true,
            machineVerifiable: false,
            source: declaration.ref,
            steps: browserMatrixSteps({
              ...(theme !== undefined ? { theme } : {}),
              ...(width !== undefined ? { width } : {}),
              ...(pointer !== undefined ? { pointer } : {}),
            }),
          });
        }
      }
    }
  }
  return criteria;
}

function isText(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/**
 * What already stops this Task converging, before a command runs.
 *
 * "Nothing is called converged while a blocking comment, stale approval or
 * failed required check remains" (leap). The first two are read here; the
 * third is read after the commands, where the exit codes are.
 */
export function blockersOf(gathered: GatheredAuthorities): VerificationBlocker[] {
  const blockers: VerificationBlocker[] = [];
  const details: Array<{ detail: ProjectWorkDetail }> = [
    { detail: gathered.task },
    ...(gathered.spec ? [{ detail: gathered.spec.detail }] : []),
    ...(gathered.design ? [{ detail: gathered.design.detail }] : []),
    ...(gathered.plan ? [{ detail: gathered.plan.detail }] : []),
  ];
  for (const { detail } of details) {
    for (const comment of detail.comments) {
      if (!comment.blocking || comment.state === "resolved") continue;
      blockers.push({
        kind: "blocking_comment",
        detail: `${detail.entity.key} has a blocking comment nobody has resolved: “${comment.text.slice(0, 200)}”.`,
        key: detail.entity.key,
        reference: comment.commentId,
      });
    }
    for (const approval of detail.approvals) {
      if (approval.decision !== "approved" || approval.invalidatedAt === undefined) continue;
      blockers.push({
        kind: "stale_approval",
        detail: `The ${approval.gate} approval on ${detail.entity.key} was invalidated by a later change, so what it covered is no longer approved.`,
        key: detail.entity.key,
        reference: approval.approvalId,
      });
    }
  }
  const readiness = gathered.task.readiness;
  if (readiness?.stalePausedBy) {
    blockers.push({
      kind: "stale_upstream",
      detail: `${readiness.stalePausedBy.key} changed after this task was planned. Reconcile it before this task can converge.`,
      key: readiness.stalePausedBy.key,
    });
  }
  for (const unmet of readiness?.unmetDependencies ?? []) {
    blockers.push({ kind: "unmet_dependency", detail: `${unmet} is not done yet.`, key: unmet });
  }
  return blockers;
}

/** The store, as the gatherer reads it. */
export function readerOf(store: ProjectWorkStore): VerificationReader {
  return { get: (query) => store.get(query) };
}
