/** What one worker process can still be holding, given where each call ran. */
export function expectedRetainedCounts({ calls = [], heavyToolGeneration = null, currentGeneration = null } = {}) {
  const same = value => value !== null && currentGeneration !== null && value === currentGeneration;
  const retained = calls.filter(call => same(call.generation));
  return {
    tailBuffers: retained.length + (same(heavyToolGeneration) ? 1 : 0),
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
