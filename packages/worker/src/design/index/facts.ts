/**
 * What every L0 parser produces, and the identities the whole index hangs on
 * (`docs/design-phase.md`, "How it is built — two layers, no execution").
 *
 * A **fact** is one thing a parser read out of one file: a dependency, a
 * declared token, a mined colour, an exported component, a story, a template
 * region. It carries where it came from — path, line range and the file's
 * digest — and one of the two L0 confidence labels:
 *
 * - `declared` — the project says it: a manifest entry, a typed prop, a `--x`
 *   custom property, a DTCG token file;
 * - `observed` — Laser mined it: a literal colour in a declaration, a class
 *   vocabulary in a template, a repeated spacing step.
 *
 * `inferred` and `proposed` are L1's labels and are never written here.
 *
 * Nothing in this module reads a file, spawns anything or imports project
 * code: it is types, digests and stable ids.
 */
import { createHash } from "node:crypto";
import { FINDING_CONFIDENCE, type FindingConfidence } from "@lasercode/protocol";

/** The two labels a parser may use. The other two belong to synthesis. */
export const L0_CONFIDENCE = ["declared", "observed"] as const satisfies readonly FindingConfidence[];
export type L0Confidence = (typeof L0_CONFIDENCE)[number];

export const L1_CONFIDENCE = ["inferred", "proposed"] as const satisfies readonly FindingConfidence[];
export type L1Confidence = (typeof L1_CONFIDENCE)[number];

/** Every fact family an L0 parser can produce. Closed, so the index is closed. */
export const DESIGN_FACT_KINDS = [
  "stack",
  "token",
  "value",
  "component",
  "prop",
  "example",
  "template",
  "class-vocabulary",
  "asset",
  "font",
  "icon",
  "i18n",
  "doc",
] as const;
export type DesignFactKind = (typeof DESIGN_FACT_KINDS)[number];

/** Where a fact was read. Lines are 1-based and inclusive. */
export interface FactSource {
  /** Project-relative, POSIX separators. Never absolute (storage refuses one). */
  path: string;
  digest: string;
  startLine: number;
  endLine: number;
  /** A short, bounded excerpt of the lines the fact came from. */
  excerpt?: string;
}

export interface DesignFact {
  /** Stable across re-index: the same fact in a moved file keeps its identity. */
  id: string;
  kind: DesignFactKind;
  /** What it is called: a dependency name, a token path, a component name. */
  name: string;
  /** Its value, as text. A parsed string, never an evaluated one. */
  value?: string;
  /** Extra parsed detail, all text. */
  detail?: Record<string, string>;
  /** The era root this fact was found under, when the roots are known. */
  eraId?: string;
  source: FactSource;
  confidence: L0Confidence;
}

/** A file, or part of one, that could not be parsed statically. Never guessed. */
export interface Gap {
  path: string;
  reason: string;
}

/** What one parser answers for one file. */
export interface L0Result {
  facts: DesignFact[];
  gaps: Gap[];
}

export const EMPTY_L0: L0Result = { facts: [], gaps: [] };

/** sha256, lowercase hex — the digest every source and cache key uses. */
export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A short, stable, opaque id: the protocol's `opaqueId` shape (`[A-Za-z0-9_-]`,
 * at most 64), derived only from the parts given. Two builds of the same
 * project produce the same ids, which is what makes a review survive a
 * re-index.
 */
export function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}

/** The id of one fact: its kind, its name and the file it was read from. */
export function factId(kind: DesignFactKind, name: string, path: string, value?: string): string {
  return stableId("f", kind, name, path, value ?? "");
}

/** Digest over the facts behind an entry, in a canonical order: "changed since review". */
export function factsDigest(facts: readonly DesignFact[]): string {
  const canonical = [...facts]
    .map((fact) => `${fact.kind}\u0001${fact.name}\u0001${fact.value ?? ""}\u0001${JSON.stringify(fact.detail ?? {})}`)
    .sort()
    .join("\u0002");
  return digestOf(canonical);
}

const EXCERPT_MAX = 240;

/** A bounded, single-line excerpt: whitespace collapsed, never a whole file. */
export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/** Build a source ref for a fact, given the file and a 0-based line index. */
export function sourceAt(file: { path: string; digest: string; lines: string[] }, line: number, endLine = line): FactSource {
  const text = file.lines.slice(line, endLine + 1).join("\n");
  return {
    path: file.path,
    digest: file.digest,
    startLine: line + 1,
    endLine: endLine + 1,
    excerpt: excerpt(text),
  };
}

/** A parsed file, as every L0 parser receives it. Text only; nothing is executed. */
export interface SourceFile {
  /** Project-relative POSIX path. */
  path: string;
  digest: string;
  text: string;
  lines: string[];
  bytes: number;
}

export function sourceFile(path: string, text: string): SourceFile {
  return { path, digest: digestOf(text), text, lines: text.split(/\r?\n/), bytes: Buffer.byteLength(text) };
}

/** True when a confidence label is one an L0 parser may use. */
export function isL0Confidence(value: string): value is L0Confidence {
  return (L0_CONFIDENCE as readonly string[]).includes(value);
}

/** The protocol's four labels, re-exported so callers need one import. */
export const CONFIDENCE_LABELS = FINDING_CONFIDENCE;
