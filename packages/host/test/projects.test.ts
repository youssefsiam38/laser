/**
 * Project list persistence and Laser-owned `.laser` trust decisions.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInfo } from "@lasercode/protocol";
import { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry, type TrustRequest } from "../src/projects.js";

let base: string;
let agentDir: string;
let sessionDir: string;
let catalog: SessionCatalog;

const project = (name: string, options: { laser?: boolean; pi?: boolean } = {}) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (options.pi) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), "{}");
  }
  if (options.laser) {
    mkdirSync(join(dir, PROJECT_DIR_NAME), { recursive: true });
    writeFileSync(join(dir, PROJECT_DIR_NAME, "settings.json"), "{}");
  }
  return dir;
};

function registry(options: Partial<ConstructorParameters<typeof ProjectRegistry>[0]> = {}) {
  const requests: TrustRequest[] = [];
  const changes: ProjectInfo[][] = [];
  const reg = new ProjectRegistry({
    catalog,
    agentDir,
    onTrustRequest: (r) => requests.push(r),
    onChange: (p) => changes.push(p),
    hasClients: () => true,
    trustTimeoutMs: 50,
    ...options,
  });
  return { reg, requests, changes };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-projects-`));
  agentDir = join(base, "agent");
  sessionDir = join(base, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  catalog = new SessionCatalog(sessionDir);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("ProjectRegistry", () => {
  it("unions pinned projects with the ones the catalog has seen, and persists the pinned ones", () => {
    const seen = project("seen");
    writeFileSync(
      join(sessionDir, "1_s.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "s", cwd: seen })}\n`,
    );
    const store = join(base, "projects.json");
    const { reg } = registry({ storePath: store });
    const added = reg.add(project("added"));
    expect(added.pinned).toBe(true);
    expect(reg.list().map((p) => [p.name, p.pinned, p.sessionCount])).toEqual([
      ["added", true, 0],
      ["seen", false, 1],
    ]);

    const { reg: reloaded } = registry({ storePath: store });
    expect(reloaded.list().filter((p) => p.pinned).map((p) => p.name)).toEqual(["added"]);

    // Removing forgets the pin; a directory the catalog knows stays visible.
    reloaded.remove(seen);
    reloaded.remove(join(base, "added"));
    expect(reloaded.list().map((p) => [p.name, p.pinned])).toEqual([["seen", false]]);
  });

  it("persists project priority and keeps entries omitted by a stale client", () => {
    const store = join(base, "projects.json");
    const alpha = project("alpha");
    const beta = project("beta");
    const gamma = project("gamma");
    const { reg, changes } = registry({ storePath: store });
    reg.add(alpha);
    reg.add(beta);
    reg.add(gamma);

    expect(reg.reorder([gamma, alpha]).map((entry) => entry.cwd)).toEqual([gamma, alpha, beta]);
    expect(changes.at(-1)?.map((entry) => entry.cwd)).toEqual([gamma, alpha, beta]);

    const { reg: reloaded } = registry({ storePath: store });
    expect(reloaded.list().map((entry) => entry.cwd)).toEqual([gamma, alpha, beta]);
  });

  it("does not ask about a directory with nothing trust-gated in it, and states no opinion", async () => {
    const plain = project("plain");
    const { reg, requests } = registry();
    expect(reg.trustOf(plain).trust).toBe("not_required");
    // `undefined`, never `false`: answering false would pin a project nobody
    // was asked about as *declined*, which the settings screen would then
    // report back to the user as their own decision.
    await expect(reg.ensureTrusted(plain)).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("distinguishes an explicit decline from nothing to decline", async () => {
    const declined = project("declined-explicitly", { laser: true });
    const { reg } = registry();
    reg.add(declined);
    reg.setTrust(declined, false, true);
    await expect(reg.ensureTrusted(declined)).resolves.toBe(false);
  });

  it("ignores the engine's project directory and trust files", async () => {
    const dir = project("engine-config", { pi: true });
    writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [dir]: false }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
    const { reg, requests } = registry();
    await expect(reg.ensureTrusted(dir)).resolves.toBeUndefined();
    expect(reg.trustOf(dir).trust).toBe("not_required");
    expect(requests).toEqual([]);
  });

  it("asks a client once per directory and remembers a remembered answer", async () => {
    const dir = project("ask", { laser: true });
    const store = join(base, "projects.json");
    const { reg, requests } = registry({ storePath: store });
    expect(reg.trustOf(dir).trust).toBe("unknown");
    expect(reg.trustOf(dir).reasons).toEqual([`${PROJECT_DIR_NAME}/settings.json`]);

    const first = reg.ensureTrusted(dir);
    const second = reg.ensureTrusted(dir); // concurrent open of a second session
    expect(requests).toHaveLength(1);
    expect(reg.pendingTrustRequests()).toHaveLength(1);

    reg.setTrust(dir, true, true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(reg.pendingTrustRequests()).toEqual([]);

    const { reg: reloaded } = registry({ storePath: store });
    expect(reloaded.trustOf(dir).trust).toBe("trusted");
  });

  it("declines for this run when nobody answers, and asks again next time", async () => {
    const dir = project("timeout", { laser: true });
    const { reg } = registry({ trustTimeoutMs: 10 });
    await expect(reg.ensureTrusted(dir)).resolves.toBe(false);
    expect(reg.trustOf(dir).trust).toBe("unknown"); // no decision was recorded
  });

  it("fails loudly instead of hanging when no client could answer", async () => {
    const dir = project("headless", { laser: true });
    const { reg } = registry({ hasClients: () => false });
    await expect(reg.ensureTrusted(dir)).rejects.toThrow(/trust decision/);
  });
});
