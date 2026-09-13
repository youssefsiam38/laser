/**
 * Per-delta React commit profile for a streaming reply.
 *
 * Run it as a browser-check script against the streaming target:
 *
 *   node scripts/browser-check/run.mjs \
 *     --target scripts/browser-check/targets/streaming.mjs --fixture long \
 *     --script scripts/browser-check/profile-streaming.mjs
 *
 * What it measures. A React DevTools hook shim is installed before the app
 * loads (no application code, build flag or profiling build is required). On
 * every commit it walks the fiber tree and counts the fibers that actually
 * re-rendered: a bailed-out fiber shares its hook list and props with its
 * alternate, a rendered one does not. Each counted fiber is attributed to the
 * message row (`data-window-message`) or the surface component that owns it,
 * so the report says which rows and which columns paid for a token.
 *
 * Every re-rendered fiber whose parent did not re-render is counted as a render
 * root (`roots`, `surface/component`): its own subscription woke it, rather than
 * a parent re-render dragging it along. That is the list of things to fix.
 *
 * For each root the profile also says WHICH of its hooks changed value, and
 * whether the new value is structurally equal to the old one (`reasons`,
 * `surface/component#hookIndex`). A hook that hands back a structurally equal
 * but freshly allocated value is a selector allocating per publication: the
 * component re-renders for a value that did not change.
 *
 * The same page counts `session/update` notifications straight off the socket,
 * so "renders per delta" is normalised by protocol deltas, not by guesswork.
 * Long tasks come from the harness's own long-task observer. The fiber walk
 * itself costs time inside each commit, so treat the long-task table from a
 * profiling run as an upper bound and re-read it from `--no-profile` runs.
 *
 * A second phase switches between a long and a short session `PROFILE_SWITCHES`
 * times and reads the renderer's own heap and node counts after a forced
 * collection, so a transcript that keeps its rows, listeners or observers alive
 * shows up as growth rather than as a feeling.
 *
 * Environment: `PROFILE_DELTAS` (500), `PROFILE_DELAY_MS` (4), `PROFILE_RUNS`
 * (3), `PROFILE_SWITCHES` (10; 0 skips the memory phase), `PROFILE_FULL_WALK`
 * (1 = do not prune untouched subtrees; slower, used to verify the pruning),
 * `PROFILE_ASSERT` (0 = report only, never fail).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const number = (name, fallback) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
};

/** Installed before any application script; see the file header. */
function instrument() {
  const profile = {
    enabled: false,
    fullWalk: false,
    commits: 0,
    walked: 0,
    frames: 0,
    renders: {},
    rows: {},
    surfaces: {},
    surfaceComponents: {},
    settledRenders: {},
    settledMounts: {},
    roots: {},
    reasons: {},
    deltas: 0,
    trace: false,
    traceName: '',
    traceLog: [],
    activeRow: null,
    mountedRowsDuring: 0,
    notifications: {},
    commitTimes: [],
    startedAt: 0,
  };
  window.__profile = profile;
  window.__renderCounts = profile.renders;

  const SURFACES = new Set(['Thread', 'ThreadContent', 'WindowRow', 'WindowedMessages', 'Composer', 'SessionsPanel', 'FleetPanel',
    'TelemetryPanel', 'Workbench', 'Rail', 'TopBar', 'GoalBar', 'StatusLine', 'ConversationMapAui', 'AgentMapView', 'Shell', 'App']);
  // Landmarks the app already owns, so a minified build is attributed as well
  // as an unminified one. Order matters: the innermost surface wins.
  const LANDMARKS = [
    ['[data-window-message]', 'MessageRow'],
    ['[data-slot="thread-footer"]', 'Composer'],
    ['[data-slot="thread-viewport"]', 'Thread'],
    ['aside[aria-label="Fleet"]', 'FleetPanel'],
    ['aside[aria-label="Telemetry"]', 'TelemetryPanel'],
    ['[aria-label="Sessions"]', 'SessionsPanel'],
    ['nav[aria-label="Projects"]', 'Rail'],
    ['[aria-label="Settings"], [aria-label="Logs"], [aria-label="Files"]', 'Workbench'],
  ];
  const bump = (bag, key) => { bag[key] = (bag[key] ?? 0) + 1; };
  const identities = new WeakMap();
  let nextIdentity = 0;
  const identityOf = value => {
    if (!value || typeof value !== 'object') return String(value);
    if (!identities.has(value)) identities.set(value, `#${++nextIdentity}`);
    return identities.get(value);
  };

  const shallowEqual = (a, b) => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(key => Object.is(a[key], b[key]));
  };
  const shapeOf = (value, depth = 0) => {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) return `array(${value.length})${value.length && depth < 1 ? ` of ${shapeOf(value[0], depth + 1)}` : ''}`;
    if (typeof value !== 'object') return typeof value;
    const keys = Object.keys(value).slice(0, 6);
    return `{${keys.join(',')}}`;
  };
  /** How much of an array really changed: a rebuild differs everywhere, an append at one end. */
  const arrayDiff = (value, before) => {
    if (!Array.isArray(value) || !Array.isArray(before)) return '';
    let same = 0;
    for (let index = 0; index < Math.min(value.length, before.length); index++) if (Object.is(value[index], before[index])) same++;
    return ` [${Math.min(value.length, before.length) - same} of ${before.length} entries replaced]`;
  };
  /**
   * Which hook of this component handed back a different value, and whether the
   * difference is real. `useSyncExternalStore` and `useState` both keep their
   * value in `hook.memoizedState`; a selector that allocates shows up as a
   * changed hook whose old and new values are shallow-equal.
   */
  const reasonsFor = (fiber, label, hooksBefore) => {
    if (typeof fiber.type !== 'function' && typeof fiber.type?.render !== 'function') return;
    if (!hooksBefore) return;
    // An effect hook's state is rebuilt by every render, so it says nothing
    // about what woke this one. The first changed value hook does.
    const isEffect = value => Boolean(value) && typeof value === 'object' && 'create' in value && 'deps' in value && 'tag' in value;
    let hook = fiber.memoizedState, old = hooksBefore, index = 0;
    while (hook && old && index < 60) {
      const value = hook.memoizedState, before = old.memoizedState;
      if (!isEffect(value) && !Object.is(value, before)) {
        const equal = shallowEqual(value, before) ? ' (equal value, new identity)' : arrayDiff(value, before);
        bump(profile.reasons, `${label}#${index}${equal} ${shapeOf(value)}`);
        // `PROFILE_TRACE=<component>` follows one component's changed value
        // commit by commit, with a stable id per object identity: an
        // alternating pair of ids is two publishers fighting over one value.
        if (profile.trace && label.endsWith(`/${profile.traceName}`) && profile.traceLog.length < 300) {
          profile.traceLog.push(`commit ${profile.commits} ${label}#${index} ${identityOf(before)}(${before?.length ?? '-'}) -> ${identityOf(value)}(${value?.length ?? '-'})`);
        }
        return;
      }
      hook = hook.next; old = old.next; index++;
    }
    bump(profile.reasons, `${label}#props-or-context`);
  };

  const nameOf = fiber => {
    const type = fiber.type ?? fiber.elementType;
    if (typeof type === 'string') return `host:${type}`;
    if (typeof type === 'function') return type.displayName || type.name || 'anonymous';
    if (type && typeof type === 'object') return type.displayName || type.render?.name || type.type?.name || 'memo';
    return `tag:${fiber.tag}`;
  };
  const elementOf = fiber => {
    for (let node = fiber; node; node = node.return) if (node.stateNode instanceof Element) return node.stateNode;
    return null;
  };
  const surfaceOf = (fiber, element) => {
    for (const [selector, name] of LANDMARKS) if (element?.closest?.(selector)) return name;
    for (let node = fiber; node; node = node.return) {
      const name = nameOf(node);
      if (SURFACES.has(name)) return name;
    }
    return 'unattributed';
  };
  /**
   * Did this component instance run its body since the previous commit?
   *
   * `fiber.alternate` cannot answer that. React double-buffers two fiber
   * objects per instance and reuses a bailed-out subtree as it stands, so a
   * component that rendered once keeps an alternate holding the older hook
   * list for every later commit — which reads as "rendered again" forever.
   * The baseline has to be what THIS instance last committed, so the record is
   * kept per instance (both fibers of the pair share it): a fresh hook list
   * means the body ran, and a hook-less fiber (a host element) is judged by
   * its props object instead.
   */
  const instances = new WeakMap();
  const rendered = fiber => {
    let record = instances.get(fiber) ?? (fiber.alternate ? instances.get(fiber.alternate) : undefined);
    if (!record) {
      record = { seen: false, state: undefined, props: undefined, child: undefined };
      instances.set(fiber, record);
      if (fiber.alternate) instances.set(fiber.alternate, record);
    } else if (fiber.alternate && !instances.has(fiber.alternate)) instances.set(fiber.alternate, record);
    const mounted = !record.seen;
    const ran = mounted || fiber.memoizedState !== record.state
      || (fiber.memoizedState === null && fiber.memoizedProps !== record.props);
    // A subtree nothing rendered in keeps its child fibers; React clones the
    // path down to a deep update, so a changed child pointer means work below.
    const sameChildren = record.seen && record.child === fiber.child;
    record.seen = true; record.state = fiber.memoizedState; record.props = fiber.memoizedProps; record.child = fiber.child;
    return { ran, sameChildren, mounted };
  };


  const record = root => {
    if (!profile.enabled) return;
    profile.commits++;
    profile.commitTimes.push(performance.now());
    const stack = [[root.current, 0, false]];
    while (stack.length) {
      const [fiber, depth, parentRan] = stack.pop();
      if (!fiber) continue;
      profile.walked++;
      const hooksBefore = (instances.get(fiber) ?? (fiber.alternate ? instances.get(fiber.alternate) : undefined))?.state;
      const { ran, sameChildren, mounted } = rendered(fiber);
      if (ran) {
        const element = elementOf(fiber);
        const name = nameOf(fiber);
        const surface = surfaceOf(fiber, element);
        bump(profile.renders, name);
        bump(profile.surfaces, surface);
        bump(profile.surfaceComponents, `${surface}/${name}`);
        const row = element?.closest?.('[data-window-message]');
        if (row) {
          const id = row.getAttribute('data-window-message');
          bump(profile.rows, id);
          // A settled row is every row but the one the reply is streaming into.
          // Mounts are separated from re-renders: a row entering the window is
          // the window doing its work, a re-render is a subscription firing.
          if (id !== profile.activeRow) bump(mounted ? profile.settledMounts : profile.settledRenders, name);
        }
        // A render root: it re-rendered and its parent did not, so its own
        // subscription (not a parent's re-render) woke it. One commit can have
        // several, one per independent subscription that fired.
        if (!parentRan) {
          const label = `${surface}/${name}`;
          bump(profile.roots, label);
          reasonsFor(fiber, label, hooksBefore);
        }
      }
      // An untouched subtree is shared with the previous tree: React reuses the
      // child fibers instead of cloning them. Nothing below can have rendered.
      if (!profile.fullWalk && !ran && sameChildren) continue;
      if (fiber.child) stack.push([fiber.child, depth + 1, ran]);
      for (let sibling = fiber.child?.sibling; sibling; sibling = sibling.sibling) stack.push([sibling, depth + 1, ran]);
    }
  };

  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    checkDCE() {},
    inject(renderer) { const id = hook.renderers.size + 1; hook.renderers.set(id, renderer); return id; },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) { try { record(root); } catch (error) { profile.error = String(error); } },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    on() {}, off() {}, sub() { return () => {}; }, emit() {},
    getFiberRoots() { return new Set(); },
    registerInternalModuleStart() {}, registerInternalModuleStop() {},
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true, writable: true });

  // Protocol deltas, straight off the socket: one `session/update` per token.
  const Native = window.WebSocket;
  class CountingWebSocket extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (!profile.enabled || typeof event.data !== 'string') return;
        const method = /"method"\s*:\s*"([^"]+)"/.exec(event.data)?.[1];
        if (!method) return;
        bump(profile.notifications, method);
        if (method === 'session/update') profile.deltas++;
      });
    }
  }
  window.WebSocket = CountingWebSocket;

  const tick = () => {
    if (profile.enabled) {
      profile.frames++;
      // Sampled while the reply streams: what is mounted then, and which row is
      // the live one — the tail row is alone on screen by the end of a long reply.
      const rows = document.querySelectorAll('[data-window-message]');
      if (rows.length > profile.mountedRowsDuring) profile.mountedRowsDuring = rows.length;
      const live = document.querySelector('[data-streaming]') ?? rows[rows.length - 1];
      const id = live?.closest?.('[data-window-message]')?.getAttribute('data-window-message');
      if (id) profile.activeRow = id;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sumOf = bag => Object.values(bag).reduce((total, value) => total + value, 0);

/**
 * Renderer memory as the browser itself accounts for it: a forced collection,
 * then Chrome's own metrics. `Nodes` counts every node the renderer still
 * holds, detached ones included, so a transcript that leaks rows grows it.
 */
async function memoryProbe(check) {
  const cdp = await check.context.newCDPSession(check.page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  return {
    async read(label) {
      await cdp.send('HeapProfiler.collectGarbage');
      await check.page.waitForTimeout(250);
      const { metrics } = await cdp.send('Performance.getMetrics');
      const value = name => metrics.find(metric => metric.name === name)?.value ?? 0;
      const live = await check.page.evaluate(() => ({
        elements: document.querySelectorAll('*').length,
        rows: document.querySelectorAll('[data-window-message]').length,
      }));
      return {
        label,
        heapMB: Number((value('JSHeapUsedSize') / 1048576).toFixed(2)),
        nodes: value('Nodes'),
        listeners: value('JSEventListeners'),
        documents: value('Documents'),
        ...live,
      };
    },
    async close() { await cdp.detach().catch(() => {}); },
  };
}

/** Click a session row in the sidebar and wait until it is the shown session. */
async function switchTo(check, title, timeout) {
  const row = check.page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: title }).first();
  await row.locator('[data-slot="aui_thread-list-item-trigger"]').first().click({ timeout });
  await check.page.locator('[data-slot="aui_thread-list-item"][data-active]').filter({ hasText: title }).first().waitFor({ timeout });
  await check.page.waitForFunction(() => document.querySelectorAll('[data-window-message]').length > 0, undefined, { timeout });
  await check.page.waitForTimeout(300);
}

/**
 * Long/short session switches with the renderer's heap and node count read
 * after each pair. The short session is created through the app's own RPC, so
 * it is an ordinary conversation in the same project, not a synthetic view.
 */
async function profileSwitches(check, pairs) {
  const project = check.fixture?.projects?.[0] ?? check.fixture?.project;
  const longTitle = `${check.fixture?.name} conversation 1`;
  const shortTitle = 'switch short conversation';
  const { state } = await check.rpc('session/new', { cwd: project });
  await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
  await check.rpc('session/prompt', { path: state.path, content: [{ type: 'text', text: 'Review checkpoint 1: verify the implementation and explain the next step.' }] });
  for (;;) { const loaded = await check.rpc('session/load', { path: state.path }); if (!loaded.state.isStreaming) break; await check.page.waitForTimeout(100); }
  await check.rpc('pi/session/rename', { path: state.path, name: shortTitle });
  await check.page.waitForTimeout(1000);

  const probe = await memoryProbe(check);
  const timeout = 30000;
  await switchTo(check, longTitle, timeout);
  const samples = [await probe.read('baseline (long, before switching)')];
  for (let pair = 0; pair < pairs; pair++) {
    await switchTo(check, shortTitle, timeout);
    await switchTo(check, longTitle, timeout);
    if (pair === 0 || pair === pairs - 1 || (pair + 1) % 5 === 0) samples.push(await probe.read(`after ${pair + 1} long/short pairs`));
  }
  await probe.close();
  const first = samples[0], last = samples.at(-1);
  console.log(`memory: heap ${first.heapMB} -> ${last.heapMB} MB, nodes ${first.nodes} -> ${last.nodes}, listeners ${first.listeners} -> ${last.listeners}`);
  return { pairs, shortPath: state.path, samples, growth: { heapMB: Number((last.heapMB - first.heapMB).toFixed(2)), nodes: last.nodes - first.nodes, listeners: last.listeners - first.listeners } };
}

export default async function profileStreaming(check) {
  const deltas = number('PROFILE_DELTAS', 500);
  const delayMs = number('PROFILE_DELAY_MS', 4);
  const runs = number('PROFILE_RUNS', 3);
  const switches = number('PROFILE_SWITCHES', 10);
  const fullWalk = process.env.PROFILE_FULL_WALK === '1';
  const path = check.fixture?.path;
  if (!path) throw new Error('This profile needs a seeded session; run with --fixture long (or huge).');

  await check.context.addInitScript(instrument);
  await check.open('/');
  await check.waitFor({ selector: '[data-window-message]' });
  // The transcript settles its window, measurement and fonts before a delta arrives.
  await check.page.waitForTimeout(1500);

  const samples = [];
  for (let run = 0; run < runs; run++) {
    const before = await check.page.evaluate(full => {
      const profile = window.__profile;
      Object.assign(profile, { commits: 0, walked: 0, frames: 0, deltas: 0, renders: {}, rows: {}, surfaces: {}, surfaceComponents: {}, settledRenders: {}, settledMounts: {}, roots: {}, reasons: {}, notifications: {}, commitTimes: [], activeRow: null, mountedRowsDuring: 0, fullWalk: full.fullWalk, trace: Boolean(full.trace), traceName: full.trace ?? '', traceLog: [], startedAt: performance.now(), enabled: true });
      window.__renderCounts = profile.renders;
      return { longTasks: window.__browserCheckLongTasks.length, at: performance.now() };
    }, { fullWalk, trace: process.env.PROFILE_TRACE ?? null });

    const started = Date.now();
    const accepted = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: `Stream ${deltas} deltas every ${delayMs} ms` }] });
    if (!accepted.accepted) throw new Error('The host refused the profiling prompt.');
    for (;;) {
      const { state } = await check.rpc('session/load', { path });
      if (!state.isStreaming) break;
      if (Date.now() - started > 240000) throw new Error('The profiling stream did not finish within four minutes.');
      await check.page.waitForTimeout(200);
    }
    await check.page.waitForTimeout(500);

    const sample = await check.page.evaluate(start => {
      const profile = window.__profile;
      profile.enabled = false;
      const tasks = window.__browserCheckLongTasks.slice(start.longTasks);
      const gaps = profile.commitTimes.slice(1).map((time, index) => time - profile.commitTimes[index]);
      const lastRow = profile.activeRow ?? [...document.querySelectorAll('[data-window-message]')].at(-1)?.getAttribute('data-window-message') ?? null;
      return {
        deltas: profile.deltas,
        roots: profile.roots,
        reasons: profile.reasons,
        ...(profile.trace ? { traceLog: profile.traceLog } : {}),
        mountedRowsDuring: profile.mountedRowsDuring,
        commits: profile.commits,
        walked: profile.walked,
        frames: profile.frames,
        durationMs: performance.now() - profile.startedAt,
        renders: profile.renders,
        rows: profile.rows,
        surfaces: profile.surfaces,
        surfaceComponents: profile.surfaceComponents,
        settledRenders: profile.settledRenders,
        settledMounts: profile.settledMounts,
        notifications: profile.notifications,
        activeRow: lastRow,
        longTasks: tasks.map(task => Math.round(task.duration)),
        longTasksOver50: tasks.filter(task => task.duration > 50).length,
        longestTaskMs: tasks.reduce((worst, task) => Math.max(worst, task.duration), 0),
        medianCommitGapMs: gaps.length ? gaps.sort((a, b) => a - b)[gaps.length >> 1] : null,
        domNodes: document.querySelectorAll('*').length,
        mountedRows: document.querySelectorAll('[data-window-message]').length,
        error: profile.error ?? null,
      };
    }, before);

    const activeRenders = sample.activeRow ? sample.rows[sample.activeRow] ?? 0 : 0;
    const settledRenders = sumOf(sample.rows) - activeRenders;
    samples.push({ ...sample, activeRowRenders: activeRenders, settledRowRenders: settledRenders,
      rendersPerDelta: sample.deltas ? Number((sumOf(sample.renders) / sample.deltas).toFixed(2)) : null,
      commitsPerDelta: sample.deltas ? Number((sample.commits / sample.deltas).toFixed(3)) : null });
    console.log(`run ${run + 1}: ${sample.deltas} deltas, ${sample.commits} commits, ${sumOf(sample.renders)} component renders, active row ${activeRenders}, settled rows ${settledRenders}, long tasks>50ms ${sample.longTasksOver50}`);
  }

  const pick = key => median(samples.map(sample => sample[key] ?? 0));
  const surfaceKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.surfaces)))];
  const rootKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.roots)))];
  const reasonKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.reasons ?? {})))];
  const componentKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.renders)))];
  const surfaceComponentKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.surfaceComponents ?? {})))];
  const summary = {
    case: { ...check.state },
    fixture: check.fixture?.name,
    plan: { deltas, delayMs, runs, fullWalk },
    medians: {
      deltas: pick('deltas'), commits: pick('commits'), frames: pick('frames'), durationMs: Math.round(pick('durationMs')),
      commitsPerDelta: pick('commitsPerDelta'), rendersPerDelta: pick('rendersPerDelta'),
      activeRowRenders: pick('activeRowRenders'), settledRowRenders: pick('settledRowRenders'),
      longTasksOver50: pick('longTasksOver50'), longestTaskMs: Math.round(pick('longestTaskMs')),
      mountedRows: pick('mountedRows'), mountedRowsDuring: pick('mountedRowsDuring'), domNodes: pick('domNodes'),
      roots: Object.fromEntries(rootKeys.map(key => [key, median(samples.map(sample => sample.roots[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
      reasons: Object.fromEntries(reasonKeys.map(key => [key, median(samples.map(sample => sample.reasons?.[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
      surfaces: Object.fromEntries(surfaceKeys.map(key => [key, median(samples.map(sample => sample.surfaces[key] ?? 0))])),
      surfaceComponents: Object.fromEntries(surfaceComponentKeys.map(key => [key, median(samples.map(sample => sample.surfaceComponents?.[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
      settledRenders: Object.fromEntries([...new Set(samples.flatMap(sample => Object.keys(sample.settledRenders ?? {})))]
        .map(key => [key, median(samples.map(sample => sample.settledRenders?.[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
      settledMounts: Object.fromEntries([...new Set(samples.flatMap(sample => Object.keys(sample.settledMounts ?? {})))]
        .map(key => [key, median(samples.map(sample => sample.settledMounts?.[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
      components: Object.fromEntries(componentKeys.map(key => [key, median(samples.map(sample => sample.renders[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
    },
    samples,
  };
  if (switches > 0) summary.memory = await profileSwitches(check, switches);
  const file = join(check.root, `streaming-profile-${check.state.width}-${check.state.theme}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`Streaming profile: ${file}`);
  console.log(`medians — renders/delta ${summary.medians.rendersPerDelta}, commits/delta ${summary.medians.commitsPerDelta}, settled rows ${summary.medians.settledRowRenders}, long tasks>50ms ${summary.medians.longTasksOver50}`);
  for (const [name, count] of Object.entries(summary.medians.surfaces)) console.log(`  surface ${name}: ${count}`);
  for (const [name, count] of Object.entries(summary.medians.roots)) if (count > 0) console.log(`  render root ${name}: ${count}`);
  for (const [name, count] of Object.entries(summary.medians.reasons)) if (count > 0) console.log(`  woke by ${name}: ${count}`);

  if (process.env.PROFILE_ASSERT !== '0') {
    const problems = [];
    if (summary.medians.settledRowRenders > 0) problems.push(`settled message rows re-rendered ${summary.medians.settledRowRenders} times`);
    for (const surface of ['SessionsPanel', 'FleetPanel', 'TelemetryPanel', 'Workbench', 'Rail']) {
      if ((summary.medians.surfaces[surface] ?? 0) > 0) problems.push(`${surface} re-rendered ${summary.medians.surfaces[surface]} times`);
    }
    if (summary.medians.longTasksOver50 > 0) problems.push(`${summary.medians.longTasksOver50} long tasks over 50 ms`);
    // A switch loop that ends where it started returns its rows and its heap.
    if (summary.memory && summary.memory.growth.nodes > 2000) problems.push(`the switch loop retained ${summary.memory.growth.nodes} DOM nodes`);
    if (problems.length) throw new Error(`Streaming profile regressed: ${problems.join('; ')}. See ${file}.`);
  }
  await check.shot('streaming-profile');
}
