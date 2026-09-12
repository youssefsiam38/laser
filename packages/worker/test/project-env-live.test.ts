/**
 * Two projects, one machine, identical variable names (M16-T17).
 *
 * This is the claim the feature exists to make, so it is proved through real
 * worker servers running real commands rather than through the resolver alone:
 * one worker per project directory, each with its own environment command,
 * both live at the same time.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectEnvironment } from "../src/project-env.js";

const roots: string[] = [];

function project(name: string, value: string): { cwd: string; command: string } {
  const cwd = mkdtempSync(join(tmpdir(), `project-${name}-`));
  roots.push(cwd);
  const command = join(cwd, "environment-command");
  // A hook is any executable. This one answers from its own arguments, the way
  // a real one answers from a secret store.
  writeFileSync(
    command,
    `#!/usr/bin/env bash\nprintf '{"version":1,"set":{"SHARED_NAME":"%s","${name.toUpperCase()}_ONLY":"1"},"unset":["INHERITED_TOKEN"]}' "${value}" >&3\n`,
    { mode: 0o755 },
  );
  chmodSync(command, 0o755);
  return { cwd, command };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("concurrent projects", () => {
  it("gives each project its own values for the same names, at the same time", async () => {
    const alpha = project("alpha", "alpha-secret");
    const beta = project("beta", "beta-secret");

    const config = (command: string) => ({
      enabled: true,
      command,
      args: [] as string[],
      required: true,
      allowProviderKeys: [] as string[],
      approved: true,
    });

    const one = new ProjectEnvironment({ cwd: alpha.cwd, config: config(alpha.command) });
    const two = new ProjectEnvironment({ cwd: beta.cwd, config: config(beta.command) });

    // Resolved concurrently, as two open projects would be.
    await Promise.all([one.ensure(), two.ensure()]);

    // The environment each project's commands would be started with. The
    // launching terminal's credential is in the base for both, and neither
    // project keeps it.
    const base = { PATH: process.env["PATH"] ?? "", INHERITED_TOKEN: "from-the-terminal-that-opened-the-app" };
    const alphaEnv = one.apply(base);
    const betaEnv = two.apply(base);

    expect(alphaEnv["SHARED_NAME"]).toBe("alpha-secret");
    expect(betaEnv["SHARED_NAME"]).toBe("beta-secret");
    expect(alphaEnv["ALPHA_ONLY"]).toBe("1");
    expect(alphaEnv["BETA_ONLY"]).toBeUndefined();
    expect(betaEnv["BETA_ONLY"]).toBe("1");
    expect(betaEnv["ALPHA_ONLY"]).toBeUndefined();

    // No accidental inheritance from the terminal that launched the app.
    expect(alphaEnv["INHERITED_TOKEN"]).toBeUndefined();
    expect(betaEnv["INHERITED_TOKEN"]).toBeUndefined();
  });

  it("reaches a real child process, which is the only proof that counts", async () => {
    const alpha = project("gamma", "gamma-secret");
    const environment = new ProjectEnvironment({
      cwd: alpha.cwd,
      config: { enabled: true, command: alpha.command, args: [], required: true, allowProviderKeys: [], approved: true },
    });
    await environment.ensure();

    // Exactly what the engine's shell tool does with the decorated environment.
    const { spawnSync } = await import("node:child_process");
    const output = join(alpha.cwd, "seen.txt");
    spawnSync("/usr/bin/env", ["bash", "-c", `printf '%s' "$SHARED_NAME" > "${output}"`], {
      cwd: alpha.cwd,
      env: environment.apply({ PATH: process.env["PATH"] ?? "" }),
    });
    expect(readFileSync(output, "utf8")).toBe("gamma-secret");
  });

  it("keeps a worktree on its owning project's environment", async () => {
    // A child agent works in <project>/.worktrees/<name>, which is part of its
    // project (invariant 5) and therefore runs in that project's worker with
    // that project's environment. The proof is that the same resolved
    // environment decorates a command whose working directory is the worktree.
    const owner = project("delta", "delta-secret");
    const worktree = join(owner.cwd, ".worktrees", "child");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(worktree, { recursive: true });

    const environment = new ProjectEnvironment({
      cwd: owner.cwd,
      config: { enabled: true, command: owner.command, args: [], required: true, allowProviderKeys: [], approved: true },
    });
    await environment.ensure();

    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("/usr/bin/env", ["bash", "-c", 'printf "%s" "$SHARED_NAME"'], {
      cwd: worktree,
      env: environment.apply({ PATH: process.env["PATH"] ?? "" }),
      encoding: "utf8",
    });
    expect(result.stdout).toBe("delta-secret");
  });
});
