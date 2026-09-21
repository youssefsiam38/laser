/**
 * Round-trip samples for import, export and publication (M21-T21).
 *
 * One valid params value per method, so the wire parser, the policy table and
 * the envelope test all have something real to parse. Not a test file itself.
 */
import type { ProjectWorkInteropMethod } from "../src/project-work-interop.js";
import { SAMPLE_DIGEST, SAMPLE_ENTITY_ID, SAMPLE_PROJECT_ID, SAMPLE_REVISION_ID } from "./project-work-samples.js";

export const sampleInteropMethodParams: Record<ProjectWorkInteropMethod, unknown> = {
  "project/work/import/preview": { projectId: SAMPLE_PROJECT_ID, adapter: "spec_kit", path: "specs" },
  "project/work/import/apply": {
    projectId: SAMPLE_PROJECT_ID,
    adapter: "spec_kit",
    path: "specs",
    previewDigest: SAMPLE_DIGEST,
    confirm: true,
    decisions: [{ sourceId: "spec_kit:specs/001-phone-review/spec.md", choice: "new_revision" }],
    idempotencyKey: "import-1",
  },
  "project/work/export/preview": { projectId: SAMPLE_PROJECT_ID, includeArchived: false },
  "project/work/export/apply": {
    projectId: SAMPLE_PROJECT_ID,
    mode: "replace",
    previewDigest: SAMPLE_DIGEST,
    confirm: true,
    idempotencyKey: "export-1",
  },
  "project/work/publish/preview": { projectId: SAMPLE_PROJECT_ID },
  "project/work/publish/apply": {
    projectId: SAMPLE_PROJECT_ID,
    previewDigest: SAMPLE_DIGEST,
    confirm: true,
    commit: "1".repeat(40),
    idempotencyKey: "publish-1",
  },
};

/** A manifest with one of everything, for the manifest schema's round trip. */
export const sampleManifest = {
  format: "project-work" as const,
  version: 1 as const,
  product: "example",
  project: { projectId: SAMPLE_PROJECT_ID },
  entities: [
    {
      entityId: SAMPLE_ENTITY_ID,
      key: "SPEC-1",
      kind: "spec" as const,
      title: "Phone review",
      state: "approved" as const,
      archived: false,
      revisionId: SAMPLE_REVISION_ID,
      revisionIndex: 2,
      digest: SAMPLE_DIGEST,
      bodyBytes: 412,
      document: "SPEC-1.md",
      body: "bodies/SPEC-1.json",
    },
  ],
  relations: [
    {
      relation: "implements" as const,
      subject: { entityId: "wk_task", key: "TASK-1", revisionId: "rev_task" },
      object: { entityId: SAMPLE_ENTITY_ID, key: "SPEC-1", revisionId: SAMPLE_REVISION_ID },
    },
  ],
  repositoryLinks: [
    {
      linkId: "lnk_1",
      relation: "published_as" as const,
      repositoryId: "repo_1",
      subject: { entityId: SAMPLE_ENTITY_ID, key: "SPEC-1", revisionId: SAMPLE_REVISION_ID },
      target: { state: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "1".repeat(40), path: "docs/work/SPEC-1.md" } },
      publishedPath: "docs/work/SPEC-1.md",
    },
  ],
  attachments: [{ blobId: "blb_1", mediaType: "text/html", digest: "b".repeat(64), bytes: 2048, key: "DES-1", field: "sketch" }],
};
