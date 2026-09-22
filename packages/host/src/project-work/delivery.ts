/**
 * What an attempt did, and whether a link's objects are still there (M21-T18).
 *
 * The leap's rule for an implementation attempt is short and absolute:
 * *checkpoints and git determine changed files; tool calls never do*. This
 * module is where that rule is executed. It reads the workspace shape of the
 * checkout an attempt ran in, gives every repository in it the project's own
 * stable `repositoryId`, resolves the attempt's checkpoint refs to commit
 * object ids **at record time**, and computes the change between the first and
 * the last of them. A model reporting that it edited a file changes nothing
 * here; a model that edited a file and said nothing is in the record anyway.
 *
 * Two repositories in one workspace stay two records with two ids — a monorepo
 * never collapses into one list — and a repository the attempt did not touch
 * still records its base, because "nothing changed here" is an answer.
 *
 * Nothing in this file writes to git, and nothing it returns is a host path:
 * the checkout is an input, the output is object ids, repository ids and
 * repository-relative paths.
 */
import {
  ATTEMPT_CHANGED_PATHS_MAX,
  ATTEMPT_CHECKPOINTS_MAX,
  ATTEMPT_COMMITS_MAX,
  ATTEMPT_REPOSITORIES_MAX,
  type AttemptCheckpointRef,
  type AttemptRepositoryRecord,
  type RepositoryChangeRef,
  type RepositoryLink,
  type RepositoryLinkAvailability,
  type RepositoryStateRef,
} from "@lasercode/protocol";
import {
  branchOf,
  commitExists,
  commitsBetween,
  diffBetween,
  headCommitOf,
  listCheckpointRefs,
  objectFormatOf,
  rootCommitOf,
  workspaceRepositories,
  type CheckpointRefRow,
  type HostRepository,
} from "../source-control/read.js";

/** What this module needs from the store: stable ids for repositories. */
export interface RepositoryIdentityStore {
  ensureRepository(input: { projectId: string; name: string; gitCommonDir: string; rootCommitId?: string | undefined }): string;
}

/** One repository of a checkout, with the project's own id for it. */
export interface IdentifiedRepository {
  repositoryId: string;
  repository: HostRepository;
  objectFormat: "sha1" | "sha256";
  head?: string;
  branch?: string;
}

export interface AttemptFactsQuery {
  projectId: string;
  /** The directory the attempt ran in. A worktree resolves to its own shape. */
  checkout: string;
  /** When the attempt started, so the checkpoints it made can be picked out. */
  startedAt: string;
  /** When it ended. Absent means "up to now". */
  endedAt?: string | undefined;
  /** The session whose checkpoints these are, when the caller knows it. */
  sessionKey?: string | undefined;
  /** The base the caller recorded, when it had one. */
  baseCommitObjectId?: string | undefined;
  /**
   * What this attempt already recorded, when it is being closed rather than
   * opened. The base a repository started at is the attempt's history and is
   * never recomputed: `HEAD` has moved by then, and taking it again would
   * quietly redefine what the attempt began from.
   */
  previous?: readonly AttemptRepositoryRecord[] | undefined;
}

/**
 * Every repository of a checkout, each with the project's stable id for it.
 *
 * The id comes from the repository's root commit when git has one, so it
 * survives relocation and is shared with a linked worktree's owner; the
 * fallback is the resolved common dir (M21-T2's identity key). Registration is
 * idempotent: the same repository asked for twice is the same id.
 */
export async function identifyRepositories(
  store: RepositoryIdentityStore,
  projectId: string,
  checkout: string,
  options: { rescan?: boolean } = {},
): Promise<IdentifiedRepository[]> {
  const repositories = (await workspaceRepositories(checkout, options)).slice(0, ATTEMPT_REPOSITORIES_MAX);
  const identified: IdentifiedRepository[] = [];
  for (const repository of repositories) {
    const [rootCommitId, objectFormat, head, branch] = await Promise.all([
      rootCommitOf(repository),
      objectFormatOf(repository),
      headCommitOf(repository),
      branchOf(repository),
    ]);
    const repositoryId = store.ensureRepository({
      projectId,
      name: repository.name,
      gitCommonDir: repository.gitDir,
      ...(rootCommitId ? { rootCommitId } : {}),
    });
    identified.push({
      repositoryId,
      repository,
      objectFormat,
      ...(head ? { head } : {}),
      ...(branch ? { branch } : {}),
    });
  }
  return identified;
}

/**
 * The exact state each repository of a checkout is in right now.
 *
 * This is what a `based_on` link records: the code an artifact revision was
 * derived from, as a commit object id, taken in the same call that wrote the
 * revision. A repository with no commits yet contributes nothing — there is no
 * state to name — rather than a placeholder.
 */
export async function currentStates(
  store: RepositoryIdentityStore,
  projectId: string,
  checkout: string,
): Promise<Array<{ repositoryId: string; state: RepositoryStateRef; branch?: string }>> {
  const repositories = await identifyRepositories(store, projectId, checkout);
  const states: Array<{ repositoryId: string; state: RepositoryStateRef; branch?: string }> = [];
  for (const row of repositories) {
    if (!row.head) continue;
    states.push({
      repositoryId: row.repositoryId,
      state: { vcs: "git", objectFormat: row.objectFormat, commitObjectId: row.head },
      ...(row.branch ? { branch: row.branch } : {}),
    });
  }
  return states;
}

/**
 * What every repository of the attempt's checkout did while it ran.
 *
 * The base is the commit the attempt started from: the one the caller recorded
 * when it started, and otherwise this repository's `HEAD`. The checkpoints are
 * the refs whose commits were created inside the attempt's window — and only
 * this session's, when the caller said which session it is. The change is
 * checkpoint(first) → checkpoint(last), and the changed paths are that change's
 * paths, from git.
 *
 * An attempt that made a single checkpoint has a base and no change: one
 * snapshot is not a difference, and inventing `HEAD` as its other end would be
 * exactly the retargeting this task exists to prevent.
 */
export async function attemptRepositoryFacts(
  store: RepositoryIdentityStore,
  query: AttemptFactsQuery,
): Promise<AttemptRepositoryRecord[]> {
  const repositories = await identifyRepositories(store, query.projectId, query.checkout, { rescan: true });
  const records: AttemptRepositoryRecord[] = [];
  for (const row of repositories) {
    const record = await repositoryFacts(row, query);
    if (record) records.push(record);
  }
  return records;
}

async function repositoryFacts(row: IdentifiedRepository, query: AttemptFactsQuery): Promise<AttemptRepositoryRecord | undefined> {
  const opened = query.previous?.find((record) => record.repositoryId === row.repositoryId);
  const claimed = opened?.base.commitObjectId ?? query.baseCommitObjectId;
  // A base somebody supplied is kept as identity whether or not git still has
  // it: this record exists to replace guesses, and "the commit it started
  // from" quietly becoming `HEAD` is the guess (review F6). `HEAD` is the base
  // only when nobody named one at all.
  const baseCommit = claimed ?? row.head;
  if (!baseCommit) return undefined;
  const baseMissing = claimed !== undefined && !(await commitExists(row.repository, claimed));
  const base: RepositoryStateRef = { vcs: "git", objectFormat: row.objectFormat, commitObjectId: baseCommit };

  const all = (await listCheckpointRefs(row.repository, query.sessionKey)).filter((checkpoint) => !checkpoint.failed);
  // What this attempt made is what came after what was already there. The turn
  // is the session's own counter, so this is exact where a ref's one-second
  // date is not; the time window is the fallback for an attempt that was never
  // opened through Laser and so has no recorded starting point.
  const sinceTurn = opened?.sinceTurn ?? highestTurn(all);
  const mine = opened
    ? all.filter((checkpoint) => checkpoint.turn > sinceTurn)
    : all.filter((checkpoint) => checkpoint.turn > sinceTurn && inWindow(checkpoint, query));
  const checkpoints = boundCheckpoints(mine).map<AttemptCheckpointRef>((checkpoint) => ({
    turn: checkpoint.turn,
    ref: checkpoint.ref,
    commitObjectId: checkpoint.commitObjectId,
    ...(checkpoint.createdAt ? { createdAt: checkpoint.createdAt } : {}),
  }));

  const first = checkpoints[0];
  const last = checkpoints[checkpoints.length - 1];
  let change: RepositoryChangeRef | undefined;
  let changedPaths: string[] = [];
  let unavailable = false;
  if (first && last && first.commitObjectId !== last.commitObjectId) {
    const diff = await diffBetween(row.repository, first.commitObjectId, last.commitObjectId);
    if (diff) {
      change = {
        base: { vcs: "git", objectFormat: row.objectFormat, commitObjectId: first.commitObjectId, checkpointId: first.ref },
        head: { vcs: "git", objectFormat: row.objectFormat, commitObjectId: last.commitObjectId, checkpointId: last.ref },
        diffDigest: diff.digest,
      };
      changedPaths = diff.files.slice(0, ATTEMPT_CHANGED_PATHS_MAX).map((file) => file.path);
    } else {
      unavailable = true;
    }
  }

  // A base git cannot resolve has no commits after it to list, and listing
  // them from `HEAD` instead would describe a history this attempt never had.
  const commits = row.head && !baseMissing ? await commitsBetween(row.repository, baseCommit, row.head, ATTEMPT_COMMITS_MAX) : [];
  return {
    repositoryId: row.repositoryId,
    name: row.repository.name,
    base,
    sinceTurn,
    checkpoints,
    ...(change ? { change } : {}),
    changedPaths,
    commits,
    ...(unavailable || baseMissing ? { unavailable: true } : {}),
  };
}

/** The turn a session's checkpoints had already reached, or -1 for none. */
function highestTurn(rows: readonly CheckpointRefRow[]): number {
  let turn = -1;
  for (const row of rows) turn = Math.max(turn, row.turn);
  return turn;
}

/**
 * Was this checkpoint made during the attempt?
 *
 * By its own creation time, inclusive at both ends, because that is the only
 * thing a ref knows about when it happened. A checkpoint with no readable date
 * is kept: losing a real checkpoint would understate the change, and the ref
 * says which session and turn it came from either way.
 */
function inWindow(checkpoint: CheckpointRefRow, query: AttemptFactsQuery): boolean {
  if (!checkpoint.createdAt) return true;
  const at = Date.parse(checkpoint.createdAt);
  if (Number.isNaN(at)) return true;
  const from = Date.parse(query.startedAt);
  // A ref's date has one-second resolution and the attempt's has a
  // millisecond's, so the start is compared at the second it falls in: a
  // checkpoint made in the same second the attempt started is the attempt's,
  // and rounding it out would lose the snapshot the change begins at.
  if (!Number.isNaN(from) && at < Math.floor(from / 1000) * 1000) return false;
  if (query.endedAt) {
    const to = Date.parse(query.endedAt);
    if (!Number.isNaN(to) && at > to) return false;
  }
  return true;
}

/**
 * Keep the ends when the list is too long.
 *
 * The first and the last checkpoint are what the change is computed from, so a
 * thousand-turn session keeps both of them and loses turns out of the middle,
 * rather than keeping a prefix and computing a change that stops halfway.
 */
function boundCheckpoints(rows: CheckpointRefRow[]): CheckpointRefRow[] {
  if (rows.length <= ATTEMPT_CHECKPOINTS_MAX) return rows;
  const head = rows.slice(0, ATTEMPT_CHECKPOINTS_MAX - 1);
  return [...head, rows[rows.length - 1]!];
}

/**
 * Is this link's source still in git, and is its capture still readable?
 *
 * The answer never changes what the link says. A commit that is gone —
 * a pruned checkpoint, a force-pushed head, a repository re-cloned without its
 * history — comes back as `sourceAvailable: false` with the object ids that
 * could not be found, and the link keeps naming exactly those ids. It is never
 * resolved to `HEAD`, and never quietly dropped.
 */
export async function linkAvailability(
  link: RepositoryLink,
  repository: HostRepository | undefined,
  captureAvailable: boolean,
): Promise<RepositoryLinkAvailability> {
  const wanted = objectIdsOf(link);
  if (!repository) {
    return {
      linkId: link.linkId,
      sourceAvailable: false,
      missing: wanted,
      captureAvailable,
      ...(link.captureBlobId ? { captureBlobId: link.captureBlobId } : {}),
      detail: captureAvailable
        ? "That repository is not open on this machine, so this change cannot be read from git. The stored capture still shows what was accepted."
        : "That repository is not open on this machine, so this change cannot be read from git.",
    };
  }
  const missing: string[] = [];
  for (const objectId of wanted) {
    if (!(await commitExists(repository, objectId))) missing.push(objectId);
  }
  if (missing.length === 0) {
    return {
      linkId: link.linkId,
      sourceAvailable: true,
      missing: [],
      captureAvailable,
      ...(link.captureBlobId ? { captureBlobId: link.captureBlobId } : {}),
    };
  }
  return {
    linkId: link.linkId,
    sourceAvailable: false,
    missing,
    captureAvailable,
    ...(link.captureBlobId ? { captureBlobId: link.captureBlobId } : {}),
    detail: captureAvailable
      ? "That commit is no longer in the repository. The stored capture still shows exactly what was accepted."
      : "That commit is no longer in the repository, and nothing was captured from it, so this change cannot be reviewed.",
  };
}

/** Every commit object id one link names. Identity, in the order it reads. */
export function objectIdsOf(link: RepositoryLink): string[] {
  const ids =
    "state" in link.target
      ? [link.target.state.commitObjectId]
      : [link.target.change.base.commitObjectId, link.target.change.head.commitObjectId];
  return [...new Set(ids)];
}

/** The repository of a checkout that carries this id, when it is open here. */
export function repositoryFor(
  repositories: readonly IdentifiedRepository[],
  repositoryId: string,
): IdentifiedRepository | undefined {
  return repositories.find((row) => row.repositoryId === repositoryId);
}
