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
  REQUIRED_PATHS_MAX,
  repositoryCaptureSchema,
  type RepositoryCapture,
  type RepositoryCaptureBasis,
  type RepositoryCaptureFile,
  type RepositoryCaptureRequired,
  type RepositoryCaptureRequiredEntry,
  type RepositoryCaptureSource,
  type RepositoryChangeRef,
  type RepositoryLink,
  type RepositoryStateRef,
} from "@lasercode/protocol";
import { sameChange, sameState, type ExpectedRequiredFacts } from "./required-facts.js";
import { commitExists, fileAt, fileSizeAt, parentsOf, treeListing, treeManifest, type HostRepository } from "../source-control/read.js";
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
    | {
        bytes: number;
        totalBytes?: number;
        data?: Uint8Array | undefined;
        nextOffset?: number | undefined;
        released?: { reason: string; detail: string };
        corrupt?: true;
      }
    | undefined;
}

export interface StoredCapture {
  blobId: string;
  bytes: number;
  files: number;
  sources: number;
  truncated?: string;
}

// ---------------------------------------------------------------------------
// The sources a decision rests on (M21-T19, review F1)
// ---------------------------------------------------------------------------

/** Where a required set came from, as the capture records it. */
export interface RequiredOrigin {
  basis: RepositoryCaptureBasis;
  /** The commit the difference was taken from. */
  base: string;
  executionLinkId?: string | undefined;
  taskEntityId?: string | undefined;
  /** A bounded scope to keep whole when there is no difference at all. */
  scopePath?: string | undefined;
}

/** One source the decision needs, and the commit its body is read at. */
interface RequiredRow {
  path: string;
  status: RepositoryCaptureRequiredEntry["status"];
  side: "before" | "after";
  /** The commit this body is read at: the state for an after side, the base for a before. */
  at: string;
}

/** The required set, selected out of git and not yet read. */
export interface RequiredSet {
  basis: RepositoryCaptureBasis;
  from: RepositoryCaptureRequired["from"];
  rows: RequiredRow[];
}

/** What reading the required set produced, ready to go into a capture. */
interface CapturedRequired {
  sources: RepositoryCaptureSource[];
  required: RepositoryCaptureRequired;
  bytesUsed: number;
  /** The after-side paths whose body is already in `sources`, by path. */
  captured: Map<string, RepositoryCaptureSource>;
}

/**
 * Which sources one decision rests on, decided by git and never by a caller
 * (M21-T19).
 *
 * The set is the difference between the commit the work started from and the
 * **exact** state being decided about — not an attempt's first-to-last
 * aggregate, which omits what the first checkpoint already changed and
 * includes what a later one reverted, and not whatever is at `HEAD`.
 *
 * `--no-renames` is what makes a rename two rows, a delete and an add, which
 * is exactly the two bodies a review of a rename needs; a delete is reviewed
 * by reading what was removed, so its body is the one at the base.
 *
 * Two refusals live here rather than downstream, because a decision made on a
 * set that could not be established is the thing this whole module exists to
 * prevent:
 *
 * - a base git no longer has: there is no difference to take, and inventing
 *   one from `HEAD` would describe a decision nobody made;
 * - a listing git could not produce or that ran past its bound: a truncated
 *   required set is not a required set.
 *
 * When the difference is **empty** the state is byte-identical to what the
 * work started from, and a person may perfectly well have verified code that
 * did not need changing. Demanding a fabricated edit before they may say so
 * would be the wrong refusal, so what is kept instead is the *complete* body
 * of one explicitly named bounded scope — the link's own `path` when it has
 * one, otherwise the tracked tree, and only when that whole scope fits inside
 * the existing bounds. It is a bounded canonical capture of a named scope, not
 * a repository backup: nothing is kept as a prefix, nothing is traversed past
 * the file cap, and a scope that is empty or cannot be kept whole is refused
 * for that exact reason.
 */
export async function selectRequired(input: {
  repository: HostRepository;
  origin: RequiredOrigin;
  /** The commit being decided about: a state's commit, or a change's head. */
  at: string;
}): Promise<RequiredSet> {
  const { repository, origin } = input;
  if (!(await commitExists(repository, origin.base))) {
    throw new ProjectWorkRefusedError(
      "The commit this work started from is not in the repository any more, so what it changed cannot be worked out and there would be nothing complete to review later. " +
        "Record this against a checkpoint whose starting point is still there, or start a new attempt from the code as it is now.",
    );
  }
  const diff = await diffBetween(repository, origin.base, input.at);
  if (!diff) {
    throw new ProjectWorkRefusedError(
      "The difference between where this work started and the state you named could not be read out of the repository, so what it rests on cannot be established. " +
        "Try again, or record this against a commit or checkpoint that is still there.",
    );
  }

  const from: RepositoryCaptureRequired["from"] = {
    baseCommitObjectId: origin.base,
    ...(origin.executionLinkId ? { executionLinkId: origin.executionLinkId } : {}),
    ...(origin.taskEntityId ? { taskEntityId: origin.taskEntityId } : {}),
  };

  if (diff.files.length > 0) {
    const rows: RequiredRow[] = diff.files.map((file) => ({
      path: file.path,
      status: file.status,
      side: file.status === "deleted" ? ("before" as const) : ("after" as const),
      at: file.status === "deleted" ? origin.base : input.at,
    }));
    if (rows.length > REQUIRED_PATHS_MAX) {
      throw new ProjectWorkRefusedError(
        `This covers ${String(rows.length)} files, and a decision is kept reviewable by keeping every one of them whole — at most ${String(REQUIRED_PATHS_MAX)}. ` +
          "Decide on a smaller piece of work: record it at an earlier checkpoint, or split the task and accept each part.",
      );
    }
    return { basis: origin.basis, from, rows };
  }

  // Nothing changed. What is kept whole is the named scope itself — and the
  // scope is what git is asked about, not what a whole-tree listing is filtered
  // down to afterwards. Enumerating everything and filtering second gives two
  // false answers: a scope that sorts past the bound reads as "not in the
  // repository", and a scope preceded by more unrelated files than the bound
  // reads as complete while holding a prefix of itself (review F1).
  const scope = origin.scopePath;
  const listing = await treeListing(repository, input.at, REQUIRED_PATHS_MAX, scope);
  if (!listing) {
    throw new ProjectWorkRefusedError(
      "Nothing changed between where this work started and the state you named, and the files at that state could not be listed, so there is nothing complete to keep. " +
        "Record this against a state that is still readable.",
    );
  }
  if (listing.rows.length === 0 && listing.unreadable.length === 0) {
    throw new ProjectWorkRefusedError(
      scope === undefined
        ? "Nothing changed here and there are no files at that state, so there is nothing for anyone to have reviewed. Record this against a state that has the code in it."
        : `Nothing changed here and ${scope} is not in the repository at that state, so there is nothing for anyone to have reviewed. Name a path that is there, or record this at a state that has it.`,
    );
  }
  if (listing.truncated) {
    // "More than" and never an exact count: the listing stopped at the bound,
    // so how many there really are is something this read does not know.
    throw new ProjectWorkRefusedError(
      `Nothing changed here, so what would be kept is ${scope ?? "everything tracked at that state"} in full — more than the ${String(REQUIRED_PATHS_MAX)} files a decision may rest on. ` +
        "Name the part of the repository this decision is about, and record it against that.",
    );
  }
  const unreadable = listing.unreadable[0];
  if (unreadable) {
    throw new ProjectWorkRefusedError(
      unreadable.kind === "gitlink"
        ? `Nothing changed here, and ${unreadable.path} is another repository recorded inside this one, so its code is not in this state and could not be kept where a person can still read it. ` +
          "Name a part of the repository whose files are all here, and record this against that."
        : `Nothing changed here, and ${unreadable.path} could not be read out of the repository as a file, so what would be kept would not be the whole of what you named. ` +
          "Name a part of the repository whose files can all be read, and record this against that.",
    );
  }
  return {
    basis: "complete_bounded_state",
    from: { ...from, ...(scope !== undefined ? { scopePath: scope } : {}) },
    rows: listing.rows.map((entry) => ({ path: entry.path, status: "present" as const, side: "after" as const, at: input.at })),
  };
}

/**
 * Read every required body whole, or refuse — never a placeholder.
 *
 * Looked up **directly by path**, before any bounded listing is walked, so a
 * required file that sits past the manifest's cap is still kept: nothing about
 * the set a decision rests on depends on where a file happens to sort.
 *
 * Four refusals, each naming what it found. A body that is not text a person
 * can read, a body that would only be kept as a prefix, a body git does not
 * have on the side the difference says it should be on, and a set that does
 * not fit inside the existing budget. None of them is a larger budget, a
 * second store or a copy of the repository.
 */
async function captureRequired(repository: HostRepository, set: RequiredSet, budget: number): Promise<CapturedRequired> {
  const sources: RepositoryCaptureSource[] = [];
  const entries: RepositoryCaptureRequiredEntry[] = [];
  const captured = new Map<string, RepositoryCaptureSource>();
  let left = budget;

  for (const row of [...set.rows].sort((a, b) => a.path.localeCompare(b.path))) {
    const read = await fileAt(repository, row.at, row.path, REPOSITORY_CAPTURE_SOURCE_BYTES_MAX);
    if (!read) {
      // Why it could not be read decides what to say about it: a path the
      // repository does not have on that side is a contradiction, a path too
      // big to keep whole is a bound, and anything else is a read this process
      // cannot account for — none of which is "captured".
      const size = await fileSizeAt(repository, row.at, row.path);
      if (size === undefined) throw requiredMissing(row);
      if (size > REPOSITORY_CAPTURE_SOURCE_BYTES_MAX) throw requiredTooLarge(row, size);
      throw new ProjectWorkRefusedError(
        `${row.path} could not be read out of the repository as text, so nothing of it could be kept where a person can still read it. ` +
          "Record this against a state whose files can all be read, or record what you checked about that file as evidence instead.",
      );
    }
    if (read.binary) {
      throw new ProjectWorkRefusedError(
        `${row.path} is not text, so nothing about it could be kept where a person can still read it, and a decision that rests on it could not be reviewed later. ` +
          "Decide on work whose files can be read as text, or record what you checked about that file as evidence instead.",
      );
    }
    if (read.truncated) throw requiredTooLarge(row, read.bytes);
    const cost = Buffer.byteLength(read.text, "utf8");
    if (cost > left) {
      throw new ProjectWorkRefusedError(
        `Keeping every file this rests on would take more than the ${String(Math.round(REPOSITORY_CAPTURE_BYTES_MAX / 1024 / 1024))} MB a single decision's evidence may use, and ${row.path} is where it ran out. ` +
          "Decide on a smaller piece of work: record it at an earlier checkpoint, or split the task and accept each part.",
      );
    }
    left -= cost;
    const contentDigest = sha256(read.text);
    const source: RepositoryCaptureSource = {
      path: row.path,
      bytes: read.bytes,
      contentDigest,
      text: read.text,
      side: row.side,
    };
    sources.push(source);
    if (row.side === "after") captured.set(row.path, source);
    entries.push({
      path: row.path,
      status: row.status,
      side: row.side,
      contentDigest,
      ...(read.blobObjectId ? { blobObjectId: read.blobObjectId } : {}),
    });
  }

  return {
    sources,
    required: { basis: set.basis, from: set.from, entries, complete: true },
    bytesUsed: budget - left,
    captured,
  };
}

function requiredMissing(row: RequiredRow): ProjectWorkRefusedError {
  const side = row.side === "before" ? "before this work started" : "at the state you named";
  return new ProjectWorkRefusedError(
    `${row.path} is recorded as ${row.status} here, but the repository does not have it ${side}, so what this rests on contradicts itself and cannot be kept. ` +
      "Record this against a commit or checkpoint that is still exactly as it was.",
  );
}

function requiredTooLarge(row: RequiredRow, bytes: number): ProjectWorkRefusedError {
  return new ProjectWorkRefusedError(
    `${row.path} is ${String(Math.round(bytes / 1024))} KB, more than the ${String(Math.round(REPOSITORY_CAPTURE_SOURCE_BYTES_MAX / 1024))} KB one file's evidence may take, so only part of it could be kept — and part of a file is not what a decision rests on. ` +
      "Decide on work whose files can be kept whole, or record what you checked about that file as evidence instead.",
  );
}

/**
 * Does this capture prove every source its decision rests on, from what is
 * stored alone — and is it a capture of **this** link?
 *
 * Two halves, and the second one is the one review F2 found missing:
 *
 * - the entries are checked against the bodies beside them — same path, same
 *   side, same digest, and the digest re-taken over the text that is actually
 *   there. A capture whose block and bodies disagree proves nothing, whoever
 *   wrote it;
 * - and, when the caller says which link this is supposed to prove, the
 *   capture's own repository, target, basis, base, scope and attempt are
 *   checked against what the **record** says they must be
 *   ({@link expectedRequiredFacts}). Internal consistency is not identity: a
 *   flawless capture of another repository, another ref, another path or
 *   another attempt's base is a capture of something else.
 *
 * The expectation is omitted only where there is nothing to check it against.
 */
export function requiredComplete(capture: RepositoryCapture, expected?: ExpectedRequiredFacts): boolean {
  const required = capture.required;
  if (!required || required.complete !== true || required.entries.length === 0) return false;
  if (expected !== undefined && !provesLink(capture, required, expected)) return false;
  return required.entries.every((entry) => {
    const source = capture.sources.find((row) => row.path === entry.path && (row.side ?? "after") === entry.side);
    if (!source || source.truncated === true) return false;
    if (source.contentDigest !== entry.contentDigest) return false;
    return sha256(source.text) === entry.contentDigest;
  });
}

/** Is this a capture of the link the record describes, taken the way that link allows? */
function provesLink(capture: RepositoryCapture, required: RepositoryCaptureRequired, expected: ExpectedRequiredFacts): boolean {
  // A record the store could not resolve proves nothing in either direction,
  // and the honest answer to "is this complete" is then no.
  if (expected.unresolved !== undefined) return false;
  if (capture.repositoryId !== expected.repositoryId) return false;
  if ("state" in expected.target) {
    if (!capture.state || !sameState(capture.state, expected.target.state)) return false;
  } else if (!capture.change || !sameChange(capture.change, expected.target.change)) {
    return false;
  }
  if (!expected.bases.includes(required.basis)) return false;
  // The base is checked wherever the record knows it. `commit_parent_to_commit`
  // is the exception on purpose: its base is the commit's own parent, which is
  // a fact about git rather than one the record holds.
  if (required.basis !== "commit_parent_to_commit" && expected.baseCommitObjectId !== undefined) {
    if (required.from.baseCommitObjectId !== expected.baseCommitObjectId) return false;
  }
  if (required.basis === "complete_bounded_state" && required.from.scopePath !== expected.scopePath) return false;
  if (required.from.executionLinkId !== expected.executionLinkId) return false;
  return required.from.taskEntityId === expected.taskEntityId;
}

/** One link's stored capture, parsed — never cast, never re-read from git. */
export function readCapture(store: CaptureStore, projectId: string, link: RepositoryLink): RepositoryCapture | undefined {
  if (!link.captureBlobId) return undefined;
  return readCaptureBlob(store, projectId, link.captureBlobId);
}

/**
 * One **exact** stored capture, by content address.
 *
 * What a decision bound when it was made is a blob id, not a link's current
 * pointer (D-363), so reading the proof a decision rested on is a different
 * question from reading the proof a link points at today — and it has its own
 * door.
 */
export function readCaptureBlob(store: CaptureStore, projectId: string, blobId: string): RepositoryCapture | undefined {
  const range = store.readBlob({ projectId, blobId, offset: 0, limit: REPOSITORY_CAPTURE_BYTES_MAX + 1024 * 1024 });
  if (!range || range.released !== undefined || range.corrupt === true || !range.data) return undefined;
  if (range.nextOffset !== undefined) return undefined;
  try {
    const parsed = repositoryCaptureSchema.safeParse(JSON.parse(Buffer.from(range.data).toString("utf8")));
    return parsed.success ? (parsed.data as RepositoryCapture) : undefined;
  } catch {
    return undefined;
  }
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
  /**
   * The sources this capture's decision rests on, selected out of git. Every
   * one of them is kept whole before the bounded listing fills what is left,
   * or the decision is refused (M21-T19).
   */
  required?: RequiredSet | undefined;
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
  let budget = REPOSITORY_CAPTURE_BYTES_MAX;
  const proof = input.required ? await captureRequired(input.repository, input.required, budget) : undefined;
  const sources: RepositoryCaptureSource[] = proof ? [...proof.sources] : [];
  if (proof) budget -= proof.bytesUsed;
  let capturedCount = sources.length;
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
      // The head side of a deleted file is nothing, and says so. What a review
      // of a delete reads is the body at the base, which the required block
      // carries with `side: "before"`.
      files.push({ ...row, omitted: "deleted" });
      continue;
    }
    const already = proof?.captured.get(file.path);
    if (already) {
      files.push({ ...row, bytes: already.bytes, contentDigest: already.contentDigest });
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
    ...(proof ? { required: proof.required } : {}),
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
  /**
   * The sources this capture's decision rests on (M21-T19).
   *
   * A **parentless** state — every M20 checkpoint — takes the set as given,
   * derived from the attempt this state came out of. A **parented** commit
   * derives its own from `commit^ → commit`, which is the same rule read off
   * the only base such a commit has.
   */
  required?: RequiredOrigin | undefined;
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
    // A parented commit's own parent is its base, whatever an attempt recorded:
    // the smallest complete record of what that commit introduced.
    const required = input.required
      ? await selectRequired({
          repository: input.repository,
          origin: {
            ...input.required,
            basis: "commit_parent_to_commit",
            base: parent,
            ...(input.state.path !== undefined ? { scopePath: input.state.path } : {}),
          },
          at: input.state.commitObjectId,
        })
      : undefined;
    const captured = await buildCapture({
      repository: input.repository,
      repositoryId: input.repositoryId,
      change,
      now: input.now,
      ...(required ? { required } : {}),
    });
    if (!captured) return undefined;
    // The record is about the state that was accepted, not about a difference
    // nobody named; the difference is how its bytes were found.
    const { change: _change, ...rest } = captured;
    void _change;
    return { ...rest, state: input.state };
  }

  // The sources the decision rests on are read directly by path, before any
  // listing is walked and whatever its cap is: a required file that sorts past
  // the five-hundredth entry of a tree is still kept whole.
  const proof = input.required
    ? await captureRequired(
        input.repository,
        await selectRequired({
          repository: input.repository,
          origin: {
            ...input.required,
            ...(input.state.path !== undefined ? { scopePath: input.state.path } : {}),
          },
          at: input.state.commitObjectId,
        }),
        REPOSITORY_CAPTURE_BYTES_MAX,
      )
    : undefined;

  const entries = await treeManifest(input.repository, input.state.commitObjectId, REPOSITORY_CAPTURE_FILES_MAX + 1);
  if (!entries) return undefined;
  const notes: string[] = [];
  const kept = entries.slice(0, REPOSITORY_CAPTURE_FILES_MAX);
  if (entries.length > kept.length) {
    // Said as what it is: a listing of the first N files of the tree, never a
    // tree the capture claims to have read whole.
    notes.push(`This listing covers the first ${String(kept.length)} files of the tree; ${String(entries.length - kept.length)} more are not listed.`);
  }

  const files: RepositoryCaptureFile[] = [];
  const sources: RepositoryCaptureSource[] = proof ? [...proof.sources] : [];
  let budget = REPOSITORY_CAPTURE_BYTES_MAX - (proof?.bytesUsed ?? 0);
  let capturedCount = sources.length;
  let skippedForBudget = 0;

  for (const entry of kept) {
    const row: RepositoryCaptureFile = {
      path: entry.path,
      status: "present",
      added: null,
      removed: null,
      blobObjectId: entry.blobObjectId,
      mode: entry.mode,
      bytes: entry.bytes,
    };
    const already = proof?.captured.get(entry.path);
    if (already) {
      files.push({ ...row, contentDigest: already.contentDigest });
      continue;
    }
    if (capturedCount >= REPOSITORY_CAPTURE_SOURCES_MAX || budget <= 0) {
      files.push({ ...row, omitted: "budget" });
      skippedForBudget += 1;
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
      continue;
    }
    if (bytes.binary) {
      files.push({ ...row, omitted: "binary" });
      continue;
    }
    if (bytes.truncated) {
      notes.push(`${entry.path} was captured up to its first ${String(Math.round(REPOSITORY_CAPTURE_SOURCE_BYTES_MAX / 1024))} KB.`);
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
    ...(proof ? { required: proof.required } : {}),
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
