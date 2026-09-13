import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostServer } from "../src/server.js";

let root: string;
let host: HostServer;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-static-cache-"));
  for (const name of ["agent", "sessions", "state", "ui/assets", "ui/fonts"]) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "ui", "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(root, "ui", "sw.js"), "// worker");
  writeFileSync(join(root, "ui", "assets", "index-DO2TU52U.js"), "export {};");
  writeFileSync(join(root, "ui", "assets", "index-CJNN6j6O.css"), "body{}");
  writeFileSync(join(root, "ui", "fonts", "inter-latin.woff2"), "font");
  host = new HostServer({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    stateDir: join(root, "state"),
    uiDir: join(root, "ui"),
    logFile: false,
  });
});

afterEach(async () => {
  await host.close();
  rmSync(root, { recursive: true, force: true });
});

describe("HostServer static caching", () => {
  it("marks Vite's hashed assets immutable and leaves everything else revalidated", async () => {
    const { url } = await host.listen();
    const header = async (path: string) => (await fetch(`${url}${path}`)).headers.get("cache-control");
    expect(await header("/assets/index-DO2TU52U.js")).toBe("public, max-age=31536000, immutable");
    expect(await header("/assets/index-CJNN6j6O.css")).toBe("public, max-age=31536000, immutable");
    // A new build must be noticed on the next navigation: no freshness hint.
    expect(await header("/")).toBeNull();
    expect(await header("/index.html")).toBeNull();
    expect(await header("/sw.js")).toBeNull();
    // Fonts carry no content hash in their names, so they are not immutable.
    expect(await header("/fonts/inter-latin.woff2")).toBeNull();
    // The SPA fallback serves index.html for an unknown route, unhinted.
    expect(await header("/assets/missing-DEADBEEF.js")).toBeNull();
  });
});
