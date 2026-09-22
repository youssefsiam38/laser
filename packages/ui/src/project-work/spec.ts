/**
 * The Spec body, as a thing a person edits (M21-T7).
 *
 * Everything here is pure: a draft is the protocol's `SpecBody` with the
 * list fields kept in an order a person can rearrange, and the two
 * conversions between them are total. Nothing invents a field, nothing drops
 * one, and the text used for "view difference" is derived from the body
 * rather than from the screen — so a diff is between two revisions, not
 * between two renderings.
 *
 * The brief/full distinction is the leap's ("Lifecycle and gates"): a brief
 * revision is deliberately small, and a full revision records the agreed
 * behaviour and its acceptance criteria. {@link fullSpecGaps} says what a
 * *full* spec is still missing — it is never said about a brief, because a
 * brief is not an unfinished full spec.
 */
import type { SpecAcceptanceCriterion, SpecBody, SpecForm, SpecRequirement } from "@lasercode/protocol";

/** What a brief is for, in one line, and what a full spec adds. */
export const SPEC_FORM_LABEL: Readonly<Record<SpecForm, string>> = {
  brief: "Brief",
  full: "Full spec",
};

export const SPEC_FORM_DETAIL: Readonly<Record<SpecForm, string>> = {
  brief: "Deliberately small: what this is and why. Nothing else is required of a brief.",
  full: "The agreed behaviour: the problem, the outcomes, the requirements and how they are accepted.",
};

/** Requirement levels, strongest first. `must` blocks a gate; the rest do not. */
export const REQUIREMENT_LEVELS: readonly SpecRequirement["level"][] = ["must", "should", "may"];

let counter = 0;
/** An id for a requirement or a criterion this window just added. */
export function newFieldId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** A copy of the body with every list its own array, safe to edit in place. */
export function specDraft(body: SpecBody): SpecBody {
  return {
    form: body.form,
    brief: body.brief,
    ...(body.problem !== undefined ? { problem: body.problem } : {}),
    outcomes: [...body.outcomes],
    nonGoals: [...body.nonGoals],
    requirements: body.requirements.map((requirement) => ({ ...requirement })),
    acceptance: body.acceptance.map((criterion) => ({ ...criterion })),
    constraints: [...body.constraints],
    ...(body.document !== undefined ? { document: body.document } : {}),
    ...(body.gated !== undefined ? { gated: body.gated } : {}),
  };
}

/**
 * The body to send: empty strings are dropped rather than stored, because an
 * empty optional field is *absent*, not present and blank.
 */
export function specBodyFrom(draft: SpecBody): SpecBody {
  // Whitespace decides only whether an optional row exists. Authored Markdown
  // that survives keeps its exact bytes; normalization would alter code,
  // hard line breaks and revision diffs without the person's consent.
  const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";
  const clean = (values: readonly string[]): string[] => values.filter(present);
  return {
    form: draft.form,
    brief: draft.brief,
    ...(present(draft.problem) ? { problem: draft.problem } : {}),
    outcomes: clean(draft.outcomes),
    nonGoals: clean(draft.nonGoals),
    requirements: draft.requirements.filter((requirement) => present(requirement.text)),
    acceptance: draft.acceptance.filter((criterion) => present(criterion.text)),
    constraints: clean(draft.constraints),
    ...(present(draft.document) ? { document: draft.document } : {}),
    ...(draft.gated !== undefined ? { gated: draft.gated } : {}),
  };
}

export function sameSpecBody(a: SpecBody, b: SpecBody): boolean {
  return specBodyText(a) === specBodyText(b);
}

/** A brief needs its brief. Nothing else about a spec is ever required. */
export function specIsWritable(draft: SpecBody): boolean {
  return draft.brief.trim() !== "";
}

/**
 * What a *full* spec still has nothing in, in the order the document reads.
 *
 * This is a description, not a nag: it is shown on a full spec only, beside
 * the section it names, and a full spec with gaps still saves.
 */
export function fullSpecGaps(body: SpecBody): string[] {
  if (body.form !== "full") return [];
  const gaps: string[] = [];
  if (!body.problem?.trim()) gaps.push("the problem");
  if (body.outcomes.length === 0) gaps.push("outcomes");
  if (body.requirements.length === 0) gaps.push("requirements");
  if (body.acceptance.length === 0) gaps.push("acceptance criteria");
  return gaps;
}

const block = (title: string, lines: readonly string[]): string[] => (lines.length === 0 ? [] : [`## ${title}`, ...lines, ""]);

/**
 * One revision's body as readable text.
 *
 * This is what "view difference" diffs, so it has to be derived only from the
 * body and to be stable: the same body always produces the same text, and a
 * field that moved shows as a moved line rather than as a whole-file change.
 */
export function specBodyText(body: SpecBody): string {
  const lines: string[] = [`# ${SPEC_FORM_LABEL[body.form]}`, "", body.brief.trim(), ""];
  if (body.problem?.trim()) lines.push("## Problem", body.problem.trim(), "");
  lines.push(...block("Outcomes", body.outcomes.map((value) => `- ${value}`)));
  lines.push(...block("Non-goals", body.nonGoals.map((value) => `- ${value}`)));
  lines.push(...block("Requirements", body.requirements.map((requirement) => `- [${requirement.level}] ${requirement.text}`)));
  lines.push(
    ...block(
      "Acceptance",
      body.acceptance.map((criterion) => `- [${criterion.machineVerifiable ? "checkable" : "by a person"}] ${criterion.text}`),
    ),
  );
  lines.push(...block("Constraints", body.constraints.map((value) => `- ${value}`)));
  if (body.document?.trim()) lines.push("## Document", body.document.trim(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** An empty requirement/criterion, for the "add" control in the editor. */
export const newRequirement = (): SpecRequirement => ({ id: newFieldId("req"), text: "", level: "should" });
export const newCriterion = (): SpecAcceptanceCriterion => ({ id: newFieldId("acc"), text: "", machineVerifiable: false });
