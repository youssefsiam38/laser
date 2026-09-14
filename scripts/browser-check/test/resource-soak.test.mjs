import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { modeConfig, expected, SAFETY } from '../resource/config.mjs';
import { syntheticPng, imagePayload } from '../resource/fixtures.mjs';
import { theilSen, compareRuns, assertRedacted, sanitizeOwner } from '../resource/report.mjs';
import { connectInspector, InspectorClient } from '../resource/inspector.mjs';
import { captureHeap } from '../resource/heap.mjs';
import { memoryLabels } from '../resource/process-sampler.mjs';
import { dispatchFindShortcut, findShortcutEvents } from '../resource/keyboard.mjs';
import { assertNoLiveWork, classifySampledProcess, closedPageMetrics, connectWorkerInspector, expectedRetainedCounts, partialFailureReport, proveNoLiveWork, rendererSample, retirementGuardSnapshot, revealSessionRow, safetyRefusalDetail, safetyRefusalMessage, sidebarRowView, traverseRetainedViews, writeAtomicJson } from '../resource-soak.mjs';
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
  const b={rankings:{host:[{owner:'sessions',bytes:6},{owner:'tasks',bytes:5},{owner:'logs',bytes:3},{owner:'socket',bytes:2},{owner:'pool',bytes:1}]},slopes:{host:{value:3}},scenarios};
  assert.equal(compareRuns(a,b).pass,true);
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
  const snapshot={snapshot:{meta},nodes:[0,0,1,0,1, 1,1,7,10,1, 1,2,9,20,0],edges:[2,3,5, 2,4,10],strings:['root','Target','Owned','target','owned']};
  await writeFile(file,JSON.stringify(snapshot));
  try {
    const parser=new URL('../resource/heap-parser.mjs',import.meta.url).pathname;
    const {stdout}=await execFileAsync(process.execPath,['--max-old-space-size=64',parser,file,JSON.stringify({target:7})]);
    const result=JSON.parse(stdout); assert.equal(result.targets.target.retainedBytes,30);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('heap capture deletes raw bytes after success and size overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-heap-delete-'));
  const meta={node_fields:['type','name','id','self_size','edge_count'],node_types:[['synthetic'],'string','number','number','number'],edge_fields:['type','name_or_index','to_node'],edge_types:[['property'],'string_or_number','node']};
  const body=JSON.stringify({snapshot:{meta},nodes:[0,0,1,0,0],edges:[],strings:['root']});
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

test('quick retirement traversal selects all five retained views once in stable kind order', async () => {
  const { sessions, workspace } = fixtureViews(1, 3, 1, 1); const selected = [];
  const result = await traverseRetainedViews({}, sessions, workspace, 5, { select: async (_check, session) => selected.push(session.path) });
  assert.deepEqual(result, { visited: 5, unique: 5, project: 3, beam: 1, chat: 1 });
  assert.deepEqual(selected, [...sessions, ...workspace].map(session => session.path));
});

test('full retirement traversal selects all 54 retained views once in stable kind order', async () => {
  const { sessions, workspace } = fixtureViews(5, 10, 2, 2); const selected = [];
  const result = await traverseRetainedViews({}, sessions, workspace, 54, { select: async (_check, session) => selected.push(session.path) });
  assert.deepEqual(result, { visited: 54, unique: 54, project: 50, beam: 2, chat: 2 });
  assert.equal(new Set(selected).size, 54);
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

test('in-worker retention expectations follow the live worker generation', () => {
  const calls = [
    { background: false, generation: 'a' }, { background: false, generation: 'a' }, { background: false, generation: 'a' },
    { background: true, generation: 'a' }, { background: true, generation: 'a' }, { background: true, generation: 'a' },
  ];
  assert.deepEqual(expectedRetainedCounts({ calls, heavyToolGeneration: 'a', currentGeneration: 'a' }),
    { tailBuffers: 7, workerBackgroundTasks: 3, sameGenerationCalls: 6, replacedGenerationCalls: 0, heavyToolGenerationSurvived: true });
  assert.deepEqual(expectedRetainedCounts({ calls, heavyToolGeneration: 'pre-a', currentGeneration: 'a' }),
    { tailBuffers: 6, workerBackgroundTasks: 3, sameGenerationCalls: 6, replacedGenerationCalls: 0, heavyToolGenerationSurvived: false });
  const spanning = [...calls.slice(0, 4).map(call => ({ ...call, generation: 'a' })), ...calls.slice(4).map(call => ({ ...call, generation: 'b' }))];
  assert.deepEqual(expectedRetainedCounts({ calls: spanning, heavyToolGeneration: 'a', currentGeneration: 'b' }),
    { tailBuffers: 2, workerBackgroundTasks: 2, sameGenerationCalls: 2, replacedGenerationCalls: 4, heavyToolGenerationSurvived: false });
  assert.deepEqual(expectedRetainedCounts({ calls, heavyToolGeneration: null, currentGeneration: null }),
    { tailBuffers: 0, workerBackgroundTasks: 0, sameGenerationCalls: 0, replacedGenerationCalls: 6, heavyToolGenerationSurvived: false });
  assert.deepEqual(expectedRetainedCounts(), { tailBuffers: 0, workerBackgroundTasks: 0, sameGenerationCalls: 0, replacedGenerationCalls: 0, heavyToolGenerationSurvived: false });
});

test('guard proof re-samples a worker that vanished between connect and read, then asserts zero work', async () => {
  const samples = [
    { guards: retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1 }), readable: 1, unreadable: ['Expected exactly 1 live WorkerServer; found 0.'] },
    { guards: retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1, runningTasks: 1 }, [{ runningTools: 1 }]), readable: 2, unreadable: [] },
    { guards: retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1 }, [{ runningTools: 0 }]), readable: 2, unreadable: [] },
  ];
  let taken = 0; const slept = [];
  const proved = await proveNoLiveWork(async () => samples[taken++], { deadlineMs: 1_000, sleepFor: async ms => slept.push(ms) });
  assert.equal(taken, 3);
  assert.equal(proved.attempts, 3);
  assert.deepEqual([proved.readable, proved.unreadable], [2, []]);
  assert.deepEqual(proved.guards, retirementGuardSnapshot({ connections: 1, attachmentRefs: 1, attachedPaths: 1 }, [{ runningTools: 0 }]));
  assert.equal(slept.length, 2);
});

test('guard proof fails with sanitized reasons, readable/unreadable counts and the last guards', async () => {
  let clock = 0;
  const sample = async () => ({
    guards: retirementGuardSnapshot({ connections: 2, attachmentRefs: 2, attachedPaths: 1, runningSessions: 1 }, [{ pendingApprovals: 1 }]),
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

test('post-close sampling touches no page, CDP or renderer counter, and says so', async () => {
  const forbidden = new Proxy({}, { get(_target, property) { throw new Error(`post-close sampling touched check.${String(property)}`); } });
  let pidCalls = 0; let counterCalls = 0;
  const injected = { pid: async () => { pidCalls += 1; return 4242; }, counters: async () => { counterCalls += 1; return { storeReachable: true }; } };
  const closed = await rendererSample(forbidden, { pageClosed: true }, injected);
  assert.deepEqual(closed, { pid: null, renderer: null, status: 'unavailable: app page closed before this phase' });
  assert.deepEqual([pidCalls, counterCalls], [0, 0]);

  const live = await rendererSample({ page: { url: () => 'http://fixture/app' } }, {}, injected);
  assert.deepEqual(live, { pid: 4242, renderer: { storeReachable: true }, status: 'available' });
  const blank = await rendererSample({ page: { url: () => 'about:blank' } }, {}, injected);
  assert.deepEqual(blank, { pid: 4242, renderer: null, status: 'unavailable: blank page' });
  assert.deepEqual([pidCalls, counterCalls], [2, 1]);

  const metrics = closedPageMetrics();
  assert.deepEqual([metrics.domNodes, metrics.longTasks, metrics.renderCounts], [null, null, null]);
  assert.match(metrics.note, /closed before teardown/);
  assert.doesNotThrow(() => assertRedacted(JSON.stringify({ ...closed, metrics })));
});

test('retirement guard projection is count-only and distinguishes every blocker', () => {
  const snapshot = retirementGuardSnapshot(
    { connections: 2, attachmentRefs: 3, attachedPaths: 2, runningSessions: 1, liveRuns: 1, runningTasks: 1, attentionDialogs: 1, cwd: '/secret/project' },
    [{ runningTasks: 1, pendingQuestions: 1, pendingApprovals: 1, runningTools: 1, path: '/secret/session' }],
  );
  assert.deepEqual(snapshot, { productConnections: 2, attachmentRefs: 3, attachedPaths: 2, runningSessions: 1, liveRuns: 1,
    runningTasks: 2, attentionDialogs: 1, pendingQuestions: 1, pendingApprovals: 1, runningTools: 1 });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|project|session/);
  assert.throws(() => assertNoLiveWork(snapshot), /not settled/);
  assert.doesNotThrow(() => assertNoLiveWork(retirementGuardSnapshot()));
});
