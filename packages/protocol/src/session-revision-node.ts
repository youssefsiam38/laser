/**
 * The Node hash behind `session-revision.ts`, kept off the package barrel.
 *
 * The UI bundles the barrel into the browser, so `node:crypto` must never be
 * reachable from `index.ts`. Host and worker import this subpath directly
 * (`@lasercode/protocol/revision-node`) and share exactly one hash, which is
 * what makes a live revision and a disk revision comparable at all.
 */
import { createHash } from "node:crypto";
import type { RevisionHasher } from "./session-revision.js";

export const nodeRevisionHasher: RevisionHasher = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("base64url");
