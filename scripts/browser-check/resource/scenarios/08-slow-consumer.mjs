import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket as NodeWebSocket } from '../../../../packages/host/node_modules/ws/wrapper.mjs';
import { settle } from '../fixtures.mjs';
import { closeNodeWebSocket } from '../websocket.mjs';
import { SAFETY } from '../config.mjs';
import { sleep } from '../context.mjs';

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
 * Scenario 8 — one real consumer that stops reading.
 *
 * The paused socket is owned by a `try/finally`: whatever happens — a ceiling,
 * a timeout, an assertion — its reader is resumed and the socket is force-closed
 * and awaited, so a failing run never leaves a stalled client attached to the
 * host it is about to measure for retirement.
 */
export default {
  id: '8-slow-consumer',
  title: 'leave a slow consumer connected',
  async run(run) {
    const { check, config, report, state } = run;
    const heavy = state.heavy;
    const version = JSON.parse(await readFile(join(run.checkout, 'packages/cli/package.json'), 'utf8')).version;
    const slow = new NodeWebSocket(`${check.fixture.hostRecord.url.replace('http:', 'ws:')}/ws`);
    const queuedPeak = await withStalledClient(slow, async () => {
      await new Promise((resolveOpen, reject) => { slow.onopen = resolveOpen; slow.onerror = reject; });
      let rpcId = 1;
      const loaded = new Promise((resolveLoad, reject) => {
        const timer = setTimeout(() => reject(new Error('slow-client load timed out')), config.phaseTimeoutMs);
        slow.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id === rpcId) { clearTimeout(timer); resolveLoad(message.result); } };
      });
      slow.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'session/load', params: { path: heavy.path, transcript: 'loaded' }, clientVersion: version }));
      await loaded;
      slow._socket?.pause?.();

      // One host connection for the whole backpressure observation: polling must
      // not open an inspector, and must not query objects, per sample.
      const peak = await run.withHost(async ({ counters }) => {
        // Replaying the already-loaded synthetic state makes kernel backpressure
        // deterministic even with TCP receive autotuning. The ordinary UI client
        // keeps draining while this one real socket is paused.
        for (let replay = 0; replay < config.slowReplayAttempts; replay++) {
          slow.send(JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'session/load', params: { path: heavy.path, fromSeq: 0, transcript: 'loaded' }, clientVersion: version }));
          await sleepFor(config.slowReplayPaceMs);
          const value = await counters();
          if (value.bufferedBytes > SAFETY.socketBufferedBytes) throw new Error('slow socket crossed safety ceiling');
          if (value.bufferedBytes > 0) break;
        }
        const accepted = await check.rpc('session/prompt', { path: heavy.path, content: [{ type: 'text', text: 'resource:large-stream slow' }] });
        assert.equal(accepted.accepted, true);
        return run.until(async () => {
          const value = await counters();
          if (value.bufferedBytes > SAFETY.socketBufferedBytes) throw new Error('slow socket crossed safety ceiling');
          return value.bufferedBytes > 0 ? value.bufferedBytes : false;
        }, 'real WebSocket buffered bytes', Math.min(config.phaseTimeoutMs, config.backpressureTimeoutMs));
      });
      assert.ok(peak > 0, 'the paused TCP reader must create real host backpressure');
      await settle(check.rpc, heavy.path, run.until.bind(run), config.phaseTimeoutMs);
      return peak;
    });
    const finalState = await check.rpc('session/load', { path: heavy.path });
    const recovered = await check.rpc('session/load', { path: heavy.path, fromSeq: Math.max(0, finalState.seq - 5), transcript: 'loaded' });
    assert.equal(recovered.seq, finalState.seq, 'a fresh consumer recovers the authoritative watermark');
    assert.ok(recovered.replayFrom <= Math.max(0, finalState.seq - 5), 'recovery covers the requested tail');
    report.slowConsumer = { bufferedPeakBytes: queuedPeak, recovered: true, mechanism: 'paused TCP reader' };
    const phase = await run.samplePhase('slow-consumer');
    return { phase };
  },
};
