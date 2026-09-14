import assert from 'node:assert/strict';
import { createSessions } from '../fixtures.mjs';
import { hydrate, selectSession } from '../sidebar.mjs';
import { slopeSummary } from '../report.mjs';

async function createWorkspaceSessions(run, perKind) {
  const { check } = run;
  const snapshot = await check.rpc('agents/list', {});
  const sessions = [];
  for (const name of ['beam', 'chat']) {
    const cwd = snapshot.workspaces?.[name];
    assert.equal(typeof cwd, 'string', `${name} workspace is unavailable from the authoritative catalog`);
    for (let ordinal = 1; ordinal <= perKind; ordinal++) {
      const state = (await check.rpc('session/new', { cwd, agentName: name })).state;
      await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
      const alias = `${name === 'beam' ? 'Beam' : 'Chat'}-${ordinal}`;
      await check.rpc('pi/session/rename', { path: state.path, name: alias });
      sessions.push({ path: state.path, cwd, alias, kind: name, groupRows: perKind });
    }
  }
  await hydrate(check, sessions, run.config.hydrateCheckpointEvery);
  for (const session of sessions) await selectSession(check, session);
  return sessions;
}

/** Scenarios 2 and 6 — fifty distinct sessions, and every project and workspace at once. */
export default {
  id: '2-distinct-sessions',
  ids: ['2-distinct-sessions', '6-multiple-projects-and-workspaces'],
  title: 'open distinct sessions across every project and private workspace',
  async run(run) {
    const { check, config, expected, report } = run;
    const sessions = await createSessions(check, config);
    assert.equal(sessions.length, expected.projectSessions);
    const visitCheckpoints = [];
    const open = await hydrate(check, sessions, config.hydrateCheckpointEvery, async visited => {
      const checkpoint = await run.samplePhase(`visited-${visited}`);
      visitCheckpoints.push({ visited, openSessions: await check.page.evaluate(() => Object.keys(window.__resourceSoak.store.getSnapshot().open).length),
        rendererJsHeapBytes: checkpoint.renderer?.jsHeapUsedBytes ?? null, totalPssBytes: checkpoint.totalPssBytes });
    });
    assert.equal(open, sessions.length, 'every distinct project session is held by the UI store');
    for (const session of sessions) await selectSession(check, session);
    const workspaceSessions = await createWorkspaceSessions(run, config.workspaceSessionsPerKind);
    assert.equal(workspaceSessions.length, expected.workspaceSessions);
    report.visitCheckpoints = visitCheckpoints;
    report.workspaceSessions = { beam: workspaceSessions.filter(row => row.kind === 'beam').length, chat: workspaceSessions.filter(row => row.kind === 'chat').length };

    const onePerWorkspace = [...new Map([...sessions, ...workspaceSessions].map(session => [session.cwd, session])).values()];
    // Every project and private workspace ready at one moment. A worker that
    // retired naturally between the loads and the list is not a failure; the
    // whole observation is repeated until it holds at a single instant.
    const readyWorkers = await run.until(async () => {
      for (const session of onePerWorkspace) await check.rpc('session/load', { path: session.path });
      const workers = (await check.rpc('pi/worker/list', {})).workers;
      return workers.filter(worker => worker.status === 'ready').length === expected.workers ? workers : false;
    }, 'one ready worker per project and private workspace', Math.min(config.phaseTimeoutMs, 30_000));
    assert.equal(readyWorkers.filter(worker => worker.status === 'ready').length, expected.workers,
      'every project and private workspace has one ready worker before cleanup');

    const phase = await run.samplePhase('distinct-sessions', { heap: true });
    assert.equal(phase.host.workers, expected.workers, 'host retains one row per project/private workspace');
    report.slopes.rendererDistinctSessionHeapBytesPerSession = slopeSummary(visitCheckpoints.map(row => ({ x: row.visited, y: row.rendererJsHeapBytes })), null);
    return { phase, state: { sessions, workspaceSessions, distinctPhase: phase } };
  },
};
