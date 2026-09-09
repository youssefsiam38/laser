/**
 * M13-T55 — a Settings write reaches a live session's engine settings.
 *
 * Against the real pinned engine. The first case pins the defect: the
 * adapter's write lands in the files, but an open session's own
 * `SettingsManager` is a separate instance and keeps the old value until
 * something reloads it. The rest cover the reload the driver now offers —
 * global and project scope, the `.laser` durable overrides surviving it, an
 * untrusted project contributing nothing — and the mid-turn case, where the
 * reload waits for the turn and the turn finishes exactly as it would have.
 *
 * Everything runs in temp directories; the user's real agent directory is
 * never read or written.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import type { SessionUpdate } from "@lasercode/protocol";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { SettingsAdapter } from "../src/settings.js";
import { durableOverrides } from "../src/settings-overrides.js";

let base: string;
let cwd: string;
let agentDir: string;
let driver: StableSdkDriver;
let updates: SessionUpdate[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-settings-reload-`));
  cwd = join(base, "project");
  agentDir = join(base, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  driver = new StableSdkDriver();
  updates = [];
  driver.subscribe((e) => {
    if (e.type === "update") updates.push(e.update);
  });
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  rmSync(base, { recursive: true, force: true });
});

const writeGlobal = (values: Record<string, unknown>): void => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(values, null, 2));
};

const writeLaser = (values: Record<string, unknown>): void => {
  mkdirSync(join(cwd, PROJECT_DIR_NAME), { recursive: true });
  writeFileSync(join(cwd, PROJECT_DIR_NAME, "settings.json"), JSON.stringify(values, null, 2));
};

const open = (projectTrusted = true) =>
  driver.open({ cwd, agentDir, sessionDir: join(base, "sessions"), projectTrusted });

/**
 * The engine's own view of the session's settings, not laser's copy of it.
 * The runtime is private on the driver by design, so the test reaches for it
 * deliberately (as settings-overrides.test.ts does).
 */
const engineSettings = (): SettingsManager => {
  const runtime = (driver as unknown as { runtime?: { services: { settingsManager: SettingsManager } } }).runtime;
  if (!runtime) throw new Error("driver has no open session");
  return runtime.services.settingsManager;
};

const stateUpdates = (from = 0) => updates.slice(from).filter((u): u is Extract<SessionUpdate, { kind: "state" }> => u.kind === "state");

describe("a Settings write and a live session (real engine)", () => {
  it("proof: the write lands in the file, the open session's engine settings keep the old value", async () => {
    writeGlobal({ steeringMode: "one-at-a-time" });
    await open();
    expect(engineSettings().getCompactionEnabled()).toBe(true);
    expect(driver.state().autoCompactionEnabled).toBe(true);

    // The worker's adapter is what `pi/settings/set` writes through.
    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    const snapshot = await settings.apply("global", [{ path: "compaction.enabled", op: "set", value: false }]);
    expect(snapshot.effective["compaction"]).toEqual({ enabled: false });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ compaction: { enabled: false } });

    // The defect: the session's manager is its own instance and nothing reloaded it.
    expect(engineSettings().getCompactionEnabled()).toBe(true);
    expect(driver.state().autoCompactionEnabled).toBe(true);
  }, 60_000);

  it("after a global write, the reload makes the session read it and tells the UI", async () => {
    writeGlobal({ steeringMode: "one-at-a-time" });
    await open();
    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    await settings.apply("global", [
      { path: "compaction.enabled", op: "set", value: false },
      { path: "steeringMode", op: "set", value: "all" },
      { path: "followUpMode", op: "set", value: "all" },
    ]);
    const from = updates.length;

    await expect(driver.reloadSettings()).resolves.toEqual({ deferred: false });

    // What the engine reads at turn time.
    expect(engineSettings().getCompactionEnabled()).toBe(false);
    expect(engineSettings().getSteeringMode()).toBe("all");
    // The agent's own copy of the queue modes, synced the way the engine's reload does.
    expect(driver.state()).toMatchObject({ autoCompactionEnabled: false, steeringMode: "all", followUpMode: "all" });
    // The UI hears about it through the existing state notification.
    expect(stateUpdates(from).at(-1)?.state).toMatchObject({ autoCompactionEnabled: false, steeringMode: "all", followUpMode: "all" });
  }, 60_000);

  it("after a project write, the fresh project-file values become the durable overrides", async () => {
    writeGlobal({ steeringMode: "one-at-a-time", defaultThinkingLevel: "low" });
    await open();
    expect(engineSettings().getDefaultThinkingLevel()).toBe("low");

    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    await settings.apply("project", [{ path: "defaultThinkingLevel", op: "set", value: "high" }]);
    expect(existsSync(join(cwd, PROJECT_DIR_NAME, "settings.json"))).toBe(true);
    // Not yet: the durable set still holds what `.laser` said at open time.
    expect(engineSettings().getDefaultThinkingLevel()).toBe("low");

    await driver.reloadSettings();
    expect(engineSettings().getDefaultThinkingLevel()).toBe("high");
    expect(durableOverrides(engineSettings())).toMatchObject({ defaultThinkingLevel: "high", packages: [], extensions: [], skills: [], prompts: [], themes: [] });
    // What the project did not override still comes from the global file.
    expect(engineSettings().getSteeringMode()).toBe("one-at-a-time");
    // The engine still never discovers `<cwd>/.pi`.
    expect(engineSettings().isProjectTrusted()).toBe(false);
    expect(engineSettings().getProjectSettings()).toEqual({});

    // Unsetting replaces the durable set rather than stacking on it.
    await settings.apply("project", [{ path: "defaultThinkingLevel", op: "unset" }]);
    await driver.reloadSettings();
    expect(engineSettings().getDefaultThinkingLevel()).toBe("low");
    expect(durableOverrides(engineSettings())).not.toHaveProperty("defaultThinkingLevel");
  }, 60_000);

  it("keeps the project-file values durable across the engine's own later reloads", async () => {
    writeLaser({ defaultModel: "from-project" });
    await open();
    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    await settings.apply("global", [{ path: "compaction.enabled", op: "set", value: false }]);
    await driver.reloadSettings();
    expect(engineSettings().getDefaultModel()).toBe("from-project");
    expect(engineSettings().getCompactionEnabled()).toBe(false);

    // An extension's ctx.reload(), a resource refresh: the engine's reload.
    await engineSettings().reload();
    expect(engineSettings().getDefaultModel()).toBe("from-project");
    expect(engineSettings().getCompactionEnabled()).toBe(false);
    expect(engineSettings().getPackages()).toEqual([]);
    expect(engineSettings().getExtensionPaths()).toEqual([]);
  }, 60_000);

  it("an untrusted project contributes nothing, before or after a reload", async () => {
    writeLaser({ defaultThinkingLevel: "high" });
    await open(false);
    expect(engineSettings().getDefaultThinkingLevel()).toBeUndefined();
    writeLaser({ defaultThinkingLevel: "high", defaultModel: "from-project" });
    await driver.reloadSettings();
    expect(engineSettings().getDefaultThinkingLevel()).toBeUndefined();
    expect(engineSettings().getDefaultModel()).toBeUndefined();
    expect(engineSettings().getPackages()).toEqual([]);
  }, 60_000);

  it("refuses before a session is open", async () => {
    await expect(driver.reloadSettings()).rejects.toThrow(/no open session/);
  });
});

// ------------------------------------------------------------- mid-turn ---

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

interface Stub {
  server: Server;
  url: string;
  /** Streams have been cut by the client this many times. */
  closed: number;
  /** Let the held reply finish. */
  release: () => void;
}

/** Streams "partial " and holds until released, then " done" and a normal stop. */
function startHeldProvider(): Promise<Stub> {
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  const stub: Partial<Stub> = { closed: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      res.write(sse({ ...base, choices: [{ index: 0, delta: { content: "partial " }, finish_reason: null }] }));
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 200);
      let cut = false;
      res.on("close", () => {
        clearInterval(keepAlive);
        if (cut) stub.closed! += 1;
      });
      cut = true;
      void released.then(() => {
        cut = false;
        clearInterval(keepAlive);
        res.write(sse({ ...base, choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
        res.end("data: [DONE]\n\n");
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ ...(stub as Stub), server, url: `http://127.0.0.1:${port}/v1`, release });
    });
  });
}

describe("a Settings write while a turn runs (real engine)", () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startHeldProvider();
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          stub: {
            baseUrl: stub.url,
            api: "openai-completions",
            apiKey: "stub-key",
            models: [{ id: "stub-1", name: "Stub One", contextWindow: 8000, maxTokens: 1000 }],
          },
        },
      }),
    );
    writeGlobal({ steeringMode: "one-at-a-time" });
  });

  afterEach(async () => {
    await driver.dispose().catch(() => {});
    stub.server.closeAllConnections();
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  const until = (predicate: (u: SessionUpdate) => boolean) =>
    new Promise<void>((resolve) => {
      const off = driver.subscribe((e) => {
        if (e.type === "update" && predicate(e.update)) {
          off();
          resolve();
        }
      });
    });

  it("is deferred to the turn's end, and the turn finishes exactly as it would have", async () => {
    await open();
    await driver.setModel({ provider: "stub", id: "stub-1" });
    const delta = until((u) => u.kind === "text_delta");
    const turn = driver.prompt([{ type: "text", text: "one" }]);
    await delta;
    expect(driver.state().isStreaming).toBe(true);

    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    await settings.apply("global", [
      { path: "steeringMode", op: "set", value: "all" },
      { path: "compaction.enabled", op: "set", value: false },
    ]);
    const from = updates.length;

    // Asked for mid-turn: owed, not done. The turn keeps its settings and its stream.
    await expect(driver.reloadSettings()).resolves.toEqual({ deferred: true });
    await expect(driver.reloadSettings()).resolves.toEqual({ deferred: true });
    expect(engineSettings().getSteeringMode()).toBe("one-at-a-time");
    expect(engineSettings().getCompactionEnabled()).toBe(true);
    expect(driver.state()).toMatchObject({ isStreaming: true, steeringMode: "one-at-a-time" });
    expect(stateUpdates(from)).toEqual([]);
    expect(stub.closed).toBe(0);

    // The turn ends on its own, whole, and only then does the session read the files.
    const reloaded = until((u) => u.kind === "state" && u.state.steeringMode === "all");
    stub.release();
    await turn;
    await reloaded;
    expect(stub.closed).toBe(0);
    const reply = updates.slice(from).find((u) => u.kind === "message_end" && u.role === "assistant");
    expect(reply).toMatchObject({ stopReason: "stop" });
    const kinds = updates.slice(from).map((u) => u.kind);
    expect(kinds.indexOf("agent_settled")).toBeGreaterThan(-1);
    expect(kinds.indexOf("agent_settled")).toBeLessThan(kinds.lastIndexOf("state"));
    expect(engineSettings().getSteeringMode()).toBe("all");
    expect(engineSettings().getCompactionEnabled()).toBe(false);
    expect(driver.state()).toMatchObject({ isStreaming: false, steeringMode: "all", autoCompactionEnabled: false });
    // Owed once, paid once: nothing is left for the next idle event.
    expect((driver as unknown as { settingsReloadWanted: boolean }).settingsReloadWanted).toBe(false);
    // The reply text reached the transcript intact.
    const { entries } = await driver.entries();
    const assistant = (entries as Array<{ type: string; message?: { role: string; content?: Array<{ type: string; text?: string }> } }>)
      .find((e) => e.type === "message" && e.message?.role === "assistant");
    expect(assistant?.message?.content?.map((c) => c.text).join("")).toBe("partial done");
  }, 30_000);
});
