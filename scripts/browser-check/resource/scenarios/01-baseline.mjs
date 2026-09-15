import assert from 'node:assert/strict';
import { sleep } from '../context.mjs';
import { deliveryCounts } from '../retirement.mjs';

/** Scenario 1 — clean start and idle baseline. */
export default {
  id: '1-baseline',
  title: 'clean start and idle baseline',
  async run(run) {
    const { check, config, report } = run;
    // The renderer's own store and stable provider, proved before anything is
    // measured against them.
    const prototype = await run.inspectorSet();
    try {
      const state = await check.page.evaluate(() => ({ store: !!window.__resourceSoak?.store, stable: !!window.__resourceSoak?.stable, matches: window.__resourceSoak?.matches, error: window.__resourceSoak?.error }));
      assert.deepEqual(state, { store: true, stable: true, matches: 1, error: null }, 'renderer state-store prototype checkpoint');
      assert.equal(prototype.workers.length, 0, 'baseline has no project worker');
      run.state.rendererStoreProved = true;
    } finally { await run.closeInspectorSet(prototype); }

    await sleep(config.baselineSettleMs);
    const natural = [];
    for (let index = 0; index < config.baselineNaturalSamples; index++) {
      if (index) await sleep(config.baselineNaturalIntervalMs);
      natural.push(await run.samplePhase(`baseline-natural-${index + 1}`));
    }
    const baseline = await run.samplePhase('baseline', { heap: true });
    assert.equal(baseline.host.tasks, 0, 'baseline host task register is empty');
    assert.equal(baseline.host.workers, 0, 'baseline host worker pool is empty');
    // A measured zero, not a missing one: the host must say it could read its
    // per-connection membership before "nothing is held" means anything. The
    // same numbers are proved non-zero, and zero again, against a real
    // connection that attaches and closes in scenario 8.
    const delivery = deliveryCounts(baseline.host);
    assert.equal(delivery.available, true, `baseline transcript delivery evidence is unreadable: ${delivery.reason}`);
    assert.deepEqual([delivery.paths, delivery.owners, delivery.admittedOwners, delivery.loadingOwners], [0, 0, 0, 0],
      'baseline holds no conversation on any connection');
    assert.deepEqual([baseline.host.transcriptLoaded, baseline.host.transcriptLoading, baseline.host.attachmentRefs, baseline.host.attachedPaths],
      [0, 0, 0, 0], 'the guard rows agree with the membership view they are read from');
    assert.equal(delivery.connections, baseline.host.connections, 'every connected client has a delivery record the guard can read');
    report.temporaryPeaks = { baselinePssBytes: Number.isFinite(baseline.postGc?.totalPssBytes)
      ? Math.max(...natural.map(row => row.totalPssBytes).filter(Number.isFinite), baseline.totalPssBytes ?? 0) - baseline.postGc.totalPssBytes : null };
    return { phase: baseline, state: { baselineNatural: natural } };
  },
};
