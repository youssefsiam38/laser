/**
 * M21-T20: the identity-across-relocation inventory.
 *
 * Two methods, each with a closed schema, a policy row, a byte limit and a
 * round-trip sample; a relink that cannot be made without `confirm` and the
 * digest of the preview it was decided from; and a marker file that reads as
 * absent whenever it is not exactly a marker.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_IDENTITY_STATES,
  PROJECT_MARKER_PATH,
  PROJECT_RELINK_CHOICES,
  PROJECT_WORK_CONTINUITY_METHODS,
  PROJECT_WORK_CONTINUITY_METHOD_LIMITS,
  PROJECT_WORK_CONTINUITY_WRITE_METHODS,
  parseProjectMarker,
  projectIdentityResultSchema,
  projectMarkerJson,
  projectRelinkResultSchema,
  projectWorkContinuityParamsSchemas,
  type ProjectWorkContinuityMethod,
} from "../src/project-work-continuity.js";
import { clientParamsSchemas, parseClientRequest, ProtocolError } from "../src/schemas.js";
import { methodPolicy } from "../src/method-policy.js";
import { PROJECT_DIR_NAME } from "../src/identity.js";
import { sampleContinuityMethodParams, SAMPLE_PROJECT_PATH } from "./project-work-continuity-samples.js";
import { SAMPLE_DIGEST, SAMPLE_PROJECT_ID } from "./project-work-samples.js";

const COPY_PATH = `${SAMPLE_PROJECT_PATH}-copy`;
const NAME = SAMPLE_PROJECT_PATH.slice(SAMPLE_PROJECT_PATH.lastIndexOf("/") + 1);

const INVENTORY: readonly ProjectWorkContinuityMethod[] = ["project/work/identity", "project/work/relink"];

describe("the continuity inventory", () => {
  it("is exactly the two methods, all registered with the wire", () => {
    expect([...PROJECT_WORK_CONTINUITY_METHODS].sort()).toEqual([...INVENTORY].sort());
    for (const method of INVENTORY) {
      expect(Object.prototype.hasOwnProperty.call(clientParamsSchemas, method)).toBe(true);
      expect(PROJECT_WORK_CONTINUITY_METHOD_LIMITS[method]).toBeGreaterThan(0);
    }
  });

  it("round-trips one sample per method through the wire parser", () => {
    for (const method of INVENTORY) {
      const params = sampleContinuityMethodParams[method];
      const parsed = parseClientRequest({ jsonrpc: "2.0", id: 1, method, params });
      expect(parsed.method).toBe(method);
      expect(parsed.params).toEqual(projectWorkContinuityParamsSchemas[method].parse(params));
    }
  });

  it("reads identity without project authority and relinks with it", () => {
    // Reading what a folder is answers with ids and counts, so a phone may ask
    // it; moving a folder from one history to another is project authority.
    expect(methodPolicy("project/work/identity")).toEqual({ scope: "read", reach: "any" });
    expect(methodPolicy("project/work/relink")).toEqual({ scope: "project_write", reach: "any" });
  });

  it("makes the write carry confirm, the preview digest and an idempotency key", () => {
    for (const method of PROJECT_WORK_CONTINUITY_WRITE_METHODS) {
      const params = sampleContinuityMethodParams[method] as Record<string, unknown>;
      expect(params["confirm"]).toBe(true);
      expect(params["previewDigest"]).toBe(SAMPLE_DIGEST);
      for (const field of ["confirm", "previewDigest", "idempotencyKey", "choice", "projectId"]) {
        const { [field]: _dropped, ...without } = params;
        expect(projectWorkContinuityParamsSchemas[method].safeParse(without).success).toBe(false);
      }
      // `confirm: false` is not a quieter relink; it is not a relink at all.
      expect(projectWorkContinuityParamsSchemas[method].safeParse({ ...params, confirm: false }).success).toBe(false);
    }
  });

  it("refuses a field the table does not know and a choice it does not have", () => {
    expect(() =>
      parseClientRequest({ jsonrpc: "2.0", id: 1, method: "project/work/identity", params: { cwd: "/p", merge: true } }),
    ).toThrow(ProtocolError);
    expect(
      projectWorkContinuityParamsSchemas["project/work/relink"].safeParse({
        ...(sampleContinuityMethodParams["project/work/relink"] as Record<string, unknown>),
        choice: "merge",
      }).success,
    ).toBe(false);
  });

  it("closes the identity states and the choices", () => {
    expect([...PROJECT_IDENTITY_STATES]).toEqual(["linked", "unmarked", "conflict", "blocked"]);
    expect([...PROJECT_RELINK_CHOICES]).toEqual(["reconnect", "fresh"]);
  });
});

describe("the marker file", () => {
  it("lives in the project's own configuration directory, never the engine's", () => {
    expect(PROJECT_MARKER_PATH).toBe(`${PROJECT_DIR_NAME}/project.json`);
    expect(PROJECT_MARKER_PATH.startsWith(".pi")).toBe(false);
  });

  it("round-trips the id it carries and nothing else", () => {
    const text = projectMarkerJson(SAMPLE_PROJECT_ID);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseProjectMarker(text)).toEqual({ version: 1, projectId: SAMPLE_PROJECT_ID });
    expect(JSON.parse(text)).toEqual({ projectId: SAMPLE_PROJECT_ID, version: 1 });
  });

  it("keeps reading a marker a later release added a field to", () => {
    // A marker an older release cannot fully parse must still reconnect the
    // project: refusing the id would silently mint a second history.
    expect(parseProjectMarker(JSON.stringify({ version: 1, projectId: SAMPLE_PROJECT_ID, colour: "teal" }))).toEqual({
      version: 1,
      projectId: SAMPLE_PROJECT_ID,
    });
  });

  it("reads anything that is not a marker as absent", () => {
    expect(parseProjectMarker("")).toBeUndefined();
    expect(parseProjectMarker("not json")).toBeUndefined();
    expect(parseProjectMarker(JSON.stringify({ version: 2, projectId: SAMPLE_PROJECT_ID }))).toBeUndefined();
    expect(parseProjectMarker(JSON.stringify({ version: 1 }))).toBeUndefined();
    expect(parseProjectMarker(JSON.stringify({ version: 1, projectId: "../../etc/passwd" }))).toBeUndefined();
    expect(parseProjectMarker(JSON.stringify([SAMPLE_PROJECT_ID]))).toBeUndefined();
  });
});

describe("the results a client validates", () => {
  const side = { projectId: SAMPLE_PROJECT_ID, path: SAMPLE_PROJECT_PATH, name: NAME, pathExists: true, entities: 12 };

  it("accepts a conflict a person can act on", () => {
    const result = {
      cwd: COPY_PATH,
      projectId: "prj_other",
      state: "conflict" as const,
      here: { ...side, projectId: "prj_other", path: COPY_PATH, name: `${NAME}-copy`, entities: 0 },
      marked: side,
      marker: true,
      hidden: false,
      detail: "Another folder is already open as this project.",
      choices: ["reconnect" as const, "fresh" as const],
      previewDigest: SAMPLE_DIGEST,
    };
    expect(projectIdentityResultSchema.parse(result)).toEqual(result);
  });

  it("refuses a relink result that invents a third choice", () => {
    expect(
      projectRelinkResultSchema.safeParse({
        cwd: SAMPLE_PROJECT_PATH,
        projectId: SAMPLE_PROJECT_ID,
        choice: "merge",
        marker: true,
        detail: "x",
      }).success,
    ).toBe(false);
  });
});
