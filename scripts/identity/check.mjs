#!/usr/bin/env node
/**
 * Fail the build the moment anything disagrees with product.json (MX-T7).
 *
 *   pnpm identity:check
 *
 * It runs inside `pnpm -r build` (as @lasercode/protocol's prebuild) and inside
 * `pnpm -r test`, so a hand-edited `appId` in electron-builder.yml, a stale
 * generated manifest, or a fresh `"laser"` typed into a component, all stop
 * the build with the file and line rather than shipping a product that answers
 * to two names.
 *
 * Two checks:
 *   1. Every generated file matches what product.json says it should be.
 *   2. No source file spells the product's name at all. The only places the
 *      name may appear are product.json, this directory, the templates' output,
 *      and prose (Markdown), which nothing reads at runtime.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { artifacts } from "./artifacts.mjs";
import { identity, repoRoot } from "./identity.mjs";
import { scannable } from "./scannable.mjs";

const problems = [];

// ---------------------------------------------------------------------------
// 1. Generated files match product.json.

for (const artifact of artifacts()) {
  const path = join(repoRoot, artifact.path);
  let onDisk;
  try {
    onDisk = readFileSync(path, "utf8");
  } catch {
    problems.push(`${artifact.path} is missing. It is generated from ${artifact.source}.`);
    continue;
  }
  if (onDisk !== artifact.contents) {
    problems.push(
      `${artifact.path} does not match ${artifact.source}.\n` +
        `    Either product.json changed and this was not regenerated, or this file was edited by hand.\n` +
        `    Edit ${artifact.source} (never ${artifact.path}) and run \`pnpm identity:generate\`.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Nothing else spells the name.
//
// Tracked and untracked, non-ignored source files. This catches a new file before
// its first commit; ignored build output remains invisible. Three things are
// deliberately not failures:
//
//   - Markdown, comments and identifiers. Prose for people and symbols inside a
//     private workspace; a stale sentence or an old type name after a rename is
//     a chore, not an install that cannot be upgraded. `scannable.mjs` decides
//     what counts, and for TypeScript that is string literals only.
//   - The npm scope `@<name>/…`. A workspace-internal module namespace that is
//     private, never published, and invisible to every installed copy.
//   - The generated files themselves, which check 1 already pins to product.json.

const EXEMPT_PATHS = new Set([
  // The generated files. They carry the name by construction, and check 1 above
  // already proves each one matches product.json byte for byte.
  ...artifacts().map((artifact) => artifact.path),
  "product.json",
  "scripts/identity/identity.mjs",
  "scripts/identity/artifacts.mjs",
  "scripts/identity/check.mjs",
  "scripts/identity/generate.mjs",
  "scripts/identity/template.mjs",
  "package.json", // the workspace root's own npm name
  "pnpm-lock.yaml",
  "skills-lock.json",
  // A reference vector, not a value the product reads. Its expected QR matrix
  // was cross-checked against a second encoder for one exact input string, so
  // changing the input to follow a rename would turn a correctness test into a
  // change detector. The URL inside it is test data and reaches nobody.
  "packages/cli/test/qr.test.ts",
]);

const EXEMPT_DIRS = [
  "docs/",
  ".agents/",
  ".github/ISSUE_TEMPLATE/",
  // The product's own project directory (`<project>/.<name>/`), which the app
  // writes into any project it opens — this repository included. It is data
  // the app derives from product.json, not source that spells the name; a
  // rename moves it with the product (D-36), and a developer's own settings
  // file must not fail their build.
  `.${identity.name}/`,
];

/**
 * Every name this product has answered to, current first.
 *
 * A check that only looked for today's name would be **green on a
 * half-finished rename**: rename `laser` to `wavelet`, regenerate, and every
 * `laser` still sitting in a component, a script or a packaging field would
 * pass unseen. The former names are exactly the ones a rename has to sweep, so
 * they are scanned too, and stay scanned until they are dropped from
 * product.json's `formerNames`.
 */
const NAMES = [identity.name, ...identity.formerNames.map((former) => former.name)];
const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY_NAME = NAMES.map(escape).join("|");

/** Every environment prefix, likewise: `LASER_UI_URL` must not survive a rename either. */
const ANY_ENV_PREFIX = [identity.envPrefix, ...identity.formerNames.map((former) => former.envPrefix)]
  .map(escape)
  .join("|");

/** `@lasercode/host`, `"@lasercode/protocol": "workspace:*"` — the npm scope, not the product. */
const SCOPE = new RegExp(`@(${ANY_NAME})(/[a-z0-9-]+)?`, "g");

/**
 * Wire identifiers, which are frozen on purpose and must survive a rename.
 *
 * `<ns>:panel`, `<ns>/panel/upsert`, `<ns>.channel.`, `<ns>-channel-v1` — the
 * Pi event bus, the session-message namespace, the relay's WebSocket
 * subprotocol and the HKDF labels that derive a paired device's keys. Renaming
 * those would make two already-paired peers derive different keys and simply
 * fail to connect, and would break every third-party extension that emits a
 * panel. product.json's `wireNamespace` says so, and today it happens to spell
 * the same word as `name`, so they are stripped before the scan rather than
 * reported as places that failed to derive.
 */
const WIRE = new RegExp(
  // Not preceded by `.`, `/` or a word character. Without this, `~/.laser/state`
  // — a hardcoded data directory, the single worst thing a rename can leave
  // behind — reads as the wire path `laser/state` and is stripped before the
  // scan ever sees it.
  `(?<![./\\w-])${escape(identity.wireNamespace)}(` +
    // `laser:panel`, `laser:panel:action`, `laser:window/state-changed`
    `:[a-z][a-z0-9-]*([:/][a-z][a-z0-9-]*)*` +
    // `laser/panel/upsert`, `laser/module/log` — segments, never a filename
    `|/[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*` +
    // `laser.channel.<id>`, `laser.transcribe.v1`
    `|\\.channel\\.|\\.[a-z-]+\\.v[0-9]+` +
    // the HKDF labels: `laser-channel-v1`, `laser-pairing-channel-v1`
    `|(-[a-z]+)*-v[0-9]+` +
    `)(?![a-z0-9])`,
  "g",
);

/**
 * Identifiers: the name glued to other identifier characters, as in
 * `LaserProvider`, `useLaserState`, `laserDataDir`, or a relative import
 * of a file named after one. They are symbols inside a private workspace with
 * no user-visible effect, so renaming them is a mechanical sweep rather than a
 * broken install — the same call as the npm scope.
 */
const IDENTIFIER = new RegExp(
  `\\b[A-Za-z0-9_$]*(${ANY_NAME})[A-Za-z0-9_$]+\\b|\\b[A-Za-z0-9_$]+(${ANY_NAME})[A-Za-z0-9_$]*\\b`,
  "gi",
);

/** `"./LaserProvider.js"` — a module specifier is the file's name, not the product's. */
const IMPORT_PATH = new RegExp(`["'\`]\\.{1,2}/[^"'\`]*(${ANY_NAME})[^"'\`]*["'\`]`, "gi");

/** An environment variable is always a finding, even though `_` looks like an identifier. */
const ENV_VAR = new RegExp(`\\b(${ANY_ENV_PREFIX})_[A-Z0-9_]+\\b`, "g");

/** Anything left after the exemptions above that still spells a name. */
const needle = new RegExp(ANY_NAME, "i");

/**
 * Repository source files, including untracked non-ignored files, or nothing.
 *
 * The scan needs git to know what is source and what is somebody's scratch
 * file. A source tarball has no git, and there the generated-file comparison
 * above is still the check that matters, so this degrades to "skip" with a line
 * saying so rather than failing a build for a missing tool.
 */
function repositoryFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    process.stdout.write("product identity: no git here, so only the generated files were checked.\n");
    return [];
  }
}

const strays = [];
for (const file of repositoryFiles()) {
  if (EXEMPT_PATHS.has(file)) continue;
  if (EXEMPT_DIRS.some((dir) => file.startsWith(dir))) continue;
  if (file.endsWith(".md")) continue;
  if (NAMES.some((name) => file.includes(name))) {
    strays.push({ file, line: 0, text: "the file name itself carries the product name" });
    continue;
  }
  let stat;
  try {
    stat = statSync(join(repoRoot, file));
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
  let text;
  try {
    text = readFileSync(join(repoRoot, file), "utf8");
  } catch {
    continue; // binary
  }
  if (text.includes("\0")) continue;
  scannable(file, text).split("\n").forEach((line, index) => {
    let rest = line.replace(SCOPE, "").replace(WIRE, "").replace(IMPORT_PATH, "");
    const envVars = rest.match(ENV_VAR) ?? [];
    rest = rest.replace(ENV_VAR, "").replace(IDENTIFIER, "");
    if (envVars.length === 0 && !needle.test(rest)) return;
    strays.push({ file, line: index + 1, text: line.trim().slice(0, 140) });
  });
}

if (strays.length > 0) {
  problems.push(
    `${strays.length} place${strays.length === 1 ? "" : "s"} still spell${strays.length === 1 ? "s" : ""} ` +
      `the product's name instead of deriving it from product.json:\n` +
      strays.map((stray) => `    ${stray.file}:${stray.line}  ${stray.text}`).join("\n") +
      `\n    TypeScript imports it from the protocol package's identity module; Node scripts from ` +
      `scripts/identity/identity.mjs; shell, YAML and the workflow get it through a .tpl.`,
  );
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  process.stderr.write(
    `\nproduct identity: ${problems.length} problem${problems.length === 1 ? "" : "s"}.\n\n` +
      problems.map((problem) => `  - ${problem}\n`).join("\n") +
      `\nproduct.json is the only place this product is named (MX-T7, D-36).\n\n`,
  );
  // `process.exit()` would truncate the write above: stderr to a pipe is
  // asynchronous, and this message is long.
  process.exitCode = 1;
} else {
  process.stdout.write(`product identity: ${identity.name} — every generated file agrees, no stray literals.\n`);
}
