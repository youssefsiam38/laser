import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_REF_NAMESPACE,
  CHANGE_SCOPES,
  CHECKPOINT_RETENTION_DEFAULT,
  FILE_BLOB_MAX_BYTES,
  FILE_BLOB_PAGE_MAX_BYTES,
  GIT_EMPTY_TREE,
  IMAGE_MEDIA_TYPES,
  clientParamsSchemas,
  imageMediaTypeForPath,
  type FileBlob,
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

describe("image bytes for a file with no textual diff", () => {
  it("draws only what a browser paints, from the path's own extension", () => {
    expect(imageMediaTypeForPath("src/logo.PNG")).toBe("image/png");
    expect(imageMediaTypeForPath("a/b/shot.jpeg")).toBe("image/jpeg");
    expect(imageMediaTypeForPath("icon.ico")).toBe("image/x-icon");
    // Text with a textual diff, formats a browser will not draw, and no
    // extension at all: none of them is an image this app renders.
    expect(imageMediaTypeForPath("mark.svg")).toBeUndefined();
    expect(imageMediaTypeForPath("scan.tiff")).toBeUndefined();
    expect(imageMediaTypeForPath("bundle.wasm")).toBeUndefined();
    expect(imageMediaTypeForPath("Makefile")).toBeUndefined();
    for (const type of Object.values(IMAGE_MEDIA_TYPES)) expect(type.startsWith("image/")).toBe(true);
  });

  it("bounds one side at 4 MiB and one page at 512 KiB", () => {
    expect(FILE_BLOB_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(FILE_BLOB_PAGE_MAX_BYTES).toBe(512 * 1024);
    const params = clientParamsSchemas["pi/project/file_blob"];
    expect(params.safeParse({ cwd: "/p", path: "/s.jsonl", repo: "/p", file: "logo.png" }).success).toBe(true);
    // A caller cannot ask for a bigger page than the wire is planned for, and
    // cannot smuggle a scope field this request does not have.
    expect(params.safeParse({ cwd: "/p", path: "/s.jsonl", repo: "/p", file: "logo.png", limit: FILE_BLOB_PAGE_MAX_BYTES + 1 }).success).toBe(false);
    expect(params.safeParse({ cwd: "/p", path: "/s.jsonl", repo: "/p", file: "logo.png", scope: "session" }).success).toBe(false);
  });

  it("round-trips a page of bytes and a refusal that still states the size", () => {
    const page: FileBlob = {
      repo: "/p",
      path: "src/logo.png",
      ref: "worktree",
      mediaType: "image/png",
      totalBytes: 1_200_000,
      offset: 0,
      bytes: FILE_BLOB_PAGE_MAX_BYTES,
      next: FILE_BLOB_PAGE_MAX_BYTES,
      truncated: true,
      data: "iVBORw0KGgo=",
      width: 512,
      height: 256,
    };
    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    const refused: FileBlob = {
      repo: "/p",
      path: "vendor/fonts/body.woff2",
      ref: "HEAD",
      mediaType: "application/octet-stream",
      totalBytes: 48_000,
      offset: 0,
      bytes: 0,
      truncated: false,
      refused: "not-an-image",
    };
    expect(JSON.parse(JSON.stringify(refused))).toEqual(refused);
    expect(refused.data).toBeUndefined();
  });
});
