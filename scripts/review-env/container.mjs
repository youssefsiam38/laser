import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, createWriteStream, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { roots } from "./config.mjs";
import { checkSource, invalidateBuild, readBuild, rebuild, recordBuild } from "./build-record.mjs";

if (process.env.REVIEW_ISOLATED !== "1" || process.env.HOME !== roots.home || process.cwd() !== roots.workspace) {
  throw new Error("This entry point runs only inside the dedicated review container.");
}
for (const path of Object.values(roots)) mkdirSync(path, { recursive: true, mode: 0o700 });
const command = process.argv[2] ?? "serve";
const stamp = process.env.REVIEW_SOURCE ? JSON.parse(inflateRawSync(Buffer.from(process.env.REVIEW_SOURCE, "base64"))) : undefined;

function execute(program, args, logName) {
  return new Promise((done, reject) => {
    const log = createWriteStream(join(roots.logs, logName), { flags: "a", mode: 0o600 });
    const child = spawn(program, args, { cwd: roots.workspace, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on("data", chunk => { process.stderr.write(chunk); log.write(chunk); });
    child.once("error", error => { log.end(); reject(error); });
    child.once("exit", code => { log.end(); code === 0 ? done() : reject(new Error(`${program} ${args.join(" ")} exited ${code}; see ${roots.logs}/${logName}`)); });
  });
}
if (command === "prepare") {
  if (!stamp?.files?.length) throw new Error("Missing source snapshot manifest.");
  invalidateBuild(roots);
  // Retain only dependency/build caches; deleted source never survives a refresh.
  for (const entry of readdirSync(roots.workspace)) {
    if (entry !== "node_modules") rmSync(join(roots.workspace, entry), { recursive: true, force: true });
  }
  const digest = createHash("sha256");
  for (const file of stamp.files) {
    const source = resolve("/source", file);
    const destination = resolve(roots.workspace, file);
    if (!source.startsWith("/source/") || !destination.startsWith(`${roots.workspace}/`)) throw new Error("Invalid source manifest path.");
    mkdirSync(dirname(destination), { recursive: true });
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
    else cpSync(source, destination);
    const stat = lstatSync(destination);
    digest.update(file).update("\0").update(String(stat.mode & 0o777)).update("\0").update(stat.isSymbolicLink() ? readlinkSync(destination) : readFileSync(destination)).update("\0");
  }
  if (digest.digest("hex") !== stamp.sourceSha256) throw new Error("The source changed during snapshot capture. Run prepare again once edits settle.");
  writeFileSync(join(roots.state, "source-files.json"), JSON.stringify(stamp.files), { mode: 0o600 });
  // A private index makes the source/identity gate scan the copied source too.
  // This is a disposable repository, never the feature worktree's Git directory.
  await execute("git", ["init", "--initial-branch=review-source"], "prepare.log");
  await execute("git", ["config", "user.name", "Review Environment"], "prepare.log");
  await execute("git", ["config", "user.email", "review@localhost.invalid"], "prepare.log");
  await execute("git", ["add", "--all"], "prepare.log");
  await execute("pnpm", ["install", "--frozen-lockfile", "--store-dir", `${roots.cache}/pnpm-store`], "prepare.log");
  await execute("pnpm", ["build"], "prepare.log");
  const build = recordBuild(roots, stamp, "prepare");
  process.stdout.write(`${JSON.stringify(build, null, 2)}\n`);
} else if (command === "check-source") {
  process.stdout.write(`Prepared source verified: ${checkSource(roots, stamp).sourceSha256}\n`);
} else if (command === "verify") {
  await rebuild(roots, stamp, "verify", async () => {
    await execute("pnpm", ["identity:check"], "verify.log");
    await execute("xvfb-run", ["-a", "pnpm", "verify"], "verify.log");
  });
} else if (command === "serve") {
  readBuild(roots);
  await import(`${roots.workspace}/scripts/review-env/host.mjs`);
} else {
  throw new Error(`Unknown container operation: ${command}`);
}
