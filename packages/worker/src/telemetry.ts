/**
 * Live whole-session telemetry. The fold is the protocol's; this file only
 * feeds it the engine's entries, live context, and child runs this worker
 * already holds.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  TelemetryFold,
  runsBeneathSession,
  sessionTelemetryOf,
  turnEntryIndices,
  type AgentRun,
  type SessionState,
  type SessionTelemetry,
  type TelemetryChildSource,
  type TelemetryContext,
  type TelemetryLiveOverlay,
  type TelemetrySection,
} from "@lasercode/protocol";

const TELEMETRY_UPDATE_KINDS = new Set([
  "message_end",
  "tool_execution_end",
  "compaction_end",
  "agent_settled",
  "state",
  "entry_appended",
]);

const DEFAULT_RESERVE_TOKENS = 16_384;

export function telemetryUpdateKind(kind: string): boolean {
  return TELEMETRY_UPDATE_KINDS.has(kind);
}

export function liveOverlay(
  state: SessionState,
  extras: {
    composition?: TelemetryContext["composition"];
    reserveTokens?: number;
  } = {},
): TelemetryLiveOverlay {
  const usage = state.contextUsage;
  const reserve = extras.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  return {
    ...(usage
      ? {
          context: {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
            ...(extras.composition ? { composition: extras.composition } : {}),
            autoCompact: {
              enabled: state.autoCompactionEnabled,
              thresholdTokens: Math.max(0, usage.contextWindow - reserve),
              state: state.isCompacting ? "compacting" : state.autoCompactionEnabled ? "idle" : "off",
            },
          },
        }
      : {}),
    ...(state.accountUsage ? { account: state.accountUsage } : {}),
    ...(state.model
      ? {
          model: {
            provider: state.model.provider,
            id: state.model.id,
            thinkingLevel: state.thinkingLevel,
            ...(state.model.contextWindow !== undefined ? { contextWindow: state.model.contextWindow } : {}),
          },
        }
      : { model: { thinkingLevel: state.thinkingLevel } }),
  };
}

/**
 * Incremental fold per child session path. A parent with several children
 * must not re-read each finished child's whole JSONL on every tool result.
 */
export class ChildTelemetryCache {
  private readonly folds = new Map<string, TelemetryFold>();

  sources(
    sessionPath: string,
    runs: readonly AgentRun[],
    liveEntries: (path: string) => unknown[] | undefined,
  ): TelemetryChildSource[] {
    const livePaths = new Set(runs.map((run) => run.sessionPath));
    for (const path of this.folds.keys()) {
      if (!livePaths.has(path)) this.folds.delete(path);
    }
    const seen = new Set<string>();
    const children: TelemetryChildSource[] = [];
    for (const run of runsBeneathSession(sessionPath, runs)) {
      if (seen.has(run.sessionPath)) continue;
      seen.add(run.sessionPath);
      const model = run.model ? `${run.model.provider}/${run.model.id}` : undefined;
      const entries = liveEntries(run.sessionPath);
      if (entries) {
        const fold = this.foldOf(run.sessionPath);
        fold.ingest(entries);
        children.push({ ...(model ? { model } : {}), fold: fold.state });
        continue;
      }
      const cached = this.folds.get(run.sessionPath);
      if (cached) {
        children.push({ ...(model ? { model } : {}), fold: cached.state });
        continue;
      }
      const stored = readSessionEntries(run.sessionPath);
      if (!stored) {
        children.push(model ? { model } : {});
        continue;
      }
      const fold = this.foldOf(run.sessionPath);
      fold.ingest(stored);
      children.push({ ...(model ? { model } : {}), fold: fold.state });
    }
    return children;
  }

  private foldOf(path: string): TelemetryFold {
    const existing = this.folds.get(path);
    if (existing) return existing;
    const created = TelemetryFold.create();
    this.folds.set(path, created);
    return created;
  }
}

export function childSources(
  sessionPath: string,
  runs: readonly AgentRun[],
  liveEntries: (path: string) => unknown[] | undefined,
  cache?: ChildTelemetryCache,
): TelemetryChildSource[] {
  return (cache ?? new ChildTelemetryCache()).sources(sessionPath, runs, liveEntries);
}

export function computeLiveTelemetry(
  fold: TelemetryFold,
  entries: readonly unknown[],
  leafId: string | null,
  fence: { revision: string; environmentKey: string },
  options: {
    include?: readonly TelemetrySection[];
    scope?: "session" | "turn";
    turnId?: string;
    overlay: TelemetryLiveOverlay;
    children: readonly TelemetryChildSource[];
  },
): SessionTelemetry {
  const scope = options.scope ?? "session";
  if (scope === "turn") {
    const turnId = options.turnId;
    if (!turnId) throw new Error("turn");
    const slice = turnEntryIndices(entries, leafId, turnId);
    if (!slice) throw new Error("turn-missing");
    const turn = TelemetryFold.create();
    for (const index of slice) turn.push(entries[index]);
    return sessionTelemetryOf(turn.state, { ...fence, authority: "live" }, {
      ...(options.include ? { include: options.include } : {}),
      scope: "turn",
      turnId,
    });
  }
  fold.ingest(entries);
  return sessionTelemetryOf(fold.state, { ...fence, authority: "live" }, {
    ...(options.include ? { include: options.include } : {}),
    scope: "session",
    overlay: options.overlay,
    ...(options.children.length > 0 ? { children: options.children } : {}),
  });
}

function readSessionEntries(path: string): unknown[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const entries: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "session") continue;
      entries.push(parsed);
    }
    return entries;
  } catch {
    return undefined;
  }
}
