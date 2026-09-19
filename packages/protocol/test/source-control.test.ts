import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_REF_NAMESPACE,
  CHANGE_SCOPES,
  CHECKPOINT_RETENTION_DEFAULT,
  checkpointRef,
  checkpointRefPrefix,
  checkpointRetentionKeep,
  isChangeScope,
  isCheckpointRetention,
  parseCheckpointRef,
} from "../src/index.js";

describe("checkpoint refs", () => {
  it("lays out refs under the product namespace without a hard-coded name", () => {
    expect(CHECKPOINT_REF_NAMESPACE.startsWith("refs/")).toBe(true);
    expect(CHECKPOINT_REF_NAMESPACE.endsWith("/checkpoints")).toBe(true);
    const ref = checkpointRef("abc", 7);
    expect(ref).toBe(`${checkpointRefPrefix("abc")}/7`);
    expect(parseCheckpointRef(ref)).toEqual({ sessionKey: "abc", turn: 7 });
    expect(parseCheckpointRef("refs/other/checkpoints/abc/7")).toBeUndefined();
  });

  it("keeps the default retention at 200 turns", () => {
    expect(CHECKPOINT_RETENTION_DEFAULT).toBe("200");
    expect(checkpointRetentionKeep("200")).toBe(200);
    expect(checkpointRetentionKeep("off")).toBe(0);
    expect(checkpointRetentionKeep("all")).toBeNull();
    expect(isCheckpointRetention("200")).toBe(true);
    expect(isCheckpointRetention("20")).toBe(false);
    expect(CHANGE_SCOPES).toEqual(["session", "turn", "uncommitted", "range", "agent"]);
    expect(isChangeScope("session")).toBe(true);
  });
});
