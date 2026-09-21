/**
 * Scenario 9's vocabulary: what "dormant" means, what a detached view must
 * still receive, and what has to be true before a worker may retire.
 */
import assert from 'node:assert/strict';
import { sanitizeError, sanitizeOwner } from './report.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * A count the host actually answered.
 *
 * `null` is the host saying it could not read that evidence (RP-6 membership
 * that does not publish its view, for instance), and it stays `null`: folding
 * it into 0 would turn "unknown" into "nothing is attached", which is the
 * shape of every vacuous guard. A key that was never produced at all is still
 * 0, so a caller passing a partial row keeps its old meaning.
 */
function guardCount(value) {
  if (value === null) return null;
  return Number(value) || 0;
}

/**
 * Is this returned worker row evidence, or the worker saying it has none?
 *
 * `WORKER_COUNTERS_FN` answers `{ available: false, reason, …null }` when RP-4's
 * runtime table cannot be read. That is not a quiet worker: it is a worker that
 * did not answer, and it must be counted with the ones whose inspector call
 * threw. One predicate decides that, and every consumer — phase sampling and
 * the retirement guard alike — goes through it.
 */
export function workerEvidence(row) {
  if (row && row.kind === 'worker' && row.available === true) return { readable: true, row, reason: null };
  const reason = sanitizeOwner(
    row && typeof row.reason === 'string' && row.reason !== ''
      ? row.reason
      : row && row.available === false
        ? 'a worker returned no retained-state evidence'
        : 'a worker returned a counter row this harness does not recognise',
  );
  return { readable: false, row: row ?? null, reason };
}

/**
 * Split worker counter rows into evidence and reasons, in one place.
 * `unreadable` keeps bounded, sanitized, categorical sentences — never a path.
 */
export function partitionWorkerCounters(rows = []) {
  const readable = [];
  const unreadable = [];
  for (const row of rows) {
    const evidence = workerEvidence(row);
    if (evidence.readable) readable.push(evidence.row);
    else unreadable.push(evidence.reason);
  }
  return { readable, unreadable };
}

export function retirementGuardSnapshot(host = {}, workers = []) {
  // Unknown propagates: one worker that did not answer, or one null count,
  // makes the total unknown rather than a zero somebody could certify on.
  const sum = (key) => {
    let total = 0;
    for (const worker of workers) {
      if (!workerEvidence(worker).readable) return null;
      const value = worker?.[key];
      if (!Number.isInteger(value) || value < 0) return null;
      total += value;
    }
    return total;
  };
  const withHost = (hostValue, workerTotal) => (workerTotal === null ? null : (Number(hostValue) || 0) + workerTotal);
  return {
    productConnections: guardCount(host.connections),
    attachmentRefs: guardCount(host.attachmentRefs),
    attachedPaths: guardCount(host.attachedPaths),
    runningSessions: guardCount(host.runningSessions),
    liveRuns: guardCount(host.liveRuns),
    runningTasks: withHost(host.runningTasks, sum('runningTasks')),
    attentionDialogs: guardCount(host.attentionDialogs),
    pendingQuestions: sum('pendingQuestions'),
    pendingApprovals: sum('pendingApprovals'),
  };
}

/**
 * What one host reading says about RP-6 transcript membership, or why it says
 * nothing.
 *
 * The host projects `transcriptDelivery` from the canonical public view
 * (`counts()`, `paths()`, `admittedHolders()`); this is the harness side of
 * that contract. Evidence that is absent, refused or not a set of counts is
 * `available: false` with every number `null` — a caller must never read it as
 * "no connection is holding anything".
 */
export function deliveryCounts(host = {}) {
  const evidence = host.transcriptDelivery;
  const unavailable = reason => ({ available: false, reason, connections: Number.isInteger(evidence?.connections) ? evidence.connections : null,
    paths: null, owners: null, admittedOwners: null, loadingOwners: null });
  if (!evidence) return unavailable('the host reported no transcript delivery evidence');
  if (evidence.available !== true) return unavailable(evidence.reason ?? 'the host could not read its transcript delivery');
  if (![evidence.paths, evidence.owners, evidence.admittedOwners, evidence.loadingOwners].every(Number.isInteger)) {
    return unavailable('the transcript delivery evidence is not a set of counts');
  }
  return { available: true, reason: null, connections: evidence.connections ?? null,
    paths: evidence.paths, owners: evidence.owners, admittedOwners: evidence.admittedOwners, loadingOwners: evidence.loadingOwners };
}

export function liveWorkOf(snapshot = {}) {
  const { productConnections: _connections, attachmentRefs: _refs, attachedPaths: _paths, ...work } = snapshot;
  return work;
}

export function assertNoLiveWork(snapshot) {
  const work = liveWorkOf(snapshot);
  const unknown = Object.entries(work).filter(([, value]) => value === null).map(([name]) => name);
  assert.deepEqual(unknown, [], `retirement prerequisites are unknown, not settled: ${unknown.join(', ')} could not be read`);
  assert.deepEqual(work, {
    runningSessions: 0, liveRuns: 0, runningTasks: 0, attentionDialogs: 0,
    pendingQuestions: 0, pendingApprovals: 0,
  }, `retirement prerequisites are not settled: ${JSON.stringify(work)}`);
}

/**
 * Prove the retirement prerequisites, tolerating only the observation race: a
 * worker may exit between its identity-checked inspector connect and the
 * counter read, and a vanished worker is neither live work nor a zero. The
 * whole set is re-sampled within one explicit deadline until every currently
 * connected worker answered and every work count is zero.
 */
export async function proveNoLiveWork(sample, { deadlineMs = 15_000, now = () => Date.now(), sleepFor = sleep, pollMs = 250 } = {}) {
  const deadline = now() + deadlineMs;
  let attempts = 0;
  let last = { guards: retirementGuardSnapshot(), readable: 0, unreadable: ['no sample taken'] };
  while (true) {
    attempts += 1;
    last = await sample();
    const work = liveWorkOf(last.guards);
    // `0` only. `null` is a count nobody could read, and a retirement
    // prerequisite that was not read is not a prerequisite that was met.
    if (last.unreadable.length === 0 && Object.values(work).every(value => value === 0)) {
      assertNoLiveWork(last.guards);
      return { ...last, attempts };
    }
    if (now() >= deadline) break;
    await sleepFor(pollMs);
  }
  throw new Error('Retirement prerequisites were not provable before the guard deadline; '
    + `attempts=${attempts} readableWorkers=${last.readable} unreadableWorkers=${last.unreadable.length} `
    + `reasons=${JSON.stringify(last.unreadable.map(reason => sanitizeOwner(reason)))} guards=${JSON.stringify(last.guards)}`);
}

export async function traverseRetainedViews(check, sessions, workspaceSessions, expectedCount, { select } = {}) {
  const retained = [...sessions, ...workspaceSessions];
  assert.equal(retained.length, expectedCount, 'retirement traversal has the expected retained view count');
  assert.equal(new Set(retained.map(session => session.path)).size, expectedCount, 'retirement traversal paths are unique');
  const rank = session => session.kind === 'chat' ? 1 : 0;
  const ordered = retained.map((session, index) => ({ session, index })).sort((a, b) => rank(a.session) - rank(b.session) || a.index - b.index);
  for (const { session } of ordered) await select(check, session);
  const kinds = ordered.reduce((counts, { session }) => {
    counts[session.kind === 'chat' ? 'chat' : 'project'] += 1; return counts;
  }, { project: 0, chat: 0 });
  return { visited: ordered.length, unique: expectedCount, ...kinds };
}

/** Which retained views the app should have detached: everything but the current one. */
export function dormantViews(openPaths, currentPath) {
  return openPaths.filter(path => path !== currentPath);
}

/**
 * Delivery reconciliation for one session, tolerant of arrival order.
 *
 * A prompt produces two independent facts — the transcript grew, and the turn
 * finished — and they can be observed in either order, more than once, or from
 * a snapshot taken before either happened. This settles only when both hold in
 * the same observation, and reports what it saw when they never do.
 */
export async function reconcileDelivery(observe, { baselineEntries, deadlineMs = 60_000, pollMs = 250, now = () => Date.now(), sleepFor = sleep } = {}) {
  const deadline = now() + deadlineMs;
  let last = null;
  let sawGrowth = false;
  let sawTerminal = false;
  while (true) {
    const value = await observe();
    last = value;
    if (value.entries > baselineEntries) sawGrowth = true;
    if (value.streaming === false) sawTerminal = true;
    if (value.entries > baselineEntries && value.streaming === false) {
      return { entries: value.entries, grewBy: value.entries - baselineEntries, settled: true, attentionSeen: value.attention ?? null };
    }
    if (now() >= deadline) break;
    await sleepFor(pollMs);
  }
  throw new Error('Delivery to a reattached view was not reconciled: '
    + `baselineEntries=${baselineEntries} lastEntries=${last?.entries ?? 'none'} lastStreaming=${last?.streaming ?? 'unknown'} `
    + `sawGrowth=${sawGrowth} sawTerminal=${sawTerminal}`);
}

export function workerStatusCounts(workers) {
  return workers.reduce((counts, worker) => {
    const status = ['starting', 'ready', 'retiring', 'retired', 'crashed'].includes(worker.status) ? worker.status : 'other';
    counts[status] = (counts[status] ?? 0) + 1; return counts;
  }, {});
}

export async function waitForNaturalRetirement(check, timeoutMs, guards, { pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs; let statuses = {};
  while (Date.now() < deadline) {
    const workers = (await check.rpc('pi/worker/list', {})).workers;
    statuses = workerStatusCounts(workers);
    if (workers.every(worker => !['starting', 'ready'].includes(worker.status))) return workers;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for natural worker retirement; guards=${JSON.stringify(guards)} statuses=${JSON.stringify(statuses)}`);
}

export { sanitizeError };
