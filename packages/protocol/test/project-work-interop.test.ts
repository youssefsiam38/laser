/**
 * M21-T21: the import/export/publish inventory.
 *
 * Six methods, each with a closed schema, a policy row, a byte limit and a
 * round-trip sample; an apply that cannot be made without `confirm` and the
 * digest of the preview it was decided from; a manifest schema that refuses a
 * future format and a path that leaves the export.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_WORK_INTEROP_METHODS,
  PROJECT_WORK_INTEROP_METHOD_LIMITS,
  PROJECT_WORK_INTEROP_WRITE_METHODS,
  WORK_EXPORT_MODES,
  WORK_IMPORT_ADAPTERS,
  WORK_IMPORT_CHOICES,
  projectWorkInteropParamsSchemas,
  projectWorkManifestSchema,
  type ProjectWorkInteropMethod,
} from "../src/project-work-interop.js";
import { clientParamsSchemas, parseClientRequest, ProtocolError } from "../src/schemas.js";
import { methodPolicy } from "../src/method-policy.js";
import { sampleInteropMethodParams, sampleManifest } from "./project-work-interop-samples.js";
import { SAMPLE_DIGEST, SAMPLE_PROJECT_ID } from "./project-work-samples.js";

const INVENTORY: readonly ProjectWorkInteropMethod[] = [
  "project/work/import/preview",
  "project/work/import/apply",
  "project/work/export/preview",
  "project/work/export/apply",
  "project/work/publish/preview",
  "project/work/publish/apply",
];

describe("the interop inventory", () => {
  it("is exactly the six methods, all registered with the wire", () => {
    expect([...PROJECT_WORK_INTEROP_METHODS].sort()).toEqual([...INVENTORY].sort());
    for (const method of INVENTORY) {
      expect(Object.prototype.hasOwnProperty.call(clientParamsSchemas, method)).toBe(true);
      expect(PROJECT_WORK_INTEROP_METHOD_LIMITS[method]).toBeGreaterThan(0);
    }
  });

  it("round-trips one sample per method through the wire parser", () => {
    for (const method of INVENTORY) {
      const params = sampleInteropMethodParams[method];
      const parsed = parseClientRequest({ jsonrpc: "2.0", id: 1, method, params });
      expect(parsed.method).toBe(method);
      expect(parsed.params).toEqual(projectWorkInteropParamsSchemas[method].parse(params));
    }
  });

  it("gives every method the project_write scope and any reach", () => {
    for (const method of INVENTORY) {
      expect(methodPolicy(method)).toEqual({ scope: "project_write", reach: "any" });
    }
  });

  it("refuses a field the table does not know", () => {
    expect(() =>
      parseClientRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "project/work/export/preview",
        params: { projectId: SAMPLE_PROJECT_ID, watch: true },
      }),
    ).toThrow(ProtocolError);
  });

  it("makes every write carry confirm, a preview digest and an idempotency key", () => {
    for (const method of PROJECT_WORK_INTEROP_WRITE_METHODS) {
      const params = sampleInteropMethodParams[method] as Record<string, unknown>;
      expect(params["confirm"]).toBe(true);
      expect(params["previewDigest"]).toBe(SAMPLE_DIGEST);
      expect(params["idempotencyKey"]).toBeTypeOf("string");
      for (const field of ["confirm", "previewDigest", "idempotencyKey"]) {
        const { [field]: _dropped, ...without } = params;
        expect(projectWorkInteropParamsSchemas[method].safeParse(without).success).toBe(false);
      }
      // `confirm: false` is not a quieter apply; it is not an apply at all.
      expect(projectWorkInteropParamsSchemas[method].safeParse({ ...params, confirm: false }).success).toBe(false);
    }
  });

  it("refuses a path that leaves the project", () => {
    const schema = projectWorkInteropParamsSchemas["project/work/export/preview"];
    expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, path: "docs/work" }).success).toBe(true);
    expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, path: "../elsewhere" }).success).toBe(false);
    expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, path: "docs/../../etc" }).success).toBe(false);
    expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, path: "/etc/passwd" }).success).toBe(false);
    expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, path: "C:\\Windows" }).success).toBe(false);
  });

  it("takes a git object id or HEAD when publishing, and nothing else", () => {
    const schema = projectWorkInteropParamsSchemas["project/work/publish/apply"];
    const base = { projectId: SAMPLE_PROJECT_ID, previewDigest: SAMPLE_DIGEST, confirm: true, idempotencyKey: "p1" };
    expect(schema.safeParse({ ...base, commit: "HEAD" }).success).toBe(true);
    expect(schema.safeParse({ ...base, commit: "9".repeat(40) }).success).toBe(true);
    expect(schema.safeParse({ ...base, commit: "main" }).success).toBe(false);
    expect(schema.safeParse({ ...base, commit: "HEAD", checkpointId: "ckpt_1" }).success).toBe(true);
  });

  it("names an adapter from the closed list, and no tracker yet", () => {
    const schema = projectWorkInteropParamsSchemas["project/work/import/preview"];
    for (const adapter of WORK_IMPORT_ADAPTERS) {
      expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, adapter }).success).toBe(true);
    }
    // `ExternalWorkLink` is M25's contract, not an import adapter (yet).
    expect(schema.safeParse({ projectId: SAMPLE_PROJECT_ID, adapter: "jira" }).success).toBe(false);
    expect(WORK_IMPORT_ADAPTERS).not.toContain("jira");
  });

  it("offers exactly the three import choices and the two export modes", () => {
    expect([...WORK_IMPORT_CHOICES]).toEqual(["new_revision", "new_entity", "skip"]);
    expect([...WORK_EXPORT_MODES]).toEqual(["replace", "new_revision"]);
  });
});

describe("the manifest", () => {
  it("parses a manifest with one of everything", () => {
    expect(projectWorkManifestSchema.parse(sampleManifest)).toEqual(sampleManifest);
  });

  it("refuses another format, another version and an unknown field", () => {
    expect(projectWorkManifestSchema.safeParse({ ...sampleManifest, format: "something-else" }).success).toBe(false);
    expect(projectWorkManifestSchema.safeParse({ ...sampleManifest, version: 2 }).success).toBe(false);
    expect(projectWorkManifestSchema.safeParse({ ...sampleManifest, exportedAt: "2026-01-01T00:00:00.000Z" }).success).toBe(false);
  });

  it("refuses a document path that climbs out of the export", () => {
    const escaping = {
      ...sampleManifest,
      entities: [{ ...sampleManifest.entities[0]!, document: "../../etc/passwd" }],
    };
    expect(projectWorkManifestSchema.safeParse(escaping).success).toBe(false);
  });

  it("keeps `published_as` pointing at a state and a path", () => {
    const parsed = projectWorkManifestSchema.parse(sampleManifest);
    const link = parsed.repositoryLinks[0]!;
    expect(link.relation).toBe("published_as");
    expect(link.publishedPath).toBe("docs/work/SPEC-1.md");
    expect("state" in link.target).toBe(true);
  });
});
