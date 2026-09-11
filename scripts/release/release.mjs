#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { identity } from "../identity/identity.mjs";
import { inspectReleaseByTag, isExplicitMissingRelease, releaseInventory, verifyInventory } from "./publish-github.mjs";

const MAIN_REF = "refs/heads/main";
const CI_WORKFLOW = "ci.yml";
const RELEASE_WORKFLOW = "release.yml";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const STAGES = ["created", "prepared", "main-pushed", "ci-passed", "tag-pushed", "release-passed", "verified"];
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export class ReleaseError extends Error {}

function fail(message) {
  throw new ReleaseError(message);
}

export function parseArgs(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const options = {
    version: "",
    source: "",
    publish: false,
    resume: false,
    recoverStaleLock: false,
    notesFile: "",
    offline: false,
    ciTimeoutMinutes: 45,
    releaseTimeoutMinutes: 120,
  };
  const args = [...argv];
  options.version = args.shift() ?? "";
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--publish") options.publish = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--recover-stale-lock") options.recoverStaleLock = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--source") options.source = args.shift() ?? "";
    else if (arg === "--notes") options.notesFile = args.shift() ?? "";
    else if (arg === "--ci-timeout-minutes") options.ciTimeoutMinutes = Number(args.shift());
    else if (arg === "--release-timeout-minutes") options.releaseTimeoutMinutes = Number(args.shift());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (!VERSION_RE.test(options.version)) fail("VERSION must be MAJOR.MINOR.PATCH, optionally with a prerelease suffix.");
  if (options.source && !FULL_SHA_RE.test(options.source)) fail("--source must be a full 40-character lowercase commit SHA.");
  if (options.publish && !options.source) fail("--publish requires --source FULL_SHA from the reviewed release authorization.");
  if (options.publish && !options.resume && !options.notesFile) fail("--publish requires --notes FILE: the release notes a person reads on the release page.");
  if (options.resume && !options.publish) fail("--resume is valid only with --publish.");
  if (options.recoverStaleLock && (!options.publish || !options.resume)) {
    fail("--recover-stale-lock requires --publish --resume.");
  }
  for (const [name, value] of [["--ci-timeout-minutes", options.ciTimeoutMinutes], ["--release-timeout-minutes", options.releaseTimeoutMinutes]]) {
    if (!Number.isFinite(value) || value <= 0 || value > 24 * 60) fail(`${name} must be between 1 and 1440.`);
  }
  return options;
}

/**
 * The release notes, from a Markdown file written for this release. They go
 * into the annotated tag's body, and the publisher (publish.sh) reads them from
 * there as the release page's text — so the notes are part of the tagged
 * object, not typed into a form. Empty notes are refused.
 */
export function loadReleaseNotes(path) {
  const file = resolve(path);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`--notes ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) fail(`--notes ${path} is empty; write what changed for the people who install this release.`);
  return { path: file, text: `${trimmed}\n`, digest: createHash("sha256").update(trimmed).digest("hex"), lines: trimmed.split("\n").length };
}

function commandText(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(" ");
}

export function systemExec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: sanitizedEnvironment(options.env ?? process.env),
    timeout: options.timeoutMs ?? (command === "pnpm" || args.includes("download") ? 30 * 60_000 : 5 * 60_000),
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const answer = { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (!(options.allowCodes ?? [0]).includes(answer.code)) {
    fail(`${commandText(command, args)} failed (${answer.code}).\n${answer.stderr || answer.stdout}`.trim());
  }
  return answer;
}

function checked(exec, command, args, options = {}) {
  return exec(command, args, options).stdout.trim();
}

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeOrigin(url) {
  return url
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
}


function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

function readJson(path, context) {
  return parseJson(readFileSync(path, "utf8"), context);
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireReleaseLock({ commonDir, version, source, resume, recoverStaleLock, pid = process.pid }) {
  const root = join(commonDir, `${identity.dirName}-release`);
  const lockPath = join(root, "lock");
  const journalPath = join(root, `v${version}.json`);
  mkdirSync(root, { recursive: true });
  const checkpointId = existsSync(journalPath) ? readJson(journalPath, "release checkpoint").id : randomUUID();
  const owner = { id: randomUUID(), checkpointId, pid, version, source, commonDir, startedAt: new Date().toISOString() };
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const ownerPath = join(lockPath, "owner.json");
    if (!existsSync(ownerPath)) fail(`Release lock ${lockPath} has no owner record; inspect it manually.`);
    const stale = readJson(ownerPath, "release lock owner");
    if (processExists(stale.pid)) fail(`Release ${stale.version} is already running as PID ${stale.pid}.`);
    if (!recoverStaleLock || !resume) {
      fail(`Stale release lock found for ${stale.version}; inspect its checkpoint, then resume with --recover-stale-lock.`);
    }
    if (!existsSync(journalPath)) fail("Stale lock recovery refused: the matching checkpoint is missing.");
    const journal = readJson(journalPath, "release checkpoint");
    if (stale.version !== version || stale.source !== source || stale.commonDir !== commonDir ||
        journal.version !== version || journal.source !== source || journal.commonDir !== commonDir ||
        !journal.id || stale.checkpointId !== journal.id || checkpointId !== journal.id) {
      fail("Stale lock recovery refused: lock and checkpoint identities do not match this command.");
    }
    const archived = `${lockPath}.stale-${Date.now()}-${stale.id ?? "unknown"}`;
    renameSync(lockPath, archived);
    try {
      mkdirSync(lockPath);
    } catch (race) {
      fail(`Another release command won stale-lock recovery: ${race instanceof Error ? race.message : String(race)}`);
    }
  }
  writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  return {
    journalPath,
    checkpointId,
    release() {
      const ownerPath = join(lockPath, "owner.json");
      if (existsSync(ownerPath) && readJson(ownerPath, "release lock owner").id === owner.id) rmSync(lockPath, { recursive: true });
    },
  };
}

export function selectWorkflowRun(runs, { workflowPath, event, branch, headSha }) {
  const exact = runs.filter((run) =>
    run.event === event && run.head_branch === branch && run.head_sha === headSha &&
    (run.path === workflowPath || (typeof run.path === "string" && run.path.startsWith(`${workflowPath}@`))),
  );
  const ids = new Set(exact.map((run) => String(run.id ?? run.databaseId)));
  if (ids.size > 1) fail(`More than one ${workflowPath} ${event} run matches ${branch} at ${headSha}; refusing ambiguity.`);
  if (exact.length === 0) return null;
  return exact.sort((a, b) => Number(b.run_attempt ?? 1) - Number(a.run_attempt ?? 1))[0];
}

function ghApi(exec, endpoint, { allow404 = false } = {}) {
  const result = exec("gh", ["api", endpoint], { allowCodes: allow404 ? [0, 1] : [0] });
  if (result.code === 0) return parseJson(result.stdout, `GitHub API ${endpoint}`);
  if (allow404 && /\bHTTP 404\b/i.test(result.stderr)) return null;
  fail(`GitHub API ${endpoint} failed; this is not evidence of absence.\n${result.stderr || result.stdout}`.trim());
}

function remoteTagIdentity(exec, repoRoot, ref) {
  const output = checked(exec, "git", ["ls-remote", "origin", ref, `${ref}^{}`], { cwd: repoRoot });
  if (!output) return null;
  const rows = output.split("\n").map((line) => line.trim().split(/\s+/));
  const commit = rows.find(([, name]) => name === `${ref}^{}`)?.[0];
  const object = rows.find(([, name]) => name === ref)?.[0];
  if (!FULL_SHA_RE.test(object ?? "") || (commit && !FULL_SHA_RE.test(commit))) fail("Invalid remote tag response.");
  return { object, commit: commit ?? object, annotated: Boolean(commit) };
}

function remoteRef(exec, repoRoot, ref) {
  return remoteTagIdentity(exec, repoRoot, ref)?.commit ?? null;
}

export function assertRecordedTag(tag, journal) {
  if (!tag?.annotated) fail(`Remote tag ${journal.tag} must be annotated.`);
  if (!journal.tagObject || tag.object !== journal.tagObject || tag.commit !== journal.candidate) {
    fail(`Remote tag ${journal.tag} no longer matches its checkpoint object and candidate.`);
  }
}

function remoteMain(exec, repoRoot) {
  const output = checked(exec, "git", ["ls-remote", "--heads", "origin", MAIN_REF], { cwd: repoRoot });
  const rows = output ? output.split("\n") : [];
  if (rows.length !== 1) fail(`Expected exactly one remote ${MAIN_REF}; found ${rows.length}.`);
  const [sha, ref] = rows[0].trim().split(/\s+/);
  if (!FULL_SHA_RE.test(sha) || ref !== MAIN_REF) fail(`Unexpected remote ${MAIN_REF} response.`);
  return sha;
}

function workflowRuns(exec, workflow, branch) {
  const query = `repos/${identity.repository}/actions/workflows/${workflow}/runs?event=push&branch=${encodeURIComponent(branch)}&per_page=100`;
  const response = ghApi(exec, query);
  if (!Array.isArray(response.workflow_runs)) fail(`Workflow ${workflow} response has no workflow_runs array.`);
  return response.workflow_runs;
}

function releaseByTag(exec, tag, allow404 = true) {
  const release = inspectReleaseByTag(tag, identity.repository, (args, allowMissing = false) => {
    const result = exec("gh", args, { allowCodes: allowMissing ? [0, 1] : [0] });
    if (result.code !== 0) {
      if (allowMissing && isExplicitMissingRelease(result.stderr)) return null;
      fail("Release lookup failed; this is not evidence of absence.\n" + result.stderr);
    }
    return parseJson(result.stdout, "Release lookup");
  });
  if (!release && !allow404) fail(`Release ${tag} is missing.`);
  return release;
}

function assertSource(exec, repoRoot, source) {
  const resolved = checked(exec, "git", ["rev-parse", `${source}^{commit}`], { cwd: repoRoot });
  if (!FULL_SHA_RE.test(resolved) || resolved !== source) fail(`Source ${source} is not the exact commit requested.`);
  for (const path of [
    `.github/workflows/${CI_WORKFLOW}`,
    `.github/workflows/${RELEASE_WORKFLOW}`,
    "scripts/release/release.mjs",
    "scripts/release/set-version.sh",
  ]) {
    checked(exec, "git", ["cat-file", "-e", `${source}:${path}`], { cwd: repoRoot });
  }
}

export function preflight({ exec = systemExec, repoRoot, version, source, allowRemoteAhead = false }) {
  const root = resolve(repoRoot);
  const callerHead = checked(exec, "git", ["rev-parse", "HEAD"], { cwd: root });
  const exactSource = source || callerHead;
  if (!FULL_SHA_RE.test(exactSource)) fail("Source must resolve to a full commit SHA.");
  if (callerHead !== exactSource) {
    fail(`The executing checkout is at ${callerHead}, not reviewed source ${exactSource}; switch to the exact source without rewriting it.`);
  }
  assertSource(exec, root, exactSource);
  const origin = checked(exec, "git", ["remote", "get-url", "origin"], { cwd: root });
  if (normalizeOrigin(origin) !== identity.repository) fail(`origin does not match the configured repository ${identity.repository}.`);
  const main = remoteMain(exec, root);
  const ancestor = exec("git", ["merge-base", "--is-ancestor", main, exactSource], { cwd: root, allowCodes: [0, 1] });
  if (ancestor.code !== 0) {
    const remoteAhead = allowRemoteAhead && exec("git", ["merge-base", "--is-ancestor", exactSource, main], {
      cwd: root,
      allowCodes: [0, 1],
    }).code === 0;
    if (!remoteAhead) fail(`Reviewed source ${exactSource} is not a fast-forward of remote main ${main}.`);
  }
  const tag = `v${version}`;
  const tagSha = remoteRef(exec, root, `refs/tags/${tag}`);
  const release = releaseByTag(exec, tag, true);
  return {
    repoRoot: root,
    source: exactSource,
    version,
    tag,
    origin: identity.repository,
    frozenRemoteMain: main,
    remoteTagSha: tagSha,
    release,
    existingCiRun: selectWorkflowRun(workflowRuns(exec, CI_WORKFLOW, "main"), {
      workflowPath: `.github/workflows/${CI_WORKFLOW}`,
      event: "push",
      branch: "main",
      headSha: exactSource,
    }),
  };
}

function metadataPaths(worktree) {
  const packages = readdirSync(join(worktree, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(worktree, "packages", entry.name, "package.json")))
    .map((entry) => `packages/${entry.name}/package.json`)
    .sort();
  return ["package.json", ...packages, "packages/protocol/src/product.generated.ts"];
}

function changedPaths(exec, cwd, cached = false) {
  const args = ["diff", ...(cached ? ["--cached"] : []), "--name-only"];
  const output = checked(exec, "git", args, { cwd });
  return output ? output.split("\n").filter(Boolean).sort() : [];
}

function changedFromHead(exec, cwd) {
  const output = checked(exec, "git", ["diff", "HEAD", "--name-only"], { cwd });
  return output ? output.split("\n").filter(Boolean).sort() : [];
}

function ensureExactPaths(actual, allowed, context) {
  const allowedSet = new Set(allowed);
  const outside = actual.filter((path) => !allowedSet.has(path));
  if (outside.length > 0) fail(`${context} changed files outside release metadata:\n${outside.join("\n")}`);
}

function assertCleanStatus(exec, cwd) {
  const status = checked(exec, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  if (status) fail(`Isolated release worktree is not clean:\n${status}`);
}

export function sanitizedEnvironment(input = process.env) {
  const env = { ...input };
  // Repository/index/config selection must not escape into linked worktrees or
  // the temporary repositories created by verification tests.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function withoutAlternateIndex() { return sanitizedEnvironment(); }

function assertSynchronizedVersions(worktree, paths, version) {
  const manifests = paths.filter((path) => path.endsWith("package.json"));
  for (const path of manifests) {
    const found = parseJson(readFileSync(join(worktree, path), "utf8"), path).version;
    if (found !== version) fail(`${path} is ${found}, expected ${version}.`);
  }
  const generated = readFileSync(join(worktree, "packages/protocol/src/product.generated.ts"), "utf8");
  if (!generated.includes(`PRODUCT_VERSION: string = "${version}"`)) {
    fail(`Generated product version does not equal ${version}.`);
  }
}

export function assertVersionOnlyContent(before, after, path, version) {
  if (path.endsWith("package.json")) {
    const expected = { ...parseJson(before, path), version };
    if (!isDeepStrictEqual(parseJson(after, path), expected)) fail(`${path} contains changes other than its version.`);
  } else {
    const expected = before.replace(/(PRODUCT_VERSION: string = )"[^"]*"/, `$1"${version}"`);
    if (after.trim() !== expected.trim()) fail(`${path} contains changes other than its generated version.`);
  }
}

function assertVersionOnlyDiff(exec, worktree, changed, version) {
  for (const path of changed) {
    const before = checked(exec, "git", ["show", `HEAD:${path}`], { cwd: worktree });
    assertVersionOnlyContent(before, readFileSync(join(worktree, path), "utf8"), path, version);
  }
}

export function prepareCandidate({ exec = systemExec, worktree, version, offline = false, resume = false }) {
  const allowed = metadataPaths(worktree);
  if (!resume) assertCleanStatus(exec, worktree);
  else {
    const existing = changedFromHead(exec, worktree);
    ensureExactPaths(existing, allowed, "Resumed release checkpoint");
    assertVersionOnlyDiff(exec, worktree, existing, version);
    const existingUntracked = checked(exec, "git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree });
    if (existingUntracked) fail(`Resumed release checkpoint has untracked files:\n${existingUntracked}`);
  }
  const installArgs = ["install", "--frozen-lockfile", ...(offline ? ["--offline"] : [])];
  checked(exec, "pnpm", installArgs, { cwd: worktree, env: withoutAlternateIndex() });
  checked(exec, "bash", ["scripts/release/set-version.sh", version], { cwd: worktree, env: withoutAlternateIndex() });
  const changed = changedFromHead(exec, worktree);
  ensureExactPaths(changed, allowed, "Version synchronization");
  assertVersionOnlyDiff(exec, worktree, changed, version);
  assertSynchronizedVersions(worktree, allowed, version);
  const untracked = checked(exec, "git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree });
  if (untracked) fail(`Version synchronization created untracked files:\n${untracked}`);
  if (changed.length > 0) checked(exec, "git", ["add", "--", ...changed], { cwd: worktree });
  checked(exec, "pnpm", ["identity:check"], { cwd: worktree, env: withoutAlternateIndex() });
  checked(exec, "pnpm", ["verify"], { cwd: worktree, env: withoutAlternateIndex() });
  const staged = changedPaths(exec, worktree, true);
  ensureExactPaths(staged, allowed, "Staged verification");
  if (JSON.stringify(staged) !== JSON.stringify(changed)) {
    fail("Staged metadata changed during verification.");
  }
  const afterUnstaged = changedPaths(exec, worktree);
  if (afterUnstaged.length > 0) fail(`Verification left unstaged source changes:\n${afterUnstaged.join("\n")}`);
  const afterUntracked = checked(exec, "git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree });
  if (afterUntracked) fail(`Verification left untracked source files:\n${afterUntracked}`);
  checked(exec, "git", ["diff", "--check"], { cwd: worktree });
  checked(exec, "git", ["diff", "--cached", "--check"], { cwd: worktree });
  let metadataCommit = null;
  if (changed.length > 0) {
    checked(exec, "git", ["commit", "-m", `chore(release): prepare ${version}`], { cwd: worktree });
    metadataCommit = checked(exec, "git", ["rev-parse", "HEAD"], { cwd: worktree });
  }
  assertCleanStatus(exec, worktree);
  const candidate = checked(exec, "git", ["rev-parse", "HEAD"], { cwd: worktree });
  checked(exec, "git", ["diff", "--check", `${metadataCommit ? `${metadataCommit}^` : candidate}..${candidate}`], { cwd: worktree });
  return { candidate, metadataCommit, changed };
}

function createWorktree(exec, repoRoot, source, version, checkpointId) {
  const path = mkdtempSync(join(tmpdir(), `${identity.dirName}-release-${version}-`));
  rmdirSync(path);
  checked(exec, "git", ["worktree", "add", "--detach", path, source], { cwd: repoRoot });
  const gitDir = checked(exec, "git", ["rev-parse", "--absolute-git-dir"], { cwd: path });
  atomicJson(join(gitDir, "release-owner.json"), { checkpointId, source });
  return path;
}

function removeWorktree(exec, repoRoot, worktree) {
  assertCleanStatus(exec, worktree);
  checked(exec, "git", ["worktree", "remove", worktree], { cwd: repoRoot });
}

function writeJournal(path, journal, stage) {
  if (stage) journal.stage = stage;
  journal.updatedAt = new Date().toISOString();
  atomicJson(path, journal);
}

function stageAtLeast(journal, stage) {
  return STAGES.indexOf(journal.stage) >= STAGES.indexOf(stage);
}

function validateJournal(journal, expected) {
  for (const key of ["id", "version", "source", "commonDir", "repoRoot", "origin", "tag"]) {
    if (journal[key] !== expected[key]) fail(`Checkpoint ${key} does not match this command.`);
  }
  if (!STAGES.includes(journal.stage)) fail(`Checkpoint has unknown stage ${journal.stage}.`);
}

/** A candidate is the reviewed source or its single, version-only child. */
export function validateCandidate(exec, { repoRoot, source, candidate, version }, requireVersion = true) {
  if (!FULL_SHA_RE.test(source) || !FULL_SHA_RE.test(candidate)) fail("Checkpoint source/candidate is not a commit SHA.");
  const parents = checked(exec, "git", ["rev-list", "--parents", "-n", "1", candidate], { cwd: repoRoot }).split(/\s+/);
  if (parents[0] !== candidate || (candidate !== source && (parents.length !== 2 || parents[1] !== source))) {
    fail("Candidate is not the reviewed source or its one metadata-only child.");
  }
  const tree = checked(exec, "git", ["ls-tree", "-r", "--name-only", source], { cwd: repoRoot }).split("\n");
  const allowed = tree.filter((path) => path === "package.json" || /^packages\/[^/]+\/package\.json$/.test(path) || path === "packages/protocol/src/product.generated.ts");
  const changed = checked(exec, "git", ["diff", "--name-only", source, candidate], { cwd: repoRoot }).split("\n").filter(Boolean);
  ensureExactPaths(changed, allowed, "Candidate lineage");
  if (candidate !== source || requireVersion) {
    for (const path of allowed) {
      const before = checked(exec, "git", ["show", `${source}:${path}`], { cwd: repoRoot });
      const after = checked(exec, "git", ["show", `${candidate}:${path}`], { cwd: repoRoot });
      assertVersionOnlyContent(before, after, path, version);
    }
  }
}

function validateOwnedWorktree(exec, journal) {
  if (resolve(journal.worktree) === resolve(journal.repoRoot)) fail("Checkpoint cannot own the caller's checkout.");
  const common = checked(exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: journal.worktree });
  const gitDir = checked(exec, "git", ["rev-parse", "--absolute-git-dir"], { cwd: journal.worktree });
  if (resolve(common) !== resolve(journal.commonDir) || resolve(gitDir) === resolve(common)) fail("Checkpoint worktree ownership changed.");
  const marker = readJson(join(gitDir, "release-owner.json"), "worktree owner");
  if (marker.checkpointId !== journal.id || marker.source !== journal.source) fail("Checkpoint does not own this worktree.");
  const branch = exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd: journal.worktree, allowCodes: [0, 1] });
  if (branch.code !== 1) fail("Release worktree must remain detached.");
  const head = checked(exec, "git", ["rev-parse", "HEAD"], { cwd: journal.worktree });
  if (stageAtLeast(journal, "prepared") && head !== journal.candidate) fail("Checkpoint worktree HEAD moved after preparation.");
  validateCandidate(exec, { ...journal, candidate: head }, stageAtLeast(journal, "prepared"));
}

export function validateWorkflowProof(exec, journal, kind) {
  const id = journal[`${kind}RunId`];
  if (!Number.isSafeInteger(id) || id <= 0) fail(`Checkpoint has no valid ${kind} workflow proof.`);
  const run = ghApi(exec, `repos/${identity.repository}/actions/runs/${id}`);
  const exact = selectWorkflowRun([run], {
    workflowPath: kind === "ci" ? `.github/workflows/${CI_WORKFLOW}` : RELEASE_WORKFLOW_PATH,
    event: "push", branch: kind === "ci" ? "main" : journal.tag, headSha: journal.candidate,
  });
  if (!exact || run.id !== id || run.status !== "completed" || run.conclusion !== "success" ||
      Number(run.run_attempt ?? 1) < Number(journal[`${kind}RunAttempt`] ?? 1)) {
    fail(`Recorded ${kind} workflow proof is no longer an exact successful run; resume after its current attempt succeeds.`);
  }
  journal[`${kind}RunAttempt`] = run.run_attempt ?? 1;
}

export function pushMain(exec, journal) {
  const current = remoteMain(exec, journal.repoRoot);
  if (current === journal.candidate) return false;
  if (current !== journal.frozenRemoteMain) fail(`Remote main moved from ${journal.frozenRemoteMain} to ${current}; refusing release push.`);
  const ancestor = exec("git", ["merge-base", "--is-ancestor", current, journal.candidate], {
    cwd: journal.worktree,
    allowCodes: [0, 1],
  });
  if (ancestor.code !== 0) fail("Candidate is not a fast-forward of the frozen remote main.");
  checked(exec, "git", ["push", "origin", `${journal.candidate}:${MAIN_REF}`], { cwd: journal.worktree });
  const after = remoteMain(exec, journal.repoRoot);
  if (after !== journal.candidate) fail(`Remote main did not settle on candidate ${journal.candidate}.`);
  return true;
}

export async function waitForWorkflow({ exec, sleep, now, journal, workflow, workflowPath, branch, timeoutMinutes, onObserved }) {
  const deadline = now() + timeoutMinutes * 60_000;
  const timedExec = (command, args, options = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) fail(`Timed out waiting for ${workflowPath} at ${journal.candidate}.`);
    return exec(command, args, { ...options, timeoutMs: Math.min(5 * 60_000, remaining) });
  };
  while (now() <= deadline) {
    const run = selectWorkflowRun(workflowRuns(timedExec, workflow, branch), {
      workflowPath,
      event: "push",
      branch,
      headSha: journal.candidate,
    });
    if (run) {
      const id = run.id ?? run.databaseId;
      onObserved?.(run);
      const detail = ghApi(timedExec, `repos/${identity.repository}/actions/runs/${id}`);
      const exact = selectWorkflowRun([detail], { workflowPath, event: "push", branch, headSha: journal.candidate });
      if (!exact) fail(`Workflow run ${id} changed identity while being inspected.`);
      if (detail.status === "completed") {
        if (detail.conclusion !== "success") {
          const error = new ReleaseError(`${workflowPath} run ${id} attempt ${detail.run_attempt ?? 1} finished ${detail.conclusion}.`);
          error.workflowRun = detail;
          throw error;
        }
        return detail;
      }
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }
  fail(`Timed out waiting for ${workflowPath} at ${journal.candidate}.`);
}

export function ensureTag(exec, journal, checkpoint = () => {}) {
  const ref = `refs/tags/${journal.tag}`;
  let remote = remoteTagIdentity(exec, journal.repoRoot, ref);
  if (remote) { assertRecordedTag(remote, journal); return false; }
  let result = exec("git", ["rev-parse", ref], { cwd: journal.worktree, allowCodes: [0, 128] });
  if (result.code === 128) {
    if (journal.tagObject) fail("The checkpoint's annotated local tag is missing; refusing to replace it.");
    if (typeof journal.notes !== "string" || !journal.notes.trim()) fail("The release tag carries the release notes; the checkpoint has none.");
    // Subject, then the notes as the body: publish.sh reads `%(contents:body)`.
    // Verbatim, or git would strip every Markdown heading as a `#` comment.
    checked(exec, "git", ["tag", "-a", "--cleanup=verbatim", journal.tag, journal.candidate, "-m", `${identity.displayName} ${journal.version}`, "-m", journal.notes], { cwd: journal.worktree });
    result = exec("git", ["rev-parse", ref], { cwd: journal.worktree });
  }
  const object = result.stdout.trim();
  if (checked(exec, "git", ["cat-file", "-t", object], { cwd: journal.worktree }) !== "tag") fail("Local release tag must be annotated; refusing a lightweight tag.");
  const commit = checked(exec, "git", ["rev-parse", `${ref}^{commit}`], { cwd: journal.worktree });
  if (commit !== journal.candidate || (journal.tagObject && journal.tagObject !== object)) fail("Local tag differs from the checkpoint candidate/object.");
  journal.tagObject = object;
  checkpoint(); // Persist ownership BEFORE the irreversible remote push.
  remote = remoteTagIdentity(exec, journal.repoRoot, ref);
  if (remote) { assertRecordedTag(remote, journal); return false; }
  if (remoteMain(exec, journal.repoRoot) !== journal.candidate) fail("Remote main moved before the release tag was pushed.");
  checked(exec, "git", ["push", "origin", ref], { cwd: journal.worktree });
  assertRecordedTag(remoteTagIdentity(exec, journal.repoRoot, ref), journal);
  return true;
}

/** The files SHA256SUMS never lists: itself, its signature, and the provenance bundle. */
const UNMANIFESTED_ASSETS = new Set(["SHA256SUMS", "SHA256SUMS.sig", "provenance.jsonl"]);

/**
 * `SHA256SUMS` as published: `<hex>  <name>` per line, every name once. A few
 * hundred bytes, fetched through the API's asset endpoint rather than a full
 * download of the release.
 */
export function parseManifest(text) {
  const entries = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([^/\n]+)$/.exec(line);
    if (!match) fail(`Invalid SHA256SUMS line: ${line}`);
    if (entries.has(match[2])) fail(`Duplicate SHA256SUMS entry: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

/**
 * The published bytes, checked without downloading them: the API reports a
 * SHA-256 digest per asset, the release's own `SHA256SUMS` (fetched, a few
 * hundred bytes) says what the workflow computed for each file, and the two
 * must agree for every file the manifest covers — and the manifest must cover
 * exactly the inventory. An asset replaced after publication keeps its name,
 * its upload state and a plausible size, and only the digest gives it away.
 */
export function verifyPublishedDigests(exec, release, remoteAssets, version) {
  const manifestAsset = remoteAssets.find((asset) => asset.name === "SHA256SUMS");
  if (!manifestAsset) fail("Published release has no SHA256SUMS.");
  const fetched = exec("gh", ["api", "-H", "Accept: application/octet-stream", `repos/${identity.repository}/releases/assets/${manifestAsset.id}`]);
  if (fetched.code !== 0) fail(`Could not read the published SHA256SUMS; this is not evidence of absence.\n${fetched.stderr || fetched.stdout}`.trim());
  const manifest = parseManifest(fetched.stdout);
  const expected = releaseInventory(version).filter((name) => !UNMANIFESTED_ASSETS.has(name)).sort();
  const listed = [...manifest.keys()].sort();
  if (!isDeepStrictEqual(listed, expected)) fail("SHA256SUMS coverage does not match the release inventory.");
  for (const asset of remoteAssets) {
    if (UNMANIFESTED_ASSETS.has(asset.name)) continue;
    const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : "";
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(`GitHub reports no SHA-256 digest for ${asset.name}; the published bytes cannot be checked.`);
    if (manifest.get(asset.name) !== digest) fail(`Published ${asset.name} does not match SHA256SUMS: the asset changed after the workflow uploaded it.`);
  }
  if (manifestAsset.size !== Buffer.byteLength(fetched.stdout, "utf8")) fail("The fetched SHA256SUMS is not the size the API reports for it.");
}

/**
 * The provenance bundle, verified once against the source this release was
 * cut from. Every asset was attested by the release workflow; verifying the
 * manifest's own subject with `--source-digest` and `--source-ref` pinned is
 * the check that the bundle belongs to this tag and this commit, which the
 * workflow's local installer gate cannot make (it runs before the attest step).
 * `install.sh` runs the same verification on every machine, so a bundle that
 * fails here would fail every install after Latest was promoted.
 */
export function verifyPublishedProvenance(exec, journal, remoteAssets, directory) {
  const bundleAsset = remoteAssets.find((asset) => asset.name === "provenance.jsonl");
  if (!bundleAsset) fail("Published release has no provenance bundle.");
  const bundle = join(directory, "provenance.jsonl");
  const manifest = join(directory, "SHA256SUMS");
  for (const [asset, path] of [[bundleAsset, bundle], [remoteAssets.find((item) => item.name === "SHA256SUMS"), manifest]]) {
    const fetched = exec("gh", ["api", "-H", "Accept: application/octet-stream", `repos/${identity.repository}/releases/assets/${asset.id}`]);
    if (fetched.code !== 0) fail(`Could not read the published ${asset.name}; this is not evidence of absence.\n${fetched.stderr || fetched.stdout}`.trim());
    writeFileSync(path, fetched.stdout);
  }
  const verified = exec("gh", [
    "attestation", "verify", manifest,
    "--bundle", bundle,
    "--repo", identity.repository,
    "--signer-workflow", `${identity.repository}/${RELEASE_WORKFLOW_PATH}`,
    "--source-digest", journal.candidate,
    "--source-ref", `refs/tags/${journal.tag}`,
    "--format", "json",
  ], { allowCodes: [0, 1] });
  if (verified.code !== 0) {
    fail(`The published provenance bundle does not verify for ${journal.tag} at ${journal.candidate}; every install would refuse it.\n${verified.stderr || verified.stdout}`.trim());
  }
}

/**
 * The public release, read through the API: not a draft, the recorded tag,
 * the exact inventory with every asset uploaded, every digest agreeing with
 * the published `SHA256SUMS`, the provenance bundle verified against this
 * tag's source, the release page carrying the notes the tag carries, and
 * Latest promotion. Two small files are fetched (the manifest and the
 * bundle); the installers are not downloaded — their digests are what the
 * manifest and the API both report, and the workflow attested those bytes.
 */
export function verifyPublicRelease(exec, journal) {
  const release = releaseByTag(exec, journal.tag, false);
  if (release.draft) fail(`Release ${journal.tag} is still a draft.`);
  if (release.tag_name !== journal.tag) fail(`Release tag is ${release.tag_name}, expected ${journal.tag}.`);
  const prerelease = journal.version.includes("-");
  if (Boolean(release.prerelease) !== prerelease) fail("Release prerelease state does not match its version.");
  assertRecordedTag(remoteTagIdentity(exec, journal.repoRoot, `refs/tags/${journal.tag}`), journal);
  if (!Array.isArray(release.assets)) fail("Published release has no asset inventory.");
  const remoteAssets = release.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    state: asset.state,
    digest: asset.digest,
  }));
  verifyInventory(remoteAssets, journal.version);
  const notUploaded = remoteAssets.filter((asset) => asset.state !== "uploaded");
  if (notUploaded.length > 0) fail(`Published release has assets that are not uploaded: ${notUploaded.map((asset) => asset.name).join(", ")}.`);
  const requiredNames = releaseInventory(journal.version);
  const allowedNames = new Set([...requiredNames, "SHA256SUMS.sig"]);
  const unexpected = remoteAssets.filter((asset) => !allowedNames.has(asset.name));
  if (unexpected.length > 0 || ![requiredNames.length, requiredNames.length + 1].includes(remoteAssets.length)) {
    fail(`Published release contains unexpected assets: ${unexpected.map((asset) => asset.name).join(", ") || "duplicate inventory"}.`);
  }
  verifyPublishedDigests(exec, release, remoteAssets, journal.version);
  const scratch = mkdtempSync(join(tmpdir(), `${identity.dirName}-release-provenance-${journal.version}-`));
  try {
    verifyPublishedProvenance(exec, journal, remoteAssets, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The page is the notes the tag carries, or the chain that carries them
  // (tag → publish.sh → --notes) broke somewhere and a generated commit list
  // is standing where a person's words should be.
  if (typeof journal.notes === "string" && journal.notes.trim()) {
    const body = String(release.body ?? "").replace(/\r\n/g, "\n").trim();
    if (body !== journal.notes.trim()) fail(`The release page's text is not the release notes the tag carries; edit the release to the notes in the checkpoint and resume.`);
  }
  const latest = ghApi(exec, `repos/${identity.repository}/releases/latest`);
  if (!prerelease && latest.id !== release.id) fail(`Stable release ${journal.tag} is not Latest.`);
  if (prerelease && latest.id === release.id) fail(`Prerelease ${journal.tag} must not be Latest.`);
  return { releaseId: release.id, url: release.html_url, assets: remoteAssets.length };
}

export function publicationState(exec, journal) {
  try {
    const release = releaseByTag(exec, journal.tag, true);
    if (!release) {
      if (journal.releaseRunId) {
        const run = ghApi(exec, `repos/${identity.repository}/actions/runs/${journal.releaseRunId}`);
        if (run.status !== "completed") return `tag pushed; release workflow ${run.status}`;
        return `tag pushed; release workflow ${run.conclusion ?? "incomplete"}`;
      }
      return "tag pushed; release workflow not discovered";
    }
    if (release.draft) return "tag pushed; release draft remains private";
    return stageAtLeast(journal, "release-passed")
      ? "published; workflow succeeded; inventory check incomplete"
      : "published; deployment incomplete";
  } catch (error) {
    return `publication state unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}

function help() {
  return `Release a reviewed source through the existing CI and release workflows.\n\n` +
    `  node scripts/release/release.mjs VERSION [--source FULL_SHA] [--notes FILE]\n` +
    `  node scripts/release/release.mjs VERSION --publish --source FULL_SHA --notes FILE [--resume]\n\n` +
    `Dry-run is the default and makes no Git or GitHub writes. --publish requires explicit user authorization\n` +
    `and --notes FILE, the release notes (Markdown) that become the tag annotation and the release page.\n` +
    `Optional: --offline, --ci-timeout-minutes N, --release-timeout-minutes N,\n` +
    `          --recover-stale-lock (only with --publish --resume).\n`;
}

export async function runRelease(options, dependencies = {}) {
  const exec = dependencies.exec ?? systemExec;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = dependencies.now ?? Date.now;
  const repoRoot = dependencies.repoRoot ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const frozen = preflight({
    exec,
    repoRoot,
    version: options.version,
    source: options.source,
    allowRemoteAhead: options.resume,
  });
  const notes = options.notesFile ? loadReleaseNotes(options.notesFile) : undefined;
  if (!options.publish) {
    return {
      status: "dry-run",
      ...frozen,
      ...(notes ? { notes: { path: notes.path, lines: notes.lines } } : {}),
      next: `node scripts/release/release.mjs ${options.version} --publish --source ${frozen.source} --notes ${notes ? notes.path : "RELEASE_NOTES.md"}`,
    };
  }
  if (frozen.release && !options.resume) fail(`Release ${frozen.tag} already exists; refusing a new publication transaction.`);
  if (frozen.remoteTagSha && !options.resume) fail(`Tag ${frozen.tag} already exists at ${frozen.remoteTagSha}; refusing a new transaction.`);
  const commonDir = resolve(repoRoot, checked(exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot }));
  const lock = acquireReleaseLock({
    commonDir,
    version: options.version,
    source: frozen.source,
    resume: options.resume,
    recoverStaleLock: options.recoverStaleLock,
  });
  let journal;
  try {
    const identityFields = {
      id: lock.checkpointId,
      version: options.version,
      source: frozen.source,
      commonDir,
      repoRoot: frozen.repoRoot,
      origin: frozen.origin,
      tag: frozen.tag,
    };
    if (options.resume) {
      if (!existsSync(lock.journalPath)) fail(`No checkpoint exists for ${frozen.tag}.`);
      journal = readJson(lock.journalPath, "release checkpoint");
      validateJournal(journal, identityFields);
      // Until the tag exists the notes still have to be typed into it, so a
      // resume must present the same file. Once the tag carries them the
      // checkpoint's text is the one source; a resume then needs no file, and
      // a file that no longer matches is only refused before the tag.
      if (!stageAtLeast(journal, "tag-pushed")) {
        if (!notes) fail("--resume before the tag exists needs --notes FILE, the same notes the checkpoint was started with.");
        if (journal.notesDigest !== notes.digest) fail("The release notes differ from the checkpoint's; resume with the same notes or start a new release.");
      } else if (notes && journal.notesDigest !== notes.digest) {
        fail(`The release notes differ from the ones in the tag; resume without --notes (the checkpoint carries them) or start a new release.`);
      }
    } else {
      if (existsSync(lock.journalPath)) fail(`Checkpoint ${lock.journalPath} already exists; use --resume after inspection.`);
      journal = {
        ...identityFields,
        frozenRemoteMain: frozen.frozenRemoteMain,
        stage: "created",
        createdAt: new Date().toISOString(),
        notes: notes.text,
        notesDigest: notes.digest,
        worktree: createWorktree(exec, frozen.repoRoot, frozen.source, options.version, lock.checkpointId),
      };
      writeJournal(lock.journalPath, journal);
    }
    if (!existsSync(journal.worktree) && !stageAtLeast(journal, "verified")) {
      fail(`Checkpoint worktree is missing: ${journal.worktree}`);
    }
    if (existsSync(journal.worktree)) validateOwnedWorktree(exec, journal);
    if (stageAtLeast(journal, "prepared")) validateCandidate(exec, journal);
    if (!stageAtLeast(journal, "prepared")) {
      const prepared = prepareCandidate({
        exec,
        worktree: journal.worktree,
        version: options.version,
        offline: options.offline,
        resume: options.resume,
      });
      Object.assign(journal, prepared);
      if (journal.candidate !== journal.source) journal.metadataCommit = journal.candidate;
      validateCandidate(exec, journal);
      writeJournal(lock.journalPath, journal, "prepared");
    }
    if (!stageAtLeast(journal, "main-pushed")) {
      journal.mainPushPerformed = pushMain(exec, journal);
      journal.mainPushedAt = new Date().toISOString();
      writeJournal(lock.journalPath, journal, "main-pushed");
    } else if (remoteMain(exec, journal.repoRoot) !== journal.candidate) {
      fail(`Remote main no longer equals checkpoint candidate ${journal.candidate}.`);
    }
    if (!stageAtLeast(journal, "ci-passed")) {
      const run = await waitForWorkflow({
        exec, sleep, now, journal, workflow: CI_WORKFLOW, workflowPath: `.github/workflows/${CI_WORKFLOW}`,
        branch: "main", timeoutMinutes: options.ciTimeoutMinutes,
        onObserved(observed) {
          journal.ciRunId = observed.id ?? observed.databaseId;
          journal.ciRunAttempt = observed.run_attempt ?? 1;
          journal.ciUrl = observed.html_url;
          writeJournal(lock.journalPath, journal);
        },
      });
      journal.ciRunId = run.id;
      journal.ciRunAttempt = run.run_attempt ?? 1;
      journal.ciUrl = run.html_url;
      writeJournal(lock.journalPath, journal, "ci-passed");
    }
    validateWorkflowProof(exec, journal, "ci");
    writeJournal(lock.journalPath, journal);
    if (remoteMain(exec, journal.repoRoot) !== journal.candidate) fail("Remote main moved after source CI; refusing to tag.");
    if (!stageAtLeast(journal, "tag-pushed")) {
      journal.tagPushPerformed = ensureTag(exec, journal, () => writeJournal(lock.journalPath, journal));
      journal.tagPushedAt = new Date().toISOString();
      writeJournal(lock.journalPath, journal, "tag-pushed");
    } else {
      assertRecordedTag(remoteTagIdentity(exec, journal.repoRoot, `refs/tags/${journal.tag}`), journal);
    }
    if (!stageAtLeast(journal, "release-passed")) {
      const run = await waitForWorkflow({
        exec, sleep, now, journal, workflow: RELEASE_WORKFLOW, workflowPath: RELEASE_WORKFLOW_PATH,
        branch: journal.tag, timeoutMinutes: options.releaseTimeoutMinutes,
        onObserved(observed) {
          journal.releaseRunId = observed.id ?? observed.databaseId;
          journal.releaseRunAttempt = observed.run_attempt ?? 1;
          journal.releaseUrl = observed.html_url;
          writeJournal(lock.journalPath, journal);
        },
      });
      journal.releaseRunId = run.id;
      journal.releaseRunAttempt = run.run_attempt ?? 1;
      journal.releaseUrl = run.html_url;
      writeJournal(lock.journalPath, journal, "release-passed");
    }
    validateWorkflowProof(exec, journal, "release");
    // A receipt is not a substitute for today's public asset/provenance facts.
    journal.publication = verifyPublicRelease(exec, journal);
    writeJournal(lock.journalPath, journal, "verified");
    if (existsSync(journal.worktree)) removeWorktree(exec, journal.repoRoot, journal.worktree);
    journal.worktreeRemoved = true;
    journal.completedAt = new Date().toISOString();
    writeJournal(lock.journalPath, journal);
    return {
      status: "published",
      version: journal.version,
      tag: journal.tag,
      source: journal.source,
      candidate: journal.candidate,
      metadataCommit: journal.metadataCommit,
      ciRunId: journal.ciRunId,
      releaseRunId: journal.releaseRunId,
      publication: journal.publication,
      callerFollowUp: `Caller refs and index were not changed. Fast-forward a local main only after confirming it still has no local work: git fetch origin && git switch main && git merge --ff-only origin/main`,
    };
  } catch (error) {
    if (journal) {
      journal.lastError = error instanceof Error ? error.message : String(error);
      writeJournal(lock.journalPath, journal);
      if (stageAtLeast(journal, "tag-pushed")) {
        error.message = `${error.message}\nCheckpoint: ${lock.journalPath}\nActual state: ${publicationState(exec, journal)}.`;
      } else {
        error.message = `${error.message}\nCheckpoint: ${lock.journalPath}`;
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  const result = await runRelease(options);
  if (result.status === "dry-run") {
    process.stdout.write(
      `Dry run only; no Git or GitHub writes.\n` +
      `Source: ${result.source}\nRemote main: ${result.frozenRemoteMain}\nTag: ${result.tag} (${result.remoteTagSha ?? "absent"})\n` +
      `Release: ${result.release ? (result.release.draft ? "draft" : "published") : "absent"}\n` +
      `Exact-SHA CI: ${result.existingCiRun ? `${result.existingCiRun.status}/${result.existingCiRun.conclusion ?? "pending"}` : "not found yet"}\n` +
      `Notes: ${result.notes ? `${result.notes.path} (${result.notes.lines} lines)` : "none given; --publish needs --notes FILE"}\n` +
      `Authorized execution: ${result.next}\n`,
    );
  } else {
    process.stdout.write(
      `Published ${result.tag} from candidate ${result.candidate}.\n` +
      `Source CI run: ${result.ciRunId}; release run: ${result.releaseRunId}; assets: ${result.publication.assets} (inventory checked, nothing downloaded).\n` +
      `Notes: in the ${result.tag} annotation and on the release page.\n` +
      `${result.callerFollowUp}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
