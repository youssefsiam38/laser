/**
 * The design workspace methods (M21-T13, `docs/design-phase.md`).
 *
 * Six client methods that join the Design tab to the engine that owns a
 * project's design facts. Unlike `project/work/*`, which the host answers from
 * its own store, **these are answered by the project's worker**: the index,
 * the review document and the templates they are parsed from are files inside
 * the project directory, and one worker process owns one project directory
 * (AGENTS.md invariant 5). The host's part is authority and routing — it maps
 * the opaque `projectId` to the directory it spawned that worker for and
 * forwards the call; nothing above the worker parses a project file.
 *
 * Shapes are closed: every schema is `.strict()`, every string is bounded, and
 * the index and host-page results reuse the body schemas they already have in
 * `project-work-bodies.ts` rather than restating them.
 *
 * Three rules the schemas carry:
 *
 * - **`cwd` is the host's word, never the caller's.** A client names the
 *   project by id. The host adds the resolved directory when it forwards, and
 *   the worker refuses a directory that is not its own, so a forged `cwd` can
 *   only ever be refused.
 * - **Progress is by files, never by percent** (`docs/design-phase.md`,
 *   "Re-index"): a percentage of an unknown tree is a number the product would
 *   be making up.
 * - **A sketch crosses as untrusted text.** `design/sketch/ground` takes the
 *   document the sandboxed frame was given and returns a validated tree; the
 *   bytes are never rendered anywhere but that frame, and nothing parsed out
 *   of them is executed.
 */
import { z } from "zod";
import {
  designBodySchema,
  designIndexSchema,
  designScreenSchema,
  SKETCH_MAX_BYTES,
  type DesignIndex,
  type DesignScreen,
  type DesignStrategy,
  type HostPage,
  type InsertionRegion,
} from "./project-work-bodies.js";
import { projectIdSchema } from "./project-work.js";

/** How the design workspace names a project and the directory behind it. */
const projectTarget = {
  projectId: projectIdSchema,
  /**
   * The project directory, added by the host when it forwards. A client that
   * sends one gets it overwritten; the worker refuses anything but its own.
   */
  cwd: z.string().min(1).max(4096).optional(),
};

/**
 * The primitive kit's names, as the vocabulary a `DesignTree` may reference.
 *
 * The kit itself is the window's (M21-T11): its contract, its stylesheet and
 * its renderer are UI code. What has to be shared is only the **vocabulary** —
 * anything that composes a tree outside the window (the sketch grounding in
 * the worker, a tool, a test) must name the same sixteen primitives, and
 * `validateDesignTree` has to be given them to refuse a seventeenth. The UI
 * asserts its kit against this list, so the two cannot drift apart quietly.
 */
export const DESIGN_KIT_PRIMITIVES = [
  "stack",
  "grid",
  "text",
  "button",
  "input",
  "select",
  "checkbox",
  "card",
  "dialog",
  "toast",
  "nav",
  "table",
  "empty",
  "loading",
  "error",
  "image",
] as const;
export type DesignKitPrimitive = (typeof DESIGN_KIT_PRIMITIVES)[number];

/** Where an index build is, in the words a fleet row shows. */
export const DESIGN_BUILD_PHASES = ["scanning", "parsing", "grouping", "describing", "writing", "done", "stopped", "failed"] as const;
export type DesignBuildPhase = (typeof DESIGN_BUILD_PHASES)[number];

/** One index build, as the Design tab and the fleet row read it. */
export interface DesignIndexCommand {
  commandId: string;
  title: string;
  phase: DesignBuildPhase;
  /** Files opened and parsed so far. Never a percentage. */
  filesParsed: number;
  /** Files the walk found and would parse. Grows while `scanning`. */
  filesFound: number;
  /** Files answered from the digest cache instead of being re-parsed. */
  filesFromCache: number;
  /** The file being read, for the line under the title. */
  currentPath?: string;
  elapsedMs: number;
  running: boolean;
  /** Why it ended, when it ended badly. A sentence, never a stack. */
  failure?: string;
  /** The session the fleet row hangs under, when one started it. */
  sessionPath?: string;
}

export const designIndexCommandSchema = z
  .object({
    commandId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    phase: z.enum(DESIGN_BUILD_PHASES),
    filesParsed: z.number().int().nonnegative(),
    filesFound: z.number().int().nonnegative(),
    filesFromCache: z.number().int().nonnegative(),
    currentPath: z.string().max(1024).optional(),
    elapsedMs: z.number().int().nonnegative(),
    running: z.boolean(),
    failure: z.string().max(1000).optional(),
    sessionPath: z.string().min(1).max(4096).optional(),
  })
  .strict();

/** Why this project has no index to read, in one sentence a person can act on. */
export const DESIGN_INDEX_ABSENT_SENTENCE =
  "This project has not been indexed yet, so nothing has been read from its source. Build the index to see the tokens, components and conventions it already has.";

export interface DesignIndexGetParams {
  projectId: string;
  cwd?: string;
}

export interface DesignIndexGetResult {
  /** `ready` with the reviewed index; `absent` when nothing was ever built. */
  state: "ready" | "absent";
  index?: DesignIndex;
  /** Review progress over the whole index, for the panel's line. */
  progress?: { total: number; reviewed: number; changed: number };
  /** Builds this worker has run since it started, newest last. */
  commands: DesignIndexCommand[];
  /** Why there is no index, when there is none. */
  detail?: string;
}

export interface DesignIndexBuildParams {
  projectId: string;
  cwd?: string;
  /** Throw the parse cache away and read every file again. */
  rebuild?: boolean;
  /** The app root inside the project, for a repository with several apps. */
  appRoot?: string;
  /** The file budget. The build stops itself at it and says so. */
  maxFiles?: number;
  /**
   * The session the person started it from, so the Command takes a row in that
   * session's fleet group (D-328: one command, one session). Absent = the
   * progress is read in the Design tab and nowhere else.
   */
  sessionPath?: string;
}

export interface DesignIndexBuildResult {
  command: DesignIndexCommand;
}

export interface DesignIndexStopParams {
  projectId: string;
  cwd?: string;
  commandId: string;
}

export interface DesignIndexStopResult {
  command?: DesignIndexCommand;
  /** False when this worker has no such build any more. */
  stopped: boolean;
}

/** The four review verbs the Design tab offers, of M21-T10's eleven. */
export const DESIGN_REVIEW_VERBS = ["accept", "rename", "merge", "reject", "use-for-new-work", "pin", "unpin", "reset"] as const;
export type DesignReviewVerb = (typeof DESIGN_REVIEW_VERBS)[number];

export interface DesignIndexReviewParams {
  projectId: string;
  cwd?: string;
  entryId: string;
  action: DesignReviewVerb;
  /** The new name, for `rename`. */
  name?: string;
  /** The entry this one is merged into, for `merge`. */
  intoEntryId?: string;
  note?: string;
  /** For `use-for-new-work` on an era entry. */
  useForNewWork?: boolean;
  /** The digest the caller believes the entry's facts have (retry fence). */
  expectedFactsDigest?: string;
}

export interface DesignIndexReviewResult {
  /** The whole reviewed index, so the panel never renders a stale row. */
  index: DesignIndex;
  progress: { total: number; reviewed: number; changed: number };
}

/** How much is being added, for the Conform/Island proposal. */
export const DESIGN_FEATURE_SIZES = ["small", "medium", "large"] as const;
export type DesignFeatureSize = (typeof DESIGN_FEATURE_SIZES)[number];

export interface DesignHostGroundParams {
  projectId: string;
  cwd?: string;
  /** A route (`/orders`), a template path, or a view name. */
  routeOrPath: string;
  appRoot?: string;
  featureSize?: DesignFeatureSize;
  hostStackCanExpress?: boolean;
  migrationWanted?: boolean;
  teamKnowsHostStack?: boolean;
}

/** One case of the strategy proposal, with its reasons and what it costs. */
export interface DesignStrategyCase {
  kind: DesignStrategy;
  reasons: string[];
  tradeoffs: string[];
  eraId?: string;
}

export interface DesignStrategyProposal {
  recommended: DesignStrategy;
  conform: DesignStrategyCase;
  island: DesignStrategyCase;
  /** One sentence for the chip: what is recommended and why. */
  summary: string;
  /** True while Island is a proposal for the Plan rather than a decision. */
  proposalOnly: boolean;
  newWorkEra?: { id: string; name: string };
}

/**
 * A reference image, carried once with its bytes so the canvas can lay a
 * design over it. Only an image the repository itself references is carried
 * this way (`mapped`); a person-supplied screenshot is a blob on the revision
 * and never crosses here.
 */
export interface DesignHostReferenceImage {
  path: string;
  mediaType: string;
  bytes: number;
  /** base64. Bounded by {@link DESIGN_REFERENCE_IMAGE_MAX_BYTES}. */
  data: string;
}

export const DESIGN_REFERENCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface DesignHostGroundResult {
  /** The frozen host page, when a template was found. */
  hostPage?: HostPage;
  /** Both strategies with their reasons, when the index says what the eras are. */
  strategy?: DesignStrategyProposal;
  /** Pages that could have been meant, when nothing matched. */
  candidates: string[];
  gaps: Array<{ path: string; reason: string }>;
  /** The first repository reference image, with its bytes, when there is one. */
  referenceImage?: DesignHostReferenceImage;
  /** Why no page was found, when none was. */
  detail?: string;
}

export const DESIGN_SKETCH_DOCUMENT_MAX_BYTES = SKETCH_MAX_BYTES;

export interface DesignSketchGroundParams {
  projectId: string;
  cwd?: string;
  /** The sketch document, exactly as the sandboxed frame was given it. */
  document: string;
  /** The screen name the grounded tree takes. */
  screenName?: string;
  /** The era to compose in. Defaults to the one marked for new work. */
  eraId?: string;
}

/** One part of a sketch that the index could not account for. */
export interface DesignUnmappedPart {
  /** What it was in the sketch: a tag, a class, a colour, a script feature. */
  what: string;
  /** Why it did not map, in a sentence. */
  why: string;
  /** The primitive it was drawn with instead, when one was chosen. */
  primitive?: string;
}

export interface DesignSketchGroundResult {
  /** The grounded screen, validated before it is returned. */
  screen: DesignScreen;
  /** Everything the index could not account for, as `Proposed`. */
  unmapped: DesignUnmappedPart[];
  /** The logic the sketch ran, recorded as states rather than script. */
  states: Array<{ name: string; included: boolean; skipReason?: string }>;
  /** Index entries the tree references, for the Mapped/Proposed labels. */
  usedEntryIds: string[];
  /** What the grounding could not read at all. Never guessed. */
  notes: string[];
}

/** The insertion region a person picked, named for the surfaces. */
export type DesignInsertionRegion = InsertionRegion;

/**
 * The host page, exactly as a Design body records it. Taken from the body
 * schema itself so there is one definition of a `HostPage` and not two.
 */
const hostPageShape = designBodySchema.innerType().shape.hostPage.unwrap();

const strategyCaseSchema = z
  .object({
    kind: z.enum(["conform", "island"]),
    reasons: z.array(z.string().min(1).max(2000)).max(16),
    tradeoffs: z.array(z.string().min(1).max(2000)).max(16),
    eraId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const designStrategyProposalSchema = z
  .object({
    recommended: z.enum(["conform", "island"]),
    conform: strategyCaseSchema,
    island: strategyCaseSchema,
    summary: z.string().min(1).max(2000),
    proposalOnly: z.boolean(),
    newWorkEra: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) }).strict().optional(),
  })
  .strict();

const reviewProgressSchema = z
  .object({ total: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(), changed: z.number().int().nonnegative() })
  .strict();

export const designWorkspaceParamsSchemas = {
  "design/index/get": z.object({ ...projectTarget }).strict(),
  "design/index/build": z
    .object({
      ...projectTarget,
      rebuild: z.boolean().optional(),
      appRoot: z.string().min(1).max(1024).optional(),
      maxFiles: z.number().int().positive().max(200_000).optional(),
      sessionPath: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  "design/index/stop": z.object({ ...projectTarget, commandId: z.string().min(1).max(200) }).strict(),
  "design/index/review": z
    .object({
      ...projectTarget,
      entryId: z.string().min(1).max(200),
      action: z.enum(DESIGN_REVIEW_VERBS),
      name: z.string().min(1).max(200).optional(),
      intoEntryId: z.string().min(1).max(200).optional(),
      note: z.string().max(1000).optional(),
      useForNewWork: z.boolean().optional(),
      expectedFactsDigest: z.string().min(1).max(200).optional(),
    })
    .strict()
    .refine((value) => value.action !== "rename" || value.name !== undefined, {
      message: "A rename needs the new name.",
      path: ["name"],
    })
    .refine((value) => value.action !== "merge" || value.intoEntryId !== undefined, {
      message: "A merge needs the entry it merges into.",
      path: ["intoEntryId"],
    }),
  "design/host/ground": z
    .object({
      ...projectTarget,
      routeOrPath: z.string().min(1).max(1024),
      appRoot: z.string().min(1).max(1024).optional(),
      featureSize: z.enum(DESIGN_FEATURE_SIZES).optional(),
      hostStackCanExpress: z.boolean().optional(),
      migrationWanted: z.boolean().optional(),
      teamKnowsHostStack: z.boolean().optional(),
    })
    .strict(),
  "design/sketch/ground": z
    .object({
      ...projectTarget,
      document: z.string().min(1).max(DESIGN_SKETCH_DOCUMENT_MAX_BYTES),
      screenName: z.string().min(1).max(200).optional(),
      eraId: z.string().min(1).max(200).optional(),
    })
    .strict(),
} satisfies Record<string, z.ZodTypeAny>;

export type DesignWorkspaceMethod = keyof typeof designWorkspaceParamsSchemas;

export const DESIGN_WORKSPACE_METHODS = Object.keys(designWorkspaceParamsSchemas) as DesignWorkspaceMethod[];

/** The methods a read-only connection may call. Everything else writes. */
export const DESIGN_WORKSPACE_READ_METHODS: readonly DesignWorkspaceMethod[] = ["design/index/get"];

/** Result schemas, for the round-trip samples and a client that validates. */
export const designWorkspaceResultSchemas = {
  "design/index/get": z
    .object({
      state: z.enum(["ready", "absent"]),
      index: designIndexSchema.optional(),
      progress: reviewProgressSchema.optional(),
      commands: z.array(designIndexCommandSchema).max(50),
      detail: z.string().max(2000).optional(),
    })
    .strict(),
  "design/index/build": z.object({ command: designIndexCommandSchema }).strict(),
  "design/index/stop": z.object({ command: designIndexCommandSchema.optional(), stopped: z.boolean() }).strict(),
  "design/index/review": z.object({ index: designIndexSchema, progress: reviewProgressSchema }).strict(),
  "design/host/ground": z
    .object({
      hostPage: hostPageShape.optional(),
      strategy: designStrategyProposalSchema.optional(),
      candidates: z.array(z.string().min(1).max(1024)).max(50),
      gaps: z.array(z.object({ path: z.string().max(1024), reason: z.string().max(500) }).strict()).max(50),
      referenceImage: z
        .object({
          path: z.string().min(1).max(1024),
          mediaType: z.string().min(1).max(120),
          bytes: z.number().int().nonnegative(),
          data: z.string().max(Math.ceil((DESIGN_REFERENCE_IMAGE_MAX_BYTES * 4) / 3) + 4),
        })
        .strict()
        .optional(),
      detail: z.string().max(2000).optional(),
    })
    .strict(),
  "design/sketch/ground": z
    .object({
      screen: designScreenSchema,
      unmapped: z
        .array(z.object({ what: z.string().min(1).max(200), why: z.string().min(1).max(500), primitive: z.string().min(1).max(60).optional() }).strict())
        .max(200),
      states: z
        .array(z.object({ name: z.string().min(1).max(60), included: z.boolean(), skipReason: z.string().max(500).optional() }).strict())
        .max(32),
      usedEntryIds: z.array(z.string().min(1).max(200)).max(500),
      notes: z.array(z.string().min(1).max(500)).max(50),
    })
    .strict(),
} satisfies Record<DesignWorkspaceMethod, z.ZodTypeAny>;

