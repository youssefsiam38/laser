import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prompt } from '../fixtures.mjs';
import { expectedRetainedCounts, allocationRows } from '../retention.mjs';
import { setCategory } from '../rankings.mjs';
import { slopeSummary } from '../report.mjs';

const TERMINAL_RUNS = new Set(['completed', 'blocked', 'failed', 'cancelled']);

async function startChildren(run, heavy) {
  const { check, config } = run;
  const definition = { name: 'worker', description: 'Runs synthetic resource work.', instructions: 'Complete only the assigned synthetic resource work.',
    engineInstructions: false, model: { provider: 'stub', id: 'stub-1' }, thinkingLevel: null, supportsSubagents: true,
    allowedAgents: ['worker'], scopedSkills: false, skills: [] };
  const before = await check.rpc('agents/list', {});
  if (!before.agents.some(agent => agent.name === 'worker')) await check.rpc('agents/save', { agent: definition, originalName: null });
  const catalog = await check.rpc('agents/list', {});
  const childAgent = catalog.agents.find(agent => agent.name === 'worker');
  assert.ok(childAgent, `scratch catalog did not contain expected worker; available: ${catalog.agents.map(agent => agent.name).join(',')}`);
  const parent = (await check.rpc('session/new', { cwd: heavy.cwd, agentName: childAgent.name })).state;
  await check.rpc('pi/model/set', { path: parent.path, model: { provider: 'stub', id: 'stub-1' } });
  assert.equal((await check.rpc('agents/runs/list', { path: parent.path })).runs.length, 0, 'scratch parent starts with no unrelated runs');
  for (let index = 1; index <= config.children; index++) {
    await prompt(check.rpc, parent.path, `resource:start-child:${index} agent=${childAgent.name}`, run.until.bind(run), config.phaseTimeoutMs);
  }
  const children = await run.until(async () => {
    const runs = (await check.rpc('agents/runs/list', { path: parent.path })).runs;
    const matching = runs.filter(row => /^resource-child-\d+$/.test(row.subagentName));
    return matching.length === config.children && matching.every(row => ['running', 'needs_input'].includes(row.status)) ? matching : false;
  }, `${config.children} synthetic child runs`, config.phaseTimeoutMs);
  assert.equal((await check.rpc('agents/runs/list', { path: parent.path })).runs.length, config.children);
  return { parent, children };
}

/** Scenario 5 — ten children and two hundred foreground/background Bash calls. */
export default {
  id: '5-children-and-bash',
  title: 'start children and execute foreground and background Bash calls',
  async run(run) {
    const { check, config, expected, report, state } = run;
    const { parent, children } = await startChildren(run, state.heavy);
    await run.samplePhase('children-active');
    for (const child of children) await check.rpc('agents/runs/stop', { runId: child.runId, reason: 'synthetic resource checkpoint complete' });
    await run.until(async () => {
      const runs = (await check.rpc('agents/runs/list', { path: parent.path })).runs;
      return runs.length === config.children && runs.every(row => TERMINAL_RUNS.has(row.status)) ? runs : false;
    }, 'children to reach terminal status after stop', config.phaseTimeoutMs);

    const bashSessions = state.sessions.slice(0, Math.min(10, state.sessions.length));
    const bashCalls = [];
    const totalCalls = expected.bashCalls;
    const allocationStartsAt = Math.max(1, totalCalls - config.allocationWindowCalls + 1);
    let allocationSet;
    let allocationStartedAt = 0;
    let allocationStartRequests = 0;
    for (let index = 1; index <= totalCalls; index++) {
      if (!allocationSet && index === allocationStartsAt) {
        allocationSet = await run.inspectorSet();
        allocationStartedAt = Date.now();
        allocationStartRequests = JSON.parse(await readFile(join(check.root, 'provider-counters.json'), 'utf8')).requests;
        await allocationSet.host.client.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        for (const worker of allocationSet.workers) await worker.client.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      }
      const background = index > config.foregroundCalls;
      const ordinal = background ? index - config.foregroundCalls : index;
      const session = bashSessions[(index - 1) % bashSessions.length];
      await prompt(check.rpc, session.path, `resource:bash:${background ? 'bg' : 'fg'}:${ordinal} bytes=16384 RESOURCE-SOAK-COMMAND-CANARY`, run.until.bind(run), config.phaseTimeoutMs);
      bashCalls.push({ background, generation: await run.workerGeneration(session.cwd) });
      if (index % config.bashCheckpointEvery === 0 || index === totalCalls) {
        const checkpoint = await run.samplePhase(`bash-${index}`);
        (report.taskCheckpoints ??= []).push({ calls: index, rendererJsHeapBytes: checkpoint.renderer?.jsHeapUsedBytes ?? null });
      }
    }
    if (allocationSet) {
      try {
        const hostAllocations = allocationRows((await allocationSet.host.client.send('HeapProfiler.stopSampling')).profile);
        setCategory(report.rankings, 'host-allocation', hostAllocations);
        const rows = [];
        for (const worker of allocationSet.workers) rows.push(...allocationRows((await worker.client.send('HeapProfiler.stopSampling')).profile));
        setCategory(report.rankings, 'worker-allocation', rows.sort((a, b) => b.bytes - a.bytes).slice(0, 20));
        const elapsedMs = Date.now() - allocationStartedAt;
        const providerRequests = JSON.parse(await readFile(join(check.root, 'provider-counters.json'), 'utf8')).requests - allocationStartRequests;
        const hostSampledBytes = hostAllocations.reduce((sum, row) => sum + row.bytes, 0);
        const workerSampledBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
        report.allocationRate = { status: 'available', elapsedMs, providerRequests, windowCalls: config.allocationWindowCalls,
          hostSampledBytesPerSecond: elapsedMs > 0 ? hostSampledBytes * 1000 / elapsedMs : null,
          hostSampledBytesPerProviderRequest: providerRequests > 0 ? hostSampledBytes / providerRequests : null,
          workerSampledBytesPerSecond: elapsedMs > 0 ? workerSampledBytes * 1000 / elapsedMs : null,
          workerSampledBytesPerProviderRequest: providerRequests > 0 ? workerSampledBytes / providerRequests : null };
      } finally { await run.closeInspectorSet(allocationSet); }
    }

    const tasks = await check.rpc('tasks/list', {});
    assert.equal(tasks.tasks.filter(task => task.status !== 'running').length, config.backgroundCalls, 'host retains every background call');
    // In-worker retention belongs to one worker process, so the sample and the
    // generation it is graded against must be the same one.
    let phase;
    let retention;
    for (let attempt = 1; attempt <= 3 && !retention; attempt++) {
      const before = await run.workerGeneration(state.heavy.cwd);
      const candidate = await run.samplePhase('bash-complete', { heap: true });
      const after = await run.workerGeneration(state.heavy.cwd);
      if (before === after) { phase = candidate; retention = expectedRetainedCounts({ calls: bashCalls, heavyToolGeneration: state.heavyToolGeneration, currentGeneration: after }); }
      else report.phases.pop();
    }
    if (!retention) throw new Error('The project worker was replaced during every bash-complete sample, so retained-count evidence could not be taken within one worker generation.');
    assert.equal(phase.unreadableWorkers, 0, 'retained-count evidence needs every live worker readable');
    assert.equal(phase.tailBuffers.available, true, 'retained-count evidence needs the extension tail buffers readable');
    const workerTaskRows = phase.workers.reduce((sum, worker) => sum + worker.tasks, 0);
    assert.equal(phase.tailBuffers.count, retention.tailBuffers,
      'no finished command keeps a tail buffer: 200 completed Bash calls leave compact records and bounded logs, not 200 windows in memory (RP-6) '
      + `(same-generation calls ${retention.sameGenerationCalls}, calls whose worker was replaced ${retention.replacedGenerationCalls}, heavy tool survived ${retention.heavyToolGenerationSurvived})`);
    assert.equal(phase.tailBuffers.bytes, 0, 'retained tail bytes after every command has ended');
    assert.equal(phase.host.tasks, config.backgroundCalls, 'host retains background-task metadata only');
    assert.equal(workerTaskRows, retention.workerBackgroundTasks,
      `workers retain background-task metadata only for the generation that ran it (expected ${retention.workerBackgroundTasks} of ${config.backgroundCalls})`);
    report.workerGenerations = { bashCalls: bashCalls.length, sameGenerationCalls: retention.sameGenerationCalls,
      replacedGenerationCalls: retention.replacedGenerationCalls, heavyToolGenerationSurvived: retention.heavyToolGenerationSurvived };
    report.retainedTaskRecords = { extensionTailBuffers: phase.tailBuffers.count, workerTaskRows, hostTaskRows: phase.host.tasks,
      expectedExtensionTailBuffers: retention.tailBuffers, expectedWorkerTaskRows: retention.workerBackgroundTasks };
    report.slopes.rendererBashHeapBytesPerCall = slopeSummary((report.taskCheckpoints ?? []).map(row => ({ x: row.calls, y: row.rendererJsHeapBytes })), null);
    report.temporaryPeaks.bashRendererJsBytes = Number.isFinite(phase.postGc?.renderer?.jsHeapUsedBytes)
      ? Math.max(...(report.taskCheckpoints ?? []).map(row => row.rendererJsHeapBytes).filter(Number.isFinite), phase.renderer?.jsHeapUsedBytes ?? 0)
        - phase.postGc.renderer.jsHeapUsedBytes : null;
    return { phase, state: { bashCalls: bashCalls.length } };
  },
};
