/**
 * Conform or Island, proposed with reasons and trade-offs (M21-T12).
 *
 * `docs/design-phase.md`, "Two strategies, chosen explicitly":
 *
 * | Strategy | Meaning | Index era used | Typical when |
 * | --- | --- | --- | --- |
 * | Conform | build in the host's own idiom — its classes, partials, helpers | the host's era | small feature, page stays, team knows the stack |
 * | Island | mount one self-contained modern component in the region, bridging the look through CSS custom properties at the boundary | the current era inside, the host era at the boundary | larger feature, migration wanted, host stack cannot express it |
 *
 * **The model proposes; the person chooses.** So this module never returns a
 * decision: it returns both cases, always both, each with its reasons and its
 * trade-offs, and says which one it would pick and why. A recommendation with
 * no case for the other option is not a proposal, it is a nudge.
 *
 * Pure and deterministic: the same inputs give the same proposal, which is
 * what makes the reasons reviewable.
 */
import type { DesignBody, DesignStrategy } from "@lasercode/protocol";

/** An era, as much of one as a strategy needs. Comes from the Design Index. */
export interface StrategyEra {
  id: string;
  name: string;
  /** Frameworks and styling, as the index recorded them. */
  stack: readonly string[];
  useForNewWork: boolean;
}

export const FEATURE_SIZES = ["small", "medium", "large"] as const;
export type FeatureSize = (typeof FEATURE_SIZES)[number];

export interface StrategyInput {
  /** The era the host page itself belongs to. */
  host: StrategyEra;
  /** Every era the index knows, the host's included. */
  eras: readonly StrategyEra[];
  /** How much is being added. An honest estimate, not a measurement. */
  featureSize: FeatureSize;
  /** False when the host's own stack cannot express the feature at all. */
  hostStackCanExpress?: boolean;
  /** True when the team works in the host's stack day to day. */
  teamKnowsHostStack?: boolean;
  /** True when a migration off the host era is wanted. */
  migrationWanted?: boolean;
}

export interface StrategyCase {
  kind: DesignStrategy;
  /** Why this one, in this project, for this feature. */
  reasons: string[];
  /** What it costs. Never empty: both strategies cost something. */
  tradeoffs: string[];
  /** The index era the new work is composed in under this strategy. */
  eraId: string;
}

export interface StrategyProposal {
  recommended: DesignStrategy;
  conform: StrategyCase;
  island: StrategyCase;
  /** The era marked `useForNewWork`, when the index has one. */
  newWorkEra?: StrategyEra;
  /** One sentence for the chip: what is recommended and why. */
  summary: string;
  /** True while Island is a proposal for the Plan rather than a decision. */
  proposalOnly: boolean;
}

function stackOf(era: StrategyEra | undefined): string {
  const stack = era?.stack.filter((part) => part !== "") ?? [];
  return stack.length === 0 ? "its own stack" : stack.join(" + ");
}

/** The era new work belongs in: the one marked, else the host's own. */
export function newWorkEraOf(input: Pick<StrategyInput, "eras" | "host">): StrategyEra | undefined {
  return input.eras.find((era) => era.useForNewWork) ?? (input.host.useForNewWork ? input.host : undefined);
}

/**
 * Both cases, and the one this proposes. Scored, so the recommendation and
 * the reasons can never disagree: every point scored is a sentence.
 */
export function proposeStrategy(input: StrategyInput): StrategyProposal {
  const newWork = newWorkEraOf(input);
  const sameEra = newWork === undefined || newWork.id === input.host.id;
  const canExpress = input.hostStackCanExpress !== false;
  const knowsStack = input.teamKnowsHostStack !== false;

  const conformReasons: string[] = [];
  const islandReasons: string[] = [];
  let score = 0;

  if (sameEra) {
    conformReasons.push(`The host page is already in the era new work is composed in (${input.host.name}, ${stackOf(input.host)}), so conforming adds nothing new to maintain.`);
  } else {
    score += 2;
    islandReasons.push(
      `The host page is ${input.host.name} (${stackOf(input.host)}) and new work belongs in ${newWork.name} (${stackOf(newWork)}); an island keeps the new code in the era the project actually maintains.`,
    );
    conformReasons.push(`Staying in ${input.host.name} keeps the page in one idiom, with no bundle boundary and no second stack on it.`);
  }

  if (!canExpress) {
    score += 3;
    islandReasons.push(`The host's own stack (${stackOf(input.host)}) cannot express this feature, so conforming would mean writing it twice or writing it badly.`);
  } else {
    conformReasons.push(`The host's own stack can express this feature with its existing components and helpers.`);
  }

  if (input.featureSize === "large") {
    score += 1;
    islandReasons.push("The feature is large enough that one self-contained component is easier to review and to move than a spread of template edits.");
  } else if (input.featureSize === "small") {
    score -= 1;
    conformReasons.push("This is a small feature; one more partial in the host's idiom is less code, and less risk, than a seam.");
  } else {
    conformReasons.push("The feature is middling; the host's idiom carries it without a seam.");
  }

  if (input.migrationWanted === true) {
    score += 1;
    islandReasons.push(`A migration off ${input.host.name} is wanted, and this page becomes the first piece of it.`);
  }

  if (!knowsStack) {
    score += 1;
    islandReasons.push(`The team does not work in ${stackOf(input.host)} day to day, so new work there ages badly.`);
  } else {
    conformReasons.push(`The team works in ${stackOf(input.host)} day to day.`);
  }

  const conform: StrategyCase = {
    kind: "conform",
    reasons: conformReasons,
    tradeoffs: [
      `The new work inherits ${input.host.name}'s constraints and ages with it.`,
      ...(sameEra ? [] : [`Nothing of this feature moves the project towards ${newWork.name}.`]),
      ...(canExpress ? [] : ["What the host stack cannot express has to be faked, and a facsimile is what would ship."]),
    ],
    eraId: input.host.id,
  };

  const islandEraId = newWork?.id ?? input.host.id;
  const island: StrategyCase = {
    kind: "island",
    reasons: islandReasons.length > 0 ? islandReasons : [`One self-contained component, composed in ${newWork?.name ?? input.host.name}, mounted into the region.`],
    tradeoffs: [
      `The island has to be built into ${input.host.name}'s existing build, which is Plan and Task work rather than Design work.`,
      "The seam needs a contract: the host era's values mapped to CSS custom properties at the boundary, and an explicit events/props API across it.",
      "Until the rest follows, the page carries two idioms and two ways of doing the same thing.",
    ],
    eraId: islandEraId,
  };

  const recommended: DesignStrategy = score >= 2 ? "island" : "conform";
  const head = (recommended === "island" ? island.reasons[0] : conform.reasons[0]) ?? "";
  return {
    recommended,
    conform,
    island,
    ...(newWork !== undefined ? { newWorkEra: newWork } : {}),
    summary: `${recommended === "island" ? "Island" : "Conform"} — ${head} The other option is on the table with its own reasons; the choice is the person's.`,
    // Bundling an island into a legacy build is Plan/Task work, so a Design
    // records Island as a proposal (docs/design-phase.md, "Two strategies").
    proposalOnly: recommended === "island",
  };
}

export interface StrategyRecordInput {
  choice: DesignStrategy;
  proposal: StrategyProposal;
  /** The files this design would change. From the grounding, then edited. */
  targetFiles: readonly string[];
  /** How it joins the host. Defaulted from the strategy when not given. */
  integrationContract?: string;
  /** Override the proposal's own "this is a proposal for the Plan". */
  proposalOnly?: boolean;
}

/** The default integration contract for each strategy, in plain sentences. */
export function defaultIntegrationContract(choice: DesignStrategy, proposal: StrategyProposal, targetFiles: readonly string[]): string {
  const files = targetFiles.length === 0 ? "the page's own template" : targetFiles.slice(0, 6).join(", ");
  if (choice === "conform") {
    return `Conform: the new subtree is written in the host's own idiom — its classes, partials and helpers — inside ${files}. No new build step, no new dependency, no boundary.`;
  }
  const era = proposal.newWorkEra?.name ?? "the current era";
  return (
    `Island: one self-contained component composed in ${era}, mounted into the region in ${files}. ` +
    `At the boundary the host era's values are mapped to CSS custom properties, and everything crossing the seam is a declared prop in or event out. ` +
    `Bundling it into the host's build is Plan and Task work, previewed like any repository change.`
  );
}

/** What the Design body records once the person has chosen (or proposed). */
export function strategyRecord(input: StrategyRecordInput): NonNullable<DesignBody["strategy"]> {
  const chosen = input.choice === "island" ? input.proposal.island : input.proposal.conform;
  const other = input.choice === "island" ? input.proposal.conform : input.proposal.island;
  const proposalOnly = input.proposalOnly ?? (input.choice === "island" ? input.proposal.proposalOnly : false);
  return {
    kind: input.choice,
    reason: chosen.reasons[0] ?? input.proposal.summary,
    targetFiles: [...input.targetFiles].slice(0, 200),
    integrationContract: input.integrationContract ?? defaultIntegrationContract(input.choice, input.proposal, input.targetFiles),
    reasons: chosen.reasons.slice(0, 12),
    tradeoffs: chosen.tradeoffs.slice(0, 12),
    alternative: { kind: other.kind, reasons: other.reasons.slice(0, 12), tradeoffs: other.tradeoffs.slice(0, 12) },
    eraId: chosen.eraId,
    ...(proposalOnly ? { proposalOnly: true } : {}),
  };
}
