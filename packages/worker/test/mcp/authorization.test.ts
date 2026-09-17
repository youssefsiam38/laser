import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { McpAuthorizationRegistry, mcpAuthorizationIdentity, mcpAuthorizationIdentities, mcpAuthorizationAccount, mcpAuthorizationPartition, mcpAuthorizationRevision } from "../../src/mcp/authorization.js";
import type { McpConfiguredServer } from "../../src/mcp/store.js";

// Keep real filesystem behavior, with configurable exports for scoped faults.
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let root: string;
const server: McpConfiguredServer = { name: "notion", transport: { kind: "http", url: "https://example.test/mcp" } };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), `${PRODUCT_NAME}-mcp-authorization-`)); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("MCP authorization identities and durable generations", () => {
  it("separates scopes, projects and endpoints, not display names or credentials", async () => {
    const a = await mcpAuthorizationIdentity("project", join(root, "a"), server);
    const b = await mcpAuthorizationIdentity("project", join(root, "b"), server);
    const global = await mcpAuthorizationIdentity("global", root, server);
    expect(new Set([a, b, global]).size).toBe(3);
    expect(await mcpAuthorizationIdentity("global", join(root, "b"), server)).toBe(global);
    expect(await mcpAuthorizationIdentity("global", root, { ...server, name: "other", label: "New label", auth: { kind: "bearer", token: "secret-sentinel" } })).toBe(global);
    expect(await mcpAuthorizationIdentity("global", root, { ...server, transport: { kind: "http", url: "https://other.test/mcp" } })).not.toBe(global);
    expect(global).not.toContain("example");
  });

  it("canonicalizes project aliases", async () => {
    const project = join(root, "project");
    await mkdir(project);
    await symlink(project, join(root, "alias"), "dir");
    expect(await mcpAuthorizationIdentity("project", project, server)).toBe(await mcpAuthorizationIdentity("project", join(root, "alias"), server));
  });

  it("separates command arguments and transport kinds", async () => {
    const command: McpConfiguredServer = { name: "x", transport: { kind: "stdio", command: "node", args: ["server-a.mjs"] } };
    const a = await mcpAuthorizationIdentity("global", root, command);
    const b = await mcpAuthorizationIdentity("global", root, { ...command, transport: { kind: "stdio", command: "node", args: ["server-b.mjs"] } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(await mcpAuthorizationIdentity("global", root, server));
  });

  it("fingerprints the SDK's expanded URLs, arguments and relative transport paths", async () => {
    vi.stubEnv("MCP_IDENTITY_HOST", "EXAMPLE.test:443");
    const expanded = { ...server, transport: { kind: "http" as const, url: "https://${MCP_IDENTITY_HOST}/mcp" } };
    const first = await mcpAuthorizationIdentity("global", root, expanded);
    expect(first).toBe(await mcpAuthorizationIdentity("global", root, server));
    vi.stubEnv("MCP_IDENTITY_HOST", "other.test");
    expect(await mcpAuthorizationIdentity("global", root, expanded)).not.toBe(first);
    vi.stubEnv("MCP_IDENTITY_ARG", "first");
    const command = { name: "x", transport: { kind: "stdio" as const, command: "node", args: ["${MCP_IDENTITY_ARG}"], cwd: "sub" } };
    expect(await mcpAuthorizationIdentity("global", root, command)).toBe(await mcpAuthorizationIdentity("global", root, { ...command, transport: { ...command.transport, args: ["first"], cwd: join(root, "sub") } }));
    expect(await mcpAuthorizationIdentity("global", join(root, "other"), command)).not.toBe(await mcpAuthorizationIdentity("global", root, command));
    const socket = { name: "x", transport: { kind: "socket" as const, path: "~/fixture.sock" } };
    expect(await mcpAuthorizationIdentity("global", root, socket)).toBe(await mcpAuthorizationIdentity("global", root, { ...socket, transport: { ...socket.transport, path: join(homedir(), "fixture.sock") } }));
  });

  it("uses the same relative cwd and expanded argument on real stdio transports in two projects", async () => {
    vi.stubEnv("MCP_IDENTITY_ARG", "expanded-argument");
    const script = join(root, "server.mjs");
    await writeFile(script, `import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", line => {
        const q = JSON.parse(line); if (q.id === undefined) return;
        let result;
        if (q.method === "initialize") result = { protocolVersion: q.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:process.cwd(),version:"1"} };
        else if (q.method === "tools/list") result = {tools:[{name:"where",description:"Working directory",inputSchema:{type:"object"}}]};
        else if (q.method === "tools/call") result = {content:[{type:"text",text:process.cwd()+"|"+process.argv[2]}]};
        else if (q.method === "ping") result = {};
        process.stdout.write(JSON.stringify(result === undefined ? {jsonrpc:"2.0",id:q.id,error:{code:-32601,message:"Unsupported"}} : {jsonrpc:"2.0",id:q.id,result})+"\\n");
      });`);
    const { McpInspector } = await import("../../src/mcp/inspector.js");
    const config: McpConfiguredServer = { name: "where", protocolVersion: "legacy", transport: { kind: "stdio", command: process.execPath, args: [script, "${MCP_IDENTITY_ARG}"], cwd: "nested" } };
    const identities: string[] = [];
    for (const project of [join(root, "a"), join(root, "b")]) {
      await mkdir(join(project, "nested"), { recursive: true });
      const inspector = new McpInspector(project, root);
      try {
        identities.push(await mcpAuthorizationIdentity("global", project, config));
        const result = await inspector.inspect({ scope: "global", config, secrets: new Map() });
        expect(result.server?.name).toBe(join(project, "nested"));
        expect(await inspector.call("global", config, new Map(), "where", {})).toMatchObject({ ok: true, content: [{ type: "text", text: `${join(project, "nested")}|expanded-argument` }] });
      } finally { await inspector.dispose(); }
    }
    expect(identities[0]).not.toBe(identities[1]);
  }, 30_000);

  it("canonicalizes logical partitions independently of order and observation time", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshots = await Promise.all((await mcpAuthorizationIdentities("global", root, server)).map(id => registry.establish(id)));
    const reordered = snapshots.toReversed().map(value => ({ ...value, updatedAt: value.updatedAt + 1 }));
    expect(mcpAuthorizationPartition(reordered)).toBe(mcpAuthorizationPartition(snapshots));
    expect(mcpAuthorizationRevision(reordered)).toBe(mcpAuthorizationRevision(snapshots));
    const primary = snapshots[0]!;
    expect(mcpAuthorizationAccount(primary)).toBe(`${primary.identity}:${primary.generation.epoch}`);
    for (const generation of [{ ...primary.generation, counter: primary.generation.counter + 1 }, { ...primary.generation, epoch: "00000000-0000-0000-0000-000000000000" }]) {
      expect(mcpAuthorizationPartition([{ ...primary, generation }, ...snapshots.slice(1)])).not.toBe(mcpAuthorizationPartition(snapshots));
    }
  });

  it.each([false, true])("coalesces fresh setup without locking established reads (established=%s)", async established => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const before = established ? await registry.establish(id) : undefined;
    const snapshots = await Promise.all(Array.from({ length: 12 }, () => new McpAuthorizationRegistry(root).establish(id)));
    expect(snapshots.every(snapshot => JSON.stringify(snapshot) === JSON.stringify(snapshots[0]))).toBe(true);
    if (before) expect(snapshots[0]).toEqual(before);
    expect(await registry.current(snapshots[0]!)).toBe(true);
  });

  it("locks configuration guards during a credential write without advancing their generations", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const ids = await mcpAuthorizationIdentities("global", root, server);
    const snapshots = await Promise.all(ids.map(id => registry.establish(id)));
    const expected = new Map(snapshots.map(snapshot => [snapshot.identity, snapshot]));
    const committed = await registry.revoke([ids[0]!], async next => {
      expect((await Promise.all(snapshots.map(snapshot => registry.current(snapshot)))).every(value => !value)).toBe(true);
      return next;
    }, expected);
    expect(await registry.current(snapshots[0]!)).toBe(false);
    for (const guard of snapshots.slice(1)) {
      expect(committed.get(guard.identity)).toEqual(guard);
      expect(await registry.current(guard)).toBe(true);
    }
    await registry.bump(ids[1]!);
    let saved = false;
    await expect(registry.revoke([ids[0]!], async () => { saved = true; }, committed)).rejects.toThrow("access changed");
    expect(saved).toBe(false);
  });

  it("revokes snapshots held by independent worker registries without changing other identities", async () => {
    const workerA = new McpAuthorizationRegistry(root);
    const workerB = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const other = await mcpAuthorizationIdentity("project", root, server);
    const first = await workerA.establish(id);
    const unaffected = await workerB.establish(other);
    expect(await workerB.current(first)).toBe(true);
    const second = await workerB.bump(id);
    expect(second.generation.counter).toBe(first.generation.counter + 1);
    expect(await workerA.current(first)).toBe(false);
    expect(await workerA.current(second)).toBe(true);
    expect(await workerA.current(unaffected)).toBe(true);
    expect(await new McpAuthorizationRegistry(root).establish(id)).toEqual(second);
    const persisted = JSON.parse(await readFile(join(workerA.directory, `${id}.json`), "utf8"));
    expect(Object.keys(persisted).sort()).toEqual(["generation", "identity", "updatedAt"]);
  });

  it("fences another process before token persistence settles and refuses a stale refresh transaction", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const source = fileURLToPath(new URL("../../src/mcp/authorization.ts", import.meta.url));
    const readFromProcess = async () => {
      const script = `import {createJiti} from "jiti";
        const {McpAuthorizationRegistry}=await createJiti(import.meta.url,{fsCache:false}).import(${JSON.stringify(source)});
        console.log(JSON.stringify(await new McpAuthorizationRegistry(${JSON.stringify(root)}).current(${JSON.stringify(snapshot)})));`;
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
      return JSON.parse(result.stdout.trim());
    };
    expect(await readFromProcess()).toBe(true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = registry.revoke([id], async committed => { entered.resolve(); await release.promise; return committed.get(id)!; }, new Map([[id, snapshot]]));
    await entered.promise;
    try { expect(await readFromProcess()).toBe(false); } finally { release.resolve(); }
    const committed = await write;
    expect(await registry.current(committed)).toBe(true);
    expect(await readFromProcess()).toBe(false);
    let saved = false;
    await expect(registry.revoke([id], async () => { saved = true; }, new Map([[id, snapshot]]))).rejects.toThrow("access changed");
    expect(saved).toBe(false);
    expect(await registry.current(committed)).toBe(true);
  });

  it.each(["{torn", "{}", "x".repeat(1_024)])("fails stale on corrupt state and repairs only for fresh authorization (%s)", async (contents) => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const old = await registry.establish(id);
    await writeFile(join(registry.directory, `${id}.json`), contents);
    expect(await registry.current(old)).toBe(false);
    const repaired = await registry.establish(id);
    expect(repaired.generation.epoch).not.toBe(old.generation.epoch);
    expect(await registry.current(old)).toBe(false);
    expect(await registry.current(repaired)).toBe(true);
  });

  it("joins a pending same-worker establishment after actually observing its held lock", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const path = join(registry.directory, `${id}.json`);
    const entered = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const open = fs.open;
    const lstat = fs.lstat;
    let watching = false;
    let held = false;
    const locks = vi.spyOn(lockfile, "lock");
    const probe = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const result = await lstat(...args);
      if (watching && args[0] === `${path}.lock`) observed.resolve();
      return result;
    });
    const gate = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === path && args[1] === "r" && !held && await lstat(`${path}.lock`).then(() => true, () => false)) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return open(...args);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending: Array<ReturnType<McpAuthorizationRegistry["establish"]>> = [];
    try {
      const first = registry.establish(id);
      pending.push(first);
      await entered.promise;
      watching = true;
      const second = new McpAuthorizationRegistry(root).establish(id);
      pending.push(second);
      await observed.promise;
      release.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(b).toEqual(a);
      expect(locks).toHaveBeenCalledTimes(1);
      expect(await registry.current(a)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      gate.mockRestore();
      probe.mockRestore();
      locks.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["complete", "EIO", "deadline"] as const)("preserves a valid generation across partial filesystem chunks (%s)", async fault => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshot = await registry.establish(await mcpAuthorizationIdentity("global", root, server));
    const path = join(registry.directory, `${snapshot.identity}.json`);
    const before = await readFile(path, "utf8");
    const entered = Array.from({ length: 2 }, () => Promise.withResolvers<void>());
    const release = Promise.withResolvers<void>();
    const drained: Promise<void>[] = [];
    const positions: number[][] = [];
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] !== path || args[1] !== "r") return handle;
      const index = positions.length;
      const observed: number[] = [];
      positions.push(observed);
      const closed = Promise.withResolvers<void>();
      drained.push(closed.promise);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      const partial = async (buffer: Buffer, offset: number, length: number, position: number) => {
        observed.push(position);
        if (observed.length === 2 && fault === "EIO") throw Object.assign(new Error("synthetic partial read failure"), { code: "EIO" });
        if (observed.length === 2 && fault === "deadline") {
          entered[index]!.resolve();
          await release.promise;
        }
        return read(buffer, offset, Math.min(length, 11), position);
      };
      vi.spyOn(handle, "read").mockImplementation(partial as typeof handle.read);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        try { await close(); } finally { closed.resolve(); }
      });
      return handle;
    });
    if (fault === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: typeof snapshot | undefined;
    let error: unknown;
    try {
      const outcome = registry.establish(snapshot.identity).then(value => { result = value; }, value => { error = value; });
      if (fault === "deadline") for (const signal of entered) {
        if (!await Promise.race([signal.promise.then(() => true), outcome.then(() => false)])) break;
        await vi.advanceTimersByTimeAsync(101);
      }
      await outcome;
    } finally {
      release.resolve();
      spy.mockRestore();
      try { await Promise.all(drained); } finally { vi.useRealTimers(); }
    }
    expect(await readFile(path, "utf8")).toBe(before);
    if (fault === "complete") {
      expect(result).toEqual(snapshot);
      expect(error).toBeUndefined();
      expect(positions).toHaveLength(1);
      expect(positions[0]!.slice(0, 3)).toEqual([0, 11, 22]);
      expect(positions[0]!.at(-1)).toBe(Buffer.byteLength(before)); // EOF, not a short-prefix guess
    } else {
      expect(error).toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE" });
      expect(result).toBeUndefined();
      expect(positions).toHaveLength(2); // advisory observation, then locked authority
      expect(positions.every(value => value.length === 2)).toBe(true);
    }
    expect(await registry.current(snapshot)).toBe(true);
  });

  it.each(["establish", "establish-first-read", "bump", "cas", "credential-account"] as const)("preserves an existing record when %s reads are unavailable", async operation => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshot = await registry.establish(await mcpAuthorizationIdentity("global", root, server));
    const path = join(registry.directory, `${snapshot.identity}.json`);
    const before = await readFile(path, "utf8");
    const save = vi.fn(async () => undefined);
    const open = fs.open;
    let reads = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === path && args[1] === "r" && (++reads === 1 || operation !== "establish-first-read")) {
        throw Object.assign(new Error("private-path-and-credential-sentinel"), { code: "EIO" });
      }
      return open(...args);
    });
    const execute = () => operation === "bump" ? registry.bump(snapshot.identity)
      : operation === "cas" ? registry.revoke([snapshot.identity], save, new Map([[snapshot.identity, snapshot]]))
      : operation === "credential-account" ? registry.credentialAccount(snapshot.identity)
      : registry.establish(snapshot.identity);
    let result: unknown;
    let error: unknown;
    try { result = await execute().catch(value => { error = value; }); }
    finally { spy.mockRestore(); }
    expect(await readFile(path, "utf8")).toBe(before);
    if (operation === "establish-first-read") {
      expect(result).toEqual(snapshot);
      expect(error).toBeUndefined();
      expect(reads).toBe(2); // advisory fault followed by one healthy locked preflight
    } else {
      expect(error).toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE", reason: "unavailable" });
      expect(String(error)).not.toContain("private-path-and-credential-sentinel");
    }
    expect(save).not.toHaveBeenCalled();
    expect(await registry.current(snapshot)).toBe(true);
  });

  it.each((["establish", "bump", "cas", "credential-account"] as const).flatMap(operation =>
    (["open", "close"] as const).map(phase => ({ operation, phase }))))("preserves raw bytes when $operation exceeds the bounded filesystem deadline ($phase)", async ({ operation, phase }) => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshot = await registry.establish(await mcpAuthorizationIdentity("global", root, server));
    const path = join(registry.directory, `${snapshot.identity}.json`);
    const before = await readFile(path, "utf8");
    const save = vi.fn(async () => undefined);
    const entered = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const release = Promise.withResolvers<void>();
    const drained: Promise<void>[] = [];
    const open = fs.open;
    let reads = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] !== path || args[1] !== "r") return open(...args);
      const closed = Promise.withResolvers<void>(); drained.push(closed.promise);
      const signal = entered[reads++]!;
      if (phase === "open") { signal.resolve(); await release.promise; }
      try {
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          if (phase === "close") { signal.resolve(); await release.promise; }
          try { await close(); } finally { closed.resolve(); }
        });
        return handle;
      } catch (error) { closed.resolve(); throw error; }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const execute = () => operation === "bump" ? registry.bump(snapshot.identity)
      : operation === "cas" ? registry.revoke([snapshot.identity], save, new Map([[snapshot.identity, snapshot]]))
      : operation === "credential-account" ? registry.credentialAccount(snapshot.identity)
      : registry.establish(snapshot.identity);
    let error: unknown;
    try {
      const outcome = execute().catch(value => { error = value; });
      // Advance only after each real filesystem operation reaches its gate.
      // Establishment has an advisory probe and one locked preflight; other
      // paths have one authoritative read. Neither may repair an unknown record.
      for (const signal of entered) {
        if (!await Promise.race([signal.promise.then(() => true), outcome.then(() => false)])) break;
        await vi.advanceTimersByTimeAsync(101);
      }
      await outcome;
    } finally {
      release.resolve(); spy.mockRestore();
      try { await Promise.all(drained); } finally { vi.useRealTimers(); }
    }
    expect(await readFile(path, "utf8")).toBe(before);
    expect(error).toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE", reason: "unavailable" });
    expect(save).not.toHaveBeenCalled();
    expect(await registry.current(snapshot)).toBe(true);
  });

  it("does not repair an unreadable record published after the initial missing observation", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshot = await registry.establish(await mcpAuthorizationIdentity("global", root, server));
    const path = join(registry.directory, `${snapshot.identity}.json`);
    const before = await readFile(path, "utf8");
    await fs.unlink(path);
    const open = fs.open;
    let reads = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] !== path || args[1] !== "r") return open(...args);
      if (++reads === 1) {
        try { return await open(...args); }
        catch (error) {
          expect(error).toMatchObject({ code: "ENOENT" });
          // Another worker publishes the valid record before we acquire its lock.
          await writeFile(path, before);
          throw error;
        }
      }
      throw Object.assign(new Error("synthetic storage unavailable"), { code: "EACCES" });
    });
    try { await expect(registry.establish(snapshot.identity)).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }); }
    finally { spy.mockRestore(); }
    expect(reads).toBe(2);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await registry.current(snapshot)).toBe(true);
  });

  it.each(["lock-before", "lock-after", "read", "close"] as const)("does not mistake a %s I/O refusal for a missing or corrupt record", async phase => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshot = await registry.establish(await mcpAuthorizationIdentity("global", root, server));
    const path = join(registry.directory, `${snapshot.identity}.json`);
    const before = await readFile(path, "utf8");
    const unavailable = Object.assign(new Error("private-storage-sentinel"), { code: "EACCES" });
    const lstat = fs.lstat, open = fs.open;
    let probes = 0;
    const lockSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (args[0] === `${path}.lock` && ++probes === (phase === "lock-before" ? 1 : phase === "lock-after" ? 2 : -1)) throw unavailable;
      return lstat(...args);
    });
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path && args[1] === "r") {
        if (phase === "read") vi.spyOn(handle, "read").mockRejectedValue(unavailable);
        if (phase === "close") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw unavailable; });
        }
      }
      return handle;
    });
    try {
      // The public guard always refuses this observation. Establishment may
      // safely fall through to a healthy locked preflight for lock-probe faults.
      expect(await registry.current(snapshot)).toBe(false);
      probes = 0;
      if (phase === "lock-before" || phase === "lock-after") {
        expect(await registry.establish(snapshot.identity)).toEqual(snapshot);
      } else {
        await expect(registry.establish(snapshot.identity)).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE" });
      }
    } finally { lockSpy.mockRestore(); openSpy.mockRestore(); }
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await registry.current(snapshot)).toBe(true);
  });

  async function transactionFixture(count = 2) {
    const registry = new McpAuthorizationRegistry(root);
    const ids = Array.from({ length: count }, (_, index) => String(index + 1).repeat(64));
    const snapshots = await Promise.all(ids.map(id => registry.establish(id)));
    const paths = ids.map(id => join(registry.directory, `${id}.json`));
    const bytes = () => Promise.all(paths.map(path => readFile(path, "utf8")));
    const expectReleased = async () => {
      for (const path of paths) await expect(fs.lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      // A healthy mutation must actually reacquire every released lock.
      return registry.revoke(ids, async next => next);
    };
    return { registry, ids, snapshots, paths, bytes, expectReleased };
  }

  it.each((["unavailable", "cas-mismatch", "held-lock"] as const).flatMap(fault =>
    [false, true].map(reverse => ({ fault, reverse }))))("preflights all identities before changing any bytes ($fault, reverse=$reverse)", async ({ fault, reverse }) => {
    const f = await transactionFixture();
    const expected = new Map(f.snapshots.map(snapshot => [snapshot.identity, snapshot]));
    if (fault === "cas-mismatch") await f.registry.bump(f.ids[1]!);
    const before = await f.bytes();
    const save = vi.fn(async () => undefined);
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (fault === "unavailable" && args[0] === f.paths[1] && args[1] === "r") throw Object.assign(new Error("synthetic later read failure"), { code: "EIO" });
      return open(...args);
    });
    const releaseOther = fault === "held-lock" ? await lockfile.lock(f.paths[1]!, { realpath: false, retries: 0 }) : undefined;
    let error: unknown;
    try {
      await f.registry.revoke(reverse ? f.ids.toReversed() : f.ids, save, fault === "cas-mismatch" ? expected : undefined).catch(value => { error = value; });
    } finally { spy.mockRestore(); await releaseOther?.(); }
    expect(await f.bytes()).toEqual(before);
    expect(error).toMatchObject({ code: fault === "unavailable" ? "MCP_AUTHORIZATION_UNAVAILABLE" : fault === "held-lock" ? "MCP_AUTHORIZATION_UPDATING" : "MCP_AUTHORIZATION_CHANGED" });
    expect(save).not.toHaveBeenCalled();
    await f.expectReleased();
  });

  it.each((["missing", "corrupt"] as const).flatMap(state => [false, true].map(compare => ({ state, compare }))))("recovers known $state data only without a forbidden expected generation (compare=$compare)", async ({ state, compare }) => {
    const f = await transactionFixture();
    if (state === "missing") await fs.unlink(f.paths[1]!);
    else await writeFile(f.paths[1]!, "{torn");
    const bytes = () => Promise.all(f.paths.map(path => readFile(path, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    })));
    const before = await bytes();
    const save = vi.fn(async (next: ReadonlyMap<string, typeof f.snapshots[number]>) => next);
    if (compare) {
      await expect(f.registry.revoke(f.ids, save, new Map(f.snapshots.map(snapshot => [snapshot.identity, snapshot])))).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_CHANGED" });
      expect(await bytes()).toEqual(before);
      expect(save).not.toHaveBeenCalled();
    } else {
      const next = await f.registry.revoke(f.ids, save);
      expect(next.get(f.ids[1]!)?.generation.epoch).not.toBe(f.snapshots[1]!.generation.epoch);
      expect(save).toHaveBeenCalledTimes(1);
    }
    await f.expectReleased();
  });

  it("holds and validates the complete deduplicated set before one successful callback", async () => {
    const f = await transactionFixture(3);
    const before = await f.bytes();
    const expected = new Map(f.snapshots.map(snapshot => [snapshot.identity, snapshot]));
    const save = vi.fn(async (next: ReadonlyMap<string, typeof f.snapshots[number]>) => {
      expect([...next.keys()]).toEqual(f.ids);
      for (const id of f.ids) {
        expect(await f.registry.current(next.get(id)!)).toBe(false);
        expect(JSON.parse(await readFile(join(f.registry.directory, `${id}.json`), "utf8"))).toEqual(next.get(id));
      }
      return next;
    });
    // Third identity participates only through CAS and must not be rewritten.
    const committed = await f.registry.revoke([f.ids[1]!, f.ids[0]!, f.ids[1]!], save, expected);
    expect(save).toHaveBeenCalledTimes(1);
    expect((await f.bytes())[2]).toBe(before[2]);
    for (const snapshot of f.snapshots.slice(0, 2)) expect(committed.get(snapshot.identity)?.generation).toEqual({ ...snapshot.generation, counter: snapshot.generation.counter + 1 });
    expect(committed.get(f.ids[2]!)).toEqual(f.snapshots[2]);
    for (const snapshot of committed.values()) expect(await f.registry.current(snapshot)).toBe(true);
    await f.expectReleased();
  });

  it("keeps all committed revocations when the external callback fails", async () => {
    const f = await transactionFixture();
    const failure = new Error("synthetic external persistence failure");
    const save = vi.fn(async () => { throw failure; });
    await expect(f.registry.revoke(f.ids, save)).rejects.toBe(failure);
    expect(save).toHaveBeenCalledTimes(1);
    for (const snapshot of f.snapshots) {
      expect(await f.registry.current(snapshot)).toBe(false);
      expect((await f.registry.read(snapshot.identity))?.generation).toEqual({ ...snapshot.generation, counter: snapshot.generation.counter + 1 });
    }
    await f.expectReleased();
  });

  it("does not roll back an earlier rename when a later write fails, and never calls the callback", async () => {
    const f = await transactionFixture();
    const before = await f.bytes();
    const save = vi.fn(async () => undefined);
    const failure = Object.assign(new Error("synthetic later rename failure"), { code: "EIO" });
    const rename = fs.rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (args[1] === f.paths[1]) throw failure;
      return rename(...args);
    });
    try { await expect(f.registry.revoke(f.ids, save)).rejects.toBe(failure); }
    finally { spy.mockRestore(); }
    const after = await f.bytes();
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(await f.registry.current(f.snapshots[0]!)).toBe(false);
    expect(await f.registry.current(f.snapshots[1]!)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect((await fs.readdir(f.registry.directory)).some(name => name.endsWith(".tmp"))).toBe(false);
    await f.expectReleased();
  });

  it.each(["success", "callback", "write"] as const)("attempts every release and preserves the proper error after %s", async outcome => {
    const f = await transactionFixture();
    const releaseFailure = new Error("synthetic release failure");
    const operationFailure = new Error("synthetic operation failure");
    const attempted: string[] = [];
    const lock = lockfile.lock;
    const locks = vi.spyOn(lockfile, "lock").mockImplementation(async (...args) => {
      const release = await lock(...args);
      return async () => {
        attempted.push(args[0]);
        await release();
        if (args[0] === f.paths[1]) throw releaseFailure;
      };
    });
    const rename = fs.rename;
    const writes = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (outcome === "write" && args[1] === f.paths[1]) throw operationFailure;
      return rename(...args);
    });
    const save = vi.fn(async () => {
      if (outcome === "callback") throw operationFailure;
    });
    try {
      await expect(f.registry.revoke(f.ids, save)).rejects.toBe(outcome === "success" ? releaseFailure : operationFailure);
    } finally {
      locks.mockRestore();
      writes.mockRestore();
    }
    expect(attempted).toEqual(f.paths.toReversed());
    expect(save).toHaveBeenCalledTimes(outcome === "write" ? 0 : 1);
    expect(await f.registry.current(f.snapshots[0]!)).toBe(false);
    expect(await f.registry.current(f.snapshots[1]!)).toBe(outcome === "write");
    await f.expectReleased();
  });

  it("does not wait for a contended writer and treats its cache snapshots as stale", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const release = await lockfile.lock(join(registry.directory, `${id}.json`), { realpath: false, retries: 0 });
    try {
      await expect(registry.bump(id)).rejects.toThrow("being updated");
      await expect(registry.establish(id)).rejects.toThrow("being updated");
      expect(await registry.current(snapshot)).toBe(false);
    } finally { await release(); }
    expect(await registry.current(await registry.bump(id))).toBe(true);
  });
});

describe("the live guard's three answers", () => {
  const blockEventLoop = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* a cold worker loading its engine */ } };

  it("answers current when a read is starved past its deadline by a blocked event loop", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const path = join(registry.directory, `${id}.json`);
    const open = fs.open;
    let blocked = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === path && args[1] === "r" && blocked++ === 0) blockEventLoop(150);
      return open(...args);
    });
    try {
      expect(await registry.check(snapshot)).toBe("current");
    } finally { spy.mockRestore(); }
    expect(blocked).toBeGreaterThanOrEqual(2);
  });

  it("answers unknown, never stale, when the record stays unreadable, and retries for about two seconds", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const path = join(registry.directory, `${id}.json`);
    const open = fs.open;
    let reads = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === path && args[1] === "r") { reads++; throw Object.assign(new Error("synthetic"), { code: "EIO" }); }
      return open(...args);
    });
    const started = Date.now();
    try {
      expect(await registry.check(snapshot)).toBe("unknown");
    } finally { spy.mockRestore(); }
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(await registry.check(snapshot)).toBe("current");
  });

  it("answers stale only for a real revocation: a new generation or a missing record", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const next = await registry.bump(id);
    expect(await registry.check(snapshot)).toBe("stale");
    expect(await registry.check(next)).toBe("current");
    await rm(join(registry.directory, `${id}.json`));
    expect(await registry.check(next)).toBe("stale");
  });
});
