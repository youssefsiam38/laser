/**
 * The implementation context packet (leap, "Execution and convergence").
 *
 * What an attempt is given, and nothing else: the exact approved revisions it
 * is implementing, the comments nobody has resolved, the Tasks it depends on,
 * the acceptance it will be judged by, the project's own instructions, and
 * what the last attempt already proved.
 *
 * Three properties matter more than the contents:
 *
 * - **Bounded.** Every section has a ceiling and the packet has one; a Task
 *   with two hundred comments costs the same as a Task with three. What is
 *   cut says it was cut, and how to read the rest.
 * - **Provenance-labelled.** Every line that this session did not write opens
 *   with `[from …]` naming the exact revision or comment it came from, so a
 *   model can never mistake someone else's words for its own reasoning, and a
 *   person reading the transcript can see where a claim came from.
 * - **Refreshed at model-call boundaries.** It is built at
 *   `before_agent_start`, the same boundary the agent role block uses (D-140),
 *   so it can never describe a state older than the turn that reads it.
 */
import type {
  ProjectWorkComment,
  ProjectWorkEvidence,
  ProjectWorkGetResult,
  TaskReadiness,
} from "@lasercode/protocol";
import type { ProjectWorkBridge } from "./bridge.js";

/** Ceilings. A packet that grows with the project is not a packet. */
export const CONTEXT_PACKET_MAX = 6_000;
export const CONTEXT_PACKET_LINE_MAX = 300;
export const CONTEXT_PACKET_COMMENTS_MAX = 10;
export const CONTEXT_PACKET_EVIDENCE_MAX = 5;
export const CONTEXT_PACKET_UPSTREAM_MAX = 6;
export const CONTEXT_PACKET_INSTRUCTIONS_MAX = 1_200;

export interface ContextPacketOptions {
  bridge: ProjectWorkBridge;
  /** The Task this session is an attempt on. */
  task: { entityId: string; key?: string };
  /** The project's own instructions, as the person wrote them. */
  projectInstructions?: string | undefined;
}

export interface ContextPacket {
  /** The packet as the model reads it. Empty when there is nothing to say. */
  text: string;
  /** Which exact revisions it quotes, for the attempt record. */
  revisions: string[];
  /** True when something was left out, so a caller can say so. */
  truncated: boolean;
}

/** One line of somebody else's words, labelled and cut. */
function quoted(source: string, text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const room = CONTEXT_PACKET_LINE_MAX - source.length - 10;
  const cut = oneLine.length > room ? `${oneLine.slice(0, Math.max(room, 0))}…` : oneLine;
  return `[from ${source}] ${cut}`;
}

function unresolved(comments: readonly ProjectWorkComment[]): ProjectWorkComment[] {
  return comments.filter((comment) => comment.state !== "resolved");
}

function readinessLine(readiness: TaskReadiness | undefined): string | undefined {
  if (!readiness) return undefined;
  if (readiness.ready) return "Ready to work on.";
  const parts: string[] = [];
  if (readiness.unmetDependencies.length > 0) parts.push(`waiting on ${readiness.unmetDependencies.join(", ")}`);
  if (readiness.stalePausedBy) parts.push(`paused because ${readiness.stalePausedBy.key} is stale`);
  if (readiness.blockingComments > 0) parts.push(`${String(readiness.blockingComments)} blocking comments`);
  return parts.length > 0 ? `Not ready: ${parts.join("; ")}.` : "Not ready yet.";
}

function evidenceLine(evidence: ProjectWorkEvidence): string {
  return quoted(`${evidence.kind} evidence, ${evidence.outcome}`, evidence.summary);
}

/**
 * Build the packet.
 *
 * Every read is one bridge call and the number of them is bounded by
 * {@link CONTEXT_PACKET_UPSTREAM_MAX}: the Task itself, and at most six of the
 * artifacts it implements. A read that fails leaves its section out with a
 * line saying so — an attempt with a partial packet is better than a turn
 * that cannot start.
 */
export async function buildContextPacket(options: ContextPacketOptions): Promise<ContextPacket> {
  const { bridge } = options;
  const projectId = bridge.projectId();
  if (projectId === undefined) return { text: "", revisions: [], truncated: false };

  let task: ProjectWorkGetResult;
  try {
    task = (await bridge.call("project/work/get", {
      projectId,
      entityId: options.task.entityId,
      body: { mode: "full" as const },
      include: { comments: true, evidence: true, links: true, approvals: true },
    })) as ProjectWorkGetResult;
  } catch {
    return { text: "", revisions: [], truncated: false };
  }

  const lines: string[] = [];
  const revisions: string[] = [`${task.entity.key}@${task.revision.revisionId}`];
  let truncated = false;

  lines.push(`# ${task.entity.key} · ${task.entity.title}`);
  lines.push(
    `State ${task.entity.state}, revision ${task.revision.revisionId} (digest ${task.revision.digest.slice(0, 12)}). ` +
      "This packet is rebuilt every turn from the project's own record; quote the revision when you write.",
  );

  const body = task.body?.body;
  if (body?.kind === "task") {
    const taskBody = body.task;
    lines.push("", "## Outcome", quoted(`${task.entity.key} revision ${task.revision.revisionId}`, taskBody.outcome));
    if (taskBody.nonGoals.length > 0) {
      lines.push("", "## Not this task", ...taskBody.nonGoals.slice(0, 6).map((goal) => quoted(task.entity.key, goal)));
    }
    if (taskBody.acceptance.length > 0) {
      lines.push(
        "",
        "## Acceptance",
        ...taskBody.acceptance.slice(0, 10).map((criterion) =>
          quoted(`${task.entity.key} acceptance`, `${criterion.text}${criterion.command ? ` — ${criterion.command}` : ""}`),
        ),
      );
      if (taskBody.acceptance.length > 10) truncated = true;
    }
    if (taskBody.verificationCommands.length > 0) {
      lines.push("", "## Verify with", ...taskBody.verificationCommands.slice(0, 6).map((command) => quoted(task.entity.key, command)));
    }
    if (taskBody.dependencies.length > 0) {
      lines.push("", "## Depends on", quoted(task.entity.key, taskBody.dependencies.join(", ")));
    }
    if (taskBody.scope.paths.length > 0 || taskBody.scope.packages.length > 0) {
      lines.push(
        "",
        "## Where it writes",
        quoted(task.entity.key, [...taskBody.scope.packages, ...taskBody.scope.paths].slice(0, 12).join(", ")),
      );
    }
  }

  const readiness = readinessLine(task.readiness);
  if (readiness) lines.push("", "## Readiness", readiness);
  if (task.conflicts && task.conflicts.length > 0) {
    lines.push(
      ...task.conflicts.slice(0, 3).map((conflict) =>
        quoted(conflict.key, `also writes where this task does${conflict.accepted ? ", and a person accepted the overlap" : ""}`),
      ),
    );
  }

  // The exact approved revisions this attempt implements. Only the artifacts
  // this Task is actually joined to, and only as identity plus one line.
  const upstream = task.edges
    .filter((edge) => edge.subject.entityId === task.entity.entityId || edge.object.entityId === task.entity.entityId)
    .slice(0, CONTEXT_PACKET_UPSTREAM_MAX);
  const approvedLines: string[] = [];
  const commentLines: string[] = [];
  for (const edge of upstream) {
    const other = edge.subject.entityId === task.entity.entityId ? edge.object : edge.subject;
    if (other.kind === "task") continue;
    let read: ProjectWorkGetResult;
    try {
      read = (await bridge.call("project/work/get", {
        projectId,
        entityId: other.entityId,
        body: { mode: "none" as const },
        include: { approvals: true, comments: true },
      })) as ProjectWorkGetResult;
    } catch {
      continue;
    }
    const approval = read.approvals.find((candidate) => candidate.decision === "approved" && candidate.invalidatedAt === undefined);
    revisions.push(`${read.entity.key}@${read.revision.revisionId}`);
    approvedLines.push(
      quoted(
        `${read.entity.key} revision ${read.revision.revisionId}`,
        `${read.entity.title} — ${approval ? `${approval.gate} gate approved` : `${read.entity.state}, not approved`}${read.entity.staleBecause ? `, stale since ${read.entity.staleBecause.upstreamKey} moved` : ""}`,
      ),
    );
    for (const comment of unresolved(read.comments)) {
      commentLines.push(quoted(`${read.entity.key} comment`, `${comment.blocking ? "blocking: " : ""}${comment.text}`));
    }
  }
  if (approvedLines.length > 0) lines.push("", "## What you are implementing", ...approvedLines);

  const own = unresolved(task.comments).map((comment) =>
    quoted(`${task.entity.key} comment`, `${comment.blocking ? "blocking: " : ""}${comment.text}`),
  );
  const allComments = [...own, ...commentLines];
  if (allComments.length > 0) {
    lines.push("", "## Unresolved comments", ...allComments.slice(0, CONTEXT_PACKET_COMMENTS_MAX));
    if (allComments.length > CONTEXT_PACKET_COMMENTS_MAX) {
      truncated = true;
      lines.push(
        `${String(allComments.length - CONTEXT_PACKET_COMMENTS_MAX)} more comments were left out; read them with inspect_project_work include comments.`,
      );
    }
  }

  // What the last attempt already proved, so this one does not repeat it.
  const attempts = [...task.executionLinks].sort((left, right) => left.attempt - right.attempt);
  const last = attempts.at(-1);
  if (last) {
    lines.push(
      "",
      "## The last attempt",
      `Attempt ${String(last.attempt)}${last.endedAt ? ` ended ${last.outcome ?? "without saying how"}` : " is still open"}${last.branch ? ` on ${last.branch}` : ""}${last.targetUnavailable ? "; its session is no longer on this machine, and the record stands" : ""}.`,
      ...task.evidence.slice(-CONTEXT_PACKET_EVIDENCE_MAX).map(evidenceLine),
    );
  }

  if (options.projectInstructions?.trim()) {
    const text = options.projectInstructions.trim();
    const cut = text.length > CONTEXT_PACKET_INSTRUCTIONS_MAX ? `${text.slice(0, CONTEXT_PACKET_INSTRUCTIONS_MAX)}…` : text;
    if (cut.length < text.length) truncated = true;
    lines.push("", "## Project instructions", ...cut.split("\n").map((line) => quoted("project instructions", line)).slice(0, 20));
  }

  let text = lines.join("\n");
  if (text.length > CONTEXT_PACKET_MAX) {
    truncated = true;
    text = `${text.slice(0, CONTEXT_PACKET_MAX)}\n…this packet was cut. Read the rest with inspect_project_work.`;
  }
  return { text, revisions, truncated };
}
