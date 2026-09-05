/**
 * Everything that has to be true before electron-builder copies a single file.
 *
 * Three jobs, in the order a mistake here costs the most:
 *
 * 1. **Stage the right stock Node and its package manager**, downloading them
 *    if they are missing, and
 *    refuse to continue unless the binary on disk is the one `runtime.json`
 *    pins. electron-builder's `${platform}`/`${arch}` macros are not reliable
 *    enough to point `extraResources` at `runtime/<platform>-<arch>/` directly,
 *    and getting it wrong ships a macOS binary inside a Windows installer — a
 *    mistake nobody notices until the app will not start on a stranger's
 *    machine. So the target is resolved here, from the context electron-builder
 *    hands us, and copied to one fixed path the config can name literally.
 *
 * 2. **Refuse to ship a dependency tree the packager cannot see all of.** A
 *    dependency that only the *installer* knows about — pnpm's
 *    `packageExtensions`, an undeclared transitive import, a per-platform
 *    native binding — is invisible to electron-builder, which walks manifests.
 *    It installs fine, it develops fine, and the packaged app dies on its
 *    first import. That has happened here twice: the agent's own bundle
 *    imports `@earendil-works/pi-server` without declaring it, and
 *    `@napi-rs/keyring` reaches its native binding through a bare `require()`
 *    of a sibling package that pnpm resolves and electron-builder does not
 *    follow — the second one cost a twenty minute build and an app that would
 *    not start. The build now stops instead, and says exactly which package
 *    and exactly where to declare it.
 *
 * 3. **Configure Windows code signing from the environment** — present, and the
 *    installer is signed; absent, and it is an honest unsigned installer rather
 *    than a build that refuses to run.
 */
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { join, sep } = require("node:path");

/** electron-builder's Arch enum, which is an index rather than a name. */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

const AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Azure Trusted Signing, only when every value is there.
 *
 * electron-builder 26 reads the presence of `win.azureSignOptions` as "sign
 * this build" and errors out when the endpoint does not resolve — it does not
 * skip signing. So the block is written here at pack time instead of being
 * committed with placeholders, which would make `--win` fail on any machine
 * without Azure credentials instead of producing an unsigned installer.
 */
function configureWindowsSigning(context) {
  if (context.electronPlatformName !== "win32") return;
  const publisherName = process.env.PIORBIT_AZURE_PUBLISHER_NAME;
  const endpoint = process.env.PIORBIT_AZURE_ENDPOINT;
  const codeSigningAccountName = process.env.PIORBIT_AZURE_ACCOUNT;
  const certificateProfileName = process.env.PIORBIT_AZURE_PROFILE;
  const win = context.packager?.platformSpecificBuildOptions;
  if (!win) return;
  if (!publisherName || !endpoint || !codeSigningAccountName || !certificateProfileName) {
    console.log(
      "piorbit: no Azure Trusted Signing credentials in the environment; producing an UNSIGNED Windows installer. " +
        "Set PIORBIT_AZURE_PUBLISHER_NAME, PIORBIT_AZURE_ENDPOINT, PIORBIT_AZURE_ACCOUNT and PIORBIT_AZURE_PROFILE to sign it.",
    );
    return;
  }
  win.azureSignOptions = { publisherName, endpoint, codeSigningAccountName, certificateProfileName };
  console.log(`piorbit: signing with Azure Trusted Signing (${endpoint})`);
}

/** Every package directory under a `node_modules`, scoped names included. */
function packageNamesIn(modulesDir) {
  const names = [];
  let entries;
  try {
    entries = readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const child of readdirSync(join(modulesDir, entry.name), { withFileTypes: true })) {
        if (!child.name.startsWith(".")) names.push(`${entry.name}/${child.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The packages every workspace manifest declares. This is what electron-builder
 * walks, so it is the definition of "the packager can see it".
 */
function declaredAcrossWorkspace(packagesDir) {
  const declared = new Set();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
    }
  }
  return declared;
}

/**
 * Compare what the installer actually gave one package against what any
 * manifest declares. Anything in the first set and not the second exists on
 * this machine and will not exist in the package.
 *
 * Only meaningful under pnpm's virtual store, which is where the gap comes
 * from; under a flat installer there is nothing to compare and the artifact
 * check (`scripts/clean-machine.mjs`) is the backstop.
 *
 * `subject` names the package to inspect, `owner` the workspace package it is
 * installed under, and `declareIn` the manifest a person should add the missing
 * name to — that last one is the whole point of the message, because knowing a
 * package is missing is useless without knowing where to declare it.
 */
function assertTreeIsPackagable({ packagesDir, owner, subject, label, declareIn }) {
  const link = join(packagesDir, owner, "node_modules", ...subject.split("/"));
  if (!existsSync(link)) {
    throw new Error(
      `piorbit: ${label} (${subject}) is not installed under packages/${owner}, so there is nothing to package.\n` +
        `Run \`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install\` at the repository root.`,
    );
  }
  const dir = realpathSync(link);
  if (!dir.includes(`${sep}.pnpm${sep}`)) {
    console.log(`piorbit: not a pnpm virtual store; skipping the ${label} dependency-visibility check`);
    return;
  }

  const manifest = readJson(join(dir, "package.json"));
  const declaredBySubject = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  // `<store>/<id>/node_modules/<scope>/<name>` → the directory holding every
  // package the installer resolved for this one.
  const installed = packageNamesIn(join(dir, "..", ".."));
  const declaredByWorkspace = declaredAcrossWorkspace(packagesDir);

  const invisible = installed
    .filter((name) => name !== subject)
    .filter((name) => !declaredBySubject.has(name))
    .filter((name) => !declaredByWorkspace.has(name));

  if (invisible.length > 0) {
    throw new Error(
      `piorbit: ${label} needs ${invisible.join(", ")}, which the installer supplies but no manifest declares.\n` +
        `electron-builder walks manifests, so ${invisible.length === 1 ? "it" : "they"} would be missing from the ` +
        `packaged app and it would fail at runtime.\n` +
        `Fix: add ${invisible.map((name) => `"${name}": "<exact version>"`).join(", ")} to the dependencies of ` +
        `${declareIn}, then run \`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install\`.`,
    );
  }
  console.log(`piorbit: ${label} dependency tree is fully declared (${installed.length} packages)`);
}

/**
 * The one thing the tree walk above cannot see: a package that resolves a
 * per-platform sibling with a bare `require()` at runtime. pnpm installs only
 * the binding for the machine it is running on, so the *store* is right and the
 * *manifest* is what has to name it — and it has to name the binding for the
 * platform being built, not the platform building it.
 */
function assertNativeBindingIsStaged(packageRoot, platform, arch) {
  const manifest = readJson(join(packageRoot, "package.json"));
  const declared = Object.keys(manifest.optionalDependencies ?? {});
  const suffix = { darwin: `darwin-${arch}`, win32: `win32-${arch}-msvc`, linux: `linux-${arch}-gnu` }[platform];
  const wanted = declared.filter((name) => name.endsWith(suffix));
  if (wanted.length === 0) {
    throw new Error(
      `piorbit: packages/desktop declares no native binding for ${platform}-${arch}.\n` +
        `The keychain is loaded from @napi-rs/keyring-${suffix}, and without it the app will not start.\n` +
        `Fix: add "@napi-rs/keyring-${suffix}" to the optionalDependencies of packages/desktop/package.json ` +
        `with the same exact version as "@napi-rs/keyring".`,
    );
  }
  for (const name of wanted) {
    if (!existsSync(join(packageRoot, "node_modules", ...name.split("/")))) {
      throw new Error(
        `piorbit: ${name} is declared but not installed, so the packaged app would have no keychain binding ` +
          `and would fail at startup with "Cannot find native binding".\n` +
          `This is what a cross-architecture build looks like: pnpm installs only the binding matching the ` +
          `machine it ran on. Build ${arch} on ${arch} hardware, or run ` +
          `\`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install\` on an ${arch} machine.`,
      );
    }
  }
  console.log(`piorbit: native keychain binding for ${platform}-${arch} is declared and installed (${wanted.join(", ")})`);
}

/**
 * The staged Node is the pinned Node.
 *
 * `fetch-node.mjs` verifies the downloaded archive against the hash committed
 * in `runtime.json`, extracts it, and records both that archive hash and the
 * SHA-256 of the binary it produced. This re-reads the stamp *and re-hashes the
 * binary*, so a file that was hand-placed, half-copied, or left behind by an
 * older pin fails the build rather than shipping — reading the note beside the
 * binary would have proved only that the note was written.
 */
function assertStagedRuntimeIsPinned(packageRoot, target, binary) {
  const pin = readJson(join(packageRoot, "runtime.json"));
  const spec = pin.targets[target];
  if (!spec) {
    throw new Error(
      `piorbit: no Node runtime is pinned for ${target}.\n` +
        `Pinned targets: ${Object.keys(pin.targets).join(", ")}. Add one to runtime.json with its hash from ` +
        `https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt.`,
    );
  }
  const npmCli = join(packageRoot, "runtime", target, "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) {
    throw new Error(
      `piorbit: the Node runtime staged for ${target} has no package manager beside it.\n` +
        `piorbit installs extensions from Settings, and a person who installed the app has no npm on PATH — ` +
        `so it ships the one out of the Node archive it already verified.\n` +
        `Fix: delete packages/desktop/runtime/${target} and run \`pnpm -F @piorbit/desktop runtime -- --target ${target}\`.`,
    );
  }
  const stampPath = join(packageRoot, "runtime", target, ".pin.json");
  if (!existsSync(stampPath)) {
    throw new Error(
      `piorbit: the Node runtime staged for ${target} has no provenance stamp, so nothing proves it is the pinned one.\n` +
        `Fix: delete packages/desktop/runtime/${target} and run \`pnpm -F @piorbit/desktop runtime -- --target ${target}\`.`,
    );
  }
  const stamp = readJson(stampPath);
  if (stamp.version !== pin.version || stamp.sha256 !== spec.sha256) {
    throw new Error(
      `piorbit: the Node runtime staged for ${target} is node ${stamp.version} (${stamp.sha256.slice(0, 12)}…), ` +
        `but runtime.json pins ${pin.version} (${spec.sha256.slice(0, 12)}…).\n` +
        `Fix: delete packages/desktop/runtime/${target} and run \`pnpm -F @piorbit/desktop runtime -- --target ${target}\`.`,
    );
  }
  const binaryPath = join(packageRoot, "runtime", target, binary);
  if (typeof stamp.binarySha256 !== "string" || stamp.binarySha256 === "") {
    throw new Error(
      `piorbit: the Node runtime staged for ${target} was written by an older fetch-node.mjs that did not record ` +
        `the binary's own hash, so nothing here can prove the file is the one that came out of the pinned archive.\n` +
        `Fix: delete packages/desktop/runtime/${target} and run \`pnpm -F @piorbit/desktop runtime -- --target ${target}\`.`,
    );
  }
  const actual = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actual !== stamp.binarySha256) {
    throw new Error(
      `piorbit: ${binaryPath} is not the binary that was extracted from the pinned Node archive.\n` +
        `  expected  ${stamp.binarySha256}\n` +
        `  got       ${actual}\n` +
        `Something replaced or truncated it after it was fetched. This build would have shipped that file to ` +
        `everyone who installs piorbit.\n` +
        `Fix: delete packages/desktop/runtime/${target} and run \`pnpm -F @piorbit/desktop runtime -- --target ${target}\`.`,
    );
  }
  console.log(`piorbit: staged node ${pin.version} for ${target}, binary re-hashed and matching the pinned archive`);
  return binary;
}

exports.default = async function beforePack(context) {
  const packageRoot = join(__dirname, "..");
  configureWindowsSigning(context);
  const platform = context.electronPlatformName; // "darwin" | "win32" | "linux"
  const arch = ARCH_NAMES[context.arch] ?? "x64";

  if (arch === "universal") {
    // A universal macOS app would need a `lipo`-merged node. We ship separate
    // arm64 and x64 builds instead, which is also what the update feed expects.
    throw new Error(
      "piorbit does not build a universal macOS app: build arm64 and x64 separately so each ships its own Node.",
    );
  }

  assertTreeIsPackagable({
    packagesDir: join(packageRoot, ".."),
    owner: "worker",
    subject: AGENT_PACKAGE,
    label: "the agent",
    declareIn: "packages/worker/package.json",
  });
  assertTreeIsPackagable({
    packagesDir: join(packageRoot, ".."),
    owner: "desktop",
    subject: "@napi-rs/keyring",
    label: "the keychain",
    declareIn: "packages/desktop/package.json",
  });
  assertNativeBindingIsStaged(packageRoot, platform, arch);

  const target = `${platform}-${arch}`;
  const binary = platform === "win32" ? "node.exe" : "node";
  const source = join(packageRoot, "runtime", target, binary);

  if (!existsSync(source)) {
    console.log(`piorbit: fetching the pinned Node runtime for ${target}`);
    execFileSync(process.execPath, [join(packageRoot, "scripts", "fetch-node.mjs"), "--target", target], {
      stdio: "inherit",
      cwd: packageRoot,
    });
  }
  if (!existsSync(source)) {
    throw new Error(`piorbit: no Node runtime at ${source}. Run \`pnpm -F @piorbit/desktop runtime\`.`);
  }
  assertStagedRuntimeIsPinned(packageRoot, target, binary);

  // One fixed staging directory, cleaned each time, so a previous platform's
  // binary can never survive into this build.
  const staging = join(packageRoot, "build", "runtime");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  copyFileSync(source, join(staging, binary));
  // The package manager, beside the runtime. `host-process.ts` points
  // PIORBIT_NPM_CLI at it, which is how Settings installs an extension on a
  // machine that has never had Node on it.
  cpSync(join(packageRoot, "runtime", target, "npm"), join(staging, "npm"), { recursive: true });
  console.log(`piorbit: staged ${target} node and its package manager for packaging`);
};
