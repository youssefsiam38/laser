/**
 * Live whole-session telemetry. The fold is the protocol's; this file only
 * feeds it the engine's entries, live context, and child runs this worker
 * already holds.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  TelemetryFold,
  sessionTelemetryOf,
  turnEntryIndices,
  type SessionState,
  type SessionTelemetry,
  type TelemetryChildSource,
  type TelemetryLiveOverlay,
  type TelemetrySection,
} from "@lasercode/protocol";
import type { AgentRun } from "@lasercode/protocol";

const TELEMETRY_UPDATE_KINDS = new Set([
  "message_end",
  "tool_execution_end",
  "compaction_end",
  "agent_settled",
  "state",
  "entry_appended",
]);

export function telemetryUpdateKind(kind: string): boolean {
  return TELEMETRY_UPDATE_KINDS.has(kind);
}

export function liveOverlay(state: SessionState): TelemetryLiveOverlay {
  const usage = state.contextUsage;
  return {
    ...(usage
      ? {
          context: {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
            autoCompact: {
              enabled: state.autoCompactionEnabled,
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

export function childSources(rootPath: string, runs: readonly AgentRun[], liveEntries: (path: string) => unknown[] | undefined): TelemetryChildSource[] {
  const seen = new Set<string>();
  const children: TelemetryChildSource[] = [];
  for (const run of runs) {
    if (run.sessionPath === rootPath || seen.has(run.sessionPath)) continue;
    seen.add(run.sessionPath);
    const model = run.model ? `${run.model.provider}/${run.model.id}` : undefined;
    const entries = liveEntries(run.sessionPath) ?? readSessionEntries(run.sessionPath);
    if (!entries) {
      children.push(model ? { model } : {});
      continue;
    }
    const fold = TelemetryFold.create();
    fold.ingest(entries);
    children.push({ ...(model ? { model } : {}), fold: fold.state });
  }
  return children;
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
      overlay: options.overlay,
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
