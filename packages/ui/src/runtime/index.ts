/**
 * Public surface of the laser assistant-ui runtime layer.
 *
 * Components import from here; nothing below it talks to `HostClient` or the
 * reducer directly.
 */
export {
  NOTICE_DATA_PART,
  dialogActionReason,
  dialogToToolFields,
  projectMessages,
  projectSessionView,
  shareProjectedMessages,
  splitDialogs,
  toolStatus,
  type ProjectedContentPart,
  type ProjectedMessageStatus,
  type ProjectedToolCallPart,
  type ProjectedToolStatus,
  type ProjectionInput,
  type ProjectionResult,
} from "./projection.js";

export {
  ARCHIVE_STORAGE_KEY,
  ATTENTION_ORDER,
  attentionRank,
  createArchiveStore,
  createThreadListAdapter,
  mergeSessions,
  sessionAttention,
  sessionTitle,
  sortSessions,
  threadListSignature,
  toThreadMetadata,
  type ArchiveStore,
  type RemoteThreadMetadata,
  type ThreadListDeps,
} from "./threadList.js";

export {
  FOLLOW_UP_QUEUE_PREFIX,
  STEER_QUEUE_PREFIX,
  composerSendPlan,
  contentBlocksFromAppendMessage,
  createThreadAdapter,
  imageContentFromDataUrl,
  imageCountOfContentBlocks,
  isSteerQueueItemId,
  queueItemId,
  queueItemsOf,
  requestIdOfInterruptPayload,
  resolveSendBehavior,
  sendToSession,
  textOfContentBlocks,
  uiResponseForApproval,
  uiResponseForInterrupt,
  type ComposerKeyState,
  type ComposerSendPlan,
  type InterruptAnswer,
  type RequestClient,
  type SendBehavior,
  type SendLane,
  type ThreadAdapterDeps,
} from "./adapter.js";

export { THEME_PREFS_NAMESPACE, useThemeSync } from "./prefs.js";
export {
  activityDetailLevel,
  activityGroupDefaultOpen,
  setActivityDetailLevel,
  toolDetailsDefaultOpen,
  useActivityDetailLevel,
  type ActivityDetailLevel,
} from "./sessionPreferences.js";

export {
  PROJECTS_STORAGE_KEY,
  PROJECT_STORAGE_KEY,
  LaserProvider,
  useExtensionUi,
  useHostUiRequests,
  useLaser,
  useLaserStable,
  useLaserState,
  useLaserView,
  useSessionMeta,
  useToasts,
  useTrustPrompts,
  type ExtensionUi,
  type HostUiRequests,
  type TrustPrompts,
  type TrustRequest,
  type LaserActions,
  type LaserContextValue,
  type LaserStable,
  type LaserProviderProps,
  type SessionMeta,
  type Toasts,
} from "./LaserProvider.js";
