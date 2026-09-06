/**
 * PackageService (M10-T5) and first-run state (M10-T6) — the host's half of
 * "extensions are installed from Settings, never from a terminal".
 *
 * The split is policy here, mechanism in the worker. The agent's own package
 * manager (inside the worker) knows how to lay a package out on disk and how
 * to write the settings entry that makes it load; nothing here re-implements
 * that. What the worker cannot do is what this file does:
 *
 *  - **Pin.** Every npm install goes to the worker as `npm:<name>@<exact>`.
 *    The host resolves "newest" (or a range someone typed) against the
 *    registry and turns it into one release, so the settings file — which is
 *    what the agent reproduces an install from — never contains a moving
 *    target. The record of what was installed, with the tarball integrity the
 *    registry declared for it, lives in `<stateDir>/packages.lock.json`.
 *  - **Verify.** After the worker reports success the manifest on disk must
 *    carry the version that was pinned, *and* the integrity npm recorded for
 *    what it installed must be the integrity the registry declared for that
 *    release — npm does its own metadata fetch, so the version string alone
 *    proves nothing about the bytes. Anything else is removed and reported. A
 *    failed install leaves nothing behind that was not there before, and a hash
 *    is only ever stored (and therefore only ever shown) once it was checked.
 *  - **Run without npm on PATH.** The packaged app ships a stock Node and the
 *    package manager out of the same verified archive. `runtime()` finds it
 *    beside that Node — for the host the shell spawned and for one a terminal
 *    `laser up` left running, which the shell adopts — and `npmCommand()` is
 *    what the worker is told to use, with `--strict-allow-scripts` so an
 *    unreviewed install script stops the install instead of running. A packaged
 *    build never reaches for the machine's own npm. When there is none, an
 *    install fails before it touches the network, with a sentence a person can
 *    act on.
 *  - **Browse.** A curated list and a live registry search, so a person can
 *    find an extension without knowing its name.
 *  - **First run.** `SetupService` keeps "has setup finished" on the host so it
 *    survives a quit and is the same from every device, and owns a directory
 *    with no project in it for the settings that exist before any project does.
 *
 * Only JSON and manifests are read here (AGENTS.md invariant 1): the host
 * still imports nothing from the agent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { ENV, ErrorCodes, PRODUCT_NAME, ProtocolError, type ClientMethod, type ClientRequests, type DirectoryEntry, type DirectoryListing, type PackageCatalogEntry, type PackageEntry, type PackageRecord, type PackageRuntimeInfo, type PackageScope, type PackageUpdateInfo, type SetupState } from "@lasercode/protocol";

// ---------------------------------------------------------------------------
// npm sources

/** A source string that names an npm package: `npm:name`, `npm:@s/n@^1`, or a bare name. */
export interface NpmSource {
  name: string;
  /** What followed the `@`: an exact version, a range, or a dist-tag. Absent = newest. */
  spec?: string;
}

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const GIT_LIKE = /^(?:https?:\/\/|git\+|git@|ssh:\/\/|github:|gitlab:|bitbucket:)/i;

/**
 * Recognise an npm source. The agent treats a bare word as a *local path*, so
 * `pi-web-access` typed into a field would be looked up on disk and fail with
 * "path does not exist"; a name that is not a path on this machine is taken as
 * the package it obviously means and normalised to `npm:` before it goes down.
 */
export function parseNpmSource(source: string, existsOnDisk: (path: string) => boolean = existsSync): NpmSource | undefined {
  const trimmed = source.trim();
  if (trimmed === "") return undefined;
  let spec = trimmed;
  if (trimmed.startsWith("npm:")) {
    spec = trimmed.slice("npm:".length).trim();
  } else {
    if (GIT_LIKE.test(trimmed) || trimmed.endsWith(".git")) return undefined;
    if (/^[./~\\]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return undefined;
    if (trimmed.includes("/") && !trimmed.startsWith("@")) return undefined; // owner/repo shorthand is git
    if (existsOnDisk(resolve(trimmed))) return undefined;
  }
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const rest = at > 0 ? spec.slice(at + 1) : undefined;
  if (!NPM_NAME.test(name) || name.length > 214) return undefined;
  return rest !== undefined && rest !== "" ? { name, spec: rest } : { name };
}

// ---------------------------------------------------------------------------
// semver — only as much as the registry's ranges need, so the host has no
// dependency for it and the rules are in one place a test can see.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers; empty for a release. */
  pre: string[];
  raw: string;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
    raw: text.trim(),
  };
}

export function isExactVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

function compareIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release outranks any prerelease of the same triple.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIds(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Comparator {
  op: Op;
  version: Version;
}

const v = (major: number, minor: number, patch: number, pre: string[] = []): Version => ({
  major,
  minor,
  patch,
  pre,
  raw: `${major}.${minor}.${patch}${pre.length ? `-${pre.join(".")}` : ""}`,
});

/** `1`, `1.2`, `1.2.x`, `*` → the parts that were given. */
function partial(text: string): { major?: number; minor?: number; patch?: number; pre: string[] } | undefined {
  const t = text.trim().replace(/^v/, "");
  if (t === "" || t === "*" || /^[xX*]$/.test(t)) return { pre: [] };
  const m = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(t);
  if (!m) return undefined;
  const num = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? undefined : Number(s));
  const out: { major?: number; minor?: number; patch?: number; pre: string[] } = { pre: m[4] ? m[4].split(".") : [] };
  const major = num(m[1]);
  const minor = num(m[2]);
  const patch = num(m[3]);
  if (major !== undefined) out.major = major;
  if (minor !== undefined) out.minor = minor;
  if (patch !== undefined) out.patch = patch;
  return out;
}

/** One comparator token → primitive comparators, or undefined when it is not one. */
function expandComparator(token: string): Comparator[] | undefined {
  const m = /^(>=|<=|>|<|=|\^|~>?)?\s*(.*)$/.exec(token.trim());
  if (!m) return undefined;
  const op = m[1] ?? "";
  const p = partial(m[2] ?? "");
  if (!p) return undefined;
  const { major, minor, patch, pre } = p;

  // Wildcard on its own: anything.
  if (major === undefined) return op === "<" ? [{ op: "<", version: v(0, 0, 0) }] : [{ op: ">=", version: v(0, 0, 0) }];

  const lower = v(major, minor ?? 0, patch ?? 0, pre);
  if (op === "^") {
    const upper =
      major > 0 || minor === undefined
        ? v(major + 1, 0, 0)
        : minor > 0 || patch === undefined
          ? v(0, minor + 1, 0)
          : v(0, 0, patch + 1);
    return [{ op: ">=", version: lower }, { op: "<", version: upper }];
  }
  if (op.startsWith("~")) {
    const upper = minor === undefined ? v(major + 1, 0, 0) : v(major, minor + 1, 0);
    return [{ op: ">=", version: lower }, { op: "<", version: upper }];
  }
  if (op === "" || op === "=") {
    if (minor === undefined) return [{ op: ">=", version: lower }, { op: "<", version: v(major + 1, 0, 0) }];
    if (patch === undefined) return [{ op: ">=", version: lower }, { op: "<", version: v(major, minor + 1, 0) }];
    return [{ op: "=", version: lower }];
  }
  if (op === ">=") return [{ op: ">=", version: lower }];
  if (op === "<") return [{ op: "<", version: lower }];
  if (op === ">") {
    if (minor === undefined) return [{ op: ">=", version: v(major + 1, 0, 0) }];
    if (patch === undefined) return [{ op: ">=", version: v(major, minor + 1, 0) }];
    return [{ op: ">", version: lower }];
  }
  // <=
  if (minor === undefined) return [{ op: "<", version: v(major + 1, 0, 0) }];
  if (patch === undefined) return [{ op: "<", version: v(major, minor + 1, 0) }];
  return [{ op: "<=", version: lower }];
}

/** One `||` alternative → its comparator set, or undefined when unparsable. */
function parseSet(text: string): Comparator[] | undefined {
  const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(text);
  if (hyphen) {
    const lo = expandComparator(`>=${hyphen[1]}`);
    const hiPartial = partial(hyphen[2] ?? "");
    if (!lo || !hiPartial) return undefined;
    const hi =
      hiPartial.major === undefined
        ? []
        : hiPartial.minor === undefined
          ? [{ op: "<" as Op, version: v(hiPartial.major + 1, 0, 0) }]
          : hiPartial.patch === undefined
            ? [{ op: "<" as Op, version: v(hiPartial.major, hiPartial.minor + 1, 0) }]
            : [{ op: "<=" as Op, version: v(hiPartial.major, hiPartial.minor, hiPartial.patch, hiPartial.pre) }];
    return [...lo, ...hi];
  }
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [{ op: ">=", version: v(0, 0, 0) }];
  const out: Comparator[] = [];
  for (const token of tokens) {
    const expanded = expandComparator(token);
    if (!expanded) return undefined;
    out.push(...expanded);
  }
  return out;
}

function holds(version: Version, c: Comparator): boolean {
  const cmp = compareVersions(version, c.version);
  switch (c.op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
  }
}

/** Is `range` something this resolver understands? Exact versions and dist-tags are not ranges. */
export function isRange(text: string): boolean {
  if (isExactVersion(text)) return false;
  return text.split("||").every((alt) => parseSet(alt) !== undefined);
}

/**
 * npm's semantics for the part that matters: a prerelease only satisfies a
 * range that itself names a prerelease of the same `major.minor.patch`. A
 * `^1.0.0` never picks up `2.0.0-beta.1`, and never `1.1.0-rc.1` either.
 */
export function satisfies(text: string, range: string): boolean {
  const version = parseVersion(text);
  if (!version) return false;
  for (const alt of range.split("||")) {
    const set = parseSet(alt);
    if (!set) return false;
    if (!set.every((c) => holds(version, c))) continue;
    if (version.pre.length === 0) return true;
    const allowed = set.some(
      (c) =>
        c.version.pre.length > 0 &&
        c.version.major === version.major &&
        c.version.minor === version.minor &&
        c.version.patch === version.patch,
    );
    if (allowed) return true;
  }
  return false;
}

export function maxSatisfying(versions: readonly string[], range: string): string | undefined {
  let best: Version | undefined;
  for (const text of versions) {
    if (!satisfies(text, range)) continue;
    const parsed = parseVersion(text);
    if (parsed && (!best || compareVersions(parsed, best) > 0)) best = parsed;
  }
  return best?.raw;
}

// ---------------------------------------------------------------------------
// registry

/** The abbreviated packument (`application/vnd.npm.install-v1+json`): tags, versions, dists. */
export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, { version: string; dist?: { tarball?: string; integrity?: string; shasum?: string }; deprecated?: string }>;
  modified?: string;
  time?: Record<string, string>;
  description?: string;
  homepage?: string;
  keywords?: string[];
}

export interface ResolvedVersion {
  name: string;
  version: string;
  integrity?: string;
  resolved?: string;
  /** The registry's `latest` tag at the time, for "an update is available". */
  latest?: string;
}

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 15_000;
const PACKUMENT_TTL_MS = 5 * 60_000;

export class RegistryError extends Error {
  override readonly name = "RegistryError";
  constructor(
    message: string,
    /** The registry answered 404: the name does not exist there. */
    readonly notFound = false,
  ) {
    super(message);
  }
}

/**
 * Pick one release from a packument for what was asked. Exact versions must
 * exist; a dist-tag resolves through `dist-tags`; a range takes the highest
 * satisfying release; nothing takes `latest`.
 */
export function resolveFromPackument(doc: Packument, spec: string | undefined): ResolvedVersion {
  const tags = doc["dist-tags"] ?? {};
  const latest = tags["latest"];
  const pick = (version: string, why: string): ResolvedVersion => {
    const entry = doc.versions?.[version];
    if (!entry) throw new RegistryError(`${doc.name} has no release ${version}${why}`);
    return {
      name: doc.name,
      version,
      ...(entry.dist?.integrity ? { integrity: entry.dist.integrity } : {}),
      ...(entry.dist?.tarball ? { resolved: entry.dist.tarball } : {}),
      ...(latest ? { latest } : {}),
    };
  };
  if (spec === undefined || spec === "" || spec === "latest") {
    if (!latest) throw new RegistryError(`${doc.name} has no published release yet`);
    return pick(latest, "");
  }
  if (isExactVersion(spec)) return pick(spec.replace(/^v/, ""), "");
  if (spec in tags) return pick(tags[spec]!, ` (the "${spec}" tag points at it)`);
  if (isRange(spec)) {
    const hit = maxSatisfying(Object.keys(doc.versions ?? {}), spec);
    if (!hit) throw new RegistryError(`no release of ${doc.name} matches ${spec}`);
    return pick(hit, "");
  }
  throw new RegistryError(`"${spec}" is not a version, a range or a tag of ${doc.name}`);
}

// ---------------------------------------------------------------------------
// the curated list

interface CuratedPackage {
  name: string;
  description: string;
  homepage?: string;
}

/**
 * Extensions worth showing before anyone types a search. Names only; the
 * version is resolved live so the list never advertises a stale release, and
 * installing pins whatever it resolves to. Ordered roughly by how often they
 * are wanted, not by downloads.
 */
export const CURATED_PACKAGES: readonly CuratedPackage[] = [
  { name: "pi-web-access", description: "Search the web, read pages and PDFs, clone repositories, watch YouTube transcripts.", homepage: "https://pi.dev/packages/pi-web-access" },
  { name: "pi-subagents", description: "Delegate parts of a task to parallel agents and run multi-step workflows.", homepage: "https://pi.dev/packages/pi-subagents" },
  { name: "pi-mcp-adapter", description: "Use tools from any Model Context Protocol server.", homepage: "https://pi.dev/packages/pi-mcp-adapter" },
  { name: "pi-background-tasks", description: "Long-running shell commands that keep going after the turn and report back.", homepage: "https://pi.dev/packages/pi-background-tasks" },
  { name: "pi-lens", description: "Language servers, linters, formatters and type checks as feedback to the agent.", homepage: "https://pi.dev/packages/pi-lens" },
  { name: "context-mode", description: "Compresses the context window so long sessions keep going.", homepage: "https://pi.dev/packages/context-mode" },
  { name: "pi-memory", description: "Remembers across sessions, with semantic search.", homepage: "https://pi.dev/packages/pi-memory" },
  { name: "pi-simplify", description: "Reviews changed code for clarity and needless complexity.", homepage: "https://pi.dev/packages/pi-simplify" },
  { name: "@plannotator/pi-extension", description: "Review and annotate the agent's plan before it acts.", homepage: "https://pi.dev/packages/@plannotator/pi-extension" },
  { name: "@juicesharp/rpiv-todo", description: "A live to-do list the agent keeps while it works.", homepage: "https://pi.dev/packages/@juicesharp/rpiv-todo" },
  { name: "@juicesharp/rpiv-ask-user-question", description: "Structured questions to you, with options, in the middle of a task.", homepage: "https://pi.dev/packages/@juicesharp/rpiv-ask-user-question" },
];

/** The keyword the gallery requires; a search hit without it is not an extension. */
const PACKAGE_KEYWORD = "pi-package";

// ---------------------------------------------------------------------------
// the install runtime

export interface InstallRuntime extends PackageRuntimeInfo {
  /** `[command, ...args]` the worker should run as its package manager; absent when not ready. */
  command?: string[];
}

const NOT_READY =
  `This copy of ${PRODUCT_NAME} cannot install extensions: the installer it ships with is missing. Reinstall ${PRODUCT_NAME} to restore it.`;

/**
 * npm runs a package's `postinstall` as the person who is signed in, with their
 * whole home directory in reach, and npm 11 still only *warns* about scripts it
 * has not been told to trust. Settings installs from a live registry search, so
 * a card in that list is a stranger's code one click from running.
 *
 * `--strict-allow-scripts` turns that warning into a hard failure that names
 * the package. The install stops, the person is told which extension wanted to
 * run something, and nothing has run. It is the bundled npm's own flag, and it
 * is why the bundled npm is the one laser ships with.
 */
const NPM_SAFETY_FLAGS = ["--strict-allow-scripts"] as const;

/**
 * Where the installer is. Best first:
 *
 *   1. `LASER_NPM_CLI`, which the desktop shell sets;
 *   2. `<node>/../npm/bin/npm-cli.js` — the packaged layout, which is what
 *      `build/before-pack.cjs` stages beside the pinned Node;
 *   3. `<node>/../../lib/node_modules/npm/bin/npm-cli.js` — a stock Node
 *      install's layout, which is what a development checkout has;
 *   4. `npm` on PATH, **only when this is not a packaged install**.
 *
 * (2) exists because (1) reaches only the host the Electron shell spawns. A
 * person who runs `laser up` in a terminal first, then opens the window, gets
 * a host the window *adopts* — and that host had no LASER_NPM_CLI, so
 * Settings used to say "the installer it ships with is missing. Reinstall
 * laser", which is false and which reinstalling cannot fix. Both hosts run on
 * the same bundled Node, so a sibling lookup answers for both.
 *
 * (4) is excluded from a packaged install on purpose: laser pins every
 * version it ships, and an unpinned npm off the person's PATH writing into
 * laser's own agent directory is exactly the thing the bundling is for.
 */
export function detectInstallRuntime(
  options: { execPath?: string; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean; packaged?: boolean } = {},
): InstallRuntime {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const packaged = options.packaged ?? isPackagedInstall();
  const node = { version: process.version, path: execPath };

  const configured = env[ENV.npmCli];
  if (configured && exists(configured)) {
    return { ready: true, node, npm: { path: configured, source: "configured" }, command: [execPath, configured, ...NPM_SAFETY_FLAGS] };
  }
  const bundled = resolve(join(dirname(execPath), "npm", "bin", "npm-cli.js"));
  if (exists(bundled)) {
    return { ready: true, node, npm: { path: bundled, source: "bundled" }, command: [execPath, bundled, ...NPM_SAFETY_FLAGS] };
  }
  const stock = resolve(join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  if (exists(stock)) {
    return { ready: true, node, npm: { path: stock, source: "bundled" }, command: [execPath, stock, ...NPM_SAFETY_FLAGS] };
  }
  if (!packaged) {
    const names = process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];
    for (const dir of (env["PATH"] ?? "").split(delimiter)) {
      if (!dir) continue;
      for (const name of names) {
        const candidate = join(dir, name);
        if (exists(candidate)) return { ready: true, node, npm: { path: candidate, source: "path" }, command: [candidate, ...NPM_SAFETY_FLAGS] };
      }
    }
  }
  return { ready: false, node, reason: NOT_READY };
}

/**
 * Is this host running out of a packaged app? The host's own module lives under
 * `resources/app.asar.unpacked/` in every packaging format, and nowhere else —
 * so this answers the same way whether the shell spawned the host or a terminal
 * `laser up` did.
 */
function isPackagedInstall(): boolean {
  return import.meta.url.includes("app.asar");
}

// ---------------------------------------------------------------------------
// failure, in one sentence

/**
 * The worker's error is the agent's, wrapped around a package manager's stderr:
 * pages of `npm error` lines nobody should read. Reduce it to the one fact
 * that decides what to do next.
 */
export function describeInstallFailure(name: string, raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const say = (why: string) => `Could not install ${name}: ${why}`;
  if (/\be404\b|404 not found|is not in this registry|not on the registry|no such package/.test(lower)) {
    return say("no extension with that name exists. Check the spelling.");
  }
  if (/\betarget\b|no matching version|has no release|no release of|does not exist/.test(lower)) {
    const version = /(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)/i.exec(text)?.[1];
    return say(version ? `version ${version} does not exist.` : "that version does not exist.");
  }
  if (/enotfound|eai_again|econnrefused|econnreset|etimedout|fetch failed|network|socket hang up|getaddrinfo/.test(lower)) {
    return say("the package registry could not be reached. Check your internet connection and try again.");
  }
  if (/\beacces\b|\beperm\b|permission denied/.test(lower)) {
    return say(`${PRODUCT_NAME} is not allowed to write to its extensions folder. Check the folder's permissions and try again.`);
  }
  if (/\benospc\b|no space left/.test(lower)) {
    return say("the disk is full.");
  }
  if (/estrictallowscripts|install scripts (?:not covered by allowscripts|blocked)/.test(lower)) {
    return say(`one of its components needs to run setup code that ${PRODUCT_NAME} has not reviewed yet. Nothing was installed.`);
  }
  if (/not trusted/.test(lower)) {
    return say("this project is not trusted yet. Trust it first, or install for your user instead.");
  }
  if (/\benoent\b.*\bnpm\b|spawn .* enoent|command not found/.test(lower)) {
    return say(`the installer ${PRODUCT_NAME} ships with could not be started. Reinstall ${PRODUCT_NAME} to restore it.`);
  }
  // Fall back to the first line that carries information, stripped of the
  // package manager's prefixes, capped so a stack never reaches the screen.
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*npm (?:ERR!|error|warn|WARN)\s*/i, "").trim())
      .find((l) => l.length > 0 && !/^could not install/i.test(l)) ?? "it did not finish.";
  const trimmed = line.replace(/^Could not [^:]+:\s*/i, "");
  return say(trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed.endsWith(".") ? trimmed : `${trimmed}.`);
}

// ---------------------------------------------------------------------------
// the lock

interface LockFile {
  version: 1;
  records: PackageRecord[];
}

/** `<stateDir>/packages.lock.json`, written whole and atomically. */
export class PackageLock {
  private records: PackageRecord[] = [];
  private loaded = false;

  constructor(private readonly path: string | undefined) {}

  list(): PackageRecord[] {
    this.load();
    return [...this.records];
  }

  find(name: string, scope: PackageScope, cwd?: string): PackageRecord | undefined {
    this.load();
    return this.records.find((r) => r.name === name && r.scope === scope && (scope === "user" || r.cwd === cwd));
  }

  upsert(record: PackageRecord): void {
    this.load();
    const rest = this.records.filter(
      (r) => !(r.name === record.name && r.scope === record.scope && (record.scope === "user" || r.cwd === record.cwd)),
    );
    this.records = [...rest, record].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
    this.save();
  }

  remove(name: string, scope: PackageScope, cwd?: string): void {
    this.load();
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => !(r.name === name && r.scope === scope && (scope === "user" || r.cwd === cwd)),
    );
    if (this.records.length !== before) this.save();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockFile>;
      if (Array.isArray(parsed.records)) this.records = parsed.records.filter(isRecord);
    } catch {
      // A corrupt lock is not worth refusing installs over; the next write replaces it.
      this.records = [];
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, records: this.records } satisfies LockFile, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

function isRecord(value: unknown): value is PackageRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["name"] === "string" &&
    typeof r["version"] === "string" &&
    (r["scope"] === "user" || r["scope"] === "project") &&
    typeof r["source"] === "string" &&
    typeof r["installedAt"] === "string"
  );
}

// ---------------------------------------------------------------------------
// the service

/** Reaches the worker for `cwd`: the router's `pool.get(cwd).request(...)`. */
export type Forward = <M extends ClientMethod>(
  cwd: string,
  method: M,
  params: ClientRequests[M]["params"],
) => Promise<ClientRequests[M]["result"]>;

export interface PackageServiceOptions {
  /** The agent's directory; user-scope packages live under `<agentDir>/npm`. */
  agentDir: string;
  /** laser's own state; the lock lives here. Absent = memory only (tests). */
  stateDir?: string;
  forward: Forward;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  registry?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  now?: () => Date;
}

/** A `ProtocolError` whose message is already written for the person reading it. */
export class PackageServiceError extends ProtocolError {}

type Packages = ClientRequests["pi/packages/list"]["result"];

export class PackageService {
  private readonly lock: PackageLock;
  private readonly forward: Forward;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly registry: string;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execPath: string | undefined;
  private readonly packuments = new Map<string, { at: number; doc: Promise<Packument> }>();
  /** `latestVersion` per configured npm entry, from the last `checkUpdates`. */
  private readonly latest = new Map<string, string>();
  /** One write in flight per (scope, cwd, package); see `serialize`. */
  private readonly writes = new Map<string, Promise<void>>();
  readonly agentDir: string;

  constructor(private readonly options: PackageServiceOptions) {
    this.agentDir = resolve(options.agentDir);
    this.lock = new PackageLock(options.stateDir ? join(options.stateDir, "packages.lock.json") : undefined);
    this.forward = options.forward;
    this.log = options.log ?? (() => {});
    this.fetchImpl = options.fetch ?? fetch;
    this.registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.execPath = options.execPath;
  }

  // --- runtime ------------------------------------------------------------

  runtime(): PackageRuntimeInfo {
    const { command: _command, ...info } = detectInstallRuntime({
      env: this.env,
      ...(this.execPath ? { execPath: this.execPath } : {}),
    });
    return info;
  }

  /** What the worker should run as its package manager, or undefined when nothing is available. */
  npmCommand(): string[] | undefined {
    return detectInstallRuntime({ env: this.env, ...(this.execPath ? { execPath: this.execPath } : {}) }).command;
  }

  // --- reading ------------------------------------------------------------

  async list(cwd: string): Promise<Packages> {
    const result = await this.forward(cwd, "pi/packages/list", { cwd });
    return { packages: this.decorate(cwd, result.packages) };
  }

  records(cwd?: string): PackageRecord[] {
    return this.lock.list().filter((r) => r.scope === "user" || cwd === undefined || r.cwd === resolve(cwd));
  }

  // --- catalog --------------------------------------------------------------

  async catalog(params: ClientRequests["pi/packages/catalog"]["params"]): Promise<ClientRequests["pi/packages/catalog"]["result"]> {
    const limit = params.limit ?? 50;
    const query = params.query?.trim() ?? "";
    const installed = params.cwd ? await this.installedByName(params.cwd) : new Map<string, PackageEntry>();
    const mark = (entry: PackageCatalogEntry): PackageCatalogEntry => {
      const hit = installed.get(entry.name);
      return hit
        ? { ...entry, installed: { source: hit.source, scope: hit.scope, ...(hit.version ? { version: hit.version } : {}) } }
        : entry;
    };

    if (query === "") {
      let error: string | undefined;
      const entries = await Promise.all(
        CURATED_PACKAGES.map(async (pkg): Promise<PackageCatalogEntry | undefined> => {
          const base: PackageCatalogEntry = { name: pkg.name, description: pkg.description, curated: true, ...(pkg.homepage ? { homepage: pkg.homepage } : {}) };
          try {
            const doc = await this.packument(pkg.name);
            const latest = doc["dist-tags"]?.["latest"];
            const published = latest ? doc.time?.[latest] : undefined;
            return { ...base, ...(latest ? { version: latest } : {}), ...(published ? { publishedAt: published } : {}) };
          } catch (fetchError) {
            // A name the registry does not know is a mistake in this list, not
            // something to show a person; anything else is the network, said once.
            if (fetchError instanceof RegistryError && fetchError.notFound) {
              this.log(`packages: curated entry ${pkg.name} is not on the registry`);
              return undefined;
            }
            error ??= describeRegistryFailure(fetchError);
            return base;
          }
        }),
      );
      const present = entries.filter((entry): entry is PackageCatalogEntry => entry !== undefined);
      return { entries: present.slice(0, limit).map(mark), source: "curated", truncated: present.length > limit, ...(error ? { error } : {}) };
    }

    try {
      const url = `${this.registry}/-/v1/search?text=${encodeURIComponent(`keywords:${PACKAGE_KEYWORD} ${query}`)}&size=${Math.min(250, limit * 2)}`;
      const body = (await this.getJson(url)) as {
        objects?: Array<{ package?: { name?: string; version?: string; description?: string; keywords?: string[]; date?: string; links?: { homepage?: string; npm?: string } } }>;
      };
      const seen = new Set<string>();
      const entries: PackageCatalogEntry[] = [];
      for (const item of body.objects ?? []) {
        const p = item.package;
        if (!p?.name || !p.version || seen.has(p.name)) continue;
        // The search is fuzzy; the keyword is the contract with the gallery.
        if (!Array.isArray(p.keywords) || !p.keywords.includes(PACKAGE_KEYWORD)) continue;
        seen.add(p.name);
        entries.push({
          name: p.name,
          version: p.version,
          curated: CURATED_PACKAGES.some((c) => c.name === p.name),
          ...(p.description ? { description: p.description } : {}),
          ...(p.links?.homepage ? { homepage: p.links.homepage } : p.links?.npm ? { homepage: p.links.npm } : {}),
          ...(p.date ? { publishedAt: p.date } : {}),
          keywords: p.keywords.filter((k) => k !== PACKAGE_KEYWORD).slice(0, 8),
        });
      }
      return { entries: entries.slice(0, limit).map(mark), source: "search", truncated: entries.length > limit };
    } catch (searchError) {
      // Offline: the curated list still answers a query by name and description.
      const needle = query.toLowerCase();
      const entries = CURATED_PACKAGES.filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(needle)).map(
        (c): PackageCatalogEntry => ({ name: c.name, description: c.description, curated: true, ...(c.homepage ? { homepage: c.homepage } : {}) }),
      );
      return { entries: entries.map(mark), source: "curated", truncated: false, error: describeRegistryFailure(searchError) };
    }
  }

  // --- writing --------------------------------------------------------------

  async install(params: ClientRequests["pi/packages/install"]["params"]): Promise<ClientRequests["pi/packages/install"]["result"]> {
    const npmName = parseNpmSource(params.source)?.name ?? params.source;
    // One directory, more than one client: the desktop, a phone over the relay
    // and `laser packages` all reach this service. The worker serialises what
    // it runs, but two requests for the same package overlap *here* — and the
    // loser's post-install check then reads the winner's version, calls it a
    // mismatch, and `discard()`s a package that was installed successfully.
    // Serialising per (scope, cwd, name) is the whole fix.
    return this.serialize(writeKey(params.scope, params.cwd, npmName), () => this.installOne(params));
  }

  private async installOne(params: ClientRequests["pi/packages/install"]["params"]): Promise<ClientRequests["pi/packages/install"]["result"]> {
    const { cwd, scope } = params;
    const npm = parseNpmSource(params.source);
    if (!npm) {
      // git and local sources: the agent handles them whole. Nothing to pin
      // from here; a git ref is pinned by writing it into the source.
      const result = await this.forward(cwd, "pi/packages/install", { cwd, source: params.source, scope });
      return { packages: this.decorate(cwd, result.packages) };
    }
    if (params.version !== undefined && npm.spec !== undefined && npm.spec !== params.version) {
      throw new PackageServiceError(ErrorCodes.InvalidParams, `${params.source} names ${npm.spec} but version ${params.version} was asked for; give one or the other`);
    }

    const runtime = detectInstallRuntime({ env: this.env, ...(this.execPath ? { execPath: this.execPath } : {}) });
    if (!runtime.ready) throw new PackageServiceError(ErrorCodes.Unsupported, runtime.reason ?? NOT_READY);

    let resolved: ResolvedVersion;
    try {
      resolved = resolveFromPackument(await this.packument(npm.name), params.version ?? npm.spec);
    } catch (resolveError) {
      throw new PackageServiceError(ErrorCodes.Internal, describeInstallFailure(npm.name, describeRegistryFailure(resolveError)));
    }
    const pinnedSource = `npm:${resolved.name}@${resolved.version}`;
    const target = this.installPath(cwd, scope, resolved.name);
    const existedBefore = existsSync(target);
    const versionBefore = readManifestVersion(target);

    let result: Packages;
    try {
      result = await this.forward(cwd, "pi/packages/install", { cwd, source: pinnedSource, scope });
    } catch (installError) {
      if (!existedBefore) this.discard(target);
      const message = installError instanceof Error ? installError.message : String(installError);
      this.log(`packages: install ${pinnedSource} failed — ${message.split("\n")[0]}`);
      throw new PackageServiceError(ErrorCodes.Internal, describeInstallFailure(resolved.name, message));
    }

    // The proof, not the report: the manifest on disk has to be the release
    // that was pinned. Anything else is not what the person agreed to.
    const onDisk = readManifestVersion(target);
    if (onDisk !== resolved.version) {
      if (!existedBefore) this.discard(target);
      else if (versionBefore && versionBefore !== onDisk) this.log(`packages: ${resolved.name} was ${versionBefore}, is now ${onDisk ?? "missing"}`);
      throw new PackageServiceError(
        ErrorCodes.Internal,
        `Could not install ${resolved.name}: version ${resolved.version} was expected but ${onDisk ? `${onDisk} was installed` : "nothing arrived"}. Nothing was kept; try again.`,
      );
    }

    // The second proof. The version string matching says nothing about which
    // bytes arrived: npm re-resolves the spec through its own registry fetch,
    // and a mirror or a stale `.npmrc` can answer differently from the fetch
    // this host made a moment ago. So compare the integrity the registry
    // declared against the one npm recorded for what it installed.
    //
    // Three outcomes, and each one is said out loud:
    //   they match      -> the record carries the hash, and Settings may show it
    //   they differ     -> refuse, and keep nothing that was not there before
    //   nothing to read -> record no hash at all, rather than show an unchecked
    //                      one next to the path as if it were a receipt
    const installedIntegrity = readInstalledIntegrity(this.installRoot(cwd, scope), resolved.name);
    if (resolved.integrity && installedIntegrity && installedIntegrity !== resolved.integrity) {
      if (!existedBefore) this.discard(target);
      this.log(`packages: ${resolved.name}@${resolved.version} integrity mismatch (registry ${resolved.integrity}, installed ${installedIntegrity})`);
      throw new PackageServiceError(
        ErrorCodes.Internal,
        `Could not install ${resolved.name}: the files that arrived are not the ones the package registry published for version ${resolved.version}. ` +
          `Nothing was kept. This usually means a proxy or a mirror is serving different files; if you set a custom registry, check it.`,
      );
    }
    const verifiedIntegrity = resolved.integrity && installedIntegrity === resolved.integrity ? resolved.integrity : undefined;
    if (resolved.integrity && !verifiedIntegrity) {
      this.log(`packages: ${resolved.name}@${resolved.version} installed, but npm left no integrity to check it against`);
    }

    const record: PackageRecord = {
      name: resolved.name,
      version: resolved.version,
      scope,
      ...(scope === "project" ? { cwd: resolve(cwd) } : {}),
      ...(verifiedIntegrity ? { integrity: verifiedIntegrity } : {}),
      ...(resolved.resolved ? { resolved: resolved.resolved } : {}),
      source: pinnedSource,
      installedAt: this.now().toISOString(),
    };
    this.lock.upsert(record);
    this.latest.delete(latestKey(resolved.name, scope, cwd));
    this.log(`packages: installed ${pinnedSource} (${scope})`);
    return { packages: this.decorate(cwd, result.packages), record };
  }

  async remove(params: ClientRequests["pi/packages/remove"]["params"]): Promise<ClientRequests["pi/packages/remove"]["result"]> {
    const name = parseNpmSource(params.source)?.name ?? params.source;
    // Same queue as install: removing a package while an install of it is in
    // flight would otherwise leave the lock and the disk disagreeing.
    return this.serialize(writeKey(params.scope, params.cwd, name), () => this.removeOne(params));
  }

  private async removeOne(params: ClientRequests["pi/packages/remove"]["params"]): Promise<ClientRequests["pi/packages/remove"]["result"]> {
    const result = await this.forward(params.cwd, "pi/packages/remove", params);
    const npm = parseNpmSource(params.source);
    if (npm) {
      this.lock.remove(npm.name, params.scope, resolve(params.cwd));
      this.latest.delete(latestKey(npm.name, params.scope, params.cwd));
    }
    return { ...result, packages: this.decorate(params.cwd, result.packages) };
  }

  /**
   * An update of a pinned npm package is a new pin, not a `latest` drift: the
   * host resolves the newest release and installs that one. Git sources go to
   * the agent, which knows their refs.
   */
  async update(params: ClientRequests["pi/packages/update"]["params"]): Promise<ClientRequests["pi/packages/update"]["result"]> {
    const { cwd } = params;
    const current = this.decorate(cwd, (await this.forward(cwd, "pi/packages/list", { cwd })).packages);
    const wanted = params.source ? current.filter((e) => sameSource(e, params.source!)) : current;
    if (params.source && wanted.length === 0) {
      throw new PackageServiceError(ErrorCodes.InvalidParams, `${params.source} is not one of this project's extensions.`);
    }
    const failures: string[] = [];
    for (const entry of wanted) {
      const npm = parseNpmSource(entry.source);
      try {
        if (!npm) {
          await this.forward(cwd, "pi/packages/update", { cwd, source: entry.source });
          continue;
        }
        // A range keeps its range; a pin and a bare name move to the newest.
        const spec = npm.spec !== undefined && isRange(npm.spec) ? npm.spec : undefined;
        const resolved = resolveFromPackument(await this.packument(npm.name), spec);
        if (resolved.version === entry.version) continue;
        await this.install({ cwd, source: `npm:${npm.name}`, scope: entry.scope, version: resolved.version });
      } catch (updateError) {
        failures.push(updateError instanceof Error ? updateError.message : String(updateError));
      }
    }
    const packages = this.decorate(cwd, (await this.forward(cwd, "pi/packages/list", { cwd })).packages);
    if (failures.length > 0) {
      throw new PackageServiceError(ErrorCodes.Internal, failures.length === 1 ? failures[0]! : `${failures.length} updates failed. ${failures[0]}`);
    }
    return { packages };
  }

  async checkUpdates(params: ClientRequests["pi/packages/check_updates"]["params"]): Promise<ClientRequests["pi/packages/check_updates"]["result"]> {
    const { cwd } = params;
    const entries = this.decorate(cwd, (await this.forward(cwd, "pi/packages/list", { cwd })).packages);
    // The agent answers for git sources; a pinned npm source it reports as
    // never updatable, which is true of the pin and false of the package.
    const fromWorker = (await this.forward(cwd, "pi/packages/check_updates", { cwd })).updates.filter(
      (u) => parseNpmSource(u.source) === undefined,
    );
    const updates: PackageUpdateInfo[] = [...fromWorker];
    let firstError: string | undefined;
    await Promise.all(
      entries.map(async (entry) => {
        const npm = parseNpmSource(entry.source);
        if (!npm) return;
        try {
          const spec = npm.spec !== undefined && isRange(npm.spec) ? npm.spec : undefined;
          const resolved = resolveFromPackument(await this.packument(npm.name), spec);
          this.latest.set(latestKey(npm.name, entry.scope, cwd), resolved.version);
          if (entry.version !== undefined && resolved.version !== entry.version) {
            updates.push({
              source: entry.source,
              displayName: npm.name,
              type: "npm",
              scope: entry.scope,
              installedVersion: entry.version,
              latestVersion: resolved.version,
            });
          }
        } catch (checkError) {
          firstError ??= describeRegistryFailure(checkError);
        }
      }),
    );
    if (firstError && updates.length === 0 && entries.some((e) => parseNpmSource(e.source))) {
      throw new PackageServiceError(ErrorCodes.Internal, `Could not check for updates: ${firstError}`);
    }
    return { updates };
  }

  // --- internals ------------------------------------------------------------

  /**
   * One in-flight write per key, queued rather than refused. A person who
   * double-clicks Install, or a phone and the desktop asking for the same
   * package at once, waits a moment instead of racing a directory.
   */
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.writes.set(key, tail);
    // Drop the entry once nothing is queued behind it, so a long-lived host
    // does not keep one settled promise per package it has ever touched.
    void tail.then(() => {
      if (this.writes.get(key) === tail) this.writes.delete(key);
    });
    return next;
  }

  private async installedByName(cwd: string): Promise<Map<string, PackageEntry>> {
    try {
      const { packages } = await this.list(cwd);
      const map = new Map<string, PackageEntry>();
      for (const entry of packages) if (entry.name) map.set(entry.name, entry);
      return map;
    } catch {
      return new Map();
    }
  }

  /** Root the agent installs `scope` packages under; mirrors its own layout. */
  private installRoot(cwd: string, scope: PackageScope): string {
    return scope === "project" ? join(resolve(cwd), ".pi", "npm") : join(this.agentDir, "npm");
  }

  private installPath(cwd: string, scope: PackageScope, name: string): string {
    return join(this.installRoot(cwd, scope), "node_modules", ...name.split("/"));
  }

  private discard(target: string): void {
    // Only ever a directory under one of the two roots this service computes,
    // and only one that did not exist before the attempt.
    const roots = [join(this.agentDir, "npm", "node_modules")];
    if (!roots.some((root) => target.startsWith(root + sep)) && !/[\\/]\.pi[\\/]npm[\\/]node_modules[\\/]/.test(target)) return;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (rmError) {
      this.log(`packages: could not clean up ${target}: ${rmError instanceof Error ? rmError.message : String(rmError)}`);
    }
  }

  /** Name, pinned version, on-disk version, lock integrity and last-known latest, per entry. */
  private decorate(cwd: string, packages: PackageEntry[]): PackageEntry[] {
    return packages.map((entry) => {
      const npm = parseNpmSource(entry.source);
      if (!npm) return entry;
      const path = entry.installedPath ?? this.installPath(cwd, entry.scope, npm.name);
      const version = readManifestVersion(path);
      const record = this.lock.find(npm.name, entry.scope, resolve(cwd));
      const latest = this.latest.get(latestKey(npm.name, entry.scope, cwd));
      return {
        ...entry,
        type: "npm",
        name: npm.name,
        ...(version ? { version } : {}),
        ...(npm.spec !== undefined && isExactVersion(npm.spec) ? { pinnedVersion: npm.spec } : {}),
        ...(record?.integrity ? { integrity: record.integrity } : {}),
        ...(latest ? { latestVersion: latest, ...(version && latest !== version ? { updateAvailable: true } : {}) } : {}),
      };
    });
  }

  private packument(name: string): Promise<Packument> {
    const cached = this.packuments.get(name);
    const now = Date.now();
    if (cached && now - cached.at < PACKUMENT_TTL_MS) return cached.doc;
    const doc = this.getJson(`${this.registry}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`, {
      accept: "application/vnd.npm.install-v1+json",
    }).then((body) => {
      const parsed = body as Packument;
      if (!parsed || typeof parsed !== "object" || typeof parsed.versions !== "object") {
        throw new RegistryError(`the registry's answer for ${name} was not a package`);
      }
      return { ...parsed, name: parsed.name ?? name };
    });
    this.packuments.set(name, { at: now, doc });
    doc.catch(() => this.packuments.delete(name));
    return doc;
  }

  private async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch (fetchError) {
      throw new RegistryError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    }
    if (response.status === 404) throw new RegistryError("E404: the registry has no package by that name", true);
    if (!response.ok) throw new RegistryError(`the registry answered ${response.status}`);
    return response.json();
  }
}

function latestKey(name: string, scope: PackageScope, cwd: string): string {
  return scope === "project" ? `${name}\0project\0${resolve(cwd)}` : `${name}\0user`;
}

function sameSource(entry: PackageEntry, source: string): boolean {
  if (entry.source === source) return true;
  const a = parseNpmSource(entry.source);
  const b = parseNpmSource(source);
  return a !== undefined && b !== undefined && a.name === b.name;
}

/**
 * The queue key for one write. Install and remove must produce the *same*
 * string for the same package, or the two would run against one directory at
 * once. The separator is a character that cannot appear in a scope, a path or
 * a package name.
 */
function writeKey(scope: PackageScope, cwd: string, name: string): string {
  return [scope, resolve(cwd), name].join("\u0000");
}

function readManifestVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The integrity npm recorded for the package it actually installed.
 *
 * The host resolves a version against the registry and hands the worker
 * `npm:<name>@<exact>`; npm then does its own metadata fetch and installs
 * whatever tarball *its* answer names. Those two answers can differ — a mirror,
 * a proxy, an `.npmrc` with a `registry=` line the person set years ago — and
 * the version string matching proves nothing about the bytes.
 *
 * npm writes what it installed into the prefix's own `package-lock.json`, so
 * that is the thing to compare against. Returns `undefined` when there is no
 * lock entry to read, which is the honest answer and not a pass.
 */
function readInstalledIntegrity(root: string, name: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { integrity?: unknown; version?: unknown }>;
    };
    const entry = lock.packages?.[`node_modules/${name}`];
    return typeof entry?.integrity === "string" ? entry.integrity : undefined;
  } catch {
    return undefined;
  }
}

function describeRegistryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (/timeout|timed out|aborted/.test(lower)) return "the package registry took too long to answer. Try again in a moment.";
  if (/enotfound|eai_again|econnrefused|fetch failed|network|getaddrinfo/.test(lower)) {
    return "the package registry could not be reached. Check your internet connection.";
  }
  if (/^e404/i.test(message)) return "that extension is not on the registry. Check the spelling.";
  return message.endsWith(".") ? message : `${message}.`;
}

// ---------------------------------------------------------------------------
// first run (M10-T6)

export interface SetupServiceOptions {
  /** laser's own state directory. */
  stateDir: string;
  now?: () => Date;
}

interface SetupFile {
  completed: boolean;
  completedAt?: string;
}

/**
 * Setup state and the project-less directory. `<stateDir>/global` is an
 * empty directory the host owns: every settings, provider and model method is
 * routed by directory, and this is the one to use before a project exists.
 * Nothing about it is a project — it has no `.pi`, so trust never comes up.
 */
export class SetupService {
  readonly cwd: string;
  private readonly file: string;
  private readonly now: () => Date;

  constructor(options: SetupServiceOptions) {
    this.cwd = join(options.stateDir, "global");
    this.file = join(options.stateDir, "setup.json");
    this.now = options.now ?? (() => new Date());
  }

  state(): SetupState {
    mkdirSync(this.cwd, { recursive: true });
    const saved = this.read();
    return { cwd: this.cwd, completed: saved.completed, ...(saved.completedAt ? { completedAt: saved.completedAt } : {}) };
  }

  complete(completed: boolean): SetupState {
    const next: SetupFile = completed ? { completed: true, completedAt: this.now().toISOString() } : { completed: false };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.file);
    return this.state();
  }

  private read(): SetupFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SetupFile>;
      return {
        completed: parsed.completed === true,
        ...(typeof parsed.completedAt === "string" ? { completedAt: parsed.completedAt } : {}),
      };
    } catch {
      return { completed: false };
    }
  }
}

const BROWSE_LIMIT = 500;
const PROJECT_MARKERS = [".git", ".pi", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "Gemfile", "CMakeLists.txt"];

/**
 * Subdirectories of `path`, for choosing a project without typing (M10-T6).
 * Directories only; dotfiles skipped; symlinks followed when they point at a
 * directory; capped, sorted, and never a stack trace when a folder cannot be
 * read.
 */
export function browseDirectories(path?: string, home: string = homedir()): DirectoryListing {
  const target = resolve(path && path.trim() !== "" ? expandHome(path.trim(), home) : home);
  const parent = dirname(target);
  const base: Omit<DirectoryListing, "entries" | "truncated"> = {
    path: target,
    home,
    ...(parent !== target ? { parent } : {}),
  };
  let names: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    names = readdirSync(target, { withFileTypes: true });
  } catch (readError) {
    return { ...base, entries: [], truncated: false, error: describeBrowseFailure(readError, target) };
  }
  const entries: DirectoryEntry[] = [];
  for (const entry of names) {
    if (entry.name.startsWith(".")) continue;
    const full = join(target, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({ name: entry.name, path: full, project: PROJECT_MARKERS.some((marker) => existsSync(join(full, marker))) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return { ...base, entries: entries.slice(0, BROWSE_LIMIT), truncated: entries.length > BROWSE_LIMIT };
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

function describeBrowseFailure(error: unknown, target: string): string {
  const code = (error as { code?: string } | null)?.code;
  const name = basename(target) || target;
  if (code === "ENOENT") return `"${name}" does not exist any more.`;
  if (code === "EACCES" || code === "EPERM") return `You do not have permission to open "${name}".`;
  if (code === "ENOTDIR") return `"${name}" is a file, not a folder.`;
  return `"${name}" could not be opened.`;
}
