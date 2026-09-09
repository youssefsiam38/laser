/**
 * Every file that carries the product's name, and how it is produced (MX-T7).
 *
 * One list, two readers: `generate.mjs` writes it, `check.mjs` compares it
 * against what is on disk and fails the build on any difference. Adding a file
 * that names the product means adding it here — that is the whole contract.
 *
 * An artifact is `{ path, contents, kind }`:
 *   - `kind: "committed"` lives in git, so a stale copy is a visible diff.
 *   - `kind: "built"` is generated into an ignored directory on every build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ENV_NAMES, envKey, identity, repoRoot } from "./identity.mjs";
import { renderTemplate } from "./template.mjs";

const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");

/**
 * The TypeScript view of product.json.
 *
 * Emitted rather than imported so that `tsc`, `vite`, `vitest` and the browser
 * all see the same values with no JSON-module resolution, no bundler plugin and
 * no runtime file read. `identity.ts` is the hand-written half that derives from
 * it; nothing else in TypeScript may name the product.
 */
function productModule() {
  const shape = {
    name: identity.name,
    displayName: identity.displayName,
    appId: identity.appId,
    developerId: identity.developerId,
    urlScheme: identity.urlScheme,
    /**
     * Frozen on purpose: the namespace on every wire contract. A rename must
     * not change it. See product.json's "$wireNamespace".
     */
    wireNamespace: identity.wireNamespace,
    envPrefix: identity.envPrefix,
    dirName: identity.dirName,
    storagePrefix: identity.storagePrefix,
    symbolPrefix: identity.symbolPrefix,
    binary: identity.binary,
    realBinary: identity.realBinary,
    repository: identity.repository,
    homepage: identity.homepage,
    issuesUrl: identity.issuesUrl,
    vendor: identity.vendor,
    copy: identity.copy,
    branding: identity.branding,
    desktopFileName: identity.desktopFileName,
    metainfoFileName: identity.metainfoFileName,
    /**
     * Identities this product has answered to before, newest first. A person
     * who installed under one of these keeps their directories and their
     * browser storage; see packages/host/src/identity-migration.ts.
     */
    formerNames: identity.formerNames.map((former) => ({
      name: former.name,
      dirName: former.dirName,
      storagePrefix: former.storagePrefix,
      envPrefix: former.envPrefix,
      symbolPrefix: former.symbolPrefix,
      urlScheme: former.urlScheme,
    })),
  };
  const env = Object.fromEntries(ENV_NAMES.map((name) => [envKey(name), `${identity.envPrefix}_${name}`]));
  return `/**
 * GENERATED from product.json by \`pnpm identity:generate\`. Do not edit.
 *
 * \`pnpm identity:check\` runs inside \`pnpm -r build\` and \`pnpm -r test\` and
 * fails if this file and product.json disagree, so an edit here is caught
 * rather than shipped. The derived constants every package imports live next
 * door in \`identity.ts\`; this file holds only what product.json said.
 */

export const PRODUCT = ${JSON.stringify(shape, null, 2)} as const;

/** Build identity, captured in code so replacing installed files cannot change a running process. */
export const PRODUCT_VERSION: string = ${JSON.stringify(JSON.parse(read("package.json")).version)};

/**
 * Every environment variable the product reads, by its unprefixed name.
 *
 * Emitted rather than composed at runtime so that the full name is a literal
 * type: \`ENV.agentDir\` is \`"${env.agentDir}"\`, and a typo is a compile error
 * rather than a variable nobody sets.
 */
export const ENV = ${JSON.stringify(env, null, 2)} as const;

export type Product = typeof PRODUCT;
export type EnvName = keyof typeof ENV;
`;
}

/** The PWA manifest. Browsers key an installed app on `id` and `scope`. */
function webManifest() {
  return renderTemplate(
    read("packages", "ui", "public", "manifest.webmanifest.tpl"),
    identity,
    "manifest.webmanifest.tpl",
  );
}

/**
 * The identity as POSIX shell variables, for the repository's own scripts.
 *
 * `install.sh` cannot use it — it is downloaded on its own and has to be one
 * file — so that one is rendered from a template instead. Everything under
 * `scripts/` and every build script sources this.
 */
function shellIdentity() {
  const lines = [
    ["product_name", identity.name],
    ["product_display", identity.displayName],
    ["product_binary", identity.binary],
    ["product_real_binary", identity.realBinary],
    ["product_app_id", identity.appId],
    ["product_scheme", identity.urlScheme],
    ["product_dir", identity.dirName],
    ["product_env_prefix", identity.envPrefix],
    ["product_repo", identity.repository],
    ["product_desktop_file", identity.desktopFileName],
    ["product_metainfo_file", identity.metainfoFileName],
    ["product_setup_script", identity.setupScriptName],
  ];
  return `# GENERATED from product.json by \`pnpm identity:generate\`. Do not edit.
#
# Source it from any script in this repository:
#
#     . "$(dirname "$0")/../identity/identity.sh"
#
# install.sh deliberately does NOT source this: it is downloaded on its own and
# has to be a single file, so it is rendered from install.sh.tpl instead.

${lines.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}
`;
}

/**
 * A package.json's identity fields, rewritten in place.
 *
 * A manifest cannot be generated whole — its dependencies, its version and its
 * scripts are edited by people and by pnpm — so only the keys that carry the
 * name are rewritten, textually, leaving key order and formatting alone. These
 * are the fields an installed copy can see: the command on PATH and the
 * `.desktop` basename that Electron uses for its own Wayland app_id.
 */
function manifestFields(relativePath, edits) {
  let text = read(...relativePath.split("/"));
  for (const [pattern, replacement] of edits) {
    if (!pattern.test(text)) {
      throw new Error(
        `${relativePath}: expected ${pattern} and did not find it. The identity fields moved; ` +
          `update scripts/identity/artifacts.mjs so the rename still reaches them.`,
      );
    }
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Replace a marked block inside a hand-written file.
 *
 * `manifestFields` edits a value; this edits a region, for the one file that
 * needs generated *code* and cannot import it (the sandboxed preload). The
 * markers stay in the file so the next person can see the region is written
 * from `product.json`, not by hand.
 */
function inlineBlock(relativePath, label, block) {
  const text = read(...relativePath.split("/"));
  const begin = `// <generated: ${label}>`;
  const end = `// </generated: ${label}>`;
  const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (!pattern.test(text)) {
    throw new Error(
      `${relativePath}: expected the ${begin} … ${end} markers and did not find them. ` +
        `Restore them, or drop this artifact from scripts/identity/artifacts.mjs.`,
    );
  }
  return text.replace(pattern, `${begin}\n${block}\n${end}`);
}

/** Everything generated from product.json, in the order a person would read it. */

/**
 * The Electron IPC channel table.
 *
 * Emitted as CommonJS because the preload is a `.cts` and cannot import the
 * ESM one, and duplicating the table by hand is how `laser:identity` survived
 * a rename that changed the other twenty channels. One generated file, imported
 * by both sides.
 *
 * These are internal to a single build — main and renderer ship together and no
 * channel name is ever persisted — so unlike the wire namespace they follow the
 * product when it is renamed.
 */
function ipcModule() {
  const channels = [
    ["hostInfo", "host/info"], ["hostChanged", "host/changed"], ["hostRetry", "host/retry"],
    ["deepLink", "deep-link"], ["deepLinkPending", "deep-link/pending"],
    ["windowMinimize", "window/minimize"], ["windowToggleMaximize", "window/toggle-maximize"],
    ["windowClose", "window/close"], ["windowState", "window/state"],
    ["windowStateChanged", "window/state-changed"],
    ["themeSet", "theme/set"],
    ["directorySelect", "directory/select"],
    ["sourceFileOpen", "source-file/open"],
    ["microphoneStatus", "microphone/status"], ["microphoneRequest", "microphone/request"],
    ["microphoneSettings", "microphone/settings"],
    ["identity", "identity"],
    ["updateStatus", "update/status"], ["updateCheck", "update/check"],
    ["updateInstall", "update/install"], ["updateChanged", "update/changed"],
  ];
  const body = channels
    .map(([key, suffix]) => `  ${key}: "${identity.name}:${suffix}",`)
    .join("\n");
  const head = [
    "// Generated by scripts/identity/generate.mjs from product.json. Do not edit.",
    "// The channel names both the main process and the preload use.",
    "",
  ];
  // Two spellings of one table. The preload is CommonJS and cannot import the
  // ESM module, so rather than let someone copy the list by hand again — which
  // is how one channel survived a rename — both are generated from this array.
  const esm = [...head, "export const IPC = {", body, "} as const;", "",
    "export type IpcChannel = (typeof IPC)[keyof typeof IPC];", ""].join("\n");
  // The same table as statements, for inlining into a file that cannot import it.
  const block = ["const IPC = {", body, "} as const;"].join("\n");
  const cjs = [...head, "const IPC = {", body, "} as const;", "",
    "type IpcChannel = (typeof IPC)[keyof typeof IPC];", "",
    "export = { IPC } as { IPC: typeof IPC & Record<string, IpcChannel> };", ""].join("\n");
  return { esm, cjs, block };
}

export function artifacts() {
  return [
    {
      path: join("packages", "desktop", "src", "ipc.generated.ts"),
      contents: ipcModule().esm,
      kind: "committed",
    },
    {
      path: join("packages", "desktop", "src", "ipc.generated.cts"),
      contents: ipcModule().cjs,
      kind: "committed",
    },
    {
      // The preload cannot `require` a sibling file: a sandboxed preload's
      // `require` resolves `electron` and a few Node builtins and nothing else,
      // so a relative specifier fails at load time and the whole bridge is
      // silently absent from the window. The channel table is therefore written
      // *into* the preload, between the markers below, and stays generated.
      path: join("packages", "desktop", "src", "preload.cts"),
      contents: inlineBlock(
        join("packages", "desktop", "src", "preload.cts"),
        "IPC CHANNELS",
        ipcModule().block,
      ),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "package.json",
      contents: manifestFields("package.json", [[/("name":\s*)"[^"]*"/, `$1${JSON.stringify(identity.name)}`]]),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/cli/package.json",
      contents: manifestFields("packages/cli/package.json", [
        [/("bin":\s*\{\s*)"[^"]*"/, `$1${JSON.stringify(identity.binary)}`],
      ]),
      kind: "committed",
      source: "product.json",
    },
    {
      // Internal, never spawned by name — but a manifest that still says
      // `laser-host` after a rename is the product answering to two names,
      // and the check cannot see a field it does not generate.
      path: "packages/host/package.json",
      contents: manifestFields("packages/host/package.json", [
        [/("bin":\s*\{\s*)"[^"]*"/, `$1${JSON.stringify(`${identity.binary}-host`)}`],
      ]),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/worker/package.json",
      contents: manifestFields("packages/worker/package.json", [
        [/("bin":\s*\{\s*)"[^"]*"/, `$1${JSON.stringify(`${identity.binary}-worker`)}`],
      ]),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/relay/package.json",
      contents: manifestFields("packages/relay/package.json", [
        [/("bin":\s*\{\s*)"[^"]*"/, `$1${JSON.stringify(`${identity.binary}-relay`)}`],
      ]),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/desktop/package.json",
      contents: manifestFields("packages/desktop/package.json", [
        [/("homepage":\s*)"[^"]*"/, `$1${JSON.stringify(identity.homepage)}`],
        [/("desktopName":\s*)"[^"]*"/, `$1${JSON.stringify(identity.desktopFileName)}`],
      ]),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/protocol/src/product.generated.ts",
      contents: productModule(),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/ui/public/manifest.webmanifest",
      contents: webManifest(),
      kind: "committed",
      source: "packages/ui/public/manifest.webmanifest.tpl",
    },
    {
      path: "packages/desktop/electron-builder.yml",
      contents: renderTemplate(
        read("packages", "desktop", "electron-builder.yml.tpl"),
        identity,
        "electron-builder.yml.tpl",
      ),
      kind: "committed",
      source: "packages/desktop/electron-builder.yml.tpl",
    },
    {
      path: ".github/workflows/release.yml",
      contents: renderTemplate(read(".github", "workflows", "release.yml.tpl"), identity, "release.yml.tpl"),
      kind: "committed",
      source: ".github/workflows/release.yml.tpl",
    },
    {
      path: "scripts/identity/identity.sh",
      contents: shellIdentity(),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "packages/desktop/build/linux/after-install.sh",
      contents: manifestFields("packages/desktop/build/linux/after-install.sh", [
        [/REPO_OWNER='[^']*'/, `REPO_OWNER='${identity.repository.split("/")[0]}'`],
        [/REPO_NAME='[^']*'/, `REPO_NAME='${identity.repository.split("/")[1]}'`],
      ]),
      kind: "committed",
      source: "product.json",
    },
    {
      path: "install.sh",
      contents: renderTemplate(read("install.sh.tpl"), identity, "install.sh.tpl"),
      kind: "committed",
      source: "install.sh.tpl",
      mode: 0o755,
    },
  ];
}
