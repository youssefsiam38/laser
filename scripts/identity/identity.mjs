/**
 * product.json, resolved (MX-T7).
 *
 * One reader, four consumers: the generators, the drift check, the desktop's
 * Linux packaging scripts and the TypeScript emitter. Everything that is
 * *derived* rather than *written* is derived exactly once, here, so a rename
 * cannot half-apply.
 *
 * The TypeScript side gets the same values through
 * `packages/protocol/src/product.generated.ts`, which this file emits. There is
 * no second definition of any of these strings anywhere in the repository, and
 * `scripts/identity/check.mjs` is what keeps that true.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const productJsonPath = join(repoRoot, "product.json");

/** Every environment variable the product reads, by its unprefixed name. */
export const ENV_NAMES = /** @type {const} */ ([
  "AGENT_DIR",
  "ALLOWED_ORIGINS",
  "ARCH",
  "DEBUG",
  "DISABLE_SANDBOX",
  "EXTENSION_NAME",
  "FEATURES",
  "HOME",
  "MCP_LIVE",
  "NODE",
  "NODE_MIRROR",
  "NPM_CLI",
  "NPM_COMMAND",
  "PORT",
  "PROJECT_ENV",
  "RELEASE_KEY",
  "RELEASE_KEY_PEM",
  "PACKAGE_SIGNING_KEY",
  "REPO",
  "SCRATCH",
  "SCREENSHOT_BASE_URL",
  "SESSION_DIR",
  "STATE_DIR",
  "TAG",
  "UI_URL",
  "WORKER_FD",
  "AZURE_ACCOUNT",
  "AZURE_ENDPOINT",
  "AZURE_PROFILE",
  "AZURE_PUBLISHER_NAME",
]);

/** camelCase key for an env name, so `ENV.agentDir` reads like a field. */
export const envKey = (name) => name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const asObject = (entry) => (typeof entry === "string" ? { name: entry } : entry);

function normalizeFormer(entry) {
  const raw = asObject(entry);
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("product.json: every formerNames entry needs a non-empty `name`.");
  }
  return {
    name,
    dirName: raw.dirName ?? name,
    storagePrefix: raw.storagePrefix ?? name,
    envPrefix: raw.envPrefix ?? name.toUpperCase().replace(/[^A-Z0-9]/g, "_"),
    symbolPrefix: raw.symbolPrefix ?? name,
    appId: raw.appId ?? undefined,
    urlScheme: raw.urlScheme ?? name,
  };
}

const REQUIRED = [
  "name",
  "displayName",
  "appId",
  "urlScheme",
  "envPrefix",
  "dirName",
  "storagePrefix",
  "symbolPrefix",
  "binary",
  "repository",
  "wireNamespace",
];

/**
 * Read and resolve product.json.
 *
 * Every rule that turns a written value into a derived one lives in this
 * function. If you find yourself writing `${name}-something` in a generator,
 * add it here instead — that is the difference between one edit and a sweep.
 */
export function readIdentity(path = productJsonPath) {
  /** @type {Record<string, any>} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `product.json could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}\n` +
        `It is the product's identity and nothing builds without it.`,
    );
  }

  const missing = REQUIRED.filter((field) => typeof raw[field] !== "string" || raw[field].trim() === "");
  if (missing.length > 0) {
    throw new Error(`product.json is missing ${missing.join(", ")}. Every field is required; none may be empty.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(raw.name)) {
    throw new Error(
      `product.json: "name" is ${JSON.stringify(raw.name)}. It becomes a directory name, a binary name and a URL ` +
        `scheme, so it must be lower case, start with a letter, and hold only letters, digits and hyphens.`,
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){2,}$/.test(raw.appId)) {
    throw new Error(
      `product.json: "appId" is ${JSON.stringify(raw.appId)}. macOS, Windows and freedesktop all want reverse-DNS ` +
        `with at least three segments, for example "dev.example.desktop".`,
    );
  }
  if (!/^[a-z][a-z0-9+.-]*$/.test(raw.urlScheme)) {
    throw new Error(`product.json: "urlScheme" is ${JSON.stringify(raw.urlScheme)}; RFC 3986 wants a-z 0-9 + . -.`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(raw.envPrefix)) {
    throw new Error(`product.json: "envPrefix" is ${JSON.stringify(raw.envPrefix)}; use A-Z, digits and underscores.`);
  }
  if (!/^[^/]+\/[^/]+$/.test(raw.repository)) {
    throw new Error(`product.json: "repository" is ${JSON.stringify(raw.repository)}; it must read owner/name.`);
  }

  const homepage = `https://github.com/${raw.repository}`;
  const expand = (value) =>
    String(value)
      .replaceAll("{name}", raw.name)
      .replaceAll("{displayName}", raw.displayName)
      .replaceAll("{binary}", raw.binary)
      .replaceAll("{scheme}", raw.urlScheme)
      .replaceAll("{appId}", raw.appId)
      .replaceAll("{repository}", raw.repository)
      .replaceAll("{homepage}", homepage);

  const env = Object.fromEntries(ENV_NAMES.map((name) => [envKey(name), `${raw.envPrefix}_${name}`]));
  const formerNames = (raw.formerNames ?? []).map(normalizeFormer);
  if (formerNames.some((former) => former.name === raw.name)) {
    throw new Error(`product.json: "${raw.name}" is listed in formerNames as well as being the current name.`);
  }

  return {
    name: raw.name,
    displayName: raw.displayName,
    appId: raw.appId,
    /** `dev.laser` — AppStream's developer id, the app id without its last segment. */
    developerId: raw.appId.split(".").slice(0, -1).join("."),
    urlScheme: raw.urlScheme,
    schemePrefix: `${raw.urlScheme}://`,
    /** Frozen on purpose; see product.json's "$wireNamespace". */
    wireNamespace: raw.wireNamespace ?? raw.name,
    envPrefix: raw.envPrefix,
    env,
    dirName: raw.dirName,
    storagePrefix: raw.storagePrefix,
    symbolPrefix: raw.symbolPrefix,
    binary: raw.binary,
    /** The real Electron binary, next to the launcher. See build/after-pack.cjs. */
    realBinary: `${raw.binary}-bin`,
    repository: raw.repository,
    repositoryOwner: raw.repository.split("/")[0],
    repositoryName: raw.repository.split("/")[1],
    homepage,
    issuesUrl: `${homepage}/issues`,
    vendor: expand(raw.vendor ?? `${raw.displayName} contributors`),
    maintainerEmail: raw.maintainerEmail ?? "",
    maintainer: raw.maintainerEmail
      ? `${expand(raw.vendor ?? `${raw.displayName} contributors`)} <${raw.maintainerEmail}>`
      : expand(raw.vendor ?? `${raw.displayName} contributors`),
    copyright: `Copyright © ${expand(raw.vendor ?? `${raw.displayName} contributors`)}`,

    formerNames,

    copy: Object.fromEntries(Object.entries(raw.copy ?? {}).map(([key, value]) => [key, expand(value)])),
    license: { project: raw.license?.project ?? "", metadata: raw.license?.metadata ?? "CC0-1.0" },
    categories: raw.categories ?? [],
    webCategories: raw.webCategories ?? [],
    keywords: raw.keywords ?? [],
    branding: raw.branding ?? {},
    iconSizes: raw.iconSizes ?? [],

    // Filenames that carry the name. Every consumer asks for these rather than
    // spelling them, which is why renaming does not leave a stale basename.
    /**
     * Every home-directory tree the product has ever owned, current name first,
     * as a POSIX-sh word list. install.sh's `--purge` walks it, so a person who
     * installed under an older name still has their data found and removed
     * rather than left behind for them to discover years later.
     */
    shellDataDirs: [raw.dirName, ...formerNames.map((former) => former.dirName)]
      .flatMap((dir) => [`"$HOME/.config/${dir}"`, `"$HOME/.local/share/${dir}"`, `"$HOME/.${dir}"`])
      .join(" "),

    /**
     * The vendor key install.sh stamps on a `.desktop` entry it wrote, so an
     * uninstall can tell its own entry from one a package manager owns.
     * Freedesktop reserves `X-`; the rest is the product name in TitleCase.
     */
    desktopInstalledByKey: `X-${raw.name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("")}-Installed-By`,

    desktopFileName: `${raw.binary}.desktop`,
    metainfoFileName: `${raw.appId}.metainfo.xml`,
    setupScriptName: `${raw.binary}-setup.sh`,
    installPrefixDirName: raw.binary,
  };
}

/** @typedef {ReturnType<typeof readIdentity>} Identity */

export const identity = readIdentity();
