import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactTreeSha256 } from '../../review-env/artifacts.mjs';

export const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const self = fileURLToPath(import.meta.url);

export async function target(runtime) {
  for (const path of ['packages/cli/dist/main.js', 'packages/host/dist/index.js', 'packages/worker/dist/main.js', 'packages/ui/dist/index.html']) {
    if (!existsSync(join(checkout, path))) throw new Error('The app is not built; run pnpm -r build from the target checkout.');
  }
  const { ENV, storageKey, dottedStorageKey } = await import('../../../packages/protocol/dist/index.js');
  const { PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV } = await import('../../../packages/cli/dist/config.js');
  const agentDir = join(runtime.root, 'agent'), sessionDir = join(runtime.root, 'sessions'), stateDir = join(runtime.root, 'state');
  for (const path of [agentDir, sessionDir, stateDir]) mkdirSync(path, { recursive: true });
  const env = { ...runtime.env, [ENV.agentDir]: agentDir, [ENV.sessionDir]: sessionDir, [ENV.stateDir]: stateDir, [ENV.node]: runtime.node, [PI_AGENT_DIR_ENV]: agentDir, [PI_SESSION_DIR_ENV]: sessionDir, PI_MCP_ADAPTER_TEST_AUTH_STORE: 'memory' };
  runtime.spawn(runtime.node, [self, '--provider', runtime.root], { name: 'provider', env });
  await runtime.until(() => existsSync(join(runtime.root, 'provider.json')), 'stub provider (see logs/provider.log)', runtime.timeout);
  const port = await runtime.freePort();
  runtime.spawn(runtime.node, [join(checkout, 'packages/cli/dist/main.js'), 'up', '--foreground', '--no-open', '--port', String(port), '--agent-dir', agentDir, '--session-dir', sessionDir, '--state-dir', stateDir], { name: 'host', env });
  const url = `http://127.0.0.1:${port}`;
  await runtime.until(async () => (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok, 'built host (see logs/host.log)', runtime.timeout);
  const version = JSON.parse(readFileSync(join(checkout, 'packages/cli/package.json'), 'utf8')).version;
  // One short-lived socket per call: timeout/error always closes it, and fixture
  // setup never leaves an unowned transport keeping the harness alive.
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/ws`);
    const finish = (error, value) => { clearTimeout(timer); ws.close(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error(`RPC ${method} timed out after ${runtime.timeout}ms`)), runtime.timeout);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, clientVersion: version }));
    ws.onmessage = event => { const message = JSON.parse(event.data); if (message.id === 1) finish(message.error ? new Error(`${method}: ${message.error.message}`) : null, message.result); };
    ws.onerror = () => finish(new Error(`RPC ${method}: host connection failed`));
  });
  return {
    url, rpc, env, agentDir, sessionDir,
    build: Object.fromEntries(['host', 'worker', 'ui'].map(name => [name, artifactTreeSha256(join(checkout, `packages/${name}/dist`))])),
    async preparePage(check, fixture) {
      if (!fixture?.project) return;
      await check.context.addInitScript(({ fixture, projectKey, sessionKey }) => {
        localStorage.setItem(projectKey, fixture.project);
        if (fixture.path) localStorage.setItem(sessionKey, JSON.stringify({ [fixture.project]: fixture.path }));
      }, { fixture, projectKey: storageKey('project'), sessionKey: storageKey('session') });
    },
    async ready(check) {
      await check.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: runtime.timeout });
    },
    async theme(check) {
      const key = dottedStorageKey('theme');
      // Read the app's own validated state after boot; persist follow-system via
      // the real preference route. Never synthesize theme tokens or click menus.
      const state = await runtime.until(() => check.page.evaluate(key => {
        try { return JSON.parse(localStorage.getItem(key))?.state; } catch { return null; }
      }, key), 'stored app theme', runtime.timeout);
      await rpc('pi/prefs/set', { namespace: 'theme', value: { ...state, followSystem: true } });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === '--provider') {
  const root = process.argv[3];
  const { startStubProvider, writeStubModels } = await import('../../../packages/worker/test/agents/stub-provider.ts');
  const { answer } = await import('./fixtures.mjs');
  const provider = await startStubProvider(answer);
  writeStubModels(join(root, 'agent'), provider.url);
  const modelsPath = join(root, 'agent/models.json');
  const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
  models.providers.stub.models[0].contextWindow = 1000000;
  writeFileSync(modelsPath, JSON.stringify(models));
  writeFileSync(join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub-1', compaction: { enabled: false } }));
  writeFileSync(join(root, 'provider.json'), JSON.stringify({ url: provider.url }));
  process.once('SIGTERM', () => void provider.close().then(() => process.exit(0)));
}
export { fixture } from './fixtures.mjs';
