import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const workerModule = await import(pathToFileURL(join(checkout, 'packages/worker/dist/server.js')).href);
const backgroundModule = await import(pathToFileURL(join(checkout, 'packages/pi-extension/dist/modules/background-work.js')).href);
Object.defineProperty(globalThis, '__resourceSoakPrototypes', {
  value: { WorkerServer: workerModule.WorkerServer.prototype, TailBuffer: backgroundModule.TailBuffer.prototype },
  configurable: false, enumerable: false, writable: false,
});
await import(pathToFileURL(join(checkout, 'packages/worker/dist/main.js')).href);
