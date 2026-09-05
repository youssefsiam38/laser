/**
 * The missions ledger (M3-T7): `~/.pi/agent/missions`.
 *
 * A mission is the durable record — it outlives the runs it joins, the session
 * that started it, and several compactions. pi-subagents keeps two copies: a
 * flat `index/<sha>.json` for listing, and the record itself under
 * `projects/<sha(projectRoot)>/<missionId>.json`. The index is a cache of the
 * record's head, so the record wins wherever they disagree.
 *
 * Verified against the user's own 65 missions (2026-09-05). Two things about
 * the real data shape the rendering:
 *
 *   - `title` and `objective` are frequently the literal string
 *     "[prompt redacted]", because the user's Pi redacts prompts before they
 *     reach the ledger. A title that says nothing is worse than no title, so
 *     the summary's first line is used instead and the redaction is stated.
 *   - `runs[].asyncDir` is the join key back to a background run, and it is an
 *     absolute path into a temp root that may have been reaped. A missing
 *     directory is normal, not an error.
 *
 * The whole ledger renders as one `collection` per owning session (rows scale;
 * 65 document islands would not), and one `document` per mission on demand.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectionItem, CollectionPanel, DocumentPanel } from "@piorbit/protocol";
import { PANEL_ID_PREFIX, PANEL_SOURCE } from "./panels.js";

export const REDACTED = "[prompt redacted]";

export interface MissionRun {
  runId: string;
  mode?: string;
  asyncDir?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  tokens?: number;
}

export interface MissionDecision {
  id?: string;
  question?: string;
  answer?: string;
  resolvedAt?: string;
}

export interface MissionArtifact {
  kind?: string;
  path: string;
  description?: string;
}

export interface Mission {
  id: string;
  recordPath: string;
  title?: string;
  objective?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  cwd?: string;
  projectRoot?: string;
  /** Session file path of the session that created it — piorbit's session `path`. */
  ownerSessionId?: string;
  summary?: string;
  runs: MissionRun[];
  decisions: MissionDecision[];
  artifacts: MissionArtifact[];
  workflowChildren: Array<{ childId?: string; agent?: string; state?: string }>;
}

export function missionsDirOf(agentDir: string = join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "missions");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const put = <T>(value: T | undefined, key: string): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

/** Bound on one scan of the ledger, so a huge history cannot stall the host. */
const MAX_MISSIONS = 500;

export function parseMission(raw: unknown, recordPath: string): Mission | undefined {
  const o = rec(raw);
  const id = o ? str(o.id) : undefined;
  const status = o ? str(o.status) : undefined;
  if (!o || !id) return undefined;
  return {
    id,
    recordPath,
    status: status ?? "unknown",
    ...put(str(o.title), "title"),
    ...put(str(o.objective), "objective"),
    ...put(str(o.createdAt), "createdAt"),
    ...put(str(o.updatedAt), "updatedAt"),
    ...put(str(o.cwd), "cwd"),
    ...put(str(o.projectRoot), "projectRoot"),
    ...put(str(o.ownerSessionId), "ownerSessionId"),
    ...put(str(o.summary), "summary"),
    runs: arr(o.runs)
      .slice(0, 64)
      .map((entry): MissionRun | undefined => {
        const r = rec(entry);
        const runId = r ? str(r.runId) : undefined;
        if (!r || !runId) return undefined;
        const usage = rec(r.usage);
        return {
          runId,
          ...put(str(r.mode), "mode"),
          ...put(str(r.asyncDir), "asyncDir"),
          ...put(str(r.status), "status"),
          ...put(str(r.startedAt), "startedAt"),
          ...put(str(r.completedAt), "completedAt"),
          ...put(usage ? num(usage.tokens) : undefined, "tokens"),
        };
      })
      .filter((r): r is MissionRun => r !== undefined),
    decisions: arr(o.decisions)
      .slice(0, 64)
      .map((entry): MissionDecision | undefined => {
        const d = rec(entry);
        if (!d) return undefined;
        return {
          ...put(str(d.id), "id"),
          ...put(str(d.question), "question"),
          ...put(str(d.answer), "answer"),
          ...put(str(d.resolvedAt), "resolvedAt"),
        };
      })
      .filter((d): d is MissionDecision => d !== undefined),
    artifacts: arr(o.artifacts)
      .slice(0, 64)
      .map((entry): MissionArtifact | undefined => {
        const a = rec(entry);
        const path = a ? str(a.path) : undefined;
        if (!a || !path) return undefined;
        return { path, ...put(str(a.kind), "kind"), ...put(str(a.description), "description") };
      })
      .filter((a): a is MissionArtifact => a !== undefined),
    workflowChildren: arr(o.workflowChildren)
      .slice(0, 64)
      .map((entry) => {
        const c = rec(entry);
        if (!c) return undefined;
        return { ...put(str(c.childId), "childId"), ...put(str(c.agent), "agent"), ...put(str(c.state), "state") };
      })
      .filter((c): c is { childId?: string; agent?: string; state?: string } => c !== undefined),
  };
}

/**
 * Every mission on disk, newest first. Reads the records, not the index: the
 * index is a head cache and the record carries the runs, decisions and
 * artifacts everything below needs. Failure-tolerant by design — this runs on
 * a timer and must never throw.
 */
export function readMissions(missionsDir = missionsDirOf()): Mission[] {
  const out: Mission[] = [];
  let projects: string[];
  try {
    projects = readdirSync(join(missionsDir, "projects"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return out;
  }
  for (const project of projects) {
    let files: string[];
    try {
      files = readdirSync(join(missionsDir, "projects", project)).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (out.length >= MAX_MISSIONS) break;
      const recordPath = join(missionsDir, "projects", project, file);
      try {
        const mission = parseMission(JSON.parse(readFileSync(recordPath, "utf8")), recordPath);
        if (mission) out.push(mission);
      } catch {
        // A record being written, or a foreign file. Skip it; the next scan
        // picks it up. Never let one bad file hide the other 64.
      }
    }
  }
  return out.sort((a, b) => (a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * A title worth reading. The ledger's own title is used when there is one, but
 * on this machine most of them are the literal `[prompt redacted]`, so the
 * fallback matters: the objective, then the first real sentence of the summary,
 * then the id. A machine-shaped opener ("Workflow completed with 3 child
 * run(s). Return: [") is cut at its sentence end rather than mid-bracket.
 */
export function missionTitle(mission: Mission): string {
  const declared = mission.title?.trim();
  if (declared && declared !== REDACTED) return sentence(declared);
  const objective = mission.objective?.trim();
  if (objective && objective !== REDACTED) return sentence(objective);
  const firstLine = mission.summary
    ?.split("\n")
    .map((l) => l.trim().replace(/^#+\s*/, "").replace(/^[-*+]\s+/, "").replace(/^\*{1,2}|\*{1,2}$/g, "").trim())
    .find((l) => l.length > 8 && !l.endsWith(":"));
  if (firstLine) return sentence(firstLine);
  return `Mission ${mission.id.slice(0, 8)}`;
}

const MAX_TITLE = 96;

/** One sentence, or one clause, never a fragment ending in an open bracket. */
function sentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.search(/[.!?](\s|$)/);
  const cut = stop >= 20 && stop < MAX_TITLE ? flat.slice(0, stop) : flat;
  if (cut.length <= MAX_TITLE) return cut;
  const space = cut.lastIndexOf(" ", MAX_TITLE);
  return `${cut.slice(0, space > 40 ? space : MAX_TITLE).trimEnd()}…`;
}

const MISSION_STATUS_WORDS: Record<string, string> = {
  completed: "completed",
  active: "active",
  open: "open",
  failed: "failed",
  closed: "closed",
};

export const missionCollectionId = `${PANEL_ID_PREFIX}missions`;
export const missionDocumentId = (missionId: string): string => `${PANEL_ID_PREFIX}mission:${missionId}`;

/** The ledger for one session, as rows. Opening a row asks the host for its document. */
export function missionsCollection(missions: readonly Mission[]): CollectionPanel | undefined {
  if (missions.length === 0) return undefined;
  const items: CollectionItem[] = missions.slice(0, 200).map((mission) => ({
    id: mission.id,
    primary: missionTitle(mission),
    ...(mission.updatedAt ? { secondary: `updated ${mission.updatedAt.slice(0, 16).replace("T", " ")}` } : {}),
    meta: [
      { label: "status", value: MISSION_STATUS_WORDS[mission.status] ?? mission.status },
      { label: "runs", value: String(mission.runs.length) },
      ...(mission.decisions.length > 0 ? [{ label: "decisions", value: String(mission.decisions.length) }] : []),
    ],
    actions: [{ id: "open", label: "Open the ledger" }],
  }));
  return {
    kind: "collection",
    id: missionCollectionId,
    source: PANEL_SOURCE,
    intent: "follow",
    title: `Missions · ${missions.length}`,
    layout: "table",
    items,
    total: missions.length,
  };
}

/** One mission as something you read. Markdown, because the ledger is prose plus tables. */
export function missionDocument(mission: Mission): DocumentPanel {
  return {
    kind: "document",
    id: missionDocumentId(mission.id),
    source: PANEL_SOURCE,
    intent: "follow",
    title: missionTitle(mission),
    mediaType: "text/markdown",
    renderable: true,
    content: { inline: renderMission(mission) },
    path: mission.recordPath,
  };
}

const MAX_SUMMARY = 16_000;

/**
 * The ledger as markdown. Deliberately plain: headings, one table for the runs
 * and one for the decisions, then the summary verbatim. No HTML ever reaches
 * the renderer (invariant 9); the markdown renderer escapes what it is given.
 */
export function renderMission(mission: Mission): string {
  const lines: string[] = [];
  lines.push(`# ${missionTitle(mission)}`, "");
  const facts: string[] = [`**Status** ${mission.status}`];
  if (mission.createdAt) facts.push(`**Created** ${mission.createdAt.slice(0, 16).replace("T", " ")}`);
  if (mission.updatedAt) facts.push(`**Updated** ${mission.updatedAt.slice(0, 16).replace("T", " ")}`);
  if (mission.cwd) facts.push(`**Project** \`${mission.cwd}\``);
  lines.push(facts.join(" · "), "");

  if (mission.objective && mission.objective !== REDACTED) {
    lines.push("## Objective", "", mission.objective.trim(), "");
  } else if (mission.objective === REDACTED || mission.title === REDACTED) {
    lines.push("_The objective was redacted before it reached the ledger, so only the outcome is on record._", "");
  }

  if (mission.runs.length > 0) {
    lines.push("## Runs", "", "| run | mode | status | tokens | finished |", "| --- | --- | --- | --- | --- |");
    for (const run of mission.runs) {
      lines.push(
        `| \`${run.runId.slice(0, 8)}\` | ${run.mode ?? "—"} | ${run.status ?? "—"} | ${run.tokens?.toLocaleString("en-US") ?? "not measured"} | ${run.completedAt?.slice(0, 16).replace("T", " ") ?? "—"} |`,
      );
    }
    lines.push("");
  }

  if (mission.workflowChildren.length > 0) {
    lines.push("## Workflow children", "");
    for (const child of mission.workflowChildren) {
      lines.push(`- ${child.agent ?? child.childId ?? "child"} — ${child.state ?? "unknown"}`);
    }
    lines.push("");
  }

  if (mission.decisions.length > 0) {
    lines.push("## Decisions", "");
    for (const decision of mission.decisions) {
      const answered = decision.answer ? `**${decision.answer}**` : "_still open_";
      lines.push(`- ${decision.question ?? decision.id ?? "decision"} — ${answered}`);
    }
    lines.push("");
  }

  if (mission.artifacts.length > 0) {
    lines.push("## Artifacts", "");
    for (const artifact of mission.artifacts) {
      lines.push(`- \`${artifact.path}\`${artifact.description ? ` — ${artifact.description}` : ""}`);
    }
    lines.push("");
  }

  if (mission.summary) {
    lines.push("## Summary", "");
    const summary = mission.summary.length > MAX_SUMMARY ? `${mission.summary.slice(0, MAX_SUMMARY)}\n\n_(truncated)_` : mission.summary;
    lines.push(summary.trim(), "");
  }

  return lines.join("\n");
}

/** The runs a mission joins, by `asyncDir` — the key that survives the run itself. */
export function missionRunDirs(missions: readonly Mission[]): Map<string, Mission> {
  const out = new Map<string, Mission>();
  for (const mission of missions) {
    for (const run of mission.runs) {
      if (run.asyncDir) out.set(run.asyncDir, mission);
      out.set(run.runId, mission);
    }
  }
  return out;
}

/** The mission index's own head cache, for a cheap "has anything changed?" check. */
export function missionIndexNames(missionsDir = missionsDirOf()): string[] {
  try {
    return readdirSync(join(missionsDir, "index")).filter((n) => n.endsWith(".json")).map((n) => basename(n));
  } catch {
    return [];
  }
}
