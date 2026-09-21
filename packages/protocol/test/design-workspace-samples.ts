/**
 * Round-trip samples for the design workspace methods (M21-T13).
 *
 * One per method, so `schemas.test.ts` proves every one of them survives the
 * wire exactly as it was written.
 */
import type { ClientRequests } from "../src/index.js";

export const SAMPLE_DESIGN_PROJECT_ID = "pw_9f2c1a0400000000000000000000";

type Params<M extends keyof ClientRequests> = ClientRequests[M]["params"];

export const sampleDesignWorkspaceParams = {
  "design/index/get": { projectId: SAMPLE_DESIGN_PROJECT_ID } satisfies Params<"design/index/get">,
  "design/index/build": {
    projectId: SAMPLE_DESIGN_PROJECT_ID,
    rebuild: true,
    appRoot: "apps/web",
    maxFiles: 5000,
    sessionPath: "/sessions/one.jsonl",
  } satisfies Params<"design/index/build">,
  "design/index/stop": { projectId: SAMPLE_DESIGN_PROJECT_ID, commandId: "dib_1" } satisfies Params<"design/index/stop">,
  "design/index/review": {
    projectId: SAMPLE_DESIGN_PROJECT_ID,
    entryId: "e_button",
    action: "rename",
    name: "Primary button",
    note: "the name the team uses",
    expectedFactsDigest: "a".repeat(64),
  } satisfies Params<"design/index/review">,
  "design/host/ground": {
    projectId: SAMPLE_DESIGN_PROJECT_ID,
    routeOrPath: "/orders",
    appRoot: "apps/web",
    featureSize: "medium",
    hostStackCanExpress: true,
    migrationWanted: false,
    teamKnowsHostStack: true,
  } satisfies Params<"design/host/ground">,
  "design/sketch/ground": {
    projectId: SAMPLE_DESIGN_PROJECT_ID,
    document: "<!doctype html><html><body><h1>Orders</h1></body></html>",
    screenName: "Orders, grounded",
  } satisfies Params<"design/sketch/ground">,
};
