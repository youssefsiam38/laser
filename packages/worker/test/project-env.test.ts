/**
 * The worker half of the project environment command (M16-T17).
 *
 * These run real child processes, because the things most worth proving are
 * process-level: that the answer arrives on a private descriptor, that stdout
 * noise cannot corrupt it, that a hook which hangs or floods is killed, and
 * that a failure refuses execution instead of quietly running with the wrong
 * environment.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectEnvironment } from "../src/project-env.js";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "project-env-"));
  roots.push(root);
  return root;
}

/** Write an executable hook and return its path. */
function hook(root: string, name: string, script: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

const config = (command: string, args: string[] = [], overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  command,
  args,
  required: true,
  allowProviderKeys: [] as string[],
  approved: true,
  ...overrides,
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("ProjectEnvironment", () => {
  it("reads the document from the private descriptor and applies it", async () => {
    const root = workspace();
    const command = hook(root, "env-ok", `printf '%s' '{"version":1,"set":{"DATABASE_URL":"postgres://project/db"},"unset":["STALE_TOKEN"]}' >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });

    const status = await environment.ensure();
    expect(status.state).toBe("ready");
    expect(status.names).toEqual(["DATABASE_URL"]);
    expect(status.unsetNames).toEqual(["STALE_TOKEN"]);

    // The decoration sets what the project asked for and removes what it did
    // not: a credential inherited from the launching terminal does not survive.
    const applied = environment.apply({ PATH: "/usr/bin", STALE_TOKEN: "from-the-terminal" });
    expect(applied).toEqual({ PATH: "/usr/bin", DATABASE_URL: "postgres://project/db" });
    expect(environment.blocking).toBe(false);
  });

  it("ignores anything the hook writes to stdout or stderr", async () => {
    const root = workspace();
    const command = hook(
      root,
      "env-noisy",
      [
        `echo "a friendly banner on stdout"`,
        `echo "a warning on stderr" >&2`,
        `printf '%s' '{"version":1,"set":{"OK":"yes"}}' >&3`,
      ].join("\n"),
    );
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });
    const status = await environment.ensure();
    expect(status.state).toBe("ready");
    expect(status.names).toEqual(["OK"]);
  });

  it("runs in the project directory and can be given arguments", async () => {
    const root = workspace();
    const command = hook(root, "env-cwd", `printf '{"version":1,"set":{"SEEN_CWD":"%s","ARG":"%s"}}' "$PWD" "$1" >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command, ["--profile=team"]) });
    await environment.ensure();
    const applied = environment.apply({});
    expect(applied["SEEN_CWD"]).toBe(root);
    expect(applied["ARG"]).toBe("--profile=team");
  });

  it("refuses execution when a required hook fails, with a sentence and no stderr", async () => {
    const root = workspace();
    const command = hook(root, "env-fail", `echo "postgres://user:hunter2@host/db is unreachable" >&2\nexit 3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });

    const status = await environment.ensure();
    expect(status.state).toBe("failed");
    expect(status.error).toBe("The command exited with code 3.");
    expect(environment.blocking).toBe(true);
    // The hook's own output may contain secrets; it is never quoted back.
    expect(environment.blockingReason()).not.toContain("hunter2");
    expect(environment.blockingReason()).toContain("Settings");
    // Nothing is applied from a failed run.
    expect(environment.apply({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it("does not block when the project says the hook is optional", async () => {
    const root = workspace();
    const command = hook(root, "env-optional", `exit 1`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command, [], { required: false }) });
    await environment.ensure();
    expect(environment.blocking).toBe(false);
  });

  it("explains a missing or non-executable command", async () => {
    const root = workspace();
    const missing = new ProjectEnvironment({ cwd: root, config: config(join(root, "nope")) });
    expect((await missing.ensure()).error).toContain("was not found");

    const path = join(root, "not-executable");
    writeFileSync(path, "#!/usr/bin/env bash\ntrue\n", { mode: 0o644 });
    const refused = new ProjectEnvironment({ cwd: root, config: config(path) });
    expect((await refused.ensure()).error).toContain("not executable");
  });

  it("kills a hook that hangs, and does not wait for it", async () => {
    const root = workspace();
    const command = hook(root, "env-hang", `sleep 30`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });
    // The real bound is 20s; this proves the timeout path with a short one.
    const started = Date.now();
    const status = await environment["runner"]({
      command,
      args: [],
      cwd: root,
      env: process.env,
      timeoutMs: 250,
      maxBytes: 1024,
    });
    expect(status.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses a document larger than the bound instead of holding it in memory", async () => {
    const root = workspace();
    const command = hook(root, "env-flood", `head -c 200000 /dev/zero | tr '\\0' 'x' >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });
    const result = await environment["runner"]({
      command,
      args: [],
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      maxBytes: 1024,
    });
    expect(result.overflowed).toBe(true);
    expect(result.payload).toBe("");
  });

  it("explains malformed output without repeating it", async () => {
    const root = workspace();
    const command = hook(root, "env-garbage", `printf '%s' 'not json at all' >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });
    const status = await environment.ensure();
    expect(status.state).toBe("failed");
    expect(status.error).toBe("The environment command did not return readable output.");
    expect(status.error).not.toContain("not json at all");
  });

  it("never runs an unapproved command", async () => {
    const root = workspace();
    const marker = join(root, "it-ran");
    const command = hook(root, "env-unapproved", `touch "${marker}"\nprintf '%s' '{"version":1,"set":{}}' >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command, [], { approved: false }) });

    const status = await environment.ensure();
    expect(status.state).toBe("needs-approval");
    expect(environment.blocking).toBe(true);
    expect(environment.blockingReason()).toContain("approve it again");
    // The proof that matters: the executable was never started.
    expect(() => rmSync(marker)).toThrow();
  });

  it("resolves once, and again only when asked", async () => {
    const root = workspace();
    const counter = join(root, "runs");
    const command = hook(root, "env-count", `echo x >> "${counter}"\nprintf '%s' '{"version":1,"set":{"N":"1"}}' >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });

    // Concurrent callers share one run: two tools starting together must not
    // spawn the hook twice.
    await Promise.all([environment.ensure(), environment.ensure(), environment.ensure()]);
    await environment.ensure();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);

    await environment.refresh();
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("keeps a project's values out of the worker's own environment", async () => {
    const root = workspace();
    const command = hook(root, "env-isolated", `printf '%s' '{"version":1,"set":{"PROJECT_ONLY_MARKER":"yes"}}' >&3`);
    const environment = new ProjectEnvironment({ cwd: root, config: config(command) });
    await environment.ensure();
    // This is what keeps a project from repointing the agent's own model
    // authentication: the values live in the object, not in the process.
    expect(process.env["PROJECT_ONLY_MARKER"]).toBeUndefined();
    expect(environment.apply({})["PROJECT_ONLY_MARKER"]).toBe("yes");
  });

  it("refuses a provider credential unless the project allows it", async () => {
    const root = workspace();
    const command = hook(root, "env-provider", `printf '%s' '{"version":1,"set":{"ANTHROPIC_API_KEY":"sk-project"}}' >&3`);

    const blocked = new ProjectEnvironment({ cwd: root, config: config(command) });
    const status = await blocked.ensure();
    expect(status.names).toEqual([]);
    expect(status.refused[0]?.name).toBe("ANTHROPIC_API_KEY");
    expect(blocked.apply({})["ANTHROPIC_API_KEY"]).toBeUndefined();

    const allowed = new ProjectEnvironment({
      cwd: root,
      config: config(command, [], { allowProviderKeys: ["ANTHROPIC_API_KEY"] }),
    });
    await allowed.ensure();
    expect(allowed.apply({})["ANTHROPIC_API_KEY"]).toBe("sk-project");
  });

  it("is inert when no environment command is configured", async () => {
    const root = workspace();
    const environment = new ProjectEnvironment({ cwd: root, config: undefined });
    const status = await environment.ensure();
    expect(status.state).toBe("off");
    expect(environment.blocking).toBe(false);
    expect(environment.apply({ A: "1" })).toEqual({ A: "1" });
  });
});
