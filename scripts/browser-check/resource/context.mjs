/**
 * The run context every scenario shares: connections, phase sampling, the
 * report it writes into, and the small number of product calls that more than
 * one scenario needs. Scenarios hold no state of their own beyond what they
 * return.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitForRegistrations, connectInspector, connectionPressure, queryInstances, scalarCounters, tailBufferCounters, linuxStartToken } from './inspector.mjs';
import { DiscoveryRegistry } from './discovery.mjs';
import { ProcessCensus, censusTotals, verdictFor } from './sampling.mjs';
import { captureHeap } from './heap.mjs';
import { SAFETY } from './config.mjs';
import { addHeapOwners, addRendererProjection } from './rankings.mjs';
import { sanitizeError, sanitizeOwner } from './report.mjs';
import { retirementGuardSnapshot } from './retirement.mjs';

export const sleep = ms => new Promise(done => setTimeout(done, ms));

export function moduleUrls(checkout) {
  return {
    host: pathToFileURL(join(checkout, 'packages/host/dist/server.js')).href,
    worker: pathToFileURL(join(checkout, 'packages/worker/dist/server.js')).href,
    tail: pathToFileURL(join(checkout, 'packages/pi-extension/dist/modules/background-work.js')).href,
  };
}

export async function connectWorkerInspector(record, hostPid, { connect = connectInspector, query = queryInstances, workerModule } = {}) {
  let client;
  let ownershipTransferred = false;
  try {
    client = await connect(record, { rootPid: hostPid, label: 'worker' });
    const found = await query(client, workerModule, 'WorkerServer');
    const handle = { record, client, found };
    ownershipTransferred = true;
    return handle;
  } finally {
    if (client && !ownershipTransferred) await client.close();
  }
}

// The harness itself answers for a closed page; the soak only re-exports it so
// its own tests can assert the same behaviour.
export { closedPageMetrics } from '../browser.mjs';

export class SoakRun {
  constructor(check, { config, expected, report, modules, mode, checkout }) {
    this.check = check;
    this.config = config;
    this.expected = expected;
    this.report = report;
    this.modules = modules;
    this.mode = mode;
    this.checkout = checkout;
    this.discovery = new DiscoveryRegistry();
    this.census = new ProcessCensus({ hostPid: check.fixture.hostRecord.pid });
    this.state = {};
  }

  /** Bounded polling against one product RPC per attempt, torn down per call. */
  until(fn, label, timeout) {
    const deadline = Date.now() + timeout;
    const interval = this.config.pollIntervalMs;
    return (async () => {
      while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await sleep(interval);
      }
      throw new Error(`Timed out waiting for ${label}.`);
    })();
  }

  // --- inspector connections ------------------------------------------------

  async inspectorSet({ includeWorkers = true } = {}) {
    const records = await waitForRegistrations(this.check.fixture.inspectDir, { rootPid: this.check.fixture.hostRecord.pid, minimum: 1, timeoutMs: 10_000 });
    const hostRecord = records.find(record => record.pid === this.check.fixture.hostRecord.pid);
    if (!hostRecord) throw new Error('The owned host inspector registration is missing.');
    const host = await connectInspector(hostRecord, { rootPid: this.check.fixture.hostRecord.pid, label: 'host' });
    const hostHandle = await this.discovery.handle(host, {
      pid: hostRecord.pid, startToken: hostRecord.startToken, moduleUrl: this.modules.host, exportName: 'HostServer',
    });
    const workers = [];
    const unreadable = [];
    if (includeWorkers) for (const record of records.filter(record => record.pid !== hostRecord.pid)) {
      let client;
      try {
        client = await connectInspector(record, { rootPid: this.check.fixture.hostRecord.pid, label: 'worker' });
        const handle = await this.discovery.handle(client, {
          pid: record.pid, startToken: record.startToken, moduleUrl: this.modules.worker, exportName: 'WorkerServer',
        });
        workers.push({ record, client, handle });
      } catch (error) {
        if (client) await client.close().catch(() => {});
        unreadable.push({ reason: sanitizeError(error) });
      }
    }
    return { records, host: { record: hostRecord, client: host, handle: hostHandle }, workers, unreadableWorkers: unreadable };
  }

  async closeInspectorSet(set) {
    await set.host.client.send('Runtime.releaseObjectGroup', { objectGroup: set.host.handle.group }).catch(() => {});
    await set.host.client.close().catch(() => {});
    for (const worker of set.workers) {
      await worker.client.send('Runtime.releaseObjectGroup', { objectGroup: worker.handle.group }).catch(() => {});
      await worker.client.close().catch(() => {});
    }
  }

  /** One host connection for a whole bounded activity — never one per poll. */
  async withHost(fn, { includeWorkers = false } = {}) {
    const set = await this.inspectorSet({ includeWorkers });
    try {
      return await fn({
        set,
        counters: () => scalarCounters(set.host.client, set.host.handle.objectId, 'host'),
        // One named connection's own queue account, on the same host connection
        // this activity already holds: no extra inspector, no queried objects.
        connection: remotePort => connectionPressure(set.host.client, set.host.handle.objectId, remotePort),
      });
    } finally { await this.closeInspectorSet(set); }
  }

  async hostCounters() {
    return this.withHost(({ counters }) => counters());
  }

  /** Host and worker guard counters in one pass, with unreadable rows kept. */
  async sampleRetirementGuards() {
    const set = await this.inspectorSet();
    try {
      const host = await scalarCounters(set.host.client, set.host.handle.objectId, 'host');
      const workers = [];
      const unreadable = set.unreadableWorkers.map(row => row.reason);
      for (const worker of set.workers) {
        try { workers.push(await scalarCounters(worker.client, worker.handle.objectId, 'worker')); }
        catch (error) { unreadable.push(sanitizeError(error)); }
      }
      return { guards: retirementGuardSnapshot(host, workers), readable: workers.length, unreadable };
    } finally { await this.closeInspectorSet(set); }
  }

  // --- renderer -------------------------------------------------------------

  async rendererPid() {
    const check = this.check;
    if (check._resourceRendererPid) return check._resourceRendererPid;
    const marker = `resource-renderer-${Date.now()}`;
    let resolveComplete;
    const completed = new Promise(resolve => { resolveComplete = resolve; });
    const listener = value => resolveComplete(value);
    check.browserCdp.once('Tracing.tracingComplete', listener);
    let timer;
    try {
      await check.browserCdp.send('Tracing.start', { categories: 'blink.user_timing,devtools.timeline', transferMode: 'ReturnAsStream' });
      await check.page.evaluate(value => { performance.mark(value); console.timeStamp(value); }, marker);
      await sleep(100);
      await check.browserCdp.send('Tracing.end');
      const { stream } = await Promise.race([completed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome trace marker timed out.')), 10_000); })]);
      let text = '';
      while (true) {
        const part = await check.browserCdp.send('IO.read', { handle: stream, size: 1024 * 1024 });
        text += part.data;
        if (text.length > 8 * 1024 * 1024) throw new Error('Chrome marker trace exceeded 8 MiB.');
        if (part.eof) break;
      }
      await check.browserCdp.send('IO.close', { handle: stream });
      const trace = JSON.parse(text);
      const matches = trace.traceEvents.filter(event => event.name === marker || event.args?.data?.message === marker || event.args?.name === marker);
      const pids = [...new Set(matches.map(event => event.pid).filter(Number.isInteger))];
      if (pids.length !== 1) throw new Error(`Could not map the measured page to one renderer PID; marker matched ${pids.length}.`);
      check._resourceRendererPid = pids[0];
      return pids[0];
    } finally {
      clearTimeout(timer);
      check.browserCdp.off?.('Tracing.tracingComplete', listener);
    }
  }

  async rendererCounters() {
    const check = this.check;
    await check.cdp.send('Performance.enable');
    const [metrics, dom, state] = await Promise.all([
      check.cdp.send('Performance.getMetrics'), check.cdp.send('Memory.getDOMCounters'),
      check.page.evaluate(() => {
        const store = window.__resourceSoak?.store; if (!store) return { storeReachable: false };
        const snapshot = store.getSnapshot(); const pairs = Object.entries(snapshot.open); const views = pairs.map(([, value]) => value);
        return { storeReachable: true, openSessions: views.length, hydratedSessions: views.filter(view => view?.hydrated).length,
          entries: views.reduce((n, view) => n + (view?.entries?.length ?? 0), 0),
          ownerBytes: pairs.map(([path, view], index) => ({ owner: window.__resourceSoak.aliases[path] ?? `session-view-${index + 1}`,
            bytes: new TextEncoder().encode(JSON.stringify(view?.entries ?? [])).byteLength })),
          mountedRows: document.querySelectorAll('[data-window-message]').length,
          images: [...document.querySelectorAll('[data-slot="message-image"]')].map(image => ({ width: image.naturalWidth, height: image.naturalHeight, decoded: image.complete && image.naturalWidth > 0 })) };
      }),
    ]);
    const values = Object.fromEntries(metrics.metrics.map(row => [row.name, row.value]));
    return { ...state, jsHeapUsedBytes: values.JSHeapUsedSize ?? null, jsHeapTotalBytes: values.JSHeapTotalSize ?? null,
      documents: values.Documents ?? null, listeners: values.JSEventListeners ?? null, domNodes: dom.nodes, detachedNodes: dom.detachedNodes };
  }

  async workerGeneration(cwd) {
    const row = (await this.check.rpc('pi/worker/list', {})).workers.find(worker => worker.cwd === cwd);
    if (!row || row.status !== 'ready' || !Number.isInteger(row.pid)) return null;
    const token = await linuxStartToken(row.pid).catch(() => null);
    return token ? `${row.pid}:${token}` : null;
  }

  // --- one phase ------------------------------------------------------------

  /**
   * Natural first: `/proc` rows and the renderer's own counters are taken
   * before any inspector connection, query or heap work, because all of those
   * collect garbage in the process being measured. Everything that can only be
   * read by querying the heap is taken afterwards and labelled post-GC.
   */
  async samplePhase(name, { heap = false, includeWorkers = true, pageClosed = false } = {}) {
    const report = this.report;
    const rendererPid = pageClosed ? null : await this.rendererPid();
    const census = await this.census.take({ rendererPid, requiredPids: pageClosed ? [this.check.fixture.hostRecord.pid] : [this.check.fixture.hostRecord.pid, rendererPid] });
    let safety;
    try {
      safety = await verdictFor(census);
    } catch (error) {
      throw await this.describeSafetyRefusal({ phase: name, census, rendererPid, error });
    }
    const renderer = pageClosed || this.check.page.url() === 'about:blank' ? null : await this.rendererCounters();
    const rendererStatus = pageClosed ? 'unavailable: app page closed before this phase' : renderer ? 'available' : 'unavailable: blank page';
    const inventory = await this.check.rpc('resource/snapshot', { refresh: true });
    const totals = censusTotals(census);

    const set = await this.inspectorSet({ includeWorkers });
    let phase;
    try {
      const hostCounters = await scalarCounters(set.host.client, set.host.handle.objectId, 'host');
      const workerCounters = [];
      const unreadableWorkers = [...set.unreadableWorkers];
      for (const worker of set.workers) {
        try { workerCounters.push(await scalarCounters(worker.client, worker.handle.objectId, 'worker')); }
        catch (error) { unreadableWorkers.push({ reason: sanitizeError(error) }); }
      }
      // TailBuffer instances have no single published handle, so finding them
      // costs a Runtime.queryObjects collection. It runs only here, after the
      // natural sample, and its numbers are labelled for what they are.
      const tails = [];
      for (const worker of set.workers) {
        try { tails.push(await tailBufferCounters(worker.client, this.modules.tail)); }
        catch (error) { tails.push({ available: false, reason: sanitizeError(error) }); }
      }
      phase = {
        name, atMs: Date.now() - report.startedAtMs,
        sampleOrder: 'proc rows and renderer counters first, then inspector counters, then queried and heap work',
        ...totals, natural: { totalPssBytes: totals.totalPssBytes, totalPrivateResidentBytes: totals.totalPrivateResidentBytes, label: 'before any inspector, query or heap work' },
        safety, renderer, rendererStatus, host: hostCounters, workers: workerCounters,
        unreadableWorkers: unreadableWorkers.length, unreadableWorkerReasons: unreadableWorkers.map(row => row.reason),
        exitedProcesses: census.exited.length, replacedProcesses: census.replaced.length,
        inventory: {
          processCount: inventory.snapshot.processes.length, coverage: inventory.snapshot.totals.coverage,
          knownPhysicalBytes: inventory.snapshot.totals.knownPhysicalBytes, physicalBytes: inventory.snapshot.totals.physical.value ?? null,
          roles: inventory.snapshot.byRole.map(row => ({ role: row.role, processes: row.coverage.processes, measured: row.coverage.measured,
            complete: row.coverage.complete, knownPhysicalBytes: row.knownPhysicalBytes })),
          collectors: inventory.snapshot.health.collectors.map(row => ({ name: row.name, status: row.status })), crossCheck: inventory.snapshot.health.crossCheck.status,
        },
        tailBuffers: { phase: 'post-gc', measuredBy: 'Runtime.queryObjects after the natural sample',
          available: tails.every(row => row.available !== false),
          count: tails.reduce((n, row) => n + (row.count ?? 0), 0), bytes: tails.reduce((n, row) => n + (row.bytes ?? 0), 0) },
      };
      if (heap) await this.captureHeaps(phase, set, { renderer });
      if (heap) {
        await sleep(1_000);
        const after = await this.census.take({ rendererPid, requiredPids: [] });
        phase.postGc = {
          label: 'after this phase heap captures and forced collections',
          ...censusTotals(after),
          renderer: renderer ? await this.rendererCounters() : null,
          host: await scalarCounters(set.host.client, set.host.handle.objectId, 'host'),
        };
      }
    } finally { await this.closeInspectorSet(set); }

    report.phases.push(phase);
    addRendererProjection(report.rankings, renderer?.ownerBytes ?? []);
    addHeapOwners(report.rankings, 'host', name, phase.hostHeap);
    addHeapOwners(report.rankings, 'renderer', name, phase.rendererHeap);
    for (const [index, result] of (phase.workerHeaps ?? []).entries()) {
      addHeapOwners(report.rankings, 'worker', name, result, { prefix: `worker-${index + 1}/` });
    }
    return phase;
  }

  async captureHeaps(phase, set, { renderer }) {
    const { check, modules } = this;
    phase.hostHeap = await this.captureInstanceHeap(set.host.client, join(check.root, `${phase.name}-host.heapsnapshot`), modules.host, 'HostServer', set.host.record);
    if (renderer) {
      const object = await check.cdp.send('Runtime.evaluate', { expression: 'window.__resourceSoak.store.getSnapshot().open', objectGroup: 'resource-open' });
      phase.rendererHeap = await captureHeap(check.cdp, join(check.root, `${phase.name}-renderer.heapsnapshot`), { stateOpen: object.result.objectId });
      await check.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'resource-open' }).catch(() => {});
    }
    phase.workerHeaps = [];
    for (const [index, worker] of set.workers.slice(0, this.config.workerHeapCaptures).entries()) {
      try {
        phase.workerHeaps.push(await this.captureInstanceHeap(worker.client, join(check.root, `${phase.name}-worker-${index + 1}.heapsnapshot`), modules.worker, 'WorkerServer', worker.record));
      } catch (error) {
        phase.workerHeaps.push({ available: false, reason: sanitizeError(error) });
      }
    }
  }

  /** The published handle for this generation, resolved right before its capture. */
  async captureInstanceHeap(client, file, moduleUrl, exportName, record) {
    const handle = await this.discovery.handle(client, { pid: record.pid, startToken: record.startToken, moduleUrl, exportName });
    return captureHeap(client, file, { [exportName]: handle.objectId });
  }

  // --- refusals -------------------------------------------------------------

  lastRendererSnapshot() {
    const report = this.report;
    for (let index = report.phases.length - 1; index >= 0; index--) {
      const phase = report.phases[index];
      if (phase.rendererHeap?.available) return { phase: phase.name, ageMs: Math.max(0, Date.now() - (report.startedAtMs + phase.atMs)) };
    }
    return null;
  }

  async describeSafetyRefusal({ phase, census, rendererPid, error }) {
    let inventory = [];
    try { inventory = (await this.check.rpc('resource/snapshot', { refresh: true })).snapshot.processes ?? []; } catch {}
    const hostPid = this.check.fixture.hostRecord.pid;
    const hostDescendants = census.rows.map(row => row.pid);
    const offenders = census.rows.filter(row => (row.pssBytes ?? 0) > SAFETY.processPssBytes).map(row => {
      const known = inventory.find(item => item.key === `${row.pid}@${row.startToken}`);
      return { role: classifySampledProcess(row.pid, { hostPid, hostDescendants, rendererPid, inventoryRole: known?.role ?? null, inventoryLabel: known?.label ?? null }),
        pssBytes: row.pssBytes, privateResidentBytes: row.privateResidentBytes };
    });
    const totals = censusTotals(census);
    const detail = safetyRefusalDetail({
      phase, reason: sanitizeOwner(error instanceof Error ? error.message : String(error)),
      offenders, totalPssBytes: totals.totalPssBytes, processCount: census.rows.length,
      coverage: census.coverage, lastRendererSnapshot: this.lastRendererSnapshot(),
    });
    this.report.safetyRefusal = detail;
    return new Error(safetyRefusalMessage(detail));
  }
}

/**
 * What a sampled process is, from structural evidence only: the host's own
 * process tree, the renderer the measured page actually runs in (mapped
 * through a trace marker), and the host's structural inventory role when that
 * process is one the host knows. Never argv, never a path.
 */
export function classifySampledProcess(pid, { hostPid = null, hostDescendants = [], rendererPid = null, inventoryRole = null, inventoryLabel = null } = {}) {
  const structural = pid === hostPid ? 'host'
    : pid === rendererPid ? 'renderer of the measured page'
    : hostDescendants.includes(pid) ? 'host descendant (worker or worker child)'
    : 'browser child outside the host process tree';
  return inventoryRole ? `${structural} · inventory role ${inventoryRole}${inventoryLabel ? ` (${inventoryLabel})` : ''}` : structural;
}

/** Count-only description of a refusal; no pid, no start token, no path. */
export function safetyRefusalDetail({ phase, reason, offenders = [], totalPssBytes = null, processCount = null, coverage = null, lastRendererSnapshot = null, ceilingBytes = SAFETY.processPssBytes }) {
  return { phase, enforcedAt: "start of phase, before this phase's heap capture", reason, ceilingBytes,
    offenders: offenders.map(offender => ({ role: offender.role, pssBytes: offender.pssBytes ?? null, privateResidentBytes: offender.privateResidentBytes ?? null })),
    totalPssBytes, processCount, coverage, lastRendererSnapshot };
}

export function safetyRefusalMessage(detail) {
  const offenders = detail.offenders.map(offender => `${offender.role} PSS ${offender.pssBytes}`).join('; ') || 'no single process over the ceiling';
  const snapshot = detail.lastRendererSnapshot
    ? `last renderer heap snapshot: phase ${detail.lastRendererSnapshot.phase}, ${detail.lastRendererSnapshot.ageMs} ms earlier`
    : 'no renderer heap snapshot had been taken yet';
  const coverage = detail.coverage
    ? `coverage ${detail.coverage.measured}/${detail.coverage.expected} expected processes, ${detail.coverage.complete ? 'complete' : 'incomplete'}`
    : 'coverage unknown';
  return `${detail.reason} Enforced at the ${detail.enforcedAt} "${detail.phase}"; ceiling ${detail.ceilingBytes}; ${offenders}; `
    + `total PSS ${detail.totalPssBytes} over ${detail.processCount} sampled processes; ${coverage}; ${snapshot}.`;
}
