/**
 * L0 assembly: facts in, a `DesignIndex` out.
 *
 * This is the deterministic half of the index. It dispatches each opened file
 * to the parser family that understands it, folds the facts into entries with
 * stable ids, and records everything it could not read as a gap. No model is
 * involved and nothing is executed: run it twice on the same tree and the two
 * indexes are byte-identical, which is what makes the digest-keyed cache and
 * the review's "changed since review" mean anything.
 */
import type { DesignIndex, DesignIndexEntry } from "@lasercode/protocol";
import { factsDigest, stableId, type DesignFact, type Gap, type L0Result, type SourceFile } from "./facts.js";
import { assetFacts, isI18nPath, parseI18nCatalogue } from "./l0-assets.js";
import { isComponentSourcePath, isStoryPath, parseComponentFile, parseMdxDoc, parseStoryFile } from "./l0-components.js";
import { isStyleSheet, isTailwindConfig, parseCssInJs, parseStyleSheet, parseTailwindConfig } from "./l0-styles.js";
import { parseStackFile, stackFactsFromPaths, stackSummary } from "./l0-stack.js";
import { isTemplatePath, parseTemplate } from "./l0-templates.js";
import { isTokenDocumentPath, parseTokenDocument } from "./l0-tokens.js";
import { detectEras, type EraCandidate } from "./eras.js";
import type { ScanResult } from "./scan.js";
import { collectTokens, tokenDocument, type IndexToken } from "./tokens.js";

/** Everything L0 knows after a build, before synthesis and before review. */
export interface L0Build {
  facts: DesignFact[];
  gaps: Gap[];
  eras: EraCandidate[];
  tokens: IndexToken[];
  index: DesignIndex;
  /** How many files were parsed, and how many came from the cache. */
  parsedFiles: number;
  cachedFiles: number;
}

/** One file through every parser that claims it. Never throws. */
export function parseSourceFile(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const take = (result: L0Result): void => {
    facts.push(...result.facts);
    gaps.push(...result.gaps);
  };
  try {
    take(parseStackFile(file));
    if (isTokenDocumentPath(file.path)) take(parseTokenDocument(file));
    if (isI18nPath(file.path)) take(parseI18nCatalogue(file));
    if (isStyleSheet(file.path)) take(parseStyleSheet(file));
    if (isTailwindConfig(file.path)) take(parseTailwindConfig(file));
    if (/\.[jt]sx?$/.test(file.path) || /\.[cm][jt]s$/.test(file.path)) take(parseCssInJs(file));
    if (isStoryPath(file.path)) take(parseStoryFile(file));
    else if (isComponentSourcePath(file.path)) take(parseComponentFile(file));
    if (/\.mdx$/.test(file.path)) take(parseMdxDoc(file));
    if (isTemplatePath(file.path)) take(parseTemplate(file));
  } catch (error) {
    // A parser that trips on an unusual file records a gap and the build goes
    // on: one odd template must not cost a person their whole index.
    gaps.push({ path: file.path, reason: `this file could not be parsed statically (${error instanceof Error ? error.message : "unknown reason"}); nothing was taken from it.` });
  }
  return { facts, gaps };
}

const MAX_ENTRIES = 3_000;
const MAX_GAPS = 400;

function entry(
  kind: DesignIndexEntry["kind"],
  name: string,
  facts: readonly DesignFact[],
  extra: Partial<DesignIndexEntry> = {},
): DesignIndexEntry {
  const sources = facts
    .slice(0, 16)
    .map((fact) => ({
      path: fact.source.path,
      ...(fact.source.digest !== "" ? { digest: fact.source.digest } : {}),
      ...(fact.source.excerpt !== undefined ? { excerpt: fact.source.excerpt } : {}),
    }));
  return {
    id: stableId("e", kind, extra.eraId ?? "", name),
    kind,
    name,
    sources,
    confidence: facts.every((fact) => fact.confidence === "declared") && facts.length > 0 ? "declared" : "observed",
    review: { state: "unreviewed" },
    factsDigest: factsDigest(facts),
    ...extra,
  };
}

/** Which era a path belongs to: the longest matching root wins. */
function eraFor(path: string, eras: readonly EraCandidate[]): string | undefined {
  let best: { id: string; length: number } | undefined;
  for (const era of eras) {
    for (const root of era.roots) {
      const matches = root === "." || path === root || path.startsWith(`${root}/`);
      if (!matches) continue;
      const length = root === "." ? 0 : root.length;
      if (best === undefined || length > best.length) best = { id: era.id, length };
    }
  }
  return best?.id;
}

function componentEntries(facts: readonly DesignFact[], eras: readonly EraCandidate[]): DesignIndexEntry[] {
  const byComponent = new Map<string, { facts: DesignFact[]; props: DesignFact[]; examples: DesignFact[] }>();
  for (const fact of facts) {
    if (fact.kind === "component") {
      const bucket = byComponent.get(fact.name) ?? { facts: [], props: [], examples: [] };
      bucket.facts.push(fact);
      byComponent.set(fact.name, bucket);
      continue;
    }
    if (fact.kind === "prop" || fact.kind === "example") {
      const owner = fact.detail?.["component"];
      if (owner === undefined) continue;
      const bucket = byComponent.get(owner) ?? { facts: [], props: [], examples: [] };
      if (fact.kind === "prop") bucket.props.push(fact);
      else bucket.examples.push(fact);
      byComponent.set(owner, bucket);
    }
  }

  const entries: DesignIndexEntry[] = [];
  for (const [name, bucket] of byComponent) {
    const declaration = bucket.facts[0];
    if (!declaration) continue;
    const eraId = eraFor(declaration.source.path, eras);
    const variants = bucket.props
      .flatMap((prop) => (prop.detail?.["options"] ?? "").split(",").map((option) => option.trim()).filter((option) => option !== "").map((option) => `${prop.name.split(".").pop() ?? ""}=${option}`))
      .slice(0, 40);
    const status = declaration.detail?.["status"];
    const all = [...bucket.facts, ...bucket.props, ...bucket.examples];
    entries.push(
      entry("component", name, all, {
        ...(eraId !== undefined ? { eraId } : {}),
        ...(status === "deprecated" || status === "internal" ? { status } : { status: "active" as const }),
        detail: {
          framework: declaration.detail?.["framework"] ?? "unknown",
          typed: declaration.detail?.["typed"] ?? "false",
          props: bucket.props.map((prop) => `${prop.name.split(".").pop() ?? ""}${prop.detail?.["required"] === "true" ? "" : "?"}: ${prop.value ?? ""}`).join("; ").slice(0, 1800),
          ...(variants.length > 0 ? { variants: variants.join(", ").slice(0, 600) } : {}),
          ...(bucket.examples.length > 0
            ? {
              examples: bucket.examples.map((example) => example.detail?.["example"] ?? example.name).join(", ").slice(0, 600),
              exampleArgs: bucket.examples.map((example) => `${example.detail?.["example"] ?? ""}: ${example.value ?? ""}`).join(" · ").slice(0, 1800),
            }
            : {}),
          importPath: declaration.source.path,
        },
        confidence: declaration.confidence,
      }),
    );
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/** Conventions L0 can state without a model: counts, repetitions, inventories. */
function conventionEntries(facts: readonly DesignFact[], eras: readonly EraCandidate[]): DesignIndexEntry[] {
  const entries: DesignIndexEntry[] = [];
  const routes = facts.filter((fact) => fact.kind === "template" && fact.detail?.["form"] === "route");
  if (routes.length > 0) {
    const regions = new Map<string, number>();
    for (const fact of facts) {
      if (fact.kind !== "template" || fact.detail?.["form"] !== "region") continue;
      regions.set(fact.name, (regions.get(fact.name) ?? 0) + 1);
    }
    entries.push(
      entry("convention", "page template", routes.slice(0, 16), {
        ...(routes[0] !== undefined && eraFor(routes[0].source.path, eras) !== undefined ? { eraId: eraFor(routes[0].source.path, eras) as string } : {}),
        summary: `${String(routes.length)} routes were parsed; the regions they repeat are ${[...regions].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([name, count]) => `${name} (${String(count)})`).join(", ")}.`,
        detail: {
          routes: routes.map((route) => route.name).slice(0, 40).join(", ").slice(0, 1800),
          regions: [...regions].map(([name, count]) => `${name}: ${String(count)}`).join(", ").slice(0, 600),
        },
      }),
    );
  }

  const states = facts.filter((fact) => fact.kind === "template" && fact.detail?.["form"] === "state");
  if (states.length > 0) {
    const byKind = new Map<string, DesignFact[]>();
    for (const state of states) byKind.set(state.name, [...(byKind.get(state.name) ?? []), state]);
    for (const [name, group] of byKind) {
      entries.push(
        entry("convention", name, group.slice(0, 16), {
          summary: `${String(group.length)} places in the templates write a ${name} by hand; their wording is the project's own.`,
          detail: { examples: group.slice(0, 6).map((fact) => fact.value ?? "").join(" · ").slice(0, 1800) },
        }),
      );
    }
  }

  const spacing = facts.filter((fact) => (fact.kind === "value" || fact.kind === "token") && fact.detail?.["category"] === "spacing");
  if (spacing.length >= 4) {
    const steps = new Map<string, number>();
    for (const fact of spacing) steps.set((fact.value ?? "").trim(), (steps.get((fact.value ?? "").trim()) ?? 0) + 1);
    const ordered = [...steps].sort((left, right) => right[1] - left[1]).slice(0, 12);
    entries.push(
      entry("convention", "spacing rhythm", spacing.slice(0, 16), {
        summary: `The spacing values that repeat most are ${ordered.slice(0, 6).map(([value, count]) => `${value} (${String(count)}×)`).join(", ")}.`,
        detail: { steps: ordered.map(([value, count]) => `${value}: ${String(count)}`).join(", ").slice(0, 600) },
      }),
    );
  }

  const icons = facts.filter((fact) => fact.kind === "icon");
  if (icons.length > 0) {
    entries.push(
      entry("convention", "iconography", icons.slice(0, 16), {
        summary: `Icons come from ${icons.map((icon) => icon.name).slice(0, 6).join(", ")}.`,
        detail: { sources: icons.map((icon) => `${icon.name} (${icon.detail?.["form"] ?? ""})`).join(", ").slice(0, 600) },
      }),
    );
  }

  const copy = facts.filter((fact) => fact.kind === "i18n");
  if (copy.length > 0) {
    entries.push(
      entry("convention", "copy voice", copy.slice(0, 16), {
        summary: `Copy lives in ${String(copy.length)} translation ${copy.length === 1 ? "catalogue" : "catalogues"}; the index quotes it rather than inventing a tone.`,
        detail: { sample: copy.map((fact) => fact.detail?.["sample"] ?? "").join(" · ").slice(0, 1800) },
      }),
    );
  }
  return entries;
}

function assetEntries(facts: readonly DesignFact[]): DesignIndexEntry[] {
  const assets = facts.filter((fact) => fact.kind === "asset" || fact.kind === "icon" || fact.kind === "font");
  const entries: DesignIndexEntry[] = [];
  for (const fact of assets) {
    entries.push(
      entry("asset", fact.name, [fact], {
        summary: `${fact.detail?.["form"] ?? "asset"}${fact.value !== undefined && fact.value !== "" ? ` · ${fact.value}` : ""}`,
        detail: { ...(fact.detail ?? {}) },
        confidence: fact.confidence,
      }),
    );
  }
  return entries;
}

function tokenEntries(tokens: readonly IndexToken[], eras: readonly EraCandidate[]): DesignIndexEntry[] {
  return tokens.map((token) => {
    const eraId = eraFor(token.sources[0]?.path ?? ".", eras);
    return {
      id: token.entryId,
      kind: "token" as const,
      name: token.path,
      ...(eraId !== undefined ? { eraId } : {}),
      summary: `${token.value}${token.usages > 1 ? ` · used ${String(token.usages)}×` : ""}`,
      detail: {
        value: token.value,
        category: token.category,
        usages: String(token.usages),
        ...(token.alias ? { alias: "true" } : {}),
      },
      sources: token.sources.slice(0, 16),
      confidence: token.confidence,
      review: { state: "unreviewed" as const },
      factsDigest: tokenDigest(token),
      citations: token.factIds.slice(0, 16),
    };
  });
}

function tokenDigest(token: IndexToken): string {
  return factsDigest([
    {
      id: token.entryId,
      kind: "token",
      name: token.path,
      value: token.value,
      detail: { category: token.category, usages: String(token.usages) },
      source: { path: token.sources[0]?.path ?? "", digest: "", startLine: 1, endLine: 1 },
      confidence: token.confidence,
    },
  ]);
}

function eraEntries(eras: readonly EraCandidate[], facts: readonly DesignFact[]): DesignIndexEntry[] {
  return eras.map((era) => {
    const own = facts.filter((fact) => era.factIds.includes(fact.id)).slice(0, 16);
    return {
      id: era.id,
      kind: "era" as const,
      name: era.name,
      eraId: era.id,
      summary: era.reason,
      detail: {
        roots: era.roots.join(", ").slice(0, 600),
        signals: era.signals.join(", ").slice(0, 600),
        useForNewWork: era.useForNewWork ? "true" : "false",
      },
      sources: own.map((fact) => ({
        path: fact.source.path,
        ...(fact.source.digest !== "" ? { digest: fact.source.digest } : {}),
        ...(fact.source.excerpt !== undefined ? { excerpt: fact.source.excerpt } : {}),
      })),
      confidence: "observed" as const,
      review: { state: "unreviewed" as const },
      factsDigest: factsDigest(own),
      citations: era.factIds.slice(0, 16),
    };
  });
}

export interface AssembleOptions {
  indexId: string;
  builtAt: string;
  appRoot?: string;
  builtFrom?: DesignIndex["builtFrom"];
  stoppedEarly?: boolean;
  parsedFiles?: number;
  cachedFiles?: number;
}

/** Facts and a scan → the L0 index. */
export function assembleIndex(facts: DesignFact[], gaps: Gap[], scan: ScanResult, options: AssembleOptions): L0Build {
  const withAssets = [...facts, ...assetFacts(scan.files), ...stackFactsFromPaths(scan.files.map((file) => file.path))];
  const eras = detectEras(withAssets, scan.files);
  const tokens = collectTokens(withAssets);
  const entries = [
    ...eraEntries(eras, withAssets),
    ...tokenEntries(tokens, eras),
    ...componentEntries(withAssets, eras),
    ...conventionEntries(withAssets, eras),
    ...assetEntries(withAssets),
  ].slice(0, MAX_ENTRIES);

  const allGaps = [...gaps, ...scan.gaps];
  if (scan.truncated) {
    allGaps.push({ path: options.appRoot ?? ".", reason: "the build stopped at its budget; the index covers what it read, and says so here." });
  }

  const index: DesignIndex = {
    indexId: options.indexId,
    stack: stackSummary(withAssets),
    eras: eras.map((era) => ({ id: era.id, name: era.name, roots: era.roots, useForNewWork: era.useForNewWork })),
    entries,
    gaps: dedupeGaps(allGaps).slice(0, MAX_GAPS),
    builtAt: options.builtAt,
    tokensDocument: tokenDocument(tokens),
    builtWith: { layers: ["l0"] },
    ...(options.appRoot !== undefined && options.appRoot !== "." ? { appRoot: options.appRoot } : {}),
    ...(options.builtFrom !== undefined ? { builtFrom: options.builtFrom } : {}),
    ...(options.stoppedEarly === true || scan.truncated ? { stoppedEarly: true } : {}),
  };

  return {
    facts: withAssets,
    gaps: index.gaps,
    eras,
    tokens,
    index,
    parsedFiles: options.parsedFiles ?? scan.files.filter((file) => file.kind === "parsed").length,
    cachedFiles: options.cachedFiles ?? 0,
  };
}

function dedupeGaps(gaps: readonly Gap[]): Gap[] {
  const seen = new Set<string>();
  const unique: Gap[] = [];
  for (const gap of gaps) {
    const key = `${gap.path}\u0000${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ path: gap.path, reason: gap.reason.slice(0, 500) });
  }
  return unique;
}
