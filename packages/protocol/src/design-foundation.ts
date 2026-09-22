/**
 * Foundation mode, as pure rules (M21-T14; `docs/design-phase.md`, "Case A ·
 * Foundation mode").
 *
 * The worker proposes a greenfield foundation and the window edits and
 * approves it. Neither may hold the rules that decide what a proposal *is* —
 * the order of the steps, what makes one complete, what the Design Profile
 * digest is taken over, and what "superseded by the index" means in token
 * names — so those rules live here, beside the schema they describe, and both
 * sides import them.
 *
 * Everything in this file is pure and platform-free. The digest itself is
 * taken by the caller's own crypto over {@link foundationCanonicalJson}: the
 * worker hashes it with Node's `createHash`, the window with `crypto.subtle`,
 * and the bytes they hash are byte-identical because this function decides
 * them.
 */
import { flattenDesignTokens } from "./design-tree.js";
import {
  FOUNDATION_STEP_IDS,
  type DesignFoundation,
  type DesignTokenGroup,
  type FoundationStepId,
  type FoundationStepRecord,
  type PlanBody,
  type ProjectTaskBody,
} from "./project-work-bodies.js";

/** One step of Foundation mode, with what it decides and why it is here. */
export interface FoundationStepDefinition {
  id: FoundationStepId;
  /** The step's name on screen. */
  label: string;
  /** What this step settles, in one sentence for a person. */
  purpose: string;
  /** The body fields this step writes. Nothing else on the body moves. */
  writes: readonly (keyof DesignFoundation)[];
}

/**
 * The ten steps, in the contract's order. A step may be proposed only when
 * every step before it has been accepted: each one is the input to the next.
 */
export const FOUNDATION_STEPS: readonly FoundationStepDefinition[] = [
  {
    id: "principles",
    label: "Principles",
    purpose: "What this product should feel like, in a handful of lines everything after this is measured against.",
    writes: ["principles"],
  },
  {
    id: "primitive_tokens",
    label: "Primitive tokens",
    purpose: "The raw palette: colour ramps, base sizes and the families every semantic name will point at.",
    writes: ["tokens"],
  },
  {
    id: "semantic_tokens",
    label: "Semantic tokens and modes",
    purpose: "The names the product actually uses — ground, ink, line, status — and the light and dark modes over them.",
    writes: ["tokens", "modes"],
  },
  {
    id: "type_scale",
    label: "Type scale",
    purpose: "The sizes, line heights and weights text is allowed to take, and what each one is for.",
    writes: ["typeScale"],
  },
  {
    id: "space_radius_shadow_z",
    label: "Spacing, radius, shadow and depth",
    purpose: "The rhythm of the layout, the softness of its corners, the elevation of its surfaces and the order they stack in.",
    writes: ["scales"],
  },
  {
    id: "motion",
    label: "Motion",
    purpose: "How long things take, how they ease, and what happens for someone who asked for less movement.",
    writes: ["motion"],
  },
  {
    id: "icon_and_asset_sources",
    label: "Icon and asset sources",
    purpose: "Where icons, illustrations and fonts come from — each with the licence check that decides whether it may be used at all.",
    writes: ["sources"],
  },
  {
    id: "layout_rules",
    label: "Layout rules",
    purpose: "Page frames, widths, breakpoints and density: the rules a screen is composed under.",
    writes: ["layoutRules"],
  },
  {
    id: "accessibility_floor",
    label: "Accessibility floor",
    purpose: "The minimums nothing in this product may go below: contrast, text size, focus and target size.",
    writes: ["accessibility"],
  },
  {
    id: "component_contracts",
    label: "Core component contracts",
    purpose: "Button, Input, Select, Checkbox, Card, Dialog, Toast, Nav, Table and the empty, error and loading states.",
    writes: ["components"],
  },
];

const STEP_INDEX = new Map<FoundationStepId, number>(FOUNDATION_STEP_IDS.map((id, index) => [id, index]));

/** Where a step sits in the fixed order, or `-1` when it is not a step. */
export function foundationStepIndex(id: string): number {
  return STEP_INDEX.get(id as FoundationStepId) ?? -1;
}

export function foundationStep(id: string): FoundationStepDefinition | undefined {
  return FOUNDATION_STEPS.find((step) => step.id === id);
}

/** The steps as they stand, in order, whatever order they were recorded in. */
export function foundationSteps(foundation: Pick<DesignFoundation, "steps"> | undefined): FoundationStepRecord[] {
  return [...(foundation?.steps ?? [])].sort((left, right) => foundationStepIndex(left.id) - foundationStepIndex(right.id));
}

export function foundationStepState(
  foundation: Pick<DesignFoundation, "steps"> | undefined,
  id: FoundationStepId,
): FoundationStepRecord | undefined {
  return foundation?.steps?.find((step) => step.id === id);
}

/** The step Foundation mode would propose next, or `undefined` when it is done. */
export function nextFoundationStep(foundation: Pick<DesignFoundation, "steps"> | undefined): FoundationStepId | undefined {
  for (const id of FOUNDATION_STEP_IDS) {
    const record = foundationStepState(foundation, id);
    if (!record || record.state !== "accepted") return id;
  }
  return undefined;
}

/** Why a step may not be proposed yet, in the sentence a person or a model reads. */
export interface FoundationOrderRefusal {
  code: "unknown_step" | "out_of_order" | "already_accepted";
  message: string;
  /** The step that must be settled first, when one must. */
  blockedBy?: FoundationStepId;
  next: FoundationStepId | undefined;
}

/**
 * Whether this step may be proposed now.
 *
 * The rule is the contract's, not a convenience: a proposal is a one-shot
 * completion given the person's inputs *and the steps already accepted*, so a
 * step proposed before its inputs exist would be composed out of nothing.
 * Re-proposing a step that is only `proposed` is allowed — that is what
 * "each editable" means; re-proposing an accepted one is refused so an
 * accepted decision is never quietly rewritten.
 */
export function checkFoundationStepOrder(
  foundation: Pick<DesignFoundation, "steps"> | undefined,
  id: string,
  options: { replace?: boolean } = {},
): FoundationOrderRefusal | undefined {
  const next = nextFoundationStep(foundation);
  const index = foundationStepIndex(id);
  if (index === -1) {
    return {
      code: "unknown_step",
      message: `"${id}" is not one of the foundation's steps. They are, in order: ${FOUNDATION_STEP_IDS.join(", ")}.`,
      next,
    };
  }
  const stepId = id as FoundationStepId;
  const existing = foundationStepState(foundation, stepId);
  if (existing?.state === "accepted" && options.replace !== true) {
    return {
      code: "already_accepted",
      message: `The ${foundationStep(stepId)?.label.toLowerCase() ?? stepId} step is already accepted. Propose it again only when the person asks for it to be reconsidered.`,
      next,
    };
  }
  for (const earlier of FOUNDATION_STEP_IDS.slice(0, index)) {
    const record = foundationStepState(foundation, earlier);
    if (record?.state === "accepted") continue;
    return {
      code: "out_of_order",
      message: `The foundation is proposed in order, and ${foundationStep(earlier)?.label.toLowerCase() ?? earlier} is not settled yet: ${foundationStep(stepId)?.label.toLowerCase() ?? stepId} is composed from it.`,
      blockedBy: earlier,
      next,
    };
  }
  return undefined;
}

/**
 * Put one step's record on the foundation, in the contract's order.
 *
 * The one place a step record is written, so the worker and the window cannot
 * drift on where a step lands or what order the list comes back in. What each
 * side *puts* there stays its own: the worker composes a fresh record for a
 * proposal it just made, the window patches the record it already has. This
 * only replaces the row of that id and keeps `steps` sorted, whatever order
 * they arrived in; a step id that is not one of the contract's is appended
 * rather than dropped, because losing a record silently is worse than
 * carrying one the order does not know.
 */
export function withFoundationStep(foundation: DesignFoundation, record: FoundationStepRecord): DesignFoundation {
  const steps = (foundation.steps ?? []).filter((step) => step.id !== record.id);
  steps.push(record);
  steps.sort((left, right) => rank(left.id) - rank(right.id));
  return { ...foundation, steps };
}

/** Where a record sorts: its place in the fixed order, unknown ids last. */
function rank(id: string): number {
  const index = foundationStepIndex(id);
  return index === -1 ? FOUNDATION_STEP_IDS.length : index;
}

/** True when every step has been accepted by the person. */
export function foundationIsComplete(foundation: Pick<DesignFoundation, "steps"> | undefined): boolean {
  return nextFoundationStep(foundation) === undefined;
}

/** How far the proposal has got: accepted steps out of the ten. */
export function foundationProgress(foundation: Pick<DesignFoundation, "steps"> | undefined): { accepted: number; total: number } {
  const accepted = FOUNDATION_STEP_IDS.filter((id) => foundationStepState(foundation, id)?.state === "accepted").length;
  return { accepted, total: FOUNDATION_STEP_IDS.length };
}

/**
 * Sources the foundation may not recommend, with the reason.
 *
 * A source whose licence could not be read is *not* recommended and says so;
 * this is the list a surface shows and the list an approval is checked
 * against (leap, "Design contract": permissive, exact-pinned, provenance
 * retained).
 */
export function foundationBlockedSources(foundation: Pick<DesignFoundation, "sources"> | undefined): Array<{ id: string; name: string; reason: string }> {
  return (foundation?.sources ?? [])
    .filter((source) => !source.recommended)
    .map((source) => ({ id: source.id, name: source.name, reason: source.reason }));
}

/**
 * The bytes the Design Profile digest v1 is taken over.
 *
 * Content only: the approval's own record (`status`, `profile`,
 * `supersededBy`) and every step's bookkeeping are left out, so approving a
 * foundation does not change the digest of the thing being approved, and two
 * machines that hold the same foundation compute the same digest.
 *
 * Keys are emitted in a fixed order and objects are walked with their keys
 * sorted, so a body whose fields were written in a different order still
 * hashes the same.
 */
export function foundationCanonicalJson(foundation: DesignFoundation): string {
  const content: Record<string, unknown> = {
    version: 1,
    principles: foundation.principles,
    tokens: foundation.tokens ?? null,
    modes: foundation.modes ?? null,
    typeScale: foundation.typeScale ?? null,
    scales: foundation.scales ?? null,
    motion: foundation.motion ?? null,
    sources: foundation.sources ?? null,
    layoutRules: foundation.layoutRules ?? null,
    accessibility: foundation.accessibility ?? null,
    components: foundation.components ?? null,
  };
  return canonical(content);
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Every token name the foundation proposes, including its modes, sorted. */
export function foundationTokenNames(foundation: Pick<DesignFoundation, "tokens" | "modes"> | undefined): string[] {
  const names = new Set<string>(tokenNames(foundation?.tokens));
  for (const mode of foundation?.modes ?? []) for (const name of tokenNames(mode.tokens)) names.add(name);
  return [...names].sort();
}

/**
 * Every name in a document, including the ones the frame refuses to draw: a
 * token whose value the renderer skipped is still a name the foundation
 * proposed, and hiding it from the diff would hide exactly the token most
 * worth looking at.
 */
function tokenNames(document: DesignTokenGroup | undefined): string[] {
  const flat = flattenDesignTokens(document);
  return [...flat.tokens.map((token) => token.path), ...flat.skipped.map((entry) => entry.path)];
}

/** The diff a superseded foundation shows: token names gained, lost and kept. */
export interface FoundationTokenDiff {
  added: string[];
  removed: string[];
  kept: string[];
}

/**
 * What the built source's index says about the foundation's token names.
 *
 * Names only. A value that moved is Build's business and the index's; what a
 * person needs here is whether the thing they approved still exists under the
 * name they approved it under.
 */
export function foundationTokenDiff(foundationNames: readonly string[], indexNames: readonly string[]): FoundationTokenDiff {
  const proposed = new Set(foundationNames);
  const built = new Set(indexNames);
  return {
    added: [...built].filter((name) => !proposed.has(name)).sort(),
    removed: [...proposed].filter((name) => !built.has(name)).sort(),
    kept: [...proposed].filter((name) => built.has(name)).sort(),
  };
}

// ---------------------------------------------------------------------------
// Implementation ordering
// ---------------------------------------------------------------------------

/** One Task of the Plan an approved foundation produces, in order. */
export interface FoundationPlanTask {
  title: string;
  body: ProjectTaskBody;
  /** The phase it belongs to, by phase id. */
  phaseId: string;
}

/**
 * The Plan skeleton an approved foundation produces, and its Tasks in order.
 *
 * The rule this encodes is the contract's: **Build implements the foundation
 * first**, and the built source is what the index then reads. So the Plan's
 * first phase holds exactly one Task — emit the tokens and the core
 * components — and every other Task depends on it. A Plan that let a feature
 * be built beside the foundation would produce a codebase with two design
 * languages in it, which is the thing Case A exists to prevent.
 *
 * This produces bodies only. Creating them is `project/work/create`'s, one
 * call per Task and one for the Plan, because keys are minted by the host and
 * a phase names Tasks by key.
 */
export interface FoundationPlanSkeleton {
  plan: PlanBody;
  /** The Tasks to create, foundation first. Their order is the Plan's order. */
  tasks: FoundationPlanTask[];
}

const FOUNDATION_PHASE = "foundation";
const PRODUCT_PHASE = "product";

export function foundationPlanSkeleton(
  foundation: DesignFoundation,
  options: { designKey?: string; product?: string; followOn?: Array<{ title: string; outcome: string }> } = {},
): FoundationPlanSkeleton {
  const designKey = options.designKey;
  const product = options.product?.trim();
  const componentNames = (foundation.components ?? []).map((component) => component.name);
  const sources = (foundation.sources ?? []).filter((source) => source.recommended);
  const blocked = foundationBlockedSources(foundation);
  const tokenCount = foundationTokenNames(foundation).length;

  const foundationTask: FoundationPlanTask = {
    phaseId: FOUNDATION_PHASE,
    title: "Implement the design foundation",
    body: {
      outcome: `The approved foundation exists in the codebase: ${String(tokenCount)} tokens emitted in this stack's own idiom, the ${String(componentNames.length)} core components built against their contracts${designKey ? `, exactly as ${designKey} records them` : ""}.`,
      nonGoals: [
        "No product feature is built in this task: this is the language everything else is then built in.",
        "No design decision is re-opened here. A change to the foundation is a revision of the design, approved again.",
      ],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [
        { id: "tokens", text: "Every approved token exists under the approved name, in every mode, and nothing in the codebase carries a literal value a token already names.", machineVerifiable: false },
        { id: "components", text: `Each core component (${componentNames.slice(0, 12).join(", ") || "as recorded"}) exists with its recorded variants, sizes, slots and states.`, machineVerifiable: false },
        { id: "accessibility", text: `The accessibility floor holds: contrast at least ${String(foundation.accessibility?.contrastMin ?? 4.5)}:1, nothing below ${String(foundation.accessibility?.minFontPx ?? 12)}px, focus visible on every interactive element.`, machineVerifiable: false },
        ...(sources.length > 0
          ? [
              {
                id: "sources",
                text: `Each approved source is pinned exactly with its licence kept beside it: ${sources.map((source) => `${source.name}${source.version ? ` ${source.version}` : ""} (${source.licence.spdx ?? source.licence.classification})`).join(", ")}.`,
                machineVerifiable: false as const,
              },
            ]
          : []),
        { id: "indexed", text: "The design index is rebuilt from the built source and reads it as the authority; the foundation is marked superseded.", machineVerifiable: false },
      ],
      verificationCommands: [],
      visualEvidenceRequired: true,
      assignment: { policy: "unassigned" },
      notes: [
        "Build this first: everything else in this plan is composed from it.",
        ...(blocked.length > 0 ? [`Not to be used: ${blocked.map((source) => `${source.name} — ${source.reason}`).join(" ")}`] : []),
      ].join("\n"),
    },
  };

  const followOn = (options.followOn ?? []).map((task) => ({
    phaseId: PRODUCT_PHASE,
    title: task.title,
    body: {
      outcome: task.outcome,
      nonGoals: ["Nothing here introduces a token, a component or a rule the foundation does not already have."],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [{ id: "from-foundation", text: "Composed entirely from the foundation's tokens and components.", machineVerifiable: false }],
      verificationCommands: [],
      visualEvidenceRequired: true,
      assignment: { policy: "unassigned" as const },
    } satisfies ProjectTaskBody,
  }));

  const plan: PlanBody = {
    brief: product
      ? `Build ${product} on its approved design foundation. The foundation is implemented first; everything else is composed from it.`
      : "Build this product on its approved design foundation. The foundation is implemented first; everything else is composed from it.",
    phases: [
      { id: FOUNDATION_PHASE, name: "Foundation", summary: "The design language, in code: tokens, modes, type, spacing, motion and the core components.", taskKeys: [] },
      ...(followOn.length > 0
        ? [{ id: PRODUCT_PHASE, name: "Product", summary: "Everything composed from the foundation, once it exists.", taskKeys: [] }]
        : []),
    ],
    dependencies: [],
    boundaries: [
      { scope: "design system", rule: "Only the foundation task creates tokens or core components; every other task composes from them." },
      { scope: "licensing", rule: "Imported sources are open source, pinned exactly, with their licences retained beside them." },
    ],
    migrations: [],
    risks: [
      {
        summary: "A feature is built before the foundation exists, and the codebase ends up with two design languages.",
        control: "The foundation task is the first phase and every other task depends on it.",
        severity: "high",
      },
      ...(blocked.length > 0
        ? [
            {
              summary: `${String(blocked.length)} proposed source${blocked.length === 1 ? "" : "s"} could not be recommended on licence grounds.`,
              control: "They are named in the foundation task's notes and are not to be imported until someone decides otherwise.",
              severity: "medium" as const,
            },
          ]
        : []),
    ],
    verification: [
      "The built tokens match the approved names and values.",
      "Each core component matches its recorded contract, in both modes.",
      "The design index, rebuilt from the built source, reads the foundation back.",
    ],
    ...(designKey !== undefined ? { document: `Implements the foundation approved on ${designKey}.` } : {}),
  };

  return { plan, tasks: [foundationTask, ...followOn] };
}

/**
 * Fill the skeleton's phases in once the Tasks have keys.
 *
 * `keys` are in the same order as {@link FoundationPlanSkeleton.tasks}, which
 * is the order they must be created in: the foundation Task first, and every
 * other Task depending on it.
 */
export function foundationPlanWithKeys(skeleton: FoundationPlanSkeleton, keys: readonly string[]): PlanBody {
  const phases = skeleton.plan.phases.map((phase) => ({
    ...phase,
    taskKeys: skeleton.tasks.flatMap((task, index) => (task.phaseId === phase.id && keys[index] !== undefined ? [keys[index]] : [])),
  }));
  const first = keys[0];
  const dependencies =
    first === undefined
      ? []
      : keys.slice(1).flatMap((key) => (key === undefined ? [] : [{ from: key, to: first, reason: "Composed from the foundation, which has to exist first." }]));
  return { ...skeleton.plan, phases, dependencies };
}

/** The sentence every Foundation surface says about the repository. */
export const FOUNDATION_REPOSITORY_SENTENCE =
  "Nothing here is written into the project. The foundation lives in this app until you approve it and a build implements it — the built source is what the design index then reads.";

/** What a foundation shows once the built source has been indexed. */
export const FOUNDATION_SUPERSEDED_SENTENCE =
  "This foundation has been built, and the design index now reads the real source. The index is the authority; this is kept as the proposal it grew from.";
