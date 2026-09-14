/**
 * The boundary, end to end (RP-13).
 *
 * Three real callers against one real host:
 *
 * - the app shell or a terminal: a loopback socket with no browser origin;
 * - a page this host serves: the same socket with its own `Origin`;
 * - a paired device: a Noise_KK session through a stubbed relay, exactly as a
 *   phone would reach it.
 *
 * No credentials anywhere: the keys are generated for the test, and the relay
 * is the same 60-line stub the relay client's own tests use, which is what
 * lets this assert what the relay saw — ciphertext, and not one method name.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { channelIdFor, fromUtf8, nobleBackend, utf8 } from "@lasercode/crypto";
import { ErrorCodes, PRODUCT_NAME, PRODUCT_VERSION, type EnvironmentDescriptor, type JsonRpcMessage } from "@lasercode/protocol";
import { HostServer } from "../src/server.js";
import { Phone, StubRelay, until } from "./relay-stub.js";

interface Answer {
  result?: unknown;
  error?: { code: number; message: string };
}

/** A local client, with or without the browser `Origin` a page always sends. */
class LocalClient {
  private id = 0;
  private readonly pending = new Map<number, (message: Answer) => void>();
  readonly notifications: JsonRpcMessage[] = [];
  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as JsonRpcMessage & { id?: number };
      if ("method" in message) this.notifications.push(message);
      if (typeof message.id === "number") this.pending.get(message.id)?.(message as Answer);
    });
  }

  static async connect(url: string, origin?: string): Promise<LocalClient> {
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`, origin ? { origin } : {});
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new LocalClient(socket);
  }

  request(method: string, params: unknown = {}): Promise<Answer> {
    const id = ++this.id;
    return new Promise<Answer>((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function base(): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-access-e2e-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the boundary over a real socket", () => {
  it("tells each local caller what it is, and keeps the shell's own methods to the shell", async () => {
    const dir = base();
    const host = new HostServer({
      agentDir: join(dir, "agent"),
      sessionDir: join(dir, "sessions"),
      stateDir: join(dir, "state"),
      logFile: false,
      log: () => {},
    });
    cleanup.push(() => host.close());
    const { url, port } = await host.listen();

    const shell = await LocalClient.connect(url);
    const page = await LocalClient.connect(url, `http://127.0.0.1:${port}`);
    cleanup.push(() => {
      shell.close();
      page.close();
    });

    const shellDescriptor = ((await shell.request("environment/describe")).result as { environment: EnvironmentDescriptor }).environment;
    expect(shellDescriptor.actor.class).toBe("local_app");
    expect(shellDescriptor.version).toBe(PRODUCT_VERSION);
    expect(shellDescriptor.environmentKey).toMatch(/^e1\.[A-Za-z0-9_-]{22}$/);
    expect(shellDescriptor.environmentKey).toBe(host.revisions.environmentKey);
    expect(shellDescriptor.deployment).toBe("local");
    expect(shellDescriptor.localOnly).toEqual([]);
    // The one capability this host really does not have: it was started
    // without a log store.
    expect(shellDescriptor.capabilities.logs).toBe(false);
    expect(shellDescriptor.capabilities.durableReads).toBe(true);

    const pageDescriptor = ((await page.request("environment/describe")).result as { environment: EnvironmentDescriptor }).environment;
    expect(pageDescriptor.actor.class).toBe("local_browser");
    expect(pageDescriptor.localOnly).toContain("pi/host/environment");

    // The shell may hand an environment down; the page may not, and is told why.
    expect((await shell.request("pi/host/environment", { variables: { SYNTHETIC_FIXTURE: "value" } })).result).toEqual({ applied: 1 });
    const refused = await page.request("pi/host/environment", { variables: { SYNTHETIC_FIXTURE: "value" } });
    expect(refused.error?.code).toBe(ErrorCodes.Unsupported);
    expect(refused.error?.message).toContain("local app or terminal");

    // Both may read the redacted inventory the host built itself (RP-3).
    expect((await page.request("resource/snapshot", { refresh: false })).result).toBeDefined();
  });

  it("refuses to start at all when a policy it was given cannot be honoured", () => {
    const dir = base();
    // Constructing the host is what throws, which is before it listens and
    // before a socket could exist: a host told to narrow must never come up
    // wider than it was asked to be.
    expect(() => new HostServer({
      stateDir: join(dir, "state"),
      logFile: false,
      policy: { remote: { scopes: ["root"] } } as never,
      log: () => {},
    })).toThrow(/cannot be used/);

    const stateDir = join(dir, "narrowed");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "policy.json"), JSON.stringify({ remote: { scopes: ["everything"] } }));
    expect(() => new HostServer({ stateDir, logFile: false, log: () => {} })).toThrow(/cannot be used/);

    // A usable file narrows the host that comes up.
    writeFileSync(join(stateDir, "policy.json"), JSON.stringify({ remote: { scopes: ["handshake", "read"] } }));
    const host = new HostServer({ stateDir, logFile: false, log: () => {} });
    cleanup.push(() => host.close());
    expect(host.access.policy.remote.scopes).toEqual(["handshake", "read"]);
  });
});

describe("the boundary through the relay", () => {
  it("answers a paired device by its grant, refuses what is local, and leaves the relay with ciphertext", async () => {
    const dir = base();
    const relay = new StubRelay();
    const relayUrl = await relay.listen();
    cleanup.push(() => relay.close());

    const desktop = await nobleBackend.generateKeyPair();
    const device = await nobleBackend.generateKeyPair();
    const channelId = await channelIdFor(desktop, device.publicKey, { backend: nobleBackend });

    const host = new HostServer({
      agentDir: join(dir, "agent"),
      sessionDir: join(dir, "sessions"),
      stateDir: join(dir, "state"),
      logFile: false,
      log: () => {},
      // The device is granted reading and answering only: no settings, no
      // diagnostics, no starting or stopping work.
      relay: {
        url: relayUrl,
        staticKeyPair: desktop,
        devices: [
          {
            id: "test-device",
            name: "test phone",
            publicKey: device.publicKey,
            grants: { scopes: ["handshake", "read", "approval"] },
          },
        ],
      },
    });
    cleanup.push(() => host.close());
    await host.listen();

    const phone = await Phone.attach(relayUrl, channelId, device, desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();

    const described = await phone.request({ id: 1, method: "environment/describe" });
    const descriptor = (described.result as { environment: EnvironmentDescriptor }).environment;
    expect(descriptor.actor.class).toBe("paired_device");
    expect(descriptor.actor.id).toMatch(/^d1\.[A-Za-z0-9_-]{22}$/);
    expect(descriptor.scopes).toEqual(["handshake", "read", "approval"]);
    expect(descriptor.capabilities.diagnostics).toBe(false);
    expect(descriptor.localOnly).toContain("resource/report");
    expect(descriptor.environmentKey).toBe(host.revisions.environmentKey);

    // Reading is granted.
    expect((await phone.request({ id: 2, method: "pi/session/list" })).result).toEqual({ sessions: [] });

    // Settings and diagnostics are not, and the refusal is a sentence.
    const settings = await phone.request({ id: 3, method: "pi/prefs/set", params: { namespace: "theme", value: {} } });
    expect(settings.error?.code).toBe(ErrorCodes.Unsupported);
    expect(settings.error?.message).toContain("change settings");
    const snapshot = await phone.request({ id: 4, method: "resource/snapshot", params: {} });
    expect(snapshot.error?.message).toContain("read diagnostics");

    // Local by nature, and refused with the sentence it has always had.
    const report = await phone.request({ id: 5, method: "resource/report", params: {} });
    expect(report.error?.message).toContain("running on this machine");

    // Nothing the frames carried is readable by the relay: it forwarded
    // padded ciphertext, and none of the method names appears in any frame.
    expect(relay.forwarded.length).toBeGreaterThan(5);
    const seen = relay.forwarded.map((frame) => Buffer.from(frame).toString("latin1")).join("\u0000");
    for (const needle of ["environment/describe", "resource/report", "pi/prefs/set", "paired_device", descriptor.environmentKey, descriptor.actor.id]) {
      expect(seen, needle).not.toContain(needle);
    }
    // And the same bytes really do decrypt on the far side, so this is not a
    // test of an empty channel.
    expect(phone.messages.length).toBeGreaterThan(4);
  }, 20_000);

  it("sends a narrowed device only the notifications its scopes cover", async () => {
    const dir = base();
    const relay = new StubRelay();
    const relayUrl = await relay.listen();
    cleanup.push(() => relay.close());

    const desktop = await nobleBackend.generateKeyPair();
    const device = await nobleBackend.generateKeyPair();
    const channelId = await channelIdFor(desktop, device.publicKey, { backend: nobleBackend });

    const host = new HostServer({
      agentDir: join(dir, "agent"),
      sessionDir: join(dir, "sessions"),
      stateDir: join(dir, "state"),
      logFile: false,
      log: () => {},
      relay: {
        url: relayUrl,
        staticKeyPair: desktop,
        devices: [{ id: "test-device", name: "test phone", publicKey: device.publicKey, grants: { scopes: ["handshake", "read"] } }],
      },
    });
    cleanup.push(() => host.close());
    await host.listen();

    const phone = await Phone.attach(relayUrl, channelId, device, desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();
    // The relay client only forwards once it is attached; one request proves it.
    await phone.request({ id: 1, method: "pi/host/version" });

    host.notify("pi/session/seen", { path: "/sessions/a.jsonl" });
    host.notify("resource/refresh_request", {});
    host.notify("pi/logs/append", { entries: [] });

    await until(
      () => phone.messages.some((message) => (message as { method?: string }).method === "pi/session/seen"),
      4000,
      "the notification a reader may hear",
    );
    const methods = phone.messages.map((message) => (message as { method?: string }).method).filter(Boolean);
    expect(methods).toContain("pi/session/seen");
    expect(methods).not.toContain("resource/refresh_request");
    expect(methods).not.toContain("pi/logs/append");
  }, 20_000);
});
