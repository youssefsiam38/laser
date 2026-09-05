/**
 * Public surface of the piorbit assistant-ui runtime layer.
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

export {
  PROJECTS_STORAGE_KEY,
  PROJECT_STORAGE_KEY,
  PiorbitProvider,
  useExtensionUi,
  useHostUiRequests,
  usePiorbit,
  usePiorbitStable,
  usePiorbitState,
  usePiorbitView,
  useSessionMeta,
  useToasts,
  type ExtensionUi,
  type HostUiRequests,
  type PiorbitActions,
  type PiorbitContextValue,
  type PiorbitStable,
  type PiorbitProviderProps,
  type SessionMeta,
  type Toasts,
} from "./PiorbitProvider.js";
