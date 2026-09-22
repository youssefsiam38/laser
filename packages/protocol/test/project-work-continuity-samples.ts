/**
 * Round-trip samples for identity across relocation (M21-T20).
 *
 * One valid params value per method, so the wire parser, the policy table and
 * the envelope test all have something real to parse. Not a test file itself.
 */
import { PRODUCT_NAME } from "../src/identity.js";
import type { ProjectWorkContinuityMethod } from "../src/project-work-continuity.js";
import { SAMPLE_DIGEST, SAMPLE_PROJECT_ID } from "./project-work-samples.js";

/** A folder path. Derived, because the product is named in one place only. */
export const SAMPLE_PROJECT_PATH = `/home/p/projects/${PRODUCT_NAME}`;

export const sampleContinuityMethodParams: Record<ProjectWorkContinuityMethod, unknown> = {
  "project/work/identity": { cwd: SAMPLE_PROJECT_PATH },
  "project/work/relink": {
    cwd: SAMPLE_PROJECT_PATH,
    choice: "reconnect",
    projectId: SAMPLE_PROJECT_ID,
    previewDigest: SAMPLE_DIGEST,
    confirm: true,
    idempotencyKey: "relink-1",
  },
};
