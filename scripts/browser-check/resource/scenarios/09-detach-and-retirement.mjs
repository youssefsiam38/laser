import assert from 'node:assert/strict';
import { selectSession } from '../sidebar.mjs';
import { scalarCounters, waitForRegistrations, removeRegistrations } from '../inspector.mjs';
import { slopeSummary } from '../report.mjs';
import { sleep } from '../context.mjs';
import {
  assertNoLiveWork, dormantViews, proveNoLiveWork, reconcileDelivery,
  retirementGuardSnapshot, traverseRetainedViews, waitForNaturalRetirement,
} from '../retirement.mjs';

/** The app's own view of one session: what it holds and whether it is streaming. */
async function observeView(check, path) {
  return check.page.evaluate(value => {
    const snapshot = window.__resourceSoak.store.getSnapshot();
    const view = snapshot.open[value];
    const summary = (snapshot.sessions ?? []).find(row => row.path === value) ?? null;
    return {
      present: !!view,
      entries: view?.entries?.length ?? 0,
      streaming: view ? !!view.isStreaming : null,
      attention: summary ? { status: summary.status ?? null, seq: summary.seq ?? null, modifiedAt: summary.modifiedAt ?? null } : null,
    };
  }, path);
}

async function openPaths(check) {
  return check.page.evaluate(() => ({
    open: Object.keys(window.__resourceSoak.store.getSnapshot().open),
    current: window.__resourceSoak.store.getSnapshot().current ?? null,
  }));
}

/** Scenario 9 — detach every dormant view, reattach one, then retire. */
export default {
  id: '9-detach-and-retirement',
  title: 'detach every dormant session and wait through worker retirement',
  async run(run) {
    const { check, config, expected, report, state } = run;
    await run.samplePhase('pre-detach', { heap: true });
    const proved = await proveNoLiveWork(() => run.sampleRetirementGuards(), { deadlineMs: Math.min(config.phaseTimeoutMs, config.retirementGuardDeadlineMs) });
    const traversal = await traverseRetainedViews(check, state.sessions, state.workspaceSessions, expected.retainedViews, { select: selectSession });
    assert.equal(traversal.visited, expected.retainedViews, 'retirement traversal visits every retained UI view');
    report.retirement = { traversal, preDetachGuards: proved.guards, guardAttempts: proved.attempts, readableWorkers: proved.readable };

    // 1. Detachment. The app detaches every open session that is not the one on
    // screen; this proves the host's attached set actually collapsed to it,
    // rather than assuming the effect ran.
    const before = await openPaths(check);
    const dormant = dormantViews(before.open, before.current);
    const dormantSet = new Set(dormant);
    // The app may hold more open views than this run created — a scenario's own
    // agent parent, for one — so the claim is about the retained views: every
    // one of them except the view on screen is dormant.
    const retainedPaths = [...state.sessions, ...state.workspaceSessions].map(session => session.path);
    const retainedDormant = retainedPaths.filter(path => path !== before.current);
    assert.equal(retainedDormant.every(path => dormantSet.has(path)), true, 'every retained view except the current one is dormant');
    assert.equal(retainedDormant.length, expected.retainedViews - (retainedPaths.includes(before.current) ? 1 : 0),
      'the dormant set covers every retained view the run created');
    const detached = await run.withHost(({ counters }) => run.until(async () => {
      const guards = retirementGuardSnapshot(await counters());
      return guards.attachedPaths <= 1 ? guards : false;
    }, 'the app to detach every dormant retained view', Math.min(config.phaseTimeoutMs, config.teardownTimeoutMs)));
    // The product detaches eagerly, so after visiting every retained view the
    // host holds at most the one on screen — never a set that grew with the
    // visits. Zero is the same statement: the app detached that one too.
    assert.ok(detached.attachedPaths <= 1,
      `after visiting ${expected.retainedViews} retained views the host still holds ${detached.attachedPaths} attached paths`);

    // 2. Reattachment and delivery reconciliation. Selecting a detached view
    // re-attaches it through the product's own session/load; a prompt then has
    // to reach that view and settle, in either arrival order.
    const reattached = state.sessions.at(-1);
    await selectSession(check, reattached);
    const baseline = await observeView(check, reattached.path);
    assert.equal(baseline.present, true, 'the reattached view is still held by the app');
    const accepted = await check.rpc('session/prompt', { path: reattached.path, content: [{ type: 'text', text: 'resource:reattached' }] });
    assert.equal(accepted.accepted, true, 'a reattached view accepts a prompt');
    const reconciled = await reconcileDelivery(() => observeView(check, reattached.path), {
      baselineEntries: baseline.entries, deadlineMs: Math.min(config.phaseTimeoutMs, 120_000), pollMs: config.pollIntervalMs,
    });
    const authoritative = await check.rpc('pi/session/entries', { path: reattached.path });
    assert.ok(reconciled.entries > baseline.entries, 'the reattached view received its new entries');
    assert.ok(authoritative.entries.length >= reconciled.entries - reconciled.grewBy, 'the reattached view agrees with the authoritative transcript');
    const stillDormant = dormant.find(path => path !== reattached.path) ?? dormant[0];
    const dormantDelivery = await observeView(check, stillDormant);
    report.retirement.reattachment = {
      openViews: before.open.length, dormantViews: dormant.length, retainedDormantViews: retainedDormant.length,
      attachedBeforeTraversal: proved.guards.attachedPaths, attachedAfterDetach: detached.attachedPaths,
      reattachedEntries: reconciled.entries, reattachedGrewBy: reconciled.grewBy,
      dormantViewStillHeld: dormantDelivery.present, dormantViewStreaming: dormantDelivery.streaming,
      note: 'detach is attachment bookkeeping only: a loaded view stays subscribed until its connection closes',
    };
    const settledGuards = await proveNoLiveWork(() => run.sampleRetirementGuards(), { deadlineMs: Math.min(config.phaseTimeoutMs, config.retirementGuardDeadlineMs) });
    report.retirement.postReattachGuards = settledGuards.guards;

    // 3. The page itself goes away, which is what releases the product socket
    // and everything the host counted through it.
    const boundarySet = await run.inspectorSet({ includeWorkers: false });
    let boundaryGuards = retirementGuardSnapshot();
    try {
      await check.page.close();
      try {
        boundaryGuards = await run.until(async () => {
          const host = await scalarCounters(boundarySet.host.client, boundarySet.host.handle.objectId, 'host');
          boundaryGuards = retirementGuardSnapshot(host);
          return boundaryGuards.productConnections === 0 && boundaryGuards.attachmentRefs === 0 && boundaryGuards.attachedPaths === 0 ? boundaryGuards : false;
        }, 'product WebSocket and attachment teardown', Math.min(config.phaseTimeoutMs, config.teardownTimeoutMs));
      } catch {
        throw new Error(`Timed out waiting for product WebSocket and attachment teardown; guards=${JSON.stringify(boundaryGuards)}`);
      }
      assertNoLiveWork(boundaryGuards);
      assert.deepEqual({ connections: boundaryGuards.productConnections, refs: boundaryGuards.attachmentRefs, paths: boundaryGuards.attachedPaths },
        { connections: 0, refs: 0, paths: 0 }, 'page teardown releases every product connection and attachment');
    } finally {
      await run.closeInspectorSet(boundarySet);
    }
    report.retirement.boundaryGuards = boundaryGuards;

    await waitForNaturalRetirement(check, config.idleMs + config.sweepMs * 2 + 10_000, boundaryGuards, { pollMs: config.pollIntervalMs });
    const retired = await run.samplePhase('retired', { heap: true, includeWorkers: false, pageClosed: true });
    assert.equal(retired.workers.length, 0);
    const quiet = [];
    for (let index = 0; index < config.quietSamples; index++) {
      await sleep(config.quietIntervalMs);
      const phase = await run.samplePhase(`retired-quiet-${index + 1}`, { includeWorkers: false, pageClosed: true });
      quiet.push({ x: index * (config.quietIntervalMs / 60_000), y: phase.totalPssBytes });
    }
    report.slopes.hostPostRetirementPssBytesPerMinute = slopeSummary(quiet, config.quietIntervalMs / 1000);
    await removeRegistrations((await waitForRegistrations(check.fixture.inspectDir, { rootPid: check.fixture.hostRecord.pid, minimum: 1 }))
      .filter(record => record.pid !== check.fixture.hostRecord.pid));
    return { phase: retired };
  },
};
