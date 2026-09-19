import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_REF_NAMESPACE,
  CHANGE_SCOPES,
  CHECKPOINT_RETENTION_DEFAULT,
  GIT_EMPTY_TREE,
  checkpointRef,
  checkpointRefPrefix,
  checkpointRetentionFromSettingsJson,
  checkpointRetentionKeep,
  gitLooksBinary,
  isChangeScope,
  isCheckpointRetention,
  mergeSourceControlSettingsJson,
  parseCheckpointRef,
} from "../src/index.js";
import { checkpointSessionKey } from "../src/checkpoint-key.js";

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
    expect(GIT_EMPTY_TREE).toMatch(/^[0-9a-f]{40}$/);
    expect(gitLooksBinary(Buffer.from("hello"))).toBe(false);
    expect(gitLooksBinary(Buffer.from([0, 1, 2]))).toBe(true);
    expect(checkpointRetentionFromSettingsJson('{"checkpointRetention":"50"}')).toBe("50");
    expect(mergeSourceControlSettingsJson({}, "off")).toContain("off");
    expect(checkpointSessionKey("/sessions/demo.jsonl")).toHaveLength(32);
    expect(checkpointSessionKey("/sessions/demo.jsonl")).toBe(checkpointSessionKey("/sessions/demo.jsonl"));
  });
});
