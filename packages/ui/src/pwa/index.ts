/**
 * PWA layer: what makes the one web bundle feel native on a phone.
 * Components live in `components/mobile`; this is the logic underneath.
 */
// The push document is protocol, not a UI concern: the host builds it, the
// page reads it, and the service worker restates it (it is emitted as one
// standalone file). Re-exported here so `@/pwa` stays the one import for this
// layer.
export {
  DECLARATIVE_WEB_PUSH_VERSION,
  clipForNotification,
  decisionNavigateUrl,
  decisionPushPayload,
  isDeclarativePushPayload,
  type DeclarativePushAction,
  type DeclarativePushNotification,
  type DeclarativePushPayload,
  type DecisionPushData,
  type DecisionPushInput,
} from "@lasercode/protocol";

export {
  applyUpdate,
  getServiceWorkerRegistration,
  onServiceWorkerMessage,
  registerServiceWorker,
  resetServiceWorkerState,
  useServiceWorker,
  type ServiceWorkerSnapshot,
} from "./register.js";

export {
  canPromptInstall,
  captureInstallPrompt,
  detectPlatform,
  insecureOriginAdvice,
  promptInstall,
  readEnvironment,
  useCanPromptInstall,
  useEnvironment,
  type InsecureOriginAdvice,
  type MobilePlatform,
  type PwaEnvironment,
} from "./environment.js";

export { SETTLE_DELAYS_MS, VISUAL_HEIGHT_VAR, VISUAL_TOP_VAR, installViewportGuards, viewportVars, type ViewportMetrics } from "./viewport.js";

export {
  DEFAULT_CONNECTING_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  createReconnectGuard,
  type GuardConnectionState,
  type ReconnectGuard,
  type ReconnectGuardEvent,
  type ReconnectGuardOptions,
  type ReconnectableClient,
} from "./reconnect.js";

export {
  asRawClient,
  extendedRequest,
  type MobileMethod,
  type PushConfig,
  type PushDeviceInfo,
  type PushSubscriptionJson,
  type RawRequestClient,
  type TranscribeStatus,
} from "./host-rpc.js";

export {
  PushPermissionError,
  currentSubscription,
  deviceLabel,
  disablePush,
  enablePush,
  pushAvailability,
  subscriptionToJson,
  syncPushSubscription,
  urlBase64ToUint8Array,
  usePush,
  type PushAvailability,
  type UsePush,
} from "./push.js";

export {
  CHUNK_BYTES,
  DEFAULT_MAX_SECONDS,
  MediaRecorderDictationAdapter,
  RECORDER_MIME_CANDIDATES,
  chunkBase64,
  describeMicrophoneError,
  pickRecorderMimeType,
  placePhraseAtCaret,
  transcribeTransport,
  type CaretPlacement,
  type DictationPhase,
  type MediaRecorderDictationOptions,
  type TranscribeTransport,
} from "./dictation.js";

export {
  LINK_TTL_MS,
  acceptNavigateMessage,
  consumeDecisionLink,
  parseDecisionLink,
  pendingDecisionLink,
  rememberDecisionLink,
  resetDecisionLinks,
  stripDecisionParams,
  usePendingDecisionLink,
  type DecisionLink,
  type DecisionLinkAnswer,
} from "./deep-link.js";

export {
  clearDictationError,
  getMobileDictationAdapter,
  setDictationPhraseSink,
  setDictationScope,
  useDictationError,
  useDictationLevel,
  useDictationPhase,
} from "./mobile-dictation.js";
