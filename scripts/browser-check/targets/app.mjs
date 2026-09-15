import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactTreeSha256 } from '../../review-env/artifacts.mjs';

export const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const self = fileURLToPath(import.meta.url);

/**
 * Point the sandboxed agent directory at a stub provider and record its URL.
 * Shared with sibling targets that supply their own provider process (the
 * streaming profiler's chunked provider), so provider startup stays one recipe.
 */
export function configureStubProvider(root, url) {
  const modelsPath = join(root, 'agent/models.json');
  const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
  models.providers.stub.models[0].contextWindow = 1000000;
  writeFileSync(modelsPath, JSON.stringify(models));
  writeFileSync(join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub-1', compaction: { enabled: false } }));
  writeFileSync(join(root, 'provider.json'), JSON.stringify({ url }));
}

/**
 * The app's own notification deep link, which is how this target lands a case
 * on the fixture's session (`packages/ui/src/pwa/deep-link.ts`,
 * `main-destination-controller.ts`). It is consumed by the same startup path a
 * person's notification tap uses — after the environment handshake, through
 * the app's own `openSession` — so the harness never builds a storage key or
 * an environment key of its own.
 */
export function sessionDeepLink(url, path) {
  return `${url.replace(/\/$/, '')}/#/session/${encodeURIComponent(path)}`;
}

/**
 * The session the app itself says it is showing, read from the destination it
 * recorded through its own device-storage authority. Read-only, and by suffix:
 * the environment namespace belongs to the app, and this never reconstructs or
 * assumes one. `undefined` means "it has not said yet".
 */
export function openedSessionPath(entries) {
  for (const [key, value] of entries) {
    if (!key.endsWith(':destination')) continue;
    try {
      const code = JSON.parse(value)?.code;
      if (code?.kind === 'project-session' && typeof code.path === 'string') return code.path;
    } catch {
      // A record this harness cannot read is not a destination it can trust.
    }
  }
  return undefined;
}

/**
 * `options.provider` is the module that runs the stub provider process; it must
 * accept `--provider <root>` and write `provider.json` as this file does.
 * Everything else — host, fixtures, theme, RPC — is identical for every target
 * built on this one.
 */
export async function target(runtime, options = {}) {
  for (const path of ['packages/cli/dist/main.js', 'packages/host/dist/index.js', 'packages/worker/dist/main.js', 'packages/ui/dist/index.html']) {
    if (!existsSync(join(checkout, path))) throw new Error('The app is not built; run pnpm -r build from the target checkout.');
  }
  const { ENV, dottedStorageKey } = await import('../../../packages/protocol/dist/index.js');
  const { PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV } = await import('../../../packages/cli/dist/config.js');
  const agentDir = join(runtime.root, 'agent'), sessionDir = join(runtime.root, 'sessions'), stateDir = join(runtime.root, 'state');
  for (const path of [agentDir, sessionDir, stateDir]) mkdirSync(path, { recursive: true });
  const env = { ...runtime.env, [ENV.agentDir]: agentDir, [ENV.sessionDir]: sessionDir, [ENV.stateDir]: stateDir, [ENV.node]: runtime.node, [PI_AGENT_DIR_ENV]: agentDir, [PI_SESSION_DIR_ENV]: sessionDir, PI_MCP_ADAPTER_TEST_AUTH_STORE: 'memory' };
  runtime.spawn(runtime.node, [options.provider ?? self, '--provider', runtime.root], { name: 'provider', env });
  await runtime.until(() => existsSync(join(runtime.root, 'provider.json')), 'stub provider (see logs/provider.log)', runtime.timeout);
  const port = await runtime.freePort();
  runtime.spawn(runtime.node, [join(checkout, 'packages/cli/dist/main.js'), 'up', '--foreground', '--no-open', '--port', String(port), '--agent-dir', agentDir, '--session-dir', sessionDir, '--state-dir', stateDir], { name: 'host', env });
  const url = `http://127.0.0.1:${port}`;
  await runtime.until(async () => (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok, 'built host (see logs/host.log)', runtime.timeout);
  const version = JSON.parse(readFileSync(join(checkout, 'packages/cli/package.json'), 'utf8')).version;
  /** The fixture session every case opens, decided once the fixture exists. */
  let landing;
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
    async preparePage(_check, fixture) {
      // Which session every case of this run should be looking at. Seeding it
      // into storage is not possible any more and never was safe: those keys
      // belonged to no environment, and the app purges them before it reads
      // anything (RP-13 B). `ready` navigates instead.
      landing = fixture?.path;
    },
    async ready(check) {
      if (landing) {
        await check.page.goto(sessionDeepLink(url, landing), { waitUntil: 'domcontentloaded' });
        // A navigation can restore the context's initial touch/media overrides.
        await check.touch(check.state.touch);
        await check.reducedMotion(check.state.reducedMotion);
      }
      await check.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: runtime.timeout });
      if (!landing) return;
      // The app has to agree, in its own words, that this is where it is: a
      // case that started on a different session would make every assertion
      // about "the fixture session" a coincidence.
      await runtime.until(
        async () => openedSessionPath(await check.page.evaluate(() => Object.entries(localStorage))) === landing,
        `the app to open the fixture session ${landing}`,
        runtime.timeout,
      );
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
  configureStubProvider(root, provider.url);
  process.once('SIGTERM', () => void provider.close().then(() => process.exit(0)));
}
export { fixture } from './fixtures.mjs';
