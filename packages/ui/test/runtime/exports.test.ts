import { namespaced } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import * as runtime from "../../src/runtime/index.js";

/**
 * Guards the public surface the shell components import. A missing export here
 * is a broken UI, and importing the barrel also proves the provider module
 * loads (assistant-ui + React resolve, nothing runs at import time).
 */
describe("runtime barrel", () => {
  it("exports the provider, its hooks and the pure builders", () => {
    for (const name of [
      "LaserProvider",
      "useLaser",
      "useLaserStable",
      "useLaserState",
      "useLaserView",
      "useHostUiRequests",
      "useSessionMeta",
      "useExtensionUi",
      "useToasts",
      "projectMessages",
      "projectSessionView",
      "shareProjectedMessages",
      "splitDialogs",
      "toolStatus",
      "dialogToToolFields",
      "dialogActionReason",
      "createThreadAdapter",
      "createThreadListAdapter",
      "createArchiveStore",
      "sortSessions",
      "sessionAttention",
      "sessionTitle",
      "mergeSessions",
      "toThreadMetadata",
      "threadListSignature",
      "composerSendPlan",
      "resolveSendBehavior",
      "sendToSession",
      "contentBlocksFromAppendMessage",
      "imageContentFromDataUrl",
      "imageCountOfContentBlocks",
      "textOfContentBlocks",
      "queueItemsOf",
      "queueItemId",
      "isSteerQueueItemId",
      "uiResponseForApproval",
      "uiResponseForInterrupt",
      "requestIdOfInterruptPayload",
      "attentionRank",
    ]) {
      expect(runtime, name).toHaveProperty(name);
      expect(typeof (runtime as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("exports the documented constants", () => {
    expect(runtime.NOTICE_DATA_PART).toBe(namespaced("notice"));
    expect(runtime.ARCHIVE_STORAGE_KEY).toBe(namespaced("archived"));
    expect(runtime.PROJECT_STORAGE_KEY).toBe(namespaced("project"));
    expect(runtime.PROJECTS_STORAGE_KEY).toBe(namespaced("projects"));
    expect(runtime.STEER_QUEUE_PREFIX).toBe("steer:");
    expect(runtime.FOLLOW_UP_QUEUE_PREFIX).toBe("followUp:");
    expect(runtime.ATTENTION_ORDER).toEqual(["waiting_for_input", "error", "finished_unread", "working", "idle"]);
  });
});
