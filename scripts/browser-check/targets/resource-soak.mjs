import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWebSocket } from '../../../packages/host/node_modules/ws/wrapper.mjs';
import { artifactTreeSha256 } from '../../review-env/artifacts.mjs';
import { settledWebSocketRpc } from '../resource/websocket.mjs';

export const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const provider = fileURLToPath(new URL('../resource/provider.mjs', import.meta.url));
const host = fileURLToPath(new URL('../resource/host.mjs', import.meta.url));
const preload = fileURLToPath(new URL('../resource/inspect-preload.cjs', import.meta.url));

export function resourceTarget(mode = 'quick') {
  return async runtime => {
    for (const path of ['packages/host/dist/index.js', 'packages/worker/dist/main.js', 'packages/ui/dist/index.html']) {
      if (!existsSync(join(checkout, path))) throw new Error('The resource soak target is not built; run pnpm -r build.');
    }
    const { ENV } = await import('../../../packages/protocol/dist/index.js');
    const { PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV } = await import('../../../packages/cli/dist/config.js');
    const agentDir = join(runtime.root, 'agent');
    const sessionDir = join(runtime.root, 'sessions');
    const stateDir = join(runtime.root, 'state');
    const inspectDir = join(runtime.root, 'inspect');
    for (const path of [agentDir, sessionDir, stateDir, inspectDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const baseEnv = { ...runtime.env, [ENV.agentDir]: agentDir, [ENV.sessionDir]: sessionDir, [ENV.stateDir]: stateDir,
      [ENV.node]: runtime.node, [PI_AGENT_DIR_ENV]: agentDir, [PI_SESSION_DIR_ENV]: sessionDir, PI_MCP_ADAPTER_TEST_AUTH_STORE: 'memory' };
    runtime.spawn(runtime.node, [provider, runtime.root, mode], { name: 'resource-provider', env: baseEnv });
    await runtime.until(() => existsSync(join(runtime.root, 'provider.json')), 'resource provider', runtime.timeout);
    const inspectEnv = { ...baseEnv, NODE_OPTIONS: `--require=${preload}`, RESOURCE_SOAK_INSPECT_DIR: inspectDir };
    runtime.spawn(runtime.node, [host, runtime.root, mode], { name: 'resource-host', env: inspectEnv });
    await runtime.until(() => existsSync(join(runtime.root, 'host.json')), 'resource host', runtime.timeout);
    const hostRecord = JSON.parse(readFileSync(join(runtime.root, 'host.json'), 'utf8'));
    await runtime.until(async () => (await fetch(`${hostRecord.url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok, 'resource host health', runtime.timeout);
    const version = JSON.parse(readFileSync(join(checkout, 'packages/cli/package.json'), 'utf8')).version;
    const rpc = (method, params = {}) => settledWebSocketRpc({
      WebSocketCtor: NodeWebSocket,
      url: `${hostRecord.url.replace('http:', 'ws:')}/ws`,
      request: { jsonrpc: '2.0', id: 1, method, params, clientVersion: version },
      timeoutMs: runtime.timeout,
    });
    return {
      url: hostRecord.url, rpc,
      build: Object.fromEntries(['host', 'worker', 'ui'].map(name => [name, artifactTreeSha256(join(checkout, `packages/${name}/dist`))])),
      resource: { hostRecord, inspectDir, agentDir, sessionDir, stateDir, mode },
      async preparePage(check) {
        await check.context.addInitScript(() => {
          const state = { store: null, stable: null, matches: 0, error: null, aliases: Object.create(null) };
          Object.defineProperty(window, '__resourceSoak', { value: state, configurable: true });
          const candidate = value => {
            try {
              if (!value || typeof value !== 'object') return false;
              const descriptors = Object.getOwnPropertyDescriptors(value);
              return typeof descriptors.getSnapshot?.value === 'function' && typeof descriptors.subscribe?.value === 'function'
                && typeof descriptors.dispatch?.value === 'function' && descriptors.presentation?.value;
            } catch { return false; }
          };
          // Walk only until both objects are in hand. This runs on every React
          // commit in a page the run is about to measure, so it must not keep
          // traversing a fifty-session fiber tree once it has what it needs.
          const record = root => {
            const stack = [root.current]; const found = new Set();
            while (stack.length) {
              if (found.size === 1 && state.stable) break;
              const fiber = stack.pop(); if (!fiber) continue;
              let value;
              try { value = fiber.memoizedProps?.value; } catch {}
              if (candidate(value)) found.add(value);
              let nested;
              try { nested = Object.getOwnPropertyDescriptor(value ?? {}, 'store')?.value; } catch {}
              if (candidate(nested)) {
                found.add(nested);
                const open = Object.getOwnPropertyDescriptor(value, 'openSession')?.value;
                if (typeof open === 'function') state.stable = value;
              }
              if (fiber.child) stack.push(fiber.child);
              for (let sibling = fiber.child?.sibling; sibling; sibling = sibling.sibling) stack.push(sibling);
            }
            if (found.size >= 1) state.matches = found.size;
            if (found.size === 1) state.store = [...found][0];
          };
          const hook = { renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
            inject(renderer) { const id = hook.renderers.size + 1; hook.renderers.set(id, renderer); return id; },
            onScheduleFiberRoot() {}, onCommitFiberRoot(_id, root) { try { record(root); } catch (error) { state.error = String(error); } },
            onPostCommitFiberRoot() {}, onCommitFiberUnmount() {}, on() {}, off() {}, sub() { return () => {}; }, emit() {},
            getFiberRoots() { return new Set(); }, registerInternalModuleStart() {}, registerInternalModuleStop() {} };
          Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true, writable: true });
        });
      },
      async ready(check) { await check.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: runtime.timeout }); },
    };
  };
}

export async function fixture(target, runtime) {
  const config = (await import('../resource/config.mjs')).modeConfig(target.resource.mode);
  const projects = Array.from({ length: config.projects }, (_, index) => join(runtime.root, `project-${index + 1}`));
  await target.rpc('pi/setup/complete', { completed: true });
  for (const project of projects) {
    mkdirSync(project, { recursive: true, mode: 0o700 });
    await target.rpc('pi/project/add', { cwd: project });
    await target.rpc('pi/project/trust', { cwd: project, trusted: true, remember: true });
  }
  return { ...target.resource, projects, config };
}
