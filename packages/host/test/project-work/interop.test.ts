/**
 * M21-T21: import, export and publication, over the wire.
 *
 * Everything goes through `Router.handle` with a real JSON-RPC envelope, over
 * the harness whose worker pool throws on every way of reaching a worker — so
 * "an adapter reads the project's files, an export writes them and publication
 * reads git, all without starting a worker" is proved rather than asserted.
 *
 * Publication runs against a real temporary git repository: a commit that does
 * not carry the exported bytes must be refused, and the `published_as` that is
 * finally recorded must name the exact commit, path and blob.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ErrorCodes,
  PROJECT_DIR_NAME,
  WORK_EXPORT_DIR,
  checkpointRef,
  projectWorkManifestSchema,
  type ProjectWorkGetResult,
  type ProjectWorkListResult,
  type ProjectWorkManifest,
  type ProjectWorkWriteResult,
  type WorkExportApplyResult,
  type WorkExportPreviewResult,
  type WorkImportApplyResult,
  type WorkImportPreviewResult,
  type WorkPublishApplyResult,
  type WorkPublishPreviewResult,
} from "@lasercode/protocol";

import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { planBody, specBody, taskBody } from "./fixtures.js";
import { writeFile, writeFrontMatterMarkdown, writeOpenSpec, writePlanMd, writeSpecKit } from "./interop-fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

const EXPORT_ROOT = `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`;

function harnessWithProjectFolder(): ProjectWorkHarness {
  const harness = projectWorkHarness();
  mkdirSync(harness.projectRoot, { recursive: true });
  return harness;
}

async function importPreview(harness: ProjectWorkHarness, adapter: string, path?: string): Promise<WorkImportPreviewResult> {
  return ok<WorkImportPreviewResult>(
    await harness.call("project/work/import/preview", { projectId: harness.projectId, adapter, ...(path ? { path } : {}) }),
  );
}

async function importApply(
  harness: ProjectWorkHarness,
  adapter: string,
  preview: WorkImportPreviewResult,
  options: { key: string; path?: string; decisions?: Array<{ sourceId: string; choice: string }> },
): Promise<WorkImportApplyResult> {
  return ok<WorkImportApplyResult>(
    await harness.call("project/work/import/apply", {
      projectId: harness.projectId,
      adapter,
      ...(options.path ? { path: options.path } : {}),
      previewDigest: preview.previewDigest,
      confirm: true,
      ...(options.decisions ? { decisions: options.decisions } : {}),
      idempotencyKey: options.key,
    }),
  );
}

async function exportOnce(harness: ProjectWorkHarness, options: { key: string; mode?: string } = { key: "x1" }): Promise<WorkExportApplyResult> {
  const preview = ok<WorkExportPreviewResult>(
    await harness.call("project/work/export/preview", { projectId: harness.projectId, ...(options.mode ? { mode: options.mode } : {}) }),
  );
  return ok<WorkExportApplyResult>(
    await harness.call("project/work/export/apply", {
      projectId: harness.projectId,
      ...(options.mode ? { mode: options.mode } : {}),
      previewDigest: preview.previewDigest,
      confirm: true,
      idempotencyKey: options.key,
    }),
  );
}

async function create(harness: ProjectWorkHarness, kind: "spec" | "plan" | "task", title: string, key: string): Promise<ProjectWorkWriteResult> {
  const body = kind === "spec" ? specBody() : kind === "plan" ? planBody() : taskBody();
  return ok<ProjectWorkWriteResult>(
    await harness.call("project/work/create", { projectId: harness.projectId, kind, title, body, idempotencyKey: key }),
  );
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env },
  }).trim();
}

/**
 * A checkpoint, the way the worker makes one: the whole working tree written
 * to a temporary index, that tree committed, and the commit put under the
 * checkpoint ref namespace. Nothing here is a product code path — it is the
 * fixture that lets publication be tested against a checkpoint that really
 * holds bytes, rather than against a string.
 */
function writeCheckpoint(harness: ProjectWorkHarness, sessionKey: string, turn: number): { ref: string; commit: string } {
  const indexFile = join(harness.dir, `checkpoint-index-${sessionKey}-${String(turn)}`);
  const environment = { GIT_INDEX_FILE: indexFile };
  git(harness.projectRoot, ["read-tree", "HEAD"], environment);
  git(harness.projectRoot, ["add", "-A"], environment);
  const tree = git(harness.projectRoot, ["write-tree"], environment);
  const parent = git(harness.projectRoot, ["rev-parse", "HEAD"]);
  const commit = git(harness.projectRoot, ["commit-tree", tree, "-p", parent, "-m", `checkpoint ${String(turn)}`]);
  const ref = checkpointRef(sessionKey, turn);
  git(harness.projectRoot, ["update-ref", ref, commit]);
  return { ref, commit };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("import adapters", () => {
  it("reads a Spec Kit feature into a Spec, a Plan and one Task per checklist line, and writes nothing until confirmed", async () => {
    h = harnessWithProjectFolder();
    writeSpecKit(h.projectRoot);

    const preview = await importPreview(h, "spec_kit");
    expect(preview.root).toBe("specs");
    expect(preview.watches).toBe(false);
    // File order, and therefore proposal order, is the sorted path: the same
    // tree always previews the same way, whatever order the filesystem
    // happened to hand its entries back in.
    expect(preview.proposals.map((proposal) => proposal.kind)).toEqual(["plan", "spec", "task", "task", "task"]);
    expect(preview.creates).toBe(5);
    expect(preview.conflicts).toBe(0);

    const spec = preview.proposals.find((proposal) => proposal.kind === "spec")!;
    expect(spec.title).toBe("Phone review");
    expect(spec.source.path).toBe("specs/001-phone-review/spec.md");
    expect(spec.source.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.source.adapter).toBe("spec_kit");
    // The tree declares MIT, and that travels with the import.
    expect(spec.source.licence).toBe("permissive");
    expect(spec.source.licenceName).toBe("MIT License");
    expect(spec.source.externalId).toBe("001-phone-review");

    // The preview wrote nothing at all.
    const before = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(before.items).toHaveLength(0);

    // An apply without the typed confirmation is refused at the boundary.
    const unconfirmed = failed(
      await h.call("project/work/import/apply", {
        projectId: h.projectId,
        adapter: "spec_kit",
        previewDigest: preview.previewDigest,
        idempotencyKey: "i0",
      }),
    );
    expect(unconfirmed.code).toBe(ErrorCodes.InvalidParams);

    const applied = await importApply(h, "spec_kit", preview, { key: "i1" });
    expect(applied.created).toBe(5);
    expect(applied.watches).toBe(false);
    expect(applied.applied.every((row) => row.action === "created")).toBe(true);

    const after = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(after.items).toHaveLength(5);
    expect(h.workerAttempts()).toBe(0);
  });

  it("records where each imported revision came from, with the digest and the licence", async () => {
    h = harnessWithProjectFolder();
    writeSpecKit(h.projectRoot);
    const preview = await importPreview(h, "spec_kit");
    const applied = await importApply(h, "spec_kit", preview, { key: "i1" });
    const specRow = applied.applied.find((row) => row.key?.startsWith("SPEC-"))!;

    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: specRow.entityId }));
    expect(detail.revision.note).toBe("Imported from specs/001-phone-review/spec.md (spec_kit).");
    const provenance = detail.evidence.find((record) => record.kind === "source_location")!;
    expect(provenance.summary).toContain("Imported from specs/001-phone-review/spec.md by the spec_kit adapter.");
    expect(provenance.detail).toContain(`digest: ${specRow.source.digest}`);
    expect(provenance.detail).toContain("licence: MIT License");
    expect(provenance.role).toBe("supporting");

    // The requirements the source numbered survive with their level.
    const body = detail.body?.body;
    expect(body?.kind).toBe("spec");
    if (body?.kind === "spec") {
      expect(body.spec.requirements.map((requirement) => requirement.level)).toEqual(["must", "should"]);
      expect(body.spec.requirements[0]?.id).toBe("fr-001");
      expect(body.spec.outcomes).toEqual(["A gate can be approved at 320px."]);
      expect(body.spec.nonGoals).toEqual(["Editing the canvas on a phone."]);
      // Nothing the parser did not understand is lost.
      expect(body.spec.document).toContain("## Technical Context".slice(0, 3));
    }
  });

  it("never watches the source: editing it after an import changes nothing", async () => {
    h = harnessWithProjectFolder();
    writeSpecKit(h.projectRoot);
    const preview = await importPreview(h, "spec_kit");
    const applied = await importApply(h, "spec_kit", preview, { key: "i1" });
    const specRow = applied.applied.find((row) => row.key?.startsWith("SPEC-"))!;
    const before = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: specRow.entityId }));
    const events = h.notifications.length;

    writeFile(h.projectRoot, "specs/001-phone-review/spec.md", "# Rewritten\n\nSomething else entirely.\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.notifications.length).toBe(events);
    const after = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: specRow.entityId }));
    expect(after.revision.revisionId).toBe(before.revision.revisionId);
    expect(after.revision.digest).toBe(before.revision.digest);

    // And the next preview refuses the digest the person confirmed before.
    const stale = failed(
      await h.call("project/work/import/apply", {
        projectId: h.projectId,
        adapter: "spec_kit",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "i2",
      }),
    );
    expect(stale.message).toContain("Preview the import again");
  });

  it("offers new revision, new item or skip when something is already there, and refuses an apply that decided nothing", async () => {
    h = harnessWithProjectFolder();
    writeSpecKit(h.projectRoot);
    await importApply(h, "spec_kit", await importPreview(h, "spec_kit"), { key: "i1" });

    const second = await importPreview(h, "spec_kit");
    expect(second.conflicts).toBe(5);
    const spec = second.proposals.find((proposal) => proposal.kind === "spec")!;
    expect(spec.action).toBe("decide");
    expect(spec.conflict).toEqual({ reason: "title", choices: ["new_revision", "new_entity", "skip"] });
    expect(spec.match?.key).toMatch(/^SPEC-/);

    const undecided = failed(
      await h.call("project/work/import/apply", {
        projectId: h.projectId,
        adapter: "spec_kit",
        previewDigest: second.previewDigest,
        confirm: true,
        idempotencyKey: "i2",
      }),
    );
    expect(undecided.message).toContain("already exist in this project");

    const decided = await importApply(h, "spec_kit", second, {
      key: "i3",
      decisions: second.proposals.map((proposal) => ({
        sourceId: proposal.sourceId,
        choice: proposal.sourceId === spec.sourceId ? "new_revision" : "skip",
      })),
    });
    expect(decided.revised).toBe(1);
    expect(decided.skipped).toBe(4);

    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items).toHaveLength(5);
    const revisedSpec = list.items.find((item) => item.kind === "spec")!;
    expect(revisedSpec.revisionCount).toBe(2);
  });

  it("refuses an apply when the work a proposal would revise gained a revision after the preview", async () => {
    h = harnessWithProjectFolder();
    writeSpecKit(h.projectRoot);
    await importApply(h, "spec_kit", await importPreview(h, "spec_kit"), { key: "i1" });

    const second = await importPreview(h, "spec_kit");
    const conflicted = second.proposals.find((proposal) => proposal.kind === "spec")!;
    const decisions = second.proposals.map((proposal) => ({
      sourceId: proposal.sourceId,
      choice: proposal.sourceId === conflicted.sourceId ? "new_revision" : "skip",
    }));

    // The item that proposal would land on is revised in the app, in between.
    // The files did not change; the work the person read did.
    const existing = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items.find(
      (item) => item.ref.entityId === conflicted.match!.entityId,
    )!;
    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: existing.ref.entityId,
        expectedRevisionId: existing.ref.revisionId,
        body: specBody("Someone else wrote this while that preview was open."),
        idempotencyKey: "r1",
      }),
    );

    const refusal = failed(
      await h.call("project/work/import/apply", {
        projectId: h.projectId,
        adapter: "spec_kit",
        previewDigest: second.previewDigest,
        confirm: true,
        decisions,
        idempotencyKey: "i2",
      }),
    );
    expect(refusal.message).toContain("Preview the import again");

    // Nothing was written: the revised item still has exactly its two revisions.
    const after = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items.find(
      (item) => item.ref.entityId === existing.ref.entityId,
    )!;
    expect(after.revisionCount).toBe(2);

    // A fresh preview of the same files applies, against the revision that is
    // there now.
    const third = await importPreview(h, "spec_kit");
    const applied = await importApply(h, "spec_kit", third, {
      key: "i3",
      decisions: third.proposals.map((proposal) => ({
        sourceId: proposal.sourceId,
        choice: proposal.match?.entityId === existing.ref.entityId ? "new_revision" : "skip",
      })),
    });
    expect(applied.revised).toBe(1);
  });

  it("reads OpenSpec capabilities, proposals, designs and task lists", async () => {
    h = harnessWithProjectFolder();
    writeOpenSpec(h.projectRoot);

    const preview = await importPreview(h, "openspec");
    const kinds = preview.proposals.map((proposal) => `${proposal.kind}:${proposal.title}`);
    expect(kinds).toContain("spec:Review");
    expect(kinds).toContain("spec:Add phone review");
    expect(kinds).toContain("plan:Phone review approach");
    expect(preview.proposals.filter((proposal) => proposal.kind === "task")).toHaveLength(2);

    const applied = await importApply(h, "openspec", preview, { key: "o1" });
    expect(applied.created).toBe(preview.proposals.length);

    const capability = applied.applied.find((row) => row.source.externalId === "review")!;
    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: capability.entityId }));
    const body = detail.body?.body;
    if (body?.kind === "spec") {
      expect(body.spec.requirements.map((requirement) => requirement.text)).toEqual([
        "A gate records who decided it",
        "An agent never approves",
      ]);
      expect(body.spec.requirements.every((requirement) => requirement.level === "must")).toBe(true);
      expect(body.spec.acceptance[0]?.text).toContain("Approving a brief gate");
      expect(body.spec.brief).toContain("Reviewing is how a person decides");
    }
  });

  it("reads an existing PLAN.md into a Plan per milestone and a Task per row", async () => {
    h = harnessWithProjectFolder();
    writePlanMd(h.projectRoot);

    const preview = await importPreview(h, "plan_md");
    expect(preview.root).toBe("PLAN.md");
    expect(preview.proposals.filter((proposal) => proposal.kind === "plan").map((proposal) => proposal.title)).toEqual([
      "M40 · Phone review",
      "M41 · Offline review",
    ]);
    const tasks = preview.proposals.filter((proposal) => proposal.kind === "task");
    expect(tasks.map((task) => task.title)).toEqual(["Sticky review footer", "Gate decision above the fold", "Cache the open gates"]);
    expect(tasks[0]?.source.externalId).toBe("M40-T1");

    const applied = await importApply(h, "plan_md", preview, { key: "p1" });
    const first = applied.applied.find((row) => row.source.externalId === "M40-T1")!;
    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: first.entityId }));
    const body = detail.body?.body;
    if (body?.kind === "task") {
      expect(body.task.outcome).toBe("the footer is reachable with one thumb at 320px");
      // The source's own ids are kept as a note; they are not keys this
      // project minted, and a graph made of them would be refused.
      expect(body.task.notes).toContain("Depends on: M39-T2");
      expect(body.task.dependencies).toEqual([]);
    }
  });

  it("reads plain Markdown that declares what it is, and names what it skipped", async () => {
    h = harnessWithProjectFolder();
    writeFrontMatterMarkdown(h.projectRoot);

    const preview = await importPreview(h, "markdown");
    expect(preview.proposals.map((proposal) => `${proposal.kind}:${proposal.title}`)).toEqual([
      "spec:Phone review, end to end",
      "task:Sticky footer",
    ]);
    expect(preview.proposals[0]?.source.licence).toBe("permissive");
    expect(preview.proposals[0]?.source.licenceName).toBe("Apache-2.0");
    expect(preview.skipped).toEqual([{ path: "docs/readme.md", reason: "no front matter saying what it is" }]);

    const applied = await importApply(h, "markdown", preview, { key: "m1" });
    expect(applied.created).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("export", () => {
  it("writes deterministic documents, exact bodies and a manifest with no timestamps", async () => {
    h = harnessWithProjectFolder();
    const spec = await create(h, "spec", "Phone review", "c1");
    const task = await create(h, "task", "Sticky footer", "c2");
    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "edge",
          relation: "implements",
          subject: { entityId: task.entity.entityId, revisionId: task.revision.revisionId },
          object: { entityId: spec.entity.entityId, revisionId: spec.revision.revisionId },
        },
        idempotencyKey: "l1",
      }),
    );

    const first = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId }));
    const second = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId }));
    // Deterministic: the same work previews to the same digest and the same files.
    expect(second.previewDigest).toBe(first.previewDigest);
    expect(second.files).toEqual(first.files);
    expect(first.root).toBe(EXPORT_ROOT);
    expect(first.entities).toBe(2);
    expect(first.files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "SPEC-1.md",
      "TASK-1.md",
      "bodies/SPEC-1.json",
      "bodies/TASK-1.json",
      "manifest.json",
    ]);
    expect(first.existing).toBeUndefined();

    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        previewDigest: first.previewDigest,
        confirm: true,
        idempotencyKey: "e1",
      }),
    );
    expect(applied.files).toHaveLength(6);
    expect(applied.removed).toEqual([]);

    const manifestText = readFileSync(join(h.projectRoot, EXPORT_ROOT, "manifest.json"), "utf8");
    const manifest = projectWorkManifestSchema.parse(JSON.parse(manifestText));
    expect(manifest.entities.map((entity) => entity.key)).toEqual(["SPEC-1", "TASK-1"]);
    expect(manifest.relations).toEqual([
      {
        relation: "implements",
        subject: { entityId: task.entity.entityId, key: "TASK-1", revisionId: task.revision.revisionId },
        object: { entityId: spec.entity.entityId, key: "SPEC-1", revisionId: spec.revision.revisionId },
      },
    ]);
    // Nothing in the manifest is a timestamp: an export of unchanged work is
    // the same bytes, which is what makes a re-export a readable diff.
    expect(manifestText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    const document = readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md"), "utf8");
    expect(document).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(document.startsWith("---\nkey: \"SPEC-1\"\n")).toBe(true);
    expect(document).toContain("# SPEC-1 · Phone review");
    expect(document).toContain("## Requirements\n\n- **must** The review footer is reachable with one thumb.");

    const audit = h.logs.find((row) => row.kind === "project_work_exported")!;
    expect(audit.summary).toContain("exported 2 item(s)");
    expect(JSON.stringify(audit.detail)).not.toContain("Phone review");
    expect(h.workerAttempts()).toBe(0);
  });

  it("makes a re-export an explicit replace or new-revision decision", async () => {
    h = harnessWithProjectFolder();
    await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });

    const second = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId }));
    expect(second.existing?.unchanged).toBe(true);
    expect(second.decide).toEqual({ reason: "existing_export", choices: ["replace", "new_revision"] });

    const undecided = failed(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        previewDigest: second.previewDigest,
        confirm: true,
        idempotencyKey: "e2",
      }),
    );
    expect(undecided.message).toContain("Choose whether to replace it");

    const beside = await exportOnce(h, { key: "e3", mode: "new_revision" });
    expect(beside.root).toBe(`${EXPORT_ROOT}-2`);
    expect(readFileSync(join(h.projectRoot, `${EXPORT_ROOT}-2`, "SPEC-1.md"), "utf8")).toBe(
      readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md"), "utf8"),
    );

    // Replacing removes the documents of work the export no longer has.
    const spec = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items[0]!;
    ok(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: spec.ref.entityId,
        expectedRevisionId: spec.ref.revisionId,
        confirm: true,
        idempotencyKey: "d1",
      }),
    );
    const replaced = await exportOnce(h, { key: "e4", mode: "replace" });
    expect(replaced.removed).toEqual(["SPEC-1.md", "bodies/SPEC-1.json"]);
    expect(() => readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md"), "utf8")).toThrow();
  });

  it("deletes only leftovers a valid manifest proves this export wrote, and keeps a changed body and its document", async () => {
    h = harnessWithProjectFolder();
    await create(h, "spec", "Phone review", "c1");
    await create(h, "spec", "Sticky footer", "c2");
    await exportOnce(h, { key: "e1" });

    // Both items leave the project, so both exports' files are leftovers — and
    // then a person edits one of the two bodies in the folder.
    for (const item of ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items) {
      ok(
        await h.call("project/work/delete", {
          projectId: h.projectId,
          entityId: item.ref.entityId,
          expectedRevisionId: item.ref.revisionId,
          confirm: true,
          idempotencyKey: `d-${item.key}`,
        }),
      );
    }
    const editedBody = join(h.projectRoot, EXPORT_ROOT, "bodies", "SPEC-2.json");
    const edited = JSON.parse(readFileSync(editedBody, "utf8")) as { spec: { brief: string } };
    edited.spec.brief = "I rewrote this in the folder myself.";
    const mine = `${JSON.stringify(edited, null, 2)}\n`;
    writeFileSync(editedBody, mine);

    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, mode: "replace" }));
    expect(preview.removes).toEqual(["SPEC-1.md", "bodies/SPEC-1.json"]);
    expect(preview.preserved).toEqual([
      { path: "SPEC-2.md", reason: "changed" },
      { path: "bodies/SPEC-2.json", reason: "changed" },
    ]);

    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        mode: "replace",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "e2",
      }),
    );
    expect(applied.removed).toEqual(["SPEC-1.md", "bodies/SPEC-1.json"]);
    expect(() => readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md"), "utf8")).toThrow();
    // The changed body, and the document beside it, are exactly as they were.
    expect(readFileSync(editedBody, "utf8")).toBe(mine);
    expect(readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-2.md"), "utf8")).toContain("Sticky footer");
  });

  it("keeps a document a person edited in the folder, and refuses an apply when one is edited after the preview", async () => {
    h = harnessWithProjectFolder();
    await create(h, "spec", "Phone review", "c1");
    await create(h, "spec", "Sticky footer", "c2");
    await exportOnce(h, { key: "e1" });
    for (const item of ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items) {
      ok(
        await h.call("project/work/delete", {
          projectId: h.projectId,
          entityId: item.ref.entityId,
          expectedRevisionId: item.ref.revisionId,
          confirm: true,
          idempotencyKey: `d-${item.key}`,
        }),
      );
    }

    // The body is untouched; only the readable document was edited. The body's
    // digest alone would have called this pair a leftover.
    const document = join(h.projectRoot, EXPORT_ROOT, "SPEC-2.md");
    const mine = `${readFileSync(document, "utf8")}\nA note I typed into the copy.\n`;
    writeFileSync(document, mine);

    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, mode: "replace" }));
    expect(preview.removes).toEqual(["SPEC-1.md", "bodies/SPEC-1.json"]);
    expect(preview.preserved).toEqual([
      { path: "SPEC-2.md", reason: "changed" },
      { path: "bodies/SPEC-2.json", reason: "changed" },
    ]);

    // A document edited between the preview and the press changes the proof, so
    // the confirmation is spent rather than honoured.
    const other = join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md");
    writeFileSync(other, `${readFileSync(other, "utf8")}\nEdited while the dialog was open.\n`);
    const refusal = failed(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        mode: "replace",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "e2",
      }),
    );
    expect(refusal.message).toContain("Preview the export again");
    expect(readFileSync(other, "utf8")).toContain("Edited while the dialog was open.");

    // Previewing again keeps both edited documents and their bodies.
    const again = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, mode: "replace" }));
    expect(again.removes).toEqual([]);
    expect(again.preserved?.map((entry) => entry.path)).toEqual(["SPEC-1.md", "SPEC-2.md", "bodies/SPEC-1.json", "bodies/SPEC-2.json"]);
    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        mode: "replace",
        previewDigest: again.previewDigest,
        confirm: true,
        idempotencyKey: "e3",
      }),
    );
    expect(applied.removed).toEqual([]);
    expect(readFileSync(document, "utf8")).toBe(mine);
  });

  it("keeps an export written before documents were proved, rather than assuming it wrote those files", async () => {
    h = harnessWithProjectFolder();
    const spec = await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    ok(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        confirm: true,
        idempotencyKey: "d1",
      }),
    );

    // A manifest exactly as an earlier version of this product wrote one: every
    // row valid, no document digest anywhere.
    const manifestPath = join(h.projectRoot, EXPORT_ROOT, "manifest.json");
    const manifest = projectWorkManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    expect(manifest.entities[0]?.documentDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const entity of manifest.entities) delete entity.documentDigest;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, mode: "replace" }));
    expect(preview.removes).toEqual([]);
    expect(preview.preserved).toEqual([
      { path: "SPEC-1.md", reason: "unproven" },
      { path: "bodies/SPEC-1.json", reason: "unproven" },
    ]);

    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        mode: "replace",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "e2",
      }),
    );
    expect(applied.removed).toEqual([]);
    expect(readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md"), "utf8")).toContain("Phone review");
  });

  it("deletes nothing when the manifest in that folder is not one this app wrote, and says so", async () => {
    h = harnessWithProjectFolder();
    const spec = await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    ok(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        confirm: true,
        idempotencyKey: "d1",
      }),
    );

    // A manifest anyone could have written: valid JSON, not a manifest of ours.
    const manifestPath = join(h.projectRoot, EXPORT_ROOT, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify({ format: "project-work", version: 1, entities: [{ document: "SPEC-1.md" }] }, null, 2)}\n`);

    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, mode: "replace" }));
    expect(preview.removes).toEqual([]);
    expect(preview.removeRefusal).toContain("not one this app wrote");

    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        mode: "replace",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "e2",
      }),
    );
    expect(applied.removed).toEqual([]);
    expect(readFileSync(join(h.projectRoot, EXPORT_ROOT, "SPEC-1.md"), "utf8")).toContain("Phone review");
    expect(readFileSync(join(h.projectRoot, EXPORT_ROOT, "bodies", "SPEC-1.json"), "utf8")).toContain("spec");
  });

  it("keeps a file a manifest names outside this export's own layout, rather than deleting what it points at", async () => {
    h = harnessWithProjectFolder();
    const spec = await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    ok(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        confirm: true,
        idempotencyKey: "d1",
      }),
    );

    // A schema-valid manifest, edited to name a different file for that item.
    // A path inside the export is not a licence to delete it: only the layout
    // an export of this product writes for that identity is.
    const manifestPath = join(h.projectRoot, EXPORT_ROOT, "manifest.json");
    const manifest = projectWorkManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    manifest.entities[0]!.document = "notes/keep-me.md";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(join(h.projectRoot, EXPORT_ROOT, "notes"), { recursive: true });
    writeFileSync(join(h.projectRoot, EXPORT_ROOT, "notes", "keep-me.md"), "my own notes\n");

    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId, mode: "replace" }));
    expect(preview.removes).toEqual([]);
    expect(preview.preserved).toEqual([
      { path: "bodies/SPEC-1.json", reason: "not_this_export" },
      { path: "notes/keep-me.md", reason: "not_this_export" },
    ]);

    const applied = ok<WorkExportApplyResult>(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        mode: "replace",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "e2",
      }),
    );
    expect(applied.removed).toEqual([]);
    expect(readFileSync(join(h.projectRoot, EXPORT_ROOT, "notes", "keep-me.md"), "utf8")).toBe("my own notes\n");
  });

  it("refuses an apply whose preview is no longer what would be written", async () => {
    h = harnessWithProjectFolder();
    await create(h, "spec", "Phone review", "c1");
    const preview = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: h.projectId }));
    await create(h, "task", "Sticky footer", "c2");

    const refusal = failed(
      await h.call("project/work/export/apply", {
        projectId: h.projectId,
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "e1",
      }),
    );
    expect(refusal.message).toContain("Preview the export again");
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe("a second import of the same export", () => {
  it("round-trips byte-identically into another project", async () => {
    h = harnessWithProjectFolder();
    const spec = await create(h, "spec", "Phone review", "c1");
    const task = await create(h, "task", "Sticky footer", "c2");
    await create(h, "plan", "Ship phone review", "c3");
    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "edge",
          relation: "implements",
          subject: { entityId: task.entity.entityId, revisionId: task.revision.revisionId },
          object: { entityId: spec.entity.entityId, revisionId: spec.revision.revisionId },
        },
        idempotencyKey: "l1",
      }),
    );
    await exportOnce(h, { key: "e1" });

    // A second project, on this machine, with the export copied into it.
    const otherRoot = join(h.dir, "beta");
    mkdirSync(otherRoot, { recursive: true });
    const otherId = h.store.projectIdFor(otherRoot)!;
    cpSync(join(h.projectRoot, EXPORT_ROOT), join(otherRoot, "incoming"), { recursive: true });

    const preview = ok<WorkImportPreviewResult>(
      await h.call("project/work/import/preview", { projectId: otherId, adapter: "work_export", path: "incoming" }),
    );
    expect(preview.proposals.map((proposal) => proposal.kind)).toEqual(["plan", "spec", "task"]);
    expect(preview.proposals.every((proposal) => proposal.action === "create")).toBe(true);

    const applied = ok<WorkImportApplyResult>(
      await h.call("project/work/import/apply", {
        projectId: otherId,
        adapter: "work_export",
        path: "incoming",
        previewDigest: preview.previewDigest,
        confirm: true,
        idempotencyKey: "r1",
      }),
    );
    expect(applied.created).toBe(3);
    expect(applied.relations).toBe(1);

    const exported = ok<WorkExportPreviewResult>(await h.call("project/work/export/preview", { projectId: otherId }));
    ok(
      await h.call("project/work/export/apply", {
        projectId: otherId,
        previewDigest: exported.previewDigest,
        confirm: true,
        idempotencyKey: "r2",
      }),
    );

    // Every document and every body is byte-for-byte what the first export
    // wrote. The manifest differs only in the ids each store minted.
    for (const name of ["SPEC-1.md", "TASK-1.md", "PLAN-1.md", "bodies/SPEC-1.json", "bodies/TASK-1.json", "bodies/PLAN-1.json", "README.md"]) {
      expect(readFileSync(join(otherRoot, EXPORT_ROOT, name), "utf8")).toBe(readFileSync(join(h.projectRoot, EXPORT_ROOT, name), "utf8"));
    }
    const read = (root: string): ProjectWorkManifest =>
      JSON.parse(readFileSync(join(root, EXPORT_ROOT, "manifest.json"), "utf8")) as ProjectWorkManifest;
    const strip = (manifest: ProjectWorkManifest) => ({
      entities: manifest.entities.map(({ entityId: _id, revisionId: _revision, ...rest }) => rest),
      relations: manifest.relations.map((relation) => [relation.relation, relation.subject.key, relation.object.key]),
      attachments: manifest.attachments,
      format: manifest.format,
      version: manifest.version,
    });
    expect(strip(read(otherRoot))).toEqual(strip(read(h.projectRoot)));
  });

  it("refuses an exported body that was edited by hand, and names it", async () => {
    h = harnessWithProjectFolder();
    await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    const bodyPath = join(h.projectRoot, EXPORT_ROOT, "bodies", "SPEC-1.json");
    const body = JSON.parse(readFileSync(bodyPath, "utf8")) as { spec: { brief: string } };
    body.spec.brief = "Something a person typed into the copy.";
    writeFileSync(bodyPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");

    const otherRoot = join(h.dir, "gamma");
    mkdirSync(otherRoot, { recursive: true });
    const otherId = h.store.projectIdFor(otherRoot)!;
    cpSync(join(h.projectRoot, EXPORT_ROOT), join(otherRoot, "incoming"), { recursive: true });

    const preview = ok<WorkImportPreviewResult>(
      await h.call("project/work/import/preview", { projectId: otherId, adapter: "work_export", path: "incoming" }),
    );
    expect(preview.proposals).toHaveLength(0);
    expect(preview.skipped[0]?.reason).toContain("no longer matches the digest");
  });
});

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

describe("publication", () => {
  async function repositoryHarness(): Promise<ProjectWorkHarness> {
    const harness = harnessWithProjectFolder();
    git(harness.projectRoot, ["init", "-q", "-b", "main"]);
    writeFileSync(join(harness.projectRoot, "README.md"), "# Project\n", "utf8");
    git(harness.projectRoot, ["add", "README.md"]);
    git(harness.projectRoot, ["commit", "-q", "-m", "first"]);
    return harness;
  }

  it("refuses to record a publication while the export is not in the commit, and hands back the commit action", async () => {
    h = await repositoryHarness();
    await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });

    const preview = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    expect(preview.ready).toBe(false);
    expect(preview.uncommitted).toContain(`${EXPORT_ROOT}/SPEC-1.md`);
    expect(preview.commit).toEqual({
      method: "pi/project/git/commit",
      cwd: preview.commit?.cwd,
      paths: [EXPORT_ROOT],
      message: "Publish project work export (1 item)",
    });
    expect(preview.repository?.objectFormat).toBe("sha1");
    expect(preview.entities[0]?.publishedPath).toBe(`${EXPORT_ROOT}/SPEC-1.md`);

    const refusal = failed(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: preview.previewDigest,
        confirm: true,
        commit: "HEAD",
        idempotencyKey: "pub1",
      }),
    );
    expect(refusal.message).toContain("does not carry");

    // Nothing was recorded.
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items[0]?.linkCounts.repository).toBe(0);
  });

  it("records `published_as` against the exact commit, path and blob once the export is committed", async () => {
    h = await repositoryHarness();
    await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    git(h.projectRoot, ["add", EXPORT_ROOT]);
    git(h.projectRoot, ["commit", "-q", "-m", "publish work"]);
    const head = git(h.projectRoot, ["rev-parse", "HEAD"]);

    const preview = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    expect(preview.ready).toBe(true);
    expect(preview.uncommitted).toEqual([]);
    expect(preview.commit).toBeUndefined();
    expect(preview.files.every((file) => file.committed)).toBe(true);

    const applied = ok<WorkPublishApplyResult>(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: preview.previewDigest,
        confirm: true,
        commit: "HEAD",
        idempotencyKey: "pub1",
      }),
    );
    expect(applied.commitObjectId).toBe(head);
    expect(applied.published).toHaveLength(1);
    expect(applied.published[0]?.publishedPath).toBe(`${EXPORT_ROOT}/SPEC-1.md`);

    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, key: "SPEC-1" }));
    const link = detail.repositoryLinks.find((candidate) => candidate.relation === "published_as")!;
    expect(link.publishedPath).toBe(`${EXPORT_ROOT}/SPEC-1.md`);
    expect("state" in link.target).toBe(true);
    if ("state" in link.target) {
      expect(link.target.state.commitObjectId).toBe(head);
      expect(link.target.state.path).toBe(`${EXPORT_ROOT}/SPEC-1.md`);
      // The exact blob git holds at that path, in that commit.
      expect(link.target.state.blobObjectId).toBe(git(h.projectRoot, ["rev-parse", `HEAD:${EXPORT_ROOT}/SPEC-1.md`]));
      expect(link.target.state.contentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(link.target.state.checkpointId).toBeUndefined();
    }

    const audit = h.logs.find((row) => row.kind === "project_work_published")!;
    expect(audit.summary).toContain("published 1 item(s)");
    expect(h.workerAttempts()).toBe(0);
  });

  it("supersedes the previous publication when the work is published again", async () => {
    h = await repositoryHarness();
    const spec = await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    git(h.projectRoot, ["add", "-A"]);
    git(h.projectRoot, ["commit", "-q", "-m", "publish"]);
    const first = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    const firstApplied = ok<WorkPublishApplyResult>(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: first.previewDigest,
        confirm: true,
        commit: "HEAD",
        idempotencyKey: "pub1",
      }),
    );

    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("A reviewer decides from anywhere."),
        idempotencyKey: "rev1",
      }),
    );
    await exportOnce(h, { key: "e2", mode: "replace" });
    git(h.projectRoot, ["add", "-A"]);
    git(h.projectRoot, ["commit", "-q", "-m", "publish again"]);
    const second = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    expect(second.entities[0]?.publishedAs).toBeUndefined();
    const secondApplied = ok<WorkPublishApplyResult>(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: second.previewDigest,
        confirm: true,
        commit: "HEAD",
        idempotencyKey: "pub2",
      }),
    );
    expect(secondApplied.published[0]?.supersedesLinkId).toBe(firstApplied.published[0]?.linkId);
    expect(secondApplied.commitObjectId).not.toBe(firstApplied.commitObjectId);

    // The earlier publication is kept: provenance appends, it never rewrites.
    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, key: "SPEC-1" }));
    expect(detail.repositoryLinks.filter((link) => link.relation === "published_as")).toHaveLength(2);
  });

  it("records an uncommitted publication against the checkpoint commit that really holds the bytes", async () => {
    h = await repositoryHarness();
    await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    // The export is on disk and uncommitted; the checkpoint is the commit
    // object that carries it (leap: a checkpoint *is* a commit).
    const checkpoint = writeCheckpoint(h, "a1b2c3", 4);
    const preview = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    expect(preview.ready).toBe(false);
    expect(preview.refusal).toContain("choose a state that carries these exact files");
    // The current commit does not carry it; the checkpoint that does is offered
    // beside it, host-resolved and already proved.
    expect(preview.selected?.kind).toBe("commit");
    expect(preview.selected?.carriesExport).toBe(false);
    const offered = preview.sources?.find((source) => source.checkpointId === checkpoint.ref);
    expect(offered).toMatchObject({ kind: "checkpoint", commitObjectId: checkpoint.commit, carriesExport: true });
    expect(offered?.label).toBe("Checkpoint from turn 4");

    // Choosing it re-measures the export against that state, and only then is
    // the publication ready.
    const chosen = ok<WorkPublishPreviewResult>(
      await h.call("project/work/publish/preview", {
        projectId: h.projectId,
        source: { kind: "checkpoint", checkpointId: checkpoint.ref },
      }),
    );
    expect(chosen.ready).toBe(true);
    expect(chosen.selected).toMatchObject({ kind: "checkpoint", checkpointId: checkpoint.ref, commitObjectId: checkpoint.commit, carriesExport: true });
    expect(chosen.uncommitted).toEqual([]);
    expect(chosen.previewDigest).not.toBe(preview.previewDigest);

    // Two identities that disagree are refused rather than one being preferred.
    const ambiguous = failed(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: chosen.previewDigest,
        confirm: true,
        commit: "HEAD",
        checkpointId: checkpoint.ref,
        idempotencyKey: "pub-ambiguous",
      }),
    );
    expect(ambiguous.message).toContain("published at its own commit");
    const conflicting = failed(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: chosen.previewDigest,
        confirm: true,
        commit: git(h.projectRoot, ["rev-parse", "HEAD"]),
        checkpointId: checkpoint.ref,
        idempotencyKey: "pub-conflict",
      }),
    );
    expect(conflicting.message).toContain("two different states");
    // A confirmation of the commit preview cannot be spent on the checkpoint one.
    const stalePreview = failed(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: preview.previewDigest,
        confirm: true,
        commit: checkpoint.commit,
        checkpointId: checkpoint.ref,
        idempotencyKey: "pub-stale",
      }),
    );
    expect(stalePreview.message).toContain("Preview the publication again");
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items[0]?.linkCounts.repository).toBe(0);

    const applied = ok<WorkPublishApplyResult>(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: chosen.previewDigest,
        confirm: true,
        commit: checkpoint.commit,
        checkpointId: checkpoint.ref,
        idempotencyKey: "pub1",
      }),
    );
    // The state recorded is the checkpoint's own commit, not the HEAD that was
    // named beside it and does not carry these files.
    expect(applied.state.checkpointId).toBe(checkpoint.ref);
    expect(applied.commitObjectId).toBe(checkpoint.commit);
    expect(applied.commitObjectId).not.toBe(git(h.projectRoot, ["rev-parse", "HEAD"]));

    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, key: "SPEC-1" }));
    const link = detail.repositoryLinks[0]!;
    expect("state" in link.target).toBe(true);
    if ("state" in link.target) {
      expect(link.target.state.checkpointId).toBe(checkpoint.ref);
      expect(link.target.state.commitObjectId).toBe(checkpoint.commit);
      // The blob the checkpoint really holds at that path, proved and recorded.
      expect(link.target.state.blobObjectId).toBe(git(h.projectRoot, ["rev-parse", `${checkpoint.commit}:${EXPORT_ROOT}/SPEC-1.md`]));
      expect(link.target.state.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses a checkpoint id that is not a checkpoint this repository has, and records nothing", async () => {
    h = await repositoryHarness();
    await create(h, "spec", "Phone review", "c1");
    await exportOnce(h, { key: "e1" });
    const preview = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));

    // An invented id, a ref outside the checkpoint namespace, and a checkpoint
    // ref that this repository simply does not have.
    for (const [index, checkpointId] of ["ckpt_17", "HEAD", "refs/heads/main", checkpointRef("a1b2c3", 4)].entries()) {
      const refusal = failed(
        await h.call("project/work/publish/apply", {
          projectId: h.projectId,
          previewDigest: preview.previewDigest,
          confirm: true,
          commit: "HEAD",
          checkpointId,
          idempotencyKey: `pub-${String(index)}`,
        }),
      );
      expect(refusal.message).toContain("not a checkpoint this repository still has");
      // And a preview cannot be talked into one either.
      const previewRefusal = ok<WorkPublishPreviewResult>(
        await h.call("project/work/publish/preview", { projectId: h.projectId, source: { kind: "checkpoint", checkpointId } }),
      );
      expect(previewRefusal.ready).toBe(false);
      expect(previewRefusal.refusal).toContain("not a checkpoint this repository still has");
      expect(previewRefusal.selected).toBeUndefined();
    }
    // Nothing in the namespace, so the only state offered is the commit itself.
    expect(preview.sources?.every((source) => source.kind === "commit")).toBe(true);

    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items[0]?.linkCounts.repository).toBe(0);
  });

  it("refuses a real checkpoint whose commit does not carry the export, and records nothing", async () => {
    h = await repositoryHarness();
    await create(h, "spec", "Phone review", "c1");
    // A checkpoint taken before the export exists: a real ref, a real commit,
    // and not this export's bytes.
    const stale = writeCheckpoint(h, "a1b2c3", 1);
    await exportOnce(h, { key: "e1" });
    const preview = ok<WorkPublishPreviewResult>(
      await h.call("project/work/publish/preview", { projectId: h.projectId, source: { kind: "checkpoint", checkpointId: stale.ref } }),
    );
    // The state resolves, and the preview says plainly that it does not carry
    // this export: the readiness is the proof, not the id.
    expect(preview.ready).toBe(false);
    expect(preview.selected).toMatchObject({ kind: "checkpoint", checkpointId: stale.ref, carriesExport: false });
    expect(preview.selected?.missing).toContain(`${EXPORT_ROOT}/SPEC-1.md`);

    const refusal = failed(
      await h.call("project/work/publish/apply", {
        projectId: h.projectId,
        previewDigest: preview.previewDigest,
        confirm: true,
        commit: stale.commit,
        checkpointId: stale.ref,
        idempotencyKey: "pub1",
      }),
    );
    expect(refusal.message).toContain("That checkpoint does not carry");
    expect(refusal.message).toContain(`${EXPORT_ROOT}/SPEC-1.md`);

    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items[0]?.linkCounts.repository).toBe(0);
  });

  it("refuses when there is no export, and when the export is out of date", async () => {
    h = await repositoryHarness();
    await create(h, "spec", "Phone review", "c1");

    const empty = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    expect(empty.ready).toBe(false);
    expect(empty.refusal).toContain("Export again");

    await exportOnce(h, { key: "e1" });
    await create(h, "task", "Sticky footer", "c2");
    const stale = ok<WorkPublishPreviewResult>(await h.call("project/work/publish/preview", { projectId: h.projectId }));
    expect(stale.ready).toBe(false);
    expect(stale.refusal).toContain("Export again");
  });

  it("refuses every interop method on a project whose folder is not trusted", async () => {
    h = projectWorkHarness({ trustOf: () => "declined" });
    mkdirSync(h.projectRoot, { recursive: true });
    for (const params of [
      { method: "project/work/import/preview", params: { projectId: h.projectId, adapter: "markdown" } },
      { method: "project/work/export/preview", params: { projectId: h.projectId } },
      { method: "project/work/publish/preview", params: { projectId: h.projectId } },
    ]) {
      const refusal = failed(await h.call(params.method, params.params));
      expect(refusal.code).toBe(ErrorCodes.ProjectUntrusted);
    }
  });

  it("refuses a path that leaves the project", async () => {
    h = harnessWithProjectFolder();
    const refusal = failed(await h.call("project/work/export/preview", { projectId: h.projectId, path: "../outside" }));
    expect(refusal.code).toBe(ErrorCodes.InvalidParams);
  });

  it("refuses to export into a repository's storage or this project's settings, and leaves them alone", async () => {
    h = harnessWithProjectFolder();
    await create(h, "spec", "Phone review", "c1");
    writeFile(h.projectRoot, `${PROJECT_DIR_NAME}/settings.json`, '{"kept":true}\n');
    writeFile(h.projectRoot, `${PROJECT_DIR_NAME}/design/index.json`, '{"design":true}\n');

    for (const path of [".git", ".git/hooks", PROJECT_DIR_NAME, `${PROJECT_DIR_NAME}/design`, `${PROJECT_DIR_NAME}/settings.json`]) {
      const refusal = failed(await h.call("project/work/export/preview", { projectId: h.projectId, path }));
      expect(refusal.message).toMatch(/repository's own storage|this project's own settings/);
    }

    // Nothing there moved, and the one folder exports do use still works.
    expect(readFileSync(join(h.projectRoot, PROJECT_DIR_NAME, "settings.json"), "utf8")).toBe('{"kept":true}\n');
    expect(readFileSync(join(h.projectRoot, PROJECT_DIR_NAME, "design", "index.json"), "utf8")).toBe('{"design":true}\n');
    const exported = await exportOnce(h, { key: "e1" });
    expect(exported.root).toBe(EXPORT_ROOT);
  });

  it("refuses to import from a repository's storage or this project's settings", async () => {
    h = harnessWithProjectFolder();
    for (const path of [".git", `${PROJECT_DIR_NAME}/design`]) {
      const refusal = failed(await h.call("project/work/import/preview", { projectId: h.projectId, adapter: "markdown", path }));
      expect(refusal.message).toMatch(/repository's own storage|this project's own settings/);
    }
  });
});
