/**
 * The product's identity, for TypeScript (MX-T7, D-36).
 *
 * "piorbit" is a working name. The product may be renamed and moved to another
 * repository, and nothing may treat the current name as fixed — so no package
 * writes it. Everything derives from `product.json` at the repository root,
 * through the generated `product.generated.ts` next door and this module's
 * derived constants and helpers.
 *
 * Why it lives in `@lasercode/protocol`: it is the one package every other
 * package already depends on, and it imports nothing. The host, the worker, the
 * CLI, the desktop shell and the browser bundle all get the same answer, which
 * is the point — a window and a terminal that disagree about the data directory
 * show one person two different session lists with nothing on screen to explain
 * why.
 *
 * The rules:
 *
 * - Never write the product's name in a source file. Import it from here.
 * - Never write an environment variable's name. Use `ENV`.
 * - Never write a browser storage key, a `Symbol.for` key or a directory name.
 *   Use `storageKey`, `dottedStorageKey`, `symbolKey`, `dataDirName`.
 * - Renaming is one edit to `product.json` plus `pnpm identity:generate`. If it
 *   ever needs a second edit, that is a bug in this module or in the check.
 *
 * The rename is nearly free today and stops being free the moment somebody
 * installs a build: `appId` keys macOS TCC permission grants, the Windows
 * notification centre and the update feed's identity, so a rename afterwards is
 * a different application rather than an upgrade — the microphone permission is
 * lost and the old install is orphaned. The same is true of the config and state
 * directories, the URL scheme and every browser storage key. `FORMER_NAMES`
 * plus the host's identity migration is what makes a later rename survivable
 * anyway.
 */
import { ENV, PRODUCT } from "./product.generated.js";

export { ENV, PRODUCT };
export type { EnvName, Product } from "./product.generated.js";

/** The name in prose, in paths and in filenames: lower case, no spaces. */
export const PRODUCT_NAME: string = PRODUCT.name;

/** What a person is shown. Today the same word; a rename may capitalise it. */
export const PRODUCT_DISPLAY_NAME: string = PRODUCT.displayName;

/**
 * The reverse-DNS application id.
 *
 * macOS keys TCC permission grants on it, Windows keys the notification centre
 * and the taskbar identity on it, freedesktop keys the AppStream component on
 * it, and an update feed keys "is this the same application" on it.
 */
export const APP_ID: string = PRODUCT.appId;

/** The app id without its last segment — AppStream's `<developer id>`. */
export const APP_DEVELOPER_ID: string = PRODUCT.developerId;

/** The one URL scheme the app answers to, without punctuation. */
export const URL_SCHEME: string = PRODUCT.urlScheme;

/** `piorbit://` — the prefix a deep link starts with. */
export const URL_SCHEME_PREFIX = `${PRODUCT.urlScheme}://`;

/**
 * The namespace on every wire contract — and the one value here that a rename
 * must **not** change.
 *
 * It spells the relay's WebSocket subprotocol (`<ns>.channel.<id>`), the Pi
 * event-bus events the companion extension listens on (`<ns>:panel`), the
 * `<ns>/…` session-message types, the HKDF labels that derive a paired device's
 * channel keys, and the marker written into pi-subagents' control files.
 * Renaming those would make two already-paired peers derive different keys and
 * fail to connect with nothing to explain why, and would break every
 * third-party extension that emits a panel.
 *
 * Its type is the literal, not `string`, so it can appear in a discriminated
 * union: `source: typeof WIRE_NAMESPACE | "extension"`.
 */
export const WIRE_NAMESPACE = PRODUCT.wireNamespace;

/** The prefix on every environment variable the product reads. */
export const ENV_PREFIX: string = PRODUCT.envPrefix;

/** The one directory the product owns, under each platform's data root. */
export const DATA_DIR_NAME: string = PRODUCT.dirName;

/** The prefix on every `localStorage`, `sessionStorage` and Cache Storage key. */
export const STORAGE_PREFIX: string = PRODUCT.storagePrefix;

/** The prefix on every cross-realm `Symbol.for` key. */
export const SYMBOL_PREFIX: string = PRODUCT.symbolPrefix;

/** The command on PATH, the icon name and the `.desktop` basename. */
export const BINARY_NAME: string = PRODUCT.binary;

/** Electron's own executable, renamed so the launcher can take its place. */
export const REAL_BINARY_NAME: string = PRODUCT.realBinary;

export const REPOSITORY: string = PRODUCT.repository;
export const HOMEPAGE: string = PRODUCT.homepage;
export const ISSUES_URL: string = PRODUCT.issuesUrl;
export const VENDOR: string = PRODUCT.vendor;

/** The product copy, expanded. `copy.summary` is the one-line description. */
export const PRODUCT_COPY = PRODUCT.copy;

/** The `.desktop` basename and the AppStream metainfo basename. */
export const DESKTOP_FILE_NAME: string = PRODUCT.desktopFileName;
export const METAINFO_FILE_NAME: string = PRODUCT.metainfoFileName;

/** One identity the product used to answer to. */
export interface FormerIdentity {
  readonly name: string;
  readonly dirName: string;
  readonly storagePrefix: string;
  readonly envPrefix: string;
  readonly symbolPrefix: string;
  readonly urlScheme: string;
}

/**
 * Every identity the product has answered to before, newest first.
 *
 * Typed as an array rather than left as the generated tuple so that an empty
 * list still gives `FormerIdentity` to whatever iterates it. The host moves
 * directories named here on start; the browser moves storage keys.
 */
export const FORMER_NAMES: readonly FormerIdentity[] = PRODUCT.formerNames;

// ---------------------------------------------------------------------------
// Helpers. Everything below composes a name; nothing below writes one.

/** `PIORBIT_FOO` from `FOO`, for a variable not in `ENV` (a test, a probe). */
export function envVar(suffix: string): string {
  return `${PRODUCT.envPrefix}_${suffix}`;
}

/**
 * Read one of the product's variables, falling back to a former name's prefix.
 *
 * A person who set `OLDNAME_AGENT_DIR` in their shell profile before a rename
 * keeps working, and the app can say which spelling it honoured. An empty or
 * whitespace-only value counts as unset, because that is what a shell leaves
 * behind when a variable is exported and never assigned.
 */
export function readEnv(
  env: Record<string, string | undefined>,
  suffix: string,
): { value: string; variable: string } | undefined {
  for (const prefix of [PRODUCT.envPrefix, ...FORMER_NAMES.map((former) => former.envPrefix)]) {
    const variable = `${prefix}_${suffix}`;
    const value = (env[variable] ?? "").trim();
    if (value !== "") return { value, variable };
  }
  return undefined;
}

/**
 * `piorbit-panels` — the product's hyphenated namespace.
 *
 * Everything a browser keys by name goes through this: `localStorage` keys,
 * Cache Storage names, the id of a `<style>` element the app owns, the name it
 * gives a popped-out window. One prefix, so a rename moves all of them and the
 * migration has one list to walk.
 */
export function namespaced(suffix: string): string {
  return `${PRODUCT.storagePrefix}-${suffix}`;
}

/** `piorbit-panels` — a hyphenated browser storage key. */
export const storageKey = namespaced;

/** `piorbit.theme` — a dotted browser storage key, for the ones already dotted. */
export function dottedStorageKey(suffix: string): string {
  return `${PRODUCT.storagePrefix}.${suffix}`;
}

/**
 * The same key under every name the product has had, newest first.
 *
 * The browser's storage migration walks this so a person who used the app under
 * an older name keeps their theme, their collapsed panels and their drafts.
 */
export function storageKeyHistory(suffix: string, separator: "-" | "." = "-"): string[] {
  return [PRODUCT.storagePrefix, ...FORMER_NAMES.map((former) => former.storagePrefix)].map(
    (prefix) => `${prefix}${separator}${suffix}`,
  );
}

/** `piorbit.transcribe.v1` — a cross-realm `Symbol.for` key. */
export function symbolKey(suffix: string): string {
  return `${PRODUCT.symbolPrefix}.${suffix}`;
}

/** `piorbit://open` — build a deep link. `rest` is already encoded. */
export function schemeUrl(rest: string): string {
  return `${URL_SCHEME_PREFIX}${rest}`;
}

/** True when a string is one of this product's deep links, current or former. */
export function isProductUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return [PRODUCT.urlScheme, ...FORMER_NAMES.map((former) => former.urlScheme)].some((scheme) =>
    lower.startsWith(`${scheme}://`),
  );
}
