import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { artifactTreeSha256 } from "./artifacts.mjs";

export function sourceSha256(workspace, files) {
  const digest = createHash("sha256");
  for (const file of files) {
    const path = resolve(workspace, file);
    if (!path.startsWith(`${workspace}/`)) throw new Error("Invalid source manifest path.");
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Invalid source input: ${file}`);
    if (!realpathSync(path).startsWith(`${workspace}/`)) throw new Error(`Source input escapes the snapshot: ${file}`);
    digest.update(file).update("\0").update(String(stat.mode & 0o777)).update("\0")
      .update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)).update("\0");
  }
  return digest.digest("hex");
}

export function assertCopiedSource(roots, stamp) {
  const files = JSON.parse(readFileSync(join(roots.state, "source-files.json"), "utf8"));
  if (!stamp?.files?.length || JSON.stringify(files) !== JSON.stringify(stamp.files)
    || sourceSha256(roots.workspace, files) !== stamp.sourceSha256) {
    throw new Error("The copied source differs from the checked snapshot. Run prepare again.");
  }
  // New, non-ignored source must not influence a build outside the recorded inputs.
  const extra = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: roots.workspace, encoding: "utf8" })
    .split("\0").filter(file => file && !files.includes(file));
  if (extra.length) throw new Error(`Unrecorded source inputs exist: ${extra.slice(0, 5).join(", ")}`);
}

export function readBuild(roots) {
  const file = join(roots.state, "build.json");
  if (!existsSync(file)) throw new Error("No prepared review build. Run prepare first.");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function checkSource(roots, stamp) {
  const built = readBuild(roots);
  if (!stamp || stamp.sourceSha256 !== built.sourceSha256 || stamp.commit !== built.commit) {
    throw new Error("The checkout differs from the prepared build. Stop this review app and run prepare before launching or verifying.");
  }
  assertCopiedSource(roots, stamp);
  return built;
}

export function invalidateBuild(roots) {
  rmSync(join(roots.state, "build.json"), { force: true });
  rmSync(join(roots.workspace, "packages/ui/dist/review-build.json"), { force: true });
}

export function recordBuild(roots, stamp, operation) {
  assertCopiedSource(roots, stamp);
  const { files, ...summary } = stamp;
  const fingerprint = path => createHash("sha256").update(readFileSync(join(roots.workspace, path))).digest("hex");
  const build = {
    ...summary, fileCount: files.length, builtAt: new Date().toISOString(), operation, node: process.version,
    host: { path: `${roots.workspace}/packages/host/dist/index.js`, sha256: fingerprint("packages/host/dist/index.js") },
    worker: { path: `${roots.workspace}/packages/worker/dist/main.js`, sha256: fingerprint("packages/worker/dist/main.js") },
    frontend: { path: `${roots.workspace}/packages/ui/dist/index.html`, sha256: fingerprint("packages/ui/dist/index.html") },
    lockfileSha256: fingerprint("pnpm-lock.yaml"),
    artifactTrees: Object.fromEntries(["host", "worker", "ui", "protocol", "pi-extension", "pi-goal"].map(name => {
      const directory = `${roots.workspace}/packages/${name}/dist`;
      return [name, { directory, sha256: artifactTreeSha256(directory) }];
    })),
  };
  const contents = `${JSON.stringify(build, null, 2)}\n`;
  // The launch marker is last: failure before it leaves this generation unavailable.
  writeFileSync(join(roots.logs, `build-${operation}-${Date.now()}.json`), contents, { mode: 0o600 });
  writeFileSync(join(roots.workspace, "packages/ui/dist/review-build.json"), contents, { mode: 0o600 });
  writeFileSync(join(roots.state, "build.json"), contents, { mode: 0o600 });
  return build;
}

export async function rebuild(roots, stamp, operation, work) {
  const prepared = checkSource(roots, stamp);
  invalidateBuild(roots);
  await work(prepared);
  return recordBuild(roots, stamp, operation);
}
