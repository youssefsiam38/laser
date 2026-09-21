/**
 * The four model-facing project lifecycle tools (leap, "Protocol and
 * authority"; `docs/agent-tool-contract.md`, D-350).
 *
 * | Tool | Does | Writes |
 * | --- | --- | --- |
 * | `inspect_project_work` | list, get or search the project's work | no |
 * | `write_project_artifact` | create or revise one artifact | yes |
 * | `request_project_review` | comment, ask for review, mark a comment addressed | yes |
 * | `report_project_task` | move a Task, record its evidence, link an attempt | yes |
 *
 * Four rules shape all of it:
 *
 * - **Summary by default.** A list or a get answers with identity and one
 *   line; a body comes only when `include` asks for it, and then as a bounded
 *   page with `next_offset`.
 * - **Exact revisions.** Every write carries `expected_revision_id` and
 *   `idempotency_key`; a mismatch is the typed `stale_revision` conflict with
 *   the revision to read, never a silent overwrite.
 * - **Opaque ids, no paths.** Nothing here returns a host path, a storage
 *   location or an engine session file — a Task attempt's checkout is
 *   recorded by the host and never handed back to a model.
 * - **The host decides.** Project, trust, scope and the research rules are
 *   re-checked there on every call; a refusal comes back as this contract's
 *   `{ code, message, committed, next }`.
 */
import { createHash } from "node:crypto";
import {
  ARTIFACT_REVIEW_STATES,
  EVIDENCE_KINDS,
  EVIDENCE_ROLES,
  PROJECT_TASK_ACTIONS,
  PROJECT_TASK_STATES,
  PROJECT_WORK_BODY_PAGE_MAX_BYTES,
  PROJECT_WORK_KINDS,
  PROJECT_WORK_LIST_LIMIT_MAX,
  PROJECT_WORK_NOTE_MAX,
  PROJECT_WORK_SEARCH_LIMIT_MAX,
  PROJECT_WORK_TEXT_MAX,
  isRecord,
  projectWorkBodySchema,
  type AttemptRepositoryRecord,
  type LaserToolSpec,
  type ProjectTaskAction,
  type ProjectWorkBody,
  type ProjectWorkComment,
  type ProjectWorkEntity,
  type ProjectWorkGetResult,
  type ProjectWorkKind,
  type ProjectWorkListResult,
  type ProjectWorkSearchResults,
} from "@lasercode/protocol";
import { attemptEnvelope, projectWorkFailure, refuseProjectWork, type ProjectWorkBridge } from "./bridge.js";

/** The most of a body one call may read. Bigger pages come by asking again. */
export const PROJECT_WORK_TOOL_BODY_PAGE = 8_192;
/** The most body text a model may send in one write. */
export const PROJECT_WORK_TOOL_BODY_MAX = 120_000;
/** The most comments, evidence rows or links one answer carries. */
export const PROJECT_WORK_TOOL_RELATED_MAX = 25;
/** The bound on an opaque id a model hands back. */
const ID_MAX = 64;

const ENTITY_STATES = [...new Set<string>([...ARTIFACT_REVIEW_STATES, ...PROJECT_TASK_STATES])];

/** What each tool says about a failure that does not know its own recovery. */
export const PROJECT_WORK_TOOL_RECOVERY: Record<string, { code: string; next: string }> = {
  inspect_project_work: {
    code: "project_work_unreadable",
    next: "call inspect_project_work with action list to see what this project has",
  },
  write_project_artifact: {
    code: "write_refused",
    next: "call inspect_project_work on the artifact to read its current revision, then write again with it",
  },
  request_project_review: {
    code: "review_refused",
    next: "call inspect_project_work on the artifact with include comments to read where it stands, then ask again",
  },
  report_project_task: {
    code: "task_report_refused",
    next: "call inspect_project_work on the task to read its state and readiness, then report again",
  },
};

// ----------------------------------------------------------------- the specs

const INCLUDE_VALUES = ["body", "comments", "approvals", "evidence", "links", "history"] as const;
const ANCHOR_TARGETS = ["entity", "section", "node", "flow_edge", "token", "region"] as const;
const REPORT_ACTIONS = [...PROJECT_TASK_ACTIONS, "record_evidence", "link_execution"] as const;

export const INSPECT_PROJECT_WORK_SPEC: LaserToolSpec = {
  name: "inspect_project_work",
  description:
    "Read this project's work: its specs, research, designs, plans and tasks. " +
    "action list pages the project's items, action get reads one by key (SPEC-12) or entity_id, action search finds items by words in their text. " +
    "Answers are summaries: identity, title, state, the current revision and one line. Ask for more with include — body returns a bounded page of the typed body with next_offset, comments, approvals, evidence, links and history return at most 25 rows each. " +
    "Every answer carries the revision_id and digest a write has to quote. project_id reads another project you have access to; without it this session's own project is read, and a session with no project can still read by naming one. Reads change nothing.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", description: "list the project's work, get one item, or search for items.", enum: ["list", "get", "search"] },
      project_id: { type: "string", description: "Another project, from a search result or a mention. Omitted reads this session's project.", maxLength: ID_MAX },
      key: { type: "string", description: "The item's person-facing key, like SPEC-12 or TASK-4.", maxLength: 40 },
      entity_id: { type: "string", description: "The item's opaque id, when you have it instead of a key.", maxLength: ID_MAX },
      revision_id: { type: "string", description: "A historical revision to read. Omitted reads the current one.", maxLength: ID_MAX },
      query: { type: "string", description: "Words to search for, for action search.", maxLength: 200 },
      kinds: {
        type: "array",
        description: "Narrow to these kinds.",
        maxItems: 5,
        items: { type: "string", description: "One kind of project work.", enum: [...PROJECT_WORK_KINDS] },
      },
      states: {
        type: "array",
        description: "Narrow a list to these states.",
        maxItems: 12,
        items: { type: "string", description: "One state.", enum: ENTITY_STATES },
      },
      needs_you: { type: "boolean", description: "List only what is waiting on a person." },
      include: {
        type: "array",
        description: "What to add to a get beyond the summary.",
        maxItems: 6,
        items: { type: "string", description: "One projection.", enum: [...INCLUDE_VALUES] },
      },
      body_offset: { type: "integer", description: "Where to start reading the body, in bytes. Use the next_offset of the previous page.", minimum: 0, maximum: 16_000_000 },
      body_limit: { type: "integer", description: "How many bytes of body to read. Default 8192.", minimum: 1, maximum: PROJECT_WORK_BODY_PAGE_MAX_BYTES },
      limit: { type: "integer", description: "How many items to return. Default 20.", minimum: 1, maximum: PROJECT_WORK_LIST_LIMIT_MAX },
      cursor: { type: "string", description: "The next_cursor of the previous page.", maxLength: 200 },
    },
    required: ["action"],
  },
  output: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "The project this answer is about." },
      items: { type: "array", description: "One row per item: key, kind, title, state, revision and digest.", items: { type: "object", description: "One item summary." } },
      counts: { type: "object", description: "How many items this project has, by kind and by state." },
      item: { type: "object", description: "The item a get read: key, kind, title, state, revision, digest, and its readiness when it is a task." },
      body: { type: "object", description: "A bounded page of the typed body: text, total_bytes, next_offset." },
      comments: { type: "array", description: "Open and addressed comments, newest first.", items: { type: "object", description: "One comment." } },
      approvals: { type: "array", description: "Gate decisions recorded against this item.", items: { type: "object", description: "One approval." } },
      evidence: { type: "array", description: "Evidence records joined to this item.", items: { type: "object", description: "One evidence record." } },
      links: { type: "array", description: "Relations, repository links and execution attempts.", items: { type: "object", description: "One link." } },
      history: { type: "array", description: "Revision metadata, newest first.", items: { type: "object", description: "One revision." } },
      results: { type: "array", description: "Search matches with the snippet that matched.", items: { type: "object", description: "One match." } },
      next_cursor: { type: "string", description: "Pass as cursor to read the next page." },
      omitted: { type: "integer", description: "How many rows were left out of a truncated list." },
      advice: { type: "string", description: "How to ask for less, when something was cut." },
    },
  },
  annotations: { readOnly: true, idempotent: true, destructive: false, external: false },
  label: "injected",
};

export const WRITE_PROJECT_ARTIFACT_SPEC: LaserToolSpec = {
  name: "write_project_artifact",
  description:
    "Create or revise one piece of this project's work: a spec, research, design, plan or task. " +
    "body_json is the typed body for that kind, as JSON — read an existing item with inspect_project_work include body to see the shape. " +
    "action revise needs the entity and the expected_revision_id you read; if the item has moved on, nothing is written and the refusal names the revision to read. " +
    "Every call needs an idempotency_key you choose: sending the same key twice returns the first result instead of writing twice. " +
    "It writes into this session's own project; work owned by another project is read-only from here. Research findings and answers are written with record_finding and resolve_question, not here.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", description: "create a new item, or revise an existing one.", enum: ["create", "revise"] },
      kind: { type: "string", description: "What to create. Required for action create.", enum: [...PROJECT_WORK_KINDS] },
      title: { type: "string", description: "The item's title. Required for a create; changes the title on a revise.", maxLength: 200 },
      key: { type: "string", description: "The item to revise, by key, like DES-3.", maxLength: 40 },
      entity_id: { type: "string", description: "The item to revise, by opaque id.", maxLength: ID_MAX },
      expected_revision_id: { type: "string", description: "The revision you read, for a revise. The write is refused if it is no longer current.", maxLength: ID_MAX },
      body_json: { type: "string", description: "The typed body for this kind, as JSON.", maxLength: PROJECT_WORK_TOOL_BODY_MAX },
      note: { type: "string", description: "Why this revision exists, in one or two sentences.", maxLength: PROJECT_WORK_NOTE_MAX },
      idempotency_key: { type: "string", description: "Your own key for this exact write; a repeat with it returns the first result.", maxLength: 200 },
    },
    required: ["action", "body_json", "idempotency_key"],
  },
  output: {
    type: "object",
    properties: {
      key: { type: "string", description: "The item's person-facing key." },
      entity_id: { type: "string", description: "Its opaque id." },
      kind: { type: "string", description: "What kind of work it is." },
      state: { type: "string", description: "Its state after the write." },
      revision_id: { type: "string", description: "The revision this write created; quote it on the next write." },
      digest: { type: "string", description: "The digest of that revision." },
      replayed: { type: "boolean", description: "True when this answer replayed an earlier call with the same idempotency_key." },
      plan_graph: { type: "object", description: "For a plan: the task graph this revision accepted." },
      note: { type: "string", description: "What happens next, in one sentence." },
    },
  },
  annotations: { readOnly: false, idempotent: true, destructive: false, external: false },
  label: "injected",
};

export const REQUEST_PROJECT_REVIEW_SPEC: LaserToolSpec = {
  name: "request_project_review",
  description:
    "Put a piece of project work in front of a person, or leave a comment on it. " +
    "action comment anchors a note to the whole item, a section, a design node, a flow edge, a token or a host region; blocking true means a gate cannot be approved until a person resolves it. " +
    "action request_review moves the item to needs review. action mark_comment_addressed says you have dealt with a comment — only a person resolves one. " +
    "Gate-affecting calls accept preview true, which writes nothing and answers with exactly what the person would see. " +
    "Approving is a person's alone; this tool never approves. Every call needs the expected_revision_id you read and an idempotency_key you choose.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        description: "leave a comment, ask a person to review, take it back to draft, or mark a comment addressed.",
        enum: ["comment", "request_review", "return_to_draft", "mark_comment_addressed"],
      },
      key: { type: "string", description: "The item, by key, like SPEC-12.", maxLength: 40 },
      entity_id: { type: "string", description: "The item, by opaque id.", maxLength: ID_MAX },
      expected_revision_id: { type: "string", description: "The revision you read. The call is refused if it is no longer current.", maxLength: ID_MAX },
      revision_id: { type: "string", description: "For a comment: the revision it is about, when that is an older one.", maxLength: ID_MAX },
      anchor_target: { type: "string", description: "What the comment is about. Default entity.", enum: [...ANCHOR_TARGETS] },
      anchor_id: { type: "string", description: "The id of the section, node, edge, token or region the comment anchors to.", maxLength: 120 },
      screen_id: { type: "string", description: "For a node anchor: the screen the node is on.", maxLength: ID_MAX },
      text: { type: "string", description: "The comment, written for a person.", maxLength: PROJECT_WORK_TEXT_MAX },
      blocking: { type: "boolean", description: "True when this comment must be resolved before a gate can be approved." },
      comment_id: { type: "string", description: "The comment to mark addressed.", maxLength: ID_MAX },
      note: { type: "string", description: "Why, for a review request or a return to draft.", maxLength: PROJECT_WORK_NOTE_MAX },
      preview: { type: "boolean", description: "Answer with what this would do and write nothing." },
      idempotency_key: { type: "string", description: "Your own key for this exact call; a repeat with it returns the first result.", maxLength: 200 },
    },
    required: ["action", "expected_revision_id", "idempotency_key"],
  },
  output: {
    type: "object",
    properties: {
      key: { type: "string", description: "The item this was recorded on." },
      entity_id: { type: "string", description: "Its opaque id." },
      state: { type: "string", description: "Its state after the call." },
      comment_id: { type: "string", description: "The comment that was created or updated." },
      comment_state: { type: "string", description: "open, addressed or resolved." },
      blocking_comments: { type: "integer", description: "How many open blocking comments the item has now." },
      preview: { type: "boolean", description: "True when nothing was written and this is what would happen." },
      digest: { type: "string", description: "The preview's digest, for the person's confirmation." },
      summary: { type: "string", description: "One sentence saying what this does." },
      confirmWith: { type: "string", description: "The tool that carries the preview out." },
      note: { type: "string", description: "What happens next, in one sentence." },
    },
  },
  annotations: { readOnly: false, idempotent: true, destructive: false, external: false },
  label: "injected",
};

export const REPORT_PROJECT_TASK_SPEC: LaserToolSpec = {
  name: "report_project_task",
  description:
    "Report on a project task: move it, record what you proved, or link this session to it as an attempt. " +
    "action start, submit_for_review, block, request_changes, reopen, mark_ready, cancel and return_to_draft move the task; the host refuses a move the task's dependencies or upstream do not allow and says why. " +
    "action record_evidence stores one piece of evidence — a test run, a diff, a command's output — with its outcome. " +
    "action link_execution records this session as an attempt on the task and is what a run does before it starts working; passing outcome ends the attempt and records evidence only. " +
    "The files an attempt changed are read from this session's own checkpoints and from git, never from what you report, so report what you proved rather than which files you touched. " +
    "A task is never marked done by a report alone: action complete needs acceptance evidence that passed, in this call or already recorded. Every call needs the expected_revision_id you read and an idempotency_key you choose.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", description: "What to report about the task.", enum: [...REPORT_ACTIONS] },
      key: { type: "string", description: "The task, by key, like TASK-7.", maxLength: 40 },
      entity_id: { type: "string", description: "The task, by opaque id.", maxLength: ID_MAX },
      expected_revision_id: { type: "string", description: "The revision you read. The call is refused if it is no longer current.", maxLength: ID_MAX },
      note: { type: "string", description: "Why, in a sentence a person reads.", maxLength: PROJECT_WORK_NOTE_MAX },
      evidence_kind: { type: "string", description: "What the evidence is.", enum: [...EVIDENCE_KINDS] },
      evidence_role: { type: "string", description: "acceptance proves the task is done; supporting is context; deviation records a difference.", enum: [...EVIDENCE_ROLES] },
      evidence_summary: { type: "string", description: "One line: what was run or seen, and what it showed.", maxLength: PROJECT_WORK_TEXT_MAX },
      evidence_detail: { type: "string", description: "The detail behind it: the command, the failing line, the diff summary.", maxLength: PROJECT_WORK_TEXT_MAX },
      evidence_outcome: { type: "string", description: "Whether it passed, failed or was inconclusive.", enum: ["passed", "failed", "inconclusive"] },
      evidence_id: { type: "string", description: "Evidence already recorded, for a complete that rests on it.", maxLength: ID_MAX },
      outcome: { type: "string", description: "For link_execution: how this attempt ended. Omitted starts one.", enum: ["completed", "blocked", "cancelled", "failed"] },
      idempotency_key: { type: "string", description: "Your own key for this exact call; a repeat with it returns the first result.", maxLength: 200 },
    },
    required: ["action", "expected_revision_id", "idempotency_key"],
  },
  output: {
    type: "object",
    properties: {
      key: { type: "string", description: "The task this was recorded on." },
      entity_id: { type: "string", description: "Its opaque id." },
      state: { type: "string", description: "The task's state now." },
      transition: { type: "object", description: "The move that happened: from and to." },
      readiness: { type: "object", description: "Whether the task can be worked on now, and why not when it cannot." },
      cascaded: { type: "array", description: "Other tasks this move changed.", items: { type: "object", description: "One task the graph moved." } },
      evidence_id: { type: "string", description: "The evidence record this call wrote." },
      attempt: { type: "integer", description: "Which attempt this session is on the task." },
      execution_link_id: { type: "string", description: "The attempt's link id." },
      repositories: {
        type: "array",
        description: "What each repository recorded for this attempt, from its checkpoints: how many files changed and how many checkpoints it has.",
        items: { type: "object", description: "One repository's record of this attempt." },
      },
      conflicts: { type: "array", description: "Active tasks writing where this one does.", items: { type: "object", description: "One conflict." } },
      note: { type: "string", description: "What happens next, in one sentence." },
    },
  },
  annotations: { readOnly: false, idempotent: true, destructive: false, external: false },
  label: "injected",
};

/** The four specs, in the order the leap lists them. */
export const PROJECT_WORK_TOOL_SPECS: readonly LaserToolSpec[] = [
  INSPECT_PROJECT_WORK_SPEC,
  WRITE_PROJECT_ARTIFACT_SPEC,
  REQUEST_PROJECT_REVIEW_SPEC,
  REPORT_PROJECT_TASK_SPEC,
];

// -------------------------------------------------------------- the handlers

export interface InspectProjectWorkInput {
  action: "list" | "get" | "search";
  project_id?: string;
  key?: string;
  entity_id?: string;
  revision_id?: string;
  query?: string;
  kinds?: ProjectWorkKind[];
  states?: string[];
  needs_you?: boolean;
  include?: Array<(typeof INCLUDE_VALUES)[number]>;
  body_offset?: number;
  body_limit?: number;
  limit?: number;
  cursor?: string;
}

/** identity + one line, never a body. What every summary row is. */
function entityRow(entity: ProjectWorkEntity): Record<string, unknown> {
  return {
    key: entity.key,
    entity_id: entity.entityId,
    kind: entity.kind,
    title: entity.title,
    state: entity.state,
    revision_id: entity.currentRevisionId,
    digest: entity.currentDigest,
    updated_at: entity.updatedAt,
    ...(entity.blockingComments ? { blocking_comments: entity.blockingComments } : {}),
    ...(entity.staleBecause ? { stale_because: entity.staleBecause.upstreamKey } : {}),
    ...(entity.archivedAt ? { archived: true } : {}),
  };
}

function commentRow(comment: ProjectWorkComment): Record<string, unknown> {
  return {
    comment_id: comment.commentId,
    revision_id: comment.revisionId,
    anchor: comment.anchor,
    text: comment.text,
    state: comment.state,
    blocking: comment.blocking,
    by: comment.origin.actor.kind === "person" ? "person" : "agent",
    created_at: comment.createdAt,
    ...(comment.orphaned ? { orphaned: true } : {}),
  };
}

export async function inspectProjectWork(bridge: ProjectWorkBridge, input: InspectProjectWorkInput): Promise<Record<string, unknown>> {
  const projectId = input.project_id ?? bridge.projectId();
  if (input.action === "search") {
    const query = input.query?.trim();
    if (!query) {
      refuseProjectWork(
        "no_query",
        "A search needs words to look for.",
        "call inspect_project_work again with a query, or with action list to see everything in this project",
      );
    }
    const results = (await bridge.call("project/work/search", {
      ...(projectId !== undefined ? { projectId } : {}),
      query,
      ...(input.kinds ? { kinds: input.kinds } : {}),
      limit: Math.min(input.limit ?? 10, PROJECT_WORK_SEARCH_LIMIT_MAX),
    })) as ProjectWorkSearchResults;
    return {
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      results: results.results.map((match) => ({
        key: match.ref.key,
        kind: match.ref.kind,
        title: match.ref.label,
        project_id: match.ref.projectId,
        entity_id: match.ref.entityId,
        revision_id: match.ref.revisionId,
        digest: match.ref.digest,
        ...(match.matches[0] ? { snippet: match.matches[0].snippet, matched: match.matches[0].field } : {}),
      })),
      ...(results.truncated
        ? { advice: "More matched than were returned; search for narrower words or pass a smaller limit." }
        : {}),
    };
  }

  if (input.action === "list") {
    if (projectId === undefined) {
      refuseProjectWork(
        "no_project",
        "This session is not working in a project, so there is no project work to list.",
        "call inspect_project_work with action search to find work in the projects you can read, then get it by project_id",
      );
    }
    const limit = Math.min(input.limit ?? 20, PROJECT_WORK_LIST_LIMIT_MAX);
    const page = (await bridge.call("project/work/list", {
      projectId,
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.states ? { states: input.states as ProjectWorkListResult["items"][number]["state"][] } : {}),
      ...(input.needs_you !== undefined ? { needsYou: input.needs_you } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      limit,
    })) as ProjectWorkListResult;
    return {
      project_id: page.projectId,
      items: page.items.map((item) => ({
        key: item.key,
        entity_id: item.ref.entityId,
        kind: item.kind,
        title: item.title,
        state: item.state,
        revision_id: item.ref.revisionId,
        digest: item.ref.digest,
        updated_at: item.updatedAt,
        ...(item.needsAttention ? { needs_you: true } : {}),
        ...(item.blockingComments > 0 ? { blocking_comments: item.blockingComments } : {}),
        ...(item.staleBecauseKey !== undefined ? { stale_because: item.staleBecauseKey } : {}),
      })),
      counts: page.counts,
      ...(page.nextCursor !== undefined
        ? { next_cursor: page.nextCursor, advice: "More items follow; pass next_cursor, or narrow with kinds or states." }
        : {}),
    };
  }

  if (projectId === undefined) {
    refuseProjectWork(
      "no_project",
      "Reading one item needs the project it belongs to.",
      "call inspect_project_work with action search to find it, then get it with the project_id the search returned",
    );
  }
  if (input.key === undefined && input.entity_id === undefined) {
    refuseProjectWork(
      "no_item",
      "Name the item to read, by key (SPEC-12) or by entity_id.",
      "call inspect_project_work with action list to see this project's items with their keys",
    );
  }
  const include = new Set(input.include ?? []);
  const wantsBody = include.has("body");
  const result = (await bridge.call("project/work/get", {
    projectId,
    ...(input.entity_id !== undefined ? { entityId: input.entity_id } : {}),
    ...(input.key !== undefined ? { key: input.key } : {}),
    ...(input.revision_id !== undefined ? { revisionId: input.revision_id } : {}),
    ...(wantsBody
      ? {
          body: {
            mode: "range" as const,
            offset: input.body_offset ?? 0,
            limit: Math.min(input.body_limit ?? PROJECT_WORK_TOOL_BODY_PAGE, PROJECT_WORK_BODY_PAGE_MAX_BYTES),
          },
        }
      : { body: { mode: "none" as const } }),
    include: {
      comments: include.has("comments"),
      approvals: include.has("approvals"),
      evidence: include.has("evidence"),
      links: include.has("links"),
      history: include.has("history"),
    },
  })) as ProjectWorkGetResult;

  const answer: Record<string, unknown> = {
    project_id: projectId,
    item: {
      ...entityRow(result.entity),
      revision_id: result.revision.revisionId,
      digest: result.revision.digest,
      ...(result.readiness ? { readiness: result.readiness } : {}),
      ...(result.conflicts && result.conflicts.length > 0 ? { conflicts: result.conflicts } : {}),
      ...(result.planGraph ? { plan_graph: result.planGraph } : {}),
    },
  };
  if (result.body) {
    answer["body"] = {
      text: result.body.text,
      total_bytes: result.body.totalBytes,
      offset: result.body.offset,
      bytes: result.body.bytes,
      ...(result.body.nextOffset !== undefined ? { next_offset: result.body.nextOffset } : {}),
      ...(result.body.released ? { released: result.body.released.detail } : {}),
    };
    if (result.body.nextOffset !== undefined) {
      answer["advice"] = "The body continues; read on with body_offset set to next_offset, or work from this page.";
    }
  }
  if (include.has("comments")) answer["comments"] = result.comments.slice(0, PROJECT_WORK_TOOL_RELATED_MAX).map(commentRow);
  if (include.has("approvals")) {
    answer["approvals"] = result.approvals.slice(0, PROJECT_WORK_TOOL_RELATED_MAX).map((approval) => ({
      gate: approval.gate,
      decision: approval.decision,
      at: approval.at,
      by: approval.origin.actor.label,
      covers: approval.covers.map((covered) => `${covered.key}@${covered.revisionId}`),
    }));
  }
  if (include.has("evidence")) {
    answer["evidence"] = result.evidence.slice(0, PROJECT_WORK_TOOL_RELATED_MAX).map((evidence) => ({
      evidence_id: evidence.evidenceId,
      kind: evidence.kind,
      role: evidence.role,
      outcome: evidence.outcome,
      summary: evidence.summary,
      at: evidence.at,
    }));
  }
  if (include.has("links")) {
    answer["links"] = [
      ...result.edges.slice(0, PROJECT_WORK_TOOL_RELATED_MAX).map((edge) => ({
        type: "relation",
        relation: edge.relation,
        subject: edge.subject.key,
        object: edge.object.key,
      })),
      ...result.executionLinks.slice(0, PROJECT_WORK_TOOL_RELATED_MAX).map((link) => ({
        type: "attempt",
        attempt: link.attempt,
        kind: link.kind,
        started_at: link.startedAt,
        ...(link.endedAt !== undefined ? { ended_at: link.endedAt } : {}),
        ...(link.outcome !== undefined ? { outcome: link.outcome } : {}),
        ...(link.branch !== undefined ? { branch: link.branch } : {}),
        ...(link.targetUnavailable ? { unavailable: true } : {}),
      })),
    ];
  }
  if (include.has("history")) {
    answer["history"] = (result.history ?? []).slice(0, PROJECT_WORK_TOOL_RELATED_MAX).map((revision) => ({
      revision_id: revision.revisionId,
      digest: revision.digest,
      at: revision.createdAt,
      by: revision.origin.actor.label,
      ...(revision.note !== undefined ? { note: revision.note } : {}),
    }));
  }
  if (result.truncated.length > 0) {
    answer["omitted"] = result.truncated.length;
    answer["advice"] = `These lists were cut: ${result.truncated.join(", ")}. Ask for one projection at a time.`;
  }
  return answer;
}

export interface WriteProjectArtifactInput {
  action: "create" | "revise";
  kind?: ProjectWorkKind;
  title?: string;
  key?: string;
  entity_id?: string;
  expected_revision_id?: string;
  body_json: string;
  note?: string;
  idempotency_key: string;
}

/** The typed body a write carries, parsed and shape-checked before it is sent. */
function parseBody(text: string, kind: ProjectWorkKind | undefined): ProjectWorkBody {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    refuseProjectWork(
      "body_not_json",
      `The body is not valid JSON: ${error instanceof Error ? error.message : "it could not be parsed"}.`,
      "call write_project_artifact again with body_json as a JSON object for this kind",
    );
  }
  // A body written as the bare body of its kind is the mistake a model makes
  // first; wrapping it is what the union asks for, so say which one is missing.
  const wrapped = isRecord(value) && typeof value["kind"] === "string" ? value : kind ? { kind, [kind]: value } : value;
  const parsed = projectWorkBodySchema.safeParse(wrapped);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuseProjectWork(
      "body_invalid",
      `That body is not a valid ${kind ?? "project work"} body: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "it does not match the shape"}.`,
      "call inspect_project_work on an item of this kind with include body to read the shape, then write again",
    );
  }
  return parsed.data as ProjectWorkBody;
}

export async function writeProjectArtifact(bridge: ProjectWorkBridge, input: WriteProjectArtifactInput): Promise<Record<string, unknown>> {
  const projectId = bridge.projectId();
  if (projectId === undefined) {
    refuseProjectWork(
      "no_project",
      "This session is not working in a project, so it cannot write project work.",
      "ask the person to open this chat in a project, or move it to one, and then write again",
    );
  }
  if (input.action === "create") {
    if (!input.kind) refuseProjectWork("no_kind", "A create says what kind of work it is.", "call write_project_artifact again with kind set to spec, research, design, plan or task");
    if (!input.title) refuseProjectWork("no_title", "A create needs a title a person can read.", "call write_project_artifact again with a title");
    const body = parseBody(input.body_json, input.kind);
    if (body.kind !== input.kind) {
      refuseProjectWork(
        "kind_mismatch",
        `This is a ${body.kind} body, but the call says kind ${input.kind}.`,
        "call write_project_artifact again with the kind that matches the body",
      );
    }
    const result = await bridge.call("project/work/create", {
      projectId,
      kind: input.kind,
      title: input.title,
      body,
      ...(input.note !== undefined ? { note: input.note } : {}),
      idempotencyKey: input.idempotency_key,
    });
    return {
      key: result.entity.key,
      entity_id: result.entity.entityId,
      kind: result.entity.kind,
      state: result.entity.state,
      revision_id: result.revision.revisionId,
      digest: result.revision.digest,
      ...(result.replayed ? { replayed: true } : {}),
      ...(result.planGraph ? { plan_graph: result.planGraph } : {}),
      note: `${result.entity.key} is a draft. Nobody has been asked to look at it: call request_project_review when it is ready for a person.`,
    };
  }

  const entityId = await entityIdFor(bridge, projectId, input);
  if (!input.expected_revision_id) {
    refuseProjectWork(
      "no_expected_revision",
      "A revise says which revision it is based on, so a change nobody read cannot be overwritten.",
      "call inspect_project_work on this item to read its revision_id, then revise with it",
    );
  }
  const body = parseBody(input.body_json, input.kind);
  const result = await bridge.call("project/work/revise", {
    projectId,
    entityId,
    expectedRevisionId: input.expected_revision_id,
    ...(input.title !== undefined ? { title: input.title } : {}),
    body,
    ...(input.note !== undefined ? { note: input.note } : {}),
    idempotencyKey: input.idempotency_key,
  });
  return {
    key: result.entity.key,
    entity_id: result.entity.entityId,
    kind: result.entity.kind,
    state: result.entity.state,
    revision_id: result.revision.revisionId,
    digest: result.revision.digest,
    ...(result.replayed ? { replayed: true } : {}),
    ...(result.planGraph ? { plan_graph: result.planGraph } : {}),
    note: `Revision ${result.revision.revisionId} of ${result.entity.key} is stored. Quote it as expected_revision_id on your next write.`,
  };
}

export interface RequestProjectReviewInput {
  action: "comment" | "request_review" | "return_to_draft" | "mark_comment_addressed";
  key?: string;
  entity_id?: string;
  expected_revision_id: string;
  revision_id?: string;
  anchor_target?: (typeof ANCHOR_TARGETS)[number];
  anchor_id?: string;
  screen_id?: string;
  text?: string;
  blocking?: boolean;
  comment_id?: string;
  note?: string;
  preview?: boolean;
  idempotency_key: string;
}

/** A short, stable digest of what a preview described. */
function previewDigest(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export async function requestProjectReview(bridge: ProjectWorkBridge, input: RequestProjectReviewInput): Promise<Record<string, unknown>> {
  const projectId = bridge.projectId();
  if (projectId === undefined) {
    refuseProjectWork(
      "no_project",
      "This session is not working in a project, so it cannot comment on or review its work.",
      "ask the person to open this chat in a project, and then ask again",
    );
  }
  const entityId = await entityIdFor(bridge, projectId, input);

  // A gate-affecting call may be previewed: the person sees the same sentence
  // the model would act on, and nothing is written (contract §2).
  if (input.preview === true) {
    const summary =
      input.action === "request_review"
        ? "Ask a person to review this work; it moves to needs review and waits for them."
        : input.action === "comment"
          ? `Leave ${input.blocking ? "a blocking " : "a "}comment on this work${input.blocking ? ", which stops a gate until a person resolves it" : ""}.`
          : input.action === "return_to_draft"
            ? "Take this work back to draft, so it is no longer in front of anybody."
            : "Mark a comment as addressed; only a person can resolve it.";
    return {
      preview: true,
      digest: previewDigest([input.action, entityId, input.expected_revision_id, input.text ?? "", input.blocking === true]),
      summary,
      items: [entityId],
      confirmWith: "request_project_review",
      note: "Nothing was written. Send the same call without preview to carry it out.",
    };
  }

  if (input.action === "comment") {
    const text = input.text?.trim();
    if (!text) refuseProjectWork("no_text", "A comment needs something to say.", "call request_project_review again with the text of the comment");
    const anchor = anchorFrom(input);
    const result = await bridge.call("project/work/comment", {
      projectId,
      entityId,
      expectedRevisionId: input.expected_revision_id,
      revisionId: input.revision_id ?? input.expected_revision_id,
      anchor,
      text,
      ...(input.blocking !== undefined ? { blocking: input.blocking } : {}),
      idempotencyKey: input.idempotency_key,
    });
    return {
      key: result.entity.key,
      entity_id: result.entity.entityId,
      state: result.entity.state,
      comment_id: result.comment.commentId,
      comment_state: result.comment.state,
      ...(result.entity.blockingComments !== undefined ? { blocking_comments: result.entity.blockingComments } : {}),
      note: result.comment.blocking
        ? "This comment blocks approval until a person resolves it."
        : "The comment is on the record; nobody has been asked to act on it.",
    };
  }

  if (input.action === "mark_comment_addressed") {
    if (!input.comment_id) {
      refuseProjectWork(
        "no_comment",
        "Name the comment you have addressed.",
        "call inspect_project_work on this item with include comments to read the comment ids, then mark one addressed",
      );
    }
    const result = await bridge.call("project/work/resolve-comment", {
      projectId,
      entityId,
      expectedRevisionId: input.expected_revision_id,
      commentId: input.comment_id,
      resolution: "addressed",
      idempotencyKey: input.idempotency_key,
    });
    return {
      key: result.entity.key,
      entity_id: result.entity.entityId,
      state: result.entity.state,
      comment_id: result.comment.commentId,
      comment_state: result.comment.state,
      note: "Marked as addressed. Only a person resolves a comment.",
    };
  }

  const result = await bridge.call("project/work/review", {
    projectId,
    entityId,
    expectedRevisionId: input.expected_revision_id,
    action: input.action === "request_review" ? "request_review" : "return_to_draft",
    ...(input.note !== undefined ? { note: input.note } : {}),
    idempotencyKey: input.idempotency_key,
  });
  return {
    key: result.entity.key,
    entity_id: result.entity.entityId,
    state: result.entity.state,
    note:
      input.action === "request_review"
        ? "A person has been asked to review it. Approving is theirs alone; carry on with something else."
        : "It is a draft again, and nobody is waiting on it.",
  };
}

function anchorFrom(input: RequestProjectReviewInput): { target: "entity" } | { target: "section"; sectionId: string } | { target: "node"; nodeId: string; screenId?: string } | { target: "flow_edge"; edgeId: string } | { target: "token"; tokenId: string } | { target: "region"; regionId: string } {
  const target = input.anchor_target ?? "entity";
  if (target === "entity") return { target: "entity" };
  const id = input.anchor_id?.trim();
  if (!id) {
    refuseProjectWork(
      "no_anchor",
      `A ${target} comment says which ${target} it is about.`,
      "call inspect_project_work with include body to read the ids, then comment with anchor_id set to one of them",
    );
  }
  switch (target) {
    case "section":
      return { target: "section", sectionId: id };
    case "node":
      return { target: "node", nodeId: id, ...(input.screen_id !== undefined ? { screenId: input.screen_id } : {}) };
    case "flow_edge":
      return { target: "flow_edge", edgeId: id };
    case "token":
      return { target: "token", tokenId: id };
    default:
      return { target: "region", regionId: id };
  }
}

export interface ReportProjectTaskInput {
  action: (typeof REPORT_ACTIONS)[number];
  key?: string;
  entity_id?: string;
  expected_revision_id: string;
  note?: string;
  evidence_kind?: (typeof EVIDENCE_KINDS)[number];
  evidence_role?: (typeof EVIDENCE_ROLES)[number];
  evidence_summary?: string;
  evidence_detail?: string;
  evidence_outcome?: "passed" | "failed" | "inconclusive";
  evidence_id?: string;
  outcome?: "completed" | "blocked" | "cancelled" | "failed";
  idempotency_key: string;
}

export async function reportProjectTask(bridge: ProjectWorkBridge, input: ReportProjectTaskInput): Promise<Record<string, unknown>> {
  const projectId = bridge.projectId();
  if (projectId === undefined) {
    refuseProjectWork(
      "no_project",
      "This session is not working in a project, so it has no tasks to report on.",
      "ask the person to open this chat in the project the task belongs to",
    );
  }
  const entityId = await entityIdFor(bridge, projectId, input);

  if (input.action === "link_execution") return linkExecution(bridge, projectId, entityId, input);

  // Evidence first, so a completion can name what it rests on in one call.
  let evidenceId = input.evidence_id;
  if (input.evidence_summary !== undefined || input.action === "record_evidence") {
    const summary = input.evidence_summary?.trim();
    if (!summary) {
      refuseProjectWork(
        "no_evidence_summary",
        "Evidence says in one line what was run or seen, and what it showed.",
        "call report_project_task again with evidence_summary, evidence_kind, evidence_role and evidence_outcome",
      );
    }
    const link = await bridge.call("project/work/link", {
      projectId,
      expectedRevisionId: input.expected_revision_id,
      link: {
        type: "evidence",
        entityId,
        revisionId: input.expected_revision_id,
        kind: input.evidence_kind ?? "command_output",
        role: input.evidence_role ?? "supporting",
        summary,
        ...(input.evidence_detail !== undefined ? { detail: input.evidence_detail } : {}),
        outcome: input.evidence_outcome ?? "inconclusive",
      },
      idempotencyKey: `${input.idempotency_key}-evidence`,
    });
    if (link.link.type === "evidence") evidenceId = link.link.evidence.evidenceId;
    if (input.action === "record_evidence") {
      return {
        entity_id: entityId,
        evidence_id: evidenceId,
        note: "The evidence is on the record. It does not move the task by itself: report the move you want as well.",
      };
    }
  }

  // A run ending, and a report, never mark a task done on their own: a
  // completion rests on acceptance evidence that passed (leap, "Plan and
  // Project Task contract").
  if (input.action === "complete" && evidenceId === undefined) {
    refuseProjectWork(
      "no_acceptance_evidence",
      "A task is not marked done by saying so: it needs acceptance evidence that passed.",
      "call report_project_task with action record_evidence, evidence_role acceptance and evidence_outcome passed, then complete it naming that evidence_id",
    );
  }

  const result = await bridge.call("project/task/action", {
    projectId,
    entityId,
    expectedRevisionId: input.expected_revision_id,
    action: input.action as ProjectTaskAction,
    ...(evidenceId !== undefined ? { evidenceId } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    idempotencyKey: input.idempotency_key,
  });
  return {
    key: result.entity.key,
    entity_id: result.entity.entityId,
    state: result.entity.state,
    transition: { from: result.transition.from, to: result.transition.to },
    ...(evidenceId !== undefined ? { evidence_id: evidenceId } : {}),
    ...(result.readiness ? { readiness: result.readiness } : {}),
    ...(result.cascaded && result.cascaded.length > 0
      ? { cascaded: result.cascaded.map((task) => ({ key: task.key, from: task.from, to: task.to })) }
      : {}),
    note: `${result.entity.key} is ${result.transition.to.replace(/_/g, " ")}.`,
  };
}

/**
 * This session, as an attempt on the task.
 *
 * The identity is the worker's, never the model's: a model cannot claim to be
 * another session, another run or another branch. What it may say is how the
 * attempt ended.
 */
async function linkExecution(
  bridge: ProjectWorkBridge,
  projectId: string,
  entityId: string,
  input: ReportProjectTaskInput,
): Promise<Record<string, unknown>> {
  const identity = bridge.identity();
  const shape = await bridge.execution();
  const targetId = identity.runId ?? identity.sessionId;
  if (!targetId) {
    refuseProjectWork(
      "no_session_identity",
      "This session has no identity to link an attempt to yet.",
      "carry on with the work and report the evidence with action record_evidence instead",
    );
  }
  const result = await bridge.call(
    "project/task/link-execution",
    {
      projectId,
      entityId,
      expectedRevisionId: input.expected_revision_id,
      execution: {
        kind: identity.runId ? "agent_run" : "session",
        targetId,
        ...(shape.profileId !== undefined ? { profileId: shape.profileId } : {}),
        ...(shape.branch !== undefined ? { branch: shape.branch } : {}),
        ...(shape.baseCommitObjectId !== undefined ? { baseCommitObjectId: shape.baseCommitObjectId } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome, endedAt: new Date().toISOString() } : {}),
      },
      idempotencyKey: input.idempotency_key,
    },
    { attempt: attemptEnvelope(shape) },
  );
  const repositories = result.attemptRepositories ?? result.link.repositories ?? [];
  return {
    key: result.entity.key,
    entity_id: result.entity.entityId,
    state: result.entity.state,
    attempt: result.link.attempt,
    execution_link_id: result.link.linkId,
    ...(repositories.length > 0 ? { repositories: repositories.map(attemptRepositoryRow) } : {}),
    ...(result.conflicts && result.conflicts.length > 0 ? { conflicts: result.conflicts } : {}),
    ...(result.attemptEvidence ? { evidence_id: result.attemptEvidence.evidenceId } : {}),
    note: input.outcome
      ? "The attempt is closed and its evidence recorded. Ending a run never marks the task done."
      : `Attempt ${String(result.link.attempt)} is linked to ${result.entity.key}. Start the work.`,
  };
}

/**
 * One repository's record of an attempt, as a model reads it.
 *
 * Counts and object ids, and the repository's own name — never a checkout
 * path, and never the full list of changed files, which is a page of the
 * workspace rather than something a tool answer carries. It is here so a model
 * can *see* what was observed about its own work: the files come from the
 * checkpoints, so a report that contradicts them is visibly wrong.
 */
function attemptRepositoryRow(record: AttemptRepositoryRecord): Record<string, unknown> {
  return {
    repository: record.name,
    repository_id: record.repositoryId,
    base_commit: record.base.commitObjectId,
    checkpoints: record.checkpoints.length,
    changed_files: record.changedPaths.length,
    ...(record.change ? { head_commit: record.change.head.commitObjectId, diff_digest: record.change.diffDigest } : {}),
    ...(record.commits.length > 0 ? { commits: record.commits.length } : {}),
    ...(record.unavailable ? { unavailable: true } : {}),
  };
}

/** The opaque id of the item a call names, resolving a key when it gave one. */
async function entityIdFor(
  bridge: ProjectWorkBridge,
  projectId: string,
  input: { key?: string; entity_id?: string },
): Promise<string> {
  if (input.entity_id !== undefined) return input.entity_id;
  if (input.key === undefined) {
    refuseProjectWork(
      "no_item",
      "Name the item, by key (SPEC-12) or by entity_id.",
      "call inspect_project_work with action list to see this project's items with their keys",
    );
  }
  const found = (await bridge.call("project/work/get", {
    projectId,
    key: input.key,
    body: { mode: "none" as const },
  })) as ProjectWorkGetResult;
  return found.entity.entityId;
}
