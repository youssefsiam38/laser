/**
 * What "the host contained a consumer that stopped reading" is allowed to look
 * like (RP-7), and what it is not.
 *
 * Scenario 8 leaves one real paused WebSocket attached and drives authoritative
 * traffic at it. Before M18-T7 there was one possible outcome: the bytes the
 * host could not write piled up behind that socket, so a positive pending-byte
 * peak was the whole observation. With the transport bounds in place there are
 * two, and both are containment:
 *
 * - **queued** — the connection is holding bytes, under the run's high-water
 *   ceiling. That is the peak this scenario has always measured.
 * - **fenced** — the host decided this connection could not stay under its byte
 *   fence and closed it for reconnect instead of queueing for it. The queue the
 *   sampler was waiting for may never exist, and waiting for it for ever is the
 *   harness misreading a success.
 *
 * The distinction this file exists to protect: *fenced* is an observation about
 * **one named socket**, proved by that socket's own pressure state on the host
 * or by its 1013 closure once its reader resumes. A connection that merely
 * disappeared, a socket error, a timeout, or a queue that stayed at zero are
 * none of those, and each one fails the scenario exactly as it did before.
 */

const sleep = ms => new Promise(done => setTimeout(done, ms));
/** A bound that never keeps the run alive by itself. */
const bound = ms => new Promise(done => { const timer = setTimeout(done, ms); timer.unref?.(); });

/** The two containment outcomes, in the words the report uses. */
export const MECHANISMS = Object.freeze({ queued: 'queued', fenced: 'fenced' });

/**
 * One sample of the named connection, classified.
 *
 * `view` is `CONNECTION_PRESSURE_FN`'s answer: how many of the host's direct
 * connections carry the caller's port (never more than one, or the observation
 * is not specific), and that connection's own queue account.
 */
export function classifyConnection(view, { seen = false } = {}) {
  if (view?.ambiguous) return { outcome: 'ambiguous' };
  const connection = view?.connection ?? null;
  if (connection) {
    if (connection.fenced === true || connection.state === 'fenced') {
      return { outcome: 'fenced', by: 'this connection\u2019s own host pressure state', connection };
    }
    return { outcome: connection.pendingBytes > 0 ? 'queued' : 'none', connection };
  }
  // Absence is evidence only about a connection this observation already saw:
  // "it was never there" is a broken observation, not a contained one.
  return { outcome: seen ? 'removed' : 'absent' };
}

/**
 * Watch for the closure the host's byte fence sends, on this socket only.
 *
 * The reader is paused, so the close frame sits in the kernel until it is
 * resumed: resuming is what makes the evidence readable, and it is bounded, so
 * a socket that never closes is reported as "not observed" rather than waited
 * on. Only close code 1013 counts — the one the host sends when it disconnects
 * a connection to make it reconnect and re-read (`server.ts` fence callback).
 */
export const FENCE_CLOSE_CODE = 1013;

export function watchFenceClosure(socket) {
  const seen = { code: null, reason: null, at: null };
  const waiters = [];
  const record = (code, reason) => {
    if (seen.code !== null) return;
    seen.code = Number(code) || null;
    seen.reason = reason === undefined || reason === null ? null : String(reason).slice(0, 120);
    seen.at = Date.now();
    for (const resolve of waiters.splice(0)) resolve({ ...seen });
  };
  if (typeof socket?.on === 'function') socket.on('close', (code, reason) => record(code, reason));
  else socket?.addEventListener?.('close', event => record(event?.code, event?.reason));
  return {
    get closed() { return seen.code !== null; },
    snapshot() { return { ...seen }; },
    /** Resume the paused reader and wait, bounded, for this socket's close. */
    async prove({ timeoutMs = 5_000, resume = () => socket?._socket?.resume?.(), sleepFor = bound } = {}) {
      if (seen.code !== null) return { ...seen, observed: true };
      resume();
      const waited = new Promise(resolve => waiters.push(resolve));
      const timer = sleepFor(timeoutMs).then(() => null);
      const result = await Promise.race([waited, timer]);
      if (!result) return { code: null, reason: null, at: null, observed: false };
      return { ...result, observed: true };
    },
  };
}

/**
 * Observe one named connection until the host has demonstrably contained it.
 *
 * Returns the mechanism and its evidence, or throws. It never returns on a
 * timeout, on a generic disappearance it cannot attribute to the fence, or on a
 * queue that stayed at zero: each of those is the failure it has always been.
 */
export async function observeBackpressure({
  sample,
  closure,
  deadlineMs,
  ceilingBytes,
  seen = false,
  pollMs = 250,
  now = () => Date.now(),
  sleepFor = sleep,
  closeTimeoutMs = 5_000,
} = {}) {
  const deadline = now() + deadlineMs;
  let samples = 0;
  let peakBytes = 0;
  let lastBytesWritten = -1;
  let firstBytesWritten = null;
  let peakTotalBufferedBytes = 0;
  let lastState = null;
  let lastReadyState = null;
  let everSeen = seen;
  let lastOutcome = 'none';
  while (true) {
    samples += 1;
    const view = await sample();
    // The run's own high-water ceiling, unchanged: it is a safety gate over
    // every connection the host has, not a threshold this observation tunes.
    if (Number(view?.totalBufferedBytes) > ceilingBytes) throw new Error('slow socket crossed safety ceiling');
    peakTotalBufferedBytes = Math.max(peakTotalBufferedBytes, Number(view?.totalBufferedBytes) || 0);
    const classified = classifyConnection(view, { seen: everSeen });
    lastOutcome = classified.outcome;
    if (classified.outcome === 'ambiguous') {
      throw new Error('More than one host connection carried the slow consumer\u2019s port; this observation is not about one socket.');
    }
    const connection = classified.connection ?? null;
    if (connection) {
      everSeen = true;
      if (connection.bytesWritten < lastBytesWritten) {
        throw new Error('The host connection carrying the slow consumer\u2019s port changed identity mid-observation.');
      }
      lastBytesWritten = connection.bytesWritten;
      if (firstBytesWritten === null) firstBytesWritten = connection.bytesWritten;
      lastState = connection.state;
      lastReadyState = connection.readyState;
      if (connection.pendingBytes > ceilingBytes) throw new Error('slow socket crossed safety ceiling');
      peakBytes = Math.max(peakBytes, connection.pendingBytes);
    }
    if (classified.outcome === 'fenced' || classified.outcome === 'removed') {
      const required = classified.outcome === 'removed';
      const proved = closure ? await closure.prove({ timeoutMs: closeTimeoutMs }) : { code: null, reason: null, observed: false };
      if (required && proved.code !== FENCE_CLOSE_CODE) {
        throw new Error('The slow consumer\u2019s connection left the host without the byte fence\u2019s closure: '
          + `closeCode=${proved.code ?? 'none'} observed=${proved.observed} samples=${samples}. `
          + 'A connection that merely disappeared is not containment.');
      }
      return {
        mechanism: MECHANISMS.fenced,
        peakBytes,
        samples,
        evidence: {
          by: classified.by ?? 'this connection was removed from the host after its byte fence closed it',
          pressureState: connection?.state ?? null,
          pressureFenced: connection?.fenced ?? null,
          highWaterBytes: connection?.highWaterBytes ?? null,
          readyState: connection?.readyState ?? null,
          closeCode: proved.code,
          closeCodeRequired: required,
          closeObserved: proved.observed,
        },
      };
    }
    if (classified.outcome === 'queued') {
      return {
        mechanism: MECHANISMS.queued,
        peakBytes,
        samples,
        evidence: {
          by: 'this connection\u2019s own pending bytes on the host',
          pendingBytes: connection.pendingBytes,
          accountedBytes: connection.accountedBytes,
          socketBufferedBytes: connection.socketBufferedBytes,
          highWaterBytes: connection.highWaterBytes,
          pressureState: connection.state,
        },
      };
    }
    if (now() >= deadline) break;
    await sleepFor(pollMs);
  }
  // What the observation actually saw, so a timeout is a measurement rather
  // than a shrug: how many bytes the host wrote to this one socket while it
  // was paused says whether the workload created pressure at all.
  throw new Error('Timed out waiting for the slow consumer to be queued for or fenced by the host: '
    + `samples=${samples} lastOutcome=${lastOutcome} peakBytes=${peakBytes} connectionSeen=${everSeen} `
    + `bytesWrittenToThisSocket=${lastBytesWritten < 0 ? 'unavailable' : lastBytesWritten - (firstBytesWritten ?? 0)} `
    + `pressureState=${lastState ?? 'unavailable'} readyState=${lastReadyState ?? 'unavailable'} `
    + `peakHostBufferedBytes=${peakTotalBufferedBytes}.`);
}
