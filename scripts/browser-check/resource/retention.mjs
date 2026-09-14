/**
 * What a worker generation is expected to be holding after its commands have
 * finished (RP-6).
 *
 * This used to expect one live `TailBuffer` per completed Bash call — the
 * defect, written down as an expectation: every command a session ran kept its
 * full 256 KiB window for the life of the session. A finished command now
 * keeps a compact record and a bounded window on disk, so the expectation is
 * zero live buffers, while the *metadata* rows the fleet draws are unchanged.
 */
export function expectedRetainedCounts({ calls = [], heavyToolGeneration = null, currentGeneration = null } = {}) {
  const same = value => value !== null && currentGeneration !== null && value === currentGeneration;
  const retained = calls.filter(call => same(call.generation));
  return {
    // No command is still running at this point in the scenario, so nothing
    // may be holding a tail buffer.
    tailBuffers: 0,
    workerBackgroundTasks: retained.filter(call => call.background).length,
    sameGenerationCalls: retained.length,
    replacedGenerationCalls: calls.length - retained.length,
    heavyToolGenerationSurvived: same(heavyToolGeneration),
  };
}

/** Sampled allocation owners from one V8 sampling profile. */
export function allocationRows(profile) {
  const by = new Map();
  const walk = node => {
    const name = node.callFrame?.functionName || '(anonymous)';
    by.set(name, (by.get(name) ?? 0) + (node.selfSize ?? 0));
    for (const child of node.children ?? []) walk(child);
  };
  if (profile?.head) walk(profile.head);
  for (const sample of profile?.samples ?? []) by.set('sampled-allocation', (by.get('sampled-allocation') ?? 0) + (sample.size ?? 0));
  return [...by].map(([owner, bytes]) => ({ owner, bytes })).filter(row => row.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 20);
}
