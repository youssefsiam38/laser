/**
 * The project's command to run first (M16-T17).
 *
 * The ordinary case: a person already prepares a shell by hand, and wants the
 * agent's commands to start the same way. It runs in the agent's own shell, so
 * a shell function works where a spawned executable never could.
 */
import { describe, expect, it } from "vitest";
import { ProjectEnvironment } from "../src/project-env.js";
import { projectEnvFingerprint, projectEnvWorkerConfig } from "@lasercode/protocol";

const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  preface: "workenv use kwentra",
  command: "",
  args: [] as string[],
  required: true,
  allowProviderKeys: [] as string[],
  approved: true,
  ...overrides,
});

describe("the command that runs first", () => {
  it("is offered to the shell tool once approved", () => {
    const environment = new ProjectEnvironment({ cwd: "/tmp", config: config() });
    expect(environment.preface).toBe("workenv use kwentra");
  });

  it("is withheld until it is approved, because it is executed", () => {
    const environment = new ProjectEnvironment({ cwd: "/tmp", config: config({ approved: false }) });
    expect(environment.preface).toBeUndefined();
  });

  it("is withheld while the project has it switched off", () => {
    const environment = new ProjectEnvironment({ cwd: "/tmp", config: config({ enabled: false }) });
    expect(environment.preface).toBeUndefined();
  });

  it("needs no resolver run, and never blocks a command", async () => {
    const environment = new ProjectEnvironment({ cwd: "/tmp", config: config() });
    const status = await environment.ensure();
    expect(status.state).toBe("ready");
    expect(environment.blocking).toBe(false);
  });

  it("counts as what runs, so changing it needs approving again", () => {
    const before = projectEnvFingerprint({ preface: "workenv use kwentra", command: "", args: [] });
    const after = projectEnvFingerprint({ preface: "workenv use personal", command: "", args: [] });
    expect(before).not.toBe(after);
  });

  it("reaches a worker without an executable being configured", () => {
    const worker = projectEnvWorkerConfig({
      enabled: true,
      preface: "workenv use kwentra",
      command: "",
      args: [],
      required: true,
      approvedFingerprint: projectEnvFingerprint({ preface: "workenv use kwentra", command: "", args: [] }),
    });
    expect(worker?.preface).toBe("workenv use kwentra");
    expect(worker?.approved).toBe(true);
  });
});
