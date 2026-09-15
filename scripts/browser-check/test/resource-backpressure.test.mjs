/**
 * Scenario 8's state machine: which of RP-7's two containment outcomes the
 * harness accepts for the one connection it captured, and everything it still
 * refuses — a connection the host dropped without the byte fence's closure, an
 * unreadable reading, a queue that stayed at zero, and the deadline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { SAFETY } from '../resource/config.mjs';
import { assertRedacted } from '../resource/report.mjs';
import { FENCE_CLOSE_CODE, classifyConnection, observeBackpressure, watchFenceClosure } from '../resource/backpressure.mjs';
import { slowConsumerLoad, withStalledClient } from '../resource/scenarios/08-slow-consumer.mjs';

const CHECKOUT = new URL('../../../', import.meta.url);

// --- the two containment outcomes scenario 8 accepts --------------------------

/** What `CONNECTION_PRESSURE_FN` says about the captured object, sample by sample. */
const connectionView = (over = {}) => ({
  readable: true, reason: null, present: true, connections: 3, totalBufferedBytes: 0,
  connection: { readyState: 1, pendingBytes: 0, socketBufferedBytes: 0, accountedBytes: 0, highWaterBytes: 0,
    state: 'flowing', fenced: false, inFlight: 0, shed: 0, tracked: true },
  ...over,
});
/** The host no longer holds the captured object — whatever else is on its port. */
const goneView = (over = {}) => ({
  readable: true, reason: null, present: false, connections: 2, totalBufferedBytes: 0,
  connection: { readyState: 3, pendingBytes: 0, socketBufferedBytes: 0, accountedBytes: null, highWaterBytes: null,
    state: null, fenced: null, inFlight: null, shed: null, tracked: false },
  ...over,
});
const sampler = views => { let index = 0; return async () => views[Math.min(index++, views.length - 1)]; };
const fakeClosure = value => ({ prove: async () => ({ observed: value !== null, code: value, reason: value === null ? null : 'reconnect to catch up' }) });
const observeOptions = { ceilingBytes: SAFETY.socketBufferedBytes, deadlineMs: 1_000, sleepFor: async () => {}, pollMs: 0 };
/** A clock that always reaches the deadline, so a timeout test costs no wall time. */
const advancingClock = () => { let value = 0; return () => (value += 400); };

test('a bounded positive pending-byte peak on the captured connection is the queued outcome', async () => {
  const result = await observeBackpressure({
    ...observeOptions,
    sample: sampler([
      connectionView(),
      connectionView({ connection: { ...connectionView().connection, pendingBytes: 3 * 1024 * 1024, accountedBytes: 3 * 1024 * 1024, socketBufferedBytes: 1_024, highWaterBytes: 3 * 1024 * 1024, state: 'shedding' } }),
    ]),
    closure: fakeClosure(null),
  });
  assert.equal(result.mechanism, 'queued');
  assert.equal(result.peakBytes, 3 * 1024 * 1024);
  assert.equal(result.evidence.pressureState, 'shedding');
  assert.equal(result.samples, 2);
  assert.doesNotThrow(() => assertRedacted(JSON.stringify(result)));
});

test('this socket’s own fenced pressure state is containment, with its closure recorded', async () => {
  const fenced = { ...connectionView().connection, readyState: 2, state: 'fenced', fenced: true, highWaterBytes: 16 * 1024 * 1024 };
  const result = await observeBackpressure({ ...observeOptions, sample: sampler([connectionView(), connectionView({ connection: fenced })]), closure: fakeClosure(FENCE_CLOSE_CODE) });
  assert.equal(result.mechanism, 'fenced');
  assert.equal(result.evidence.pressureState, 'fenced');
  assert.equal(result.evidence.highWaterBytes, 16 * 1024 * 1024);
  assert.deepEqual([result.evidence.closeCode, result.evidence.closeCodeRequired], [1013, false]);
  // The state is this connection's own, so an unobserved closure does not undo it.
  const quiet = await observeBackpressure({ ...observeOptions, sample: sampler([connectionView({ connection: fenced })]), closure: fakeClosure(null) });
  assert.equal(quiet.mechanism, 'fenced');
  assert.deepEqual([quiet.evidence.closeCode, quiet.evidence.closeObserved], [null, false]);
});

test('a removed connection counts only when this socket really received the 1013 fence closure', async () => {
  const removed = await observeBackpressure({ ...observeOptions, sample: sampler([connectionView(), goneView()]), closure: fakeClosure(FENCE_CLOSE_CODE) });
  assert.equal(removed.mechanism, 'fenced');
  assert.deepEqual([removed.evidence.closeCode, removed.evidence.closeCodeRequired, removed.evidence.pressureState], [1013, true, null]);
  for (const code of [1006, 1000, null]) {
    await assert.rejects(
      observeBackpressure({ ...observeOptions, sample: sampler([connectionView(), goneView()]), closure: fakeClosure(code) }),
      error => {
        assert.match(error.message, /merely disappeared is not containment/);
        assert.doesNotThrow(() => assertRedacted(error.message));
        return true;
      },
      `close code ${code} must not pass as containment`);
  }
});

test('a port the kernel reuses is never the captured connection, whatever its byte counters say', async () => {
  // The host dropped the captured object and another client is now writing from
  // the same port with an equal, then a higher, byte count. Identity is the
  // object, so both are the same answer: this connection is gone, and only its
  // own 1013 closure makes that containment.
  for (const reused of [1, 4_096]) {
    const replaced = sampler([connectionView(), goneView({ connections: 3, totalBufferedBytes: reused })]);
    await assert.rejects(observeBackpressure({ ...observeOptions, sample: replaced, closure: fakeClosure(1006) }),
      /merely disappeared is not containment/);
    const contained = await observeBackpressure({ ...observeOptions,
      sample: sampler([connectionView(), goneView({ connections: 3, totalBufferedBytes: reused })]), closure: fakeClosure(FENCE_CLOSE_CODE) });
    assert.equal(contained.mechanism, 'fenced');
    assert.equal(contained.peakBytes, 0, 'a queue on somebody else\u2019s socket is never this connection\u2019s peak');
  }
  // Even pending bytes reported against a dropped object are not a queue the
  // host is carrying for it.
  const dropped = goneView({ connection: { ...goneView().connection, pendingBytes: 9_999 } });
  await assert.rejects(observeBackpressure({ ...observeOptions, sample: sampler([connectionView(), dropped]), closure: fakeClosure(1006) }),
    /merely disappeared is not containment/);
});

test('a queue that stays at zero, an unreadable target and the byte ceiling all still fail', async () => {
  await assert.rejects(
    observeBackpressure({ ...observeOptions, now: advancingClock(), sample: sampler([connectionView()]), closure: fakeClosure(FENCE_CLOSE_CODE) }),
    error => {
      assert.match(error.message, /Timed out waiting for the slow consumer to be queued for or fenced/);
      assert.match(error.message, /lastOutcome=none peakBytes=0/);
      assert.match(error.message, /pressureState=flowing readyState=1 peakHostBufferedBytes=0/);
      assert.doesNotMatch(error.message, /bytesWritten/, 'a byte counter was never identity and is not evidence here');
      return true;
    });
  for (const unreadable of [
    { readable: false, reason: 'the host does not keep a client registry this harness can check membership in', present: null },
    { readable: true, present: 'maybe' },
    { readable: true, present: true, connection: null },
  ]) {
    await assert.rejects(observeBackpressure({ ...observeOptions, sample: sampler([connectionView(unreadable)]), closure: fakeClosure(FENCE_CLOSE_CODE) }),
      /could not be read on the host/);
  }
  await assert.rejects(observeBackpressure({ ...observeOptions, sample: sampler([connectionView({ totalBufferedBytes: SAFETY.socketBufferedBytes + 1 })]), closure: fakeClosure(null) }),
    /slow socket crossed safety ceiling/);
  await assert.rejects(observeBackpressure({ ...observeOptions,
    sample: sampler([connectionView({ connection: { ...connectionView().connection, pendingBytes: SAFETY.socketBufferedBytes + 1 } })]), closure: fakeClosure(null) }),
    /slow socket crossed safety ceiling/);
});

test('the slow consumer sends requests this protocol really accepts', async () => {
  const { parseClientRequest } = await import(new URL('packages/protocol/dist/index.js', CHECKOUT).href);
  const request = params => parseClientRequest({ jsonrpc: '2.0', id: 1, method: 'session/load', params });
  const path = '/scratch/sessions/session-abcdef.jsonl';
  assert.equal(request(slowConsumerLoad(path)).params.path, path);
  assert.equal(request(slowConsumerLoad(path, 0)).params.fromSeq, 0);
  assert.equal(request(slowConsumerLoad(path, 12)).params.fromSeq, 12);
  // The pin: the opt-in flag RP-6 removed is refused, which is exactly how this
  // scenario came to produce no traffic and then wait for a queue for ever.
  assert.throws(() => request({ ...slowConsumerLoad(path), transcript: 'loaded' }));
  const source = await readFile(new URL('../resource/scenarios/08-slow-consumer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /transcript:/, 'the scenario must not send a session/load field the protocol does not have');
  assert.match(source, /if \(message\.error\) reject/, 'a refused load must fail the scenario, never look like a loaded consumer');
});

test('classification separates the two outcomes from a dropped object and an unreadable one', () => {
  assert.equal(classifyConnection(connectionView()).outcome, 'none');
  assert.equal(classifyConnection(connectionView({ connection: { ...connectionView().connection, pendingBytes: 1 } })).outcome, 'queued');
  assert.equal(classifyConnection(connectionView({ connection: { ...connectionView().connection, state: 'fenced' } })).outcome, 'fenced');
  assert.equal(classifyConnection(connectionView({ connection: { ...connectionView().connection, fenced: true } })).outcome, 'fenced');
  // Membership decides \u201cgone\u201d before the queue account is even looked at.
  assert.equal(classifyConnection(goneView()).outcome, 'removed');
  assert.equal(classifyConnection(goneView({ connection: { ...connectionView().connection, state: 'fenced' } })).outcome, 'removed');
  assert.equal(classifyConnection({ readable: false, reason: 'no registry' }).outcome, 'unreadable');
  assert.equal(classifyConnection(undefined).outcome, 'unreadable');
});

test('the fence closure is watched on the socket itself and resumes its reader to read it', async () => {
  const socket = new EventEmitter();
  let resumed = 0;
  socket._socket = { resume: () => { resumed += 1; } };
  const closure = watchFenceClosure(socket);
  assert.equal(closure.closed, false);
  const pending = closure.prove({ timeoutMs: 1_000 });
  await Promise.resolve();
  assert.equal(resumed, 1, 'a paused reader only hears the close frame once it is resumed');
  socket.emit('close', 1013, Buffer.from('reconnect to catch up'));
  const proved = await pending;
  assert.deepEqual([proved.code, proved.observed, proved.reason], [1013, true, 'reconnect to catch up']);
  assert.equal(closure.closed, true);
  const quiet = watchFenceClosure(new EventEmitter());
  assert.deepEqual(await quiet.prove({ timeoutMs: 5, sleepFor: async () => {} }), { code: null, reason: null, at: null, observed: false });
});

test('a failing backpressure observation still resumes and closes the stalled client', async () => {
  let resumed = 0; let closed = 0;
  const socket = { _socket: { resume: () => { resumed += 1; } } };
  await assert.rejects(withStalledClient(socket, () => observeBackpressure({ ...observeOptions, now: advancingClock(), sample: sampler([connectionView()]), closure: fakeClosure(null) }),
    { close: async () => { closed += 1; } }), /Timed out waiting for the slow consumer/);
  assert.deepEqual([resumed, closed], [1, 1]);
});

