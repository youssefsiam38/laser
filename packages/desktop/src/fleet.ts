/**
 * What the tray and the notifications are looking at.
 *
 * The shell needs its own small model of the fleet because it must be right
 * when no window is open: the tray shows counts, and a notification fires,
 * whether or not anyone has loaded the UI. It is deliberately much less than
 * the UI's store — five fields per session and no transcript — because
 * everything it holds is something the main process has to keep correct across
 * reconnects.
 *
 * Kept separate from the socket so the counting and the transition rules can be
 * tested without a host. Those rules are the whole subtlety here: a
 * notification must fire on the *edge* into "needs you", never on a repeat, and
 * a reconnect that re-lists every session must not fire one per session.
 */
import { ATTENTION_RANK, type ProjectInfo, type SessionAttention, type SessionSummary } from "@piorbit/protocol";

export interface FleetSession {
  path: string;
  cwd: string;
  /** Untrusted: a session name comes from the agent. Never rendered as markup. */
  name: string | undefined;
  attention: SessionAttention;
  modifiedAt: string;
}

export interface FleetProject {
  cwd: string;
  name: string;
  running: number;
  waiting: number;
  sessions: FleetSession[];
}

export interface FleetSnapshot {
  connected: boolean;
  projects: FleetProject[];
  /** Totals across every project, which is what the tray title shows. */
  running: number;
  waiting: number;
}

/** An attention edge worth telling a person about. */
export interface AttentionChange {
  session: FleetSession;
  from: SessionAttention | undefined;
  to: SessionAttention;
  /**
   * True when this is the first time we have seen the session at all — a
   * reconnect, or a session a terminal Pi created while we were not looking.
   * Notifications ignore these: a full re-list is not five new events.
   */
  initial: boolean;
}

const EMPTY_SNAPSHOT: FleetSnapshot = { connected: false, projects: [], running: 0, waiting: 0 };

function projectNameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

export class FleetModel {
  private readonly sessions = new Map<string, FleetSession>();
  private readonly projects = new Map<string, string>();
  private connected = false;

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      // Drop the sessions but keep the project names: on reconnect the counts
      // come back from a fresh list, and a tray that briefly showed stale
      // "2 running" would be lying.
      this.sessions.clear();
    }
  }

  setProjects(projects: readonly ProjectInfo[]): void {
    this.projects.clear();
    for (const project of projects) this.projects.set(project.cwd, project.name || projectNameOf(project.cwd));
  }

  /** Replace everything we know from a full listing. Returns the edges it caused. */
  setSessions(summaries: readonly SessionSummary[]): AttentionChange[] {
    const seen = new Set<string>();
    const changes: AttentionChange[] = [];
    for (const summary of summaries) {
      seen.add(summary.path);
      const change = this.upsert({
        path: summary.path,
        cwd: summary.cwd,
        name: summary.name,
        attention: summary.attention ?? "idle",
        modifiedAt: summary.modifiedAt,
      });
      if (change) changes.push(change);
    }
    for (const path of [...this.sessions.keys()]) {
      if (!seen.has(path)) this.sessions.delete(path);
    }
    return changes;
  }

  /** One `pi/session/attention` notification. */
  applyAttention(event: { path: string; cwd: string; attention: SessionAttention; at: string }): AttentionChange | undefined {
    const known = this.sessions.get(event.path);
    return this.upsert({
      path: event.path,
      cwd: event.cwd,
      name: known?.name,
      attention: event.attention,
      // The notification's `at` is when attention changed, which is a better
      // sort key for "what did I just miss" than a stale catalog mtime.
      modifiedAt: event.at,
    });
  }

  private upsert(next: FleetSession): AttentionChange | undefined {
    const previous = this.sessions.get(next.path);
    // A listing has the name; an attention event does not. Never lose it.
    const merged: FleetSession = { ...next, name: next.name ?? previous?.name };
    this.sessions.set(next.path, merged);
    if (!this.projects.has(merged.cwd)) this.projects.set(merged.cwd, projectNameOf(merged.cwd));
    if (previous && previous.attention === merged.attention) return undefined;
    return {
      session: merged,
      from: previous?.attention,
      to: merged.attention,
      initial: previous === undefined,
    };
  }

  snapshot(): FleetSnapshot {
    if (!this.connected && this.sessions.size === 0) {
      return { ...EMPTY_SNAPSHOT, projects: this.projectShells() };
    }
    const byProject = new Map<string, FleetSession[]>();
    for (const session of this.sessions.values()) {
      const list = byProject.get(session.cwd);
      if (list) list.push(session);
      else byProject.set(session.cwd, [session]);
    }
    for (const cwd of this.projects.keys()) if (!byProject.has(cwd)) byProject.set(cwd, []);

    const projects: FleetProject[] = [];
    let running = 0;
    let waiting = 0;
    for (const [cwd, sessions] of byProject) {
      sessions.sort(compareSessions);
      const projectRunning = sessions.filter((s) => s.attention === "working").length;
      const projectWaiting = sessions.filter((s) => s.attention === "waiting_for_input" || s.attention === "error").length;
      running += projectRunning;
      waiting += projectWaiting;
      projects.push({
        cwd,
        name: this.projects.get(cwd) ?? projectNameOf(cwd),
        running: projectRunning,
        waiting: projectWaiting,
        sessions,
      });
    }
    projects.sort(compareProjects);
    return { connected: this.connected, projects, running, waiting };
  }

  private projectShells(): FleetProject[] {
    return [...this.projects.entries()]
      .map(([cwd, name]) => ({ cwd, name, running: 0, waiting: 0, sessions: [] as FleetSession[] }))
      .sort(compareProjects);
  }
}

/** Most urgent first, then most recently touched. Matches the sessions panel. */
export function compareSessions(a: FleetSession, b: FleetSession): number {
  const rank = ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention];
  if (rank !== 0) return rank;
  if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
  return a.path.localeCompare(b.path);
}

/** Projects that want you first, then busy ones, then alphabetical. */
export function compareProjects(a: FleetProject, b: FleetProject): number {
  if (a.waiting !== b.waiting) return b.waiting - a.waiting;
  if (a.running !== b.running) return b.running - a.running;
  return a.name.localeCompare(b.name);
}

/** The attentions a person should be interrupted for. */
export const NOTIFIABLE: ReadonlySet<SessionAttention> = new Set<SessionAttention>([
  "waiting_for_input",
  "finished_unread",
  "error",
]);

/**
 * Should this edge raise a notification?
 *
 * Only real edges, never the first sighting of a session (a reconnect re-lists
 * everything), and never a move *within* the notifiable set that is just the
 * same news again — finishing while already unread, say.
 */
export function shouldNotify(change: AttentionChange): boolean {
  if (change.initial) return false;
  if (!NOTIFIABLE.has(change.to)) return false;
  if (change.from !== undefined && NOTIFIABLE.has(change.from)) {
    // waiting_for_input is genuinely new information even if the session was
    // already unread: something is now blocked on a person.
    return change.to === "waiting_for_input" && change.from !== "waiting_for_input";
  }
  return true;
}
