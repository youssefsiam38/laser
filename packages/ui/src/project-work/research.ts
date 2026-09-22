/**
 * The Research body, as a thing a person reads and resolves (M21-T7).
 *
 * `docs/research-phase.md` fixes the domain: a tree of questions, each
 * resolved by findings, each finding pinned to a source with an excerpt, a
 * licence and a confidence **set by rule, never by the model and never by
 * this window**. Everything here is pure and total, so the surfaces can be
 * read as layout and these rules can be tested on their own:
 *
 * - the tree, in reading order, with each node's depth;
 * - which findings a question cites, and which are cited by nothing;
 * - the cited span inside an excerpt — matched literally, never guessed;
 * - where a source can be opened, per kind, through openers that already
 *   exist (a URL, a forge at an exact commit, a registry page, a local file,
 *   another artifact in this project);
 * - the `[from …]` provenance every piece of foreign text carries;
 * - the three writes a person may make: add a question, answer one, hand one
 *   over or mark it unanswerable. Findings are written by the research
 *   loop's own tools, never here (D-351).
 */
import type {
  ResearchBody,
  ResearchFinding,
  ResearchQuestionNode,
  ResearchQuestionState,
  ResearchStatus,
  SourceRef,
} from "@lasercode/protocol";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The question states, in this kind's own words (D-355, "Keys and type identity"). */
export const QUESTION_STATE_LABEL: Readonly<Record<ResearchQuestionState, string>> = {
  open: "Open",
  answered: "Answered",
  unanswerable: "Unanswerable",
  handed_to_person: "Handed to you",
};

export const RESEARCH_STATUS_LABEL: Readonly<Record<ResearchStatus, string>> = {
  open: "Open",
  answered: "Answered",
  partial: "Partly answered",
  unanswerable: "Unanswerable",
  superseded: "Superseded",
};

/** What each confidence *means*, because the word alone is not an explanation. */
export const CONFIDENCE_DETAIL: Readonly<Record<ResearchFinding["confidence"], string>> = {
  declared: "Verbatim from an official or primary source.",
  observed: "Read or run in this project — test output, code, a command's result.",
  inferred: "Derived from two or more findings, which it cites.",
  proposed: "No source yet. It is a claim, not evidence.",
};

export const LICENCE_LABEL: Readonly<Record<ResearchFinding["licence"], string>> = {
  permissive: "permissive",
  copyleft: "copyleft",
  proprietary: "proprietary",
  unknown: "licence unknown",
  not_applicable: "no licence",
};

export const TRUST_LABEL: Readonly<Record<SourceRef["trust"], string>> = {
  official: "official",
  primary: "primary",
  secondary: "secondary",
  community: "community",
  unknown: "trust unknown",
};

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface QuestionRow {
  node: ResearchQuestionNode;
  depth: number;
  /** How many findings this question cites that the revision still carries. */
  findings: number;
}

/**
 * The questions in reading order: each parent immediately followed by its
 * children. A node whose parent is not in the body is kept at the root rather
 * than dropped — the revision says it exists, so it is shown.
 */
export function questionRows(body: ResearchBody): QuestionRow[] {
  const known = new Set(body.questions.map((question) => question.id));
  const childrenOf = new Map<string | undefined, ResearchQuestionNode[]>();
  for (const question of body.questions) {
    const parent = question.parent !== undefined && known.has(question.parent) ? question.parent : undefined;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(question);
    else childrenOf.set(parent, [question]);
  }
  const findingIds = new Set(body.findings.map((finding) => finding.id));
  const rows: QuestionRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number): void => {
    for (const node of childrenOf.get(parent) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push({ node, depth, findings: node.findings.filter((id) => findingIds.has(id)).length });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // A cycle the schema would refuse cannot strand a node off the screen.
  for (const node of body.questions) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    rows.push({ node, depth: 0, findings: node.findings.filter((id) => findingIds.has(id)).length });
  }
  return rows;
}

/** The findings one question cites, in the order the body lists them. */
export function findingsFor(body: ResearchBody, questionId: string | undefined): ResearchFinding[] {
  if (questionId === undefined) return [...body.findings];
  const question = body.questions.find((candidate) => candidate.id === questionId);
  if (!question) return [];
  const byId = new Map(body.findings.map((finding) => [finding.id, finding]));
  return question.findings.flatMap((id) => {
    const finding = byId.get(id);
    return finding ? [finding] : [];
  });
}

/** Findings no question cites. They are evidence too, and are never hidden. */
export function uncitedFindings(body: ResearchBody): ResearchFinding[] {
  const cited = new Set(body.questions.flatMap((question) => question.findings));
  return body.findings.filter((finding) => !cited.has(finding.id));
}

/** What this revision can prove it spent: sources read and findings kept. */
export interface RetrievalSpend {
  sources: number;
  findings: number;
  questions: number;
  resolved: number;
}

export function retrievalSpend(body: ResearchBody): RetrievalSpend {
  return {
    sources: body.sources.length,
    findings: body.findings.length,
    questions: body.questions.length,
    // Settled means settled: a question handed to a person is still waiting on
    // one, and counting it as done would be the kind of progress theatre the
    // contract forbids (no percentages, no invented completion).
    resolved: body.questions.filter((question) => question.state === "answered" || question.state === "unanswerable").length,
  };
}

// ---------------------------------------------------------------------------
// The cited span
// ---------------------------------------------------------------------------

export interface CitedSpan {
  before: string;
  match: string;
  after: string;
}

const QUOTED = /["“”«»']([^"“”«»']{8,})["“”«»']/u;
const MIN_SPAN = 16;

/**
 * The part of the excerpt the claim actually quotes.
 *
 * Literal only: a quoted phrase inside the claim that appears in the excerpt,
 * or the longest run of characters the two share. Nothing is highlighted on a
 * resemblance, because a highlight is a claim about the source's own words.
 */
export function citedSpan(excerpt: string, claim: string): CitedSpan | undefined {
  const quoted = QUOTED.exec(claim)?.[1];
  const direct = quoted ? indexOfInsensitive(excerpt, quoted.trim()) : -1;
  if (quoted && direct >= 0) return split(excerpt, direct, quoted.trim().length);
  const common = longestCommonRun(excerpt.toLocaleLowerCase(), claim.toLocaleLowerCase());
  if (!common || common.length < MIN_SPAN) return undefined;
  const bounds = toWholeWords(excerpt, common.index, common.index + common.length);
  if (!bounds || bounds.end - bounds.start < MIN_SPAN) return undefined;
  return split(excerpt, bounds.start, bounds.end - bounds.start);
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Pull a run back to whole words *in the excerpt*: a highlight that starts or
 * ends mid-word claims the source said something it did not.
 */
function toWholeWords(excerpt: string, from: number, to: number): { start: number; end: number } | undefined {
  let start = from;
  let end = to;
  if (start > 0 && WORD.test(excerpt[start - 1] ?? "") && WORD.test(excerpt[start] ?? "")) {
    while (start < end && WORD.test(excerpt[start] ?? "")) start += 1;
  }
  while (start < end && !WORD.test(excerpt[start] ?? "")) start += 1;
  if (end < excerpt.length && WORD.test(excerpt[end] ?? "") && WORD.test(excerpt[end - 1] ?? "")) {
    while (end > start && WORD.test(excerpt[end - 1] ?? "")) end -= 1;
  }
  while (end > start && !WORD.test(excerpt[end - 1] ?? "")) end -= 1;
  return end > start ? { start, end } : undefined;
}

const split = (excerpt: string, at: number, length: number): CitedSpan => ({
  before: excerpt.slice(0, at),
  match: excerpt.slice(at, at + length),
  after: excerpt.slice(at + length),
});

const indexOfInsensitive = (haystack: string, needle: string): number =>
  haystack.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());

/** Longest common substring, with one rolling row: the excerpt is bounded at 2 000. */
function longestCommonRun(a: string, b: string): { index: number; length: number } | undefined {
  if (a.length === 0 || b.length === 0) return undefined;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  let best = 0;
  let end = 0;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : 0;
      if ((current[j] ?? 0) > best) {
        best = current[j] ?? 0;
        end = i;
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return best === 0 ? undefined : { index: end - best, length: best };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Where a source can be opened, through an opener this app already has. */
export type SourceTarget =
  | { open: "external"; url: string; label: string }
  | { open: "file"; path: string; label: string }
  | { open: "work"; key: string; label: string }
  | { open: "none"; reason: string };

const FORGE_COMMIT_PATH: Readonly<Record<string, string>> = {
  "github.com": "tree",
  "gitlab.com": "-/tree",
  "bitbucket.org": "src",
};

const REGISTRY_URL: Readonly<Record<string, (name: string, version: string | undefined) => string>> = {
  npm: (name, version) => `https://www.npmjs.com/package/${name}${version ? `/v/${version}` : ""}`,
  pypi: (name, version) => `https://pypi.org/project/${name}/${version ?? ""}`,
  crates: (name, version) => `https://crates.io/crates/${name}${version ? `/${version}` : ""}`,
};

const WORK_KEY = /^(SPEC|RES|DES|PLAN|TASK)-\d+$/u;

/**
 * The canonical thing to open for one source.
 *
 * Only identities the adapter contract fixes are turned into a URL: an
 * absolute URL, a known forge at an exact commit, a registry this app ships
 * an adapter for, a DOI through its published resolver. Anything else is
 * shown as what it is — a local path, an artifact key, or a person's own
 * words, which has nothing to open and says so.
 */
export function sourceTarget(source: SourceRef): SourceTarget {
  const id = source.id.trim();
  if (/^https?:\/\//iu.test(id)) return { open: "external", url: id, label: hostOf(id) ?? id };
  if (source.kind === "repository") {
    const repo = /^(?:git@|ssh:\/\/)?([\w.-]+\.[a-z]{2,})[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[@#]([0-9a-f]{7,40}))?$/iu.exec(id);
    const host = repo?.[1]?.toLocaleLowerCase();
    const path = host ? FORGE_COMMIT_PATH[host] : undefined;
    if (repo && host && path) {
      const commit = repo[4];
      const base = `https://${host}/${repo[2]}/${repo[3]}`;
      return { open: "external", url: commit ? `${base}/${path}/${commit}` : base, label: commit ? `${host} at ${commit.slice(0, 10)}` : host };
    }
  }
  if (source.kind === "package") {
    const coordinate = /^([a-z]+):(@?[\w./-]+?)(?:@([\w.+-]+))?$/iu.exec(id);
    const registry = coordinate?.[1]?.toLocaleLowerCase();
    const build = registry ? REGISTRY_URL[registry] : undefined;
    if (build && coordinate?.[2]) return { open: "external", url: build(coordinate[2], coordinate[3]), label: `${registry} · ${coordinate[2]}` };
  }
  if (source.kind === "scholarly") {
    const doi = /^(?:doi:)?(10\.\d{4,9}\/\S+)$/iu.exec(id);
    if (doi?.[1]) return { open: "external", url: `https://doi.org/${doi[1]}`, label: `doi.org/${doi[1]}` };
  }
  if (source.kind === "project") {
    if (WORK_KEY.test(id)) return { open: "work", key: id, label: id };
    return { open: "file", path: id, label: id };
  }
  if (source.kind === "document") return { open: "file", path: id, label: id };
  if (source.kind === "person") return { open: "none", reason: "A person said this. There is nothing to open." };
  if (source.kind === "session") return { open: "none", reason: "An earlier conversation concluded this." };
  return { open: "none", reason: "This source has no address this app can open." };
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Every piece of foreign text carries where it came from (`research-phase.md`). */
export function provenanceOf(source: SourceRef): string {
  return `[from ${source.id}]`;
}

/**
 * What Quote puts in the composer: the artifact it came from, the claim, the
 * verbatim excerpt as a blockquote, and the provenance line. Markdown, so the
 * conversation renders it back as the quote it is.
 */
export function quoteMarkdown(finding: ResearchFinding, workKey: string): string {
  const lines = [`${workKey} · ${finding.claim}`];
  if (finding.excerpt?.trim()) {
    lines.push("", ...finding.excerpt.trim().split("\n").map((line) => `> ${line}`));
  } else if (finding.location) {
    lines.push("", `> ${locationLabel(finding.location)}`);
  }
  lines.push("", `${provenanceOf(finding.source)} · ${finding.confidence} · ${LICENCE_LABEL[finding.licence]}`);
  return lines.join("\n");
}

export function locationLabel(location: NonNullable<ResearchFinding["location"]>): string {
  const from = location.from !== undefined ? `:${location.from}` : "";
  const to = location.to !== undefined && location.from !== undefined ? `-${location.to}` : "";
  return `${location.path}${from}${to}`;
}

// ---------------------------------------------------------------------------
// The writes a person may make
// ---------------------------------------------------------------------------

/** Status is derived from the question states, never typed in (`research-phase.md`). */
export function deriveResearchStatus(body: ResearchBody): ResearchStatus {
  if (body.status === "superseded") return "superseded";
  const states = body.questions.map((question) => question.state);
  if (states.length === 0) return "open";
  if (states.every((state) => state === "answered")) return "answered";
  if (states.every((state) => state === "unanswerable")) return "unanswerable";
  if (states.some((state) => state === "answered")) return "partial";
  return "open";
}

const withStatus = (body: ResearchBody, questions: ResearchQuestionNode[]): ResearchBody => {
  const next: ResearchBody = { ...body, questions };
  return { ...next, status: deriveResearchStatus(next) };
};

/** Add a question, optionally under another one. Ids are this window's own. */
export function addQuestion(body: ResearchBody, input: { text: string; parent?: string | undefined }): ResearchBody {
  const id = `q${body.questions.length + 1}${Date.now().toString(36).slice(-4)}`;
  const node: ResearchQuestionNode = {
    id,
    text: input.text.trim(),
    ...(input.parent ? { parent: input.parent } : {}),
    state: "open",
    findings: [],
  };
  return withStatus(body, [...body.questions, node]);
}

export interface QuestionResolution {
  state: ResearchQuestionState;
  answer?: string | undefined;
  findings?: readonly string[] | undefined;
  /** The person says outright that the answer rests on inference alone. */
  inferredOnly?: boolean | undefined;
}

/**
 * Resolve one question.
 *
 * The one rule the body schema enforces is kept here too, so the surface can
 * refuse *before* a round trip rather than showing the host's refusal: an
 * `answered` question cites at least one finding, or says it rests on
 * inference alone.
 */
export function resolveQuestion(body: ResearchBody, questionId: string, resolution: QuestionResolution): ResearchBody {
  const questions = body.questions.map((question) => {
    if (question.id !== questionId) return question;
    const answer = resolution.answer?.trim();
    const findings = [...(resolution.findings ?? question.findings)];
    const next: ResearchQuestionNode = {
      id: question.id,
      text: question.text,
      ...(question.parent ? { parent: question.parent } : {}),
      state: resolution.state,
      ...(answer ? { answer } : {}),
      findings,
      ...(resolution.state === "answered" && findings.length === 0 && resolution.inferredOnly ? { inferredOnly: true } : {}),
    };
    return next;
  });
  return withStatus(body, questions);
}

/** Whether {@link resolveQuestion} would produce a body the schema accepts. */
export function resolutionRefusal(resolution: QuestionResolution): string | undefined {
  if (resolution.state === "answered") {
    if (!resolution.answer?.trim()) return "An answered question needs the answer written down.";
    if ((resolution.findings?.length ?? 0) === 0 && resolution.inferredOnly !== true) {
      return "An answered question cites at least one finding, or says outright that it rests on inference alone.";
    }
  }
  if (resolution.state !== "answered" && resolution.state !== "open" && !resolution.answer?.trim()) {
    return resolution.state === "unanswerable"
      ? "Say what no source could settle, so the next person knows what to look for."
      : "Say what you are being asked to settle.";
  }
  return undefined;
}

/** Unresolved facts a person adds when a question turns out to be unanswerable. */
export function noteUnresolved(body: ResearchBody, entry: { fact: string; wouldSettleIt: string }): ResearchBody {
  const fact = entry.fact.trim();
  if (fact === "" || body.unresolved.some((existing) => existing.fact === fact)) return body;
  return { ...body, unresolved: [...body.unresolved, { fact, wouldSettleIt: entry.wouldSettleIt.trim() }] };
}
