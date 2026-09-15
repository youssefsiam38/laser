/**
 * The contracts the resource soak's inspector projections have with the product
 * they read: RP-4's worker runtime table, RP-6's transcript membership, and one
 * captured connection's RP-7 pressure account. Each projection is the exact
 * function source the harness sends, evaluated here, plus a source pin so a
 * rename in the product fails a test instead of quietly returning zeros.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONNECTION_PRESSURE_FN, CONNECTION_TARGET_FN, HOST_COUNTERS_FN, WORKER_COUNTERS_FN,
  captureConnectionTarget, connectionPressure, scalarCounters,
} from '../resource/inspector.mjs';
import { assertRedacted } from '../resource/report.mjs';
import { assertNoLiveWork, deliveryCounts, partitionWorkerCounters, proveNoLiveWork, retirementGuardSnapshot, workerEvidence } from '../resource/retirement.mjs';
import { SoakRun } from '../resource/context.mjs';
import { modeConfig, expected } from '../resource/config.mjs';

// --- worker retained-state projection (RP-4's runtime table) ------------------

const CHECKOUT = new URL('../../../', import.meta.url);
const projectWorker = new Function(`return ${WORKER_COUNTERS_FN}`)();

/**
 * The real table and replay buffer when the worker is built, and stand-ins with
 * exactly the API the projection reads when it is not. The pin test below keeps
 * the stand-ins honest against the product source.
 */
async function workerRuntimeParts() {
  try {
    const [runtimes, replay] = await Promise.all([
      import(new URL('packages/worker/dist/session-runtimes.js', CHECKOUT).href),
      import(new URL('packages/worker/dist/replay-buffer.js', CHECKOUT).href),
    ]);
    return { SessionRuntimes: runtimes.SessionRuntimes, ReplayBuffer: replay.ReplayBuffer, source: 'the built worker' };
  } catch {
    class SessionRuntimes {
      #table = new Map();
      get size() { return this.#table.size; }
      values() { return this.#table.values(); }
      attach(live) { this.#table.set(live.path, live); }
      openPaths() { return []; }
      releasingPaths() { return []; }
      get fenced() { return false; }
      get retiring() { return false; }
    }
    class ReplayBuffer {
      #entries = new Map(); #bytes = 0;
      get size() { return this.#entries.size; }
      get bytes() { return this.#bytes; }
      push(value) { this.#entries.set(value.seq, value); this.#bytes += Buffer.byteLength(JSON.stringify(value)); }
    }
    return { SessionRuntimes, ReplayBuffer, source: 'source-shaped stand-ins (worker not built)' };
  }
}

function liveSession(path, { entries = 3, buffer, pending = [] } = {}) {
  const manager = entries === null ? undefined : { getEntries: () => Array.from({ length: entries }, (_, index) => ({ id: `entry-${index}` })) };
  return { path, buffer, driver: { runtime: manager ? { session: { sessionManager: manager } } : undefined, pendingUi: () => pending } };
}

test('worker counters read RP-4’s runtime table and report real sessions, entries and replay', async () => {
  const { SessionRuntimes, ReplayBuffer, source } = await workerRuntimeParts();
  const runtimes = new SessionRuntimes();
  const buffers = [new ReplayBuffer(100, 1024 * 1024), new ReplayBuffer(100, 1024 * 1024)];
  buffers[0].push({ seq: 1, sessionId: 'a', update: { kind: 'text_delta', delta: 'hello' } });
  buffers[0].push({ seq: 2, sessionId: 'a', update: { kind: 'text_delta', delta: 'again' } });
  buffers[1].push({ seq: 1, sessionId: 'b', update: { kind: 'text_delta', delta: 'x' } });
  runtimes.attach(liveSession('/p/one.jsonl', { entries: 12, buffer: buffers[0], pending: [{ id: 'q1' }, { id: 'a1', toolCallId: 't1' }] }));
  runtimes.attach(liveSession('/p/two.jsonl', { entries: 7, buffer: buffers[1] }));
  const value = projectWorker.call({
    runtimes,
    tasks: { bySession: new Map([['/p/one.jsonl', new Map([['t', { status: 'running' }], ['u', { status: 'exited' }]])]]) },
    runningTools: new Map([['/p/one.jsonl', new Set(['tool-1'])]]),
  });
  assert.equal(value.available, true, `projection unavailable against ${source}`);
  assert.equal(value.sessions, 2, `sessions must come from the runtime table (${source})`);
  assert.equal(value.entries, 19);
  assert.equal(value.entriesUnreadable, 0);
  assert.equal(value.replayCount, 3);
  assert.ok(value.replayBytes > 0, 'replay bytes are the buffers’ own account, never a zero');
  assert.deepEqual([value.tasks, value.runningTasks, value.runningTools], [2, 1, 1]);
  assert.deepEqual([value.pendingQuestions, value.pendingApprovals], [1, 1]);
  assert.deepEqual([value.opening, value.releasing, value.fenced, value.retiring], [0, 0, false, false]);
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /one\.jsonl|two\.jsonl|entry-0|hello/, 'the projection carries counts, never an identity or content');
});

test('a live runtime whose entry count cannot be read is null, never a zero', async () => {
  const { SessionRuntimes, ReplayBuffer } = await workerRuntimeParts();
  const runtimes = new SessionRuntimes();
  const buffer = new ReplayBuffer(100, 1024 * 1024);
  buffer.push({ seq: 1, sessionId: 'a', update: { kind: 'state' } });
  runtimes.attach(liveSession('/p/open.jsonl', { entries: 5, buffer }));
  // A session whose engine runtime is not built yet: absent evidence, not zero.
  runtimes.attach(liveSession('/p/opening.jsonl', { entries: null, buffer }));
  const value = projectWorker.call({ runtimes });
  assert.equal(value.sessions, 2, 'the sessions it holds are still known exactly');
  assert.equal(value.entries, null, 'an incomplete entry total is unavailable, never a false sum');
  assert.deepEqual([value.entriesKnown, value.entriesReadable, value.entriesUnreadable], [5, 1, 1]);
  assert.equal(value.entriesSource, 'engine session manager');
  assert.equal(value.replayCount, 2, 'replay stayed readable for both rows');
});

test('a worker without RP-4’s runtime table is unavailable, never a row of zeros', () => {
  // The exact regression M18-T8 found: the projection used to read `sessions`,
  // which T4 removed, and reported every retained count as 0.
  const legacy = projectWorker.call({ sessions: new Map([['/p/one.jsonl', { driver: {}, buffer: { size: 4, bytes: 99 } }]]) });
  assert.equal(legacy.available, false);
  assert.match(legacy.reason, /runtime table unavailable/);
  assert.deepEqual([legacy.sessions, legacy.entries, legacy.replayCount, legacy.replayBytes], [null, null, null, null]);
  const broken = projectWorker.call({ runtimes: { size: 1, values() { throw new Error('table torn down'); } } });
  assert.equal(broken.available, false);
  assert.deepEqual([broken.sessions, broken.entries, broken.replayCount], [null, null, null]);
});

test('the worker projection names fields the worker source really has', async () => {
  const read = async path => readFile(new URL(path, CHECKOUT), 'utf8');
  const server = await read('packages/worker/src/server.ts');
  assert.match(server, /private readonly runtimes: SessionRuntimes<Live>/, 'WorkerServer.runtimes is the table the projection reads');
  assert.doesNotMatch(server, /private readonly sessions\b/, 'the removed `sessions` map must not come back unnoticed');
  assert.match(server, /buffer: ReplayBuffer/, 'a Live row carries its replay buffer as `buffer`');
  assert.match(server, /private readonly tasks = new TaskIndex\(\)/);
  assert.match(server, /private readonly runningTools = new Map/);
  const table = await read('packages/worker/src/session-runtimes.ts');
  for (const member of [/values\(\): IterableIterator<Live>/, /get size\(\): number/, /openPaths\(\): string\[\]/, /releasingPaths\(\): string\[\]/, /get fenced\(\): boolean/, /get retiring\(\): boolean/]) {
    assert.match(table, member, `SessionRuntimes must still expose ${member}`);
  }
  const replay = await read('packages/worker/src/replay-buffer.ts');
  assert.match(replay, /get bytes\(\): number/);
  assert.match(replay, /get size\(\): number/);
  const driver = await read('packages/worker/src/drivers/stable-sdk.ts');
  assert.match(driver, /sessionManager\.getEntries\(\)/, 'the entry count is the engine’s own synchronous accessor');
  assert.match(driver, /private runtime: AgentSessionRuntime \| undefined/);
  const tasks = await read('packages/worker/src/agents/tasks.ts');
  assert.match(tasks, /private readonly bySession = new Map/);
});

test('scalar counters send the host or worker projection and return its value', async () => {
  const sent = [];
  const client = { async send(method, params) { sent.push([method, params]); return { result: { value: { kind: 'ok' } } }; } };
  await scalarCounters(client, 'instance-1', 'worker');
  await scalarCounters(client, 'instance-1', 'host');
  assert.equal(sent[0][1].functionDeclaration, WORKER_COUNTERS_FN);
  assert.match(sent[1][1].functionDeclaration, /kind:'host'/);
  assert.equal(sent[0][1].arguments, undefined, 'a counter read passes no arguments at all');
  await connectionPressure(client, 'instance-1', 'socket-7');
  assert.deepEqual(sent.at(-1)[1].arguments, [{ objectId: 'socket-7' }], 'a connection reading passes the captured object and nothing else');
});

// --- host transcript membership (RP-6) ----------------------------------------

const projectHost = new Function(`return ${HOST_COUNTERS_FN}`)();

/** The real per-connection delivery record when the host is built. */
async function transcriptDeliveryClass() {
  const module = await import(new URL('packages/host/dist/transcript-delivery.js', CHECKOUT).href);
  return module.TranscriptDelivery;
}

const load = (id, path, owner) => ({ jsonrpc: '2.0', id, method: 'session/load', params: owner ? { path, owner } : { path } });
const detach = (id, path, owner) => ({ jsonrpc: '2.0', id, method: 'pi/session/detach', params: owner ? { path, owner } : { path } });
const hostWithDeliveries = deliveries => ({
  clients: new Set(deliveries.map((_, index) => ({ bufferedAmount: 0, readyState: 1, _socket: { remotePort: 50_000 + index } }))),
  transcripts: new Map(deliveries.map((delivery, index) => [index, delivery])),
  loadDeliveries: new Map(),
});

test('host attachment and delivery rows are read from the RP-6 membership view of a real connection', async () => {
  const TranscriptDelivery = await transcriptDeliveryClass();
  const delivery = new TranscriptDelivery();
  const path = '/scratch/sessions/session-abcdef.jsonl';
  const other = '/scratch/sessions/session-ghijkl.jsonl';
  const empty = projectHost.call(hostWithDeliveries([delivery]));
  assert.deepEqual([empty.transcriptLoaded, empty.transcriptLoading, empty.transcriptPaths, empty.attachmentRefs, empty.attachedPaths], [0, 0, 0, 0, 0]);
  assert.equal(empty.transcriptDelivery.available, true, 'a connection holding nothing is a measured zero');

  // Attached: one admitted surface, one still loading, on two conversations.
  delivery.begin(load(1, path)).finish({ jsonrpc: '2.0', id: 1, result: {} });
  delivery.begin(load(2, path, 'beam'));
  delivery.begin(load(3, other)).finish({ jsonrpc: '2.0', id: 3, result: {} });
  const attached = projectHost.call(hostWithDeliveries([delivery]));
  assert.deepEqual([attached.transcriptLoaded, attached.transcriptLoading, attached.transcriptPaths], [2, 1, 2],
    `admitted, loading and retained counts: ${JSON.stringify(attached.transcriptDelivery)}`);
  assert.deepEqual([attached.attachmentRefs, attached.attachedPaths], [3, 2], 'an attachment is a membership hold');
  assert.equal(attached.transcriptDelivery.connections, 1);
  assert.doesNotMatch(JSON.stringify(attached), /session-|scratch|jsonl/, 'the projection counts paths, it never carries one');
  assert.doesNotThrow(() => assertRedacted(JSON.stringify(attached.transcriptDelivery)));

  // Two connections holding the same conversation: owners add up, the path is
  // counted once.
  const second = new TranscriptDelivery();
  second.begin(load(4, path)).finish({ jsonrpc: '2.0', id: 4, result: {} });
  const both = projectHost.call(hostWithDeliveries([delivery, second]));
  assert.deepEqual([both.transcriptLoaded, both.attachmentRefs, both.attachedPaths, both.transcriptDelivery.connections], [3, 4, 2, 2]);

  // Detached: the same counters come back down, on the real release path.
  for (const [id, target, owner] of [[5, path], [6, path, 'beam'], [7, other]]) delivery.begin(detach(id, target, owner));
  const released = projectHost.call(hostWithDeliveries([delivery]));
  assert.deepEqual([released.transcriptLoaded, released.transcriptLoading, released.transcriptPaths, released.attachmentRefs, released.attachedPaths], [0, 0, 0, 0, 0]);
  assert.equal(released.transcriptDelivery.available, true);
});

test('membership evidence the host cannot read is null everywhere, never an empty host', () => {
  const partial = { counts: () => ({ paths: 1, owners: 1 }), paths: () => ['/scratch/sessions/session-abcdef.jsonl'].values() };
  const stale = projectHost.call(hostWithDeliveries([partial]));
  assert.equal(stale.transcriptDelivery.available, false);
  assert.match(stale.transcriptDelivery.reason, /does not publish the membership view/);
  assert.deepEqual([stale.transcriptLoaded, stale.transcriptLoading, stale.transcriptPaths, stale.attachmentRefs, stale.attachedPaths], [null, null, null, null, null]);
  assert.equal(stale.connections, 1, 'the connections it can count are still counted');

  const missing = projectHost.call({ clients: new Set(), loadDeliveries: new Map() });
  assert.equal(missing.transcriptDelivery.available, false);
  assert.match(missing.transcriptDelivery.reason, /no per-connection transcript delivery table/);
  assert.deepEqual([missing.attachmentRefs, missing.attachedPaths, missing.transcriptLoaded], [null, null, null]);

  const throwing = { counts: () => ({ paths: 1, owners: 1 }), paths: () => { throw new Error('torn down'); }, admittedHolders: () => 1 };
  const failed = projectHost.call(hostWithDeliveries([throwing]));
  assert.equal(failed.transcriptDelivery.available, false);
  assert.match(failed.transcriptDelivery.reason, /could not be read/);
  assert.equal(failed.transcriptLoaded, null);

  // The harness side of the same contract, and the guard that reads it.
  assert.deepEqual(deliveryCounts(stale), { available: false, reason: stale.transcriptDelivery.reason, connections: 1, paths: null, owners: null, admittedOwners: null, loadingOwners: null });
  assert.equal(deliveryCounts({}).available, false);
  assert.equal(deliveryCounts({ transcriptDelivery: { available: true, connections: 1, paths: 1, owners: 1, admittedOwners: 1, loadingOwners: null } }).available, false);
  const guards = retirementGuardSnapshot(stale);
  assert.deepEqual([guards.attachmentRefs, guards.attachedPaths], [null, null], 'an unreadable attachment count must not become zero');
  assert.equal(guards.productConnections, 1);
  assert.equal(retirementGuardSnapshot({ connections: 2, attachmentRefs: 3, attachedPaths: 2 }).attachedPaths, 2);
  assert.equal(retirementGuardSnapshot().attachedPaths, 0, 'a row that never carried the key keeps its old meaning');
});

test('the host projection names fields the host source really has', async () => {
  const read = async path => readFile(new URL(path, CHECKOUT), 'utf8');
  const server = await read('packages/host/src/server.ts');
  assert.match(server, /private readonly transcripts = new Map<WebSocket, TranscriptDelivery>/);
  assert.doesNotMatch(server, /private readonly attached\b/, 'the removed attachment map must not come back unnoticed');
  const delivery = await read('packages/host/src/transcript-delivery.ts');
  for (const member of [/counts\(\): \{ paths: number; owners: number \}/, /paths\(\): IterableIterator<string>/, /admittedHolders\(path: string\): number/]) {
    assert.match(delivery, member, `TranscriptDelivery must still expose ${member}`);
  }
  assert.doesNotMatch(delivery, /private readonly (?:loaded|loading)\b/, 'the maps the old projection read are gone for good');
  // The projection reads the published view and nothing behind it.
  assert.doesNotMatch(HOST_COUNTERS_FN, /\.members\b/, 'the private membership table is not the harness’s to read');
  assert.doesNotMatch(HOST_COUNTERS_FN, /\.loaded\b|\.loading\b|s\.attached\b/);
  assert.match(HOST_COUNTERS_FN, /admittedHolders/);
});

// --- one captured connection’s pressure account (RP-7) -----------------------

const projectTarget = new Function(`return ${CONNECTION_TARGET_FN}`)();
const projectConnection = new Function(`return ${CONNECTION_PRESSURE_FN}`)();

function hostWithConnections(rows) {
  const sockets = rows.map(row => ({
    bufferedAmount: row.bufferedAmount ?? 0,
    readyState: row.readyState ?? 1,
    _socket: { remotePort: row.port, bytesWritten: row.bytesWritten ?? 0 },
  }));
  const pressure = new Map();
  sockets.forEach((ws, index) => {
    const spec = rows[index].pressure;
    if (spec === null) return;
    pressure.set(ws, {
      fenced: spec?.state === 'fenced',
      snapshot: () => ({ state: 'flowing', queuedBytes: 0, socketBufferedBytes: 0, highWaterBytes: 0, inFlight: 0, shed: { total: 0, byMethod: {} }, ...spec }),
    });
  });
  return { clients: new Set(sockets), pressure, sockets };
}

test('a connection is admitted by its port exactly once, and the object itself is what is captured', () => {
  const host = hostWithConnections([{ port: 40_001, pressure: {} }, { port: 40_002, pressure: {} }]);
  assert.equal(projectTarget.call(host, 40_002), host.sockets[1], 'the live socket object is returned, not a description of it');
  assert.throws(() => projectTarget.call(host, 40_009), /No host connection was open from that loopback port/);
  assert.throws(() => projectTarget.call(hostWithConnections([{ port: 40_003, pressure: {} }, { port: 40_003, pressure: {} }]), 40_003),
    /More than one host connection was open from that loopback port/);
});

test('capturing a connection holds a remote object and reads every sample through it', async () => {
  const sent = [];
  const client = {
    async send(method, params) {
      sent.push([method, params]);
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === CONNECTION_TARGET_FN) return { result: { objectId: 'socket-7' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { readable: true, present: true } } };
      return {};
    },
  };
  const target = await captureConnectionTarget(client, 'host-1', 54_321);
  assert.deepEqual(sent[0][1].arguments, [{ value: 54_321 }], 'the port is used once, to admit');
  assert.equal(typeof sent[0][1].objectGroup, 'string', 'the handle lives in a group this harness can release');
  await target.read();
  assert.equal(sent[1][1].functionDeclaration, CONNECTION_PRESSURE_FN);
  assert.deepEqual(sent[1][1].arguments, [{ objectId: 'socket-7' }], 'every reading is of the captured object');
  assert.equal(sent[1][1].objectId, 'host-1');
  await target.release();
  assert.deepEqual(sent.at(-1), ['Runtime.releaseObjectGroup', { objectGroup: target.group }]);
  assert.doesNotMatch(JSON.stringify({ read: await target.read() }), /socket-7/, 'no object id reaches anything reportable');

  await assert.rejects(captureConnectionTarget(client, 'host-1', '54321'), /integer loopback port/);
  await assert.rejects(captureConnectionTarget({ send: async () => ({ exceptionDetails: { exception: { description: 'Error: No host connection was open from that loopback port.\n  at x' } } }) }, 'host-1', 1),
    /No host connection was open from that loopback port/);
  await assert.rejects(captureConnectionTarget({ send: async () => ({ result: { value: 3 } }) }, 'host-1', 1), /not returned as an object/);
  await assert.rejects(connectionPressure(client, 'host-1', ''), /needs the captured connection object/);
});

test('the pressure reading is about the captured object and the host’s own membership', () => {
  const host = hostWithConnections([
    { port: 40_001, bufferedAmount: 0, pressure: { state: 'flowing' } },
    { port: 40_002, bufferedAmount: 1_024, pressure: { state: 'shedding', queuedBytes: 2_048, highWaterBytes: 4_096, shed: { total: 3, byMethod: {} } } },
  ]);
  const target = projectTarget.call(host, 40_002);
  const queued = projectConnection.call(host, target);
  assert.deepEqual([queued.readable, queued.present, queued.connections], [true, true, 2]);
  assert.equal(queued.connection.pendingBytes, 2_048, 'pending bytes take the larger of the socket and the account, never their sum');
  assert.deepEqual([queued.connection.accountedBytes, queued.connection.socketBufferedBytes, queued.connection.highWaterBytes], [2_048, 1_024, 4_096]);
  assert.deepEqual([queued.connection.state, queued.connection.shed, queued.connection.tracked], ['shedding', 3, true]);
  assert.equal(queued.totalBufferedBytes, 1_024);
  assert.doesNotMatch(JSON.stringify(queued), /4000[12]|remotePort/, 'the answer carries no port, address or identity');

  const fencedHost = hostWithConnections([{ port: 40_004, readyState: 2, pressure: { state: 'fenced', highWaterBytes: 16 * 1024 * 1024 } }]);
  const fenced = projectConnection.call(fencedHost, projectTarget.call(fencedHost, 40_004));
  assert.deepEqual([fenced.present, fenced.connection.state, fenced.connection.fenced, fenced.connection.readyState], [true, 'fenced', true, 2]);

  const untrackedHost = hostWithConnections([{ port: 40_005, bufferedAmount: 7, pressure: null }]);
  const untracked = projectConnection.call(untrackedHost, projectTarget.call(untrackedHost, 40_005));
  assert.deepEqual([untracked.connection.state, untracked.connection.accountedBytes, untracked.connection.pendingBytes, untracked.connection.tracked], [null, null, 7, false]);

  const unreadable = projectConnection.call({ clients: [] }, { bufferedAmount: 0 });
  assert.deepEqual([unreadable.readable, unreadable.present], [false, null]);
  assert.match(unreadable.reason, /client registry/);
  assert.equal(projectConnection.call(hostWithConnections([]), undefined).readable, false);
});

test('a dropped connection stays dropped, whatever the kernel does with its port afterwards', () => {
  for (const reuse of [{ label: 'an equal byte counter', bytesWritten: 1_000 }, { label: 'a higher byte counter', bytesWritten: 9_999 }]) {
    const host = hostWithConnections([{ port: 40_010, bufferedAmount: 16, bytesWritten: 1_000, pressure: { state: 'flowing', queuedBytes: 16 } }]);
    const target = projectTarget.call(host, 40_010);
    assert.equal(projectConnection.call(host, target).present, true);

    // The host drops the captured socket, and the kernel hands the same port to
    // another client that is writing happily.
    host.clients.delete(target);
    host.pressure.delete(target);
    const replacement = { bufferedAmount: 1, readyState: 1, _socket: { remotePort: 40_010, bytesWritten: reuse.bytesWritten } };
    host.clients.add(replacement);
    host.pressure.set(replacement, { fenced: false, snapshot: () => ({ state: 'flowing', queuedBytes: 1, socketBufferedBytes: 1, highWaterBytes: 1, inFlight: 0, shed: { total: 0, byMethod: {} } }) });

    const after = projectConnection.call(host, target);
    assert.equal(after.present, false, `${reuse.label} on a reused port must not resurrect the captured connection`);
    assert.equal(after.readable, true, 'the host could answer; the answer is that it no longer holds this one');
    assert.equal(after.connection.tracked, false, 'a dropped connection has no pressure account left');
    assert.equal(after.totalBufferedBytes, 1, 'the replacement is somebody else’s byte backlog');
  }
});

test('the host still fences a slow direct connection with 1013', async () => {
  const source = await readFile(new URL('packages/host/src/server.ts', CHECKOUT), 'utf8');
  assert.match(source, /ws\.close\(1013, "reconnect to catch up"\)/, 'the byte fence closes with the code the harness proves');
  assert.match(source, /private readonly pressure = new Map<WebSocket, OutboundPressure>/, 'per-connection pressure is the map the projection reads');
  assert.match(source, /private dropClient\(ws: WebSocket\): void \{\n    this\.clients\.delete\(ws\);/, 'a fenced connection really leaves this.clients');
  const pressure = await readFile(new URL('packages/host/src/transport-pressure.ts', CHECKOUT), 'utf8');
  assert.match(pressure, /snapshot\(\): PressureSnapshot/);
  assert.match(pressure, /get fenced\(\): boolean/);
});


// --- the worker-evidence boundary, through the two consumers that read it -----

/**
 * One inspector client that answers the host projection, and one that answers
 * whatever worker row a test asks for. Nothing else is faked: `scalarCounters`,
 * `sampleRetirementGuards()`, `samplePhase()` and `proveNoLiveWork()` are the
 * real ones.
 */
function inspectorClients(workerRow) {
  const host = { kind: 'host', connections: 0, attachmentRefs: 0, attachedPaths: 0, runningSessions: 0, liveRuns: 0,
    runningTasks: 0, attentionDialogs: 0, transcriptDelivery: { available: true, reason: null, connections: 0, paths: 0, owners: 0, admittedOwners: 0, loadingOwners: 0 },
    transcriptLoaded: 0, transcriptLoading: 0, transcriptPaths: 0, tasks: 0, workers: 0 };
  const client = kind => ({
    async send(method, params = {}) {
      if (method === 'Runtime.callFunctionOn') return { result: { value: kind === 'host' ? host : workerRow } };
      if (method === 'Runtime.queryObjects') throw new Error('TailBuffer instances were not queryable.');
      if (method === 'Runtime.evaluate') return { result: { objectId: 'published-1' } };
      return {};
    },
    on: () => () => {},
    async close() {},
  });
  return { host: client('host'), worker: client('worker') };
}

function guardRun(workerRow) {
  const config = modeConfig('quick');
  const report = { mode: 'quick', startedAtMs: Date.now(), phases: [], rankings: {}, slopes: {}, scenarios: {} };
  const check = {
    root: '/tmp/ignored',
    fixture: { hostRecord: { pid: 1234 }, inspectDir: '/tmp/ignored' },
    async rpc() {
      return { snapshot: { processes: [], totals: { coverage: 'complete', knownPhysicalBytes: 0, physical: { value: 0 } }, byRole: [], health: { collectors: [], crossCheck: { status: 'ok' } } } };
    },
    page: { url: () => 'about:blank' },
  };
  const run = new SoakRun(check, { config, expected: expected(config), report, modules: { host: 'h', worker: 'w', tail: 't' }, mode: 'quick', checkout: '/tmp/ignored' });
  const clients = inspectorClients(workerRow);
  run.inspectorSet = async () => ({
    records: [], host: { record: { pid: 1234 }, client: clients.host, handle: { objectId: 'h', group: 'g' } },
    workers: [{ record: { pid: 2, startToken: 't' }, client: clients.worker, handle: { objectId: 'w', group: 'g' } }],
    unreadableWorkers: [],
  });
  run.closeInspectorSet = async () => {};
  run.census = { take: async () => ({ rows: [{ pid: 1234, startToken: 't', pssBytes: 10, privateResidentBytes: 5 }], unreadable: [], exited: [], replaced: [], missingRequired: [],
    coverage: { scope: 'test', expected: 1, measured: 1, complete: true, unreadableProcesses: 0, exitedProcesses: 0, replacedProcesses: 0, includedRoles: ['host'], excludedRoles: [], note: 'test' } }) };
  return { run, report };
}

const unavailableWorkerRow = {
  kind: 'worker', available: false, reason: 'worker session runtime table unavailable',
  sessions: null, opening: null, releasing: null, retiring: null, fenced: null,
  entries: null, entriesKnown: null, entriesReadable: 0, entriesUnreadable: 0,
  replayCount: null, replayBytes: null, tasks: null, runningTasks: null, runningTools: null,
  pendingQuestions: null, pendingApprovals: null,
};
const readableWorkerRow = {
  kind: 'worker', available: true, reason: null, sessions: 1, opening: 0, releasing: 0, retiring: false, fenced: false,
  entries: 3, entriesKnown: 3, entriesReadable: 1, entriesUnreadable: 0, replayCount: 0, replayBytes: 0,
  tasks: 0, runningTasks: 0, runningTools: 0, pendingQuestions: 0, pendingApprovals: 0,
};

test('a worker that answers "no evidence" is unreadable, in one place, for every consumer', () => {
  assert.equal(workerEvidence(readableWorkerRow).readable, true);
  assert.equal(workerEvidence(unavailableWorkerRow).readable, false);
  assert.equal(workerEvidence(unavailableWorkerRow).reason, 'worker session runtime table unavailable');
  assert.equal(workerEvidence({ kind: 'worker', available: false }).reason, 'a worker returned no retained-state evidence');
  assert.equal(workerEvidence(undefined).readable, false);
  assert.match(workerEvidence({}).reason, /does not recognise/);
  assert.equal(workerEvidence({ kind: 'worker', available: false, reason: '/home/person/project/worker.js is gone' }).reason.includes('/home/person'), false);
  const split = partitionWorkerCounters([readableWorkerRow, unavailableWorkerRow]);
  assert.deepEqual([split.readable.length, split.unreadable.length], [1, 1]);

  const guards = retirementGuardSnapshot({ connections: 0 }, [unavailableWorkerRow]);
  assert.deepEqual([guards.runningTasks, guards.pendingQuestions, guards.pendingApprovals, guards.runningTools], [null, null, null, null],
    'a worker that did not answer makes the totals unknown, never zero');
  assert.throws(() => assertNoLiveWork(guards), /unknown, not settled/);
  assert.deepEqual(retirementGuardSnapshot({ connections: 0 }, [readableWorkerRow]).runningTools, 0);
  const malformed = { ...readableWorkerRow };
  delete malformed.runningTools;
  assert.equal(retirementGuardSnapshot({ connections: 0 }, [malformed]).runningTools, null,
    'a readable row missing a required guard is unknown, never zero');
  assert.equal(retirementGuardSnapshot({ connections: 0 }, [{ available: true }]).runningTasks, null,
    'an unrecognised available row is unknown, never zero');
});

test('sampleRetirementGuards and proveNoLiveWork refuse a worker without evidence', async () => {
  const refusing = guardRun(unavailableWorkerRow).run;
  const sampled = await refusing.sampleRetirementGuards();
  assert.equal(sampled.readable, 0, 'an all-null row must not count as a readable worker');
  assert.deepEqual(sampled.unreadable, ['worker session runtime table unavailable']);
  assert.equal(sampled.guards.runningTools, null);
  await assert.rejects(
    proveNoLiveWork(() => refusing.sampleRetirementGuards(), { deadlineMs: 0, sleepFor: async () => {} }),
    error => {
      assert.match(error.message, /readableWorkers=0 unreadableWorkers=1/);
      assert.match(error.message, /runtime table unavailable/);
      assert.doesNotThrow(() => assertRedacted(error.message));
      return true;
    });

  const proving = guardRun(readableWorkerRow).run;
  const proved = await proveNoLiveWork(() => proving.sampleRetirementGuards(), { deadlineMs: 0, sleepFor: async () => {} });
  assert.deepEqual([proved.readable, proved.unreadable.length], [1, 0]);
  assert.equal(proved.guards.runningTools, 0);
});

test('a phase counts a no-evidence worker as unreadable, never as a row of zeros', async () => {
  const { run, report } = guardRun(unavailableWorkerRow);
  const phase = await run.samplePhase('evidence', { pageClosed: true });
  assert.equal(phase.workers.length, 0, 'an unavailable row is not worker evidence');
  assert.equal(phase.unreadableWorkers, 1);
  assert.deepEqual(phase.unreadableWorkerReasons, ['worker session runtime table unavailable']);
  assert.doesNotThrow(() => assertRedacted(JSON.stringify(phase.unreadableWorkerReasons)));
  const readable = await guardRun(readableWorkerRow).run.samplePhase('evidence', { pageClosed: true });
  assert.deepEqual([readable.workers.length, readable.unreadableWorkers], [1, 0]);
  assert.equal(report.phases.length, 1);
});
