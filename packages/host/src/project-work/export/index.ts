/**
 * Export: the project's work as deterministic files (M21-T21).
 *
 * `project/work/export/preview` computes the whole export in memory and
 * answers with the exact file set, their digests and what is already at the
 * root. `project/work/export/apply` recomputes it, refuses unless the person
 * confirmed **this** preview (`previewDigest`), writes it atomically and
 * reports what it removed.
 *
 * Three rules from the leap, made structural here:
 *
 * - **An export is a snapshot, never a second authority.** Nothing reads it
 *   back as truth, nothing watches it, and the canonical store is unchanged by
 *   writing one. Re-importing an export is an ordinary, previewed import.
 * - **Deterministic.** Same work, same bytes: the documents carry no
 *   timestamps, the manifest carries none either, and every list is ordered by
 *   key rather than by what a query returned first.
 * - **Re-export is an explicit decision.** An export already at the root is
 *   not silently overwritten: the preview says what is there and offers
 *   `replace` (overwrite, deleting the files of the previous export that this
 *   one no longer has) or `new_revision` (write beside it, leaving the
 *   previous export exactly as it is).
 */
import {
  PRODUCT_DISPLAY_NAME,
  WORK_EXPORT_ENTITIES_MAX,
  WORK_EXPORT_FILES_LISTED_MAX,
  WORK_EXPORT_MAX_BYTES,
  type ProjectWorkListItem,
  type ProjectWorkManifest,
  type WorkExportApplyParams,
  type WorkExportApplyResult,
  type WorkExportFile,
  type WorkExportMode,
  type WorkExportPreviewParams,
  type WorkExportPreviewResult,
  type WorkManifestAttachment,
} from "@lasercode/protocol";

import { ProjectWorkRefusedError } from "../errors.js";
import { canonicalJson, sha256 } from "../ids.js";
import type { ProjectWorkStore } from "../store.js";
import { renderDocument } from "./markdown.js";
import { attachmentsOf, buildManifest, manifestBytes, type ManifestEntityInput } from "./manifest.js";
import {
  DEFAULT_EXPORT_ROOT,
  insideProject,
  kindOf,
  normaliseRelative,
  projectDirectory,
  readTextFile,
  removeFile,
  walkFiles,
  writeFileAtomic,
} from "./paths.js";

/** The computed export, before anything is written. */
export interface ComputedExport {
  root: string;
  files: WorkExportFile[];
  contents: Map<string, string>;
  manifest: ProjectWorkManifest;
  manifestDigest: string;
  entities: number;
  attachments: number;
  totalBytes: number;
  truncated: boolean;
}

const MANIFEST_FILE = "manifest.json";
const README_FILE = "README.md";
const BODIES_DIR = "bodies";

export class ProjectWorkExport {
  constructor(private readonly store: ProjectWorkStore) {}

  preview(params: WorkExportPreviewParams): WorkExportPreviewResult {
    const root = this.rootOf(params.path);
    const computed = this.compute(params.projectId, root, params.includeArchived === true);
    const existing = this.existingAt(params.projectId, root, computed);
    const mode = params.mode ?? (existing ? "replace" : "replace");
    const target = mode === "new_revision" && existing ? this.nextRevisionRoot(params.projectId, root) : root;
    const placed = target === root ? computed : { ...computed, root: target };
    const removes = mode === "replace" && existing ? this.staleFiles(params.projectId, root, computed) : [];

    return {
      root: placed.root,
      previewDigest: previewDigest(placed, mode, removes),
      files: placed.files.slice(0, WORK_EXPORT_FILES_LISTED_MAX),
      entities: placed.entities,
      attachments: placed.attachments,
      totalBytes: placed.totalBytes,
      mode,
      ...(existing ? { existing } : {}),
      removes,
      ...(existing && params.mode === undefined
        ? { decide: { reason: "existing_export" as const, choices: ["replace", "new_revision"] as const } }
        : {}),
      ...(placed.files.length > WORK_EXPORT_FILES_LISTED_MAX ? { truncated: true } : {}),
    };
  }

  /**
   * Write the export.
   *
   * The whole file set is computed again from the store and fenced against the
   * digest the person confirmed: work that moved between the preview and the
   * press is a refusal naming what to do, never a write of something they did
   * not see. Files are written atomically, one by one; a previous export's
   * leftovers are removed only in `replace`, and only files the previous
   * manifest itself listed.
   */
  apply(params: WorkExportApplyParams): Omit<WorkExportApplyResult, "seq"> {
    const root = this.rootOf(params.path);
    const computed = this.compute(params.projectId, root, params.includeArchived === true);
    const existing = this.existingAt(params.projectId, root, computed);
    const mode = params.mode ?? "replace";
    if (existing && params.mode === undefined) {
      throw new ProjectWorkRefusedError(
        `There is already an export at ${root}. Choose whether to replace it or to write this one beside it as a new revision.`,
      );
    }
    const target = mode === "new_revision" && existing ? this.nextRevisionRoot(params.projectId, root) : root;
    const placed = target === root ? computed : { ...computed, root: target };
    const removes = mode === "replace" && existing ? this.staleFiles(params.projectId, root, computed) : [];
    const digest = previewDigest(placed, mode, removes);
    if (digest !== params.previewDigest) {
      throw new ProjectWorkRefusedError(
        "This project's work changed after that preview, so nothing was written. Preview the export again to see what would be written now.",
      );
    }
    if (placed.totalBytes > WORK_EXPORT_MAX_BYTES) {
      throw new ProjectWorkRefusedError(
        `This export is ${String(Math.round(placed.totalBytes / (1024 * 1024)))} MB, which is more than one export may write. Archive work you no longer need, or export a smaller part of it.`,
      );
    }

    const projectRoot = projectDirectory(this.store, params.projectId);
    const absoluteRoot = insideProject(projectRoot, placed.root);
    for (const file of placed.files) {
      const contents = placed.contents.get(file.path);
      if (contents === undefined) continue;
      writeFileAtomic(insideProject(absoluteRoot, file.path), contents);
    }
    for (const stale of removes) removeFile(insideProject(absoluteRoot, stale));

    return {
      root: placed.root,
      mode,
      files: placed.files,
      removed: removes,
      manifestDigest: placed.manifestDigest,
      entities: placed.entities,
      attachments: placed.attachments,
      totalBytes: placed.totalBytes,
    };
  }

  /** The export as files, with nothing written. Publication reads this too. */
  compute(projectId: string, root: string, includeArchived: boolean): ComputedExport {
    const { items, truncated } = this.allRows(projectId);
    const rows = items.filter((item) => includeArchived || !item.archived).sort((a, b) => compareKeys(a.key, b.key));

    const entities: ManifestEntityInput[] = [];
    const attachments: WorkManifestAttachment[] = [];
    const keyOf = new Map<string, string>();
    for (const row of rows) keyOf.set(row.ref.entityId, row.key);

    for (const row of rows) {
      const detail = this.store.get({
        projectId,
        entityId: row.ref.entityId,
        body: { mode: "full" },
        include: { comments: false, approvals: false, evidence: false, links: true, history: false },
      });
      const body = detail.body?.body;
      if (!body) continue;
      entities.push({
        entity: detail.entity,
        revision: detail.revision,
        body,
        edges: [...detail.edges].sort((a, b) => compare(a.linkId, b.linkId)),
        repositoryLinks: [...detail.repositoryLinks].sort((a, b) => compare(a.linkId, b.linkId)),
        document: `${detail.entity.key}.md`,
        bodyPath: `${BODIES_DIR}/${detail.entity.key}.json`,
      });
      for (const attachment of attachmentsOf(detail.entity.key, body)) {
        const range = this.store.readBlob({ projectId, blobId: attachment.blobId, offset: 0, limit: 1 });
        if (!range) continue;
        attachments.push({
          blobId: attachment.blobId,
          mediaType: range.mediaType,
          digest: range.digest,
          bytes: range.totalBytes,
          key: attachment.key,
          field: attachment.field,
        });
      }
    }

    const manifest = buildManifest({ projectId, entities, attachments });
    const contents = new Map<string, string>();
    const files: WorkExportFile[] = [];
    const add = (path: string, role: WorkExportFile["role"], text: string, key?: string): void => {
      contents.set(path, text);
      files.push({ path, role, bytes: Buffer.byteLength(text, "utf8"), digest: sha256(text), ...(key !== undefined ? { key } : {}) });
    };

    add(README_FILE, "readme", readme());
    for (const item of entities) {
      add(item.document, "document", renderDocument({ ...item, keyOf: (entityId) => keyOf.get(entityId) }), item.entity.key);
      add(item.bodyPath, "body", `${JSON.stringify(JSON.parse(canonicalJson(item.body)), null, 2)}\n`, item.entity.key);
    }
    const manifestText = manifestBytes(manifest);
    add(MANIFEST_FILE, "manifest", manifestText);
    files.sort((a, b) => compare(a.path, b.path));

    return {
      root,
      files,
      contents,
      manifest,
      manifestDigest: sha256(manifestText),
      entities: entities.length,
      attachments: attachments.length,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      truncated,
    };
  }

  /**
   * Every row of the backlog, followed page by page.
   *
   * A list page is bounded at 200 by the store; an export covers the project,
   * so it follows the cursor to the ceiling and says so when it stops. It
   * never exports "the first page" and calls it the project.
   */
  private allRows(projectId: string): { items: ProjectWorkListItem[]; truncated: boolean } {
    const items: ProjectWorkListItem[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = this.store.list({ projectId, includeArchived: true, limit: 200, ...(cursor !== undefined ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor === undefined) return { items, truncated: false };
      if (items.length >= WORK_EXPORT_ENTITIES_MAX) return { items: items.slice(0, WORK_EXPORT_ENTITIES_MAX), truncated: true };
    }
  }

  /** The export root as a project-relative path, defaulted and contained. */
  rootOf(path: string | undefined): string {
    const root = normaliseRelative(path ?? DEFAULT_EXPORT_ROOT);
    if (root === "") throw new ProjectWorkRefusedError("Name a folder inside this project to export to.");
    return root;
  }

  /** What is already at the root: a previous export, or nothing. */
  private existingAt(projectId: string, root: string, computed: ComputedExport): WorkExportPreviewResult["existing"] {
    const projectRoot = projectDirectory(this.store, projectId);
    const absolute = insideProject(projectRoot, root);
    if (kindOf(absolute) !== "directory") return undefined;
    const manifestText = readTextFile(insideProject(absolute, MANIFEST_FILE), 8 * 1024 * 1024);
    if (manifestText === undefined) {
      const walked = walkFiles(absolute, { max: WORK_EXPORT_FILES_LISTED_MAX });
      if (walked.files.length === 0) return undefined;
      return { root, files: walked.files.length, unchanged: false };
    }
    const digest = sha256(manifestText);
    const walked = walkFiles(absolute, { max: WORK_EXPORT_FILES_LISTED_MAX });
    const unchanged =
      digest === computed.manifestDigest &&
      computed.files.every((file) => {
        const text = readTextFile(insideProject(absolute, file.path), WORK_EXPORT_MAX_BYTES);
        return text !== undefined && sha256(text) === file.digest;
      });
    return { root, files: walked.files.length, manifestDigest: digest, unchanged };
  }

  /**
   * The files a previous export wrote that this one does not.
   *
   * Taken from the previous **manifest**, never from a scan: a file a person
   * put in that folder themselves is not this export's to delete.
   */
  private staleFiles(projectId: string, root: string, computed: ComputedExport): string[] {
    const projectRoot = projectDirectory(this.store, projectId);
    const absolute = insideProject(projectRoot, root);
    const manifestText = readTextFile(insideProject(absolute, MANIFEST_FILE), 8 * 1024 * 1024);
    if (manifestText === undefined) return [];
    let previous: ProjectWorkManifest;
    try {
      previous = JSON.parse(manifestText) as ProjectWorkManifest;
    } catch {
      return [];
    }
    const written = new Set(computed.files.map((file) => file.path));
    const stale = new Set<string>();
    for (const entity of previous.entities ?? []) {
      for (const path of [entity.document, entity.body]) {
        if (typeof path !== "string" || written.has(path)) continue;
        if (kindOf(insideProject(absolute, path)) !== "file") continue;
        stale.add(path);
      }
    }
    return [...stale].sort(compare);
  }

  /** `…/work` → `…/work-2`, the first free one. A new revision never overwrites. */
  private nextRevisionRoot(projectId: string, root: string): string {
    const projectRoot = projectDirectory(this.store, projectId);
    for (let revision = 2; revision < 1000; revision += 1) {
      const candidate = `${root}-${String(revision)}`;
      if (kindOf(insideProject(projectRoot, candidate)) === "none") return candidate;
    }
    throw new ProjectWorkRefusedError(`There are too many exports beside ${root}. Remove some of them, or export to another folder.`);
  }
}

/**
 * What the person confirmed: the root, the mode, every file with its digest,
 * and every file this would delete. Anything that changes what lands on disk
 * changes this, so a stale confirmation cannot write.
 */
function previewDigest(computed: ComputedExport, mode: WorkExportMode, removes: readonly string[]): string {
  return sha256(
    canonicalJson({
      root: computed.root,
      mode,
      manifestDigest: computed.manifestDigest,
      files: computed.files.map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes })),
      removes: [...removes],
    }),
  );
}

/** Keys sort by kind, then by number: `SPEC-2` before `SPEC-10`, always. */
function compareKeys(a: string, b: string): number {
  const split = (key: string): [string, number] => {
    const at = key.lastIndexOf("-");
    return at < 0 ? [key, 0] : [key.slice(0, at), Number(key.slice(at + 1)) || 0];
  };
  const [prefixA, numberA] = split(a);
  const [prefixB, numberB] = split(b);
  if (prefixA !== prefixB) return compare(prefixA, prefixB);
  return numberA - numberB;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one file in an export written for whoever opens the folder rather than
 * for a machine: what this is, and the one thing they must know about it —
 * that editing it changes nothing, because the app is still the authority.
 */
function readme(): string {
  return [
    `# Project work export`,
    ``,
    `This folder is a snapshot of this project's specs, research, designs, plans`,
    `and tasks, written by ${PRODUCT_DISPLAY_NAME}.`,
    ``,
    `- \`manifest.json\` lists every item with its stable id, its exact revision and`,
    `  that revision's digest, the relations between items, the repository links`,
    `  and the attachments each item references.`,
    `- \`<KEY>.md\` is the readable document for one item.`,
    `- \`bodies/<KEY>.json\` is the exact stored content of that same revision.`,
    ``,
    `It is a copy, not the original: editing these files changes nothing in the`,
    `app, and the app will not read them back on its own. To bring changes in,`,
    `import this folder — you will see exactly what would be created or updated`,
    `before anything is written.`,
    ``,
    `Nothing here carries a timestamp, so exporting the same work twice produces`,
    `the same bytes and a re-export is a diff you can read.`,
    ``,
  ].join("\n");
}
