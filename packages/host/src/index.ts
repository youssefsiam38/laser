/**
 * @lasercode/host — supervisor. Must not import Pi; it talks to workers only
 * through @lasercode/protocol over an fd-3 pipe.
 */
export {
  HostServer,
  type HostServerOptions,
  type HostRelayOptions,
  type HostRelayDevice,
  defaultUiDir,
} from "./server.js";
export { piorbitDataDir, defaultAgentDir, defaultStateDir } from "./paths.js";
export {
  migrateFormerIdentities,
  ownedDirectories,
  type IdentityMigrationResult,
  type IdentityMigrationStep,
} from "./identity-migration.js";
export { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";
export { WorkerClient, WorkerRpcError, defaultWorkerMain, type WorkerClientOptions } from "./worker-client.js";
export { SessionCatalog, defaultSessionDir, type CatalogEntry } from "./catalog.js";
export { AttentionTracker, type AttentionSnapshot, type AttentionTrackerOptions } from "./attention.js";
export { PrefsStore, type PrefsStoreOptions } from "./prefs.js";
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
  CURATED_PACKAGES,
  PackageLock,
  PackageService,
  PackageServiceError,
  SetupService,
  browseDirectories,
  describeInstallFailure,
  detectInstallRuntime,
  parseNpmSource,
  resolveFromPackument,
  type InstallRuntime,
  type NpmSource,
  type PackageServiceOptions,
  type SetupServiceOptions,
} from "./packages.js";
export {
  RelayClient,
  type RelayClientOptions,
  type RelayClientState,
  type RelayClientStats,
} from "./relay-client.js";
export * from "./subagents/index.js";
export * from "./panels/index.js";
export {
  PushService,
  b64url,
  encryptPushPayload,
  generateVapidKeys,
  vapidAuthorization,
  type PushSendResult,
  type PushServiceOptions,
  type StoredPushSubscription,
  type VapidKeys,
} from "./push.js";

export const HOST_DEFAULT_PORT = 41_441;
export const HOST_BIND_ADDRESS = "127.0.0.1";
