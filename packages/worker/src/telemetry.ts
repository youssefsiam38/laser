/**
 * Live whole-session telemetry. Durable child membership and stored spend come
 * from the host; this worker contributes only current-generation live folds.
 */
import {
  TELEMETRY_CHILD_MODEL_LINE_MAX,
  TELEMETRY_CHILD_SNAPSHOT_MAX_BYTES,
  TELEMETRY_CHILD_SOURCE_MAX,
  TelemetryFold,
  childSpendFoldOf,
  isTerminalRunStatus,
  runsBeneathSession,
  sessionTelemetryOf,
  turnEntryIndices,
  type AgentRun,
  type SessionState,
  type SessionTelemetry,
  type TelemetryChildSpendSnapshot,
  type TelemetryChildSpendSource,
  type TelemetryContext,
  type TelemetryLiveOverlay,
  type TelemetrySection,
  type TelemetrySpendCoverage,
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

type Baseline =
  | { status: "dirty"; generation: number; snapshot?: TelemetryChildSpendSnapshot }
  | { status: "fresh"; generation: number; snapshot: TelemetryChildSpendSnapshot };

export interface ResolvedChildSpend {
  sources: TelemetryChildSpendSource[];
  coverage: TelemetrySpendCoverage;
}

/**
 * Host-canonical baselines are per interested scope. Live folds are eligible
 * only while their child runtime and nonterminal run both exist.
 */
export interface ChildTelemetryLimits {
  sources?: number;
  modelLines?: number;
  bytes?: number;
}

export class ChildTelemetryCache {
  private readonly baselines = new Map<string, Baseline>();
  private readonly liveFolds = new Map<string, TelemetryFold>();

  constructor(private readonly limits: ChildTelemetryLimits = {}) {}

  invalidate(path: string, generation: number): number {
    const current = this.baselines.get(path);
    if (!current || generation > current.generation) {
      this.baselines.set(path, {
        status: "dirty",
        generation,
        ...(current?.snapshot ? { snapshot: current.snapshot } : {}),
      });
    }
    return this.baselines.get(path)?.generation ?? generation;
  }

  apply(snapshot: TelemetryChildSpendSnapshot): { applied: boolean; generation: number } {
    const current = this.baselines.get(snapshot.scopeSessionPath);
    if (current && current.generation > snapshot.generation) {
      return { applied: false, generation: current.generation };
    }
    const copy = structuredClone(snapshot);
    this.baselines.set(snapshot.scopeSessionPath, {
      status: "fresh",
      generation: snapshot.generation,
      snapshot: copy,
    });
    return { applied: true, generation: snapshot.generation };
  }

  currentGeneration(path: string): number {
    return this.baselines.get(path)?.generation ?? -1;
  }

  /** Request-scoped composition always uses the payload attached to that request. */
  resolve(
    snapshot: TelemetryChildSpendSnapshot,
    runs: readonly AgentRun[],
    liveEntries: (path: string) => unknown[] | undefined,
  ): ResolvedChildSpend {
    return this.withLiveOverlay(snapshot, runs, liveEntries);
  }

  /** Streaming composition is withheld until the host baseline is fresh. */
  streaming(
    path: string,
    runs: readonly AgentRun[],
    liveEntries: (path: string) => unknown[] | undefined,
  ): ResolvedChildSpend | undefined {
    const baseline = this.baselines.get(path);
    if (!baseline || baseline.status !== "fresh") return undefined;
    return this.withLiveOverlay(baseline.snapshot, runs, liveEntries);
  }

  dropScope(path: string): void {
    this.baselines.delete(path);
  }

  dropChild(path: string): void {
    this.liveFolds.delete(path);
  }

  rekey(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const baseline = this.baselines.get(oldPath);
    if (baseline) {
      this.baselines.delete(oldPath);
      const snapshot = baseline.snapshot
        ? {
            ...baseline.snapshot,
            scopeSessionPath: newPath,
            sources: baseline.snapshot.sources.map((source) =>
              source.sessionPath === oldPath ? { ...source, sessionPath: newPath } : source,
            ),
          }
        : undefined;
      this.baselines.set(newPath, baseline.status === "fresh" && snapshot
        ? { status: "fresh", generation: baseline.generation, snapshot }
        : { status: "dirty", generation: baseline.generation, ...(snapshot ? { snapshot } : {}) });
    }
    for (const [scope, value] of this.baselines) {
      if (!value.snapshot || !value.snapshot.sources.some((source) => source.sessionPath === oldPath)) continue;
      const snapshot = {
        ...value.snapshot,
        sources: value.snapshot.sources.map((source) =>
          source.sessionPath === oldPath ? { ...source, sessionPath: newPath } : source,
        ),
      };
      this.baselines.set(scope, value.status === "fresh"
        ? { status: "fresh", generation: value.generation, snapshot }
        : { status: "dirty", generation: value.generation, snapshot });
    }
    const fold = this.liveFolds.get(oldPath);
    if (fold) {
      this.liveFolds.delete(oldPath);
      this.liveFolds.set(newPath, fold);
    }
  }

  private withLiveOverlay(
    snapshot: TelemetryChildSpendSnapshot,
    runs: readonly AgentRun[],
    liveEntries: (path: string) => unknown[] | undefined,
  ): ResolvedChildSpend {
    const sources = new Map(snapshot.sources.map((source) => [source.sessionPath, structuredClone(source)]));
    const coverage = { ...snapshot.coverage };
    const canonicalPaths = new Set(sources.keys());
    const serializedMembershipComplete = snapshot.coverage.knownChildren === snapshot.sources.length;
    const sourceLimit = this.limits.sources ?? TELEMETRY_CHILD_SOURCE_MAX;
    const modelLineLimit = this.limits.modelLines ?? TELEMETRY_CHILD_MODEL_LINE_MAX;
    const byteLimit = this.limits.bytes ?? TELEMETRY_CHILD_SNAPSHOT_MAX_BYTES;
    const seen = new Set<string>();
    for (const run of runsBeneathSession(snapshot.scopeSessionPath, runs)) {
      if (seen.has(run.sessionPath) || isTerminalRunStatus(run.status)) continue;
      seen.add(run.sessionPath);
      const canonical = sources.get(run.sessionPath);
      // An absent path in a partial membership snapshot may be a host-known
      // child omitted by a bound, including one trimmed earlier in this loop.
      // Adding it would count that child twice.
      if (!canonical && (!serializedMembershipComplete || canonicalPaths.has(run.sessionPath))) continue;
      const entries = liveEntries(run.sessionPath);
      if (!entries) continue;
      const fold = this.liveFolds.get(run.sessionPath) ?? TelemetryFold.create();
      this.liveFolds.set(run.sessionPath, fold);
      fold.ingest(entries);
      const model = run.model ? `${run.model.provider}/${run.model.id}` : undefined;
      const replacement: TelemetryChildSpendSource = {
        sessionPath: run.sessionPath,
        ...(model ? { model } : {}),
        spend: childSpendFoldOf(fold.state),
      };
      const models = new Set([
        ...replacement.spend!.byModelAll.map((line) => line.model),
        ...replacement.spend!.byModelApi.map((line) => line.model),
      ]);

      if (canonical) {
        let filledCanonical = false;
        if (models.size <= modelLineLimit) {
          sources.set(run.sessionPath, replacement);
          if (!canonical.spend) {
            coverage.includedChildren += 1;
            coverage.unavailableChildren -= 1;
            filledCanonical = true;
          }
          if (encodedSnapshotBytes(snapshot, sources, coverage) <= byteLimit) continue;
        }
        // A live source supersedes its durable source. If the replacement does
        // not fit, retaining the old spend would present stale data as exact.
        sources.set(run.sessionPath, unavailableSource(canonical));
        if (canonical.spend || filledCanonical) {
          coverage.includedChildren -= 1;
          coverage.unavailableChildren += 1;
        }
        continue;
      }

      coverage.knownChildren += 1;
      if (models.size > modelLineLimit || sources.size >= sourceLimit) {
        coverage.unavailableChildren += 1;
        trimSnapshotToBytes(snapshot, sources, coverage, byteLimit);
        continue;
      }
      sources.set(run.sessionPath, replacement);
      coverage.includedChildren += 1;
      if (encodedSnapshotBytes(snapshot, sources, coverage) <= byteLimit) continue;
      sources.delete(run.sessionPath);
      coverage.includedChildren -= 1;
      coverage.unavailableChildren += 1;
      trimSnapshotToBytes(snapshot, sources, coverage, byteLimit);
    }
    return { sources: [...sources.values()], coverage };
  }
}

function unavailableSource(source: TelemetryChildSpendSource): TelemetryChildSpendSource {
  return {
    sessionPath: source.sessionPath,
    ...(source.model ? { model: source.model } : {}),
  };
}

function encodedSnapshotBytes(
  snapshot: TelemetryChildSpendSnapshot,
  sources: ReadonlyMap<string, TelemetryChildSpendSource>,
  coverage: TelemetrySpendCoverage,
): number {
  return new TextEncoder().encode(JSON.stringify({
    scopeSessionPath: snapshot.scopeSessionPath,
    generation: snapshot.generation,
    sources: [...sources.values()],
    coverage,
  })).byteLength;
}

/** Keep truthful coverage while freeing serialized detail for its envelope. */
function trimSnapshotToBytes(
  snapshot: TelemetryChildSpendSnapshot,
  sources: Map<string, TelemetryChildSpendSource>,
  coverage: TelemetrySpendCoverage,
  byteLimit: number,
): void {
  while (encodedSnapshotBytes(snapshot, sources, coverage) > byteLimit && sources.size > 0) {
    const entries = [...sources.entries()];
    const contributed = entries.findLast(([, source]) => source.spend !== undefined);
    if (contributed) {
      sources.set(contributed[0], unavailableSource(contributed[1]));
      coverage.includedChildren -= 1;
      coverage.unavailableChildren += 1;
      continue;
    }
    sources.delete(entries.at(-1)![0]);
  }
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
    children?: ResolvedChildSpend;
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
    ...(options.children ? { childSpend: options.children.sources, coverage: options.children.coverage } : {}),
  });
}
