/**
 * M0-T4 integration: the real driver opens a Pi session on the pinned SDK.
 * Everything is sandboxed in a temp dir (agentDir, sessionDir, cwd) so the
 * user's real ~/.pi/agent is never read or written.
 */
import { ErrorCodes, PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../src/driver.js";

let base: string;
let driver: StableSdkDriver;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-sdk-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent"), { recursive: true });
  driver = new StableSdkDriver();
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  rmSync(base, { recursive: true, force: true });
});

describe("StableSdkDriver.open", () => {
  it.each(["missing", "empty"])("refuses a %s transcript without creating a replacement identity or touching the file", async (kind) => {
    const sessionDir = join(base, "sessions");
    mkdirSync(sessionDir);
    const path = join(sessionDir, "old-session.jsonl");
    if (kind === "empty") writeFileSync(path, "");
    const before = readdirSync(sessionDir);
    await expect(driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir, sessionPath: path }))
      .rejects.toMatchObject({ code: ErrorCodes.SessionNotFound, message: expect.stringContaining("Start a new session") });
    expect(readdirSync(sessionDir)).toEqual(before);
    expect(existsSync(path)).toBe(kind === "empty");
    if (kind === "empty") expect(readFileSync(path, "utf8")).toBe("");
  });

  it("refuses a corrupt non-empty transcript without changing it", async () => {
    const sessionDir = join(base, "sessions");
    mkdirSync(sessionDir);
    const path = join(sessionDir, "corrupt.jsonl");
    writeFileSync(path, "not json\n");
    await expect(driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir, sessionPath: path }))
      .rejects.toThrow(/not a valid/);
    expect(readFileSync(path, "utf8")).toBe("not json\n");
  });

  it("loads the saved identity and cwd directly, without a throwaway new-session runtime", async () => {
    const sessionDir = join(base, "sessions");
    mkdirSync(sessionDir);
    const path = join(sessionDir, "saved.jsonl");
    const savedCwd = join(base, "project", "checkout");
    mkdirSync(savedCwd);
    const id = "00000000-0000-4000-8000-000000000123";
    const transcript = `${JSON.stringify({ type: "session", version: 3, id, cwd: savedCwd, timestamp: "2026-09-10T00:00:00.000Z" })}\n`;
    writeFileSync(path, transcript);
    const events: DriverEvent[] = [];
    driver.subscribe((event) => events.push(event));
    const state = await driver.open({ cwd: savedCwd, agentDir: join(base, "agent"), sessionDir, sessionPath: path });
    expect(state).toMatchObject({ id, path, cwd: savedCwd });
    expect(readdirSync(sessionDir)).toEqual(["saved.jsonl"]);
    expect(readFileSync(path, "utf8").split("\n")[0]).toBe(transcript.trim());
    expect(events.filter((e) => e.type === "extension" && e.message.type === "lasercode/capabilities")).toHaveLength(1);
  }, 60_000);

  it("opens a session in a sandboxed agent dir and reports state", async () => {
    const events: DriverEvent[] = [];
    driver.subscribe((e) => events.push(e));

    const state = await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });

    expect(state.cwd).toBe(join(base, "project"));
    expect(state.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.isStreaming).toBe(false);
    expect(state.messageCount).toBe(0);
    expect(state.path).toContain(join(base, "sessions"));

    // The companion extension ran its detection pass and reported.
    const caps = events.find((e) => e.type === "extension" && e.message.type === "lasercode/capabilities");
    expect(caps).toBeDefined();
    if (caps?.type === "extension" && caps.message.type === "lasercode/capabilities") {
      expect(caps.message.active).toContain("provider-log");
      expect(caps.message.failed).toEqual([]);
    }

    // A no-agent open is a resource preview, not an exposed conversation: it
    // keeps Pi's lazy behavior and leaves no orphan transcript.
    expect(state.path.startsWith(join(base, "sessions"))).toBe(true);
    expect(existsSync(state.path)).toBe(false);
    expect(existsSync(join(base, "agent", "sessions"))).toBe(false);
  }, 60_000);

  it("refuses a second open and fails closed before open", async () => {
    await expect(driver.listModels()).rejects.toThrow(/no open session/);
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    await expect(
      driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") }),
    ).rejects.toThrow(/already open/);
  }, 60_000);

  it("falls back to the whole catalogue when the machine has no credential at all", async () => {
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    const models = await driver.listModels();
    // Connected providers only (D-145) — but an empty answer would be a picker
    // with nothing in it, so with no credential the catalogue stands.
    expect(models.length).toBeGreaterThan(10);
    expect(models[0]).toMatchObject({ provider: expect.any(String), id: expect.any(String) });
  }, 60_000);

  it("lists product, Agent Skills and the bundled feature commands without reading .pi", async () => {
    const writeSkill = (root: string, name: string, extra = "") => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} test skill\n${extra}---\n\nUse ${name}.\n`,
      );
    };
    writeSkill(join(base, "agent", "skills"), "product-user-skill", "disable-model-invocation: true\n");
    writeSkill(join(base, "project", ".agents", "skills"), "agent-standard-skill");
    writeSkill(join(base, "project", PROJECT_DIR_NAME, "skills"), "product-project-skill");
    writeSkill(join(base, "project", ".pi", "skills"), "legacy-pi-skill");

    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      projectTrusted: true,
    });
    const commands = await driver.commands();
    const names = commands.map((command) => command.name);

    expect(names).toEqual(expect.arrayContaining([
      "skill:product-user-skill",
      "skill:agent-standard-skill",
      "skill:product-project-skill",
      "goal",
    ]));
    expect(names).not.toContain("skill:legacy-pi-skill");
    // pi-subagents is no longer bundled (D-140): its commands must not appear.
    expect(names).not.toContain("subagents");
    expect(names).not.toContain("subagents-guide");
    expect(commands.find((command) => command.name === "skill:product-user-skill")).toMatchObject({
      source: "skill",
      description: "product-user-skill test skill",
      filePath: expect.stringContaining("SKILL.md"),
    });
  }, 60_000);
});
