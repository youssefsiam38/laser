export const MODES = Object.freeze({
  quick: Object.freeze({
    projects: 1, sessionsPerProject: 3, longSessions: 1, longMessages: 80,
    children: 2, foregroundCalls: 3, backgroundCalls: 3,
    images: 2, imageSide: 512, reasoningBytes: 256 * 1024,
    markdownBytes: 256 * 1024, toolBytes: 512 * 1024,
    streamChunks: 128, streamDelayMs: 1, childHoldMs: 8_000,
    idleMs: 1_500, sweepMs: 100, phaseTimeoutMs: 120_000,
    runTimeoutMs: 8 * 60_000,
  }),
  full: Object.freeze({
    projects: 5, sessionsPerProject: 10, longSessions: 4, longMessages: 240,
    children: 10, foregroundCalls: 100, backgroundCalls: 100,
    images: 12, imageSide: 2048, reasoningBytes: 2 * 1024 * 1024,
    markdownBytes: 2 * 1024 * 1024, toolBytes: 8 * 1024 * 1024,
    streamChunks: 2048, streamDelayMs: 2, childHoldMs: 30_000,
    idleMs: 15_000, sweepMs: 500, phaseTimeoutMs: 5 * 60_000,
    runTimeoutMs: 30 * 60_000,
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

export const PHASES = Object.freeze([
  'baseline', 'distinct-sessions', 'paged-history', 'large-stream',
  'children-active', 'bash-complete', 'slow-consumer', 'pre-detach',
  'retired', 'desktop-visible', 'desktop-hidden', 'desktop-restored',
]);

export function modeConfig(name) {
  const value = MODES[name];
  if (!value) throw new Error(`Unknown resource-soak mode ${name}.`);
  return value;
}

export function expected(config) {
  return {
    projectSessions: config.projects * config.sessionsPerProject,
    workspaceSessions: config === MODES.full ? 4 : 2,
    bashCalls: config.foregroundCalls + config.backgroundCalls,
    logicalImageBytes: config.images * config.imageSide * config.imageSide * 4,
  };
}
