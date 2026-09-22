/**
 * What a mentioned artifact hands the worker (M21-T9).
 *
 * The leap's rule for a mention is *captured by reference, not copied*: the
 * conversation stores the identity, and the projection the model reads is a
 * **bounded** view built at send time from the exact revision the message
 * names. So this module answers one question per mention — "what does this
 * kind say about itself in a few hundred characters?" — and never hands over
 * a whole body, a blob, a comment thread or anything a person did not mention.
 *
 * Everything here is pure. The reading, the authority and the refusals belong
 * to `methods.ts` (M21-T3/T17); this turns what was read into what is sent.
 */
import {
  PROJECT_WORK_MENTION_EXCERPT_MAX,
  PROJECT_WORK_MENTION_SUMMARY_FIELDS_MAX,
  PROJECT_WORK_MENTION_SUMMARY_MAX,
  type ProjectWorkBody,
  type ProjectWorkEntity,
  type ProjectWorkMentionField,
  type ProjectWorkMentionProblem,
  type ProjectWorkMentionProjection,
  type ProjectWorkRef,
  type ProjectWorkRevision,
} from "@lasercode/protocol";

/** What one mention was read as. `body` is absent when the revision released it. */
export interface MentionReading {
  ref: ProjectWorkRef;
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  body: ProjectWorkBody | undefined;
  /** The project's display name, for the provenance line. */
  projectName: string;
  /** Why the body is missing, when it is. */
  unavailable?: { reason: ProjectWorkMentionProblem; detail: string } | undefined;
}

const clamp = (value: string, max: number): string => {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

const field = (label: string, value: string | undefined): ProjectWorkMentionField[] =>
  value && value.trim() !== "" ? [{ label, value: clamp(value, PROJECT_WORK_MENTION_SUMMARY_MAX) }] : [];

const list = (label: string, values: readonly string[] | undefined): ProjectWorkMentionField[] =>
  values && values.length > 0 ? field(label, values.join(", ")) : [];

/**
 * `[from Acme TASK-44@3]` — the sentence every quoted fact carries.
 *
 * The revision is named by its index, which is what the workspace shows a
 * person ("Revision 3 of 5"), so the provenance a model repeats back is the
 * one a person can check.
 */
export function mentionProvenance(projectName: string, key: string, revisionIndex: number): string {
  return `[from ${projectName} ${key}@${revisionIndex}]`;
}

/**
 * The bounded body excerpt for one kind, and the fields that stand beside it.
 *
 * Each kind gives up what it is *for*: a Spec its brief and its acceptance, a
 * Research its question and its settled answer, a Design its brief and how
 * real it is, a Plan its brief and shape, a Task its outcome and what it is
 * waiting on. Nothing gives up a blob, a comment or a person's name.
 */
function summarize(body: ProjectWorkBody): { fields: ProjectWorkMentionField[]; excerpt: string | undefined } {
  switch (body.kind) {
    case "spec": {
      const spec = body.spec;
      return {
        fields: [
          ...field("Form", spec.form === "brief" ? "Brief" : "Full"),
          ...field("Problem", spec.problem),
          ...list("Outcomes", spec.outcomes),
          ...list("Non-goals", spec.nonGoals),
          ...field("Requirements", spec.requirements.length > 0 ? String(spec.requirements.length) : undefined),
          ...field("Acceptance", spec.acceptance.length > 0 ? spec.acceptance.map((item) => item.text).join("; ") : undefined),
        ],
        excerpt: spec.brief,
      };
    }
    case "research": {
      const research = body.research;
      const answered = research.questions.filter((question) => question.state === "answered");
      return {
        fields: [
          ...field("Question", research.question),
          ...field("Status", research.status),
          ...field("Questions", `${answered.length} answered of ${research.questions.length}`),
          ...field("Findings", String(research.findings.length)),
          ...list("Options", research.options?.map((option) => (option.recommended ? `${option.name} (recommended)` : option.name))),
        ],
        excerpt: answered.map((question) => question.answer).filter((answer): answer is string => Boolean(answer)).join(" ") || undefined,
      };
    }
    case "design": {
      const design = body.design;
      return {
        fields: [
          ...field("Fidelity", design.fidelity),
          ...field("Screens", design.screens.length > 0 ? design.screens.map((screen) => screen.name).join(", ") : undefined),
          ...field("Strategy", design.strategy?.kind),
          ...field("Host page", design.hostPage?.routeOrPath),
        ],
        excerpt: design.brief,
      };
    }
    case "plan": {
      const plan = body.plan;
      return {
        fields: [
          ...field("Phases", plan.phases.length > 0 ? plan.phases.map((phase) => phase.name).join(", ") : undefined),
          ...field("Tasks", String(plan.phases.reduce((total, phase) => total + phase.taskKeys.length, 0))),
          ...list("Verification", plan.verification),
        ],
        excerpt: plan.brief,
      };
    }
    case "task": {
      const task = body.task;
      return {
        fields: [
          ...list("Depends on", task.dependencies),
          ...list("Paths", task.scope.paths),
          ...field("Acceptance", task.acceptance.length > 0 ? task.acceptance.map((item) => item.text).join("; ") : undefined),
          ...field("Plan", task.planKey),
        ],
        excerpt: task.outcome,
      };
    }
  }
}

/**
 * One mention, as the worker receives it.
 *
 * A reading that could not produce a body still produces a projection: the
 * identity, the title and the state the entity carries, plus the reason the
 * body is missing. A chip that loses its words must never lose its name.
 */
export function mentionProjection(reading: MentionReading): ProjectWorkMentionProjection {
  const summary = reading.body ? summarize(reading.body) : { fields: [] as ProjectWorkMentionField[], excerpt: undefined };
  // A message names one exact revision and keeps naming it. Say which one it
  // is, and say when the project has moved on, so nothing the model repeats
  // is quietly attributed to what is current now.
  const stale = reading.revision.revisionId !== reading.entity.currentRevisionId;
  const revisionField: ProjectWorkMentionField = {
    label: "Revision",
    value: `${reading.revision.index} of ${reading.entity.revisionCount}${stale ? " · not the current revision" : ""}`,
  };
  const excerptSource = summary.excerpt ?? "";
  const excerpt = clamp(excerptSource, PROJECT_WORK_MENTION_EXCERPT_MAX);
  const truncated = excerpt.endsWith("…") && excerptSource.replace(/\s+/gu, " ").trim().length > excerpt.length;
  return {
    ref: reading.ref,
    key: reading.entity.key,
    kind: reading.entity.kind,
    title: reading.revision.title || reading.entity.title,
    state: reading.entity.state,
    provenance: mentionProvenance(reading.projectName, reading.entity.key, reading.revision.index),
    fields: [revisionField, ...summary.fields].slice(0, PROJECT_WORK_MENTION_SUMMARY_FIELDS_MAX),
    ...(excerpt ? { excerpt } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(reading.unavailable ? { unavailable: reading.unavailable } : {}),
  };
}

/** The sentence a person reads when a mention could not be read as it was pinned. */
export function mentionProblemSentence(reason: ProjectWorkMentionProblem, key: string): string {
  switch (reason) {
    case "unknown_project":
      return `${key} is in a project this app does not have here, so its content was not sent.`;
    case "unknown_entity":
      return `${key} no longer exists in that project, so its content was not sent.`;
    case "unknown_revision":
      return `The exact revision of ${key} this message names is no longer stored, so its content was not sent.`;
    case "released":
      return `${key}'s content is no longer kept on this computer, so only its name was sent.`;
    case "unreadable":
      return `This conversation is not allowed to read ${key}, so only its name was sent.`;
  }
}
