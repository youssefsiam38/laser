import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modeConfig } from './config.mjs';
import { linuxStartToken } from './inspector.mjs';

const self = fileURLToPath(import.meta.url);
if (resolve(process.argv[1]) === self) {
  const root = process.argv[2];
  const mode = modeConfig(process.argv[3] ?? 'quick');
  const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const { HostServer } = await import(pathToFileURL(join(checkout, 'packages/host/dist/index.js')).href);
  const paths = {
    agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), stateDir: join(root, 'state'),
    workspacesDir: join(root, 'workspaces'), logFile: join(root, 'state', 'logs.db'),
  };
  for (const path of Object.values(paths).filter(path => !path.endsWith('.db'))) mkdirSync(path, { recursive: true });
  Object.defineProperty(globalThis, '__resourceSoakPrototypes', {
    value: { HostServer: HostServer.prototype }, configurable: false, enumerable: false, writable: false,
  });
  const server = new HostServer({
    ...paths, port: 0, host: '127.0.0.1',
    uiDir: join(checkout, 'packages/ui/dist'),
    workerMain: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    nodeBinary: process.execPath,
    workerIdleMs: mode.idleMs, workerSweepMs: mode.sweepMs,
    logRetention: { providerPayloads: 'full' },
    log: line => process.stderr.write(`${line}\n`),
  });
  const listening = await server.listen();
  const record = { url: listening.url, pid: process.pid, startToken: await linuxStartToken(process.pid) };
  writeFileSync(join(root, 'host.json'), JSON.stringify(record), { mode: 0o600 });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close({ initiator: 'harness' }); process.exit(0); };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
