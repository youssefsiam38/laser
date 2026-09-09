#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { composeConfiguration, defaultPort, projectName } from "./config.mjs";

const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const port = Number(process.env.REVIEW_PORT ?? defaultPort);
const document = JSON.stringify(composeConfiguration(checkout, port));
const prefix = ["compose", "--project-name", projectName, "--project-directory", checkout, "--env-file", "/dev/null", "--file", "-"];
const command = process.argv[2] ?? "help";
const args = process.argv.slice(3).filter((value, i) => !(i === 0 && value === "--"));

function git(args) {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}
function composeSync(args) {
  return execFileSync("docker", [...prefix, ...args], { input: document, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
function compose(args) {
  return new Promise((done, reject) => {
    const child = spawn("docker", [...prefix, ...args], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(document);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? done() : reject(new Error(`Review command exited ${code}.`)));
  });
}
function running() {
  return composeSync(["ps", "--status", "running", "--quiet", "app"]).trim();
}
function requireStopped() {
  if (running()) throw new Error("Stop this review environment before changing its build or running a separate test process: use the stop command.");
}
function provenance() {
  const branch = git(["branch", "--show-current"]);
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  const retained = [];
  for (const path of files) {
    if (path.split("/").some(part => [".git", "node_modules"].includes(part))) continue;
    if (/(^|\/)(auth\.json|\.env(?:\..*)?|\.netrc)$/.test(path) || path.endsWith(".pem") || path.endsWith(".key")) {
      throw new Error(`Remove private configuration from review inputs before preparing: ${path}`);
    }
    try {
      const full = resolve(checkout, path);
      const stat = lstatSync(full);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (path.endsWith(".npmrc")) {
        const lines = readFileSync(full, "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#") && !line.startsWith(";"));
        if (lines.some(line => !/^(?:save-exact|strict-peer-dependencies|auto-install-peers|prefer-workspace-packages|link-workspace-packages|shared-workspace-lockfile)=(?:true|false)$/.test(line))) {
          throw new Error(`Review permits only credential-free workspace behavior flags in ${path}.`);
        }
      }
      // Symlinks may point within the checkout, never into the host's home/config.
      const target = realpathSync(full);
      if (target !== checkout && !target.startsWith(`${checkout}/`)) throw new Error(`Review input escapes the checkout: ${path}`);
      hash.update(path).update("\0").update(String(stat.mode & 0o777)).update("\0").update(stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full)).update("\0");
      retained.push(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error; // a tracked deletion is valid
    }
  }
  return {
    schema: 1, checkout, branch, commit: git(["rev-parse", "HEAD"]),
    sourceSha256: hash.digest("hex"), dirty: git(["status", "--porcelain"]).length > 0,
    version: JSON.parse(readFileSync(resolve(checkout, "package.json"), "utf8")).version,
    files: retained,
  };
}
async function checkPort() {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`127.0.0.1:${port} is in use. Choose an unused REVIEW_PORT; no existing process was touched.`)));
    server.listen(port, "127.0.0.1", () => server.close(done));
  });
}
function oneOff(args, stamp) {
  return compose(["run", "--rm", "--no-deps", "-T", ...(stamp ? ["-e", `REVIEW_SOURCE=${deflateRawSync(JSON.stringify(stamp)).toString("base64")}`] : []), "app", ...args]);
}

try {
  if (command === "config") {
    process.stdout.write(`${JSON.stringify(composeConfiguration(checkout, port), null, 2)}\n`);
  } else if (command === "prepare") {
    requireStopped();
    const stamp = provenance();
    await compose(["build", "app"]);
    await oneOff(["node", "/source/scripts/review-env/container.mjs", "prepare"], stamp);
  } else if (command === "up") {
    if (running()) throw new Error("The review app is already running. Inspect it or stop it before launching another build.");
    await checkPort();
    if (args.includes("--prepared")) {
      process.stdout.write("Starting the last prepared feature snapshot. New checkout edits are not part of this development launch; inspect provenance.\n");
    } else {
      const stamp = provenance();
      await oneOff(["node", "/source/scripts/review-env/container.mjs", "check-source"], stamp);
    }
    await compose(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "90", "app"]);
    process.stdout.write(`Review application: http://127.0.0.1:${port}\n`);
  } else if (command === "stop") {
    await compose(["stop", "app"]);
  } else if (command === "reset") {
    await compose(["down", "--volumes", "--remove-orphans"]);
  } else if (command === "verify") {
    requireStopped();
    await oneOff(["node", "/source/scripts/review-env/container.mjs", "verify"], provenance());
  } else if (command === "run") {
    requireStopped();
    if (!args.length) throw new Error("Pass a command to run inside the review container.");
    await oneOff(args);
  } else if (command === "exec") {
    if (!running()) throw new Error("The review app is stopped. Use run for a one-off container or up to start it.");
    if (!args.length) throw new Error("Pass a command to execute inside the review container.");
    await compose(["exec", "-T", "app", ...args]);
  } else if (command === "status") {
    await compose(["ps", "--all"]);
  } else if (command === "logs") {
    await compose(["logs", "--tail", "100", "app"]);
  } else if (command === "provenance") {
    if (running()) await compose(["exec", "-T", "app", "cat", "/review/state/build.json", "/review/state/running.json"]);
    else await oneOff(["cat", "/review/state/build.json"]);
  } else {
    process.stdout.write("Review environment commands:\n  prepare     Build isolated dependencies and production application\n  up          Launch that exact prepared source build\n  stop        Stop only the review app; retain its data\n  reset       Remove only this Compose project's containers/network/volumes\n  verify      Run complete repository checks in a stopped review container\n  run -- CMD  Run a one-off command with isolated paths (app must be stopped)\n  exec -- CMD Run a command in the running review container\n  provenance  Print prepared/running build identity\n  status      Show only this review project's status\n  logs        Print the last 100 review log lines\n  config      Print the generated Compose configuration\n\nSet REVIEW_PORT to an unused loopback port if needed; default 43187.\n");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
