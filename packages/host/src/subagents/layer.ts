/**
 * The pi-subagents file layer (M3-T2, M3-T3, M3-T4, M3-T7).
 *
 * It lives in the host, not in the companion extension, because a session
 * started from a terminal has no worker and no extension — and those are
 * exactly the runs a person most wants to see from their phone. It parses JSON
 * and reads directories; it imports nothing from Pi or pi-subagents
 * (AGENTS.md invariant 1) and speaks only the panel contract.
 *
 * ## Why polling
 *
 * `fs.watch` on Linux fires twice for one write and misses files created in
 * directories that did not exist when the watch was set up, and pi-subagents
 * creates `control/`, `events.jsonl` and whole run directories mid-flight. The
 * status file is written atomically and is at most 100 ms stale by its own
 * contract, so a 1 s stat-and-compare poll is both simpler and no less live —
 * and it costs one `stat` per run directory, not one parse.
 *
 * ## What it emits
 *
 * Per background run: a `plan` when the run has structure, one `run` per
 * child, a `collection` when acceptance or the watchdog has something to
 * answer for. Per foreground child: one read-only `run`. Per session: one
 * `collection` of its missions. Ids come from `panels.ts` and are derived only
 * from pi-subagents' own identities, so the same child seen through the
 * in-process bus and through these files lands on one id and one panel (R9).
 *
 * ## What it never does
 *
 * It never writes a Pi session file, never kills a process, and never treats a
 * parse failure as "finished": a run whose status it cannot read stays as it
 * was, because reaping a live run is far worse than a stale card.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorCodes, PRODUCT_NAME, ProtocolError, type Panel, type PiExtensionMessage } from "@lasercode/protocol";
import { ControlError, requestInterrupt, requestSteer, requestStop, steeringClosed } from "./control.js";
import { asyncRunsDir, isRunnerAlive, subagentsTempRoots } from "./file-layer.js";
import {
  PANEL_ID_PREFIX,
  checkPanelId,
  foregroundPanelId,
  foregroundRunPanel,
  isSubagentsPanelId,
  panelsForStatus,
  resumeDecision,
  steerDecision,
  type Capabilities,
} from "./panels.js";
import {
  missionCollectionId,
  missionDocument,
  missionsCollection,
  missionsDirOf,
  readMissions,
  type Mission,
} from "./missions.js";
import { artifactSibling, parseForegroundMeta, parseStatus, parseTranscriptName, type AsyncStatus } from "./status.js";

/** Where panels go. The host's `PanelHub` satisfies this; tests pass a spy. */
export interface PanelSink {
  upsert(cwd: string, path: string, panel: Panel): void;
  close(path: string, id: string, reason?: string): void;
}

/** The sessions the host knows about, so runs and children can be attributed. */
export interface SessionRef {
  path: string;
  cwd: string;
  /** ISO. Used only to pick the parent of a foreground child in a shared directory. */
  modifiedAt?: string;
}

export interface SubagentsLayerOptions {
  sink: PanelSink;
  sessions(): readonly SessionRef[];
  /** Temp roots to scan. Defaults to `PI_SUBAGENTS_TEMP_ROOT` plus the uid-scoped default. */
  roots?: readonly string[];
  agentDir?: string;
  /** Poll period. 1 s matches pi-subagents' own ≤100 ms status staleness closely enough. */
  intervalMs?: number;
  /** Every Nth tick also re-reads the missions ledger, which changes far more slowly. */
  missionEvery?: number;
  now?: () => number;
  /**
   * Ask the worker that owns `path` to hand a command to the companion
   * extension. Resume is only reachable through the owning Pi session's bus,
   * so it is the one action this layer cannot perform itself.
   */
  forward?(path: string, command: { id: string; actionId: string; value?: string }): Promise<boolean>;
}

/** A run finished this long ago still shows; older ones leave, saying why (R7). */
export const RECENT_MS = 60 * 60_000;
/** Most runs one session shows at once. Newest first; the rest are history, not a dock. */
export const MAX_RUNS_PER_SESSION = 40;
/** A foreground transcript untouched for this long, with no `_meta.json`, is not live. */
export const FOREGROUND_STALE_MS = 120_000;
/** Bound on one directory listing, so a stale temp root cannot stall a tick. */
const MAX_DIR_ENTRIES = 500;

/** Everything needed to steer or stop one panel's run. */
interface ControlTarget {
  path: string;
  cwd: string;
  asyncDir: string;
  runId: string;
  title: string;
  /** Which child, for a multi-step run. */
  targetIndex?: number;
  childId?: string;
}

interface RunRecord {
  /** `${mtimeMs}:${size}` of status.json — the cheap "did anything change" key. */
  stamp: string;
  path: string;
  cwd: string;
  panelIds: string[];
  /**
   * Epoch ms after which a finished run stops being shown. Undefined while it
   * is still going. A finished run's status file never changes again, so
   * without this the stamp shortcut below would keep it on screen for ever.
   */
  showUntil?: number;
}

export class SubagentsLayer {
  private readonly sink: PanelSink;
  private readonly options: SubagentsLayerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tick = 0;

  /** runDir → what we last emitted for it. */
  private readonly runs = new Map<string, RunRecord>();
  /** transcript path → what we last emitted for it. */
  private readonly foreground = new Map<string, { stamp: string; path: string; cwd: string; panelId: string }>();
  /** panel id → how to control it. */
  private readonly targets = new Map<string, ControlTarget>();
  /** session path → missions owned by it, for the `open` row action. */
  private missionsById = new Map<string, Mission>();
  private missionStamp = "";
  /** session path → a live companion extension has announced the subagents bus. */
  private readonly liveBus = new Map<string, number>();
  /** Panels a live extension declared, so an id it also owns is corrected, not duplicated. */
  private readonly claimed = new Set<string>();

  constructor(options: SubagentsLayerOptions) {
    this.options = options;
    this.sink = options.sink;
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.options.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------- scanning

  /** One pass. Never throws: it runs on a timer and a broken temp root is normal. */
  refresh(): void {
    this.tick += 1;
    try {
      this.scanBackgroundRuns();
    } catch {
      /* a root vanished mid-scan; the next tick sees the new shape */
    }
    try {
      this.scanForeground();
    } catch {
      /* same */
    }
    if (this.tick % (this.options.missionEvery ?? 10) === 1) {
      try {
        this.scanMissions();
      } catch {
        /* the ledger is advisory; a bad read must not stop the runs */
      }
    }
  }

  private sessionsByPath(): Map<string, SessionRef> {
    return new Map(this.options.sessions().map((session) => [session.path, session]));
  }

  private scanBackgroundRuns(): void {
    const sessions = this.sessionsByPath();
    const seen = new Set<string>();
    const perSession = new Map<string, number>();
    const roots = this.options.roots ?? subagentsTempRoots();
    const now = this.now();

    for (const root of roots) {
      const runsDir = asyncRunsDir(root);
      for (const runId of listDirs(runsDir)) {
        const dir = join(runsDir, runId);
        const stamp = stampOf(join(dir, "status.json"));
        if (!stamp) continue;
        seen.add(dir);
        const previous = this.runs.get(dir);
        if (previous && previous.stamp === stamp) {
          // Unchanged, so nothing is parsed. A finished run still ages out:
          // its file will never change again, so the clock is the only thing
          // that can retire it (R7 — it leaves saying why).
          if (previous.showUntil !== undefined && now > previous.showUntil) {
            this.retire(dir, "it finished a while ago");
            continue;
          }
          perSession.set(previous.path, (perSession.get(previous.path) ?? 0) + 1);
          continue;
        }
        const status = readStatus(dir, runId);
        if (!status) continue;
        const path = status.sessionId;
        const session = path ? sessions.get(path) : undefined;
        if (!path || !session) continue;
        if (!this.interesting(status, now)) {
          this.retire(dir, "it finished a while ago");
          continue;
        }
        const used = perSession.get(path) ?? 0;
        if (used >= MAX_RUNS_PER_SESSION) continue;
        perSession.set(path, used + 1);
        this.emitRun(status, session, stamp, now);
      }
    }

    for (const dir of [...this.runs.keys()]) {
      if (seen.has(dir)) continue;
      this.retire(dir, "pruned by pi-subagents retention");
    }
  }

  /** Active, or finished recently enough to still be worth a dot. */
  private interesting(status: AsyncStatus, now: number): boolean {
    if (status.state === "running" || status.state === "queued" || status.state === "paused") return true;
    const ended = status.endedAt ?? status.lastUpdate ?? status.startedAt ?? 0;
    return now - ended <= RECENT_MS;
  }

  private capabilitiesFor(status: AsyncStatus, path: string): Capabilities {
    return {
      runnerAlive: isRunnerAlive(status.pid),
      steerClosed: steeringClosed(status.dir),
      busReachable: this.liveBus.has(path) && this.options.forward !== undefined,
    };
  }

  private emitRun(status: AsyncStatus, session: SessionRef, stamp: string, now: number): void {
    const caps = this.capabilitiesFor(status, session.path);
    const panels = panelsForStatus(status, { caps, bytesOf: sizeOf });
    const previous = this.runs.get(status.dir);
    const ids = panels.map((panel) => panel.id);

    // A run that changed hands (its status file now names a different session)
    // must not leave a copy behind: one run, one panel, one place (R6).
    if (previous && previous.path !== session.path) {
      for (const id of previous.panelIds) this.sink.close(previous.path, id, "it belongs to another session");
    }

    for (const panel of panels) this.sink.upsert(session.cwd, session.path, panel);
    // A panel this run used to have and no longer does (a step that vanished
    // from the status file) leaves rather than lingering.
    for (const id of previous?.panelIds ?? []) {
      if (!ids.includes(id)) this.sink.close(session.path, id, "it is no longer in the run");
    }

    const live = status.state === "running" || status.state === "queued" || status.state === "paused";
    this.runs.set(status.dir, {
      stamp,
      path: session.path,
      cwd: session.cwd,
      panelIds: ids,
      ...(live ? {} : { showUntil: (status.endedAt ?? status.lastUpdate ?? now) + RECENT_MS }),
    });
    this.rememberTargets(status, session, panels);
  }

  /** Which control file each panel's actions write to. */
  private rememberTargets(status: AsyncStatus, session: SessionRef, panels: readonly Panel[]): void {
    for (const panel of panels) {
      if (panel.kind !== "run") continue;
      const index = status.steps.findIndex((step, i) => panel.id.endsWith(`:${step.childId ?? step.workflowKey ?? String(i)}`));
      this.targets.set(panel.id, {
        path: session.path,
        cwd: session.cwd,
        asyncDir: status.dir,
        runId: status.runId,
        title: panel.title,
        ...(status.steps.length > 1 && index >= 0 ? { targetIndex: index } : {}),
        ...(index >= 0 && status.steps[index]?.childId !== undefined ? { childId: status.steps[index]!.childId! } : {}),
      });
    }
  }

  private retire(dir: string, reason: string): void {
    const record = this.runs.get(dir);
    if (!record) return;
    for (const id of record.panelIds) {
      this.sink.close(record.path, id, reason);
      this.targets.delete(id);
    }
    this.runs.delete(dir);
  }

  // ---------------------------------------------------------- foreground

  /**
   * Foreground children (M3-T3). They write no status file and appear in no
   * index, so the transcript itself is the discovery mechanism: pi-subagents
   * opens `<runId>_<agent>[_<n>]_transcript.jsonl` with the first token and
   * drops `..._meta.json` beside it when the child finishes.
   *
   * Attribution is by directory: `subagent-artifacts` is shared by every
   * session of one project, and nothing in the file names says which session
   * spawned the child. The parent is taken to be the most recently modified
   * session in that directory, which is the session that is writing while the
   * child runs. Controls are hidden throughout — there is nothing to press
   * (D-19 §6, R2).
   */
  private scanForeground(): void {
    const now = this.now();
    const byDir = new Map<string, SessionRef>();
    for (const session of this.options.sessions()) {
      const dir = join(dirname(session.path), "subagent-artifacts");
      const current = byDir.get(dir);
      if (!current || (session.modifiedAt ?? "") > (current.modifiedAt ?? "")) byDir.set(dir, session);
    }

    const seen = new Set<string>();
    for (const [dir, session] of byDir) {
      for (const file of listFiles(dir)) {
        if (!file.endsWith("_transcript.jsonl")) continue;
        const named = parseTranscriptName(file);
        if (!named) continue;
        const transcript = join(dir, file);
        const stamp = stampOf(transcript);
        if (!stamp) continue;
        const mtime = mtimeOf(transcript) ?? 0;
        const metaPath = artifactSibling(transcript, "meta.json");
        const meta = readJson(metaPath);
        const finished = meta !== undefined;
        const live = !finished && now - mtime < FOREGROUND_STALE_MS;
        // Only live children and recent finishers earn a panel; the rest are
        // the project's history, not its dock.
        if (!live && now - mtime > RECENT_MS) {
          this.retireForeground(transcript, "it finished a while ago");
          continue;
        }
        seen.add(transcript);
        const previous = this.foreground.get(transcript);
        if (previous && previous.stamp === stamp && previous.path === session.path) continue;
        const panel = foregroundRunPanel(
          {
            runId: named.runId,
            agent: named.agent,
            ...(named.index !== undefined ? { index: named.index } : {}),
            transcriptPath: transcript,
            artifactsDir: dir,
            cwd: session.cwd,
            ...(birthOf(transcript) !== undefined ? { startedAt: birthOf(transcript)! } : {}),
            live,
            ...(meta !== undefined ? { meta: parseForegroundMeta(meta) ?? {} } : {}),
          },
          { bytesOf: sizeOf },
        );
        this.sink.upsert(session.cwd, session.path, panel);
        this.foreground.set(transcript, { stamp, path: session.path, cwd: session.cwd, panelId: panel.id });
      }
    }

    for (const transcript of [...this.foreground.keys()]) {
      if (seen.has(transcript)) continue;
      this.retireForeground(transcript, "its artifacts were cleaned up");
    }
  }

  private retireForeground(transcript: string, reason: string): void {
    const record = this.foreground.get(transcript);
    if (!record) return;
    this.sink.close(record.path, record.panelId, reason);
    this.foreground.delete(transcript);
  }

  // ------------------------------------------------------------- missions

  private scanMissions(): void {
    const missionsDir = missionsDirOf(this.options.agentDir);
    const missions = readMissions(missionsDir);
    const stamp = missions.map((m) => `${m.id}:${m.updatedAt ?? ""}`).join("|");
    if (stamp === this.missionStamp) return;
    this.missionStamp = stamp;
    this.missionsById = new Map(missions.map((mission) => [mission.id, mission]));

    const sessions = this.sessionsByPath();
    const byOwner = new Map<string, Mission[]>();
    for (const mission of missions) {
      const owner = mission.ownerSessionId;
      if (!owner || !sessions.has(owner)) continue;
      const list = byOwner.get(owner) ?? [];
      list.push(mission);
      byOwner.set(owner, list);
    }
    for (const [owner, list] of byOwner) {
      const session = sessions.get(owner);
      const collection = missionsCollection(list);
      if (!session || !collection) continue;
      this.sink.upsert(session.cwd, session.path, collection);
    }
  }

  // -------------------------------------------------------------- actions

  /** Every panel this layer owns. The router asks before routing to a worker. */
  handles(id: string): boolean {
    return isSubagentsPanelId(id);
  }

  /**
   * A person pressed something. Steering opens a question rather than sending
   * an empty message, because `Action` carries no input field by design.
   */
  async act(params: { path: string; id: string; actionId: string; value?: string }): Promise<{ delivered: boolean }> {
    const { path, id, actionId } = params;
    if (!this.handles(id)) return { delivered: false };

    if (id === missionCollectionId) return this.openMission(path, actionId, params.value);
    if (id.startsWith(`${PANEL_ID_PREFIX}steer:`)) return this.answerMessage("steer", path, id, actionId, params.value);
    if (id.startsWith(`${PANEL_ID_PREFIX}resume:`)) return this.answerMessage("resume", path, id, actionId, params.value);

    const target = this.targets.get(id);
    if (!target) return { delivered: false };

    try {
      switch (actionId) {
        case "steer": {
          this.sink.upsert(target.cwd, target.path, steerDecision(id, target.title));
          return { delivered: true };
        }
        case "stop": {
          requestStop({
            asyncDir: target.asyncDir,
            ...(target.targetIndex !== undefined ? { targetIndex: target.targetIndex } : {}),
            ...(target.childId !== undefined ? { childId: target.childId } : {}),
          });
          return { delivered: true };
        }
        case "interrupt": {
          requestInterrupt({ asyncDir: target.asyncDir, reason: `you interrupted it from ${PRODUCT_NAME}` });
          return { delivered: true };
        }
        case "resume": {
          if (!this.options.forward) return { delivered: false };
          this.sink.upsert(target.cwd, target.path, resumeDecision(id, target.title));
          return { delivered: true };
        }
        default:
          return { delivered: false };
      }
    } catch (error) {
      throw asProtocolError(error);
    }
  }

  private openMission(path: string, actionId: string, value: string | undefined): { delivered: boolean } {
    if (actionId !== "open" || value === undefined) return { delivered: false };
    const mission = this.missionsById.get(value);
    if (!mission) return { delivered: false };
    const session = this.sessionsByPath().get(path);
    if (!session) return { delivered: false };
    this.sink.upsert(session.cwd, path, missionDocument(mission));
    return { delivered: true };
  }

  /**
   * The answer to a steer or resume question: perform it, then take the
   * question away. Steering is a file the runner reads; resume is the one
   * control that has to go back through the owning session's bus.
   */
  private async answerMessage(
    kind: "steer" | "resume",
    path: string,
    id: string,
    actionId: string,
    value: string | undefined,
  ): Promise<{ delivered: boolean }> {
    const parentId = id.slice(`${PANEL_ID_PREFIX}${kind}:`.length);
    if (actionId === "cancel") {
      this.sink.close(path, id, "you left it alone");
      return { delivered: true };
    }
    if (actionId !== "answer") return { delivered: false };
    const target = this.targets.get(parentId);
    if (!target) return { delivered: false };
    const message = fieldOf(value, "message");
    if (!message) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `A ${kind} needs something to say.`);
    }
    if (kind === "resume") {
      if (!this.options.forward) return { delivered: false };
      const delivered = await this.options.forward(target.path, { id: parentId, actionId: "resume", value: message });
      if (delivered) this.sink.close(path, id, "sent");
      return { delivered };
    }
    try {
      requestSteer({
        asyncDir: target.asyncDir,
        message,
        ...(target.targetIndex !== undefined ? { targetIndex: target.targetIndex } : {}),
      });
    } catch (error) {
      throw asProtocolError(error);
    }
    this.sink.close(path, id, "sent");
    return { delivered: true };
  }

  // ------------------------------------------------- the in-process module

  /**
   * One message from a session's companion extension. Two of them matter here:
   * the `subagents` module's capability announcement, which is what makes
   * Resume appear at all, and any panel it declared whose id this layer also
   * owns (R9 — one id, one panel).
   */
  observeExtensionMessage(path: string, message: PiExtensionMessage): void {
    if (message.type === "lasercode/panel/upsert") {
      this.observeDeclaredPanel(path, message.panel.id);
      return;
    }
    if (message.type !== "lasercode/subagents/event") return;
    const event = message.event as { type?: unknown; reachable?: unknown; methods?: unknown } | null;
    if (!event || event.type !== "bus") return;
    if (event.reachable !== true) {
      this.busLost(path);
      return;
    }
    const methods = Array.isArray(event.methods) ? event.methods.filter((m): m is string => typeof m === "string") : [];
    this.busAnnounced(path, methods);
  }

  /**
   * The companion extension's `subagents` module reports what it can reach
   * (R11: probe capabilities, never versions). Resume appears only while a
   * module has said the bus is there.
   */
  busAnnounced(path: string, methods: readonly string[]): void {
    if (methods.includes("resume")) this.liveBus.set(path, this.now());
    else this.liveBus.delete(path);
  }

  busLost(path: string): void {
    this.liveBus.delete(path);
  }

  /**
   * A panel the in-process module declared. When this layer owns the same id —
   * which is the point of deriving ids from pi-subagents' identities — its own,
   * richer version is re-sent immediately, so the two paths converge on one
   * panel instead of taking turns (R6, R9).
   */
  observeDeclaredPanel(path: string, panelId: string): void {
    if (!this.handles(panelId)) return;
    this.claimed.add(panelId);
    for (const [dir, record] of this.runs) {
      if (record.path !== path || !record.panelIds.includes(panelId)) continue;
      const status = readStatus(dir, dir.slice(dir.lastIndexOf("/") + 1));
      const session = this.sessionsByPath().get(path);
      const stamp = stampOf(join(dir, "status.json"));
      if (status && session && stamp) this.emitRun(status, session, stamp, this.now());
      return;
    }
  }

  /** Ids the in-process module has declared at least once. Exposed for tests. */
  get declared(): ReadonlySet<string> {
    return this.claimed;
  }

  /** Everything currently on show for one session, for `laser runs`. */
  panelIdsFor(path: string): string[] {
    const ids: string[] = [];
    for (const record of this.runs.values()) if (record.path === path) ids.push(...record.panelIds);
    for (const record of this.foreground.values()) if (record.path === path) ids.push(record.panelId);
    return ids;
  }

  /** A session's worker went away: its runs keep going, but resume does not. */
  sessionClosed(path: string): void {
    this.busLost(path);
  }
}

// ---------------------------------------------------------------------------
// Small filesystem helpers. Each one answers "undefined" rather than throwing:
// every caller is on a timer.
// ---------------------------------------------------------------------------

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .slice(0, MAX_DIR_ENTRIES)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .slice(0, MAX_DIR_ENTRIES)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function stampOf(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function sizeOf(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function birthOf(file: string): number | undefined {
  try {
    const stat = statSync(file);
    const birth = stat.birthtimeMs;
    return birth > 0 ? birth : stat.mtimeMs;
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readStatus(dir: string, runId: string): AsyncStatus | undefined {
  const raw = readJson(join(dir, "status.json"));
  return raw === undefined ? undefined : parseStatus(raw, dir, runId);
}

/** One field out of a decision answer, which travels as a JSON object string. */
function fieldOf(value: string | undefined, field: string): string {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

function asProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (error instanceof ControlError) return new ProtocolError(ErrorCodes.InvalidParams, error.message);
  return new ProtocolError(
    ErrorCodes.Internal,
    `${PRODUCT_NAME} could not reach that run's control inbox. Its temp directory may have been cleaned up.`,
  );
}
