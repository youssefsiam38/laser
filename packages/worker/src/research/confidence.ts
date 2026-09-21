/**
 * The confidence rule (`docs/research-phase.md`, "Rules"; D-351.c).
 *
 * > A finding's `confidence` is set by the rule, not the model.
 *
 * So `record_finding` does not take the model's word for it. It takes the
 * model's *claim*, computes the verdict from what is actually true of the
 * source — its kind, its trust, whether this session read it, whether an
 * excerpt was quoted, how many findings it was derived from — and answers
 * with the verdict and the reason for it. The protocol's
 * `checkFindingConfidence()` is the same rule stated as a refusal, and the
 * host runs it again on the way in.
 *
 * | Verdict | When |
 * | --- | --- |
 * | `declared` | verbatim from an official or primary source |
 * | `observed` | read or run in this project |
 * | `inferred` | derived from two or more findings, citing them |
 * | `proposed` | everything else: no source yet, or only a secondary one |
 */
import type { FindingConfidence, SourceRef } from "@lasercode/protocol";

export interface ConfidenceInput {
  source: SourceRef;
  excerpt?: string | undefined;
  location?: { path: string; from?: number; to?: number } | undefined;
  /** The findings this claim was derived from, when it was derived. */
  derivedFrom?: readonly string[] | undefined;
  /** Whether this session fetched and read that source. */
  readThisSession?: boolean;
}

export interface ConfidenceVerdict {
  confidence: FindingConfidence;
  /** Why, in one sentence, for the tool result and the finding row. */
  why: string;
}

/** The rule, as a function. Pure, and the only place the four levels are decided. */
export function confidenceFor(input: ConfidenceInput): ConfidenceVerdict {
  const { source } = input;
  const quoted = typeof input.excerpt === "string" && input.excerpt.trim() !== "";
  const derived = (input.derivedFrom ?? []).length;

  if (source.kind === "project") {
    if (quoted || input.location) return { confidence: "observed", why: "It was read in this project, so it is observed." };
    return { confidence: "proposed", why: "Nothing from this project was quoted, so it is a proposal until the file or the output is cited." };
  }
  if (source.kind === "person" || source.kind === "session") {
    return {
      confidence: "proposed",
      why: "What a person said or an earlier session concluded is secondary evidence, so it is a proposal until a source states it.",
    };
  }
  if ((source.trust === "official" || source.trust === "primary") && quoted) {
    return { confidence: "declared", why: `It is quoted verbatim from ${source.trust === "official" ? "the official source" : "a primary source"}, so it is declared.` };
  }
  if (derived >= 2) {
    return { confidence: "inferred", why: `It is derived from ${String(derived)} findings, which it cites, so it is inferred.` };
  }
  if (source.trust === "official" || source.trust === "primary") {
    return { confidence: "proposed", why: "The source is primary but nothing was quoted from it, so it is a proposal until the passage is cited." };
  }
  return {
    confidence: "proposed",
    why: `A ${source.trust} source does not declare a fact on its own, so it is a proposal until a primary source states it or two findings support it.`,
  };
}

/**
 * The verdict beside the claim, and what to say when they differ.
 *
 * The verdict always wins. The note is what the tool tells the model, so a
 * model that asked for `declared` on a blog post learns the rule rather than
 * silently getting something else.
 */
export function reconcileConfidence(claimed: FindingConfidence | undefined, input: ConfidenceInput): ConfidenceVerdict & { note?: string } {
  const verdict = confidenceFor(input);
  if (claimed === undefined || claimed === verdict.confidence) return verdict;
  return {
    ...verdict,
    note: `Recorded as ${verdict.confidence}, not ${claimed}: ${verdict.why} Confidence follows the rule, not the call.`,
  };
}
