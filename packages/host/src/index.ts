/**
 * @piorbit/host — supervisor. Must not import Pi; it talks to workers only
 * through @piorbit/protocol over an fd-3 pipe.
 */
export {
  HostServer,
  type HostServerOptions,
  type HostRelayOptions,
  type HostRelayDevice,
  defaultUiDir,
  defaultStateDir,
} from "./server.js";
export { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";
export { WorkerClient, WorkerRpcError, defaultWorkerMain, type WorkerClientOptions } from "./worker-client.js";
export { SessionCatalog, defaultSessionDir, type CatalogEntry } from "./catalog.js";
export { AttentionTracker, type AttentionSnapshot, type AttentionTrackerOptions } from "./attention.js";
export { ProjectRegistry, type ProjectRegistryOptions, type TrustRequest } from "./projects.js";
export { ViewCache } from "./views.js";
export {
  canonical,
  defaultProjectTrust,
  savedPiTrust,
  trustReasons,
  type DefaultProjectTrust,
  type TrustReasons,
} from "./trust.js";
export {
  LogStore,
  LogStoreUnavailableError,
  describeProviderRequest,
  formatBytes,
  type LogInput,
  type LogStoreOptions,
} from "./logstore.js";
export { Router, type RouterDeps } from "./router.js";
export {
  RelayClient,
  type RelayClientOptions,
  type RelayClientState,
  type RelayClientStats,
} from "./relay-client.js";
export * from "./subagents/file-layer.js";

export const HOST_DEFAULT_PORT = 41_441;
export const HOST_BIND_ADDRESS = "127.0.0.1";
