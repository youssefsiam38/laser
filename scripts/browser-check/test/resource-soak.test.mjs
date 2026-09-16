import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { modeConfig, expected, SAFETY } from '../resource/config.mjs';
import { syntheticPng, imagePayload } from '../resource/fixtures.mjs';
import { theilSen, compareRuns, assertRedacted, sanitizeOwner, sanitizeError, COMPARISON_POLICY, SLOPE_POLICY } from '../resource/report.mjs';
import { connectInspector, InspectorClient } from '../resource/inspector.mjs';
import { captureHeap } from '../resource/heap.mjs';
import { captureMemoryInfra, dumpAllocators } from '../resource/memory-infra.mjs';
import { memoryLabels } from '../resource/process-sampler.mjs';
import { dispatchFindShortcut, findShortcutEvents } from '../resource/keyboard.mjs';
import { partialFailureReport, providerAccounting, runResourceSoak, writeAtomicJson, writePartialReport } from '../resource-soak.mjs';
import { SoakRun, classifySampledProcess, closedPageMetrics, connectWorkerInspector, safetyRefusalDetail, safetyRefusalMessage } from '../resource/context.mjs';
import { assertNoLiveWork, dormantViews, proveNoLiveWork, reconcileDelivery, retirementGuardSnapshot, traverseRetainedViews } from '../resource/retirement.mjs';
import { expectedRetainedCounts } from '../resource/retention.mjs';
import { revealSessionRow, sidebarRowView } from '../resource/sidebar.mjs';
import { DiscoveryRegistry, PUBLISHED } from '../resource/discovery.mjs';
import { ProcessCensus, censusTotals, verdictFor } from '../resource/sampling.mjs';
import { withStalledClient } from '../resource/scenarios/08-slow-consumer.mjs';
import { BROWSER_SCENARIOS, SCENARIO_IDS } from '../resource/scenarios/index.mjs';
import { graphBudget, validateHeader } from '../resource/heap-parser.mjs';
import { closeNodeWebSocket, settledWebSocketRpc } from '../resource/websocket.mjs';

const execFileAsync = promisify(execFile);

test('fixture matrix pins the full acceptance workload', () => {
  const full = modeConfig('full'); const values = expected(full);
  assert.deepEqual({ projects: full.projects, sessions: full.projects * full.sessionsPerProject, long: full.longSessions,
    longMessages: full.longMessages, children: full.children, foreground: full.foregroundCalls, background: full.backgroundCalls,
    images: full.images, side: full.imageSide, logical: values.logicalImageBytes },
  { projects: 5, sessions: 50, long: 4, longMessages: 240, children: 10, foreground: 100, background: 100,
    images: 12, side: 2048, logical: 192 * 1024 * 1024 });
  assert.equal(SAFETY.snapshotBytes, 256 * 1024 * 1024);
  assert.equal(SAFETY.parserHeapMb, 384);
});

test('quick fixture still exercises every bounded mechanism', () => {
  const quick = modeConfig('quick');
  assert.deepEqual([quick.projects * quick.sessionsPerProject, quick.longMessages, quick.children,
    quick.foregroundCalls + quick.backgroundCalls, quick.images, quick.imageSide], [3, 80, 2, 6, 2, 512]);
  const values = expected(quick);
  assert.deepEqual([values.retainedViews, values.workspaceSessions, values.workers, values.seedRequests, values.historyPages], [5, 2, 3, 44, 1]);
});

test('PNG generator is deterministic, valid and uniquely seeded', () => {
  const a = syntheticPng(32, 1), again = syntheticPng(32, 1), other = syntheticPng(32, 2);
  assert.equal(a.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(a, again); assert.notDeepEqual(a, other);
  const images = imagePayload({ images: 2, imageSide: 32 });
  assert.equal(images.reduce((n,image) => n + image.logicalBytes, 0), 8192);
});

test('robust slopes and repeated owner ranks are deterministic', () => {
  assert.equal(theilSen([{x:0,y:10},{x:1,y:12},{x:2,y:14},{x:3,y:100}]), 30);
  const scenarios = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`scenario-${index + 1}`, 'complete']));
  const a={rankings:{host:[{owner:'sessions',bytes:5},{owner:'tasks',bytes:4},{owner:'logs',bytes:3},{owner:'socket',bytes:2},{owner:'pool',bytes:1}]},slopes:{host:{value:2}},scenarios};
  const b={rankings:{host:[{owner:'sessions',bytes:6},{owner:'tasks',bytes:5},{owner:'logs',bytes:3},{owner:'socket',bytes:2},{owner:'pool',bytes:1}]},slopes:{host:{value:2.2}},scenarios};
  assert.equal(compareRuns(a,b).pass,true);
  // The same rankings with a slope half again as large do not repeat.
  const spread={...b,slopes:{host:{value:3}}};
  assert.equal(compareRuns(a,spread).slopes.host.pass,false);
});

test('report redaction rejects paths, inspector URLs, payloads, ids and canaries', () => {
  for (const unsafe of ['/home/person/project/file.ts','ws://127.0.0.1:9000/id','data:image/png;base64,AAAA',
    'a'.repeat(600),'123e4567-e89b-12d3-a456-426614174000','RESOURCE-SOAK-PROMPT-CANARY','api_key: secret']) {
    assert.throws(() => assertRedacted(unsafe));
  }
  assert.doesNotThrow(() => assertRedacted('PSS proportional physical pages; 12345 bytes'));
  assert.equal(sanitizeOwner('/home/person/project/file.ts'), '<path>');
});

test('bounded heap parser computes target-retained bytes in its own process', async () => {
  const root=await mkdtemp(join(tmpdir(),'resource-heap-test-')); const file=join(root,'heap.json');
  const meta={node_fields:['type','name','id','self_size','edge_count'],node_types:[['synthetic','object','string'],'string','number','number','number'],edge_fields:['type','name_or_index','to_node'],edge_types:[['context','element','property'],'string_or_number','node']};
  // root -> target -> owned, with five fields per node and three per edge.
  const snapshot={snapshot:{meta,node_count:3,edge_count:2},nodes:[0,0,1,0,1, 1,1,7,10,1, 1,2,9,20,0],edges:[2,3,5, 2,4,10],strings:['root','Target','Owned','target','owned']};
  await writeFile(file,JSON.stringify(snapshot));
  try {
    const parser=new URL('../resource/heap-parser.mjs',import.meta.url).pathname;
    const {stdout}=await execFileAsync(process.execPath,['--max-old-space-size=64',parser,file,JSON.stringify({target:7})]);
    const result=JSON.parse(stdout); assert.equal(result.targets.target.retainedBytes,30);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('the bounded parser reads a full-scale snapshot larger than the old whole-JSON refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-heap-large-'));
  const file = join(root, 'large.heapsnapshot');
  const nodes = 4_000_000;
  const meta = { node_fields: ['type','name','id','self_size','edge_count'], node_types: [['synthetic','object','string'],'string','number','number','number'],
    edge_fields: ['type','name_or_index','to_node'], edge_types: [['context','element','property'],'string_or_number','node'] };
  try {
    // root -> target -> (nodes - 2) owned children, written as a stream so the
    // fixture itself never needs the memory the parser is being proven against.
    const out = createWriteStream(file);
    const put = async text => { if (!out.write(text)) await once(out, 'drain'); };
    await put(`{"snapshot":{"meta":${JSON.stringify(meta)},"node_count":${nodes},"edge_count":${nodes - 1}},"nodes":[0,0,1,0,1,1,1,7,10,${nodes - 2}`);
    for (let start = 2; start < nodes; start += 50_000) {
      const parts = [];
      for (let i = start; i < Math.min(nodes, start + 50_000); i++) parts.push(`,1,2,${9 + 2 * i},20,0`);
      await put(parts.join(''));
    }
    await put('],"edges":[2,3,5');
    for (let start = 2; start < nodes; start += 50_000) {
      const parts = [];
      for (let i = start; i < Math.min(nodes, start + 50_000); i++) parts.push(`,2,4,${i * 5}`);
      await put(parts.join(''));
    }
    await put('],"strings":["root","Target","Owned"]}\n');
    out.end();
    await once(out, 'close');

    const size = (await stat(file)).size;
    assert.ok(size > 96 * 1024 * 1024, `fixture is only ${size} bytes, below the old refusal`);
    assert.ok(size <= SAFETY.snapshotBytes, 'the fixture stays inside the unchanged capture ceiling');
    const parser = new URL('../resource/heap-parser.mjs', import.meta.url).pathname;
    const { stdout } = await execFileAsync(process.execPath,
      [`--max-old-space-size=${SAFETY.parserHeapMb}`, parser, file, JSON.stringify({ target: 7 })], { maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.available, true, result.reason);
    assert.equal(result.nodeCount, nodes);
    assert.equal(result.targets.target.available, true, result.targets?.target?.reason);
    assert.equal(result.targets.target.retainedBytes, 10 + 20 * (nodes - 2));
    assert.deepEqual(result.targets.target.largestOwnedNodes[0], { bytes: 20, type: 'object', name: 'Owned' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('heap capture deletes raw bytes after success and size overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-heap-delete-'));
  const meta={node_fields:['type','name','id','self_size','edge_count'],node_types:[['synthetic'],'string','number','number','number'],edge_fields:['type','name_or_index','to_node'],edge_types:[['property'],'string_or_number','node']};
  const body=JSON.stringify({snapshot:{meta,node_count:1,edge_count:0},nodes:[0,0,1,0,0],edges:[],strings:['root']});
  const fake = text => {
    let listener;
    return { on(_name, fn) { listener=fn; return () => { listener=undefined; }; }, async send(method) { if (method === 'HeapProfiler.takeHeapSnapshot') listener?.({chunk:text}); return {}; } };
  };
  const success = join(root, 'success.raw');
  const capped = join(root, 'capped.raw');
  try {
    assert.equal((await captureHeap(fake(body), success, {}, { byteCeiling: 4096 })).available, true);
    assert.equal(existsSync(success), false);
    assert.equal((await captureHeap(fake(body), capped, {}, { byteCeiling: 8 })).available, false);
    assert.equal(existsSync(capped), false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('restored-renderer keyboard helper delivers from BODY and proves the focused search DOM effect', async () => {
  const sent = [];
  let evaluations = 0;
  const page = {
    async bringToFront() {},
    async evaluate() {
      evaluations += 1;
      if (evaluations === 1) return { visibility: 'visible', documentFocused: false, activeTag: 'BODY', visibleMainThreads: 1, workbenchOpen: false, nonOwningDialog: false };
      return { visibility: 'visible', searchVisible: true, activeInSearch: true, activeTag: 'INPUT' };
    },
    locator() { return { async waitFor() {} }; },
  };
  const result = await dispatchFindShortcut({ page, cdp: { async send(method, event) { sent.push([method, event.type, event.modifiers]); } }, platform: 'linux' });
  assert.deepEqual(findShortcutEvents('linux').map(event => [event.type, event.modifiers, event.key]),
    [['keyDown', 2, 'f'], ['char', 2, 'f'], ['keyUp', 2, 'f']]);
  assert.deepEqual(sent, [['Input.dispatchKeyEvent', 'keyDown', 2], ['Input.dispatchKeyEvent', 'char', 2], ['Input.dispatchKeyEvent', 'keyUp', 2]]);
  assert.equal(result.before.activeTag, 'BODY');
  assert.equal(result.after.activeInSearch, true);
  assert.deepEqual(findShortcutEvents('darwin').map(event => event.modifiers), [4, 4, 4]);
});

function tracingStub({ owners, traceBytes = 1024 } = {}) {
  const calls = [];
  const events = level => ({ traceEvents: [{ args: { dumps: { allocators: Object.fromEntries(
    Array.from({ length: owners[level] ?? 0 }, (_, index) => [`malloc/partition-${index}`, { attrs: { size: { value: String(1000 + index) } } }]),
  ) } } }] });
  let level;
  const listeners = new Map();
  const cdp = {
    calls,
    once(name, listener) { listeners.set(name, listener); },
    async send(method, params = {}) {
      calls.push(method === 'Tracing.requestMemoryDump' ? `${method}:${params.levelOfDetail}` : method);
      if (method === 'Tracing.start') return {};
      if (method === 'Tracing.requestMemoryDump') { level = params.levelOfDetail; return { success: true }; }
      if (method === 'Tracing.end') { listeners.get('Tracing.tracingComplete')?.({ stream: 'stream-1' }); return {}; }
      if (method === 'IO.read') return { data: JSON.stringify(events(level)).padEnd(traceBytes, ' '), eof: true };
      return {};
    },
  };
  return cdp;
}

test('the memory dump runs outside the measured workload and takes the least intrusive level that names owners', async () => {
  const cdp = tracingStub({ owners: { background: 7 } });
  const order = [];
  const result = await captureMemoryInfra(cdp, async () => { order.push(`workload:${cdp.calls.length}`); });
  assert.deepEqual(order, ['workload:0'], 'nothing is traced while the workload runs');
  assert.equal(result.available, true, result.reason);
  assert.equal(result.levelOfDetail, 'background');
  assert.equal(result.allocators.length, 7);
  assert.ok(!cdp.calls.includes('Tracing.requestMemoryDump:detailed'), 'the perturbing detailed level is never requested');
  assert.deepEqual(cdp.calls.slice(0, 3), ['Tracing.start', 'Tracing.requestMemoryDump:background', 'Tracing.end']);
});

test('a dump that names too few owners escalates one bounded step and reports every attempt', async () => {
  const cdp = tracingStub({ owners: { background: 2, light: 6 } });
  const result = await dumpAllocators(cdp);
  assert.equal(result.available, true, result.reason);
  assert.equal(result.levelOfDetail, 'light');
  assert.deepEqual(result.attempts.map(attempt => [attempt.levelOfDetail, attempt.owners]), [['background', 2], ['light', 6]]);
});

test('a dump that stays too small or too large is unavailable, never a silent empty ranking', async () => {
  const thin = await dumpAllocators(tracingStub({ owners: { background: 1, light: 2 } }));
  assert.equal(thin.available, false);
  assert.match(thin.reason, /5 allocator owners/);
  const huge = await dumpAllocators(tracingStub({ owners: { background: 9 }, traceBytes: 4096 }), { byteCeiling: 1024 });
  assert.equal(huge.available, false);
  assert.match(huge.attempts[0].error, /exceeded 1024 bytes/);
});

test('memory category labels keep proportional, private, RSS, JS, native and external meanings separate', () => {
  const labels = memoryLabels();
  assert.match(labels.pssBytes, /proportional share/);
  assert.match(labels.privateResidentBytes, /Private_Clean/);
  assert.match(labels.residentBytes, /never summed/);
  assert.match(labels.externalBytes, /overlap/);
  assert.match(labels.nativeBytes, /not assigned/);
  assert.equal(Object.keys(labels).some(key => /virt|vsz/i.test(key)), false);
});

test('zero-instance worker race awaits one inspector close without transferring ownership', async () => {
  let closes = 0;
  let closeSettled = false;
  const client = { async close() { closes += 1; await new Promise(resolve => setTimeout(resolve, 10)); closeSettled = true; } };
  await assert.rejects(connectWorkerInspector({ pid: 7 }, 1, {
    connect: async () => client,
    query: async () => { throw new Error('Expected exactly 1 live WorkerServer; found 0.'); },
  }), /found 0/);
  assert.equal(closes, 1);
  assert.equal(closeSettled, true);
});

test('inspector close settles only after the debugger WebSocket closes', async () => {
  const listeners = new Map();
  const socket = {
    readyState: 1,
    addEventListener(name, listener) { listeners.set(name, listener); },
    close() { setTimeout(() => { socket.readyState = 3; listeners.get('close')?.(); }, 10); },
  };
  const client = new InspectorClient(socket, 'fixture');
  let settled = false;
  const closing = client.close().then(() => { settled = true; });
  assert.equal(settled, false);
  await closing;
  assert.equal(settled, true);
});

test('inspector registration refuses non-loopback and stale identities before connect', async () => {
  await assert.rejects(connectInspector({pid:process.pid,startToken:'bad',url:'ws://example.invalid/secret'}),/Invalid/);
});

// A real inspected Node process with one known retained object, and nothing
// else: no product, no credentials, no session data.
const PROBE_SOURCE = `
class ResourceSoakProbe { constructor(rows) { this.rows = Array.from({ length: rows }, (_, index) => \`\${index}:\${'x'.repeat(1024)}\`); } }
globalThis.__probe = new ResourceSoakProbe(512);
globalThis.__fresh = null;
globalThis.__churn = () => { const junk = []; for (let i = 0; i < 50000; i++) junk.push({ i, s: 'y'.repeat(64) }); return junk.length; };
globalThis.__makeFresh = () => { globalThis.__fresh = new ResourceSoakProbe(256); return 'made'; };
setInterval(() => {}, 1000);
`;

async function inspectedProbe() {
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', PROBE_SOURCE], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('probe inspector did not announce a URL')), 15_000);
    child.stderr.on('data', part => {
      text += String(part);
      const match = /(ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+)/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`probe exited early with ${code}`)); });
  });
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('probe inspector connect failed')), { once: true });
  });
  const client = new InspectorClient(socket, 'probe');
  await client.send('Runtime.enable');
  await client.send('HeapProfiler.enable');
  const evaluate = async expression => (await client.send('Runtime.evaluate', { expression })).result;
  return { child, client, evaluate, async stop() { await client.close().catch(() => {}); child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } };
}

test('heap targets resolve to a concrete object across forced GC and sequential snapshots', async t => {
  const probe = await inspectedProbe();
  const root = await mkdtemp(join(tmpdir(), 'resource-heap-ids-'));
  t.after(async () => { await probe.stop(); await rm(root, { recursive: true, force: true }); });

  const first = await captureHeap(probe.client, join(root, 'first.heapsnapshot'), { probe: (await probe.evaluate('globalThis.__probe')).objectId });
  assert.equal(first.available, true, first.reason);
  assert.equal(first.targets.probe.available, true, first.targets?.probe?.reason);
  assert.ok(first.targets.probe.retainedBytes > 100_000, `probe retained only ${first.targets.probe.retainedBytes} bytes`);
  assert.ok(first.targets.probe.largestOwnedNodes.length > 0, 'a resolved target carries its largest owned nodes');
  assert.equal(existsSync(join(root, 'first.heapsnapshot')), false, 'raw snapshot bytes are deleted after a successful capture');

  // Churn and collect between the two captures: an id that only survives while
  // nothing moves would be gone by the second snapshot.
  await probe.evaluate('globalThis.__churn()');
  await probe.client.send('HeapProfiler.collectGarbage');
  await probe.evaluate('globalThis.__makeFresh()');
  const second = await captureHeap(probe.client, join(root, 'second.heapsnapshot'), {
    probe: (await probe.evaluate('globalThis.__probe')).objectId,
    fresh: (await probe.evaluate('globalThis.__fresh')).objectId,
  });
  assert.equal(second.available, true, second.reason);
  assert.deepEqual([second.targets.probe.available, second.targets.fresh.available], [true, true],
    `sequential snapshot lost a target: ${JSON.stringify(second.targets)}`);
  assert.ok(second.targets.fresh.retainedBytes > 50_000, `fresh object retained only ${second.targets.fresh.retainedBytes} bytes`);
  assert.ok(second.targets.probe.retainedBytes > second.targets.fresh.retainedBytes * 1.5,
    `retained size does not follow the objects: probe ${second.targets.probe.retainedBytes}, fresh ${second.targets.fresh.retainedBytes}`);

  const stale = await captureHeap(probe.client, join(root, 'stale.heapsnapshot'), { probe: '{"injectedScriptId":1,"id":999999}' });
  assert.equal(stale.available, false, 'a handle that no longer resolves is reported, not silently absent');
  assert.match(stale.reason, /getHeapObjectId/);
  assert.equal(existsSync(join(root, 'stale.heapsnapshot')), false, 'raw snapshot bytes are deleted after a failed capture too');
});

test('a capture tracks object moves around its ids and stops tracking without a second snapshot', async () => {
  const calls = [];
  const client = {
    on: () => () => {},
    async send(method, params) {
      calls.push(method);
      if (method === 'HeapProfiler.getHeapObjectId') { assert.equal(params.objectId, 'remote-1'); return { heapSnapshotObjectId: '42' }; }
      return {};
    },
  };
  const root = await mkdtemp(join(tmpdir(), 'resource-heap-order-'));
  try {
    const result = await captureHeap(client, join(root, 'ordered.heapsnapshot'), { probe: 'remote-1' });
    assert.equal(result.available, false, 'an empty snapshot file cannot be parsed');
    assert.deepEqual(calls, ['HeapProfiler.startTrackingHeapObjects', 'HeapProfiler.collectGarbage', 'HeapProfiler.collectGarbage',
      'HeapProfiler.getHeapObjectId', 'HeapProfiler.takeHeapSnapshot', 'HeapProfiler.disable', 'HeapProfiler.enable']);
    assert.equal(existsSync(join(root, 'ordered.heapsnapshot')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queryObjects is one checkpoint per process generation and later phases read its published handle', async () => {
  const calls = [];
  const client = {
    async send(method, params = {}) {
      calls.push(`${method}${params.expression ? `:${params.expression.includes(PUBLISHED) ? 'published' : 'other'}` : ''}`);
      if (method === 'Runtime.evaluate') return { result: { objectId: 'published-1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
      return {};
    },
  };
  let queries = 0;
  const registry = new DiscoveryRegistry({ query: async () => { queries += 1; return { group: `g${queries}`, instanceId: 'instance-1', count: 1 }; } });
  const identity = { pid: 41, startToken: 'token-a', moduleUrl: 'module', exportName: 'HostServer' };
  const first = await registry.handle(client, identity);
  const second = await registry.handle(client, identity);
  assert.equal(first.source, 'queryObjects checkpoint');
  assert.equal(second.source, 'published handle');
  assert.equal(queries, 1, 'one generation costs exactly one heap-walking query');
  assert.equal(registry.proved('HostServer'), true);
  assert.equal(registry.proved('WorkerServer'), false);

  // A new process generation is a new checkpoint, never an inherited one.
  await registry.handle(client, { ...identity, pid: 41, startToken: 'token-b' });
  assert.equal(queries, 2);
  assert.doesNotMatch(JSON.stringify(registry.checkpoints()), /41|token-/);
});

test('a lost publication re-pays the checkpoint instead of reporting a handle it does not have', async () => {
  let published = false;
  const client = {
    async send(method) {
      if (method === 'Runtime.evaluate') return { result: published ? { objectId: 'published-1' } : {} };
      if (method === 'Runtime.callFunctionOn') { published = true; return { result: { value: true } }; }
      return {};
    },
  };
  let queries = 0;
  const registry = new DiscoveryRegistry({ query: async () => { queries += 1; return { group: 'g', instanceId: 'i', count: 1 }; } });
  const identity = { pid: 7, startToken: 't', moduleUrl: 'module', exportName: 'WorkerServer' };
  await registry.handle(client, identity);
  published = false;
  const again = await registry.handle(client, identity);
  assert.equal(again.source, 'queryObjects checkpoint');
  assert.equal(queries, 2);
});

class FakeSocket extends EventEmitter {
  static instances = [];
  readyState = 0;
  closeCalls = 0;
  terminateCalls = 0;
  constructor() {
    super(); FakeSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(payload) {
    const request = JSON.parse(payload);
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }))));
  }
  close() { this.closeCalls += 1; this.readyState = 2; }
  terminate() { this.terminateCalls += 1; this.readyState = 2; queueMicrotask(() => { this.readyState = 3; this.emit('close'); }); }
  finishClose() { this.readyState = 3; this.emit('close'); }
}

test('resource RPC response settles only after close and error teardown is bounded', async () => {
  FakeSocket.instances.length = 0;
  let settled = false;
  const pending = settledWebSocketRpc({ WebSocketCtor: FakeSocket, url: 'ws://fixture', request: { id: 1, method: 'fixture' }, timeoutMs: 100 }).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeSocket.instances[0];
  assert.equal(socket.closeCalls, 1);
  assert.equal(settled, false);
  socket.finishClose();
  assert.deepEqual(await pending, { ok: true });

  class ErrorSocket extends FakeSocket {
    send() { queueMicrotask(() => this.emit('error', new Error('fixture failure'))); }
  }
  const failed = settledWebSocketRpc({ WebSocketCtor: ErrorSocket, url: 'ws://fixture', request: { id: 2, method: 'failure' }, timeoutMs: 100 });
  await assert.rejects(failed, /fixture failure/);
  const errored = FakeSocket.instances.at(-1);
  assert.equal(errored.terminateCalls, 1);
  assert.equal(errored.readyState, 3);
  assert.equal(errored.eventNames().length, 0);

  class TimeoutSocket extends FakeSocket { send() {} }
  const timedOut = settledWebSocketRpc({ WebSocketCtor: TimeoutSocket, url: 'ws://fixture', request: { id: 3, method: 'timeout' }, timeoutMs: 5 });
  await assert.rejects(timedOut, /timed out/);
  const silent = FakeSocket.instances.at(-1);
  assert.equal(silent.terminateCalls, 1);
  assert.equal(silent.closeCalls, 0);
  assert.equal(silent.eventNames().length, 0);
});

test('resource RPC ignores notifications and unrelated ids before its response', async () => {
  class CorrelatedSocket extends FakeSocket {
    send(payload) {
      const request = JSON.parse(payload);
      queueMicrotask(() => {
        this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'pi/project/updated', params: {} })));
        this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id + 1, result: { wrong: true } })));
        this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { matched: true } })));
      });
    }
  }
  const pending = settledWebSocketRpc({ WebSocketCtor: CorrelatedSocket, url: 'ws://fixture', request: { id: 7, method: 'correlated' }, timeoutMs: 100 });
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeSocket.instances.at(-1);
  assert.equal(socket.closeCalls, 1);
  socket.finishClose();
  assert.deepEqual(await pending, { matched: true });
  assert.equal(socket.eventNames().length, 0);
});

test('adversarial slow client resumes, terminates and waits for close', async () => {
  const socket = new FakeSocket();
  let resumed = 0;
  socket._socket = { resume() { resumed += 1; } };
  socket.terminate = function () { this.terminateCalls += 1; this.readyState = 2; };
  await new Promise(resolve => setImmediate(resolve));
  let settled = false;
  const closing = closeNodeWebSocket(socket, { force: true, resume: true, timeoutMs: 100 }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, 1);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(settled, false);
  socket.finishClose();
  await closing;
  assert.equal(settled, true);
});

function fixtureViews(projects, sessionsPerProject, beam, chat) {
  const sessions = Array.from({ length: projects * sessionsPerProject }, (_, index) => ({ path: `/project-${index}`, alias: `P-${index}` }));
  const workspace = [
    ...Array.from({ length: beam }, (_, index) => ({ path: `/beam-${index}`, alias: `B-${index}`, kind: 'beam' })),
    ...Array.from({ length: chat }, (_, index) => ({ path: `/chat-${index}`, alias: `C-${index}`, kind: 'chat' })),
  ];
  return { sessions, workspace };
}

test('quick retirement traversal selects every retained view once in stable kind order', async () => {
  const quick = modeConfig('quick'); const values = expected(quick);
  const { sessions, workspace } = fixtureViews(quick.projects, quick.sessionsPerProject, quick.workspaceSessionsPerKind, quick.workspaceSessionsPerKind);
  const selected = [];
  const result = await traverseRetainedViews({}, sessions, workspace, values.retainedViews, { select: async (_check, session) => selected.push(session.path) });
  assert.deepEqual(result, { visited: values.retainedViews, unique: values.retainedViews, project: values.projectSessions, beam: 1, chat: 1 });
  assert.deepEqual(selected, [...sessions, ...workspace].map(session => session.path));
});

test('full retirement traversal selects every retained view once in stable kind order', async () => {
  const full = modeConfig('full'); const values = expected(full);
  const { sessions, workspace } = fixtureViews(full.projects, full.sessionsPerProject, full.workspaceSessionsPerKind, full.workspaceSessionsPerKind);
  const selected = [];
  const result = await traverseRetainedViews({}, sessions, workspace, values.retainedViews, { select: async (_check, session) => selected.push(session.path) });
  assert.deepEqual(result, { visited: values.retainedViews, unique: values.retainedViews, project: values.projectSessions, beam: 2, chat: 2 });
  assert.equal(new Set(selected).size, values.retainedViews);
  assert.deepEqual(selected.slice(-4), workspace.map(session => session.path));
});

// A view whose rows only ever change because a real "Load more" was clicked.
function pagedSidebar({ rows, holds = () => false, onClick }) {
  const state = { rows, clicks: 0, labels: [] };
  const view = {
    state,
    isRowVisible: async () => holds(state),
    rowCount: async () => state.rows,
    loadMore: async () => ({
      label: state.rows >= 21 ? 'Show fewer' : 'Load more',
      click: async () => { state.clicks += 1; onClick(state); },
    }),
  };
  return view;
}
function fakeClock() {
  const clock = { ms: 0 };
  return { now: () => clock.ms, sleepFor: async (ms) => { clock.ms += ms; } };
}

test('the sidebar row view reads only the active tabpanel and the session’s own group', async () => {
  const calls = [];
  const locator = (path) => {
    const node = {
      path,
      getByRole: (role, options = {}) => locator(`${path} > role=${role}${options.name === undefined ? '' : `[name=${options.name}]`}`),
      locator: (selector) => locator(`${path} > ${selector}`),
      filter: () => node, first: () => node,
      count: async () => { calls.push(`count:${path}`); return 0; },
      isVisible: async () => { calls.push(`isVisible:${path}`); return false; },
      textContent: async () => '', click: async () => {}, waitFor: async () => {},
    };
    return node;
  };
  const page = { getByRole: (role, options = {}) => locator(`role=${role}[name=${options.name}]`), locator: (selector) => locator(selector) };
  const view = sidebarRowView({ page }, { cwd: '/tmp/project one', alias: 'R1-S1', kind: 'code' });
  const group = 'role=region[name=Sessions] > role=tabpanel > section[data-cwd="/tmp/project one"]';
  assert.equal(view.group.path, group);
  assert.ok(view.trigger.path.startsWith(`${group} > [data-slot="aui_thread-list-item-trigger"]`));
  assert.equal(await view.loadMore(), null, 'an invisible control is not a control');
  assert.deepEqual(calls.filter(call => call.startsWith('isVisible:')), [
    `isVisible:${group} > role=button[name=/^(Load more|Show fewer|Loading chats…)$/]`,
  ]);
  assert.equal(await view.rowCount(), 0);
  assert.deepEqual(calls.filter(call => call.startsWith('count:')), [`count:${group} > [data-slot="aui_thread-list-item-trigger"]`]);
});

test('a row already shown is selected without touching Load more', async () => {
  const view = pagedSidebar({ rows: 7, holds: () => true, onClick: () => assert.fail('a visible row must not page the sidebar') });
  view.loadMore = async () => assert.fail('a visible row must not read the Load more control');
  assert.deepEqual(await revealSessionRow(view, { alias: 'R1-S3', expectedRows: 10 }), { alias: 'R1-S3', clicks: 0, revealedBy: 'already shown' });
});

test('one real Load more click reveals the titled row behind the fold', async () => {
  const clock = fakeClock();
  const view = pagedSidebar({ rows: 7, holds: (state) => state.rows >= 10, onClick: (state) => { state.rows = 10; } });
  assert.deepEqual(await revealSessionRow(view, { alias: 'R1-S1', expectedRows: 10, ...clock }), { alias: 'R1-S1', clicks: 1, revealedBy: 'Load more' });
  assert.equal(view.state.clicks, 1, 'the bounded reveal clicks exactly one page');
});

test('a row that never appears fails at the bound set by the retained rows and page increments', async () => {
  const clock = fakeClock();
  const view = pagedSidebar({ rows: 7, holds: () => false, onClick: (state) => { state.rows += 7; } });
  await assert.rejects(revealSessionRow(view, { alias: 'R1-S1', expectedRows: 10, ...clock }),
    /did not appear after 2 real "Load more" clicks, the bound for 10 retained rows in pages of 7/);
  assert.equal(view.state.clicks, 2, 'the reveal stops at its bound instead of clicking forever');
});

test('a Load more click that reveals nothing fails as no progress, not as a retry', async () => {
  const clock = fakeClock();
  const view = pagedSidebar({ rows: 7, holds: () => false, onClick: () => {} });
  await assert.rejects(revealSessionRow(view, { alias: 'R1-S1', expectedRows: 10, settleMs: 500, pollMs: 100, ...clock }),
    /made no progress for R1-S1: 7 rows before and after one real click within 500 ms/);
  assert.equal(view.state.clicks, 1, 'no progress stops after the first click');
});

test('paging refuses to guess when the retained row count of the group is unknown', async () => {
  const view = pagedSidebar({ rows: 7, holds: () => false, onClick: () => assert.fail('an unbounded reveal must not click') });
  await assert.rejects(revealSessionRow(view, { alias: 'R1-S1' }), /needs the known retained row count/);
});

test('sampled processes are classified from structural evidence, never argv or a path', () => {
  const map = { hostPid: 10, hostDescendants: [10, 11, 12], rendererPid: 90 };
  assert.equal(classifySampledProcess(10, map), 'host');
  assert.equal(classifySampledProcess(12, map), 'host descendant (worker or worker child)');
  assert.equal(classifySampledProcess(90, map), 'renderer of the measured page');
  assert.equal(classifySampledProcess(91, map), 'browser child outside the host process tree');
  assert.equal(classifySampledProcess(11, { ...map, inventoryRole: 'worker', inventoryLabel: 'node' }),
    'host descendant (worker or worker child) · inventory role worker (node)');
});

test('a safety refusal is described by role, ceiling and the last renderer snapshot, with no identity', () => {
  const detail = safetyRefusalDetail({
    phase: 'pre-detach',
    reason: 'Safety refusal: a sampled process PSS crossed 1610612736.',
    offenders: [{ role: 'renderer of the measured page', pssBytes: 1_700_000_000, privateResidentBytes: 1_650_000_000 }],
    totalPssBytes: 2_400_000_000, processCount: 7,
    lastRendererSnapshot: { phase: 'bash-complete', ageMs: 41_000 },
  });
  assert.equal(detail.enforcedAt, "start of phase, before this phase's heap capture");
  assert.equal(detail.ceilingBytes, SAFETY.processPssBytes);
  const message = safetyRefusalMessage(detail);
  assert.match(message, /before this phase's heap capture "pre-detach"/);
  assert.match(message, /renderer of the measured page PSS 1700000000/);
  assert.match(message, /last renderer heap snapshot: phase bash-complete, 41000 ms earlier/);
  assert.doesNotMatch(JSON.stringify(detail), /"pid"|startToken|\/home|\/tmp/);
  assert.doesNotThrow(() => assertRedacted(message));
  assert.match(safetyRefusalMessage(safetyRefusalDetail({ phase: 'baseline', reason: 'r' })), /no renderer heap snapshot had been taken yet/);
});

test('a failed run persists a sanitized partial report atomically and refuses an unsafe one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-partial-'));
  try {
    const report = { mode: 'quick', startedAtMs: 1, phases: [{ name: 'baseline' }, { name: 'bash-complete' }],
      scenarios: { '1-baseline': 'complete' }, rankings: {}, slopes: {}, pass: true,
      safetyRefusal: safetyRefusalDetail({ phase: 'pre-detach', reason: 'Safety refusal: a sampled process PSS crossed 1610612736.',
        offenders: [{ role: 'renderer of the measured page', pssBytes: 1_700_000_000 }] }) };
    const partial = partialFailureReport(report, new Error('Safety refusal: process 1273643 PSS crossed 1610612736.'), { survivors: [] });
    assert.equal(partial.pass, false);
    assert.equal(partial.startedAtMs, undefined);
    assert.deepEqual(partial.failure.phaseNames, ['baseline', 'bash-complete']);
    assert.deepEqual([partial.failure.phasesCompleted, partial.failure.survivors], [2, 0]);
    assert.equal(partial.failure.message, 'Safety refusal: a sampled process PSS crossed 1610612736.');
    assert.doesNotMatch(JSON.stringify(partial), /1273643|startToken/);

    const path = await writeAtomicJson(join(root, 'report-partial.json'), partial);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), partial);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);

    await assert.rejects(writeAtomicJson(join(root, 'unsafe.json'), { ...partial, leak: '/home/person/project/file.ts' }), /Unsafe resource report content/);
    assert.equal(existsSync(join(root, 'unsafe.json')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('in-worker retention expectations: no finished command keeps a tail buffer, metadata still follows its generation', () => {
  const calls = [
    { background: false, generation: 'a' }, { background: false, generation: 'a' }, { background: false, generation: 'a' },
    { background: true, generation: 'a' }, { background: true, generation: 'a' }, { background: true, generation: 'a' },
  ];
  // RP-6: the tail buffer of a command that has ended is released at terminal
  // delivery, so the expected count is zero whatever the generations did. The
  // *metadata* rows are unchanged: they still belong to the generation that
  // ran them, and a worker that was replaced took its rows with it.
  assert.deepEqual(expectedRetainedCounts({ calls, heavyToolGeneration: 'a', currentGeneration: 'a' }),
    { tailBuffers: 0, workerBackgroundTasks: 3, sameGenerationCalls: 6, replacedGenerationCalls: 0, heavyToolGenerationSurvived: true });
  assert.deepEqual(expectedRetainedCounts({ calls, heavyToolGeneration: 'pre-a', currentGeneration: 'a' }),
    { tailBuffers: 0, workerBackgroundTasks: 3, sameGenerationCalls: 6, replacedGenerationCalls: 0, heavyToolGenerationSurvived: false });
  const spanning = [...calls.slice(0, 4).map(call => ({ ...call, generation: 'a' })), ...calls.slice(4).map(call => ({ ...call, generation: 'b' }))];
  assert.deepEqual(expectedRetainedCounts({ calls: spanning, heavyToolGeneration: 'a', currentGeneration: 'b' }),
    { tailBuffers: 0, workerBackgroundTasks: 2, sameGenerationCalls: 2, replacedGenerationCalls: 4, heavyToolGenerationSurvived: false });
  assert.deepEqual(expectedRetainedCounts({ calls, heavyToolGeneration: null, currentGeneration: null }),
    { tailBuffers: 0, workerBackgroundTasks: 0, sameGenerationCalls: 0, replacedGenerationCalls: 6, heavyToolGenerationSurvived: false });
  assert.deepEqual(expectedRetainedCounts(), { tailBuffers: 0, workerBackgroundTasks: 0, sameGenerationCalls: 0, replacedGenerationCalls: 0, heavyToolGenerationSurvived: false });
});

const workerGuardRow = (overrides = {}) => ({
  kind: 'worker', available: true, runningTasks: 0, pendingQuestions: 0, pendingApprovals: 0, runningTools: 0, ...overrides,
});

test('guard proof re-samples a worker that vanished between connect and read, then asserts zero work', async () => {
  const samples = [
    { guards: retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1 }), readable: 1, unreadable: ['Expected exactly 1 live WorkerServer; found 0.'] },
    { guards: retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1, runningTasks: 1 }, [workerGuardRow({ runningTools: 1 })]), readable: 2, unreadable: [] },
    { guards: retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1 }, [workerGuardRow()]), readable: 2, unreadable: [] },
  ];
  let taken = 0; const slept = [];
  const proved = await proveNoLiveWork(async () => samples[taken++], { deadlineMs: 1_000, sleepFor: async ms => slept.push(ms) });
  assert.equal(taken, 3);
  assert.equal(proved.attempts, 3);
  assert.deepEqual([proved.readable, proved.unreadable], [2, []]);
  assert.deepEqual(proved.guards, retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1 }, [workerGuardRow()]));
  assert.equal(slept.length, 2);
});

test('guard proof fails with sanitized reasons, readable/unreadable counts and the last guards', async () => {
  let clock = 0;
  const sample = async () => ({
    guards: retirementGuardSnapshot({ connections: 2, attachmentRefs: 2, attachedPaths: 1, runningSessions: 1 }, [workerGuardRow({ pendingApprovals: 1 })]),
    readable: 1,
    unreadable: ['/home/person/project/worker.js: counters unreachable for 123e4567-e89b-12d3-a456-426614174000'],
  });
  await assert.rejects(
    proveNoLiveWork(sample, { deadlineMs: 300, now: () => (clock += 200), sleepFor: async () => {} }),
    error => {
      assert.match(error.message, /readableWorkers=1 unreadableWorkers=1/);
      assert.match(error.message, /<path>/);
      assert.doesNotMatch(error.message, /home\/person|426614174000/);
      assert.match(error.message, /"runningSessions":1/);
      assert.match(error.message, /"pendingApprovals":1/);
      assert.doesNotThrow(() => assertRedacted(error.message));
      return true;
    },
  );
});

test('retirement guard projection is count-only and distinguishes every blocker', () => {
  const snapshot = retirementGuardSnapshot(
    { connections: 2, attachmentRefs: 3, attachedPaths: 2, runningSessions: 1, liveRuns: 1, runningTasks: 1, attentionDialogs: 1, cwd: '/secret/project' },
    [workerGuardRow({ runningTasks: 1, pendingQuestions: 1, pendingApprovals: 1, runningTools: 1, path: '/secret/session' })],
  );
  assert.deepEqual(snapshot, { productConnections: 2, attachmentRefs: 3, attachedPaths: 2, runningSessions: 1, liveRuns: 1,
    runningTasks: 2, attentionDialogs: 1, pendingQuestions: 1, pendingApprovals: 1, runningTools: 1 });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|project|session/);
  assert.throws(() => assertNoLiveWork(snapshot), /not settled/);
  assert.doesNotThrow(() => assertNoLiveWork(retirementGuardSnapshot()));
});

// --- phase capture order, identity and coverage ------------------------------

function fakeInspectorClient(counters = { connections: 0 }) {
  return {
    async send(method, params = {}) {
      if (method === 'Runtime.callFunctionOn') {
        const worker = String(params.functionDeclaration).includes("kind:'worker'");
        return { result: { value: worker ? { kind: 'worker', available: true, sessions: 1, tasks: 0, runningTasks: 0, pendingQuestions: 0, pendingApprovals: 0, runningTools: 0 } : { kind: 'host', ...counters } } };
      }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'published-1' } };
      return {};
    },
    on: () => () => {},
    async close() {},
  };
}

function soakRunFixture({ order = [], census, touched = [], workerCounterFails = false } = {}) {
  const config = modeConfig('quick');
  const check = {
    root: '/tmp/ignored',
    fixture: { hostRecord: { pid: 1234 }, inspectDir: '/tmp/ignored' },
    async rpc(method) {
      order.push(`rpc:${method}`);
      return { snapshot: { processes: [], totals: { coverage: 'complete', knownPhysicalBytes: 0, physical: { value: 0 } }, byRole: [], health: { collectors: [], crossCheck: { status: 'ok' } } } };
    },
    page: new Proxy({ url: () => 'http://fixture/app' }, { get(target, property) { touched.push(`page.${String(property)}`); return target[property]; } }),
    cdp: new Proxy({}, { get(_t, property) { touched.push(`cdp.${String(property)}`); throw new Error(`sampling touched cdp.${String(property)}`); } }),
    browserCdp: new Proxy({}, { get(_t, property) { touched.push(`browserCdp.${String(property)}`); throw new Error(`sampling touched browserCdp.${String(property)}`); } }),
  };
  const report = { mode: 'quick', startedAtMs: Date.now(), phases: [], rankings: {}, slopes: {}, scenarios: {} };
  const run = new SoakRun(check, { config, expected: expected(config), report, modules: { host: 'h', worker: 'w', tail: 't' }, mode: 'quick', checkout: '/tmp/ignored' });
  run.census = { take: async (...args) => { order.push('census'); return census(...args); } };
  run.inspectorSet = async () => {
    order.push('inspectorSet');
    const workers = workerCounterFails
      ? [{ record: { pid: 2 }, client: { send: async () => { throw new Error('worker vanished'); }, on: () => () => {}, close: async () => {} }, handle: { objectId: 'w', group: 'g' } }]
      : [];
    return { records: [], host: { record: { pid: 1234 }, client: fakeInspectorClient(), handle: { objectId: 'h', group: 'g' } }, workers, unreadableWorkers: [] };
  };
  run.closeInspectorSet = async () => { order.push('closeInspectorSet'); };
  run.rendererPid = async () => { order.push('rendererPid'); return 99; };
  run.rendererCounters = async () => { order.push('rendererCounters'); return { storeReachable: true, ownerBytes: [] }; };
  return { run, report, order, touched };
}

const completeCensus = rows => ({
  rows, unreadable: [], exited: [], replaced: [], missingRequired: [],
  coverage: { scope: 'test', expected: rows.length, measured: rows.length, complete: true, unreadableProcesses: 0, exitedProcesses: 0, replacedProcesses: 0,
    includedRoles: ['host'], excludedRoles: ['browser'], note: 'test' },
});

test('a phase takes its process rows before any inspector, query or heap work', async () => {
  const order = [];
  const { run } = soakRunFixture({ order, census: async () => completeCensus([{ pid: 1234, startToken: 't', pssBytes: 10, privateResidentBytes: 5 }]) });
  const phase = await run.samplePhase('ordered');
  assert.deepEqual(order.slice(0, 3), ['rendererPid', 'census', 'rendererCounters'],
    `process rows must precede inspector work, saw ${order.join(' → ')}`);
  assert.ok(order.indexOf('census') < order.indexOf('inspectorSet'), 'the natural sample precedes any inspector connection');
  assert.equal(phase.natural.label, 'before any inspector, query or heap work');
  assert.equal(phase.tailBuffers.phase, 'post-gc');
  assert.match(phase.tailBuffers.measuredBy, /after the natural sample/);
  assert.equal(phase.totalPssBytes, 10);
});

test('a closed page is measured without touching the page, its CDP session or renderer counters', async () => {
  const order = [];
  const touched = [];
  const { run } = soakRunFixture({ order, touched, census: async () => completeCensus([{ pid: 1234, startToken: 't', pssBytes: 10, privateResidentBytes: 5 }]) });
  const phase = await run.samplePhase('retired', { includeWorkers: false, pageClosed: true });
  assert.equal(phase.renderer, null);
  assert.equal(phase.rendererStatus, 'unavailable: app page closed before this phase');
  assert.ok(!order.includes('rendererPid') && !order.includes('rendererCounters'), 'a closed page is never asked for counters');
  assert.deepEqual(touched, [], `a closed page must not be touched at all, saw ${touched.join(', ')}`);
  const metrics = closedPageMetrics();
  assert.deepEqual([metrics.domNodes, metrics.longTasks, metrics.renderCounts], [null, null, null]);
  assert.match(metrics.note, /closed before teardown/);
});

test('an unreadable worker counter is recorded, never counted as zero', async () => {
  const { run } = soakRunFixture({ census: async () => completeCensus([{ pid: 1234, startToken: 't', pssBytes: 10, privateResidentBytes: 5 }]), workerCounterFails: true });
  const phase = await run.samplePhase('unreadable-worker');
  assert.equal(phase.unreadableWorkers, 1);
  assert.equal(phase.workers.length, 0, 'a worker that could not be read contributes no row at all');
  assert.doesNotThrow(() => assertRedacted(JSON.stringify(phase.unreadableWorkerReasons)));
});

test('an expected process that cannot be read makes totals null, coverage false and safety inconclusive', async () => {
  const census = new ProcessCensus({
    hostPid: 1,
    descendants: async () => [1, 2],
    sample: async pid => {
      if (pid === 1) return { pid: 1, startToken: 'a', pssBytes: 100, privateResidentBytes: 90 };
      throw new Error('EACCES: permission denied, open /proc/2/smaps_rollup');
    },
  });
  const taken = await census.take({ rendererPid: null, requiredPids: [1] });
  assert.equal(taken.coverage.complete, false);
  assert.equal(taken.coverage.unreadableProcesses, 1);
  const totals = censusTotals(taken);
  assert.deepEqual([totals.totalPssBytes, totals.totalPrivateResidentBytes], [null, null]);
  assert.deepEqual(totals.coverage.includedRoles.length > 0 && totals.coverage.excludedRoles.length > 0, true);
  await assert.rejects(verdictFor(taken), /coverage is inconclusive/);
});

test('a stat row without Linux physical metrics is unreadable, never complete coverage', async () => {
  const census = new ProcessCensus({
    hostPid: 1,
    descendants: async () => [1],
    sample: async () => ({ pid: 1, startToken: 'a', pssBytes: null, privateResidentBytes: null }),
  });
  const taken = await census.take({ requiredPids: [1] });
  assert.equal(taken.coverage.complete, false);
  assert.equal(taken.coverage.unreadableProcesses, 1);
  assert.deepEqual([censusTotals(taken).totalPssBytes, censusTotals(taken).totalPrivateResidentBytes], [null, null]);
  await assert.rejects(verdictFor(taken), /coverage is inconclusive/);
});

test('a process that exited is not an unreadable row, and a reused pid is re-identified', async () => {
  const seen = [];
  const census = new ProcessCensus({
    hostPid: 1,
    descendants: async () => [1, 2],
    sample: async (pid, expectedToken) => {
      seen.push([pid, expectedToken ?? null]);
      if (pid === 2 && seen.length === 2) return { pid: 2, startToken: 'first', pssBytes: 1, privateResidentBytes: 1 };
      if (pid === 2 && expectedToken === 'first') throw new Error('Process changed identity before resource sampling.');
      if (pid === 2) return { pid: 2, startToken: 'second', pssBytes: 2, privateResidentBytes: 2 };
      return { pid: 1, startToken: 'a', pssBytes: 10, privateResidentBytes: 9 };
    },
  });
  await census.take({ requiredPids: [1] });
  const again = await census.take({ requiredPids: [1] });
  assert.deepEqual(again.replaced, [2]);
  assert.equal(again.coverage.complete, true);
  assert.equal(censusTotals(again).totalPssBytes, 12);

  const gone = new ProcessCensus({ hostPid: 1, descendants: async () => [1, 3],
    sample: async pid => { if (pid === 3) throw new Error('ENOENT: no such file or directory'); return { pid: 1, startToken: 'a', pssBytes: 7, privateResidentBytes: 7 }; } });
  const result = await gone.take({ requiredPids: [1] });
  assert.deepEqual([result.exited, result.unreadable], [[3], []]);
  assert.equal(result.coverage.complete, true, 'a process that exited is not a hole in coverage');
});

// --- scenario 8 and 9 races ---------------------------------------------------

test('a stalled client is resumed and closed even when its body throws', async () => {
  for (const failing of [false, true]) {
    let resumed = 0; let closed = 0;
    const socket = { _socket: { resume: () => { resumed += 1; } } };
    const body = async () => { if (failing) throw new Error('slow socket crossed safety ceiling'); return 5; };
    const call = withStalledClient(socket, body, { close: async (_socket, options) => { closed += 1; assert.deepEqual(options, { force: true, resume: true }); } });
    if (failing) await assert.rejects(call, /safety ceiling/);
    else assert.equal(await call, 5);
    assert.deepEqual([resumed, closed], [1, 1]);
  }
});

test('dormant views are every retained view except the one on screen', () => {
  assert.deepEqual(dormantViews(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(dormantViews(['a'], 'a'), []);
  assert.deepEqual(dormantViews(['a', 'b'], null), ['a', 'b']);
});

test('reattached delivery reconciles in either arrival order and never on a stale snapshot', async () => {
  const clock = fakeClock();
  const sequences = {
    'terminal first': [{ entries: 4, streaming: false }, { entries: 4, streaming: true }, { entries: 6, streaming: true }, { entries: 6, streaming: false }],
    'entries first': [{ entries: 6, streaming: true }, { entries: 6, streaming: true }, { entries: 6, streaming: false }],
    'duplicates': [{ entries: 4, streaming: false }, { entries: 6, streaming: false }],
  };
  for (const [label, frames] of Object.entries(sequences)) {
    let index = 0;
    const result = await reconcileDelivery(async () => frames[Math.min(index++, frames.length - 1)], { baselineEntries: 4, deadlineMs: 5_000, pollMs: 10, ...fakeClock() });
    assert.deepEqual([result.settled, result.entries, result.grewBy], [true, 6, 2], `${label} did not reconcile`);
  }
  await assert.rejects(reconcileDelivery(async () => ({ entries: 4, streaming: true }), { baselineEntries: 4, deadlineMs: 500, pollMs: 100, ...clock }),
    /was not reconciled: baselineEntries=4 lastEntries=4 lastStreaming=true sawGrowth=false sawTerminal=false/);
});

// --- parser validation --------------------------------------------------------

test('the parser costs its typed arrays before allocating them and refuses a graph it cannot hold', () => {
  const small = graphBudget(1_000_000, 4_000_000);
  assert.deepEqual([small.bytes, small.fits], [1_000_000 * 24 + 4_000_000 * 4, true]);
  const huge = graphBudget(40_000_000, 160_000_000);
  assert.equal(huge.fits, false);
  assert.equal(huge.budget, 512 * 1024 * 1024);
});

test('the parser validates every field, count and edge target it depends on', () => {
  const meta = { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['object']], edge_fields: ['type', 'name_or_index', 'to_node'] };
  assert.deepEqual(validateHeader({ meta, node_count: 2, edge_count: 1 }).index.to_node, 2);
  assert.throws(() => validateHeader({}), /no meta/);
  assert.throws(() => validateHeader({ meta: { ...meta, node_fields: ['type'] }, node_count: 1, edge_count: 0 }), /no name node field/);
  assert.throws(() => validateHeader({ meta: { ...meta, edge_fields: ['type'] }, node_count: 1, edge_count: 0 }), /no to_node edge field/);
  assert.throws(() => validateHeader({ meta, node_count: -1, edge_count: 0 }), /unusable node_count/);
  assert.throws(() => validateHeader({ meta, node_count: 1 }), /unusable edge_count/);
});

test('a malformed or truncated snapshot is unavailable, never a wrong number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-heap-bad-'));
  const parser = new URL('../resource/heap-parser.mjs', import.meta.url).pathname;
  const meta = { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['synthetic', 'object']], edge_fields: ['type', 'name_or_index', 'to_node'] };
  const run = async (name, body) => {
    const file = join(root, name);
    await writeFile(file, body);
    const { stdout } = await execFileAsync(process.execPath, ['--max-old-space-size=64', parser, file, JSON.stringify({ target: 7 })]);
    return JSON.parse(stdout);
  };
  try {
    const truncated = await run('truncated.json', '{"snapshot":{"meta":' + JSON.stringify(meta) + ',"node_count":2,"edge_count":1},"nodes":[0,0,1,0,1,1,1,7,10');
    assert.equal(truncated.available, false);
    assert.match(truncated.reason, /ended inside a numeric array/);

    const misaligned = await run('misaligned.json', '{"snapshot":{"meta":' + JSON.stringify(meta) + ',"node_count":2,"edge_count":1},"nodes":[0,0,1,0,1,1,1,7,10,0],"edges":[2,3,3],"strings":["a"]}');
    assert.equal(misaligned.available, false);
    assert.match(misaligned.reason, /points outside the nodes array/);

    const miscounted = await run('miscounted.json', '{"snapshot":{"meta":' + JSON.stringify(meta) + ',"node_count":2,"edge_count":5},"nodes":[0,0,1,0,1,1,1,7,10,0],"edges":[2,3,5],"strings":["a"]}');
    assert.equal(miscounted.available, false);
    assert.match(miscounted.reason, /edge counts sum to/);

    const headerless = await run('headerless.json', '{"nodes":[0,0,1,0,0],"edges":[],"strings":[]}');
    assert.equal(headerless.available, false);
    assert.match(headerless.reason, /header is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// --- sanitization and refusals ------------------------------------------------

test('a bare transcript basename is sanitized at ingestion and refused in a report', () => {
  const settleTimeout = 'Timed out waiting for session session-IMRrrr to settle.';
  assert.equal(sanitizeOwner(settleTimeout), 'Timed out waiting for session <session> to settle.');
  assert.equal(sanitizeError(new Error(settleTimeout)), 'Timed out waiting for session <session> to settle.');
  assert.throws(() => assertRedacted(settleTimeout), /session-IMRrrr/);
  assert.equal(sanitizeOwner('/home/person/sessions/session-IMRrrr.jsonl'), '<path>');
  assert.equal(sanitizeOwner('renderer/state.open/session-abc123/entries'), 'renderer/state.open/<session>/entries');
  assert.doesNotThrow(() => assertRedacted(sanitizeOwner(settleTimeout)));
});

test('a partial report that redaction refuses is reported, never swallowed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-partial-'));
  try {
    const written = [];
    const refusing = async (path, value) => {
      const text = JSON.stringify(value);
      assertRedacted(text);
      written.push(path);
      return path;
    };
    const safe = await writePartialReport(root, { phases: [], scenarios: {} }, new Error('Safety refusal: a sampled process PSS crossed 1.'), { survivors: [] }, { write: refusing });
    assert.equal(safe.written, true);

    const unsafe = await writePartialReport(root, { phases: [], scenarios: { '1-baseline': 'complete' }, leak: '/home/person/project/file.ts' },
      new Error('Timed out waiting for session session-IMRrrr to settle.'), { survivors: [] }, { write: refusing });
    assert.equal(unsafe.written, false);
    assert.equal(unsafe.refused, true);
    assert.match(unsafe.reason, /Unsafe resource report content/);
    assert.match(written.at(-1), /report-partial-refused\.json$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// --- comparison policy, provider accounting, scenario contract ----------------

test('repeatability is gated per category: structural owners strictly, sampled evidence loosely', () => {
  const scenarios = Object.fromEntries(SCENARIO_IDS.map(id => [id, 'complete']));
  const owners = (names, base = 5) => names.map((owner, index) => ({ owner, bytes: (base - index) * 10 }));
  const structural = ['sessions', 'tasks', 'logs', 'socket', 'pool'];
  const shuffledTop = ['tasks', 'sessions', 'logs', 'socket', 'pool'];
  const slopes = { host: { value: 2 } };
  const a = { scenarios, slopes, rankings: { host: owners(structural), 'host-allocation': owners(structural) } };
  const b = { scenarios, slopes: { host: { value: 3 } }, rankings: { host: owners(shuffledTop), 'host-allocation': owners(shuffledTop) } };
  const result = compareRuns(a, b);
  assert.equal(result.categories.host.policy, 'strict');
  assert.equal(result.categories.host.pass, false, 'a structural category must fail when its top owner moves');
  assert.equal(result.categories['host-allocation'].policy, 'evidence');
  assert.equal(result.categories['host-allocation'].pass, true, 'one noisy sampled symbol cannot fail the run on its own');
  assert.equal(result.pass, false);
  // The evidence policy still gates: unrelated owners fail it too.
  const unrelated = { scenarios, slopes, rankings: { 'host-allocation': owners(['x', 'y', 'z', 'w', 'v']) } };
  assert.equal(compareRuns(a, unrelated).categories['host-allocation'].pass, false);
  assert.deepEqual([COMPARISON_POLICY.strict.requireSameTopOwner, COMPARISON_POLICY.evidence.requireSameTopOwner], [true, false]);
});

test('provider accounting asserts the exact routes this workload drives', () => {
  const config = modeConfig('quick');
  const values = expected(config);
  const routes = {};
  for (let i = 1; i <= values.seedRequests; i++) routes[`seed:S${i}:1`] = 1;
  Object.assign(routes, {
    'resource:large-stream': 2, 'resource:tool-large': 2, 'resource:images': 1,
    'resource:reattached': 1, First: 15, 'Tool:': 15,
  });
  for (let i = 1; i <= config.children; i++) { routes[`resource:start-child:${i}`] = 2; routes[`resource:child:${i}`] = 1; }
  for (let i = 1; i <= config.foregroundCalls; i++) routes[`resource:bash:fg:${i}`] = 2;
  for (let i = 1; i <= config.backgroundCalls; i++) routes[`resource:bash:bg:${i}`] = 2;
  const accounting = providerAccounting({ requests: 999, routes }, config, values);
  assert.deepEqual(accounting.mismatches, []);
  assert.equal(accounting.buckets.engineInternal, 30, 'engine-driven requests are counted apart from the harness routes');
  assert.deepEqual(accounting.childRuns, { observed: config.children, started: config.children });

  const short = providerAccounting({ requests: 1, routes: { ...routes, 'resource:bash:fg:1': 1 } }, config, values);
  assert.deepEqual(short.mismatches, [`bash: expected ${values.bashCalls * 2}, saw ${values.bashCalls * 2 - 1}`]);
});

test('every scenario declares the ids it completes, and nothing is marked complete without a phase', () => {
  const ids = BROWSER_SCENARIOS.flatMap(scenario => scenario.ids ?? [scenario.id]);
  assert.deepEqual(ids, ['1-baseline', '2-distinct-sessions', '6-multiple-projects-and-workspaces', '3-backward-pagination',
    '4-large-content-and-images', '5-children-and-bash', '8-slow-consumer', '9-detach-and-retirement']);
  assert.equal(SCENARIO_IDS.length, 9, 'nine scenarios, including the desktop lane');
  for (const scenario of BROWSER_SCENARIOS) assert.equal(typeof scenario.run, 'function', `${scenario.id} has no run`);
});

test('a small structural category is gated by what it has, not by an unreachable five', () => {
  const scenarios = Object.fromEntries(SCENARIO_IDS.map(id => [id, 'complete']));
  const slopes = { host: { value: 2 } };
  const three = names => names.map((owner, index) => ({ owner, bytes: (3 - index) * 10 }));
  const a = { scenarios, slopes, rankings: { renderer: three(['baseline/stateOpen', 'paged/stateOpen', 'stream/stateOpen']) } };
  const same = { scenarios, slopes: { host: { value: 3 } }, rankings: { renderer: three(['baseline/stateOpen', 'paged/stateOpen', 'stream/stateOpen']) } };
  const moved = { scenarios, slopes: { host: { value: 3 } }, rankings: { renderer: three(['paged/stateOpen', 'baseline/stateOpen', 'stream/stateOpen']) } };
  const stable = compareRuns(a, same).categories.renderer;
  assert.deepEqual([stable.pass, stable.requiredOverlap, stable.owners], [true, 3, { a: 3, b: 3 }]);
  assert.equal(compareRuns(a, moved).categories.renderer.pass, false, 'a moved top owner still fails a structural category');
  assert.equal(compareRuns(a, { scenarios, slopes, rankings: { renderer: [{ owner: 'only', bytes: 1 }] } }).categories.renderer.pass, false,
    'a single owner that is not the other run\u2019s owner is not repeatable');
});

test('a one-owner structural category repeats when its sole owner does, and fails when it changes', () => {
  const scenarios = Object.fromEntries(SCENARIO_IDS.map(id => [id, 'complete']));
  const slopes = { host: { value: 2 } };
  const run = owner => ({ scenarios, slopes, rankings: { host: [{ owner, bytes: 1000 }] } });
  const same = compareRuns(run('HostServer'), run('HostServer'));
  assert.deepEqual([same.categories.host.pass, same.categories.host.topOwnerSame, same.categories.host.commonOwners], [true, true, 1]);
  assert.equal(same.categories.host.spearman, null, 'one common owner has no rank correlation to compute');
  assert.equal(same.categories.host.rankStability, 'trivial: one common owner');
  assert.equal(same.pass, true, 'a legitimate single-owner structural category must not fail the whole comparison');

  const moved = compareRuns(run('HostServer'), run('WorkerServer'));
  assert.equal(moved.categories.host.pass, false, 'a different sole owner is not repeatable');
  assert.equal(moved.categories.host.rankStability, 'unavailable');
  assert.equal(COMPARISON_POLICY.strict.minimumOwners, 1);
});

test('two or more owners still have to correlate above the strict rank threshold', () => {
  const scenarios = Object.fromEntries(SCENARIO_IDS.map(id => [id, 'complete']));
  const slopes = { host: { value: 2 } };
  const rank = names => ({ scenarios, slopes, rankings: { host: names.map((owner, index) => ({ owner, bytes: (names.length - index) * 10 })) } });
  const ordered = ['a', 'b', 'c', 'd', 'e'];
  const stable = compareRuns(rank(ordered), rank(ordered)).categories.host;
  assert.deepEqual([stable.pass, stable.spearman, stable.rankStability], [true, 1, 'correlated']);
  const reversedTail = compareRuns(rank(ordered), rank(['a', 'e', 'd', 'c', 'b'])).categories.host;
  assert.equal(reversedTail.topOwnerSame, true, 'the top owner is unchanged');
  assert.ok(reversedTail.spearman < COMPARISON_POLICY.strict.minimumSpearman);
  assert.equal(reversedTail.pass, false, 'a scrambled tail below the rank threshold still fails');
});

test('a slope repeats only when it points the same way and stays inside the declared spread', () => {
  const scenarios = Object.fromEntries(SCENARIO_IDS.map(id => [id, 'complete']));
  const rankings = { host: [{ owner: 'HostServer', bytes: 1 }] };
  const withSlope = value => ({ scenarios, rankings, slopes: { growth: { status: 'available', value } } });
  const tight = compareRuns(withSlope(1_000_000), withSlope(1_100_000)).slopes.growth;
  assert.equal(tight.pass, true);
  assert.ok(tight.coefficientOfVariation <= SLOPE_POLICY.maximumCoefficientOfVariation);
  assert.equal(tight.flaggedOver25Percent, false);

  const doubled = compareRuns(withSlope(1_000_000), withSlope(2_000_000));
  const wide = doubled.slopes.growth;
  assert.equal(wide.signAgrees, true, 'the sign still agrees');
  assert.ok(wide.coefficientOfVariation > SLOPE_POLICY.maximumCoefficientOfVariation);
  assert.deepEqual([wide.flaggedOver25Percent, wide.pass], [true, false], 'a slope outside the declared spread fails');
  assert.equal(doubled.pass, false, 'and it fails the whole comparison, not just its own row');

  const flipped = compareRuns(withSlope(1_000_000), withSlope(-1_000_000)).slopes.growth;
  assert.deepEqual([flipped.signAgrees, flipped.pass], [false, false]);
  const missing = compareRuns(withSlope(1_000_000), { scenarios, rankings, slopes: { growth: { status: 'unavailable', value: null } } }).slopes.growth;
  assert.deepEqual([missing.available, missing.coefficientOfVariation, missing.pass], [false, null, false]);
  assert.equal(SLOPE_POLICY.maximumCoefficientOfVariation, 0.25);
});

test('a measurement-only calibration run cannot be mistaken for a baseline (RP-5)', async () => {
  // The two-run baseline is what a repeatability claim is made of; a run that
  // stops after one scenario is measurement, and the two can never be mixed.
  await assert.rejects(runResourceSoak({ mode: 'full', runs: 2, until: '3-backward-pagination' }),
    /exactly one run/, 'a stopped run refuses the two-run comparison');
  await assert.rejects(runResourceSoak({ mode: 'full', runs: 3, until: '3-backward-pagination' }),
    /exactly one run/);
  await assert.rejects(runResourceSoak({ mode: 'full', runs: 1, until: 'scenario-that-does-not-exist' }),
    /no scenario called/, 'only a real scenario can stop a run');
  // The default baseline path is untouched: still two runs, still Electron.
  await assert.rejects(runResourceSoak({ mode: 'full', runs: 1 }), /exactly two clean runs/);
  await assert.rejects(runResourceSoak({ mode: 'full', runs: 2 }), /Electron hide\/restore lane/);
});

test('the calibration stop is a scenario the full fixture really has, and stops after the paged history', () => {
  assert.ok(SCENARIO_IDS.includes('3-backward-pagination'));
  const ids = BROWSER_SCENARIOS.flatMap(scenario => scenario.ids ?? [scenario.id]);
  const stop = ids.indexOf('3-backward-pagination');
  assert.ok(stop > ids.indexOf('2-distinct-sessions'), 'fifty distinct sessions are measured before the stop');
  assert.ok(stop < ids.length - 1, 'and scenarios after it exist, so the report must list them as not run');
  // The workload behind those scenarios is the unchanged full fixture.
  const full = modeConfig('full');
  assert.deepEqual({ projects: full.projects, sessionsPerProject: full.sessionsPerProject, longMessages: full.longMessages },
    { projects: 5, sessionsPerProject: 10, longMessages: 240 });
  assert.equal(SAFETY.processPssBytes, Math.floor(1.5 * 1024 * 1024 * 1024));
});

test('terminal TailBuffer discovery is proved by a readable zero, not a retained leak', async () => {
  const scenario = await readFile(new URL('../resource/scenarios/04-large-content-and-images.mjs', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../resource-soak.mjs', import.meta.url), 'utf8');
  assert.match(scenario, /tailBufferProjectionProved: tailBufferReadable/);
  assert.match(scenario, /assert\.equal\(tailBufferCount, 0/);
  assert.match(runner, /tailBuffer: run\.state\.tailBufferProjectionProved === true/);
  assert.doesNotMatch(runner, /tailBuffer: \(run\.state\.tailBufferCount[^\n]+>= 1/);
});
