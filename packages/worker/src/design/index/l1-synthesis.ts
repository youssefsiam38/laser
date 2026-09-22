/**
 * L1 · synthesis, on the Design-index profile.
 *
 * One bounded completion, walked down `designIndexProfileId` the way session
 * naming walks the naming profile (`docs/model-profiles.md`, "Runtime"): the
 * first model that answers with usable JSON wins, a model that is missing,
 * slow or unparseable is passed over, and a profile that is spent leaves the
 * index exactly as L0 built it plus a gap that says synthesis did not run.
 *
 * What it may do: name eras, propose semantic names for clustered values,
 * describe components from their own source and stories, extract conventions,
 * and write the philosophy. What it may not do: state anything that is not
 * derived from L0 facts. Every item cites fact ids; an item citing an id that
 * does not exist is dropped rather than shown, because an index that quietly
 * invents a component is worse than one that admits a gap.
 *
 * Labels follow the contract: `inferred` when an item cites two or more facts,
 * `proposed` when it is naming or grouping.
 */
import type { DesignIndex, DesignIndexEntry, ModelProfile } from "@lasercode/protocol";
import { stableId, type DesignFact, type Gap } from "./facts.js";
import type { CompletionContext, CompletionRuntime } from "../../agents/session-naming.js";

export const SYNTHESIS_TIMEOUT_MS = 45_000;
const MAX_INPUT_CHARS = 24_000;
const MAX_OUTPUT_TOKENS = 4_000;

export interface SynthesisOptions {
  models: () => Promise<CompletionRuntime>;
  /** The Design-index profile. `null` means synthesis is off for this machine. */
  profile: ModelProfile | null;
  /**
   * Why there is nothing to ask, when there is nothing to ask: no profile at
   * all, or the profile chosen for design work holding no model. It becomes
   * the gap's first sentence, so a person reads what to do rather than that
   * something did not happen.
   */
  unavailable?: string;
  timeoutMs?: number;
  /** Only these entries are re-described; absent means all of them. */
  onlyEntryIds?: readonly string[];
  signal?: AbortSignal;
}

export interface SynthesisResult {
  /** Entries to add or replace, already labelled and cited. */
  entries: DesignIndexEntry[];
  /** Era renames the person can accept: `{ eraId → name }`. */
  eraNames: Map<string, string>;
  /** Proposed semantic names for tokens: `{ entryId → name }`. */
  tokenNames: Map<string, string>;
  gaps: Gap[];
  /** The model that answered, for the index's `builtWith`. */
  model?: string;
  ran: boolean;
}

const EMPTY: Omit<SynthesisResult, "gaps" | "ran"> = { entries: [], eraNames: new Map(), tokenNames: new Map() };

/** True when the machine can synthesise at all: a profile with a model in it. */
export function canSynthesise(profile: ModelProfile | null): boolean {
  return (profile?.models.length ?? 0) > 0;
}

/**
 * The bounded brief the model is given: the stack, the eras, the top tokens,
 * the components with their contracts and examples, and the template
 * conventions — every line carrying the fact id it came from, so a citation is
 * something the model can only copy, not compose.
 */
export function synthesisBrief(index: DesignIndex, facts: readonly DesignFact[]): string {
  const lines: string[] = [];
  lines.push(`Stack: frameworks ${index.stack.frameworks.join(", ") || "none found"}; styling ${index.stack.styling.join(", ") || "none found"}.`);
  lines.push("");
  lines.push("Eras (id · roots · signals):");
  for (const era of index.eras) {
    const entry = index.entries.find((candidate) => candidate.kind === "era" && candidate.id === era.id);
    lines.push(`- ${era.id} · ${era.roots.join(", ")} · ${entry?.detail?.["signals"] ?? ""}`);
  }
  lines.push("");
  lines.push("Tokens (entry id · name · value · uses):");
  for (const token of index.entries.filter((candidate) => candidate.kind === "token").slice(0, 120)) {
    lines.push(`- ${token.id} · ${token.name} · ${token.detail?.["value"] ?? ""} · ${token.detail?.["usages"] ?? "1"}`);
  }
  lines.push("");
  lines.push("Components (entry id · name · props · variants · examples · file):");
  for (const component of index.entries.filter((candidate) => candidate.kind === "component").slice(0, 120)) {
    lines.push(
      `- ${component.id} · ${component.name} · ${(component.detail?.["props"] ?? "").slice(0, 300)} · ${(component.detail?.["variants"] ?? "").slice(0, 160)} · ${(component.detail?.["examples"] ?? "").slice(0, 120)} · ${component.sources[0]?.path ?? ""}`,
    );
  }
  lines.push("");
  lines.push("Parsed conventions (entry id · name · summary):");
  for (const convention of index.entries.filter((candidate) => candidate.kind === "convention").slice(0, 40)) {
    lines.push(`- ${convention.id} · ${convention.name} · ${(convention.summary ?? "").slice(0, 300)}`);
  }
  lines.push("");
  lines.push("Facts you may cite (id · kind · name · value):");
  for (const fact of facts.slice(0, 200)) {
    lines.push(`- ${fact.id} · ${fact.kind} · ${fact.name} · ${(fact.value ?? "").slice(0, 80)}`);
  }
  const text = lines.join("\n");
  return text.length <= MAX_INPUT_CHARS ? text : `${text.slice(0, MAX_INPUT_CHARS)}\n… (the brief was cut at its budget)`;
}

const SYSTEM_PROMPT = [
  "You are reading a static parse of a codebase's design system. Answer with JSON only: no prose, no code fence.",
  "Shape:",
  '{"eras":[{"id":"<era id from the brief>","name":"<short name>","useForNewWork":true,"cites":["<fact id>"]}],',
  '"tokens":[{"entryId":"<token entry id>","name":"<semantic dotted name>","cites":["<fact id>"]}],',
  '"components":[{"entryId":"<component entry id>","purpose":"<one sentence>","whenToUse":"<one sentence>","doNotUseFor":"<one sentence>","cites":["<fact id>"]}],',
  '"conventions":[{"name":"<short name>","summary":"<two sentences>","cites":["<fact id>","<fact id>"]}],',
  '"philosophy":{"text":"<three sentences about the observed visual language>","cites":["<fact id>","<fact id>"]}}',
  "Rules: every item must cite at least one fact id copied from the brief. Never state a component, token or convention the brief does not contain.",
  "Describe only what the parse shows. If you cannot say something from the facts, leave it out.",
].join("\n");

export function synthesisPrompt(brief: string): CompletionContext {
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${brief}\n\nJSON:`, timestamp: Date.now() }],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function citations(value: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && known.has(entry)).slice(0, 16);
}

/** The first JSON object in a model's answer, however it wrapped it. */
export function parseSynthesisJson(raw: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(raw);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn one model answer into entries. Pure, so the whole labelling rule is
 * testable without a model: cite ≥ 2 facts → `inferred`; a name or a grouping
 * → `proposed`; cite nothing the parse knows → dropped.
 */
export function synthesisEntries(
  answer: Record<string, unknown>,
  index: DesignIndex,
  facts: readonly DesignFact[],
  onlyEntryIds?: readonly string[],
): { entries: DesignIndexEntry[]; eraNames: Map<string, string>; tokenNames: Map<string, string>; dropped: number } {
  const known = new Set(facts.map((fact) => fact.id));
  const byId = new Map(index.entries.map((candidate) => [candidate.id, candidate]));
  const wanted = onlyEntryIds === undefined ? undefined : new Set(onlyEntryIds);
  const entries: DesignIndexEntry[] = [];
  const eraNames = new Map<string, string>();
  const tokenNames = new Map<string, string>();
  let dropped = 0;

  for (const era of Array.isArray(answer["eras"]) ? (answer["eras"] as unknown[]) : []) {
    if (!isRecord(era)) continue;
    const id = text(era["id"], 64);
    const name = text(era["name"], 120);
    if (id === undefined || name === undefined || !byId.has(id)) {
      dropped += 1;
      continue;
    }
    if (wanted && !wanted.has(id)) continue;
    eraNames.set(id, name);
  }

  for (const token of Array.isArray(answer["tokens"]) ? (answer["tokens"] as unknown[]) : []) {
    if (!isRecord(token)) continue;
    const entryId = text(token["entryId"], 64);
    const name = text(token["name"], 120);
    if (entryId === undefined || name === undefined || !byId.has(entryId)) {
      dropped += 1;
      continue;
    }
    if (wanted && !wanted.has(entryId)) continue;
    tokenNames.set(entryId, name);
  }

  for (const component of Array.isArray(answer["components"]) ? (answer["components"] as unknown[]) : []) {
    if (!isRecord(component)) continue;
    const entryId = text(component["entryId"], 64);
    const existing = entryId === undefined ? undefined : byId.get(entryId);
    const purpose = text(component["purpose"], 500);
    if (existing === undefined || existing.kind !== "component" || purpose === undefined) {
      dropped += 1;
      continue;
    }
    if (wanted && !wanted.has(existing.id)) continue;
    const cites = citations(component["cites"], known);
    if (cites.length === 0) {
      dropped += 1;
      continue;
    }
    entries.push({
      ...existing,
      summary: purpose,
      detail: {
        ...(existing.detail ?? {}),
        ...(text(component["whenToUse"], 500) !== undefined ? { whenToUse: text(component["whenToUse"], 500) as string } : {}),
        ...(text(component["doNotUseFor"], 500) !== undefined ? { doNotUseFor: text(component["doNotUseFor"], 500) as string } : {}),
      },
      // A description of a parsed component is inferred from its facts; it
      // never upgrades the component's own `declared` contract, and it never
      // claims more than the number of facts behind it.
      confidence: cites.length >= 2 ? "inferred" : "proposed",
      citations: cites,
    });
  }

  for (const convention of Array.isArray(answer["conventions"]) ? (answer["conventions"] as unknown[]) : []) {
    if (!isRecord(convention)) continue;
    const name = text(convention["name"], 120);
    const summary = text(convention["summary"], 1000);
    const cites = citations(convention["cites"], known);
    if (name === undefined || summary === undefined || cites.length === 0) {
      dropped += 1;
      continue;
    }
    const cited = facts.filter((fact) => cites.includes(fact.id));
    const id = stableId("e", "convention", "", name);
    if (wanted && !wanted.has(id)) continue;
    entries.push({
      id,
      kind: "convention",
      name,
      summary,
      sources: cited.slice(0, 16).map((fact) => ({
        path: fact.source.path,
        ...(fact.source.digest !== "" ? { digest: fact.source.digest } : {}),
        ...(fact.source.excerpt !== undefined ? { excerpt: fact.source.excerpt } : {}),
      })),
      confidence: cites.length >= 2 ? "inferred" : "proposed",
      review: { state: "unreviewed" },
      citations: cites,
    });
  }

  const philosophy = answer["philosophy"];
  if (isRecord(philosophy)) {
    const body = text(philosophy["text"], 2000);
    const cites = citations(philosophy["cites"], known);
    if (body !== undefined && cites.length > 0) {
      const cited = facts.filter((fact) => cites.includes(fact.id));
      entries.push({
        id: stableId("e", "philosophy", "", "philosophy"),
        kind: "philosophy",
        name: "visual language",
        summary: body,
        sources: cited.slice(0, 16).map((fact) => ({
          path: fact.source.path,
          ...(fact.source.digest !== "" ? { digest: fact.source.digest } : {}),
          ...(fact.source.excerpt !== undefined ? { excerpt: fact.source.excerpt } : {}),
        })),
        confidence: cites.length >= 2 ? "inferred" : "proposed",
        review: { state: "unreviewed" },
        citations: cites,
      });
    } else dropped += 1;
  }

  return { entries, eraNames, tokenNames, dropped };
}

/**
 * Run synthesis. Never throws: the index is always better off with L0 than
 * with an exception, and a person is told what did not run.
 */
export async function synthesise(index: DesignIndex, facts: readonly DesignFact[], options: SynthesisOptions): Promise<SynthesisResult> {
  const profile = options.profile;
  if (!canSynthesise(profile)) {
    return {
      ...EMPTY,
      gaps: [
        {
          path: ".",
          reason: `${options.unavailable ?? "No model profile is connected for design work."} The index holds only what the parse could read; connect or assign a design profile in Settings to have components, conventions and the philosophy described.`,
        },
      ],
      ran: false,
    };
  }
  const brief = synthesisBrief(index, facts);
  const timeoutMs = options.timeoutMs ?? SYNTHESIS_TIMEOUT_MS;
  for (const model of profile?.models ?? []) {
    if (options.signal?.aborted === true) break;
    const raw = await complete(options.models, model, synthesisPrompt(brief), timeoutMs, options.signal);
    if (raw === null) continue;
    const parsed = parseSynthesisJson(raw);
    if (!parsed) continue;
    const { entries, eraNames, tokenNames, dropped } = synthesisEntries(parsed, index, facts, options.onlyEntryIds);
    if (entries.length === 0 && eraNames.size === 0 && tokenNames.size === 0) continue;
    const gaps: Gap[] = dropped > 0
      ? [{ path: ".", reason: `${String(dropped)} synthesised items named source facts that are not in this parse and were left out of the index.` }]
      : [];
    return { entries, eraNames, tokenNames, gaps, model: model.id, ran: true };
  }
  return {
    ...EMPTY,
    gaps: [{ path: ".", reason: "the models assigned to design indexing did not answer with a usable description, so the index holds only what the parse could read. Re-index to try again." }],
    ran: false,
  };
}

async function complete(
  models: () => Promise<CompletionRuntime>,
  choice: { provider: string; id: string },
  context: CompletionContext,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const runtime = await models();
    const model = runtime.getModel(choice.provider, choice.id);
    if (!model) return null;
    const timeout = AbortSignal.timeout(timeoutMs);
    const merged = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const completion = await runtime.completeSimple(model, context, { maxTokens: MAX_OUTPUT_TOKENS, signal: merged });
    const answer = completion.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    return answer === "" ? null : answer;
  } catch {
    return null;
  }
}

/**
 * Fold a synthesis result into an index: descriptions replace their entries,
 * new conventions and the philosophy are added, era and token names become
 * `proposed` renames the person accepts in review.
 */
export function applySynthesis(index: DesignIndex, result: SynthesisResult, profileId?: string): DesignIndex {
  const byId = new Map(index.entries.map((entry) => [entry.id, entry]));
  for (const entry of result.entries) byId.set(entry.id, entry);
  for (const [id, name] of result.eraNames) {
    const entry = byId.get(id);
    if (entry) byId.set(id, { ...entry, name, confidence: "proposed" });
  }
  for (const [id, name] of result.tokenNames) {
    const entry = byId.get(id);
    if (!entry) continue;
    byId.set(id, {
      ...entry,
      detail: { ...(entry.detail ?? {}), proposedName: name, parsedName: entry.name },
      confidence: entry.confidence === "declared" ? "declared" : "proposed",
    });
  }
  const eras = index.eras.map((era) => {
    const name = result.eraNames.get(era.id);
    return name === undefined ? era : { ...era, name };
  });
  return {
    ...index,
    eras,
    entries: [...byId.values()],
    gaps: [...index.gaps, ...result.gaps].slice(0, 400),
    builtWith: {
      layers: result.ran ? ["l0", "l1"] : ["l0"],
      ...(profileId !== undefined ? { profileId } : {}),
      ...(result.model !== undefined ? { model: result.model } : {}),
    },
  };
}
