/**
 * Where the environment command is configured, and what gates it (M16-T17).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectEnvApproved } from "@lasercode/protocol";
import { ProjectEnvStore } from "../src/project-env.js";

const roots: string[] = [];

function store(): { store: ProjectEnvStore; file: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "host-project-env-"));
  roots.push(root);
  const file = join(root, "project-env.json");
  return { store: new ProjectEnvStore({ storePath: file }), file, cwd: join(root, "a-project") };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("ProjectEnvStore", () => {
  it("records the approval when a person saves a configuration", () => {
    const { store: subject, cwd } = store();
    const saved = subject.set(cwd, { enabled: true, command: "/usr/bin/helper", args: ["--profile", "work"] });
    expect(projectEnvApproved(saved)).toBe(true);
    expect(subject.baseStatus(cwd, "trusted").state).toBe("failed"); // configured, approved, awaiting a worker
    expect(subject.baseStatus(cwd, "trusted").approved).toBe(true);
  });

  it("withholds the command from a project the person declined, or has not been asked about", () => {
    const { store: subject, cwd } = store();
    subject.set(cwd, { enabled: true, command: "/usr/bin/helper" });
    expect(subject.baseStatus(cwd, "declined").state).toBe("untrusted");
    expect(subject.baseStatus(cwd, "unknown").state).toBe("untrusted");
  });

  it("allows an ordinary project, which ships nothing trust-gated at all", () => {
    // `not_required` is the common case: no `.laser/settings.json`, no
    // worktree-setup. Refusing it would mean the feature never runs anywhere.
    const { store: subject, cwd } = store();
    subject.set(cwd, { enabled: true, command: "/usr/bin/helper" });
    expect(subject.baseStatus(cwd, "not_required").state).not.toBe("untrusted");
  });

  it("needs approval again when the executable or its arguments change underneath", () => {
    const { store: subject, file, cwd } = store();
    subject.set(cwd, { enabled: true, command: "/usr/bin/helper", args: ["--profile", "work"] });

    // Someone edits the store by hand — or anything else changes what would
    // actually run. The recorded fingerprint no longer matches.
    const raw = JSON.parse(readFileSync(file, "utf8")) as { projects: Record<string, { command: string }> };
    const key = Object.keys(raw.projects)[0]!;
    raw.projects[key]!.command = "/tmp/something-else";
    writeFileSync(file, JSON.stringify(raw));

    const reloaded = new ProjectEnvStore({ storePath: file });
    expect(projectEnvApproved(reloaded.get(cwd))).toBe(false);
    expect(reloaded.baseStatus(cwd, "trusted").state).toBe("needs-approval");
  });

  it("reports a project that has switched its command off", () => {
    const { store: subject, cwd } = store();
    subject.set(cwd, { enabled: false, command: "/usr/bin/helper" });
    expect(subject.baseStatus(cwd, "trusted").state).toBe("off");
  });

  it("reports a project that never configured one", () => {
    const { store: subject, cwd } = store();
    expect(subject.baseStatus(cwd, "trusted")).toEqual({ cwd: expect.any(String), state: "not-configured", approved: false });
  });

  it("forgets a configuration when it is cleared", () => {
    const { store: subject, cwd } = store();
    subject.set(cwd, { enabled: true, command: "/usr/bin/helper" });
    subject.set(cwd, null);
    expect(subject.get(cwd)).toBeUndefined();
    expect(subject.configured()).toEqual([]);
  });

  it("survives a restart", () => {
    const { store: subject, file, cwd } = store();
    subject.set(cwd, { enabled: true, command: "/usr/bin/helper", args: ["--x"], required: false });
    const reloaded = new ProjectEnvStore({ storePath: file });
    const config = reloaded.get(cwd);
    expect(config?.command).toBe("/usr/bin/helper");
    expect(config?.args).toEqual(["--x"]);
    expect(config?.required).toBe(false);
    expect(projectEnvApproved(config)).toBe(true);
  });

  it("writes its file so that only the person can read it", () => {
    const { store: subject, file, cwd } = store();
    subject.set(cwd, { enabled: true, command: "/usr/bin/helper" });
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("ignores a corrupt store rather than failing to start", () => {
    const root = mkdtempSync(join(tmpdir(), "host-project-env-"));
    roots.push(root);
    const file = join(root, "project-env.json");
    writeFileSync(file, "{ this is not json");
    expect(() => new ProjectEnvStore({ storePath: file })).not.toThrow();
    expect(new ProjectEnvStore({ storePath: file }).configured()).toEqual([]);
  });
});
