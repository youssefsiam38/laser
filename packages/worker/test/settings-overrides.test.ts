/**
 * M13-T12: `.laser` values reach the engine only as in-memory overrides
 * (AGENTS.md invariant 6b). This file pins, against the real pinned engine,
 * that they survive every reload the engine performs — and pins the engine
 * behaviour that makes the durable wrapper necessary, so a future engine bump
 * that fixes it upstream shows up here as a failing expectation rather than as
 * silent dead code.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import { SettingsManager, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDurableOverrides, durableOverrides } from "../src/settings-overrides.js";
import { SettingsAdapter } from "../src/settings.js";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";

let base: string;
let cwd: string;
let agentDir: string;

/** Every case gets its own project directory: two managers never share one. */
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-overrides-`));
  cwd = join(base, "project");
  agentDir = join(base, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const writeGlobal = (values: Record<string, unknown>): void => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(values, null, 2));
};

const writeLaser = (values: Record<string, unknown>): void => {
  mkdirSync(join(cwd, PROJECT_DIR_NAME), { recursive: true });
  writeFileSync(join(cwd, PROJECT_DIR_NAME, "settings.json"), JSON.stringify(values, null, 2));
};

const writeLegacyPi = (values: Record<string, unknown>): void => {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(values, null, 2));
};

/**
 * Services without any resource discovery: enough to drive the engine's
 * `resourceLoader.reload()`, which is the reload that was suspected of
 * dropping overrides, without installing packages or reading the machine.
 */
const createServices = (settingsManager: SettingsManager) =>
  createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });

describe("the engine's own applyOverrides (pinned behaviour, not ours)", () => {
  it("drops a plain override during service creation", async () => {
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    manager.applyOverrides({ defaultThinkingLevel: "high", theme: "from-override" });
    expect(manager.getDefaultThinkingLevel()).toBe("high");

    await createServices(manager);

    // This is the defect M13-T12 set out to prove. If a future engine keeps
    // overrides across a reload, this expectation flips and the wrapper in
    // src/settings-overrides.ts can be retired.
    expect(manager.getDefaultThinkingLevel()).toBeUndefined();
    expect(manager.getTheme()).toBeUndefined();
  }, 60_000);

  it("drops a plain override on reload and on a trust change", async () => {
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    manager.applyOverrides({ theme: "from-override" });
    await manager.reload();
    expect(manager.getTheme()).toBeUndefined();

    manager.applyOverrides({ theme: "from-override" });
    manager.setProjectTrusted(true);
    expect(manager.getTheme()).toBeUndefined();
  });
});

describe("applyDurableOverrides", () => {
  it("survives service creation, the reload it performs, and later reloads", async () => {
    writeGlobal({ defaultModel: "from-global", steeringMode: "one-at-a-time" });
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    applyDurableOverrides(manager, {
      defaultModel: "from-project",
      defaultThinkingLevel: "high",
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });

    const services = await createServices(manager);
    expect(services.settingsManager).toBe(manager);
    expect(manager.getDefaultModel()).toBe("from-project");
    expect(manager.getDefaultThinkingLevel()).toBe("high");
    expect(manager.getPackages()).toEqual([]);

    // A second reload is the mid-session one: an extension's ctx.reload(), a
    // resource refresh, a cwd change that rebuilds services.
    await services.resourceLoader.reload();
    expect(manager.getDefaultModel()).toBe("from-project");
    expect(manager.getPackages()).toEqual([]);

    await manager.reload();
    expect(manager.getDefaultModel()).toBe("from-project");

    // Values the project did not override still come from the global file.
    expect(manager.getSteeringMode()).toBe("one-at-a-time");
  }, 60_000);

  it("survives a project-trust change in both directions", () => {
    writeLegacyPi({ theme: "from-dot-pi" });
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    applyDurableOverrides(manager, { theme: "from-project" });

    manager.setProjectTrusted(true);
    expect(manager.getTheme()).toBe("from-project");
    manager.setProjectTrusted(false);
    expect(manager.getTheme()).toBe("from-project");
  });

  it("replaces the durable set instead of stacking wrappers", async () => {
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    applyDurableOverrides(manager, { theme: "first", defaultModel: "first-model" });
    applyDurableOverrides(manager, { theme: "second" });

    expect(durableOverrides(manager)).toEqual({ theme: "second" });
    await manager.reload();
    expect(manager.getTheme()).toBe("second");
    // The dropped key is genuinely dropped, not resurrected by an older layer.
    expect(manager.getDefaultModel()).toBeUndefined();
  });

  it("still never lets the engine discover `.pi` project settings", async () => {
    writeLegacyPi({ defaultModel: "from-dot-pi", packages: ["npm:should-never-install"] });
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    applyDurableOverrides(manager, { packages: [], extensions: [], skills: [], prompts: [], themes: [] });

    await createServices(manager);

    expect(manager.isProjectTrusted()).toBe(false);
    expect(manager.getProjectSettings()).toEqual({});
    expect(manager.getDefaultModel()).toBeUndefined();
    expect(manager.getPackages()).toEqual([]);
  }, 60_000);
});

describe("StableSdkDriver, end to end", () => {
  let driver: StableSdkDriver;

  beforeEach(() => {
    driver = new StableSdkDriver();
  });

  afterEach(async () => {
    await driver.dispose().catch(() => {});
  });

  /**
   * The engine's own view of the session, not laser's copy of it. The runtime
   * is private on the driver by design — nothing in the product reads settings
   * back out of it — so the test reaches for it deliberately.
   */
  const engineSettings = (): SettingsManager => {
    const runtime = (driver as unknown as { runtime?: { services: { settingsManager: SettingsManager } } }).runtime;
    if (!runtime) throw new Error("driver has no open session");
    return runtime.services.settingsManager;
  };

  it("carries this project's values into the open session", async () => {
    writeGlobal({ defaultModel: "from-global", steeringMode: "one-at-a-time" });
    writeLaser({ defaultModel: "from-project", defaultThinkingLevel: "low" });

    await driver.open({ cwd, agentDir, sessionDir: join(base, "sessions"), projectTrusted: true });

    const settings = engineSettings();
    expect(settings.getDefaultModel()).toBe("from-project");
    expect(settings.getDefaultThinkingLevel()).toBe("low");
    // Not overridden by the project: the global file still decides.
    expect(settings.getSteeringMode()).toBe("one-at-a-time");
    // Engine-owned discovery stays off, whatever the files say.
    expect(settings.getPackages()).toEqual([]);
    expect(settings.getExtensionPaths()).toEqual([]);
    expect(settings.getSkillPaths()).toEqual([]);
    expect(settings.isProjectTrusted()).toBe(false);
    expect(settings.getProjectSettings()).toEqual({});
  }, 60_000);

  it("keeps them across a mid-session reload", async () => {
    writeLaser({ defaultModel: "from-project" });
    await driver.open({ cwd, agentDir, sessionDir: join(base, "sessions"), projectTrusted: true });

    const settings = engineSettings();
    // What an extension's ctx.reload() and a resource refresh both go through.
    await settings.reload();
    expect(settings.getDefaultModel()).toBe("from-project");
    expect(settings.getPackages()).toEqual([]);

    // The whole session reload: settings, then the resource loader, then the
    // extension runner rebuilt around them.
    const runtime = (driver as unknown as { runtime: { session: { reload(): Promise<void> } } }).runtime;
    await runtime.session.reload();
    expect(engineSettings().getDefaultModel()).toBe("from-project");
    expect(engineSettings().getPackages()).toEqual([]);
  }, 60_000);

  it("ignores the project entirely when the host withheld trust", async () => {
    writeGlobal({ defaultModel: "from-global" });
    writeLaser({ defaultModel: "from-project" });
    writeLegacyPi({ defaultModel: "from-dot-pi" });

    await driver.open({ cwd, agentDir, sessionDir: join(base, "sessions"), projectTrusted: false });

    const settings = engineSettings();
    expect(settings.getDefaultModel()).toBe("from-global");
    expect(settings.getPackages()).toEqual([]);
  }, 60_000);
});

describe("SettingsAdapter", () => {
  it(`keeps ${PROJECT_DIR_NAME} values and the discovery switches across refresh`, async () => {
    writeGlobal({ defaultModel: "from-global" });
    writeLaser({ defaultModel: "from-project", defaultThinkingLevel: "low" });
    const adapter = new SettingsAdapter({ cwd, agentDir });

    expect(adapter.settingsManager.getDefaultModel()).toBe("from-project");
    expect(adapter.settingsManager.getPackages()).toEqual([]);

    await adapter.refresh();
    expect(adapter.settingsManager.getDefaultModel()).toBe("from-project");
    expect(adapter.settingsManager.getDefaultThinkingLevel()).toBe("low");
    expect(adapter.settingsManager.getPackages()).toEqual([]);

    // A reload driven by a consumer we handed the manager to must not undo it.
    await adapter.settingsManager.reload();
    expect(adapter.settingsManager.getDefaultModel()).toBe("from-project");
    expect(adapter.settingsManager.getPackages()).toEqual([]);
  });

  it("applies nothing from an untrusted project", async () => {
    writeGlobal({ defaultModel: "from-global" });
    writeLaser({ defaultModel: "from-project" });
    const adapter = new SettingsAdapter({ cwd, agentDir, hostTrusted: false });

    expect(adapter.settingsManager.getDefaultModel()).toBe("from-global");
    await adapter.settingsManager.reload();
    expect(adapter.settingsManager.getDefaultModel()).toBe("from-global");
    // The switches are laser's, not the project's: they hold either way.
    expect(adapter.settingsManager.getPackages()).toEqual([]);
  });
});
