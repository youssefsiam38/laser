/**
 * The three model-facing tools of the Design Index
 * (`docs/design-phase.md`, "Tools"; `docs/agent-tool-contract.md`, D-350).
 *
 * | Tool | Does |
 * | --- | --- |
 * | `inspect_design_index` | search or get entries by era, kind and name; a summary by default |
 * | `build_design_index` | start or re-run the build as a bounded command; returns the command id |
 * | `review_design_index` | accept, rename, merge, split, reject, deprecate, pin, or mark an era for new work |
 * | `ground_host_page` | resolve a route or template to a `HostPage` outline and file list, with the Conform/Island proposal (M21-T12) |
 *
 * The specs here are the contract's own `LaserToolSpec`s: closed, bounded,
 * described schemas with declared outputs and annotations, linted by
 * `toolContract()` in this package's tests. They are registered with the
 * engine by the companion extension when the lifecycle tool surface lands
 * (M21-T17); everything below is already the final shape, and the handlers
 * are the real ones — a registration is the only missing wire.
 *
 * Every handler goes through {@link DesignIndexBridge}, so the tools can be
 * evaluated against a scripted world exactly the way the harness tools are.
 */
import { toolError, type LaserToolSpec, type ToolError } from "@lasercode/protocol";
import type { DesignIndex, DesignIndexEntry } from "@lasercode/protocol";
import { FEATURE_SIZES } from "../host/strategy.js";
import type { HostGroundingBridge } from "../host/ground.js";
import { DESIGN_REVIEW_ACTIONS, reviewProgress, type DesignReviewAction, type ReviewActor } from "./review.js";

/**
 * The session a build belongs to.
 *
 * Decided when the build is admitted and carried with it from there: the row
 * a person watches, and the Stop they press, hang under this session
 * (D-328: one command, one session). Nothing reads an owner back off a
 * mutable field afterwards, so two sessions building at once cannot take each
 * other's command.
 */
export interface DesignBuildOwner {
  sessionPath: string;
}

/**
 * What the tools need from the worker. One place to script, one to wire.
 *
 * The instance a session's tools hold is **bound to that session**: its
 * `startBuild` knows which conversation is asking, so the model never names an
 * owner and can never name someone else's. The worker builds one per session
 * over the project's single index; a scripted world binds a fixture session.
 */
export interface DesignIndexBridge {
  /** The reviewed index of this project, or undefined when it has never been built. */
  index(): Promise<DesignIndex | undefined>;
  /** Start a build owned by this bridge's session; returns the command the fleet shows. */
  startBuild(input: { rebuild: boolean; appRoot?: string; maxFiles?: number }): Promise<{ commandId: string; title: string; appRoot: string }>;
  /** Apply one review decision; returns the entry as it now reads. */
  review(input: {
    entryId: string;
    action: DesignReviewAction;
    name?: string;
    intoEntryId?: string;
    into?: string[];
    note?: string;
    useForNewWork?: boolean;
    expectedFactsDigest?: string;
    actor: ReviewActor;
  }): Promise<{ entry: DesignIndexEntry; reviewed: number; total: number }>;
}

/** A tool refusal in the contract's shape. Thrown; rendered by the registration helper. */
export class DesignToolFailure extends Error {
  readonly toolError: ToolError;
  constructor(error: ToolError) {
    super(error.message);
    this.name = "DesignToolFailure";
    this.toolError = error;
  }
}

function refuse(code: string, message: string, next: string, committed = false): never {
  throw new DesignToolFailure(toolError({ code, message, committed, next }));
}

/**
 * A refusal from below the tool, in the tool's own shape.
 *
 * `ReviewRefused` and `DesignStorageRefused` already know their code, their
 * sentence and the call to make instead; anything else takes the tool's
 * declared recovery. This is the same rule `registerLaserTool` applies at the
 * engine's door — held here too, so a handler can be evaluated without one.
 */
function asToolFailure(failure: unknown, tool: string): DesignToolFailure {
  if (failure instanceof DesignToolFailure) return failure;
  const recovery = DESIGN_INDEX_TOOL_RECOVERY[tool] ?? { code: "design_index_failed", next: "call inspect_design_index to see the index as it is" };
  const known = failure as { code?: unknown; next?: unknown; message?: unknown };
  return new DesignToolFailure(
    toolError({
      code: typeof known.code === "string" ? known.code : recovery.code,
      message: typeof known.message === "string" && known.message.trim() !== "" ? known.message : "The design index could not answer that.",
      // Nothing here writes before it refuses: a review is applied to a copy
      // of the document and stored only once it has been accepted whole.
      committed: false,
      next: typeof known.next === "string" ? known.next : recovery.next,
    }),
  );
}

// ---------------------------------------------------------------- the specs

const ENTRY_KINDS = ["token", "component", "convention", "asset", "era", "philosophy"] as const;

export const INSPECT_DESIGN_INDEX_SPEC: LaserToolSpec = {
  name: "inspect_design_index",
  description:
    "Read this project's design index: its eras, tokens, components, conventions and assets, as they were parsed from the source and reviewed by the person. " +
    "Returns a summary by default, or one entry in full when you name it. Compose only from entries this returns; it is the project's real design language, not a generic one.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Words to match against entry names and summaries. Omit to list by kind.", maxLength: 200 },
      entry_id: { type: "string", description: "One entry to return in full, with its sources and review state.", maxLength: 64 },
      kind: { type: "string", description: "Only entries of this kind.", enum: [...ENTRY_KINDS] },
      era_id: { type: "string", description: "Only entries belonging to this era.", maxLength: 64 },
      review_state: {
        type: "string",
        description: "Only entries in this review state.",
        enum: ["unreviewed", "accepted", "renamed", "merged", "split", "rejected", "changed"],
      },
      limit: { type: "integer", description: "How many entries to return. Default 20.", minimum: 1, maximum: 100 },
    },
    required: [],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      stack: { type: "string", description: "The frameworks and styling the index was built from.", maxLength: 500 },
      eras: {
        type: "array",
        description: "The eras of this codebase, newest work first.",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The era's id.", maxLength: 64 },
            name: { type: "string", description: "The era's name.", maxLength: 120 },
            useForNewWork: { type: "boolean", description: "Whether new work is composed in this era." },
          },
          required: ["id", "name", "useForNewWork"],
        },
      },
      entries: {
        type: "array",
        description: "The matching entries.",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The entry's stable id; review and compose with it.", maxLength: 64 },
            kind: { type: "string", description: "What kind of entry it is.", enum: [...ENTRY_KINDS] },
            name: { type: "string", description: "Its name in this project's language.", maxLength: 200 },
            summary: { type: "string", description: "What it is, in one or two sentences.", maxLength: 2000 },
            confidence: { type: "string", description: "How it was arrived at.", enum: ["declared", "observed", "inferred", "proposed"] },
            reviewState: { type: "string", description: "What the person decided about it.", enum: ["unreviewed", "accepted", "renamed", "merged", "split", "rejected"] },
            changedSinceReview: { type: "boolean", description: "True when the source moved after it was reviewed." },
            factsDigest: { type: "string", description: "The digest to send back when reviewing it.", maxLength: 64 },
            sources: { type: "array", description: "The files it was parsed from.", maxItems: 16, items: { type: "string", description: "A project-relative path.", maxLength: 1024 } },
            detail: { type: "string", description: "Its parsed detail: props, variants, values, examples.", maxLength: 4000 },
          },
          required: ["id", "kind", "name", "confidence", "reviewState"],
        },
      },
      counts: {
        type: "object",
        additionalProperties: false,
        description: "How much of the index there is, and how much is reviewed.",
        properties: {
          matched: { type: "integer", description: "Entries matching this call." },
          total: { type: "integer", description: "Entries in the index." },
          reviewed: { type: "integer", description: "Entries a person has decided on." },
          changed: { type: "integer", description: "Reviewed entries whose source has since moved." },
        },
        required: ["matched", "total", "reviewed", "changed"],
      },
      gaps: { type: "array", description: "What the parse could not read, and why.", maxItems: 20, items: { type: "string", description: "One gap.", maxLength: 600 } },
      truncated: { type: "boolean", description: "True when more entries matched than were returned." },
    },
    required: ["stack", "eras", "entries", "counts"],
  },
  annotations: { readOnly: true, idempotent: true, destructive: false, external: false },
  label: "injected",
};

export const BUILD_DESIGN_INDEX_SPEC: LaserToolSpec = {
  name: "build_design_index",
  description:
    "Build or re-build this project's design index by parsing its source: manifests, stylesheets, token files, components, stories and templates. " +
    "It runs as a command the person can watch and stop, and answers at once with its id — do not wait for it. Nothing in the project is executed, started or changed.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      rebuild: { type: "boolean", description: "Re-parse every file instead of only the ones whose contents changed. Default false." },
      app_root: { type: "string", description: "The folder to index, relative to the project, when this repository holds several apps.", maxLength: 512 },
      max_files: { type: "integer", description: "Stop after this many files. Default is the project-wide budget.", minimum: 1, maximum: 20000 },
    },
    required: [],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { type: "string", description: "The command building the index; it shows in the fleet.", maxLength: 64 },
      title: { type: "string", description: "What the command is called.", maxLength: 200 },
      appRoot: { type: "string", description: "The folder being indexed.", maxLength: 512 },
      note: { type: "string", description: "What happens next, in one sentence.", maxLength: 500 },
    },
    required: ["commandId", "title", "appRoot"],
  },
  annotations: { readOnly: false, idempotent: false, destructive: false, external: false },
  label: "injected",
};

export const REVIEW_DESIGN_INDEX_SPEC: LaserToolSpec = {
  name: "review_design_index",
  description:
    "Record a decision about one design index entry: accept it, rename it, merge it into another, split it, reject it, deprecate a component, pin a convention, or mark an era as the one new work belongs in. " +
    "Send the entry's facts_digest so the decision cannot land on facts you have not read. A decision made by an agent is recorded as an agent's and shown that way.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      entry_id: { type: "string", description: "The entry to decide about, from inspect_design_index.", maxLength: 64 },
      action: { type: "string", description: "What to record.", enum: [...DESIGN_REVIEW_ACTIONS] },
      name: { type: "string", description: "The new name, for a rename.", maxLength: 200 },
      into_entry_id: { type: "string", description: "The entry to merge this one into, for a merge.", maxLength: 64 },
      into: { type: "array", description: "The names the entry splits into, for a split.", maxItems: 8, items: { type: "string", description: "One part's name.", maxLength: 200 } },
      use_for_new_work: { type: "boolean", description: "For an era: whether new work is composed in it. Marking one era unmarks the others." },
      note: { type: "string", description: "Why, in the person's words. Never a file path.", maxLength: 1000 },
      facts_digest: { type: "string", description: "The entry's factsDigest as you read it. The call is refused when the index has moved past it.", maxLength: 64 },
    },
    required: ["entry_id", "action"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      entryId: { type: "string", description: "The entry the decision was recorded on.", maxLength: 64 },
      name: { type: "string", description: "Its name after the decision.", maxLength: 200 },
      reviewState: { type: "string", description: "Its review state now.", enum: ["unreviewed", "accepted", "renamed", "merged", "split", "rejected"] },
      reviewedBy: { type: "string", description: "Who the decision is recorded against.", maxLength: 200 },
      reviewed: { type: "integer", description: "Entries reviewed in this index." },
      total: { type: "integer", description: "Entries in this index." },
    },
    required: ["entryId", "name", "reviewState", "reviewedBy", "reviewed", "total"],
  },
  annotations: { readOnly: false, idempotent: true, destructive: false, external: false },
  label: "injected",
};

export const GROUND_HOST_PAGE_SPEC: LaserToolSpec = {
  name: "ground_host_page",
  description:
    "Ground a design in a page this project already has: name a route, a template file or a view name and get the files that draw it — template, layouts, partials, owning controller and stylesheets — with the page's structural outline and, when the index knows the eras, a Conform or Island proposal with the reasons for both. " +
    "Everything is read as text: the page is never opened, served or rendered. Anchor the new work to one outline node's structural path.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      route_or_path: {
        type: "string",
        description: "The page to ground: a route like /orders, a template path like app/views/orders/index.html.erb, or a view name like orders.index.",
        maxLength: 1024,
      },
      app_root: { type: "string", description: "The folder to read, relative to the project, when this repository holds several apps.", maxLength: 512 },
      reference_blob_id: { type: "string", description: "A screenshot the person already attached, to show behind the design. Never read for text.", maxLength: 64 },
      feature_size: { type: "string", description: "How much is being added, for the strategy proposal.", enum: [...FEATURE_SIZES] },
      host_stack_can_express: { type: "boolean", description: "False when the host page's own stack cannot express this feature at all." },
      migration_wanted: { type: "boolean", description: "True when the person wants this page to start moving off its current era." },
    },
    required: ["route_or_path"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      routeOrPath: { type: "string", description: "The route this page is served at, or the path that was grounded.", maxLength: 1024 },
      templatePath: { type: "string", description: "The template the page's own content lives in.", maxLength: 1024 },
      stack: { type: "string", description: "The convention the route was resolved under.", maxLength: 60 },
      fidelity: { type: "string", description: "mapped when the outline came from real templates; proposed when only an image did.", enum: ["mapped", "proposed"] },
      files: { type: "array", description: "Every file that draws this page: layouts, template, partials, controller, stylesheets.", maxItems: 200, items: { type: "string", description: "A project-relative path.", maxLength: 1024 } },
      outline: {
        type: "array",
        description: "The page's structure, in document order. Anchor an insertion region to one of these structural paths.",
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The node's stable id.", maxLength: 64 },
            role: { type: "string", description: "What it is: header, navigation, main, section, heading, list, form, component, partial…", maxLength: 60 },
            label: { type: "string", description: "Its heading text, name or label.", maxLength: 200 },
            depth: { type: "integer", description: "How deep it sits in the outline." },
            templatePath: { type: "string", description: "The file this node was parsed from.", maxLength: 1024 },
            structuralPath: { type: "string", description: "Its path inside that file; an insertion region anchors to this.", maxLength: 1024 },
            textHash: { type: "string", description: "A digest of its text, so a later parse can tell whether the content changed.", maxLength: 64 },
          },
          required: ["id", "role", "depth", "templatePath", "structuralPath", "textHash"],
        },
      },
      references: {
        type: "array",
        description: "Reference images for this page. Pictures only: nothing in them is read as text or as instructions.",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", description: "repository for an image the docs reference; supplied for one the person attached.", enum: ["repository", "supplied"] },
            label: { type: "string", description: "What it is called.", maxLength: 200 },
            path: { type: "string", description: "Where it lives in the repository.", maxLength: 1024 },
            fidelity: { type: "string", description: "mapped for a repository image, proposed for a supplied one.", enum: ["mapped", "proposed"] },
          },
          required: ["kind", "fidelity"],
        },
      },
      strategy: {
        type: "object",
        additionalProperties: false,
        description: "The Conform/Island proposal: what this recommends, and the case for both. The person chooses.",
        properties: {
          recommended: { type: "string", description: "The strategy this proposes.", enum: ["conform", "island"] },
          summary: { type: "string", description: "The recommendation in one sentence.", maxLength: 1000 },
          proposalOnly: { type: "boolean", description: "True while this is a proposal for the Plan rather than a decision." },
          conformReasons: { type: "array", description: "Why conform.", maxItems: 12, items: { type: "string", description: "One reason.", maxLength: 500 } },
          conformTradeoffs: { type: "array", description: "What conforming costs.", maxItems: 12, items: { type: "string", description: "One trade-off.", maxLength: 500 } },
          islandReasons: { type: "array", description: "Why an island.", maxItems: 12, items: { type: "string", description: "One reason.", maxLength: 500 } },
          islandTradeoffs: { type: "array", description: "What an island costs.", maxItems: 12, items: { type: "string", description: "One trade-off.", maxLength: 500 } },
          eraId: { type: "string", description: "The index era the recommended strategy composes in.", maxLength: 64 },
        },
        required: ["recommended", "summary", "conformReasons", "islandReasons"],
      },
      referenceRefused: {
        type: "object",
        additionalProperties: false,
        description: "Set when a supplied image was not taken; the grounding itself still stands.",
        properties: {
          code: { type: "string", description: "Why it was refused.", maxLength: 60 },
          message: { type: "string", description: "What was wrong, for the person.", maxLength: 500 },
          next: { type: "string", description: "What to do instead.", maxLength: 500 },
        },
        required: ["code", "message", "next"],
      },
      gaps: { type: "array", description: "What the parse could not read, and why.", maxItems: 20, items: { type: "string", description: "One gap.", maxLength: 600 } },
      note: { type: "string", description: "What to do with this grounding, in one sentence.", maxLength: 500 },
    },
    required: ["routeOrPath", "stack", "fidelity", "files", "outline"],
  },
  annotations: { readOnly: true, idempotent: true, destructive: false, external: false },
  label: "injected",
};

/** The four specs, in the order the docs list them. */
export const DESIGN_INDEX_TOOL_SPECS: readonly LaserToolSpec[] = [INSPECT_DESIGN_INDEX_SPEC, BUILD_DESIGN_INDEX_SPEC, REVIEW_DESIGN_INDEX_SPEC, GROUND_HOST_PAGE_SPEC];

/** What each tool says about a failure that does not know its own recovery. */
export const DESIGN_INDEX_TOOL_RECOVERY: Record<string, { code: string; next: string }> = {
  inspect_design_index: { code: "index_unreadable", next: "call build_design_index to build this project's index, then inspect it" },
  build_design_index: { code: "build_refused", next: "call inspect_design_index to see whether an index already exists" },
  review_design_index: { code: "review_refused", next: "call inspect_design_index to read the entry as it is now, then review it again" },
  ground_host_page: { code: "grounding_failed", next: "call ground_host_page again with the template's path instead of the route" },
};

// -------------------------------------------------------------- the handlers

export interface InspectDesignIndexInput {
  query?: string;
  entry_id?: string;
  kind?: (typeof ENTRY_KINDS)[number];
  era_id?: string;
  review_state?: "unreviewed" | "accepted" | "renamed" | "merged" | "split" | "rejected" | "changed";
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function detailText(entry: DesignIndexEntry): string | undefined {
  if (!entry.detail) return undefined;
  const text = Object.entries(entry.detail)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return text === "" ? undefined : text.slice(0, 4000);
}

function score(entry: DesignIndexEntry, query: string): number {
  const name = entry.name.toLowerCase();
  const summary = (entry.summary ?? "").toLowerCase();
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter((part) => part !== "")) {
    if (name === word) total += 10;
    else if (name.includes(word)) total += 5;
    if (summary.includes(word)) total += 2;
  }
  return total;
}

/** `inspect_design_index`. Read-only: it never builds and never writes. */
export async function inspectDesignIndex(bridge: DesignIndexBridge, input: InspectDesignIndexInput): Promise<Record<string, unknown>> {
  let index: DesignIndex | undefined;
  try {
    index = await bridge.index();
  } catch (failure) {
    throw asToolFailure(failure, "inspect_design_index");
  }
  if (!index) {
    refuse(
      "no_index",
      "This project has no design index yet, so there is nothing to read. An index is built by parsing the project's own source; it takes seconds to minutes and changes nothing.",
      "call build_design_index to build it, then call inspect_design_index again",
    );
  }
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  if (input.entry_id !== undefined) {
    const entry = index.entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) {
      refuse(
        "no_such_entry",
        `This index has no entry called "${input.entry_id}".`,
        "call inspect_design_index without entry_id to list the entries with their ids",
      );
    }
    return answer(index, [entry], 1, false);
  }

  let matched = index.entries.filter((entry) => {
    if (input.kind !== undefined && entry.kind !== input.kind) return false;
    if (input.era_id !== undefined && entry.eraId !== input.era_id) return false;
    if (input.review_state === "changed") return entry.changedSinceReview === true;
    if (input.review_state !== undefined && entry.review.state !== input.review_state) return false;
    return true;
  });
  if (input.query !== undefined && input.query.trim() !== "") {
    const query = input.query.trim();
    matched = matched
      .map((entry) => ({ entry, score: score(entry, query) }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((row) => row.entry);
  }
  const page = matched.slice(0, limit);
  return answer(index, page, matched.length, matched.length > page.length);
}

function answer(index: DesignIndex, entries: DesignIndexEntry[], matched: number, truncated: boolean): Record<string, unknown> {
  const progress = reviewProgress(index);
  return {
    stack: `${index.stack.frameworks.join(", ") || "no framework found"} · ${index.stack.styling.join(", ") || "no styling found"}`,
    eras: index.eras.map((era) => ({ id: era.id, name: era.name, useForNewWork: era.useForNewWork })),
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      confidence: entry.confidence,
      reviewState: entry.review.state,
      ...(entry.changedSinceReview === true ? { changedSinceReview: true } : {}),
      ...(entry.factsDigest !== undefined ? { factsDigest: entry.factsDigest } : {}),
      sources: entry.sources.slice(0, 16).map((source) => source.path),
      ...(detailText(entry) !== undefined ? { detail: detailText(entry) } : {}),
    })),
    counts: { matched, total: progress.total, reviewed: progress.reviewed, changed: progress.changed },
    gaps: index.gaps.slice(0, 20).map((gap) => `${gap.path}: ${gap.reason}`),
    ...(truncated ? { truncated: true } : {}),
  };
}

export interface BuildDesignIndexInput {
  rebuild?: boolean;
  app_root?: string;
  max_files?: number;
}

/** `build_design_index`. Starts the command and answers; it never waits. */
export async function buildDesignIndexTool(bridge: DesignIndexBridge, input: BuildDesignIndexInput): Promise<Record<string, unknown>> {
  if (input.app_root !== undefined && (input.app_root.startsWith("/") || input.app_root.includes("..") || /^[A-Za-z]:/.test(input.app_root))) {
    refuse(
      "outside_project",
      `"${input.app_root}" is not a folder inside this project, and the index only ever reads the project it belongs to.`,
      "call build_design_index again with app_root as a path relative to the project, or leave it out to index the whole project",
    );
  }
  let started: { commandId: string; title: string; appRoot: string };
  try {
    started = await bridge.startBuild({
      rebuild: input.rebuild === true,
      ...(input.app_root !== undefined ? { appRoot: input.app_root } : {}),
      ...(input.max_files !== undefined ? { maxFiles: input.max_files } : {}),
    });
  } catch (failure) {
    throw asToolFailure(failure, "build_design_index");
  }
  return {
    commandId: started.commandId,
    title: started.title,
    appRoot: started.appRoot,
    note: "The index is being built in the background; it shows in this conversation's fleet with its progress in files, and the person can stop it there. Carry on with your own work and read it with inspect_design_index when it is done.",
  };
}

export interface ReviewDesignIndexInput {
  entry_id: string;
  action: DesignReviewAction;
  name?: string;
  into_entry_id?: string;
  into?: string[];
  use_for_new_work?: boolean;
  note?: string;
  facts_digest?: string;
}

/** `review_design_index`. Person-attributed when a person calls; model-attributed otherwise. */
export async function reviewDesignIndexTool(
  bridge: DesignIndexBridge,
  input: ReviewDesignIndexInput,
  actor: ReviewActor,
): Promise<Record<string, unknown>> {
  if (!(DESIGN_REVIEW_ACTIONS as readonly string[]).includes(input.action)) {
    refuse(
      "unknown_action",
      `"${String(input.action)}" is not something this tool can record. The decisions are ${DESIGN_REVIEW_ACTIONS.join(", ")}.`,
      "call review_design_index again with one of those actions",
    );
  }
  let result: { entry: DesignIndexEntry; reviewed: number; total: number };
  try {
    result = await bridge.review({
      entryId: input.entry_id,
    action: input.action,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.into_entry_id !== undefined ? { intoEntryId: input.into_entry_id } : {}),
      ...(input.into !== undefined ? { into: input.into } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.use_for_new_work !== undefined ? { useForNewWork: input.use_for_new_work } : {}),
      ...(input.facts_digest !== undefined ? { expectedFactsDigest: input.facts_digest } : {}),
      actor,
    });
  } catch (failure) {
    throw asToolFailure(failure, "review_design_index");
  }
  return {
    entryId: result.entry.id,
    name: result.entry.name,
    reviewState: result.entry.review.state,
    reviewedBy: `${actor.label} (${actor.kind})`,
    reviewed: result.reviewed,
    total: result.total,
  };
}

export interface GroundHostPageInput {
  route_or_path: string;
  app_root?: string;
  reference_blob_id?: string;
  feature_size?: (typeof FEATURE_SIZES)[number];
  host_stack_can_express?: boolean;
  migration_wanted?: boolean;
}

/**
 * `ground_host_page`. Read-only in every sense: it walks the project, parses
 * templates as text and answers. Nothing is written, nothing is executed, and
 * a route it cannot find is a refusal with the pages it did find.
 */
export async function groundHostPageTool(bridge: HostGroundingBridge, input: GroundHostPageInput): Promise<Record<string, unknown>> {
  const asked = (input.route_or_path ?? "").trim();
  if (asked === "") {
    refuse(
      "no_route",
      "Grounding a host page needs the page: a route, a template path, or a view name.",
      "call ground_host_page again with route_or_path set to the page you are designing into",
    );
  }
  if (input.app_root !== undefined && (input.app_root.startsWith("/") || input.app_root.includes("..") || /^[A-Za-z]:/.test(input.app_root))) {
    refuse(
      "outside_project",
      `"${input.app_root}" is not a folder inside this project, and grounding only ever reads the project it belongs to.`,
      "call ground_host_page again with app_root as a path relative to the project, or leave it out",
    );
  }
  let result: Awaited<ReturnType<HostGroundingBridge["ground"]>>;
  try {
    result = await bridge.ground({
      routeOrPath: asked,
      ...(input.app_root !== undefined ? { appRoot: input.app_root } : {}),
      ...(input.reference_blob_id !== undefined ? { referenceBlobId: input.reference_blob_id } : {}),
      ...(input.feature_size !== undefined ? { featureSize: input.feature_size } : {}),
      ...(input.host_stack_can_express !== undefined ? { hostStackCanExpress: input.host_stack_can_express } : {}),
      ...(input.migration_wanted !== undefined ? { migrationWanted: input.migration_wanted } : {}),
    });
  } catch (failure) {
    throw asToolFailure(failure, "ground_host_page");
  }

  const page = result.hostPage;
  if (!page) {
    const candidates = result.candidates.slice(0, 10);
    refuse(
      "no_such_page",
      candidates.length === 0
        ? `Nothing in this project draws "${asked}", and no page templates were found to offer instead.`
        : `Nothing in this project draws "${asked}". The pages that are here: ${candidates.join("; ")}.`,
      candidates.length === 0
        ? "call ground_host_page with the path of the template file you mean, or design a new page instead of one in context"
        : "call ground_host_page again with one of those routes, or with the template's path",
    );
  }

  const strategy = result.strategy;
  return {
    routeOrPath: page.routeOrPath,
    ...(page.templatePath !== undefined ? { templatePath: page.templatePath } : {}),
    stack: page.stack ?? "unknown",
    fidelity: page.fidelity,
    files: page.files,
    outline: result.outline.nodes.map((node) => ({
      id: node.id,
      role: node.role,
      ...(node.label !== undefined ? { label: node.label } : {}),
      depth: node.depth,
      templatePath: node.templatePath,
      structuralPath: node.structuralPath,
      textHash: node.textHash,
    })),
    ...(page.references !== undefined && page.references.length > 0
      ? {
          references: page.references.map((reference) => ({
            kind: reference.kind,
            ...(reference.label !== undefined ? { label: reference.label } : {}),
            ...(reference.path !== undefined ? { path: reference.path } : {}),
            fidelity: reference.fidelity,
          })),
        }
      : {}),
    ...(strategy !== undefined
      ? {
          strategy: {
            recommended: strategy.recommended,
            summary: strategy.summary,
            proposalOnly: strategy.proposalOnly,
            conformReasons: strategy.conform.reasons,
            conformTradeoffs: strategy.conform.tradeoffs,
            islandReasons: strategy.island.reasons,
            islandTradeoffs: strategy.island.tradeoffs,
            eraId: strategy.recommended === "island" ? strategy.island.eraId : strategy.conform.eraId,
          },
        }
      : {}),
    ...(result.referenceRefused !== undefined
      ? { referenceRefused: { code: result.referenceRefused.code, message: result.referenceRefused.message, next: result.referenceRefused.next } }
      : {}),
    gaps: result.gaps.slice(0, 20).map((gap) => `${gap.path}: ${gap.reason}`),
    note:
      strategy === undefined
        ? "The host page is frozen: it is an outline of real templates, not something to edit. Compose the new subtree against one outline node, and say which node you anchored to."
        : `The host page is frozen; compose the new subtree against one outline node. ${strategy.recommended === "island" ? "Island" : "Conform"} is proposed — say why, give the person the other case too, and let them choose.`,
  };
}
