/**
 * M22-T5 · the host runs the one-way migration onto Model Profiles behind the
 * first worker, and offers the seeded profiles for review when a provider is
 * connected (`docs/model-profiles.md`, "Migration").
 *
 * Against a fake worker (a real child process speaking the fd-3 protocol), so
 * the spawn, the priming and the request are the real ones and no engine is
 * involved. The worker is the only writer of the settings file, so what it
 * answers is what the host has to believe.
 */
import { GLOBAL_AGENTS_DIR_NAME, PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer } from "../../src/index.js";

const BALANCED = "mp_testbalanced000000000";
const FAST = "mp_testfast00000000000000";
const MIGRATION_REPORT = {
  ran: true,
  profiles: [
    { id: BALANCED, name: "Balanced", models: [{ provider: "stub", id: "stub-1" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: FAST, name: "Fast", models: [{ provider: "stub", id: "stub-nano" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
  assignments: { defaultProfileId: BALANCED, namingProfileId: FAST, oracleProfileId: BALANCED, designIndexProfileId: BALANCED },
  notes: ["Created Balanced and Fast from the models you have connected."],
};

/**
 * A worker that answers the three requests this path needs and logs every
 * method it saw. `configured` says whether the stub provider has credentials;
 * with `loginAfter` set it connects one and announces it, the way a sign-in
 * through the UI does.
 *
 * `models/profiles/migrate` answers the way the real planner does: a legacy
 * choice whose model already begins a profile resolves to that profile, and
 * anything else gets one created for it. The planner's own rules are proven in
 * `packages/worker/test/profiles/migrate.test.ts`; what matters here is that
 * the host offers its choices and applies the answer.
 */
function fakeWorker(options: { log: string; configured: boolean; loginAfter?: string; choicesLog?: string; ranMarker?: string; settingsLog?: string; naming?: boolean }): string {
  return `
import { Socket } from "node:net";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const LOG = ${JSON.stringify(options.log)};
const CHOICES_LOG = ${JSON.stringify(options.choicesLog ?? null)};
const SETTINGS_LOG = ${JSON.stringify(options.settingsLog ?? null)};
const RAN_MARKER = ${JSON.stringify(options.ranMarker ?? null)};
const REPORT = ${JSON.stringify(MIGRATION_REPORT)};
const NAMING = ${options.naming === false ? "false" : "true"};

/** The planner's find-or-create rule, in the small: same key, same answer. */
function migrate(params) {
  const report = JSON.parse(JSON.stringify(REPORT));
  if (!NAMING) report.assignments.namingProfileId = null;
  const choices = (params && params.legacyChoices) || [];
  if (CHOICES_LOG) writeFileSync(CHOICES_LOG, JSON.stringify(choices));
  const resolved = {};
  for (const choice of choices) {
    const key = (choice.model.provider + "/" + choice.model.id).toLowerCase();
    const existing = report.profiles.find((profile) => (profile.models[0].provider + "/" + profile.models[0].id).toLowerCase() === key);
    resolved[choice.key] = existing ? existing.id : createdIdFor(choice);
  }
  report.resolved = resolved;
  // A settings file that already says all of this is not written again.
  if (RAN_MARKER) {
    report.ran = !existsSync(RAN_MARKER);
    writeFileSync(RAN_MARKER, "done");
  }
  return report;
}

/** Deterministic, so a second host start resolves the same key to the same profile. */
function createdIdFor(choice) {
  const slug = (choice.model.provider + choice.model.id).replace(/[^0-9A-Za-z]/g, "").slice(0, 20);
  return "mp_" + slug.padEnd(20, "0");
}

const LOGIN_AFTER = ${JSON.stringify(options.loginAfter ?? null)};
let configured = ${options.configured ? "true" : "false"};
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    appendFileSync(LOG, req.method + "\\n");
    let result = { ok: true };
    if (req.method === "pi/providers/list") result = { providers: [{ id: "stub", name: "Stub", configured, methods: [] }] };
    else if (req.method === "models/profiles/migrate") result = { report: migrate(req.params) };
    else if (req.method === "pi/settings/set") {
      if (SETTINGS_LOG) appendFileSync(SETTINGS_LOG, JSON.stringify(req.params.changes) + "\\n");
      result = { snapshot: {} };
    }
    else if (req.method === "agents/skills") result = { skills: [], roots: [] };
    send({ jsonrpc: "2.0", id: req.id, result });
    if (LOGIN_AFTER && req.method === LOGIN_AFTER) {
      configured = true;
      send({ jsonrpc: "2.0", method: "pi/providers/login/event", params: { cwd, id: "login-1", provider: "stub", event: { type: "done" } } });
    }
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal" } });
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } });
`;
}

class Client {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly inbound: JsonRpcMessage[] = [];
  async connect(url: string) {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.ws.on("message", (d) => this.inbound.push(JSON.parse(d.toString()) as JsonRpcMessage));
    await new Promise<void>((r) => this.ws.once("open", () => r()));
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20_000);
      const on = () => {
        const hit = this.inbound.find((m) => "id" in m && m.id === id) as { result?: R; error?: { message: string } } | undefined;
        if (!hit) return;
        clearTimeout(timer);
        this.ws.off("message", on);
        if (hit.error) reject(new Error(hit.error.message));
        else resolve(hit.result as R);
      };
      this.ws.on("message", on);
      on();
    });
  }
  notifications(method: string): unknown[] {
    return this.inbound.filter((m) => "method" in m && m.method === method).map((m) => (m as { params: unknown }).params);
  }
  close() {
    this.ws.close();
  }
}

let base: string;
let project: string;
let workerMain: string;
let log: string;
let host: HostServer | undefined;
let client: Client | undefined;

const methodsSeen = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []);

async function startHost(): Promise<Client> {
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    workerMain,
    workerIdleMs: 0,
    log: () => {},
  });
  const { url } = await host.listen();
  client = new Client();
  await client.connect(url);
  return client;
}

/** The preview the migration writes; the only durable evidence it ran. */
type MigrationRecord = {
  version: number;
  settings: { ran: boolean; notes: string[] };
  builtins?: Array<{ name: string; from: string | null; to: string | null }>;
  agentFiles?: Array<{ path: string; from: string | null; to: string | null }>;
};
const recordPathOf = () => join(base, "state", "model-profiles-migration.json");
const readRecord = (): MigrationRecord => JSON.parse(readFileSync(recordPathOf(), "utf8")) as MigrationRecord;
const migrated = () => methodsSeen().filter((m) => m === "models/profiles/migrate").length;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-profiles-migration-`));
  project = join(base, "project");
  for (const dir of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, dir), { recursive: true });
  workerMain = join(base, "fake-worker.mjs");
  log = join(base, "methods.log");
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await host?.close();
  host = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe("the model-profile migration at host start", () => {
  it("runs once behind the first worker and writes the preview", async () => {
    const settingsLog = join(base, "settings.log");
    writeFileSync(workerMain, fakeWorker({ log, configured: true, settingsLog }));
    const c = await startHost();
    // Anything that needs this project's worker is enough; nothing waits on
    // the migration, so the request itself answers first.
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(() => expect(existsSync(recordPathOf())).toBe(true), { timeout: 10_000, interval: 25 });
    expect(migrated()).toBe(1);
    // There are no built-in agents to give a profile to (D-347), and the
    // settings file already assigns one to naming, so nothing is written to it.
    expect(existsSync(settingsLog)).toBe(false);

    // The preview a person reads is written under the state directory, once.
    const record = readRecord();
    expect(record.version).toBe(1);
    expect(record.settings.ran).toBe(true);
    expect(record.settings.notes.join(" ")).toContain("Balanced");
    // Nothing on this machine chose a model before profiles existed, so the
    // record claims no conversion: it says what happened (B1).
    expect(record.builtins).toBeUndefined();
  });

  it("offers the seeded profiles for review when a provider is connected, once", async () => {
    writeFileSync(workerMain, fakeWorker({ log, configured: false, loginAfter: "pi/keybindings/get" }));
    const c = await startHost();
    await c.request("pi/keybindings/get", { cwd: project });
    await vi.waitFor(() => expect(c.notifications("models/profiles/seeded").length).toBe(1), { timeout: 10_000, interval: 25 });
    // The seeded set is offered, never applied silently.
    expect(c.notifications("models/profiles/seeded")).toHaveLength(1);
    expect(c.notifications("models/profiles/seeded")[0]).toMatchObject({ profiles: [{ name: "Balanced" }, { name: "Fast" }] });
  });

  it("turns the retired built-ins' models and an agent file's model into profiles, once", async () => {
    // What a machine upgrading from the previous generation actually holds:
    // built-in model choices in `agents.json` and a definition file that still
    // says `model:` (`docs/model-profiles.md`, "Migration"; B1/B2).
    writeFileSync(join(base, "state", "agents.json"), JSON.stringify({
      version: 2,
      revision: 3,
      defaultAgent: "default",
      beam: { model: { provider: "stub", id: "stub-1" }, suggested: null, needsChoice: false },
      chat: { model: null },
      namer: { status: "ready", model: { provider: "stub", id: "stub-old" }, candidates: [] },
    }));
    mkdirSync(join(base, "state", GLOBAL_AGENTS_DIR_NAME), { recursive: true });
    const reviewer = join(base, "state", GLOBAL_AGENTS_DIR_NAME, "reviewer.md");
    writeFileSync(reviewer, [
      "---",
      "description: reviews changes",
      "model: stub/stub-1",
      "---",
      "Act as reviewer.",
      "",
    ].join("\n"));
    const choicesLog = join(base, "choices.json");
    const ranMarker = join(base, "migrated.marker");
    writeFileSync(workerMain, fakeWorker({ log, configured: true, choicesLog, ranMarker }));

    const c = await startHost();
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(() => expect(existsSync(recordPathOf())).toBe(true), { timeout: 10_000, interval: 25 });

    // The file was rewritten exactly once, and only the field changed.
    await vi.waitFor(() => expect(readFileSync(reviewer, "utf8")).toContain(`profile: ${BALANCED}`), { timeout: 10_000, interval: 25 });
    const rewritten = readFileSync(reviewer, "utf8");
    expect(rewritten).not.toContain("model:");
    expect(rewritten.endsWith("Act as reviewer.\n")).toBe(true);

    // Every choice this host held was offered to the only writer there is.
    const offered = JSON.parse(readFileSync(choicesLog, "utf8")) as Array<{ key: string; label: string; model: { provider: string; id: string } }>;
    expect(offered).toEqual(expect.arrayContaining([
      { key: "builtin:beam", label: "Beam", model: { provider: "stub", id: "stub-1" } },
      { key: "builtin:namer", label: "Namer", model: { provider: "stub", id: "stub-old" } },
      { key: reviewer, label: "reviewer", model: { provider: "stub", id: "stub-1" } },
    ]));

    // The preview record is evidence: real `from` values, and only the things
    // that were actually converted. The model the removed Beam built-in was on
    // already began a profile; the naming one's did not, so a profile was
    // created for it.
    const recordPath = recordPathOf();
    await vi.waitFor(() => expect(readRecord().builtins?.length).toBe(2), { timeout: 10_000, interval: 25 });
    const record = readRecord();
    expect(record.builtins).toEqual([
      { name: "beam", from: "stub/stub-1", to: BALANCED },
      expect.objectContaining({ name: "namer", from: "stub/stub-old", to: expect.stringMatching(/^mp_stubstubold/) }),
    ]);
    expect(record.agentFiles).toEqual([{ path: reviewer, from: "stub/stub-1", to: BALANCED }]);

    // A second start converts nothing: the file is left alone and the record
    // of the run that did the work is not overwritten with an empty one.
    const recordBefore = readFileSync(recordPath, "utf8");
    client?.close();
    await host?.close();
    host = undefined;
    const next = await startHost();
    await next.request("agents/skills", { cwd: project });
    await vi.waitFor(() => expect(methodsSeen().filter((m) => m === "models/profiles/migrate")).toHaveLength(2), { timeout: 10_000, interval: 25 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(reviewer, "utf8")).toBe(rewritten);
    expect(readFileSync(recordPath, "utf8")).toBe(recordBefore);
    expect(JSON.parse(readFileSync(choicesLog, "utf8"))).toEqual([]);
  });

  it("carries the naming profile the removed built-in held, when Settings assigns none", async () => {
    // The person chose which models may title a conversation on the Namer
    // built-in. It is gone; the choice is not (`docs/plain-chat.md`).
    writeFileSync(join(base, "state", "agents.json"), JSON.stringify({
      version: 2, revision: 1, defaultAgent: "default",
      builtinProfiles: { beam: null, chat: null, namer: FAST },
    }));
    const settingsLog = join(base, "settings.log");
    writeFileSync(workerMain, fakeWorker({ log, configured: true, settingsLog, naming: false }));
    const c = await startHost();
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(() => expect(existsSync(settingsLog)).toBe(true), { timeout: 10_000, interval: 25 });
    const written = readFileSync(settingsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown[]);
    expect(written).toEqual([[{ path: "namingProfileId", op: "set", value: FAST }]]);
  });

  it("never overrules a naming profile Settings already assigns", async () => {
    writeFileSync(join(base, "state", "agents.json"), JSON.stringify({
      version: 2, revision: 1, defaultAgent: "default",
      builtinProfiles: { beam: null, chat: null, namer: "mp_testpicked00000000000" },
    }));
    const settingsLog = join(base, "settings.log");
    writeFileSync(workerMain, fakeWorker({ log, configured: true, settingsLog }));
    const c = await startHost();
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(() => expect(existsSync(recordPathOf())).toBe(true), { timeout: 10_000, interval: 25 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(settingsLog)).toBe(false);
  });
});
