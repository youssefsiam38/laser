/**
 * Project identity across relocation (M21-T20, leap "Relationship graph").
 *
 * A project's work is partitioned by a stable `projectId`, never by the folder
 * it happens to be open at (D-331). Two methods keep that promise when the
 * folder moves:
 *
 * - `project/work/identity` answers what a folder is, what its project holds,
 *   whether that work is hidden because the project was removed from the list,
 *   and — when the folder carries a marker naming another known project — the
 *   choice a person has.
 * - `project/work/relink` takes one of those choices, with the digest of the
 *   preview it was decided from and an explicit confirmation.
 *
 * The rule the pair exists to enforce is the contract's: *"Reattaching or
 * relocating the project reconnects the stable `projectId`; a path match alone
 * never merges two project histories."* So a marker found at a second live
 * folder is a question, never an automatic merge, and a folder that already
 * holds work of its own can never be reconnected into another history at all.
 *
 * The marker itself is one small file in the project's own configuration
 * directory (`<project>/.laser/project.json`, AGENTS.md invariant 6). It holds
 * an opaque id and nothing else: no path, no title, no work, nothing a person
 * has to keep in sync and nothing worth stealing.
 */
import { z } from "zod";
import { PROJECT_DIR_NAME } from "./identity.js";
import { projectIdSchema, projectWorkDigestSchema } from "./project-work.js";

// ---------------------------------------------------------------------------
// The marker file
// ---------------------------------------------------------------------------

/** The marker's file name inside the project's configuration directory. */
export const PROJECT_MARKER_FILE = "project.json";

/** Where it lives, relative to the project root. Never `.pi` (invariant 6). */
export const PROJECT_MARKER_PATH = `${PROJECT_DIR_NAME}/${PROJECT_MARKER_FILE}`;

/**
 * What the marker says.
 *
 * Deliberately not strict about extra keys: a future release may add one, and
 * an older release that refuses to read the id because of a field it does not
 * know would turn a relocation into a new, empty project.
 */
export interface ProjectMarker {
  version: 1;
  projectId: string;
}

export const projectMarkerSchema = z.object({ version: z.literal(1), projectId: projectIdSchema }).passthrough();

/** Parse marker bytes. Anything that is not a marker reads as absent. */
export function parseProjectMarker(text: string): ProjectMarker | undefined {
  try {
    const parsed = projectMarkerSchema.safeParse(JSON.parse(text));
    return parsed.success ? { version: 1, projectId: parsed.data.projectId } : undefined;
  } catch {
    return undefined;
  }
}

/** The bytes a marker is written as: stable, sorted, newline-terminated. */
export function projectMarkerJson(projectId: string): string {
  return `${JSON.stringify({ projectId, version: 1 }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Identity states
// ---------------------------------------------------------------------------

/**
 * What a folder's project identity is right now.
 *
 * - `linked` — the folder and its project agree, and the marker says so.
 * - `unmarked` — the folder has no marker and none could be written (a
 *   read-only checkout). Everything works; a later relocation will not
 *   reconnect by itself, and a person is told that rather than surprised.
 * - `conflict` — the folder's marker names another project this app knows,
 *   and that project's folder still exists. Two live folders claim one
 *   history, so the person chooses: reconnect here, or start fresh.
 * - `blocked` — the same, except this folder's own project already holds
 *   work. Reconnecting would merge two histories, so it is not offered.
 */
export const PROJECT_IDENTITY_STATES = ["linked", "unmarked", "conflict", "blocked"] as const;
export type ProjectIdentityState = (typeof PROJECT_IDENTITY_STATES)[number];

/** Which side of a conflict a relink takes. */
export const PROJECT_RELINK_CHOICES = ["reconnect", "fresh"] as const;
export type ProjectRelinkChoice = (typeof PROJECT_RELINK_CHOICES)[number];

/** What one side of the choice holds, for a preview a person reads. */
export interface ProjectIdentitySide {
  projectId: string;
  /** The folder this project is open at now, or the last one it was at. */
  path?: string;
  /** Its folder name, for copy that does not print a whole path. */
  name?: string;
  /** True when that folder is still on this machine. */
  pathExists: boolean;
  /** How much work it holds. Counted, never summarised by a model. */
  entities: number;
}

export interface ProjectIdentityParams {
  /** The folder being opened. A worktree resolves to its owner project. */
  cwd: string;
}

export interface ProjectIdentityResult {
  /** The project root the folder resolved to, canonicalised by the host. */
  cwd: string;
  /** The project this folder is part of right now. */
  projectId: string;
  state: ProjectIdentityState;
  /** This folder's own project, counted. */
  here: ProjectIdentitySide;
  /** The project the folder's marker names, when that is a different one. */
  marked?: ProjectIdentitySide;
  /** True when a marker file is on disk for this folder. */
  marker: boolean;
  /**
   * True when the project was removed from the person's list: its work is
   * retained and hidden until an explicit deletion.
   */
  hidden: boolean;
  /** One honest sentence about the state, written for a person. */
  detail: string;
  /** The choices this state offers, in the order a person should see them. */
  choices: ProjectRelinkChoice[];
  /**
   * The digest of the facts above. A relink carries it back, so a choice made
   * against a folder that has changed underneath is refused rather than
   * applied to something the person never saw.
   */
  previewDigest: string;
}

export interface ProjectRelinkParams {
  cwd: string;
  choice: ProjectRelinkChoice;
  /** The project the choice names: the marked one, or this folder's own. */
  projectId: string;
  previewDigest: string;
  confirm: true;
  idempotencyKey: string;
}

export interface ProjectRelinkResult {
  cwd: string;
  /** The project the folder belongs to after the choice. */
  projectId: string;
  choice: ProjectRelinkChoice;
  /** The project the folder belonged to before it, when that changed. */
  previousProjectId?: string;
  /**
   * True when reconnecting discarded the empty project this folder had been
   * given while it was unrecognised. Only ever an empty one.
   */
  discardedEmpty?: boolean;
  /** True when the marker on disk now names `projectId`. */
  marker: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/, "an idempotency key the caller minted");

export const projectWorkContinuityParamsSchemas = {
  "project/work/identity": z.object({ cwd: z.string().min(1).max(4096) }).strict(),
  "project/work/relink": z
    .object({
      cwd: z.string().min(1).max(4096),
      choice: z.enum(PROJECT_RELINK_CHOICES),
      projectId: projectIdSchema,
      previewDigest: projectWorkDigestSchema,
      confirm: z.literal(true),
      idempotencyKey,
    })
    .strict(),
} as const;

export type ProjectWorkContinuityMethod = keyof typeof projectWorkContinuityParamsSchemas;

export const PROJECT_WORK_CONTINUITY_METHODS = Object.keys(projectWorkContinuityParamsSchemas) as ProjectWorkContinuityMethod[];

/** The one that writes: it moves a folder from one project to another. */
export const PROJECT_WORK_CONTINUITY_WRITE_METHODS: readonly ProjectWorkContinuityMethod[] = ["project/work/relink"];

/** Both are small by construction: a folder, a choice, a digest. */
export const PROJECT_WORK_CONTINUITY_METHOD_LIMITS: Readonly<Record<ProjectWorkContinuityMethod, number>> = {
  "project/work/identity": 8 * 1024,
  "project/work/relink": 8 * 1024,
};

// ---------------------------------------------------------------------------
// Result schemas, for round-trip samples and clients that validate
// ---------------------------------------------------------------------------

export const projectIdentitySideSchema = z
  .object({
    projectId: projectIdSchema,
    path: z.string().min(1).max(4096).optional(),
    name: z.string().min(1).max(255).optional(),
    pathExists: z.boolean(),
    entities: z.number().int().nonnegative(),
  })
  .strict();

export const projectIdentityResultSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    projectId: projectIdSchema,
    state: z.enum(PROJECT_IDENTITY_STATES),
    here: projectIdentitySideSchema,
    marked: projectIdentitySideSchema.optional(),
    marker: z.boolean(),
    hidden: z.boolean(),
    detail: z.string().min(1).max(2000),
    choices: z.array(z.enum(PROJECT_RELINK_CHOICES)).max(2),
    previewDigest: projectWorkDigestSchema,
  })
  .strict();

export const projectRelinkResultSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    projectId: projectIdSchema,
    choice: z.enum(PROJECT_RELINK_CHOICES),
    previousProjectId: projectIdSchema.optional(),
    discardedEmpty: z.boolean().optional(),
    marker: z.boolean(),
    detail: z.string().min(1).max(2000),
  })
  .strict();
