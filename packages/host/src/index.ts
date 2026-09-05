/**
 * @piorbit/host — supervisor. Must not import Pi; it talks to workers only
 * through @piorbit/protocol over an fd-3 pipe.
 */
export { HostServer, type HostServerOptions, defaultUiDir } from "./server.js";
export { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";
export { WorkerClient, WorkerRpcError, defaultWorkerMain, type WorkerClientOptions } from "./worker-client.js";
export { SessionCatalog, defaultSessionDir, type CatalogEntry } from "./catalog.js";
export { Router } from "./router.js";
export * from "./subagents/file-layer.js";

export const HOST_DEFAULT_PORT = 41_441;
export const HOST_BIND_ADDRESS = "127.0.0.1";
