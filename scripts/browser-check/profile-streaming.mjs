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
 * The same page counts `session/update` notifications straight off the socket,
 * so "renders per delta" is normalised by protocol deltas, not by guesswork.
 * Long tasks come from the harness's own long-task observer. The fiber walk
 * itself costs time inside each commit, so treat the long-task table from a
 * profiling run as an upper bound and re-read it from `--no-profile` runs.
 *
 * Environment: `PROFILE_DELTAS` (500), `PROFILE_DELAY_MS` (4), `PROFILE_RUNS`
 * (3), `PROFILE_FULL_WALK` (1 = do not prune untouched subtrees; slower, used
 * to verify the pruning), `PROFILE_ASSERT` (0 = report only, never fail).
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
    deltas: 0,
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
  // A fiber that ran its function body has a fresh hook list; a bailed-out one
  // shares `memoizedState` (and, without a re-rendered parent, `memoizedProps`)
  // with its alternate. Host fibers have no hooks, so they are compared by props.
  const rendered = fiber => {
    const previous = fiber.alternate;
    if (!previous) return true;
    if (fiber.memoizedState !== previous.memoizedState) return true;
    return fiber.memoizedState === null && previous.memoizedState === null && fiber.memoizedProps !== previous.memoizedProps;
  };

  const record = root => {
    if (!profile.enabled) return;
    profile.commits++;
    profile.commitTimes.push(performance.now());
    const stack = [root.current];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber) continue;
      profile.walked++;
      const previous = fiber.alternate;
      const ran = rendered(fiber);
      if (ran) {
        const element = elementOf(fiber);
        bump(profile.renders, nameOf(fiber));
        bump(profile.surfaces, surfaceOf(fiber, element));
        const row = element?.closest?.('[data-window-message]');
        if (row) bump(profile.rows, row.getAttribute('data-window-message'));
      }
      // An untouched subtree is shared with the previous tree: React reuses the
      // child fibers instead of cloning them. Nothing below can have rendered.
      if (!profile.fullWalk && !ran && previous && fiber.child === previous.child) continue;
      if (fiber.child) stack.push(fiber.child);
      for (let sibling = fiber.child?.sibling; sibling; sibling = sibling.sibling) stack.push(sibling);
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

  const tick = () => { if (profile.enabled) profile.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sumOf = bag => Object.values(bag).reduce((total, value) => total + value, 0);

export default async function profileStreaming(check) {
  const deltas = number('PROFILE_DELTAS', 500);
  const delayMs = number('PROFILE_DELAY_MS', 4);
  const runs = number('PROFILE_RUNS', 3);
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
      Object.assign(profile, { commits: 0, walked: 0, frames: 0, deltas: 0, renders: {}, rows: {}, surfaces: {}, notifications: {}, commitTimes: [], fullWalk: full, startedAt: performance.now(), enabled: true });
      window.__renderCounts = profile.renders;
      return { longTasks: window.__browserCheckLongTasks.length, at: performance.now() };
    }, fullWalk);

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
      const lastRow = [...document.querySelectorAll('[data-window-message]')].at(-1)?.getAttribute('data-window-message') ?? null;
      return {
        deltas: profile.deltas,
        commits: profile.commits,
        walked: profile.walked,
        frames: profile.frames,
        durationMs: performance.now() - profile.startedAt,
        renders: profile.renders,
        rows: profile.rows,
        surfaces: profile.surfaces,
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
  const componentKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.renders)))];
  const summary = {
    case: { ...check.state },
    fixture: check.fixture?.name,
    plan: { deltas, delayMs, runs, fullWalk },
    medians: {
      deltas: pick('deltas'), commits: pick('commits'), frames: pick('frames'), durationMs: Math.round(pick('durationMs')),
      commitsPerDelta: pick('commitsPerDelta'), rendersPerDelta: pick('rendersPerDelta'),
      activeRowRenders: pick('activeRowRenders'), settledRowRenders: pick('settledRowRenders'),
      longTasksOver50: pick('longTasksOver50'), longestTaskMs: Math.round(pick('longestTaskMs')),
      mountedRows: pick('mountedRows'), domNodes: pick('domNodes'),
      surfaces: Object.fromEntries(surfaceKeys.map(key => [key, median(samples.map(sample => sample.surfaces[key] ?? 0))])),
      components: Object.fromEntries(componentKeys.map(key => [key, median(samples.map(sample => sample.renders[key] ?? 0))]).sort((a, b) => b[1] - a[1])),
    },
    samples,
  };
  const file = join(check.root, `streaming-profile-${check.state.width}-${check.state.theme}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`Streaming profile: ${file}`);
  console.log(`medians — renders/delta ${summary.medians.rendersPerDelta}, commits/delta ${summary.medians.commitsPerDelta}, settled rows ${summary.medians.settledRowRenders}, long tasks>50ms ${summary.medians.longTasksOver50}`);
  for (const [name, count] of Object.entries(summary.medians.surfaces)) console.log(`  surface ${name}: ${count}`);

  if (process.env.PROFILE_ASSERT !== '0') {
    const problems = [];
    if (summary.medians.settledRowRenders > 0) problems.push(`settled message rows re-rendered ${summary.medians.settledRowRenders} times`);
    for (const surface of ['SessionsPanel', 'FleetPanel', 'TelemetryPanel', 'Workbench', 'Rail']) {
      if ((summary.medians.surfaces[surface] ?? 0) > 0) problems.push(`${surface} re-rendered ${summary.medians.surfaces[surface]} times`);
    }
    if (summary.medians.longTasksOver50 > 0) problems.push(`${summary.medians.longTasksOver50} long tasks over 50 ms`);
    if (problems.length) throw new Error(`Streaming profile regressed: ${problems.join('; ')}. See ${file}.`);
  }
  await check.shot('streaming-profile');
}
