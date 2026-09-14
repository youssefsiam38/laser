/**
 * The inventory must be safe to hand to somebody.
 *
 * A command line is where secrets live: a token passed as a flag, a password in
 * a URL, a customer's name in a path. This spawns a real process whose argv,
 * environment and working directory are all hostile, runs the real collector
 * over the real `/proc`, and then reads every byte the host would ever emit —
 * the snapshot, the retained history and the diagnostic export — looking for
 * any of them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceService } from "../../src/resources/service.js";

const ARGV_SECRET = "argv-s3cret-7f21aa";
const ENV_SECRET = "env-s3cret-91b0cd";
const PATH_SECRET = "path-s3cret-4c8e12";
const SESSION_SECRET = "session-s3cret-2de904";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function hostileChild(cwd: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60000)", "--", `--token=${ARGV_SECRET}`, `https://user:${ARGV_SECRET}@example.invalid/`],
    { cwd, env: { ...process.env, LASER_TEST_SECRET: ENV_SECRET }, stdio: "ignore" },
  );
  children.push(child);
  return child;
}

describe("nothing sensitive reaches a reader", () => {
  it("keeps a hostile argv, environment, path and session out of the snapshot, history and export", async ({ skip }) => {
    if (process.platform !== "linux") return skip();

    // A directory whose *parent* carries a secret: the project's own basename
    // is a label a person asked to see, everything above it is not.
    const parent = mkdtempSync(join(tmpdir(), `${PATH_SECRET}-`));
    directories.push(parent);
    const projectCwd = join(parent, "alpha");
    mkdirSync(projectCwd, { recursive: true });

    const child = hostileChild(projectCwd);
    expect(child.pid).toBeDefined();
    // The process must be up before its identity is read.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const resources = new ResourceService({
      hostPid: process.pid,
      minIntervalMs: 0,
      ancestorsOf: () => [],
      lookups: { sessionIdOf: () => "sess-1", sessionIdsOf: () => ["sess-1"] },
    });
    resources.ownership.noteWorker(projectCwd, child.pid!);
    resources.observeProcessRegistrations(projectCwd, [
      { pid: child.pid!, role: "background_command", taskId: "task-1", sessionPath: `/sessions/${SESSION_SECRET}.jsonl` },
    ]);

    const { snapshot } = await resources.snapshot({ refresh: true });
    await resources.snapshot({ refresh: true });

    const row = snapshot.processes.find((entry) => entry.pid === child.pid);
    expect(row).toBeDefined();
    // It is there, it is named, and the name is the executable's basename.
    expect(row!.label).toBe("node");
    expect(row!.role).toBe("background_command");
    expect(row!.associations).toMatchObject({ taskIds: ["task-1"] });

    const emitted = [
      JSON.stringify(snapshot),
      JSON.stringify(resources.historyPage()),
      resources.export().document,
    ].join("\n");

    for (const secret of [ARGV_SECRET, ENV_SECRET, PATH_SECRET, SESSION_SECRET]) {
      expect(emitted).not.toContain(secret);
    }
    expect(emitted).not.toContain("example.invalid");
    expect(emitted).not.toContain(projectCwd);
    expect(emitted).not.toContain("/sessions/");
    // The label a person does get is the project's own basename, opaque id beside it.
    expect(emitted).toContain("\"label\":\"alpha\"");
  });

  it("says a truthful, bounded failure rather than echoing a machine's text", async () => {
    const resources = new ResourceService({
      platform: "linux",
      hostPid: process.pid,
      ancestorsOf: () => [],
      collector: {
        name: "hostile",
        source: "proc",
        table: async () => {
          throw new Error(`boom ${"x".repeat(1000)} ${ARGV_SECRET}`);
        },
        measure: async () => {
          throw new Error("unused");
        },
      },
    });
    const { snapshot } = await resources.snapshot();
    const detail = snapshot.health.collectors[0]!.detail!;
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).toContain("boom");
    // The truncation is a bound, not a filter: what matters is that the host
    // never invents text and never grows without limit.
    expect(detail).not.toContain(ARGV_SECRET);
  });
});
