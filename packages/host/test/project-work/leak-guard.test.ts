/**
 * What the leap's artefacts must never carry (M21-T22, threat model §9).
 *
 * Three sentinels, each standing for something a person would be horrified to
 * find in a file they shared or a log they pasted:
 *
 * - a provider credential in this process's environment;
 * - a credential file beside the project, under the project's own configuration directory;
 * - the person's own words, in a body — which belong in the export and
 *   nowhere else, least of all in an audit row about who approved what.
 *
 * Everything the leap produces from a project is then made and read back:
 * every exported file and the manifest, every audit row the authority wrote,
 * every notification it broadcast, and the answers the read methods give.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_DIR_NAME, type ProjectWorkWriteResult, type WorkExportApplyResult, type WorkExportPreviewResult } from "@lasercode/protocol";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";

let h: ProjectWorkHarness;

/** A provider-shaped token, and never a real one. */
const ENV_SECRET = "sk-ant-api03-SENTINELenvSENTINELenvSENTINELenv";
const FILE_SECRET = "ghp_SENTINELfileSENTINELfileSENTINELfile01";
const BODY_SECRET = "the-persons-private-sentence-about-the-acquisition";

let restoreEnv: string | undefined;

beforeEach(() => {
  restoreEnv = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = ENV_SECRET;
});

afterEach(() => {
  if (restoreEnv === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = restoreEnv;
  h?.cleanup();
});

/** Every file under a directory, as text. */
function filesUnder(root: string): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  return found;
}

describe("nothing the leap produces carries a credential", () => {
  it("keeps the environment's and the project's credentials out of every export, log and notification", async () => {
    h = projectWorkHarness();
    mkdirSync(join(h.projectRoot, PROJECT_DIR_NAME), { recursive: true });
    writeFileSync(join(h.projectRoot, PROJECT_DIR_NAME, "auth.json"), JSON.stringify({ providers: { anthropic: { apiKey: FILE_SECRET } } }), "utf8");

    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Phone review",
        body: specBody(BODY_SECRET),
        note: `note: ${BODY_SECRET}`,
        idempotencyKey: "s1",
      }),
    );
    const task = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "task", title: "Sticky footer", body: taskBody(BODY_SECRET), idempotencyKey: "t1" }),
    );
    await h.call("project/work/comment", {
      projectId: h.projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.entity.currentRevisionId,
      revisionId: spec.entity.currentRevisionId,
      anchor: { target: "entity" },
      text: `comment: ${BODY_SECRET}`,
      idempotencyKey: "cm1",
    });
    await h.call("project/work/archive", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.entity.currentRevisionId,
      archived: true,
      idempotencyKey: "ar1",
    });

    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, includeArchived: true }));
    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        previewDigest: preview.previewDigest,
        includeArchived: true,
        confirm: true,
        idempotencyKey: "ex1",
      }),
    );
    expect(applied.files.length).toBeGreaterThan(0);

    const exported = filesUnder(join(h.projectRoot, applied.root));
    for (const file of exported) {
      expect(file.text, `${file.path} carries the environment's credential`).not.toContain(ENV_SECRET);
      expect(file.text, `${file.path} carries the project's credential file`).not.toContain(FILE_SECRET);
      expect(file.text).not.toMatch(/sk-ant-api03-|ghp_[A-Za-z0-9]{20,}/);
    }
    // The person's own words belong in the export: that is what an export is.
    expect(exported.some((file) => file.text.includes(BODY_SECRET))).toBe(true);
    // The export never copies the project's own configuration directory.
    expect(exported.some((file) => file.path.includes(join(PROJECT_DIR_NAME, "auth")))).toBe(false);

    // Audit rows: identity, keys, digests and counts — never a body, a title,
    // a note, or anything from this machine's configuration.
    const logs = JSON.stringify(h.logs);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(ENV_SECRET);
    expect(logs).not.toContain(FILE_SECRET);
    expect(logs).not.toContain(BODY_SECRET);

    // Notifications: a summary of what changed. No body content.
    const notifications = JSON.stringify(h.notifications);
    expect(notifications).not.toContain(ENV_SECRET);
    expect(notifications).not.toContain(FILE_SECRET);
    expect(notifications).not.toContain(BODY_SECRET);

    // And the read answers a phone would get carry the person's own work and
    // nothing from this machine.
    const reads = JSON.stringify([
      ok(await h.call("project/work/list", { projectId: h.projectId, includeArchived: true })),
      ok(await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, body: { mode: "full" } })),
      ok(await h.call("project/work/search", { projectId: h.projectId, query: "review" })),
    ]);
    expect(reads).not.toContain(ENV_SECRET);
    expect(reads).not.toContain(FILE_SECRET);
  });

  it("names a refused path in the refusal without reading anything behind it", async () => {
    h = projectWorkHarness();
    mkdirSync(join(h.projectRoot, PROJECT_DIR_NAME), { recursive: true });
    writeFileSync(join(h.projectRoot, PROJECT_DIR_NAME, "auth.json"), JSON.stringify({ apiKey: FILE_SECRET }), "utf8");
    // The project configuration directory is inside the project, so containment alone does not stop this:
    // what stops it is that an import adapter reads its own documented root
    // and answers with proposals, never with the bytes of a file it did not
    // understand.
    const response = await h.call("project/work/import/preview", { projectId: h.projectId, adapter: "markdown", path: PROJECT_DIR_NAME });
    const body = JSON.stringify(response.error ?? response.result);
    expect(body).not.toContain(FILE_SECRET);
  });

  it("refuses an export path that would leave the project, and writes nothing", async () => {
    h = projectWorkHarness();
    mkdirSync(h.projectRoot, { recursive: true });
    const before = readdirSync(h.projectRoot);
    expect(failed(await h.call("project/work/export/preview", { projectId: h.projectId, path: "../../escape" })).code).toBeDefined();
    expect(readdirSync(h.projectRoot)).toEqual(before);
  });
});
