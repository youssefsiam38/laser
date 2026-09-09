import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { HostServer } from "@lasercode/host";
import { processIdentity, writeHostFile } from "@lasercode/cli";
import { applicationPaths, roots } from "./config.mjs";
import { artifactTreeSha256 } from "./artifacts.mjs";

if (process.env.REVIEW_ISOLATED !== "1" || process.env.HOME !== roots.home) throw new Error("Refusing to launch outside the isolated review container.");
const build = JSON.parse(readFileSync(join(roots.state, "build.json"), "utf8"));
for (const layer of [build.host, build.worker, build.frontend]) {
  if (createHash("sha256").update(readFileSync(layer.path)).digest("hex") !== layer.sha256) throw new Error(`Prepared artifact changed: ${layer.path}`);
}
for (const tree of Object.values(build.artifactTrees)) {
  if (artifactTreeSha256(tree.directory) !== tree.sha256) throw new Error(`Prepared artifact tree changed: ${tree.directory}`);
}
for (const path of [applicationPaths.agent, applicationPaths.sessions]) mkdirSync(path, { recursive: true, mode: 0o700 });
const project = join(roots.repositories, "review-project");
const freshProject = !existsSync(join(project, ".git"));
if (freshProject) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Review project\n\nA disposable repository for reviewing the application.\n");
  execFileSync("git", ["init", "--initial-branch=main", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=Review Environment", "-c", "user.email=review@localhost.invalid", "add", "README.md"]);
  execFileSync("git", ["-C", project, "-c", "user.name=Review Environment", "-c", "user.email=review@localhost.invalid", "commit", "-m", "chore: initialize disposable review project"]);
}

// The production host retains its loopback-only listener. This container-local
// TCP forwarder makes it reachable through Docker's explicit host-loopback port.
// It preserves WebSocket bytes and adds no application or authentication logic.
const log = createWriteStream(join(roots.logs, "host.log"), { flags: "a", mode: 0o600 });
const publicPort = Number(process.env.REVIEW_PUBLIC_PORT);
const host = new HostServer({
  host: "127.0.0.1", port: 43188,
  agentDir: applicationPaths.agent, sessionDir: applicationPaths.sessions,
  stateDir: roots.state,
  uiDir: join(roots.workspace, "packages/ui/dist"), workerMain: build.worker.path,
  nodeBinary: process.execPath, logFile: join(roots.logs, "events.db"),
  allowedOrigins: [`http://127.0.0.1:${publicPort}`, `http://localhost:${publicPort}`],
  log: line => { const entry = `${new Date().toISOString()} ${line}\n`; log.write(entry); process.stderr.write(entry); },
});
const { url, port } = await host.listen();
if (freshProject) host.projects.add(project);
const { createConnection } = await import("node:net");
const forwarder = createServer(client => {
  const upstream = createConnection({ host: "127.0.0.1", port: 43188 });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
});
await new Promise((done, reject) => { forwarder.once("error", reject); forwarder.listen(43187, "0.0.0.0", done); });
const identity = processIdentity(process.pid);
writeHostFile(applicationPaths.hostRecord, {
  pid: process.pid, host: "127.0.0.1", port, url,
  agentDir: applicationPaths.agent, sessionDir: applicationPaths.sessions,
  stateDir: roots.state,
  startedAt: new Date().toISOString(), cliVersion: build.version, ...(identity ? { identity } : {}),
});
writeFileSync(join(roots.state, "running.json"), `${JSON.stringify({
  schema: 1, pid: process.pid, identity, startedAt: new Date().toISOString(),
  sourceSha256: build.sourceSha256, commit: build.commit, branch: build.branch,
  nodeBinary: process.execPath, host: build.host, worker: build.worker,
  frontend: build.frontend, publicUrl: `http://127.0.0.1:${publicPort}`, project,
  paths: { ...roots, ...applicationPaths },
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Review ready at http://127.0.0.1:${publicPort}\nDisposable project: ${project}\nBuild: ${build.branch} ${build.commit} ${build.sourceSha256}\n`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  forwarder.close();
  await host.close();
  rmSync(applicationPaths.hostRecord, { force: true });
  rmSync(join(roots.state, "running.json"), { force: true });
  log.end(() => process.exit(0));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
