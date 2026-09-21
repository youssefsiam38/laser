/**
 * The body of every primary kind (M21-T1).
 *
 * A revision's body is a **closed, validated object**, never free text and
 * never a blob of model output. The schemas here are what the host stores, what
 * the workspace renders and what the model tools must produce:
 *
 * - `SpecBody` — brief and full forms (leap, "Lifecycle and gates").
 * - `ResearchBody` — the question tree resolved by cited findings, with
 *   `SourceRef`, exactly as `docs/research-phase.md` "Domain" fixes it (D-351).
 * - `DesignBody` — `DesignTree` with stable node ids, fidelity `Sketch`,
 *   `Mapped` or `Proposed` (**never** `Native`, which is Build evidence),
 *   bounded sandboxed Sketches, static host grounding and the explicit
 *   Conform/Island strategy, per `docs/design-phase.md` (D-353, D-354).
 * - `PlanBody` — phases, the dependency DAG, boundaries, risks and
 *   verification. No schedule, no percentages (D-330).
 * - `ProjectTaskBody` — one outcome, non-goals, dependencies, scope,
 *   acceptance, assignment policy. Attempts are links, not body fields.
 *
 * Two rules are enforced by the schemas rather than by review:
 *
 * 1. **Nothing executable.** A design node carries validated props, token
 *    references and asset handles. Raw HTML, JSX, script, free-form CSS, event
 *    handlers and unvalidated URLs cannot be expressed. The one exception is a
 *    Sketch, which is bytes in the blob store rendered only inside a sandboxed
 *    frame — its document never appears in a body.
 * 2. **Bounded.** Every list and string has a ceiling taken from the companion
 *    contracts, so one revision cannot become a resource problem.
 */
import { z } from "zod";
import { PROJECT_WORK_TEXT_MAX, projectWorkKeySchema, type ProjectWorkAnchor } from "./project-work.js";

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "an id this app minted");
const digest = z.string().regex(/^[0-9a-f]{64}$/, "a sha256 digest");
const isoInstant = z.string().min(1).max(64);
const line = z.string().min(1).max(500);
const paragraph = z.string().max(PROJECT_WORK_TEXT_MAX);

/** Markdown a person wrote or approved. Rendered through the shared renderer. */
export const PROJECT_WORK_MARKDOWN_MAX = 200_000;
const markdown = z.string().max(PROJECT_WORK_MARKDOWN_MAX);

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/**
 * The Spec is both the lifecycle root and the evolving requirements document.
 * A `brief` revision is deliberately small; a `full` revision records the
 * agreed behaviour and acceptance criteria.
 */
export const SPEC_FORMS = ["brief", "full"] as const;
export type SpecForm = (typeof SPEC_FORMS)[number];

export interface SpecRequirement {
  id: string;
  text: string;
  /** `must` blocks a gate; `should` and `may` do not. */
  level: "must" | "should" | "may";
}

export interface SpecAcceptanceCriterion {
  id: string;
  text: string;
  /** True when a command or test can decide it without a person. */
  machineVerifiable: boolean;
}

export interface SpecBody {
  form: SpecForm;
  /** The brief: what this is, in a few sentences. Always present. */
  brief: string;
  problem?: string;
  outcomes: string[];
  nonGoals: string[];
  requirements: SpecRequirement[];
  acceptance: SpecAcceptanceCriterion[];
  constraints: string[];
  /** Long-form prose, for the document view. Markdown, rendered, never executed. */
  document?: string;
  /**
   * True when this Spec was put on the gated path (leap, "Gates only when
   * chosen", D-352).
   *
   * The opt-in lives in the body rather than in a side table because it is
   * part of what a person approved: it travels with the revision, with the
   * export and with the digest, and a later revision that quietly turned the
   * gates off would be visible as a change to the bytes. Absent means the
   * Spec is ungated, which is what every Spec is until someone chooses
   * otherwise; nothing about an ungated Spec is pending.
   */
  gated?: boolean;
}

export const specBodySchema = z
  .object({
    form: z.enum(SPEC_FORMS),
    brief: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    problem: paragraph.optional(),
    outcomes: z.array(line).max(64),
    nonGoals: z.array(line).max(64),
    requirements: z
      .array(z.object({ id: opaqueId, text: paragraph, level: z.enum(["must", "should", "may"]) }).strict())
      .max(256),
    acceptance: z
      .array(z.object({ id: opaqueId, text: paragraph, machineVerifiable: z.boolean() }).strict())
      .max(256),
    constraints: z.array(line).max(64),
    document: markdown.optional(),
    gated: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Research (docs/research-phase.md "Domain")
// ---------------------------------------------------------------------------

export const SOURCE_KINDS = ["web", "repository", "package", "document", "scholarly", "project", "person", "session"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_TRUST = ["official", "primary", "secondary", "community", "unknown"] as const;
export type SourceTrust = (typeof SOURCE_TRUST)[number];

export const FINDING_CONFIDENCE = ["declared", "observed", "inferred", "proposed"] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCE)[number];

export const SOURCE_LICENCES = ["permissive", "copyleft", "proprietary", "unknown", "not_applicable"] as const;
export type SourceLicence = (typeof SOURCE_LICENCES)[number];

export const RESEARCH_QUESTION_STATES = ["open", "answered", "unanswerable", "handed_to_person"] as const;
export type ResearchQuestionState = (typeof RESEARCH_QUESTION_STATES)[number];

export const RESEARCH_STATUSES = ["open", "answered", "partial", "unanswerable", "superseded"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

/** Bounds from `docs/research-phase.md`. */
export const RESEARCH_QUESTION_MAX = 500;
export const RESEARCH_QUESTION_NODES_MAX = 64;
export const RESEARCH_QUESTION_DEPTH_MAX = 4;
export const RESEARCH_ANSWER_MAX = 2000;
export const RESEARCH_FINDINGS_MAX = 256;
export const RESEARCH_CLAIM_MAX = 500;
export const RESEARCH_EXCERPT_MAX = 2000;
export const RESEARCH_OPTIONS_MAX = 12;

/**
 * Where a finding came from. `id` is the canonical identity for the kind: a
 * normalised URL, a repository state, a registry coordinate, a DOI, a project
 * work key, a person label or a session id.
 */
export interface SourceRef {
  kind: SourceKind;
  id: string;
  title: string;
  digest?: string;
  /** The adapter that fetched it, so a disabled adapter is visible as such. */
  fetchedVia: string;
  trust: SourceTrust;
}

export const sourceRefSchema = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    id: z.string().min(1).max(2048),
    title: z.string().max(500),
    digest: digest.optional(),
    fetchedVia: z.string().min(1).max(60),
    trust: z.enum(SOURCE_TRUST),
  })
  .strict()
  .refine((source) => (source.kind === "person" || source.kind === "session" ? source.trust !== "official" && source.trust !== "primary" : true), {
    message: "a person or session source is secondary trust at most",
    path: ["trust"],
  });

export interface ResearchFinding {
  id: string;
  claim: string;
  confidence: FindingConfidence;
  source: SourceRef;
  /** The verbatim excerpt, or a local path with a line range. */
  excerpt?: string;
  location?: { path: string; from?: number; to?: number };
  retrievedAt: string;
  licence: SourceLicence;
  reuse?: { what: "code" | "concept" | "asset" | "api"; from: string; notes?: string };
  /** Which Spec or Design decisions this finding backs. Optional, always. */
  supports: string[];
  contradicts: string[];
  /**
   * The findings an `inferred` claim was derived from (D-351.b).
   *
   * The rule says an inference is "derived from ≥ 2 findings, citing them",
   * and neither `supports` (Spec/Design decisions) nor `contradicts` (the
   * opposite relation) is where those citations belong. Optional, so every
   * body written before this field still validates.
   */
  derivedFrom?: string[];
}

export interface ResearchQuestionNode {
  id: string;
  text: string;
  parent?: string;
  state: ResearchQuestionState;
  answer?: string;
  findings: string[];
  /** Set when the answer rests only on inferred findings, and says so. */
  inferredOnly?: boolean;
}

export interface ResearchBody {
  question: string;
  scope: { in: string[]; out: string[]; constraints: string[] };
  status: ResearchStatus;
  questions: ResearchQuestionNode[];
  findings: ResearchFinding[];
  options?: Array<{ name: string; summary: string; findings: string[]; tradeoffs: string[]; recommended: boolean; reason: string }>;
  unresolved: Array<{ fact: string; wouldSettleIt: string }>;
  sources: SourceRef[];
}

export const researchFindingSchema = z
  .object({
    id: opaqueId,
    claim: z.string().min(1).max(RESEARCH_CLAIM_MAX),
    confidence: z.enum(FINDING_CONFIDENCE),
    source: sourceRefSchema,
    excerpt: z.string().max(RESEARCH_EXCERPT_MAX).optional(),
    location: z
      .object({ path: z.string().min(1).max(1024), from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional() })
      .strict()
      .optional(),
    retrievedAt: isoInstant,
    licence: z.enum(SOURCE_LICENCES),
    reuse: z
      .object({ what: z.enum(["code", "concept", "asset", "api"]), from: z.string().min(1).max(2048), notes: z.string().max(1000).optional() })
      .strict()
      .optional(),
    supports: z.array(z.string().min(1).max(200)).max(32),
    contradicts: z.array(opaqueId).max(32),
    derivedFrom: z.array(opaqueId).max(32).optional(),
  })
  .strict()
  .refine((finding) => finding.confidence !== "inferred" || (finding.derivedFrom?.length ?? 0) >= 2, {
    message: "an inferred finding is derived from at least two findings, and cites them",
    path: ["derivedFrom"],
  })
  .refine((finding) => finding.confidence !== "proposed" || finding.source.kind === "person" || finding.source.kind === "session" || finding.excerpt === undefined, {
    message: "a proposed finding has no source excerpt to quote",
    path: ["excerpt"],
  })
  .refine((finding) => finding.reuse === undefined || finding.licence !== "not_applicable", {
    message: "a finding that proposes reuse must carry a licence",
    path: ["licence"],
  });

export const researchBodySchema = z
  .object({
    question: z.string().min(1).max(RESEARCH_QUESTION_MAX),
    scope: z.object({ in: z.array(line).max(32), out: z.array(line).max(32), constraints: z.array(line).max(32) }).strict(),
    status: z.enum(RESEARCH_STATUSES),
    questions: z
      .array(
        z
          .object({
            id: opaqueId,
            text: z.string().min(1).max(RESEARCH_QUESTION_MAX),
            parent: opaqueId.optional(),
            state: z.enum(RESEARCH_QUESTION_STATES),
            answer: z.string().max(RESEARCH_ANSWER_MAX).optional(),
            findings: z.array(opaqueId).max(RESEARCH_FINDINGS_MAX),
            inferredOnly: z.boolean().optional(),
          })
          .strict(),
      )
      .max(RESEARCH_QUESTION_NODES_MAX),
    findings: z.array(researchFindingSchema).max(RESEARCH_FINDINGS_MAX),
    options: z
      .array(
        z
          .object({
            name: line,
            summary: paragraph,
            findings: z.array(opaqueId).max(RESEARCH_FINDINGS_MAX),
            tradeoffs: z.array(line).max(32),
            recommended: z.boolean(),
            reason: paragraph,
          })
          .strict(),
      )
      .max(RESEARCH_OPTIONS_MAX)
      .optional(),
    unresolved: z.array(z.object({ fact: line, wouldSettleIt: paragraph }).strict()).max(64),
    sources: z.array(sourceRefSchema).max(RESEARCH_FINDINGS_MAX),
  })
  .strict()
  .superRefine((body, ctx) => {
    const byId = new Map(body.questions.map((question) => [question.id, question]));
    // Depth is a contract bound, and a cycle in a "tree" is a malformed body.
    for (const question of body.questions) {
      let depth = 0;
      let cursor = question.parent;
      const seen = new Set<string>([question.id]);
      while (cursor !== undefined) {
        if (seen.has(cursor)) {
          ctx.addIssue({ code: "custom", path: ["questions"], message: "the question tree has a cycle" });
          return;
        }
        seen.add(cursor);
        const parent = byId.get(cursor);
        if (!parent) {
          ctx.addIssue({ code: "custom", path: ["questions"], message: "a question names a parent that is not in the tree" });
          return;
        }
        depth += 1;
        if (depth >= RESEARCH_QUESTION_DEPTH_MAX) {
          ctx.addIssue({ code: "custom", path: ["questions"], message: `the question tree is deeper than ${RESEARCH_QUESTION_DEPTH_MAX}` });
          return;
        }
        cursor = parent.parent;
      }
    }
    // An answered question cites at least one finding, unless it says outright
    // that it rests on inference alone (docs/research-phase.md, "Rules").
    for (const question of body.questions) {
      if (question.state !== "answered") continue;
      if (question.findings.length === 0 && question.inferredOnly !== true) {
        ctx.addIssue({ code: "custom", path: ["questions"], message: "an answered question cites at least one finding" });
        return;
      }
    }
  });

// ---------------------------------------------------------------------------
// Design (docs/design-phase.md)
// ---------------------------------------------------------------------------

/**
 * Fidelity inside a Design record. `Native` is deliberately absent: it exists
 * only as Build evidence, an accepted M20 checkpoint preview linked
 * `verified_at` to the Design revision (D-353).
 */
export const DESIGN_FIDELITIES = ["sketch", "mapped", "proposed"] as const;
export type DesignFidelity = (typeof DESIGN_FIDELITIES)[number];

/** Every fidelity label a surface may show, including Build's. */
export const DESIGN_EVIDENCE_FIDELITIES = [...DESIGN_FIDELITIES, "native"] as const;
export type DesignEvidenceFidelity = (typeof DESIGN_EVIDENCE_FIDELITIES)[number];

export const DESIGN_STRATEGIES = ["conform", "island"] as const;
export type DesignStrategy = (typeof DESIGN_STRATEGIES)[number];

export const DESIGN_TREE_NODES_MAX = 2000;
export const DESIGN_SCREENS_MAX = 64;
export const DESIGN_FLOWS_MAX = 64;
/** One sandboxed sketch document. Bounded per D-354. */
export const SKETCH_MAX_BYTES = 512 * 1024;
export const SKETCHES_PER_REVISION_MAX = 8;

/**
 * A prop value a node may carry. Closed on purpose: a string, a number, a
 * boolean, a token reference, an asset handle or a fixture reference. There is
 * no "any", no raw markup and no handler.
 */
export type DesignPropValue =
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "token"; tokenId: string }
  | { type: "asset"; assetId: string; blobId?: string }
  | { type: "fixture"; fixtureId: string }
  | { type: "choice"; value: string };

export const designPropValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string().max(4000) }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("token"), tokenId: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal("asset"), assetId: z.string().min(1).max(200), blobId: opaqueId.optional() }).strict(),
  z.object({ type: z.literal("fixture"), fixtureId: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal("choice"), value: z.string().min(1).max(120) }).strict(),
]);

/**
 * One node of a `DesignTree`. Ids are stable across revisions so a comment
 * anchored to a node survives an edit, and a removed anchor is shown as
 * orphaned rather than silently moved.
 */
export interface DesignNode {
  id: string;
  /** The component contract this node draws, by index entry or primitive name. */
  component: { indexEntryId: string } | { primitive: string };
  fidelity: DesignFidelity;
  /** True while the index entry this node uses has not been reviewed. */
  unreviewed?: boolean;
  props: Record<string, DesignPropValue>;
  variant?: string;
  state?: string;
  children: string[];
  /** Bounded literal text, escaped at render. Never markup. */
  text?: string;
}

export const designNodeSchema = z
  .object({
    id: opaqueId,
    component: z.union([
      z.object({ indexEntryId: opaqueId }).strict(),
      z.object({ primitive: z.string().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/, "a primitive kit name") }).strict(),
    ]),
    fidelity: z.enum(DESIGN_FIDELITIES),
    unreviewed: z.boolean().optional(),
    props: z.record(z.string().min(1).max(60), designPropValueSchema),
    variant: z.string().min(1).max(60).optional(),
    state: z.string().min(1).max(60).optional(),
    children: z.array(opaqueId).max(200),
    text: z.string().max(4000).optional(),
  })
  .strict();

/** A declarative prototype action. No model script, ever (D-354). */
export type DesignAction =
  | { type: "navigate"; screenId: string; transition?: string }
  | { type: "overlay"; screenId: string }
  | { type: "close" }
  | { type: "setState"; nodeId: string; state: string }
  | { type: "setVariant"; nodeId: string; variant: string }
  | { type: "switchTheme"; theme: string }
  | { type: "switchViewport"; viewport: string };

export const designActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), screenId: opaqueId, transition: z.string().min(1).max(60).optional() }).strict(),
  z.object({ type: z.literal("overlay"), screenId: opaqueId }).strict(),
  z.object({ type: z.literal("close") }).strict(),
  z.object({ type: z.literal("setState"), nodeId: opaqueId, state: z.string().min(1).max(60) }).strict(),
  z.object({ type: z.literal("setVariant"), nodeId: opaqueId, variant: z.string().min(1).max(60) }).strict(),
  z.object({ type: z.literal("switchTheme"), theme: z.string().min(1).max(60) }).strict(),
  z.object({ type: z.literal("switchViewport"), viewport: z.string().min(1).max(60) }).strict(),
]);

export interface DesignFlowEdge {
  id: string;
  fromScreenId: string;
  fromNodeId?: string;
  trigger: "click" | "submit" | "hover" | "key";
  action: DesignAction;
}

export interface DesignScreen {
  id: string;
  name: string;
  /** `tree` screens are rendered by Laser; `sketch` screens only in a frame. */
  content: { tree: { rootNodeId: string; nodes: DesignNode[] } } | { sketchId: string };
  viewport?: string;
  theme?: string;
  /** Applicable interaction states, or the reason one is skipped. */
  states: Array<{ name: string; included: boolean; skipReason?: string }>;
  fidelity: DesignFidelity;
}

/**
 * A bounded, self-contained HTML/JS document rendered **only** inside a
 * sandboxed frame (D-354). The bytes live in the blob store; a body never
 * carries them, so nothing can accidentally hand them to the Laser renderer.
 */
export interface DesignSketch {
  id: string;
  title: string;
  blobId: string;
  bytes: number;
  digest: string;
  createdAt: string;
  /** The frame size the sketch was written for. */
  bounds: { width: number; height: number };
  /** Set once "Ground it" produced a tree from this sketch. */
  groundedIntoScreenId?: string;
}

export const designSketchSchema = z
  .object({
    id: opaqueId,
    title: z.string().min(1).max(200),
    blobId: opaqueId,
    bytes: z.number().int().positive().max(SKETCH_MAX_BYTES),
    digest: digest,
    createdAt: isoInstant,
    bounds: z
      .object({ width: z.number().int().min(64).max(8192), height: z.number().int().min(64).max(16_384) })
      .strict(),
    groundedIntoScreenId: opaqueId.optional(),
  })
  .strict();

/** The frozen host page a design in context is placed on. Parsed, never run. */
export interface HostPage {
  routeOrPath: string;
  templatePath?: string;
  /** Structural outline: regions, headings, lists, forms. Text, never markup. */
  outline: Array<{ id: string; role: string; label?: string; depth: number }>;
  files: string[];
  /** A person-supplied reference image, stored as a blob. Untrusted. */
  referenceBlobId?: string;
  fidelity: Extract<DesignFidelity, "mapped" | "proposed">;
}

export interface InsertionRegion {
  id: string;
  templatePath: string;
  /** The structural path in the parsed template. Identity for the anchor. */
  structuralPath: string;
  textHash: string;
  box?: { x: number; y: number; width: number; height: number };
  /** True when the template moved and the structural path no longer resolves. */
  orphaned?: boolean;
}

export interface DesignBody {
  /** Why this design exists, in the person's words. Always present. */
  brief: string;
  /** Which era/index the design composes from, when there is an index. */
  designIndexRef?: { indexId: string; revisionId: string; profileDigest: string; eraId?: string };
  foundation?: {
    principles: string[];
    /** DTCG token document, stored as a blob when large. */
    tokensBlobId?: string;
    notes?: string;
  };
  screens: DesignScreen[];
  flows: DesignFlowEdge[];
  sketches: DesignSketch[];
  hostPage?: HostPage;
  insertionRegion?: InsertionRegion;
  strategy?: { kind: DesignStrategy; reason: string; targetFiles: string[]; integrationContract?: string };
  /** The conservative aggregate across every screen. */
  fidelity: DesignFidelity;
  /** Fixture data bound to lists, text and images. Bounded, declarative. */
  fixtures: Array<{ id: string; name: string; rows: number; blobId?: string }>;
}

const designScreenSchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(200),
    content: z.union([
      z
        .object({
          tree: z
            .object({ rootNodeId: opaqueId, nodes: z.array(designNodeSchema).min(1).max(DESIGN_TREE_NODES_MAX) })
            .strict(),
        })
        .strict(),
      z.object({ sketchId: opaqueId }).strict(),
    ]),
    viewport: z.string().min(1).max(60).optional(),
    theme: z.string().min(1).max(60).optional(),
    states: z
      .array(z.object({ name: z.string().min(1).max(60), included: z.boolean(), skipReason: z.string().max(500).optional() }).strict())
      .max(32),
    fidelity: z.enum(DESIGN_FIDELITIES),
  })
  .strict()
  .superRefine((screen, ctx) => {
    if (!("tree" in screen.content)) return;
    const ids = new Set<string>();
    for (const node of screen.content.tree.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({ code: "custom", path: ["content"], message: "design node ids must be unique within a screen" });
        return;
      }
      ids.add(node.id);
    }
    if (!ids.has(screen.content.tree.rootNodeId)) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "the root node must be one of the screen's nodes" });
      return;
    }
    for (const node of screen.content.tree.nodes) {
      for (const child of node.children) {
        if (!ids.has(child)) {
          ctx.addIssue({ code: "custom", path: ["content"], message: "a node names a child that is not in the screen" });
          return;
        }
      }
    }
  });

export const designBodySchema = z
  .object({
    brief: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    designIndexRef: z
      .object({ indexId: opaqueId, revisionId: opaqueId, profileDigest: digest, eraId: opaqueId.optional() })
      .strict()
      .optional(),
    foundation: z
      .object({ principles: z.array(line).max(32), tokensBlobId: opaqueId.optional(), notes: paragraph.optional() })
      .strict()
      .optional(),
    screens: z.array(designScreenSchema).max(DESIGN_SCREENS_MAX),
    flows: z
      .array(
        z
          .object({
            id: opaqueId,
            fromScreenId: opaqueId,
            fromNodeId: opaqueId.optional(),
            trigger: z.enum(["click", "submit", "hover", "key"]),
            action: designActionSchema,
          })
          .strict(),
      )
      .max(DESIGN_FLOWS_MAX),
    sketches: z.array(designSketchSchema).max(SKETCHES_PER_REVISION_MAX),
    hostPage: z
      .object({
        routeOrPath: z.string().min(1).max(1024),
        templatePath: z.string().min(1).max(1024).optional(),
        outline: z
          .array(
            z
              .object({ id: opaqueId, role: z.string().min(1).max(60), label: z.string().max(200).optional(), depth: z.number().int().min(0).max(32) })
              .strict(),
          )
          .max(500),
        files: z.array(z.string().min(1).max(1024)).max(200),
        referenceBlobId: opaqueId.optional(),
        fidelity: z.enum(["mapped", "proposed"]),
      })
      .strict()
      .optional(),
    insertionRegion: z
      .object({
        id: opaqueId,
        templatePath: z.string().min(1).max(1024),
        structuralPath: z.string().min(1).max(1024),
        textHash: digest,
        box: z
          .object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite(), height: z.number().finite() })
          .strict()
          .optional(),
        orphaned: z.boolean().optional(),
      })
      .strict()
      .optional(),
    strategy: z
      .object({
        kind: z.enum(DESIGN_STRATEGIES),
        reason: paragraph,
        targetFiles: z.array(z.string().min(1).max(1024)).max(200),
        integrationContract: paragraph.optional(),
      })
      .strict()
      .optional(),
    fidelity: z.enum(DESIGN_FIDELITIES),
    fixtures: z
      .array(z.object({ id: opaqueId, name: z.string().min(1).max(120), rows: z.number().int().nonnegative().max(10_000), blobId: opaqueId.optional() }).strict())
      .max(64),
  })
  .strict()
  .superRefine((body, ctx) => {
    const sketchIds = new Set(body.sketches.map((sketch) => sketch.id));
    const screenIds = new Set(body.screens.map((screen) => screen.id));
    for (const screen of body.screens) {
      if ("sketchId" in screen.content && !sketchIds.has(screen.content.sketchId)) {
        ctx.addIssue({ code: "custom", path: ["screens"], message: "a screen names a sketch this revision does not carry" });
        return;
      }
    }
    for (const flow of body.flows) {
      if (!screenIds.has(flow.fromScreenId)) {
        ctx.addIssue({ code: "custom", path: ["flows"], message: "a flow starts on a screen this design does not have" });
        return;
      }
      const action = flow.action;
      if ((action.type === "navigate" || action.type === "overlay") && !screenIds.has(action.screenId)) {
        ctx.addIssue({ code: "custom", path: ["flows"], message: "a flow points at a screen this design does not have" });
        return;
      }
    }
  });

/** True when every screen of a design is a Sketch: it cannot pass a gate (D-354). */
export function designIsSketchOnly(body: Pick<DesignBody, "screens">): boolean {
  return body.screens.length > 0 && body.screens.every((screen) => "sketchId" in screen.content);
}

/** The conservative aggregate: the least grounded screen decides the label. */
export function designAggregateFidelity(body: Pick<DesignBody, "screens">): DesignFidelity {
  if (body.screens.some((screen) => screen.fidelity === "sketch")) return "sketch";
  if (body.screens.some((screen) => screen.fidelity === "proposed")) return "proposed";
  return "mapped";
}

// ---------------------------------------------------------------------------
// The Design Index (docs/design-phase.md "The Design Index")
// ---------------------------------------------------------------------------

export const DESIGN_INDEX_REVIEW_STATES = ["unreviewed", "accepted", "renamed", "merged", "split", "rejected"] as const;
export type DesignIndexReviewState = (typeof DESIGN_INDEX_REVIEW_STATES)[number];

/**
 * A DTCG token document, as `docs/design-phase.md` requires the index to carry
 * its tokens: groups of tokens with `$value`/`$type`, each token citing where
 * it was parsed from through `$extensions`.
 *
 * The nesting is bounded by construction (six levels, built leaf-up rather
 * than with `z.lazy`), because an index is a stored, transported body and a
 * document that could nest without limit is a resource problem, not a design.
 */
export interface DesignTokenProvenance {
  sources: Array<{ path: string; digest?: string | undefined; excerpt?: string | undefined }>;
  confidence: FindingConfidence;
  /** How many parsed declarations carried this value. */
  usages?: number | undefined;
  /** The index entry this token is reviewed as. */
  entryId?: string | undefined;
}

export interface DesignToken {
  $type?: string | undefined;
  $value: string | number | Record<string, string | number>;
  $description?: string | undefined;
  $extensions?: Record<string, DesignTokenProvenance> | undefined;
}

export type DesignTokenGroup = { [name: string]: DesignToken | DesignTokenGroup };

const designTokenProvenanceSchema = z
  .object({
    sources: z
      .array(z.object({ path: z.string().min(1).max(1024), digest: digest.optional(), excerpt: z.string().max(2000).optional() }).strict())
      .max(64),
    confidence: z.enum(FINDING_CONFIDENCE),
    usages: z.number().int().nonnegative().max(1_000_000).optional(),
    entryId: opaqueId.optional(),
  })
  .strict();

export const designTokenSchema = z
  .object({
    $type: z.string().min(1).max(60).optional(),
    $value: z.union([
      z.string().min(1).max(500),
      z.number(),
      z.record(z.string().min(1).max(60), z.union([z.string().max(500), z.number()])),
    ]),
    $description: z.string().max(500).optional(),
    $extensions: z.record(z.string().min(1).max(120), designTokenProvenanceSchema).optional(),
  })
  .strict();

const DESIGN_TOKEN_DOCUMENT_DEPTH = 6;
const DESIGN_TOKEN_GROUP_KEYS = 500;

function designTokenGroupSchema(depth: number): z.ZodType<DesignTokenGroup> {
  const member: z.ZodType<DesignToken | DesignTokenGroup> =
    depth <= 1 ? designTokenSchema : z.union([designTokenSchema, designTokenGroupSchema(depth - 1)]);
  return z.record(z.string().min(1).max(120), member).refine((group) => Object.keys(group).length <= DESIGN_TOKEN_GROUP_KEYS, {
    message: `a token group may hold at most ${String(DESIGN_TOKEN_GROUP_KEYS)} names`,
  }) as z.ZodType<DesignTokenGroup>;
}

/** The index's DTCG document: groups of tokens, each citing its sources. */
export const designTokenDocumentSchema: z.ZodType<DesignTokenGroup> = designTokenGroupSchema(DESIGN_TOKEN_DOCUMENT_DEPTH);

export const DESIGN_INDEX_ENTRY_KINDS = ["token", "component", "convention", "asset", "era", "philosophy"] as const;
export type DesignIndexEntryKind = (typeof DESIGN_INDEX_ENTRY_KINDS)[number];

/**
 * One reviewable entry of the index. Derived data with provenance: the source
 * files it was parsed from, the confidence label and the person's review state.
 */
export interface DesignIndexEntry {
  id: string;
  kind: DesignIndexEntryKind;
  name: string;
  eraId?: string;
  summary?: string;
  /** Parsed facts, as text. Never evaluated project configuration. */
  detail?: Record<string, string>;
  sources: Array<{ path: string; digest?: string; excerpt?: string }>;
  confidence: FindingConfidence;
  status?: "active" | "deprecated" | "internal";
  review: {
    state: DesignIndexReviewState;
    reviewer?: string;
    reviewedAt?: string;
    note?: string;
    /** The entry's `factsDigest` when the person reviewed it. */
    reviewedFactsDigest?: string;
    /** The name this entry was renamed from, so the parse's own name is not lost. */
    renamedFrom?: string;
    /** Where a merged entry went, and where a split child came from. */
    mergedIntoId?: string;
    splitFromId?: string;
    /** A pinned convention is always offered when composing. */
    pinned?: boolean;
  };
  /** Digest over the parsed facts behind this entry. Identity for "changed since review". */
  factsDigest?: string;
  /** L0 fact ids an inferred or proposed entry was derived from. */
  citations?: string[];
  /** True when the underlying facts moved after the person reviewed it. */
  changedSinceReview?: boolean;
}

export interface DesignIndex {
  indexId: string;
  stack: { frameworks: string[]; styling: string[]; buildTool?: string; packageManager?: string };
  eras: Array<{ id: string; name: string; roots: string[]; useForNewWork: boolean }>;
  entries: DesignIndexEntry[];
  /** Repository state the index was built from, so a Design can fence it. */
  builtFrom?: { repositoryId: string; commitObjectId: string; sourceDigests: number };
  gaps: Array<{ path: string; reason: string }>;
  builtAt: string;
  /** The DTCG document: every token of the index, with its sources. */
  tokensDocument?: DesignTokenGroup;
  /** The app root a large monorepo was indexed from, relative to the project. */
  appRoot?: string;
  /** Which layers ran, and what synthesis ran on. Absent layers are honest gaps. */
  builtWith?: { layers: Array<"l0" | "l1">; profileId?: string; model?: string };
  /** True when the build hit its budget or the person stopped it. */
  stoppedEarly?: boolean;
}

export const designIndexEntrySchema = z
  .object({
    id: opaqueId,
    kind: z.enum(DESIGN_INDEX_ENTRY_KINDS),
    name: z.string().min(1).max(200),
    eraId: opaqueId.optional(),
    summary: paragraph.optional(),
    detail: z.record(z.string().min(1).max(60), z.string().max(2000)).optional(),
    sources: z
      .array(z.object({ path: z.string().min(1).max(1024), digest: digest.optional(), excerpt: z.string().max(2000).optional() }).strict())
      .max(64),
    confidence: z.enum(FINDING_CONFIDENCE),
    status: z.enum(["active", "deprecated", "internal"]).optional(),
    review: z
      .object({
        state: z.enum(DESIGN_INDEX_REVIEW_STATES),
        reviewer: z.string().max(200).optional(),
        reviewedAt: isoInstant.optional(),
        note: z.string().max(1000).optional(),
        reviewedFactsDigest: digest.optional(),
        renamedFrom: z.string().min(1).max(200).optional(),
        mergedIntoId: opaqueId.optional(),
        splitFromId: opaqueId.optional(),
        pinned: z.boolean().optional(),
      })
      .strict(),
    factsDigest: digest.optional(),
    citations: z.array(opaqueId).max(64).optional(),
    changedSinceReview: z.boolean().optional(),
  })
  .strict();

export const designIndexSchema = z
  .object({
    indexId: opaqueId,
    stack: z
      .object({
        frameworks: z.array(z.string().min(1).max(120)).max(32),
        styling: z.array(z.string().min(1).max(120)).max(32),
        buildTool: z.string().min(1).max(120).optional(),
        packageManager: z.string().min(1).max(60).optional(),
      })
      .strict(),
    eras: z
      .array(
        z
          .object({ id: opaqueId, name: z.string().min(1).max(120), roots: z.array(z.string().min(1).max(1024)).max(64), useForNewWork: z.boolean() })
          .strict(),
      )
      .max(16),
    entries: z.array(designIndexEntrySchema).max(5000),
    builtFrom: z
      .object({ repositoryId: opaqueId, commitObjectId: z.string().regex(/^[0-9a-f]{7,64}$/), sourceDigests: z.number().int().nonnegative() })
      .strict()
      .optional(),
    gaps: z.array(z.object({ path: z.string().min(1).max(1024), reason: z.string().max(500) }).strict()).max(500),
    builtAt: isoInstant,
    tokensDocument: designTokenDocumentSchema.optional(),
    appRoot: z.string().min(1).max(1024).optional(),
    builtWith: z
      .object({
        layers: z.array(z.enum(["l0", "l1"])).max(2),
        profileId: z.string().min(1).max(120).optional(),
        model: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    stoppedEarly: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlanBody {
  /** `/plan <text>` records the text as the Plan's own brief (D-352). */
  brief: string;
  phases: Array<{ id: string; name: string; summary?: string; taskKeys: string[] }>;
  /** Declared dependencies between Task keys. The Plan is a graph, not a schedule. */
  dependencies: Array<{ from: string; to: string; reason?: string }>;
  boundaries: Array<{ scope: string; rule: string }>;
  migrations: Array<{ summary: string; reversible: boolean; note?: string }>;
  risks: Array<{ summary: string; control: string; severity: "low" | "medium" | "high" }>;
  verification: string[];
  rollback?: string;
  document?: string;
}

/**
 * The Plan body's shape.
 *
 * The *graph* rules — no cycle, no key this project never minted, no
 * dependency on a Task the Plan does not list — are `validatePlanGraph`'s,
 * which the host runs before it stores anything (M21-T15). They live there
 * rather than here because the same pass has to check the graph against the
 * project's own keys, and because the refusal must name the keys the cycle
 * goes round: a shape refusal at the wire can only say the params were bad.
 */
export const planBodySchema = z
  .object({
    brief: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    phases: z
      .array(z.object({ id: opaqueId, name: z.string().min(1).max(200), summary: paragraph.optional(), taskKeys: z.array(projectWorkKeySchema).max(500) }).strict())
      .max(32),
    dependencies: z.array(z.object({ from: projectWorkKeySchema, to: projectWorkKeySchema, reason: z.string().max(500).optional() }).strict()).max(2000),
    boundaries: z.array(z.object({ scope: line, rule: paragraph }).strict()).max(64),
    migrations: z.array(z.object({ summary: line, reversible: z.boolean(), note: paragraph.optional() }).strict()).max(64),
    risks: z.array(z.object({ summary: line, control: paragraph, severity: z.enum(["low", "medium", "high"]) }).strict()).max(64),
    verification: z.array(line).max(64),
    rollback: paragraph.optional(),
    document: markdown.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Project Task
// ---------------------------------------------------------------------------

/**
 * Assignment policy. The wire form is the closed union; `agent:<name>` is the
 * person-facing string the leap writes, produced by {@link formatAssignment}.
 */
export type TaskAssignment =
  | { policy: "unassigned" }
  | { policy: "person" }
  | { policy: "agent"; agentName: string };

export const taskAssignmentSchema = z.discriminatedUnion("policy", [
  z.object({ policy: z.literal("unassigned") }).strict(),
  z.object({ policy: z.literal("person") }).strict(),
  z.object({ policy: z.literal("agent"), agentName: z.string().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, "an agent name") }).strict(),
]);

export function formatAssignment(assignment: TaskAssignment): string {
  return assignment.policy === "agent" ? `agent:${assignment.agentName}` : assignment.policy;
}

export function parseAssignment(value: string): TaskAssignment | undefined {
  if (value === "unassigned") return { policy: "unassigned" };
  if (value === "person") return { policy: "person" };
  if (value.startsWith("agent:")) {
    const agentName = value.slice("agent:".length).trim();
    return agentName ? { policy: "agent", agentName } : undefined;
  }
  return undefined;
}

export interface ProjectTaskBody {
  outcome: string;
  nonGoals: string[];
  /** Dependencies by key. Readiness is derived from their states, never stored. */
  dependencies: string[];
  /**
   * Where this Task writes, and which overlapping Tasks a person has decided
   * to run anyway.
   *
   * `sharedWith` is the explicit acceptance of shared-checkout risk the leap's
   * "Plan and Project Task contract" allows: naming another Task's key here
   * keeps the conflict visible and marks it accepted. Only a person may add
   * one — the host refuses an agent's revision that does (M21-T15).
   */
  scope: { packages: string[]; repositories: string[]; paths: string[]; capabilities: string[]; sharedWith?: string[] };
  acceptance: Array<{ id: string; text: string; machineVerifiable: boolean; command?: string }>;
  verificationCommands: string[];
  /** True when the Task cannot be accepted without visual evidence. */
  visualEvidenceRequired: boolean;
  assignment: TaskAssignment;
  /** The Plan this Task belongs to, by key. Optional, like every link (D-352). */
  planKey?: string;
  notes?: string;
}

export const projectTaskBodySchema = z
  .object({
    outcome: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    nonGoals: z.array(line).max(32),
    dependencies: z.array(projectWorkKeySchema).max(200),
    scope: z
      .object({
        packages: z.array(z.string().min(1).max(200)).max(64),
        repositories: z.array(z.string().min(1).max(200)).max(32),
        paths: z.array(z.string().min(1).max(1024)).max(200),
        capabilities: z.array(z.string().min(1).max(60)).max(32),
        sharedWith: z.array(projectWorkKeySchema).max(64).optional(),
      })
      .strict(),
    acceptance: z
      .array(z.object({ id: opaqueId, text: paragraph, machineVerifiable: z.boolean(), command: z.string().max(1000).optional() }).strict())
      .max(64),
    verificationCommands: z.array(z.string().min(1).max(1000)).max(32),
    visualEvidenceRequired: z.boolean(),
    assignment: taskAssignmentSchema,
    planKey: projectWorkKeySchema.optional(),
    notes: paragraph.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The body union
// ---------------------------------------------------------------------------

export type ProjectWorkBody =
  | { kind: "spec"; spec: SpecBody }
  | { kind: "research"; research: ResearchBody }
  | { kind: "design"; design: DesignBody }
  | { kind: "plan"; plan: PlanBody }
  | { kind: "task"; task: ProjectTaskBody };

export const projectWorkBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spec"), spec: specBodySchema }).strict(),
  z.object({ kind: z.literal("research"), research: researchBodySchema }).strict(),
  z.object({ kind: z.literal("design"), design: designBodySchema }).strict(),
  z.object({ kind: z.literal("plan"), plan: planBodySchema }).strict(),
  z.object({ kind: z.literal("task"), task: projectTaskBodySchema }).strict(),
]);

/**
 * The searchable values of a body: titles, keys and text a person typed.
 *
 * This is the **only** projection search sees (leap, "Security, privacy and
 * resource rules"). Binary bytes, blob handles, digests, paths, credentials and
 * hidden metadata never reach it.
 */
export function searchableBodyValues(body: ProjectWorkBody): string[] {
  const values: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && value.trim()) values.push(value.trim());
  };
  switch (body.kind) {
    case "spec": {
      push(body.spec.brief);
      push(body.spec.problem);
      for (const outcome of body.spec.outcomes) push(outcome);
      for (const nonGoal of body.spec.nonGoals) push(nonGoal);
      for (const requirement of body.spec.requirements) push(requirement.text);
      for (const criterion of body.spec.acceptance) push(criterion.text);
      for (const constraint of body.spec.constraints) push(constraint);
      push(body.spec.document);
      return values;
    }
    case "research": {
      push(body.research.question);
      for (const question of body.research.questions) {
        push(question.text);
        push(question.answer);
      }
      for (const finding of body.research.findings) {
        push(finding.claim);
        push(finding.source.title);
      }
      for (const option of body.research.options ?? []) {
        push(option.name);
        push(option.summary);
      }
      for (const unresolved of body.research.unresolved) push(unresolved.fact);
      return values;
    }
    case "design": {
      push(body.design.brief);
      for (const screen of body.design.screens) {
        push(screen.name);
        if ("tree" in screen.content) {
          for (const node of screen.content.tree.nodes) push(node.text);
        }
      }
      // A sketch's document is bytes in a sandboxed blob: its title is the most
      // this projection may ever carry.
      for (const sketch of body.design.sketches) push(sketch.title);
      push(body.design.strategy?.reason);
      return values;
    }
    case "plan": {
      push(body.plan.brief);
      for (const phase of body.plan.phases) {
        push(phase.name);
        push(phase.summary);
      }
      for (const boundary of body.plan.boundaries) push(boundary.rule);
      for (const risk of body.plan.risks) push(risk.summary);
      for (const step of body.plan.verification) push(step);
      push(body.plan.document);
      return values;
    }
    case "task": {
      push(body.task.outcome);
      for (const nonGoal of body.task.nonGoals) push(nonGoal);
      for (const criterion of body.task.acceptance) push(criterion.text);
      push(body.task.notes);
      return values;
    }
  }
}

// ---------------------------------------------------------------------------
// Comment anchors (M21-T8)
// ---------------------------------------------------------------------------

/**
 * One place a comment can be anchored to, in a body as it is right now.
 *
 * The identity is the semantic target — a requirement id, a design node, a
 * flow edge, a screen, a question, a phase — never a coordinate: "coordinates
 * only position a pin" (leap, "Design contract"). A revision that keeps the id
 * keeps the comment in place; one that drops it leaves the comment orphaned
 * and visible rather than deleted.
 */
export interface AnchorTarget {
  target: ProjectWorkAnchor["target"];
  /** The stable id this anchor is keyed by. Empty for the whole entity. */
  id: string;
  /** What to call it on screen: "Requirement 1", "Screen · Review". */
  label: string;
  /** The anchored text, when this target has any. Fences a text range. */
  text?: string;
  /** For a design node: which screen it is on. */
  screenId?: string;
}

const target = (input: AnchorTarget): AnchorTarget => input;

/**
 * Every target a comment in this body could be anchored to.
 *
 * Used three ways: the inspector lists the pins, a new comment picks one, and
 * the host decides after a revision whether an existing anchor still resolves.
 */
export function anchorTargets(body: ProjectWorkBody): AnchorTarget[] {
  const targets: AnchorTarget[] = [target({ target: "entity", id: "", label: "The whole item" })];
  switch (body.kind) {
    case "spec": {
      const spec = body.spec;
      targets.push(target({ target: "section", id: "brief", label: "Brief", text: spec.brief }));
      if (spec.problem !== undefined) targets.push(target({ target: "section", id: "problem", label: "Problem", text: spec.problem }));
      spec.outcomes.forEach((outcome, index) => {
        targets.push(target({ target: "section", id: `outcome:${index + 1}`, label: `Outcome ${index + 1}`, text: outcome }));
      });
      spec.nonGoals.forEach((nonGoal, index) => {
        targets.push(target({ target: "section", id: `non-goal:${index + 1}`, label: `Non-goal ${index + 1}`, text: nonGoal }));
      });
      for (const requirement of spec.requirements) {
        targets.push(target({ target: "section", id: requirement.id, label: `Requirement · ${requirement.level}`, text: requirement.text }));
      }
      for (const criterion of spec.acceptance) {
        targets.push(target({ target: "section", id: criterion.id, label: "Acceptance criterion", text: criterion.text }));
      }
      spec.constraints.forEach((constraint, index) => {
        targets.push(target({ target: "section", id: `constraint:${index + 1}`, label: `Constraint ${index + 1}`, text: constraint }));
      });
      if (spec.document !== undefined) targets.push(target({ target: "section", id: "document", label: "Document", text: spec.document }));
      return targets;
    }
    case "research": {
      const research = body.research;
      targets.push(target({ target: "section", id: "question", label: "The question", text: research.question }));
      for (const question of research.questions) {
        targets.push(target({ target: "section", id: question.id, label: "Question", text: question.text }));
      }
      for (const finding of research.findings) {
        targets.push(target({ target: "section", id: finding.id, label: "Finding", text: finding.claim }));
      }
      return targets;
    }
    case "design": {
      const design = body.design;
      for (const screen of design.screens) {
        targets.push(target({ target: "region", id: screen.id, label: `Screen · ${screen.name}`, text: screen.name }));
        if (!("tree" in screen.content)) continue;
        for (const node of screen.content.tree.nodes) {
          targets.push(
            target({
              target: "node",
              id: node.id,
              label: "component" in node && "primitive" in node.component ? `Node · ${node.component.primitive}` : "Node",
              screenId: screen.id,
              ...(node.text !== undefined ? { text: node.text } : {}),
            }),
          );
        }
      }
      for (const flow of design.flows) {
        targets.push(target({ target: "flow_edge", id: flow.id, label: `Flow · ${flow.trigger}` }));
      }
      for (const tokenId of designTokenIds(design)) {
        targets.push(target({ target: "token", id: tokenId, label: `Token · ${tokenId}` }));
      }
      return targets;
    }
    case "plan": {
      const plan = body.plan;
      targets.push(target({ target: "section", id: "brief", label: "Brief", text: plan.brief }));
      for (const phase of plan.phases) {
        targets.push(target({ target: "section", id: phase.id, label: `Phase · ${phase.name}`, text: phase.summary ?? phase.name }));
        // A task *in this plan*: the comment belongs to the plan's shape, not
        // to the Task entity, which has comments of its own.
        for (const taskKey of phase.taskKeys) {
          if (targets.some((candidate) => candidate.target === "section" && candidate.id === taskKey)) continue;
          targets.push(target({ target: "section", id: taskKey, label: `Task · ${taskKey}`, text: taskKey }));
        }
      }
      return targets;
    }
    case "task": {
      const task = body.task;
      targets.push(target({ target: "section", id: "outcome", label: "Outcome", text: task.outcome }));
      for (const criterion of task.acceptance) {
        targets.push(target({ target: "section", id: criterion.id, label: "Acceptance criterion", text: criterion.text }));
      }
      if (task.notes !== undefined) targets.push(target({ target: "section", id: "notes", label: "Notes", text: task.notes }));
      return targets;
    }
  }
}

/** Every token a design's nodes actually reference, once each, in order. */
function designTokenIds(design: DesignBody): string[] {
  const ids: string[] = [];
  for (const screen of design.screens) {
    if (!("tree" in screen.content)) continue;
    for (const node of screen.content.tree.nodes) {
      for (const value of Object.values(node.props)) {
        if (value.type !== "token") continue;
        if (!ids.includes(value.tokenId)) ids.push(value.tokenId);
      }
    }
  }
  return ids;
}

/** The target an anchor points at, or `undefined` when the body lost it. */
export function findAnchorTarget(body: ProjectWorkBody, anchor: ProjectWorkAnchor): AnchorTarget | undefined {
  if (anchor.target === "entity") return { target: "entity", id: "", label: "The whole item" };
  const targets = anchorTargets(body);
  if (anchor.target === "text") {
    const section = targets.find((candidate) => candidate.target === "section" && candidate.id === anchor.sectionId);
    if (!section?.text) return undefined;
    if (anchor.from >= anchor.to || anchor.to > section.text.length) return undefined;
    return { ...section, target: "text", text: section.text.slice(anchor.from, anchor.to) };
  }
  const id =
    anchor.target === "section"
      ? anchor.sectionId
      : anchor.target === "node"
        ? anchor.nodeId
        : anchor.target === "flow_edge"
          ? anchor.edgeId
          : anchor.target === "token"
            ? anchor.tokenId
            : anchor.regionId;
  return targets.find((candidate) => candidate.target === anchor.target && candidate.id === id);
}

/**
 * Does this anchor still resolve in this body?
 *
 * A text range also has to still say what it said: the hash is taken over the
 * exact slice, so an edit inside the quoted words orphans the comment instead
 * of silently moving it onto different text. The hash function is supplied by
 * the caller, because this package is the one place that never reaches for
 * `node:crypto`.
 */
export function anchorResolves(body: ProjectWorkBody, anchor: ProjectWorkAnchor, hashText: (value: string) => string): boolean {
  const found = findAnchorTarget(body, anchor);
  if (!found) return false;
  if (anchor.target !== "text") return true;
  return found.text !== undefined && hashText(found.text) === anchor.textHash;
}

/** What an anchor is called when its target is gone and only the anchor is left. */
export function describeAnchor(anchor: ProjectWorkAnchor): string {
  switch (anchor.target) {
    case "entity":
      return "The whole item";
    case "section":
      return `Section ${anchor.sectionId}`;
    case "node":
      return `Node ${anchor.nodeId}`;
    case "text":
      return `A quoted range in ${anchor.sectionId}`;
    case "flow_edge":
      return `Flow ${anchor.edgeId}`;
    case "token":
      return `Token ${anchor.tokenId}`;
    case "region":
      return `Screen ${anchor.regionId}`;
  }
}
