import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXPLICIT_SYNC_GLOBAL,
  NVIDIA_VENDOR,
  connectedGpuVendors,
  linuxDisplayDecision,
  type LinuxDisplayFacts,
} from "../src/linux-display.js";
import { parseWaylandEvents, registryAndSyncRequests, waylandSocketPath } from "../src/wayland-globals.js";

/**
 * The bug this guards against is invisible in any test that can run here: a
 * window on an NVIDIA GPU showing a frame from a moment ago, so what you click
 * is not what you see. What can be tested is the decision — that the software
 * fallback lands on exactly the machines that would hit it and nowhere else.
 */
const wayland = { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000" };
const facts = (over: Partial<LinuxDisplayFacts>): LinuxDisplayFacts => ({
  argv: [],
  env: wayland,
  gpuVendors: ["0x8086"],
  waylandGlobals: ["wl_compositor", EXPLICIT_SYNC_GLOBAL],
  ...over,
});
const names = (d: ReturnType<typeof linuxDisplayDecision>) => d.switches.map((s) => s.join("="));

describe("linuxDisplayDecision", () => {
  it("asks for native Wayland and explicit sync on a Wayland session", () => {
    const d = linuxDisplayDecision(facts({}));
    expect(d.wayland).toBe(true);
    expect(names(d)).toEqual(["ozone-platform-hint=auto", "enable-features=WaylandLinuxDrmSyncobj"]);
  });

  it("never switches the GPU off, whatever the compositor lacks", () => {
    // The software-compositing fallback was removed with its theory: the
    // "dead button" it was meant to fix was a preload that failed to load.
    const d = linuxDisplayDecision(facts({ gpuVendors: [NVIDIA_VENDOR], waylandGlobals: ["wl_compositor"] }));
    expect(names(d)).toEqual(["ozone-platform-hint=auto", "enable-features=WaylandLinuxDrmSyncobj"]);
    expect(d.notes.join("\n")).toContain("NVIDIA, compositor no explicit sync");
  });

  it("names the GPU and the compositor, so a rendering report starts with facts", () => {
    const d = linuxDisplayDecision(facts({ gpuVendors: [NVIDIA_VENDOR] }));
    expect(d.notes.join("\n")).toContain("NVIDIA, compositor explicit sync");
    expect(names(d)).toContain("enable-features=WaylandLinuxDrmSyncobj");
  });

  it("says so when the compositor could not be asked", () => {
    const d = linuxDisplayDecision(facts({ gpuVendors: [NVIDIA_VENDOR], waylandGlobals: undefined }));
    expect(d.notes.join("\n")).toContain("compositor unknown");
  });

  it("leaves an X11 session exactly as Chromium would", () => {
    const d = linuxDisplayDecision(facts({ env: { DISPLAY: ":0" }, gpuVendors: [NVIDIA_VENDOR], waylandGlobals: undefined }));
    expect(d.wayland).toBe(false);
    expect(names(d)).toEqual(["ozone-platform-hint=auto"]);
  });

  it("respects a platform the person chose", () => {
    const x11 = linuxDisplayDecision(facts({ argv: ["--ozone-platform=x11"], gpuVendors: [NVIDIA_VENDOR] }));
    expect(x11.wayland).toBe(false);
    expect(names(x11)).toEqual([]);
    const forced = linuxDisplayDecision(
      facts({ argv: ["--ozone-platform=wayland"], env: { DISPLAY: ":0" }, gpuVendors: [NVIDIA_VENDOR], waylandGlobals: [] }),
    );
    expect(forced.wayland).toBe(true);
    expect(names(forced)).toEqual(["enable-features=WaylandLinuxDrmSyncobj"]);
  });

  it("respects a feature list the person passed", () => {
    const d = linuxDisplayDecision(
      facts({ argv: ["--enable-features=Foo"], gpuVendors: [NVIDIA_VENDOR], waylandGlobals: [] }),
    );
    expect(names(d)).toEqual(["ozone-platform-hint=auto"]);
  });
});

describe("Wayland wire", () => {
  const global = (name: number, iface: string, version: number): Buffer => {
    const text = Buffer.from(iface + "\0", "utf8");
    const padded = Math.ceil(text.length / 4) * 4;
    const size = 8 + 4 + 4 + padded + 4;
    const b = Buffer.alloc(size);
    b.writeUInt32LE(2, 0);
    b.writeUInt32LE((size << 16) | 0, 4);
    b.writeUInt32LE(name, 8);
    b.writeUInt32LE(text.length, 12);
    text.copy(b, 16);
    b.writeUInt32LE(version, 16 + padded);
    return b;
  };
  const done = (): Buffer => {
    const b = Buffer.alloc(12);
    b.writeUInt32LE(3, 0);
    b.writeUInt32LE((12 << 16) | 0, 4);
    b.writeUInt32LE(7, 8);
    return b;
  };

  it("encodes get_registry and sync as libwayland would", () => {
    const m = registryAndSyncRequests();
    expect(m.length).toBe(24);
    expect([m.readUInt32LE(0), m.readUInt32LE(4) >>> 16, m.readUInt32LE(4) & 0xffff, m.readUInt32LE(8)]).toEqual([1, 12, 1, 2]);
    expect([m.readUInt32LE(12), m.readUInt32LE(16) >>> 16, m.readUInt32LE(16) & 0xffff, m.readUInt32LE(20)]).toEqual([1, 12, 0, 3]);
  });

  it("reads globals across split chunks and stops at the sync callback", () => {
    const stream = Buffer.concat([global(1, "wl_compositor", 6), global(2, EXPLICIT_SYNC_GLOBAL, 1), done()]);
    // The first global is 36 bytes; cut four bytes into the second one.
    const first = parseWaylandEvents(stream.subarray(0, 40));
    expect(first.globals).toEqual(["wl_compositor"]);
    expect(first.done).toBe(false);
    const second = parseWaylandEvents(Buffer.concat([first.rest, stream.subarray(40)]), first.globals);
    expect(second.globals).toEqual(["wl_compositor", EXPLICIT_SYNC_GLOBAL]);
    expect(second.done).toBe(true);
    expect(second.rest.length).toBe(0);
  });

  it("finds the socket the way libwayland does", () => {
    expect(waylandSocketPath(wayland)).toBe("/run/user/1000/wayland-0");
    expect(waylandSocketPath({ WAYLAND_DISPLAY: "/tmp/w", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/tmp/w");
    expect(waylandSocketPath({})).toBeUndefined();
  });
});

describe("connectedGpuVendors", () => {
  it("reports only the GPUs with a display attached", () => {
    const root = mkdtempSync(join(tmpdir(), "drm-"));
    const connector = (card: string, name: string, status: string, vendor: string) => {
      mkdirSync(join(root, card, "device"), { recursive: true });
      writeFileSync(join(root, card, "device", "vendor"), vendor + "\n");
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "status"), status + "\n");
      // sysfs links a connector's `device` to its card; emulate the link with a copy.
      mkdirSync(join(root, name, "device", "device"), { recursive: true });
      writeFileSync(join(root, name, "device", "device", "vendor"), vendor + "\n");
    };
    connector("card0", "card0-eDP-1", "disconnected", "0x8086");
    connector("card1", "card1-HDMI-A-1", "connected", "0x10DE");
    expect(connectedGpuVendors(root)).toEqual([NVIDIA_VENDOR]);
  });
});
