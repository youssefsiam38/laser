import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants as osConstants, tmpdir } from "node:os";
import {
  ReleaseError,
  assertRecordedTag,
  assertRemoteMainCarriesCandidate,
  ensureTag,
  installInterruptGuard,
  runRelease,
  loadReleaseNotes,
  assertVersionOnlyContent,
  validateCandidate,
  validateWorkflowProof,
  acquireReleaseLock,
  parseArgs,
  preflight,
  prepareCandidate,
  publicationState,
  pushMain,
  selectWorkflowRun,
  systemExec,
  verifyPublicRelease,
  waitForWorkflow,
} from "../release.mjs";
import { identity } from "../../identity/identity.mjs";

const SHA = "a".repeat(40);
const MAIN = "b".repeat(40);

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

function git(cwd, ...args) {
  return systemExec("git", args, { cwd }).stdout.trim();
}

function temp(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dryRunExec({ apiError = false } = {}) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") return ok(SHA);
    if (command === "git" && args[0] === "cat-file") return ok();
    if (command === "git" && args[0] === "remote") return ok(`https://github.com/${identity.repository}.git`);
    if (command === "git" && args[0] === "merge-base") return ok();
    if (command === "git" && args[0] === "ls-remote" && args.includes("refs/heads/main")) {
      return ok(`${MAIN}\trefs/heads/main\n`);
    }
    if (command === "git" && args[0] === "ls-remote") return ok();
    if (command === "gh" && args[0] === "release" && args[1] === "view") {
      return apiError ? { code: 1, stdout: "", stderr: "network unavailable" } : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    }
    if (command === "gh" && args[0] === "api" && args[1].includes("/actions/workflows/")) {
      return ok(JSON.stringify({ workflow_runs: [] }));
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, exec };
}

test("argument contract keeps dry-run read-only and publish explicit", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(parseArgs(["0.3.8", "--source", SHA]).publish, false);
  assert.throws(() => parseArgs(["0.3.8", "--publish"]), /requires --source/);
  assert.throws(() => parseArgs(["0.3.8", "--publish", "--source", SHA]), /requires --notes FILE/);
  assert.equal(parseArgs(["0.3.8", "--publish", "--source", SHA, "--notes", "notes.md"]).notesFile, "notes.md");
  // A resume may run without the notes file: after the tag exists the checkpoint carries them.
  assert.equal(parseArgs(["0.3.8", "--publish", "--resume", "--source", SHA]).notesFile, "");
  assert.throws(() => parseArgs(["0.3.8", "--resume"]), /only with --publish/);
  assert.throws(() => parseArgs(["0.3.8", "--recover-stale-lock", "--publish", "--source", SHA, "--notes", "notes.md"]), /requires --publish --resume/);
});

test("dry-run preflight performs no local or remote writes", () => {
  const fake = dryRunExec();
  const result = preflight({ exec: fake.exec, repoRoot: "/fixture", version: "0.3.8", source: SHA });
  assert.equal(result.source, SHA);
  assert.equal(result.frozenRemoteMain, MAIN);
  assert.equal(result.remoteTagSha, null);
  assert.equal(result.release, null);
  const writes = fake.calls.filter((call) =>
    (call[0] === "git" && ["add", "commit", "push", "tag", "worktree", "reset", "clean", "stash"].includes(call[1])) ||
    (call[0] === "gh" && call[1] !== "api" && !(call[1] === "release" && call[2] === "view")),
  );
  assert.deepEqual(writes, []);
});

test("GitHub errors are not treated as an absent release", () => {
  const fake = dryRunExec({ apiError: true });
  assert.throws(() => preflight({ exec: fake.exec, repoRoot: "/fixture", version: "0.3.8", source: SHA }), /not evidence of absence/);
});

test("workflow discovery accepts one exact rerun attempt and rejects ambiguity", () => {
  const base = { id: 7, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: SHA };
  const selected = selectWorkflowRun([
    { ...base, run_attempt: 1, status: "completed", conclusion: "failure" },
    { ...base, run_attempt: 2, status: "completed", conclusion: "success" },
    { id: 8, path: ".github/workflows/ci.yml", event: "pull_request", head_branch: "main", head_sha: SHA },
  ], { workflowPath: ".github/workflows/ci.yml", event: "push", branch: "main", headSha: SHA });
  assert.equal(selected.run_attempt, 2);
  assert.equal(selected.conclusion, "success");
  assert.throws(() => selectWorkflowRun([
    { ...base, id: 7 },
    { ...base, id: 9 },
  ], { workflowPath: ".github/workflows/ci.yml", event: "push", branch: "main", headSha: SHA }), /More than one/);
});

test("workflow wait adopts an already-successful exact-SHA run and fails closed on cancellation or timeout", async () => {
  const workflowPath = ".github/workflows/ci.yml";
  const run = { id: 17, path: workflowPath, event: "push", head_branch: "main", head_sha: SHA, run_attempt: 3 };
  const makeExec = (detail, list = [run]) => (command, args) => {
    assert.equal(command, "gh");
    if (args[1].includes("/actions/workflows/")) return ok(JSON.stringify({ workflow_runs: list }));
    if (args[1].includes("/actions/runs/17")) return ok(JSON.stringify({ ...run, ...detail }));
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  let slept = false;
  const adopted = await waitForWorkflow({
    exec: makeExec({ status: "completed", conclusion: "success" }),
    sleep: async () => { slept = true; }, now: () => 0,
    journal: { candidate: SHA }, workflow: "ci.yml", workflowPath, branch: "main", timeoutMinutes: 1,
  });
  assert.equal(adopted.run_attempt, 3);
  assert.equal(slept, false);
  await assert.rejects(waitForWorkflow({
    exec: makeExec({ status: "completed", conclusion: "cancelled" }),
    sleep: async () => {}, now: () => 0,
    journal: { candidate: SHA }, workflow: "ci.yml", workflowPath, branch: "main", timeoutMinutes: 1,
  }), /finished cancelled/);
  let clock = 0;
  await assert.rejects(waitForWorkflow({
    exec: makeExec({}, []), sleep: async (ms) => { clock += ms; }, now: () => clock,
    journal: { candidate: SHA }, workflow: "ci.yml", workflowPath, branch: "main", timeoutMinutes: 0.001,
  }), /Timed out/);
});

test("exclusive lock rejects overlap and validates explicit stale recovery", () => {
  const commonDir = temp("release-lock");
  const first = acquireReleaseLock({ commonDir, version: "0.3.8", source: SHA, resume: false, recoverStaleLock: false });
  assert.throws(() => acquireReleaseLock({ commonDir, version: "0.3.8", source: SHA, resume: false, recoverStaleLock: false }), /already running/);
  first.release();

  const root = join(commonDir, `${identity.dirName}-release`);
  const lock = join(root, "lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    id: "stale-lock", checkpointId: "checkpoint", pid: 99999999, version: "0.3.8", source: SHA, commonDir,
  }));
  writeFileSync(join(root, "v0.3.8.json"), JSON.stringify({ id: "checkpoint", version: "0.3.8", source: SHA, commonDir }));
  assert.throws(() => acquireReleaseLock({ commonDir, version: "0.3.8", source: SHA, resume: true, recoverStaleLock: false }), /--recover-stale-lock/);
  const recovered = acquireReleaseLock({ commonDir, version: "0.3.8", source: SHA, resume: true, recoverStaleLock: true });
  assert.ok(readdirSync(root).some((name) => name.startsWith("lock.stale-")));
  recovered.release();
  rmSync(commonDir, { recursive: true, force: true });
});

function makePreparationRepo(version) {
  const root = temp("release-prepare");
  git(root, "init");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  mkdirSync(join(root, "packages", "one"), { recursive: true });
  mkdirSync(join(root, "packages", "protocol", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
  writeFileSync(join(root, "packages", "one", "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
  writeFileSync(join(root, "packages", "protocol", "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
  writeFileSync(join(root, "packages", "protocol", "src", "product.generated.ts"), `export const PRODUCT_VERSION: string = "${version}";\n`);
  mkdirSync(join(root, "scripts", "release"), { recursive: true });
  writeFileSync(join(root, "scripts", "release", "set-version.sh"), "fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return root;
}

function preparationExec(root, target, observations, unexpected = false) {
  return (command, args, options = {}) => {
    if (command === "pnpm") {
      observations.push({ args: [...args], hasIndex: Object.hasOwn(options.env ?? {}, "GIT_INDEX_FILE") });
      return ok();
    }
    if (command === "bash") {
      for (const path of ["package.json", "packages/one/package.json", "packages/protocol/package.json"]) {
        const file = join(root, path);
        const json = JSON.parse(readFileSync(file, "utf8"));
        json.version = target;
        writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
      }
      writeFileSync(join(root, "packages/protocol/src/product.generated.ts"), `export const PRODUCT_VERSION: string = "${target}";\n`);
      if (unexpected) writeFileSync(join(root, "unexpected.txt"), "not metadata\n");
      return ok();
    }
    return systemExec(command, args, options);
  };
}

test("already synchronized source verifies without a spurious commit or alternate index", () => {
  const root = makePreparationRepo("0.3.8");
  const before = git(root, "rev-parse", "HEAD");
  const observations = [];
  const result = prepareCandidate({ exec: preparationExec(root, "0.3.8", observations), worktree: root, version: "0.3.8" });
  assert.equal(result.candidate, before);
  assert.equal(result.metadataCommit, null);
  assert.deepEqual(result.changed, []);
  assert.ok(observations.some((item) => item.args[0] === "verify"));
  assert.ok(observations.every((item) => item.hasIndex === false));
  rmSync(root, { recursive: true, force: true });
});

test("resume revalidates and completes an already-staged metadata checkpoint", () => {
  const root = makePreparationRepo("0.3.7");
  const observations = [];
  const exec = preparationExec(root, "0.3.8", observations);
  exec("bash", ["scripts/release/set-version.sh", "0.3.8"]);
  git(root, "add", "package.json", "packages/one/package.json", "packages/protocol/package.json", "packages/protocol/src/product.generated.ts");
  const result = prepareCandidate({ exec, worktree: root, version: "0.3.8", resume: true });
  assert.ok(result.metadataCommit);
  assert.equal(git(root, "status", "--porcelain"), "");
  rmSync(root, { recursive: true, force: true });
});

test("version preparation commits only explicit metadata and refuses an unexpected file", () => {
  const root = makePreparationRepo("0.3.7");
  const observations = [];
  const result = prepareCandidate({ exec: preparationExec(root, "0.3.8", observations), worktree: root, version: "0.3.8" });
  assert.ok(result.metadataCommit);
  assert.deepEqual(result.changed, [
    "package.json",
    "packages/one/package.json",
    "packages/protocol/package.json",
    "packages/protocol/src/product.generated.ts",
  ]);
  assert.equal(git(root, "status", "--porcelain"), "");
  rmSync(root, { recursive: true, force: true });

  const bad = makePreparationRepo("0.3.7");
  assert.throws(() => prepareCandidate({
    exec: preparationExec(bad, "0.3.8", [], true), worktree: bad, version: "0.3.8",
  }), /untracked files/);
  rmSync(bad, { recursive: true, force: true });
});

test("an already-pushed candidate is a no-op and does not touch the remote", () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") return ok(`${SHA}\trefs/heads/main\n`);
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  assert.equal(pushMain(exec, {
    repoRoot: "/caller", worktree: "/isolated", frozenRemoteMain: MAIN, candidate: SHA,
  }), false);
  assert.ok(!calls.some((call) => call[1] === "push"));
});

test("branch and tag races fail before any push", async () => {
  const calls = [];
  const moved = "d".repeat(40);
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote" && args.includes("refs/heads/main")) {
      return ok(`${moved}\trefs/heads/main\n`);
    }
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  assert.throws(() => pushMain(exec, {
    repoRoot: "/caller", worktree: "/isolated", frozenRemoteMain: MAIN, candidate: SHA,
  }), /Remote main moved/);
  assert.ok(!calls.some((call) => call[1] === "push"));

  const tagCalls = [];
  const tagExec = (command, args) => {
    tagCalls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") return ok(`${moved}\trefs/tags/v0.3.8\n${MAIN}\trefs/tags/v0.3.8^{}\n`);
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  const { ensureTag } = await import("../release.mjs");
  assert.throws(() => ensureTag(tagExec, {
    repoRoot: "/caller", worktree: "/isolated", tag: "v0.3.8", candidate: SHA, tagObject: moved,
  }), /checkpoint object/);
  assert.ok(!tagCalls.some((call) => call[1] === "push" || call[1] === "tag"));
});

test("ordinary candidate push leaves caller ref, index and unrelated files untouched", () => {
  const root = temp("release-push");
  const bare = join(root, "remote.git");
  const caller = join(root, "caller");
  const worktree = join(root, "isolated");
  git(root, "init", "--bare", bare);
  git(root, "clone", bare, caller);
  git(caller, "config", "user.email", "fixture@example.invalid");
  git(caller, "config", "user.name", "Fixture");
  writeFileSync(join(caller, "tracked.txt"), "one\n");
  writeFileSync(join(caller, "delete-me.txt"), "delete\n");
  git(caller, "add", ".");
  git(caller, "commit", "-m", "base");
  git(caller, "branch", "-M", "main");
  git(caller, "push", "-u", "origin", "main");
  const base = git(caller, "rev-parse", "HEAD");
  git(caller, "worktree", "add", "--detach", worktree, base);
  git(worktree, "config", "user.email", "fixture@example.invalid");
  git(worktree, "config", "user.name", "Fixture");
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  git(worktree, "add", "candidate.txt");
  git(worktree, "commit", "-m", "candidate");
  const candidate = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(caller, "tracked.txt"), "dirty\n");
  rmSync(join(caller, "delete-me.txt"));
  writeFileSync(join(caller, "untracked.txt"), "keep\n");
  const statusBefore = git(caller, "status", "--porcelain=v1", "--untracked-files=all");
  assert.equal(pushMain(systemExec, { repoRoot: caller, worktree, frozenRemoteMain: base, candidate }), true);
  assert.equal(git(caller, "rev-parse", "HEAD"), base);
  assert.equal(git(caller, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(git(caller, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], candidate);
  rmSync(root, { recursive: true, force: true });
});

function publicReleaseFixture(version = "0.3.8", source = "c".repeat(40)) {
  const directory = temp("release-public-fixture");
  const names = ["install.sh"];
  for (const arch of ["x86_64", "arm64"]) names.push(`${identity.displayName}-${version}-${arch}.AppImage`);
  for (const arch of ["amd64", "arm64"]) names.push(`${identity.binary}_${version}_${arch}.deb`);
  for (const arch of ["x86_64", "aarch64"]) names.push(`${identity.binary}-${version}.${arch}.rpm`, `${identity.binary}-${version}-${arch}.tar.gz`);
  for (const name of names) writeFileSync(join(directory, name), `${name}\n`);
  writeFileSync(join(directory, "SHA256SUMS"), `${names.sort().map((name) => `${sha256(join(directory, name))}  ${name}`).join("\n")}\n`);
  writeFileSync(join(directory, "provenance.jsonl"), "signed fixture\n");
  const files = readdirSync(directory).sort();
  const assets = files.map((name, index) => ({
    id: 1000 + index,
    name,
    size: readFileSync(join(directory, name)).length,
    state: "uploaded",
    digest: `sha256:${sha256(join(directory, name))}`,
  }));
  const notes = "## What changed\n\n- one\n";
  const release = { id: 44, draft: false, prerelease: false, tag_name: `v${version}`, html_url: "https://example.invalid/release", body: notes, assets };
  return { version, source, directory, release, notes };
}

/** The gh/git calls public verification makes, answered from the fixture; `calls` records them. */
function publicExec(fixture, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") {
      return ok(`${"d".repeat(40)}\trefs/tags/v${fixture.version}\n${fixture.source}\trefs/tags/v${fixture.version}^{}\n`);
    }
    if (command === "gh" && args[0] === "release" && args[1] === "view") return ok(JSON.stringify({ databaseId: fixture.release.id }));
    if (command === "gh" && args[0] === "api" && args[1].endsWith("/releases/44")) return ok(JSON.stringify(fixture.release));
    if (command === "gh" && args[0] === "api" && args[1].endsWith("/releases/latest")) return ok(JSON.stringify({ id: fixture.release.id }));
    if (command === "gh" && args[0] === "api" && args[1] === "-H") {
      const id = Number(args[3].split("/").pop());
      const asset = fixture.release.assets.find((item) => item.id === id);
      if (!asset) return { code: 1, stdout: "", stderr: "HTTP 404" };
      return ok(readFileSync(join(fixture.directory, asset.name), "utf8"));
    }
    if (command === "gh" && args[0] === "attestation" && args[1] === "verify") {
      fixture.verified = args;
      return ok("[]");
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

function publicJournal(fixture) {
  return { repoRoot: "/fixture", version: fixture.version, tag: `v${fixture.version}`, candidate: fixture.source, tagObject: "d".repeat(40), notes: fixture.notes };
}

test("public verification reads the inventory through the API and downloads no installer", () => {
  const fixture = publicReleaseFixture();
  const calls = [];
  const exec = publicExec(fixture, calls);
  const journal = publicJournal(fixture);
  const result = verifyPublicRelease(exec, journal);
  assert.equal(result.assets, fixture.release.assets.length);
  assert.equal(result.releaseId, 44);
  assert.ok(!calls.some((call) => call[1] === "release" && call[2] === "download"));
  // Only the manifest and the bundle are fetched; every installer stays on GitHub.
  const fetched = calls.filter((call) => call[1] === "api" && call[2] === "-H").map((call) => Number(call[4].split("/").pop()));
  const names = fetched.map((id) => fixture.release.assets.find((asset) => asset.id === id).name).sort();
  assert.deepEqual(names, ["SHA256SUMS", "SHA256SUMS", "provenance.jsonl"]);
  fixture.release.assets.find((asset) => asset.name === "install.sh").state = "starter";
  assert.throws(() => verifyPublicRelease(exec, journal), /not uploaded: install.sh/);
  fixture.release.assets = fixture.release.assets.filter((asset) => asset.name !== "install.sh");
  assert.throws(() => verifyPublicRelease(exec, journal), /missing install.sh/);
  rmSync(fixture.directory, { recursive: true, force: true });
});

test("public verification compares every asset digest to the published SHA256SUMS", () => {
  const fixture = publicReleaseFixture();
  const exec = publicExec(fixture);
  const journal = publicJournal(fixture);
  verifyPublicRelease(exec, journal);
  // An asset replaced after publication keeps its name, state and a plausible size.
  const clobbered = fixture.release.assets.find((asset) => asset.name.endsWith("x86_64.AppImage"));
  const before = clobbered.digest;
  clobbered.digest = `sha256:${"e".repeat(64)}`;
  assert.throws(() => verifyPublicRelease(exec, journal), /does not match SHA256SUMS/);
  clobbered.digest = before;
  // A digest the API does not report cannot be waved through.
  delete clobbered.digest;
  assert.throws(() => verifyPublicRelease(exec, journal), /reports no SHA-256 digest/);
  clobbered.digest = before;
  // A manifest that lists fewer files than the inventory is not coverage.
  const manifest = readFileSync(join(fixture.directory, "SHA256SUMS"), "utf8");
  writeFileSync(join(fixture.directory, "SHA256SUMS"), manifest.split("\n").filter((line) => !line.endsWith("install.sh")).join("\n"));
  assert.throws(() => verifyPublicRelease(exec, journal), /coverage does not match/);
  rmSync(fixture.directory, { recursive: true, force: true });
});

test("public verification checks the provenance bundle once, with the source pinned", () => {
  const fixture = publicReleaseFixture();
  const exec = publicExec(fixture);
  const journal = publicJournal(fixture);
  verifyPublicRelease(exec, journal);
  const verify = fixture.verified;
  assert.ok(verify, "gh attestation verify ran");
  assert.equal(verify[verify.indexOf("--source-digest") + 1], fixture.source);
  assert.equal(verify[verify.indexOf("--source-ref") + 1], `refs/tags/v${fixture.version}`);
  assert.equal(verify[verify.indexOf("--signer-workflow") + 1], `${identity.repository}/.github/workflows/release.yml`);
  assert.ok(verify[2].endsWith("SHA256SUMS"));
  // A bundle that does not verify fails the release, exactly as it would fail every install.
  const failing = (command, args) => (command === "gh" && args[0] === "attestation" ? { code: 1, stdout: "", stderr: "no matching attestation" } : exec(command, args));
  assert.throws(() => verifyPublicRelease(failing, journal), /no matching attestation/);
  rmSync(fixture.directory, { recursive: true, force: true });
});

test("public verification refuses a release page that is not the tag's notes", () => {
  const fixture = publicReleaseFixture();
  const exec = publicExec(fixture);
  const journal = publicJournal(fixture);
  fixture.release.body = "## What's Changed\n* feat: something by @someone\n";
  assert.throws(() => verifyPublicRelease(exec, journal), /not the release notes the tag carries/);
  fixture.release.body = `${fixture.notes.trim()}\r\n`;
  verifyPublicRelease(exec, journal);
  rmSync(fixture.directory, { recursive: true, force: true });
});

test("public verification rejects an unexpected remote asset", () => {
  const fixture = publicReleaseFixture();
  fixture.release.assets.push({ id: 9999, name: "unexpected.bin", size: 1, state: "uploaded", digest: `sha256:${"a".repeat(64)}` });
  assert.throws(() => verifyPublicRelease(publicExec(fixture), publicJournal(fixture)), /unexpected assets/);
  rmSync(fixture.directory, { recursive: true, force: true });
});

test("release notes come from a non-empty file and are digested for the checkpoint", () => {
  const root = temp("release-notes");
  writeFileSync(join(root, "empty.md"), "\n  \n");
  assert.throws(() => loadReleaseNotes(join(root, "empty.md")), /is empty/);
  assert.throws(() => loadReleaseNotes(join(root, "missing.md")), /could not be read/);
  writeFileSync(join(root, "notes.md"), "## What changed\r\n\r\n- one\r\n");
  const notes = loadReleaseNotes(join(root, "notes.md"));
  assert.equal(notes.text, "## What changed\n\n- one\n");
  assert.equal(notes.lines, 3);
  assert.match(notes.digest, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

test("post-publication workflow failure reports publication truth without editing it", () => {
  const exec = (command, args) => {
    assert.equal(command, "gh");
    if (args[0] === "release" && args[1] === "view") return ok(JSON.stringify({ databaseId: 44 }));
    assert.deepEqual(args.slice(0, 2), ["api", `repos/${identity.repository}/releases/44`]);
    return ok(JSON.stringify({ draft: false }));
  };
  assert.equal(publicationState(exec, { tag: "v0.3.8", stage: "tag-pushed" }), "published; deployment incomplete");
  assert.equal(publicationState(exec, { tag: "v0.3.8", stage: "release-passed" }), "published; workflow succeeded; inventory check incomplete");
});

test("an unpublished in-progress release reports building state from its recorded run", () => {
  const exec = (command, args) => {
    if (args[0] === "release" && args[1] === "view") return { code: 1, stdout: "", stderr: "release not found" };
    if (args[1].includes("/actions/runs/71")) return ok(JSON.stringify({ status: "in_progress", conclusion: null }));
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  assert.equal(publicationState(exec, { tag: "v0.3.8", stage: "tag-pushed", releaseRunId: 71 }), "tag pushed; release workflow in_progress");
});


test("non-404 Not Found errors remain fatal and private drafts stay visible", () => {
  const fake = dryRunExec();
  const unavailable = (command, args, options) => args[0] === "release" && args[1] === "view"
    ? { code: 1, stdout: "", stderr: "HTTP 503: Not Found upstream" } : fake.exec(command, args, options);
  assert.throws(() => preflight({ exec: unavailable, repoRoot: "/fixture", version: "0.3.8", source: SHA }), /not evidence of absence/);
  const draft = (command, args) => args[0] === "release" ? ok('{"databaseId":44}') : ok('{"draft":true}');
  assert.equal(publicationState(draft, { tag: "v0.3.8", stage: "tag-pushed" }), "tag pushed; release draft remains private");
});

test("manifest validation rejects non-version changes before install on resume", () => {
  assert.throws(() => assertVersionOnlyContent('{"version":"0.3.7","scripts":{"test":"test"}}', '{"version":"0.3.8","scripts":{"test":"skip"}}', "package.json", "0.3.8"), /other than/);
  const root = makePreparationRepo("0.3.8");
  writeFileSync(join(root, "package.json"), '{"version":"0.3.8","description":"not reviewed"}');
  const observations = [];
  assert.throws(() => prepareCandidate({ exec: preparationExec(root, "0.3.8", observations), worktree: root, version: "0.3.8", resume: true }), /other than/);
  assert.equal(observations.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("all Git operations ignore and preserve a caller alternate index", () => {
  const root = makePreparationRepo("0.3.7");
  const alternate = join(root, "alternate-index");
  cpSync(join(root, ".git", "index"), alternate);
  // Keep the alternate outside the worktree so it is not an untracked input.
  const external = temp("release-index");
  const index = join(external, "index");
  cpSync(alternate, index); rmSync(alternate);
  const before = readFileSync(index);
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    prepareCandidate({ exec: preparationExec(root, "0.3.8", []), worktree: root, version: "0.3.8" });
    assert.deepEqual(readFileSync(index), before);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous;
    rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true });
  }
});

test("subprocess and workflow requests have finite remaining budgets", async () => {
  assert.throws(() => systemExec(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 20 }), /ETIMEDOUT/);
  let budget;
  await assert.rejects(waitForWorkflow({
    exec(_command, _args, options) { budget = options.timeoutMs; throw new Error("timed request"); },
    sleep: async () => {}, now: () => 0, journal: { candidate: SHA }, workflow: "ci.yml",
    workflowPath: ".github/workflows/ci.yml", branch: "main", timeoutMinutes: 0.01,
  }), /timed request/);
  assert.equal(budget, 600);
});

test("candidate lineage rejects a moved or unrelated synchronized-version HEAD", () => {
  const root = makePreparationRepo("0.3.8");
  const source = git(root, "rev-parse", "HEAD");
  validateCandidate(systemExec, { repoRoot: root, source, candidate: source, version: "0.3.8" });
  writeFileSync(join(root, "unreviewed.txt"), "not version metadata");
  git(root, "add", "unreviewed.txt"); git(root, "commit", "-m", "unreviewed");
  const candidate = git(root, "rev-parse", "HEAD");
  assert.throws(() => validateCandidate(systemExec, { repoRoot: root, source, candidate, version: "0.3.8" }), /outside release metadata/);
  rmSync(root, { recursive: true, force: true });
});

test("resume rejects stale CI proof and may adopt a newer successful attempt", () => {
  const journal = { candidate: SHA, ciRunId: 17, ciRunAttempt: 1 };
  const run = { id: 17, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: SHA, run_attempt: 2, status: "completed", conclusion: "cancelled" };
  assert.throws(() => validateWorkflowProof(() => ok(JSON.stringify(run)), journal, "ci"), /no longer/);
  run.conclusion = "success";
  validateWorkflowProof(() => ok(JSON.stringify(run)), journal, "ci");
  assert.equal(journal.ciRunAttempt, 2);
});

test("origin diagnostics never print embedded credentials", () => {
  const fake = dryRunExec();
  const exec = (command, args, options) => command === "git" && args[0] === "remote"
    ? ok(`https://secret-token@github.com/${identity.repository}.git`) : fake.exec(command, args, options);
  assert.throws(() => preflight({ exec, repoRoot: "/fixture", version: "0.3.8", source: SHA }), error => !error.message.includes("secret-token") && error.message.includes("origin does not match"));
});


test("release tags reject lightweight locals and same-commit object replacement", () => {
  const root = makePreparationRepo("0.3.8");
  const candidate = git(root, "rev-parse", "HEAD");
  git(root, "tag", "v0.3.8");
  const exec = (command, args, options) => args[0] === "ls-remote" ? ok() : systemExec(command, args, options);
  assert.throws(() => ensureTag(exec, { repoRoot: root, worktree: root, tag: "v0.3.8", version: "0.3.8", candidate }), /lightweight/);
  assert.throws(() => assertRecordedTag({ object: "a".repeat(40), commit: candidate, annotated: true }, { tag: "v0.3.8", candidate, tagObject: "b".repeat(40) }), /checkpoint object/);
  rmSync(root, { recursive: true, force: true });
});

test("annotated tag ownership is checkpointed before remote push", () => {
  const root = makePreparationRepo("0.3.8");
  const candidate = git(root, "rev-parse", "HEAD");
  const notes = "## What changed\n\n- The opening screen no longer waits out a hidden question.\n";
  const journal = { repoRoot: root, worktree: root, tag: "v0.3.8", version: "0.3.8", candidate, notes };
  let pushed = false, checkpointed = false;
  const exec = (command, args, options) => {
    if (args[0] === "ls-remote" && args.includes("--heads")) return ok(`${candidate}\trefs/heads/main\n`);
    if (args[0] === "ls-remote") return pushed ? ok(`${journal.tagObject}\trefs/tags/v0.3.8\n${candidate}\trefs/tags/v0.3.8^{}\n`) : ok();
    if (args[0] === "push") { assert.equal(checkpointed, true); pushed = true; return ok(); }
    return systemExec(command, args, options);
  };
  // Without notes there is no tag: the notes are the tag's body.
  assert.throws(() => ensureTag(exec, { repoRoot: root, worktree: root, tag: "v0.3.8", version: "0.3.8", candidate }), /carries the release notes/);
  assert.equal(ensureTag(exec, journal, () => { checkpointed = true; assert.equal(git(root, "cat-file", "-t", journal.tagObject), "tag"); }), true);
  assert.equal(pushed, true);
  assert.equal(git(root, "tag", "-l", "--format=%(contents:subject)", "v0.3.8"), `${identity.displayName} 0.3.8`);
  assert.equal(`${git(root, "tag", "-l", "--format=%(contents:body)", "v0.3.8")}\n`, notes);
  rmSync(root, { recursive: true, force: true });
});

/**
 * A repository shaped like the one a release runs against: a reviewed source
 * commit, its version-only child (the candidate), and HEAD detached on the
 * source, exactly where the caller stands when it resumes.
 */
function releaseLineageRepo(from, to) {
  const root = temp("release-resume");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts", "release"), { recursive: true });
  mkdirSync(join(root, "packages", "protocol", "src"), { recursive: true });
  for (const name of ["ci.yml", "release.yml"]) writeFileSync(join(root, ".github", "workflows", name), "fixture\n");
  for (const name of ["release.mjs", "set-version.sh"]) writeFileSync(join(root, "scripts", "release", name), "fixture\n");
  const setVersion = (version) => {
    for (const path of ["package.json", "packages/protocol/package.json"]) {
      writeFileSync(join(root, path), `${JSON.stringify({ version }, null, 2)}\n`);
    }
    writeFileSync(join(root, "packages/protocol/src/product.generated.ts"), `export const PRODUCT_VERSION: string = "${version}";\n`);
  };
  setVersion(from);
  git(root, "add", ".");
  git(root, "commit", "-m", "reviewed source");
  const source = git(root, "rev-parse", "HEAD");
  setVersion(to);
  git(root, "add", ".");
  git(root, "commit", "-m", `chore(release): prepare ${to}`);
  const candidate = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "later.txt"), "work that landed after the release\n");
  git(root, "add", "later.txt");
  git(root, "commit", "-m", "later work");
  const descendant = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--detach", source);
  return { root, source, candidate, descendant };
}

/** The remote-side answers a post-tag resume needs; `calls` records every command. */
function resumeExec(repo, fixture, state, calls = []) {
  const tag = `v${fixture.version}`;
  const ciRun = {
    id: 501, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: repo.candidate,
    run_attempt: 1, status: "completed", conclusion: "success", html_url: "https://example.invalid/ci",
  };
  const releaseRun = {
    id: 777, path: ".github/workflows/release.yml", event: "push", head_branch: tag, head_sha: repo.candidate,
    run_attempt: 1, status: "completed", conclusion: "success", html_url: "https://example.invalid/release",
  };
  return (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") return ok(`git@github.com:${identity.repository}.git`);
    if (command === "git" && args[0] === "ls-remote" && args.includes("--heads")) return ok(`${state.remoteMain}\trefs/heads/main\n`);
    if (command === "git" && args[0] === "ls-remote") return ok(`${state.tagObject}\trefs/tags/${tag}\n${repo.candidate}\trefs/tags/${tag}^{}\n`);
    if (command === "git") return systemExec(command, args, { ...options, cwd: options.cwd ?? repo.root });
    if (command === "gh" && args[0] === "release" && args[1] === "view") return ok(JSON.stringify({ databaseId: fixture.release.id }));
    if (command === "gh" && args[0] === "attestation") { fixture.verified = args; return ok("[]"); }
    if (command === "gh" && args[0] === "api" && args[1] === "-H") {
      const asset = fixture.release.assets.find((item) => item.id === Number(args[3].split("/").pop()));
      return asset ? ok(readFileSync(join(fixture.directory, asset.name), "utf8")) : { code: 1, stdout: "", stderr: "HTTP 404" };
    }
    if (command === "gh" && args[0] === "api") {
      const endpoint = args[1];
      if (endpoint.includes("/actions/workflows/ci.yml/runs")) return ok(JSON.stringify({ workflow_runs: [ciRun] }));
      if (endpoint.includes("/actions/workflows/release.yml/runs")) return ok(JSON.stringify({ workflow_runs: [releaseRun] }));
      if (endpoint.endsWith("/actions/runs/501")) return ok(JSON.stringify(ciRun));
      if (endpoint.endsWith("/actions/runs/777")) return ok(JSON.stringify(releaseRun));
      if (endpoint.endsWith(`/releases/${fixture.release.id}`)) return ok(JSON.stringify(fixture.release));
      if (endpoint.endsWith("/releases/latest")) return ok(JSON.stringify({ id: fixture.release.id }));
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

function postTagCheckpoint(repo, fixture, state) {
  const commonDir = join(repo.root, ".git");
  const journalPath = join(commonDir, `${identity.dirName}-release`, `v${fixture.version}.json`);
  const journal = {
    id: "checkpoint-resume",
    version: fixture.version,
    source: repo.source,
    commonDir,
    repoRoot: repo.root,
    origin: identity.repository,
    tag: `v${fixture.version}`,
    frozenRemoteMain: repo.source,
    stage: "tag-pushed",
    createdAt: "2026-09-13T16:10:10.123Z",
    notes: fixture.notes,
    notesDigest: createHash("sha256").update(fixture.notes.trim()).digest("hex"),
    // Reaped since the tag was pushed, as the 0.6.1 checkpoint's was.
    worktree: join(tmpdir(), `${identity.dirName}-release-${fixture.version}-gone`),
    candidate: repo.candidate,
    metadataCommit: repo.candidate,
    mainPushPerformed: true,
    ciRunId: 501,
    ciRunAttempt: 1,
    tagObject: state.tagObject,
    tagPushPerformed: true,
  };
  mkdirSync(join(commonDir, `${identity.dirName}-release`), { recursive: true });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return journalPath;
}

test("a resume after the tag verifies although remote main advanced onto the candidate", async () => {
  const repo = releaseLineageRepo("0.3.7", "0.3.8");
  const fixture = publicReleaseFixture("0.3.8", repo.candidate);
  const state = { remoteMain: repo.candidate, tagObject: "d".repeat(40) };
  const journalPath = postTagCheckpoint(repo, fixture, state);
  const options = { version: "0.3.8", source: repo.source, publish: true, resume: true, notesFile: "", ciTimeoutMinutes: 1, releaseTimeoutMinutes: 1 };
  const signals = new EventEmitter();
  const calls = [];
  const dependencies = { exec: resumeExec(repo, fixture, state, calls), repoRoot: repo.root, sleep: async () => {}, signals };

  // Remote main is the candidate this release created: the reviewed source is
  // behind it by exactly the version-only commit the release made.
  const result = await runRelease(options, dependencies);
  assert.equal(result.status, "published");
  assert.equal(result.publication.assets, fixture.release.assets.length);
  const verified = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(verified.stage, "verified");
  assert.equal(verified.publication.releaseId, fixture.release.id);
  assert.ok(verified.completedAt);
  assert.ok(fixture.verified, "the provenance bundle was verified against the tag's source");
  // Nothing was pushed, tagged or edited: a post-tag resume only reads.
  const writes = calls.filter((call) =>
    (call[0] === "git" && ["push", "tag", "commit", "worktree", "reset", "clean", "stash"].includes(call[1])) ||
    (call[0] === "gh" && call[1] === "release" && call[2] !== "view"));
  assert.deepEqual(writes, []);
  assert.equal(signals.listenerCount("SIGTERM"), 0);

  // Remote main may also have moved past the candidate, as long as it still
  // contains it: the tag and the published bytes are what is being verified.
  postTagCheckpoint(repo, fixture, state);
  state.remoteMain = repo.descendant;
  assert.equal((await runRelease(options, dependencies)).status, "published");
  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).stage, "verified");

  // Remote main that lost the candidate (a rewind or force-push) is still refused.
  postTagCheckpoint(repo, fixture, state);
  state.remoteMain = repo.source;
  await assert.rejects(runRelease(options, dependencies), /does not carry checkpoint candidate/);
  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).stage, "tag-pushed");
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(fixture.directory, { recursive: true, force: true });
});

/** `merge-base --is-ancestor A B` is true only for the pairs given. */
function ancestryExec({ main, tagObject = null, tagCommit = null, ancestry = [] }) {
  const contains = new Set(ancestry.map(([a, b]) => `${a}->${b}`));
  return (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return ok(SHA);
    if (command === "git" && args[0] === "cat-file") return ok();
    if (command === "git" && args[0] === "remote") return ok(`https://github.com/${identity.repository}.git`);
    if (command === "git" && args[0] === "merge-base") {
      return contains.has(`${args[2]}->${args[3]}`) ? ok() : { code: 1, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "ls-remote" && args.includes("--heads")) return ok(`${main}\trefs/heads/main\n`);
    if (command === "git" && args[0] === "ls-remote") {
      return tagObject ? ok(`${tagObject}\trefs/tags/v0.3.8\n${tagCommit}\trefs/tags/v0.3.8^{}\n`) : ok();
    }
    if (command === "gh" && args[0] === "release") return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (command === "gh" && args[0] === "api") return ok(JSON.stringify({ workflow_runs: [] }));
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("the pre-push fast-forward check still refuses a source behind remote main", () => {
  const candidate = "e".repeat(40);
  const ahead = { main: MAIN, ancestry: [[SHA, MAIN]] };
  // No tag yet: this is an unreleased source behind remote main, refused even
  // on a resume — nothing has been published that could excuse it.
  assert.throws(() => preflight({ exec: ancestryExec(ahead), repoRoot: "/fixture", version: "0.3.8", source: SHA, allowRemoteAhead: true }),
    /is not a fast-forward of remote main/);
  // A tag that does not descend from this source proves nothing about it.
  assert.throws(() => preflight({
    exec: ancestryExec({ ...ahead, tagObject: "d".repeat(40), tagCommit: candidate, ancestry: [[SHA, MAIN], [candidate, MAIN]] }),
    repoRoot: "/fixture", version: "0.3.8", source: SHA, allowRemoteAhead: true,
  }), /is not a fast-forward of remote main/);
  // Nor does a tag remote main no longer carries.
  assert.throws(() => preflight({
    exec: ancestryExec({ ...ahead, tagObject: "d".repeat(40), tagCommit: candidate, ancestry: [[SHA, MAIN], [SHA, candidate]] }),
    repoRoot: "/fixture", version: "0.3.8", source: SHA, allowRemoteAhead: true,
  }), /is not a fast-forward of remote main/);
  const published = {
    ...ahead, tagObject: "d".repeat(40), tagCommit: candidate,
    ancestry: [[SHA, MAIN], [SHA, candidate], [candidate, MAIN]],
  };
  // A publication that is not being resumed gets the unchanged refusal, and is
  // told what the person actually wanted: the tag exists, so this is a resume.
  assert.throws(() => preflight({ exec: ancestryExec(published), repoRoot: "/fixture", version: "0.3.8", source: SHA }),
    /is not a fast-forward of remote main .* continued with --publish --resume/s);
  // Only the resume of that released source is tolerated.
  const resumed = preflight({ exec: ancestryExec(published), repoRoot: "/fixture", version: "0.3.8", source: SHA, allowRemoteAhead: true });
  assert.equal(resumed.frozenRemoteMain, MAIN);
  assert.equal(resumed.remoteTagSha, candidate);

  // Before the tag, remote main must still be exactly the candidate.
  const journal = { repoRoot: "/fixture", candidate: SHA, stage: "main-pushed" };
  const moved = (command, args) => {
    if (command === "git" && args[0] === "ls-remote") return ok(`${MAIN}\trefs/heads/main\n`);
    if (command === "git" && args[0] === "merge-base") return ok();
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  assert.throws(() => assertRemoteMainCarriesCandidate(moved, journal, "Remote main moved after source CI; refusing to tag"),
    /refusing to tag: remote main .* does not carry checkpoint candidate/);
  assert.equal(assertRemoteMainCarriesCandidate(moved, { ...journal, stage: "tag-pushed" }, "after"), MAIN);
});

test("an interrupted release records the interruption and frees its lock", () => {
  const commonDir = temp("release-interrupt");
  const lock = acquireReleaseLock({ commonDir, version: "0.3.8", source: SHA, resume: false, recoverStaleLock: false });
  const journal = { id: lock.checkpointId, version: "0.3.8", source: SHA, stage: "tag-pushed" };
  const signals = new EventEmitter();
  const exits = [];
  const reports = [];
  const remove = installInterruptGuard({
    journalPath: lock.journalPath, journal, lock, signals,
    exit: (code) => exits.push(code), report: (text) => reports.push(text),
  });
  // 0.6.1: the process was killed inside the release-workflow wait, so the
  // checkpoint kept `tag-pushed` and said nothing about why, and its lock
  // outlived it. The stage it reached is recorded; the lock is not inherited.
  signals.emit("SIGTERM");
  const recorded = JSON.parse(readFileSync(lock.journalPath, "utf8"));
  assert.equal(recorded.stage, "tag-pushed");
  assert.match(recorded.lastError, /Interrupted by SIGTERM at stage tag-pushed/);
  assert.ok(recorded.interruptedAt);
  assert.deepEqual(exits, [128 + osConstants.signals.SIGTERM]);
  assert.match(reports.join(""), /--publish --resume --source/);
  assert.equal(existsSync(join(commonDir, `${identity.dirName}-release`, "lock")), false);
  remove();
  assert.equal(signals.listenerCount("SIGINT"), 0);
  rmSync(commonDir, { recursive: true, force: true });
});
