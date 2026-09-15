import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket as NodeWebSocket } from '../../../../packages/host/node_modules/ws/wrapper.mjs';
import { settle } from '../fixtures.mjs';
import { closeNodeWebSocket } from '../websocket.mjs';
import { SAFETY } from '../config.mjs';
import { sleep } from '../context.mjs';
import { classifyConnection, observeBackpressure, watchFenceClosure } from '../backpressure.mjs';
import { deliveryCounts } from '../retirement.mjs';

const sleepFor = sleep;

/**
 * Own the stalled client for exactly as long as the body runs. Whatever the
 * body does — return, throw, cross a ceiling, time out — the paused reader is
 * resumed and the socket is force-closed and awaited before the failure
 * propagates, so no run leaves a stalled consumer attached to the host.
 */
export async function withStalledClient(socket, body, { close = closeNodeWebSocket } = {}) {
  try {
    return await body();
  } finally {
    socket._socket?.resume?.();
    await close(socket, { force: true, resume: true }).catch(() => {});
  }
}

/**
 * Every `session/load` this scenario sends, in one place.
 *
 * The parameters are the protocol's, and a test round-trips these exact objects
 * through `parseClientRequest`. A removed field kept here does not fail loudly:
 * it makes the host refuse the request, and the scenario then waits for traffic
 * that was never produced.
 */
export function slowConsumerLoad(path, fromSeq) {
  return fromSeq === undefined ? { path } : { path, fromSeq };
}

/**
 * Scenario 8 — one real consumer that stops reading.
 *
 * The paused socket is owned by a `try/finally`: whatever happens — a ceiling,
 * a timeout, an assertion — its reader is resumed and the socket is force-closed
 * and awaited, so a failing run never leaves a stalled client attached to the
 * host it is about to measure for retirement.
 *
 * The workload is unchanged: the same real paused WebSocket, the same replay
 * attempts at the same pace, the same large-stream prompt, the same high-water
 * ceiling and the same fresh-consumer authoritative recovery. What changed is
 * the observation. Under RP-7 the host may contain this connection in one of
 * two ways — by holding bytes for it, or by fencing it for reconnect — and
 * `resource/backpressure.mjs` accepts exactly those two, each proved on this
 * one named socket.
 */
export default {
  id: '8-slow-consumer',
  title: 'leave a slow consumer connected',
  async run(run) {
    const { check, config, report, state } = run;
    const heavy = state.heavy;
    let whileAttached = null;
    const version = JSON.parse(await readFile(join(run.checkout, 'packages/cli/package.json'), 'utf8')).version;
    // What the host's membership evidence says before this connection exists.
    // Scenario 1 proves the baseline zero is measured; these three readings
    // prove the same counters move for a real connection that attaches and
    // then goes away, which is the only way a zero here means anything.
    const beforeAttach = deliveryCounts(await run.hostCounters());
    assert.equal(beforeAttach.available, true, `transcript delivery evidence is unreadable: ${beforeAttach.reason}`);
    const slow = new NodeWebSocket(`${check.fixture.hostRecord.url.replace('http:', 'ws:')}/ws`);
    // Recorded from the moment the socket exists: the host's byte fence closes
    // with 1013, and a paused reader only hears it once it is resumed.
    const closure = watchFenceClosure(slow);
    const observation = await withStalledClient(slow, async () => {
      await new Promise((resolveOpen, reject) => { slow.onopen = resolveOpen; slow.onerror = reject; });
      let rpcId = 1;
      const loaded = new Promise((resolveLoad, reject) => {
        const timer = setTimeout(() => reject(new Error('slow-client load timed out')), config.phaseTimeoutMs);
        slow.onmessage = event => {
          const message = JSON.parse(String(event.data));
          if (message.id !== rpcId) return;
          clearTimeout(timer);
          // A refused request is not a loaded consumer. Accepting any reply with
          // the right id is how this socket came to follow nothing at all: the
          // host answered `session/load` with an error and the scenario then
          // waited for a queue that could not exist.
          if (message.error) reject(new Error(`the slow consumer's session/load was refused: ${message.error.message}`));
          else resolveLoad(message.result);
        };
      });
      // Exactly the parameters this protocol has. A connection is sent a
      // transcript's updates because it loaded it (RP-6); the opt-in flag that
      // used to say so was removed, and sending it made every one of these
      // loads an invalid-params refusal instead of the replay traffic this
      // scenario exists to create.
      slow.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'session/load', params: slowConsumerLoad(heavy.path), clientVersion: version }));
      const loadedState = await loaded;
      assert.ok(Number.isInteger(loadedState?.seq), 'the slow consumer really loaded the session it is going to stop reading');
      // The loopback port this socket opened from names it on the host: one TCP
      // connection, one port, so every reading below is about this socket and
      // not about "a connection".
      const port = slow._socket?.localPort;
      assert.ok(Number.isInteger(port), 'the slow consumer must be identifiable by its own loopback port');
      slow._socket?.pause?.();

      // One host connection for the whole backpressure observation: polling must
      // not open an inspector, and must not query objects, per sample.
      const result = await run.withHost(async ({ counters, connection }) => {
        const sample = async () => {
          const totals = await counters();
          // The aggregate high-water ceiling, unchanged.
          if (totals.bufferedBytes > SAFETY.socketBufferedBytes) throw new Error('slow socket crossed safety ceiling');
          const view = await connection(port);
          return { ...view, totalBufferedBytes: totals.bufferedBytes, host: totals };
        };
        const first = await sample();
        assert.equal(first.matched, 1, 'exactly one host connection carries the slow consumer\u2019s port');
        // Read from the same sample the observation already takes: no extra
        // traffic, no extra connection, nothing about the measurement changed.
        whileAttached = deliveryCounts(first.host);
        assert.equal(whileAttached.available, true, `transcript delivery evidence is unreadable: ${whileAttached.reason}`);
        assert.ok(whileAttached.admittedOwners >= beforeAttach.admittedOwners + 1,
          `a connection that loaded a conversation must be counted: ${beforeAttach.admittedOwners} → ${whileAttached.admittedOwners} admitted owners`);
        assert.ok(whileAttached.owners >= beforeAttach.owners + 1 && whileAttached.paths >= 1,
          `membership must hold this connection's surface and its conversation: ${JSON.stringify(whileAttached)}`);
        assert.equal(whileAttached.connections, first.host.connections, 'every connected client has a delivery record');

        // Replaying the already-loaded synthetic state makes kernel backpressure
        // deterministic even with TCP receive autotuning. The ordinary UI client
        // keeps draining while this one real socket is paused.
        for (let replay = 0; replay < config.slowReplayAttempts; replay++) {
          slow.send(JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'session/load', params: slowConsumerLoad(heavy.path, 0), clientVersion: version }));
          await sleepFor(config.slowReplayPaceMs);
          const outcome = classifyConnection(await sample(), { seen: true }).outcome;
          if (outcome === 'queued' || outcome === 'fenced' || outcome === 'removed') break;
        }
        // Sent whatever the replays did: the workload is the traffic, not the
        // measurement, and a run that skipped it would not be the same scenario.
        const accepted = await check.rpc('session/prompt', { path: heavy.path, content: [{ type: 'text', text: 'resource:large-stream slow' }] });
        assert.equal(accepted.accepted, true);
        return observeBackpressure({
          sample, closure, seen: true,
          ceilingBytes: SAFETY.socketBufferedBytes,
          deadlineMs: Math.min(config.phaseTimeoutMs, config.backpressureTimeoutMs),
          pollMs: config.pollIntervalMs,
        });
      });
      if (result.mechanism === 'queued') {
        assert.ok(result.peakBytes > 0, 'a queued outcome is a real, positive pending-byte peak on this connection');
      } else {
        assert.ok(result.evidence.pressureState === 'fenced' || result.evidence.pressureFenced === true || result.evidence.closeCode === 1013,
          'a fenced outcome is this socket\u2019s own host pressure state or its 1013 closure');
      }
      await settle(check.rpc, heavy.path, run.until.bind(run), config.phaseTimeoutMs);
      return result;
    });
    // The socket is closed by `withStalledClient`; the host must give its
    // membership back. Bounded, and about counts only.
    const afterClose = await run.withHost(({ counters }) => run.until(async () => {
      const counts = deliveryCounts(await counters());
      return counts.available && counts.admittedOwners <= beforeAttach.admittedOwners && counts.owners <= beforeAttach.owners ? counts : false;
    }, 'the host to release the closed slow consumer\u2019s transcript membership', Math.min(config.phaseTimeoutMs, config.teardownTimeoutMs)));

    const finalState = await check.rpc('session/load', slowConsumerLoad(heavy.path));
    const recovered = await check.rpc('session/load', slowConsumerLoad(heavy.path, Math.max(0, finalState.seq - 5)));
    assert.equal(recovered.seq, finalState.seq, 'a fresh consumer recovers the authoritative watermark');
    assert.ok(recovered.replayFrom <= Math.max(0, finalState.seq - 5), 'recovery covers the requested tail');
    report.slowConsumer = {
      // `queued` or `fenced`: which of RP-7's two containment outcomes this run
      // observed on the one paused connection, and the evidence for it.
      mechanism: observation.mechanism,
      bufferedPeakBytes: observation.mechanism === 'queued' ? observation.peakBytes : null,
      observedPeakBytes: observation.peakBytes,
      samples: observation.samples,
      evidence: observation.evidence,
      consumer: 'one real paused TCP reader on an owned loopback connection',
      recovered: true,
      // RP-6 membership around this one connection: counts only, no path.
      delivery: { beforeAttach, whileAttached, afterClose },
    };
    const phase = await run.samplePhase('slow-consumer');
    return { phase };
  },
};
