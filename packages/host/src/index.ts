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
export { laserDataDir, defaultAgentDir, defaultStateDir, workspacesDir, beamWorkspaceDir, chatWorkspaceDir, createPrivateSessionWorkspace, ensureWorkspace, projectRootOf } from "./paths.js";
export * from "./agents/index.js";
export {
  migrateFormerIdentities,
  ownedDirectories,
  type IdentityMigrationResult,
  type IdentityMigrationStep,
} from "./identity-migration.js";
export { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";
export { WorkerClient, WorkerRpcError, defaultWorkerMain, type WorkerClientOptions } from "./worker-client.js";
export {
  HOST_OLD_SPACE_CAP_MIB,
  HOST_OLD_SPACE_FLOOR_MIB,
  WORKER_OLD_SPACE_CAP_MIB,
  WORKER_OLD_SPACE_FLOOR_MIB,
  HeapCeilingCapacityError,
  configuredOldSpaceBytes,
  hostOldSpaceMiB,
  oldSpaceBytes,
  oldSpaceMiBFor,
  oldSpaceSizeFlag,
  runtimeMemoryCapacityBytes,
  workerOldSpaceMiB,
  type HeapCeilingRole,
} from "./heap-ceiling.js";
export { SessionCatalog, defaultSessionDir, type CatalogEntry } from "./catalog.js";
export { AttentionTracker, type AttentionSnapshot, type AttentionTrackerOptions } from "./attention.js";
export { PrefsStore, type PrefsStoreOptions } from "./prefs.js";
export { FeatureService } from "./features.js";
export { ProjectRegistry, type ProjectRegistryOptions, type TrustRequest } from "./projects.js";
export { ViewCache } from "./views.js";
export {
  SessionIndexCache,
  DEFAULT_SESSION_INDEX_LIMITS,
  READABLE_SESSION_VERSION,
  type FileIdentity,
  type IndexedEntry,
  type SessionIndex,
  type SessionIndexFailure,
  type SessionIndexLimits,
  type SessionIndexResult,
} from "./session-index.js";
export { SessionProjection, type ProjectionAnswer, type SessionProjectionOptions } from "./session-projection.js";
export { SessionBodyRange, sha256Hex, sliceAnswer, type BodyRangeAnswer, type SessionBodyRangeOptions } from "./session-body-range.js";
export { SessionRevisions, type ResolvedRevisionBase, type RevisionAnswer, type SessionRevisionsOptions } from "./session-revision.js";
export {
  canonical,
  trustReasons,
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
  AccessControl,
  LOCAL_APP_ACTOR_ID,
  LOCAL_BROWSER_ACTOR_ID,
  isLoopbackAddress,
  localActor,
  pairedActor,
  pairedActorId,
  type AccessControlOptions,
  type ActorIdentity,
  type Authorization,
  type HostCapabilities,
  type RequestAccess,
} from "./access.js";
export {
  AccessAudit,
  DEFAULT_AUDIT_BOUNDS,
  UNKNOWN_METHOD_LABEL,
  unknownMethodDigest,
  type AccessAuditOptions,
  type AccessAuditRecord,
  type AuditBounds,
  type AuditOutcome,
  type AuditSink,
} from "./access-audit.js";
export {
  CONFIGURED_POLICY_SOURCE,
  ENVIRONMENT_POLICY_FILE,
  FILE_POLICY_SOURCE,
  loadEnvironmentPolicy,
  type LoadEnvironmentPolicyOptions,
  type LoadedEnvironmentPolicy,
} from "./environment-policy.js";
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
export * from "./tasks/index.js";
export {
  ProcessOwnershipRegistry,
  ResourceHistory,
  ResourceService,
  type OwnershipLookups,
  type ResourceServiceOptions,
} from "./resources/index.js";
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
