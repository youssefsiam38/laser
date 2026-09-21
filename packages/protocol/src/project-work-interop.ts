/**
 * Import, export and repository publication (M21-T21, leap "Import, export and
 * interoperability").
 *
 * Six methods, beside the spine's sixteen and never inside them:
 *
 * | Method | What it does |
 * | --- | --- |
 * | `project/work/import/preview` | parse an external tool's files and say what would be created, updated or needs a decision |
 * | `project/work/import/apply` | write those revisions, with the provenance of every source file |
 * | `project/work/export/preview` | the exact file set a deterministic export would write |
 * | `project/work/export/apply` | write it, with an audit event |
 * | `project/work/publish/preview` | what publishing that export into its repository would record |
 * | `project/work/publish/apply` | record `published_as` against the exact commit, once it is known |
 *
 * Four rules the shapes here make structural:
 *
 * 1. **Nothing is written without a preview.** Every `apply` carries the
 *    `previewDigest` its preview answered with; a source file, an entity or an
 *    export that moved in between is a refusal naming the difference, never a
 *    write against a plan the person never saw.
 * 2. **An import is a read, once.** {@link WorkImportPreviewResult.watches} is
 *    the literal `false`: an adapter parses text, proposes revisions and stops.
 *    No external tool ever becomes a second writer of a Laser artifact.
 * 3. **An export is a snapshot.** The canonical store stays the authority; the
 *    export is deterministic bytes plus a manifest of stable ids, revision
 *    digests, relations, repository links and attachment references, so a
 *    second export of unchanged work is byte-identical.
 * 4. **`published_as` waits for the exact state.** The publish half records a
 *    repository link only once the commit that carries the exported bytes is
 *    known and verified, or the uncommitted state is named by a checkpoint.
 *
 * A Jira or other external tracker link (`ExternalWorkLink`) is **M25's**, not
 * this file's: {@link WORK_IMPORT_ADAPTERS} leaves the named slot and nothing
 * here speaks to a network.
 */
import { z } from "zod";
import {
  PROJECT_WORK_EDGE_RELATIONS,
  PROJECT_WORK_NOTE_MAX,
  REPOSITORY_LINK_RELATIONS,
  projectIdSchema,
  projectWorkDigestSchema,
  projectWorkIdSchema,
  projectWorkKeySchema,
  projectWorkKindSchema,
  projectWorkOriginSchema,
  projectWorkRevisionIdSchema,
  projectWorkStateSchema,
  repositoryChangeRefSchema,
  repositoryStateRefSchema,
  type ProjectWorkEdgeRelation,
  type ProjectWorkKind,
  type ProjectWorkOrigin,
  type ProjectWorkState,
  type RepositoryChangeRef,
  type RepositoryLinkRelation,
  type RepositoryStateRef,
} from "./project-work.js";
import { SOURCE_LICENCES, type SourceLicence } from "./project-work-bodies.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Proposals one import preview carries. Beyond this it says `truncated`. */
export const WORK_IMPORT_PROPOSALS_MAX = 200;
/** Files one adapter opens in a single scan. */
export const WORK_IMPORT_FILES_MAX = 2000;
/** The largest single source file an adapter reads, in bytes. */
export const WORK_IMPORT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Entities one export writes. */
export const WORK_EXPORT_ENTITIES_MAX = 2000;
/** The largest export, in bytes, before it is refused as a resource problem. */
export const WORK_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
/** Files one preview lists before it reports the rest as a count. */
export const WORK_EXPORT_FILES_LISTED_MAX = 4000;

/** Where an export goes when the person names nothing: `<project>/.<name>/work`. */
export const WORK_EXPORT_DIR = "work";

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * The adapters that exist, each one reading a documented on-disk layout.
 *
 * - `spec_kit` — `specs/<nnn>-<slug>/{spec,plan,tasks}.md`.
 * - `openspec` — `openspec/specs/<capability>/spec.md` and
 *   `openspec/changes/<change>/{proposal,design,tasks}.md`.
 * - `markdown` — any Markdown tree whose files carry front matter.
 * - `plan_md` — a `PLAN.md` of milestone sections and task tables.
 * - `work_export` — this product's own export, read back exactly.
 *
 * An issue tracker is **not** in this list. `ExternalWorkLink` (Jira) is M25's
 * contract: it is an explicit, previewed, never-syncing link to an issue, not
 * a file an adapter parses, and it lands as its own member here when it ships.
 */
export const WORK_IMPORT_ADAPTERS = ["spec_kit", "openspec", "markdown", "plan_md", "work_export"] as const;
export type WorkImportAdapter = (typeof WORK_IMPORT_ADAPTERS)[number];

/** What a person may decide about a proposal that collides with existing work. */
export const WORK_IMPORT_CHOICES = ["new_revision", "new_entity", "skip"] as const;
export type WorkImportChoice = (typeof WORK_IMPORT_CHOICES)[number];

/** Why a proposal needs a decision: the key it names, or the title it repeats. */
export const WORK_IMPORT_CONFLICT_REASONS = ["key", "title"] as const;
export type WorkImportConflictReason = (typeof WORK_IMPORT_CONFLICT_REASONS)[number];

/** Where one proposal came from, and under what licence. Kept with the revision. */
export interface WorkImportSourceRef {
  adapter: WorkImportAdapter;
  /** Project-relative path of the file that was parsed. Never absolute. */
  path: string;
  /** sha256 of the exact bytes the adapter read. */
  digest: string;
  /** The licence the source declared, when it declared one at all. */
  licence?: SourceLicence;
  /** The declared licence as written (`MIT`, `CC-BY-4.0`). Verbatim, bounded. */
  licenceName?: string;
  /** The id the source names itself by (`001-import`, `FR-003`, `M21-T21`). */
  externalId?: string;
}

export interface WorkImportMatch {
  entityId: string;
  key: string;
  title: string;
  digest: string;
  matchedBy: WorkImportConflictReason;
}

/** One thing the adapter proposes. A preview is a list of these and nothing else. */
export interface WorkImportProposal {
  /** Stable inside one preview, so a decision names exactly one proposal. */
  sourceId: string;
  kind: ProjectWorkKind;
  title: string;
  /** One line of what it carries, for the preview list. Never the whole body. */
  summary: string;
  source: WorkImportSourceRef;
  /** The existing entity this lands on, when the key or the title already exists. */
  match?: WorkImportMatch;
  /** Present exactly when a decision is required before anything is written. */
  conflict?: { reason: WorkImportConflictReason; choices: readonly WorkImportChoice[] };
  /** `create` needs no decision; `decide` is refused until one is given. */
  action: "create" | "decide";
  /** What the adapter could not read, in sentences. Never a stack trace. */
  notes: string[];
}

export interface WorkImportPreviewParams {
  projectId: string;
  adapter: WorkImportAdapter;
  /** Project-relative directory or file to read. Omitted uses the adapter's own root. */
  path?: string;
}

export interface WorkImportPreviewResult {
  adapter: WorkImportAdapter;
  /** The project-relative root that was scanned. */
  root: string;
  /** Fences the apply: the exact proposals, from the exact bytes. */
  previewDigest: string;
  proposals: WorkImportProposal[];
  creates: number;
  conflicts: number;
  /** Files the adapter opened and did not take, each with the reason. */
  skipped: Array<{ path: string; reason: string }>;
  truncated?: boolean;
  /**
   * Always `false`. An import reads the files once; nothing watches them
   * afterwards, and the external tool never becomes a second writer (leap,
   * "Import, export and interoperability").
   */
  watches: false;
}

export interface WorkImportApplyParams {
  projectId: string;
  adapter: WorkImportAdapter;
  path?: string;
  /** The digest of the preview this apply was decided from. */
  previewDigest: string;
  /** Required. Without it nothing is written and the preview is the answer. */
  confirm: true;
  /** One decision per conflicting proposal. A missing one is a refusal. */
  decisions?: Array<{ sourceId: string; choice: WorkImportChoice }>;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface WorkImportApplied {
  sourceId: string;
  action: "created" | "revised" | "skipped";
  key?: string;
  entityId?: string;
  revisionId?: string;
  digest?: string;
  /** The source file this revision was derived from, as it was recorded. */
  source: WorkImportSourceRef;
  /** Why it was skipped, or what the import could not carry over. */
  note?: string;
}

export interface WorkImportApplyResult {
  adapter: WorkImportAdapter;
  root: string;
  applied: WorkImportApplied[];
  created: number;
  revised: number;
  skipped: number;
  /** Relations the import recreated between the items it wrote. */
  relations: number;
  seq: number;
  replayed?: boolean;
  /** Always `false`, for the same reason the preview says so. */
  watches: false;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * What a re-export does with an export that is already there.
 *
 * There is no third option and no default: the leap makes re-export "an
 * explicit replace or new-revision decision", so an apply over an existing
 * export without a mode is refused with both choices named.
 */
export const WORK_EXPORT_MODES = ["replace", "new_revision"] as const;
export type WorkExportMode = (typeof WORK_EXPORT_MODES)[number];

export const WORK_EXPORT_FILE_ROLES = ["manifest", "document", "body", "readme"] as const;
export type WorkExportFileRole = (typeof WORK_EXPORT_FILE_ROLES)[number];

/** One file of an export, by its path under the export root. */
export interface WorkExportFile {
  path: string;
  role: WorkExportFileRole;
  bytes: number;
  digest: string;
  /** The entity this file belongs to, for a document or a body. */
  key?: string;
}

export interface WorkExportPreviewParams {
  projectId: string;
  /** Project-relative export root. Omitted is the default work directory. */
  path?: string;
  mode?: WorkExportMode;
  includeArchived?: boolean;
}

/** What is already at the export root, when anything is. */
export interface WorkExportExisting {
  root: string;
  files: number;
  manifestDigest?: string;
  /** True when the export already there is byte-identical to this one. */
  unchanged: boolean;
}

export interface WorkExportPreviewResult {
  /** The project-relative root this export would be written to. */
  root: string;
  previewDigest: string;
  files: WorkExportFile[];
  entities: number;
  /** Attachments the manifest references. Bytes stay in the store. */
  attachments: number;
  totalBytes: number;
  mode: WorkExportMode;
  existing?: WorkExportExisting;
  /** Files of a previous export this one would delete. `replace` only. */
  removes: string[];
  /** Set when a decision is required: an export is already at the root. */
  decide?: { reason: "existing_export"; choices: readonly WorkExportMode[] };
  truncated?: boolean;
}

export interface WorkExportApplyParams {
  projectId: string;
  path?: string;
  mode?: WorkExportMode;
  includeArchived?: boolean;
  previewDigest: string;
  confirm: true;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface WorkExportApplyResult {
  root: string;
  mode: WorkExportMode;
  files: WorkExportFile[];
  removed: string[];
  manifestDigest: string;
  entities: number;
  attachments: number;
  totalBytes: number;
  seq: number;
  replayed?: boolean;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** One exported file as the repository sees it. */
export interface WorkPublishFile {
  /** Repository-relative path. Never a host path. */
  path: string;
  digest: string;
  /** True when the committed bytes at that path are exactly these bytes. */
  committed: boolean;
}

export interface WorkPublishEntity {
  entityId: string;
  key: string;
  revisionId: string;
  digest: string;
  /** Repository-relative path of this entity's exported document. */
  publishedPath: string;
  /** The publication already recorded for this revision, when there is one. */
  publishedAs?: { linkId: string; commitObjectId: string };
}

export interface WorkPublishRepository {
  repositoryId: string;
  name: string;
  objectFormat: "sha1" | "sha256";
  /** `git rev-parse HEAD` when the repository has a commit. */
  head?: string;
  branch?: string;
}

/**
 * The commit this publication needs, handed back as the M20 git action to run.
 *
 * Publication never commits by itself: the person runs the repository's own
 * commit action, which has its own preview and typed confirmation, and comes
 * back here with the commit it produced.
 */
export interface WorkPublishCommitRequest {
  method: "pi/project/git/commit";
  cwd: string;
  paths: string[];
  message: string;
}

export interface WorkPublishPreviewParams {
  projectId: string;
  path?: string;
}

export interface WorkPublishPreviewResult {
  root: string;
  previewDigest: string;
  repository?: WorkPublishRepository;
  files: WorkPublishFile[];
  /** Exported files whose current bytes are not in `HEAD`. */
  uncommitted: string[];
  entities: WorkPublishEntity[];
  /** Present while something is still uncommitted. */
  commit?: WorkPublishCommitRequest;
  /** True when a `published_as` could be recorded right now. */
  ready: boolean;
  /** Why it is not ready, written for a person. */
  refusal?: string;
}

export interface WorkPublishApplyParams {
  projectId: string;
  path?: string;
  previewDigest: string;
  confirm: true;
  /** The commit the export was written in, or `HEAD` for the current one. */
  commit: string;
  /**
   * The checkpoint that names uncommitted bytes. Required when the export is
   * not in the commit: a publication of work in progress still records an
   * exact state, never "whatever is in the folder".
   */
  checkpointId?: string;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface WorkPublished {
  entityId: string;
  key: string;
  linkId: string;
  publishedPath: string;
  supersedesLinkId?: string;
}

export interface WorkPublishApplyResult {
  root: string;
  repositoryId: string;
  commitObjectId: string;
  objectFormat: "sha1" | "sha256";
  /** The state every published link was recorded against. */
  state: RepositoryStateRef;
  published: WorkPublished[];
  seq: number;
  replayed?: boolean;
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** The manifest format's own name and version, so a reader can refuse a future one. */
export const WORK_MANIFEST_FORMAT = "project-work";
export const WORK_MANIFEST_VERSION = 1;

export interface WorkManifestRef {
  entityId: string;
  key: string;
  revisionId: string;
}

export interface WorkManifestEntity {
  entityId: string;
  key: string;
  kind: ProjectWorkKind;
  title: string;
  state: ProjectWorkState;
  archived: boolean;
  revisionId: string;
  revisionIndex: number;
  /** The digest of the canonical body. The fence everything else is read against. */
  digest: string;
  bodyBytes: number;
  /** Path of the human document, relative to the manifest. */
  document: string;
  /** Path of the exact canonical body, relative to the manifest. */
  body: string;
}

export interface WorkManifestRelation {
  relation: ProjectWorkEdgeRelation;
  subject: WorkManifestRef;
  object: WorkManifestRef;
  note?: string;
}

export interface WorkManifestRepositoryLink {
  linkId: string;
  relation: RepositoryLinkRelation;
  repositoryId: string;
  subject: WorkManifestRef;
  target: { state: RepositoryStateRef } | { change: RepositoryChangeRef };
  publishedPath?: string;
}

/**
 * One attachment the export references.
 *
 * Bytes are **not** copied out: a sketch or a capture stays in the canonical
 * store, addressed by its digest, and the manifest records enough to find it
 * and to prove it did not change.
 */
export interface WorkManifestAttachment {
  blobId: string;
  mediaType: string;
  digest: string;
  bytes: number;
  /** The entity that references it, and through which field. */
  key: string;
  field: string;
}

/**
 * The machine-readable half of an export.
 *
 * Deliberately free of timestamps: the same work exports to the same bytes,
 * which is what makes a re-export a diff a person can read and a round trip
 * provable.
 */
export interface ProjectWorkManifest {
  format: typeof WORK_MANIFEST_FORMAT;
  version: typeof WORK_MANIFEST_VERSION;
  /** The product that wrote it, from the one identity constant. */
  product: string;
  project: { projectId: string };
  entities: WorkManifestEntity[];
  relations: WorkManifestRelation[];
  repositoryLinks: WorkManifestRepositoryLink[];
  attachments: WorkManifestAttachment[];
}

const manifestRefSchema = z
  .object({ entityId: projectWorkIdSchema, key: projectWorkKeySchema, revisionId: projectWorkRevisionIdSchema })
  .strict();

const exportRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), "a path inside the export")
  .refine((value) => !value.split("/").includes(".."), "a path that does not leave the export");

export const projectWorkManifestSchema = z
  .object({
    format: z.literal(WORK_MANIFEST_FORMAT),
    version: z.literal(WORK_MANIFEST_VERSION),
    product: z.string().min(1).max(120),
    project: z.object({ projectId: projectIdSchema }).strict(),
    entities: z
      .array(
        z
          .object({
            entityId: projectWorkIdSchema,
            key: projectWorkKeySchema,
            kind: projectWorkKindSchema,
            title: z.string().min(1).max(200),
            state: projectWorkStateSchema,
            archived: z.boolean(),
            revisionId: projectWorkRevisionIdSchema,
            revisionIndex: z.number().int().min(1),
            digest: projectWorkDigestSchema,
            bodyBytes: z.number().int().nonnegative(),
            document: exportRelativePath,
            body: exportRelativePath,
          })
          .strict(),
      )
      .max(WORK_EXPORT_ENTITIES_MAX),
    relations: z
      .array(
        z
          .object({
            relation: z.enum(PROJECT_WORK_EDGE_RELATIONS),
            subject: manifestRefSchema,
            object: manifestRefSchema,
            note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
          })
          .strict(),
      )
      .max(20_000),
    repositoryLinks: z
      .array(
        z
          .object({
            linkId: projectWorkIdSchema,
            relation: z.enum(REPOSITORY_LINK_RELATIONS),
            repositoryId: projectWorkIdSchema,
            subject: manifestRefSchema,
            target: z.union([
              z.object({ state: repositoryStateRefSchema }).strict(),
              z.object({ change: repositoryChangeRefSchema }).strict(),
            ]),
            publishedPath: z.string().min(1).max(1024).optional(),
          })
          .strict(),
      )
      .max(20_000),
    attachments: z
      .array(
        z
          .object({
            blobId: projectWorkIdSchema,
            mediaType: z.string().min(1).max(120),
            digest: projectWorkDigestSchema,
            bytes: z.number().int().nonnegative(),
            key: projectWorkKeySchema,
            field: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(20_000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/, "an idempotency key the caller minted");

/**
 * A path the caller may name: relative to the project, and unable to leave it.
 *
 * Absolute paths, drive letters and `..` segments are refused at the boundary
 * rather than resolved and checked later, so no method in this file can be
 * talked into reading or writing outside the project a person opened.
 */
const projectRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(value), "a path inside the project")
  .refine((value) => !value.split(/[\\/]/).includes(".."), "a path that does not leave the project");

export const projectWorkInteropParamsSchemas = {
  "project/work/import/preview": z
    .object({
      projectId: projectIdSchema,
      adapter: z.enum(WORK_IMPORT_ADAPTERS),
      path: projectRelativePath.optional(),
    })
    .strict(),
  "project/work/import/apply": z
    .object({
      projectId: projectIdSchema,
      adapter: z.enum(WORK_IMPORT_ADAPTERS),
      path: projectRelativePath.optional(),
      previewDigest: projectWorkDigestSchema,
      confirm: z.literal(true),
      decisions: z
        .array(z.object({ sourceId: z.string().min(1).max(300), choice: z.enum(WORK_IMPORT_CHOICES) }).strict())
        .max(WORK_IMPORT_PROPOSALS_MAX)
        .optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),

  "project/work/export/preview": z
    .object({
      projectId: projectIdSchema,
      path: projectRelativePath.optional(),
      mode: z.enum(WORK_EXPORT_MODES).optional(),
      includeArchived: z.boolean().optional(),
    })
    .strict(),
  "project/work/export/apply": z
    .object({
      projectId: projectIdSchema,
      path: projectRelativePath.optional(),
      mode: z.enum(WORK_EXPORT_MODES).optional(),
      includeArchived: z.boolean().optional(),
      previewDigest: projectWorkDigestSchema,
      confirm: z.literal(true),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),

  "project/work/publish/preview": z
    .object({ projectId: projectIdSchema, path: projectRelativePath.optional() })
    .strict(),
  "project/work/publish/apply": z
    .object({
      projectId: projectIdSchema,
      path: projectRelativePath.optional(),
      previewDigest: projectWorkDigestSchema,
      confirm: z.literal(true),
      commit: z.union([z.literal("HEAD"), z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id")]),
      checkpointId: z.string().min(1).max(200).optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
} as const;

export type ProjectWorkInteropMethod = keyof typeof projectWorkInteropParamsSchemas;

export const PROJECT_WORK_INTEROP_METHODS = Object.keys(projectWorkInteropParamsSchemas) as ProjectWorkInteropMethod[];

/** The three that write: to the store, to the project's files, or both. */
export const PROJECT_WORK_INTEROP_WRITE_METHODS: readonly ProjectWorkInteropMethod[] = [
  "project/work/import/apply",
  "project/work/export/apply",
  "project/work/publish/apply",
];

/**
 * The byte ceiling for one request of each method.
 *
 * All six are small by construction: a preview names a path and an apply names
 * a digest and its decisions. Nothing here carries a body, an export or a
 * file's content over the wire.
 */
export const PROJECT_WORK_INTEROP_METHOD_LIMITS: Readonly<Record<ProjectWorkInteropMethod, number>> = {
  "project/work/import/preview": 8 * 1024,
  "project/work/import/apply": 64 * 1024,
  "project/work/export/preview": 8 * 1024,
  "project/work/export/apply": 8 * 1024,
  "project/work/publish/preview": 8 * 1024,
  "project/work/publish/apply": 8 * 1024,
};

// ---------------------------------------------------------------------------
// Result schemas, for round-trip samples and clients that validate
// ---------------------------------------------------------------------------

export const workImportSourceRefSchema = z
  .object({
    adapter: z.enum(WORK_IMPORT_ADAPTERS),
    path: projectRelativePath,
    digest: projectWorkDigestSchema,
    licence: z.enum(SOURCE_LICENCES).optional(),
    licenceName: z.string().min(1).max(120).optional(),
    externalId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const workImportProposalSchema = z
  .object({
    sourceId: z.string().min(1).max(300),
    kind: projectWorkKindSchema,
    title: z.string().min(1).max(200),
    summary: z.string().max(500),
    source: workImportSourceRefSchema,
    match: z
      .object({
        entityId: projectWorkIdSchema,
        key: projectWorkKeySchema,
        title: z.string().max(200),
        digest: projectWorkDigestSchema,
        matchedBy: z.enum(WORK_IMPORT_CONFLICT_REASONS),
      })
      .strict()
      .optional(),
    conflict: z
      .object({ reason: z.enum(WORK_IMPORT_CONFLICT_REASONS), choices: z.array(z.enum(WORK_IMPORT_CHOICES)).min(1).max(3) })
      .strict()
      .optional(),
    action: z.enum(["create", "decide"]),
    notes: z.array(z.string().max(500)).max(16),
  })
  .strict();

export const workExportFileSchema = z
  .object({
    path: exportRelativePath,
    role: z.enum(WORK_EXPORT_FILE_ROLES),
    bytes: z.number().int().nonnegative(),
    digest: projectWorkDigestSchema,
    key: projectWorkKeySchema.optional(),
  })
  .strict();

export const projectWorkInteropResultSchemas = {
  manifest: projectWorkManifestSchema,
  proposal: workImportProposalSchema,
  exportFile: workExportFileSchema,
} as const;

/** The licence vocabulary an adapter may record, re-exported for adapters. */
export type WorkImportLicence = SourceLicence;
