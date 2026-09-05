/**
 * PackageService (M10-T5): the parts where a wrong answer is silent.
 *
 * Version resolution decides what gets pinned into a settings file that the
 * agent reproduces installs from; a resolver that lets `^1.0.0` pick a `2.0.0`
 * prerelease, or that turns a bare name into a "path does not exist", ships
 * the wrong thing without anything failing. The install path's proof — the
 * manifest on disk carries the pinned version, or nothing is kept — is the
 * supply-chain rule, so it is exercised end to end against a fake worker.
 */
import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMethod, ClientRequests, PackageEntry } from "@lasercode/protocol";
import {
  PackageService,
  browseDirectories,
  describeInstallFailure,
  detectInstallRuntime,
  maxSatisfying,
  parseNpmSource,
  resolveFromPackument,
  satisfies,
  type Packument,
} from "../src/packages.js";

describe("parseNpmSource", () => {
  const never = () => false;
  it("reads npm: sources with scopes, versions, ranges and tags", () => {
    expect(parseNpmSource("npm:pi-web-access", never)).toEqual({ name: "pi-web-access" });
    expect(parseNpmSource("npm:pi-web-access@1.2.3", never)).toEqual({ name: "pi-web-access", spec: "1.2.3" });
    expect(parseNpmSource("npm:@scope/name@^1", never)).toEqual({ name: "@scope/name", spec: "^1" });
    expect(parseNpmSource("npm:@scope/name", never)).toEqual({ name: "@scope/name" });
    expect(parseNpmSource("npm:name@next", never)).toEqual({ name: "name", spec: "next" });
  });
  it("takes a bare name as npm when it is not a path on disk, and leaves git and paths alone", () => {
    expect(parseNpmSource("pi-web-access", never)).toEqual({ name: "pi-web-access" });
    expect(parseNpmSource("pi-web-access", () => true)).toBeUndefined();
    expect(parseNpmSource("./ext", never)).toBeUndefined();
    expect(parseNpmSource("~/ext", never)).toBeUndefined();
    expect(parseNpmSource("/abs/ext", never)).toBeUndefined();
    expect(parseNpmSource("https://github.com/a/b", never)).toBeUndefined();
    expect(parseNpmSource("git@github.com:a/b.git", never)).toBeUndefined();
    expect(parseNpmSource("owner/repo", never)).toBeUndefined();
    expect(parseNpmSource("Not A Name", never)).toBeUndefined();
    expect(parseNpmSource("", never)).toBeUndefined();
  });
});

describe("semver subset", () => {
  it("handles caret, tilde, x-ranges, comparators, hyphens and alternatives", () => {
    expect(satisfies("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.9.9", "1")).toBe(true);
    expect(satisfies("1.2.7", "1.2.x")).toBe(true);
    expect(satisfies("1.3.0", "1.2.x")).toBe(false);
    expect(satisfies("5.0.0", "*")).toBe(true);
    expect(satisfies("1.5.0", ">=1.2 <2")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2 <2")).toBe(false);
    expect(satisfies("1.2.3", "1.0.0 - 1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.0.0 - 1.2.3")).toBe(false);
    expect(satisfies("1.2.4", "1.0 - 1.2")).toBe(true);
    expect(satisfies("3.1.0", "^1 || ^3")).toBe(true);
    expect(satisfies("2.1.0", "^1 || ^3")).toBe(false);
  });
  it("never lets a prerelease through a range that did not ask for one", () => {
    expect(satisfies("2.0.0-beta.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.1.0-rc.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0-rc.2", ">=1.0.0-rc.1")).toBe(true);
    expect(maxSatisfying(["1.0.0", "1.1.0", "1.2.0-beta.1", "2.0.0"], "^1")).toBe("1.1.0");
    expect(maxSatisfying(["1.0.0", "1.0.1"], "^2")).toBeUndefined();
  });
});

const doc: Packument = {
  name: "pi-web-access",
  "dist-tags": { latest: "1.4.2", next: "2.0.0-beta.1" },
  versions: {
    "1.3.0": { version: "1.3.0", dist: { tarball: "https://r/1.3.0.tgz", integrity: "sha512-a" } },
    "1.4.2": { version: "1.4.2", dist: { tarball: "https://r/1.4.2.tgz", integrity: "sha512-b" } },
    "2.0.0-beta.1": { version: "2.0.0-beta.1", dist: { tarball: "https://r/2.tgz", integrity: "sha512-c" } },
  },
};

describe("resolveFromPackument", () => {
  it("pins latest, an exact version, a tag, or the highest release in a range", () => {
    expect(resolveFromPackument(doc, undefined)).toMatchObject({ version: "1.4.2", integrity: "sha512-b", latest: "1.4.2" });
    expect(resolveFromPackument(doc, "1.3.0")).toMatchObject({ version: "1.3.0", integrity: "sha512-a" });
    expect(resolveFromPackument(doc, "next")).toMatchObject({ version: "2.0.0-beta.1" });
    expect(resolveFromPackument(doc, "^1.0.0")).toMatchObject({ version: "1.4.2" });
  });
  it("refuses what does not exist, by name", () => {
    expect(() => resolveFromPackument(doc, "9.9.9")).toThrow(/no release 9\.9\.9/);
    expect(() => resolveFromPackument(doc, "^3")).toThrow(/no release of pi-web-access matches \^3/);
    expect(() => resolveFromPackument(doc, "what ever")).toThrow(/not a version, a range or a tag/);
  });
});

describe("describeInstallFailure", () => {
  it("turns package-manager noise into one actionable sentence", () => {
    const e404 = "Could not install npm:nope@1.0.0: npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope\nnpm error 404 'nope@1.0.0' is not in this registry.";
    expect(describeInstallFailure("nope", e404)).toBe("Could not install nope: no extension with that name exists. Check the spelling.");
    expect(describeInstallFailure("x", "npm error code ENOTFOUND\nnpm error network request failed")).toMatch(/could not be reached/);
    expect(describeInstallFailure("x", "npm error code ETARGET\nNo matching version found for x@1.9.0")).toBe("Could not install x: version 1.9.0 does not exist.");
    expect(describeInstallFailure("x", "Project is not trusted; refusing to access project package storage")).toMatch(/not trusted yet/);
    const long = describeInstallFailure("x", `npm ERR! ${"y".repeat(400)}`);
    expect(long.length).toBeLessThan(240);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("detectInstallRuntime", () => {
  const exists = (set: Set<string>) => (p: string) => set.has(p);
  const node = `/opt/${PRODUCT_NAME}/resources/runtime/node`;
  /** What `build/before-pack.cjs` stages: the package manager beside the pinned Node. */
  const packagedNpm = `/opt/${PRODUCT_NAME}/resources/runtime/npm/bin/npm-cli.js`;

  it("prefers the configured installer, then the packaged layout, then a stock Node's", () => {
    const configured = detectInstallRuntime({ execPath: node, env: { [ENV.npmCli]: "/opt/npm/npm-cli.js", PATH: "" }, exists: exists(new Set(["/opt/npm/npm-cli.js"])) });
    expect(configured).toMatchObject({ ready: true, npm: { source: "configured" }, command: [node, "/opt/npm/npm-cli.js", "--strict-allow-scripts"] });
    const stock = detectInstallRuntime({ execPath: "/opt/node/bin/node", env: { PATH: "" }, exists: exists(new Set(["/opt/node/lib/node_modules/npm/bin/npm-cli.js"])) });
    expect(stock).toMatchObject({ ready: true, npm: { source: "bundled" }, command: ["/opt/node/bin/node", "/opt/node/lib/node_modules/npm/bin/npm-cli.js", "--strict-allow-scripts"] });
  });

  /**
   * The case the shell's own installer variable does not reach: a person runs
   * `laser up` (or `laser doctor`) in a terminal first, and the window then
   * *adopts* that host. Both run on the same bundled Node, so the sibling
   * lookup is what makes Settings able to install for either of them.
   */
  it("finds the package manager staged beside the bundled Node, with no environment at all", () => {
    const found = detectInstallRuntime({ execPath: node, env: { PATH: "/usr/bin" }, exists: exists(new Set([packagedNpm, "/usr/bin/npm"])) });
    expect(found).toMatchObject({ ready: true, npm: { path: packagedNpm, source: "bundled" }, command: [node, packagedNpm, "--strict-allow-scripts"] });
  });

  it("never falls back to the machine's own npm in a packaged install", () => {
    const packaged = detectInstallRuntime({ execPath: node, env: { PATH: "/usr/local/bin:/usr/bin" }, exists: exists(new Set(["/usr/bin/npm"])), packaged: true });
    expect(packaged.ready).toBe(false);
    expect(packaged.command).toBeUndefined();
  });

  it("does fall back to PATH on a development machine, where that is the only npm there is", () => {
    const onPath = detectInstallRuntime({ execPath: node, env: { PATH: "/usr/local/bin:/usr/bin" }, exists: exists(new Set(["/usr/bin/npm"])), packaged: false });
    expect(onPath).toMatchObject({ ready: true, npm: { path: "/usr/bin/npm", source: "path" }, command: ["/usr/bin/npm", "--strict-allow-scripts"] });
  });

  it("says so when there is none", () => {
    const none = detectInstallRuntime({ execPath: node, env: { PATH: "/usr/bin" }, exists: () => false });
    expect(none.ready).toBe(false);
    expect(none.reason).toMatch(new RegExp(`Reinstall ${PRODUCT_NAME}`));
    expect(none.command).toBeUndefined();
  });

  /**
   * npm 11 runs an unreviewed `postinstall` with a notice on a stream this UI
   * never shows. Settings installs straight from a registry search, so that is
   * a stranger's code one click from the person's home directory.
   */
  it("always turns an unreviewed install script into a hard failure", () => {
    for (const runtime of [
      detectInstallRuntime({ execPath: node, env: { [ENV.npmCli]: "/n.js", PATH: "" }, exists: exists(new Set(["/n.js"])) }),
      detectInstallRuntime({ execPath: node, env: { PATH: "" }, exists: exists(new Set([packagedNpm])) }),
      detectInstallRuntime({ execPath: node, env: { PATH: "/usr/bin" }, exists: exists(new Set(["/usr/bin/npm"])), packaged: false }),
    ]) {
      expect(runtime.command).toContain("--strict-allow-scripts");
    }
  });
});

describe("PackageService.install", () => {
  let base: string;
  let agentDir: string;
  let cwd: string;
  let calls: Array<{ method: string; params: unknown }>;
  /** What the fake worker does when told to install: write a manifest, or fail. */
  let onInstall: (source: string) => void;
  let configured: string[];

  const fetchPackument = (async (url: string | URL | Request) => {
    const text = String(url);
    if (text.endsWith("/pi-web-access")) return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const forward = async <M extends ClientMethod>(_cwd: string, method: M, params: ClientRequests[M]["params"]) => {
    calls.push({ method, params });
    const list = (): PackageEntry[] =>
      configured.map((source) => ({
        source,
        scope: "user" as const,
        filtered: false,
        installedPath: join(agentDir, "npm", "node_modules", source.replace(/^npm:/, "").replace(/@\d.*$/, "")),
      }));
    if (method === "pi/packages/install") {
      const { source } = params as { source: string };
      onInstall(source);
      if (!configured.includes(source)) configured.push(source);
      return { packages: list() } as ClientRequests[M]["result"];
    }
    if (method === "pi/packages/list") return { packages: list() } as ClientRequests[M]["result"];
    throw new Error(`unexpected ${method}`);
  };

  const service = () =>
    new PackageService({
      agentDir,
      stateDir: join(base, "state"),
      forward,
      fetch: fetchPackument,
      env: { [ENV.npmCli]: join(base, "npm-cli.js"), PATH: "" },
      execPath: join(base, "node"),
      now: () => new Date("2026-09-05T12:00:00Z"),
    });

  const manifestDir = () => join(agentDir, "npm", "node_modules", "pi-web-access");
  const writeInstalledLock = (integrity: string) =>
    writeFileSync(
      join(agentDir, "npm", "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/pi-web-access": { integrity } } }),
    );

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-packages-`));
    agentDir = join(base, "agent");
    cwd = join(base, "project");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(base, "npm-cli.js"), "");
    calls = [];
    configured = [];
    onInstall = (source) => {
      const version = source.slice(source.lastIndexOf("@") + 1);
      mkdirSync(manifestDir(), { recursive: true });
      writeFileSync(join(manifestDir(), "package.json"), JSON.stringify({ name: "pi-web-access", version }));
      // npm records what it *actually* fetched in the prefix's own lock. That
      // is the only file that can contradict the host's registry answer, so
      // the fake worker writes it the way npm does.
      writeInstalledLock(version === "1.4.2" ? "sha512-b" : "sha512-a");
    };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("resolves a bare name to the newest release, sends an exact pin down, and records it", async () => {
    const result = await service().install({ cwd, source: "pi-web-access", scope: "user" });
    expect(calls.find((c) => c.method === "pi/packages/install")?.params).toEqual({ cwd, source: "npm:pi-web-access@1.4.2", scope: "user" });
    expect(result.record).toMatchObject({ name: "pi-web-access", version: "1.4.2", integrity: "sha512-b", scope: "user", source: "npm:pi-web-access@1.4.2" });
    expect(result.packages[0]).toMatchObject({ name: "pi-web-access", version: "1.4.2", pinnedVersion: "1.4.2", integrity: "sha512-b", type: "npm" });
    const lock = JSON.parse(readFileSync(join(base, "state", "packages.lock.json"), "utf8")) as { records: unknown[] };
    expect(lock.records).toHaveLength(1);
  });

  /**
   * The version string matching proves nothing about the bytes: npm re-resolves
   * the pinned spec through *its own* registry fetch, so a mirror, a proxy or
   * an `.npmrc` with a `registry=` line can hand back a different tarball for
   * the same version. The lock npm writes is the only thing that can say so.
   */
  it("refuses an install whose files are not the ones the registry published", async () => {
    const previous = onInstall;
    onInstall = (source) => {
      previous(source);
      writeInstalledLock("sha512-someone-elses-tarball");
    };
    await expect(service().install({ cwd, source: "pi-web-access", scope: "user" })).rejects.toThrow(/not the ones the package registry published/);
    expect(existsSync(manifestDir())).toBe(false);
  });

  it("records no hash at all when npm left nothing to check against, rather than one it never checked", async () => {
    const previous = onInstall;
    onInstall = (source) => {
      previous(source);
      rmSync(join(agentDir, "npm", "package-lock.json"), { force: true });
    };
    const result = await service().install({ cwd, source: "pi-web-access", scope: "user" });
    expect(result.record?.version).toBe("1.4.2");
    expect(result.record?.integrity).toBeUndefined();
  });

  it("refuses to install anything before it touches the network when there is no installer", async () => {
    const none = new PackageService({ agentDir, forward, fetch: fetchPackument, env: { PATH: "" }, execPath: join(base, "node") });
    await expect(none.install({ cwd, source: "pi-web-access", scope: "user" })).rejects.toThrow(/cannot install extensions/);
    expect(calls).toHaveLength(0);
  });

  it("says in one sentence when the name does not exist, and forwards nothing", async () => {
    await expect(service().install({ cwd, source: "nope", scope: "user" })).rejects.toThrow("Could not install nope: no extension with that name exists. Check the spelling.");
    expect(calls).toHaveLength(0);
  });

  it("leaves nothing behind when the worker fails, and keeps what was already there", async () => {
    onInstall = () => {
      mkdirSync(manifestDir(), { recursive: true });
      writeFileSync(join(manifestDir(), "package.json"), "{");
      throw new Error("Could not install npm:pi-web-access@1.4.2: npm error code ENOTFOUND");
    };
    await expect(service().install({ cwd, source: "pi-web-access", scope: "user" })).rejects.toThrow(/could not be reached/);
    expect(existsSync(manifestDir())).toBe(false);

    // Now with an earlier version present: a failure must not delete it.
    mkdirSync(manifestDir(), { recursive: true });
    writeFileSync(join(manifestDir(), "package.json"), JSON.stringify({ name: "pi-web-access", version: "1.3.0" }));
    await expect(service().install({ cwd, source: "pi-web-access", scope: "user" })).rejects.toThrow();
    expect(existsSync(join(manifestDir(), "package.json"))).toBe(true);
  });

  it("rejects an install whose manifest is not the pinned version, and removes it", async () => {
    onInstall = () => {
      mkdirSync(manifestDir(), { recursive: true });
      writeFileSync(join(manifestDir(), "package.json"), JSON.stringify({ name: "pi-web-access", version: "1.3.0" }));
    };
    await expect(service().install({ cwd, source: "pi-web-access", scope: "user", version: "1.4.2" })).rejects.toThrow(/1\.4\.2 was expected but 1\.3\.0 was installed/);
    expect(existsSync(manifestDir())).toBe(false);
  });
});

describe("browseDirectories", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-browse-`));
    mkdirSync(join(base, "b-plain"));
    mkdirSync(join(base, "a-repo", ".git"), { recursive: true });
    mkdirSync(join(base, ".hidden"));
    writeFileSync(join(base, "file.txt"), "");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists visible directories, sorted, marking the ones that look like projects", () => {
    const listing = browseDirectories(base, "/home/someone");
    expect(listing.entries.map((e) => [e.name, e.project])).toEqual([
      ["a-repo", true],
      ["b-plain", false],
    ]);
    expect(listing.parent).toBe(join(base, ".."));
    expect(listing.home).toBe("/home/someone");
  });
  it("expands ~ and explains a folder it cannot open without a stack trace", () => {
    expect(browseDirectories("~", base).path).toBe(base);
    const missing = browseDirectories(join(base, "gone"));
    expect(missing.entries).toEqual([]);
    expect(missing.error).toBe('"gone" does not exist any more.');
    const file = browseDirectories(join(base, "file.txt"));
    expect(file.error).toBe('"file.txt" is a file, not a folder.');
  });
});
