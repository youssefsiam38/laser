/**
 * Bounded canonical captures: keeping accepted evidence reviewable (M21-T18).
 *
 * D-345's hardest rule is not about links, it is about what happens to them
 * later. A repository link used to approve an artifact, accept delivery or
 * mark a Task done **must remain reviewable**. Git is not a promise: a
 * checkpoint ref is pruned by retention, a branch is force-pushed, a clone
 * arrives without its history. So before Laser accepts one of those decisions
 * it stores, in its own content-addressed store, the bounded diff manifest and
 * the source captures the decision would need to be reviewed — and only then
 * accepts.
 *
 * Two bounds and one refusal shape the module:
 *
 * - **Bounded, always.** At most {@link REPOSITORY_CAPTURE_FILES_MAX} files in
 *   the manifest, {@link REPOSITORY_CAPTURE_SOURCES_MAX} files captured whole,
 *   {@link REPOSITORY_CAPTURE_SOURCE_BYTES_MAX} of each, and
 *   {@link REPOSITORY_CAPTURE_BYTES_MAX} altogether. A capture that hits a
 *   bound says what it left out, in a sentence; it never silently becomes a
 *   partial record that reads as a complete one.
 * - **Binary and deleted files are named, not copied.** The manifest keeps
 *   their path, status, counts and blob id; their bytes are not evidence a
 *   person reads.
 * - **A full durable budget refuses the gate.** Digest-only evidence is not
 *   evidence, so the decision does not happen and the refusal says what to
 *   free (leap, "Repository provenance").
 */
import {
  REPOSITORY_CAPTURE_BYTES_MAX,
  REPOSITORY_CAPTURE_FILES_MAX,
  REPOSITORY_CAPTURE_MEDIA_TYPE,
  REPOSITORY_CAPTURE_SOURCES_MAX,
  REPOSITORY_CAPTURE_SOURCE_BYTES_MAX,
  type RepositoryCapture,
  type RepositoryCaptureFile,
  type RepositoryCaptureSource,
  type RepositoryChangeRef,
  type RepositoryLink,
  type RepositoryStateRef,
} from "@lasercode/protocol";
import { fileAt, parentsOf, treeManifest, type HostRepository } from "../source-control/read.js";
import { diffBetween } from "../source-control/read.js";
import { ProjectWorkQuotaError, ProjectWorkRefusedError } from "./errors.js";
import { canonicalJson, sha256 } from "./ids.js";

/** What building and storing a capture needs from the store. */
export interface CaptureStore {
  putBlob(input: { projectId: string; entityId?: string | undefined; mediaType: string; data: Uint8Array }): {
    blobId: string;
    bytes: number;
  };
  readBlob(input: { projectId: string; blobId: string; offset?: number; limit?: number }):
    | { bytes: number; released?: { reason: string; detail: string }; corrupt?: true }
    | undefined;
}

export interface StoredCapture {
  blobId: string;
  bytes: number;
  files: number;
  sources: number;
  truncated?: string;
}

/**
 * Read one change out of git as the bounded record of what it was.
 *
 * `undefined` when git can no longer answer — the objects are gone — which is
 * what makes "capture it while it is still there" a rule rather than a hope.
 */
export async function buildCapture(input: {
  repository: HostRepository;
  repositoryId: string;
  change: RepositoryChangeRef;
  now: string;
}): Promise<RepositoryCapture | undefined> {
  const diff = await diffBetween(input.repository, input.change.base.commitObjectId, input.change.head.commitObjectId);
  if (!diff) return undefined;

  const notes: string[] = [];
  const all = diff.files;
  const kept = all.slice(0, REPOSITORY_CAPTURE_FILES_MAX);
  if (all.length > kept.length) {
    notes.push(`${String(all.length - kept.length)} more changed files are not listed.`);
  }

  const files: RepositoryCaptureFile[] = [];
  const sources: RepositoryCaptureSource[] = [];
  let budget = REPOSITORY_CAPTURE_BYTES_MAX;
  let capturedCount = 0;
  let skippedForBudget = 0;

  for (const file of kept) {
    const row: RepositoryCaptureFile = {
      path: file.path,
      status: file.status,
      added: file.added,
      removed: file.removed,
      ...(file.blobObjectId ? { blobObjectId: file.blobObjectId } : {}),
    };
    if (file.status === "deleted") {
      files.push({ ...row, omitted: "deleted" });
      continue;
    }
    if (capturedCount >= REPOSITORY_CAPTURE_SOURCES_MAX || budget <= 0) {
      files.push({ ...row, omitted: "budget" });
      skippedForBudget += 1;
      continue;
    }
    const bytes = await fileAt(
      input.repository,
      input.change.head.commitObjectId,
      file.path,
      Math.min(REPOSITORY_CAPTURE_SOURCE_BYTES_MAX, budget),
    );
    if (!bytes) {
      files.push({ ...row, omitted: "budget" });
      continue;
    }
    if (bytes.binary) {
      // Its identity and its true size are the record; its bytes are not
      // something a person reviews, and decoding them would be a lie about
      // what the file is (review F9).
      files.push({ ...row, bytes: bytes.bytes, omitted: "binary" });
      continue;
    }
    if (bytes.bytes > REPOSITORY_CAPTURE_SOURCE_BYTES_MAX && bytes.truncated) {
      // Kept, and labelled: the first 128 KiB of a very large file is still
      // the part a review reads, and the row says it is not the whole file.
      notes.push(`${file.path} was captured up to its first ${String(Math.round(REPOSITORY_CAPTURE_SOURCE_BYTES_MAX / 1024))} KB.`);
    }
    const contentDigest = sha256(bytes.text);
    sources.push({
      path: file.path,
      bytes: bytes.bytes,
      ...(bytes.truncated ? { truncated: true } : {}),
      contentDigest,
      text: bytes.text,
    });
    files.push({ ...row, bytes: bytes.bytes, contentDigest });
    budget -= Buffer.byteLength(bytes.text, "utf8");
    capturedCount += 1;
  }

  if (skippedForBudget > 0) {
    notes.push(`${String(skippedForBudget)} files are listed without their source, to keep this capture bounded.`);
  }

  return {
    version: 1,
    createdAt: input.now,
    repositoryId: input.repositoryId,
    repositoryName: input.repository.name,
    change: input.change,
    files,
    sources,
    ...(notes.length > 0 ? { truncated: notes.join(" ") } : {}),
  };
}

/**
 * Read one **state** out of git as the bounded record of what it was
 * (D-361, review F1).
 *
 * A state link names one commit and no difference, and an M20 checkpoint
 * commit is parentless and reachable only through a ref that routine retention
 * prunes. So there are two shapes, and which one is used is decided by git
 * rather than by the caller:
 *
 * - **A parented commit** captures its own difference, `commit^ → commit`:
 *   the smallest complete record of what it introduced.
 * - **A parentless commit** — every checkpoint — captures a bounded manifest
 *   of its whole tree: path, mode and blob object id, which stay true as
 *   identity after gc has reclaimed the objects, plus the source of as many of
 *   those files as the budget allows.
 *
 * `undefined` when git can no longer answer, which is what makes "capture it
 * before you accept it" a rule rather than a hope.
 */
export async function buildStateCapture(input: {
  repository: HostRepository;
  repositoryId: string;
  state: RepositoryStateRef;
  now: string;
  /** Paths whose source the decision needs; the rest are manifest-only. */
  requiredPaths?: readonly string[];
}): Promise<RepositoryCapture | undefined> {
  const parents = await parentsOf(input.repository, input.state.commitObjectId);
  const parent = parents[0];
  if (parent !== undefined) {
    const change: RepositoryChangeRef = {
      base: { ...input.state, commitObjectId: parent },
      head: input.state,
      diffDigest: (await diffBetween(input.repository, parent, input.state.commitObjectId))?.digest ?? "",
    };
    if (change.diffDigest === "") return undefined;
    const captured = await buildCapture({
      repository: input.repository,
      repositoryId: input.repositoryId,
      change,
      now: input.now,
    });
    if (!captured) return undefined;
    // The record is about the state that was accepted, not about a difference
    // nobody named; the difference is how its bytes were found.
    const { change: _change, ...rest } = captured;
    void _change;
    return { ...rest, state: input.state };
  }

  const entries = await treeManifest(input.repository, input.state.commitObjectId, REPOSITORY_CAPTURE_FILES_MAX + 1);
  if (!entries) return undefined;
  const notes: string[] = [];
  const kept = entries.slice(0, REPOSITORY_CAPTURE_FILES_MAX);
  if (entries.length > kept.length) notes.push(`${String(entries.length - kept.length)} more files are not listed.`);

  const required = new Set(input.requiredPaths ?? []);
  // Required sources come first, so a budget that runs out never costs the
  // files the decision actually rests on.
  const ordered = [...kept].sort((a, b) => Number(required.has(b.path)) - Number(required.has(a.path)));
  const files: RepositoryCaptureFile[] = [];
  const sources: RepositoryCaptureSource[] = [];
  let budget = REPOSITORY_CAPTURE_BYTES_MAX;
  let capturedCount = 0;
  let skippedForBudget = 0;
  const missingRequired: string[] = [];

  for (const entry of ordered) {
    const row: RepositoryCaptureFile = {
      path: entry.path,
      status: "present",
      added: null,
      removed: null,
      blobObjectId: entry.blobObjectId,
      mode: entry.mode,
      bytes: entry.bytes,
    };
    if (capturedCount >= REPOSITORY_CAPTURE_SOURCES_MAX || budget <= 0) {
      files.push({ ...row, omitted: "budget" });
      skippedForBudget += 1;
      if (required.has(entry.path)) missingRequired.push(entry.path);
      continue;
    }
    const bytes = await fileAt(
      input.repository,
      input.state.commitObjectId,
      entry.path,
      Math.min(REPOSITORY_CAPTURE_SOURCE_BYTES_MAX, budget),
    );
    if (!bytes) {
      files.push({ ...row, omitted: "budget" });
      if (required.has(entry.path)) missingRequired.push(entry.path);
      continue;
    }
    if (bytes.binary) {
      files.push({ ...row, omitted: "binary" });
      continue;
    }
    if (bytes.truncated) {
      notes.push(`${entry.path} was captured up to its first ${String(Math.round(REPOSITORY_CAPTURE_SOURCE_BYTES_MAX / 1024))} KB.`);
      if (required.has(entry.path)) missingRequired.push(entry.path);
    }
    const contentDigest = sha256(bytes.text);
    sources.push({
      path: entry.path,
      bytes: bytes.bytes,
      ...(bytes.truncated ? { truncated: true } : {}),
      contentDigest,
      text: bytes.text,
    });
    files.push({ ...row, contentDigest });
    budget -= Buffer.byteLength(bytes.text, "utf8");
    capturedCount += 1;
  }

  // A required source that could not be kept whole means the decision would
  // rest on a placeholder. That is not durable proof, so it is refused rather
  // than stored as if it were (D-361).
  if (missingRequired.length > 0) {
    throw new ProjectWorkRefusedError(
      `This state could not be kept where it can still be read: ${missingRequired.slice(0, 3).join(", ")}` +
        `${missingRequired.length > 3 ? ` and ${String(missingRequired.length - 3)} more` : ""} did not fit in a bounded capture. ` +
        `Accept a smaller change, or free space in this project's work, and try again.`,
    );
  }
  if (skippedForBudget > 0) {
    notes.push(`${String(skippedForBudget)} files are listed without their source, to keep this capture bounded.`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    createdAt: input.now,
    repositoryId: input.repositoryId,
    repositoryName: input.repository.name,
    state: input.state,
    files,
    sources,
    ...(notes.length > 0 ? { truncated: notes.join(" ") } : {}),
  };
}

/**
 * Put one capture in the content-addressed store.
 *
 * Canonical JSON, so the same capture of the same change is the same bytes and
 * therefore the same blob: accepting the same delivery twice costs one copy. A
 * full budget comes back as the gate's refusal, never as an accepted decision
 * with nothing behind it.
 */
export function storeCapture(
  store: CaptureStore,
  input: { projectId: string; entityId?: string | undefined; capture: RepositoryCapture; gate: string },
): StoredCapture {
  const data = Buffer.from(canonicalJson(input.capture), "utf8");
  let stored: { blobId: string; bytes: number };
  try {
    stored = store.putBlob({
      projectId: input.projectId,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      mediaType: REPOSITORY_CAPTURE_MEDIA_TYPE,
      data,
    });
  } catch (error) {
    if (error instanceof ProjectWorkQuotaError) throw gateRefusedForSpace(error, input.gate);
    throw error;
  }
  return {
    blobId: stored.blobId,
    bytes: stored.bytes,
    files: input.capture.files.length,
    sources: input.capture.sources.length,
    ...(input.capture.truncated ? { truncated: input.capture.truncated } : {}),
  };
}

/**
 * The same refusal a full budget always gives, said in the words of the thing
 * it stopped: a person asked to approve or complete, and the answer is that
 * the evidence cannot be kept, plus what to free.
 */
function gateRefusedForSpace(error: ProjectWorkQuotaError, gate: string): ProjectWorkQuotaError {
  return new ProjectWorkQuotaError(
    error.scope,
    error.usedBytes,
    error.limitBytes,
    `${gate} needs its repository evidence kept where it can still be read, and there is no room for it. ${error.recovery}`,
  );
}

/** Is this link's capture still readable, bytes and all? */
export function captureReadable(store: CaptureStore, projectId: string, link: RepositoryLink): boolean {
  if (!link.captureBlobId) return false;
  const range = store.readBlob({ projectId, blobId: link.captureBlobId, offset: 0, limit: 1 });
  return range !== undefined && range.released === undefined && range.corrupt !== true;
}

/**
 * The refusal a decision gets when its evidence is already gone.
 *
 * It names the relation and the commit, because "this cannot be approved" with
 * no subject is the kind of error this product does not ship.
 */
export function evidenceUnreviewable(link: RepositoryLink, missing: readonly string[], gate: string): ProjectWorkRefusedError {
  const what = link.relation === "implemented_by" ? "a change" : "a state";
  const which = missing[0] ? ` (${missing[0].slice(0, 12)})` : "";
  return new ProjectWorkRefusedError(
    `${gate} rests on ${what}${which} that is no longer in the repository, and nothing was captured from it while it was. ` +
      `Record it again from a commit or a checkpoint that is still there, or remove that link before deciding.`,
  );
}
