/**
 * Every quick/full constant the soak uses lives here. Scenario code reads the
 * mode's own values and never compares the mode's name, so a reader can see the
 * whole shape of a run — workload, pacing, sampling and lane scale — in one
 * table instead of deducing it from `mode === 'full'` branches.
 */
export const MODES = Object.freeze({
  quick: Object.freeze({
    name: 'quick',
    projects: 1, sessionsPerProject: 3, longSessions: 1, longMessages: 80,
    chatSessions: 1,
    children: 2, foregroundCalls: 3, backgroundCalls: 3,
    images: 2, imageSide: 512, reasoningBytes: 256 * 1024,
    markdownBytes: 256 * 1024, toolBytes: 512 * 1024,
    streamChunks: 128, streamDelayMs: 1, childHoldMs: 8_000,
    idleMs: 1_500, sweepMs: 100, phaseTimeoutMs: 120_000,
    runTimeoutMs: 8 * 60_000,
    // Pacing and sampling.
    baselineSettleMs: 500, baselineNaturalSamples: 2, baselineNaturalIntervalMs: 1_000,
    hydrateCheckpointEvery: 10, bashCheckpointEvery: 2, bashSlopeCheckpointEvery: 2, allocationWindowCalls: 2,
    workerHeapCaptures: 1, historyPageSize: 40,
    slowReplayAttempts: 24, slowReplayPaceMs: 150, backpressureTimeoutMs: 15_000,
    quietSamples: 3, quietIntervalMs: 1_000,
    retirementGuardDeadlineMs: 15_000, teardownTimeoutMs: 10_000,
    // One product RPC is one WebSocket, opened and torn down per call, so every
    // polling loop declares this bounded interval instead of spinning.
    pollIntervalMs: 250,
    // Scenario 7 runs its own Electron lane at a declared scale of its own.
    electronLaneMode: 'quick',
  }),
  full: Object.freeze({
    name: 'full',
    projects: 5, sessionsPerProject: 10, longSessions: 4, longMessages: 240,
    chatSessions: 2,
    children: 10, foregroundCalls: 100, backgroundCalls: 100,
    images: 12, imageSide: 2048, reasoningBytes: 2 * 1024 * 1024,
    markdownBytes: 2 * 1024 * 1024, toolBytes: 8 * 1024 * 1024,
    streamChunks: 2048, streamDelayMs: 2, childHoldMs: 30_000,
    idleMs: 15_000, sweepMs: 500, phaseTimeoutMs: 5 * 60_000,
    runTimeoutMs: 30 * 60_000,
    baselineSettleMs: 10_000, baselineNaturalSamples: 5, baselineNaturalIntervalMs: 1_000,
    hydrateCheckpointEvery: 10, bashCheckpointEvery: 50, bashSlopeCheckpointEvery: 10, allocationWindowCalls: 50,
    workerHeapCaptures: 3, historyPageSize: 40,
    slowReplayAttempts: 2, slowReplayPaceMs: 150, backpressureTimeoutMs: 60_000,
    quietSamples: 6, quietIntervalMs: 5_000,
    retirementGuardDeadlineMs: 15_000, teardownTimeoutMs: 10_000,
    pollIntervalMs: 250,
    // Deliberately the quick lane: the desktop hide/restore scenario measures a
    // window's own lifecycle, not the transcript workload, and its scale is
    // declared here rather than hidden in the lane.
    electronLaneMode: 'quick',
  }),
});

export const SAFETY = Object.freeze({
  snapshotBytes: 256 * 1024 * 1024,
  parserHeapMb: 384,
  socketBufferedBytes: 64 * 1024 * 1024,
  processPssBytes: Math.floor(1.5 * 1024 * 1024 * 1024),
  totalPssBytes: 5 * 1024 * 1024 * 1024,
  minimumAvailableBytes: 2 * 1024 * 1024 * 1024,
  providerRequests: 2500,
});

export function modeConfig(name) {
  const value = MODES[name];
  if (!value) throw new Error(`Unknown resource-soak mode ${name}.`);
  return value;
}

/** What the fixture must produce, derived from the mode, never from a literal. */
export function expected(config) {
  const projectSessions = config.projects * config.sessionsPerProject;
  // One private workspace since M23: Chat (`docs/plain-chat.md`).
  const workspaceSessions = config.chatSessions;
  const shortSessions = projectSessions - config.longSessions;
  return {
    projectSessions,
    workspaceSessions,
    retainedViews: projectSessions + workspaceSessions,
    workers: config.projects + workspaceSessions,
    bashCalls: config.foregroundCalls + config.backgroundCalls,
    logicalImageBytes: config.images * config.imageSide * config.imageSide * 4,
    // One provider request per seeded turn; short sessions are seeded with two.
    seedRequests: config.longSessions * (config.longMessages / 2) + shortSessions * 2,
    historyPages: Math.max(0, Math.ceil((config.longMessages - config.historyPageSize) / config.historyPageSize)),
  };
}
