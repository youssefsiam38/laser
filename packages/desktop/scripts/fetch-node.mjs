#!/usr/bin/env node
/**
 * Put a stock Node binary — and the package manager that ships with it — in
 * `packages/desktop/runtime/<platform>-<arch>/` so the packaged app can spawn
 * the host from a real `node` (M5-T2) and install extensions from Settings on a
 * machine with nothing on PATH (M10-T5).
 *
 * Why a second Node next to Electron's:
 *   - `process.execPath` inside the host must be a node binary, because Pi and
 *     MCP servers spawn children with it (`npx`, stdio servers). Electron's
 *     execPath is the app, and the `runAsNode` fuse that would make it behave
 *     like node is exactly the fuse we want off.
 *   - a stock binary means no ABI rebuild for anything native, and no
 *     `utilityProcess` (which has no stdin, which the worker pipe needs).
 *   - it cannot live inside `app.asar`: an archive is not a file a kernel can
 *     execute, so electron-builder unpacks `runtime/`.
 *
 * And why the package manager comes out of the same archive: Settings installs
 * extensions, which needs one, and a person who installed a desktop app has no
 * npm on PATH and must never be told to go and get one. Taking it from the Node
 * archive means it is covered by the hash already pinned in `runtime.json` —
 * one download, one check, nothing else to trust.
 *
 * Downloads are verified against the hashes committed in `runtime.json`, not
 * against a checksum file fetched at the same time from the same host.
 *
 * Usage:
 *   node scripts/fetch-node.mjs                 every target in runtime.json
 *   node scripts/fetch-node.mjs --current       just this machine's target
 *   node scripts/fetch-node.mjs --target linux-x64 --target darwin-arm64
 *   node scripts/fetch-node.mjs --current --verify   run it and print execPath
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const runtimeDir = join(packageRoot, "runtime");
const cacheDir = join(runtimeDir, ".cache");
const pin = JSON.parse(readFileSync(join(packageRoot, "runtime.json"), "utf8"));

const BASE_URL = process.env["PIORBIT_NODE_MIRROR"] ?? "https://nodejs.org/dist";

function currentTarget() {
  return `${process.platform}-${process.arch}`;
}

function parseArgv(argv) {
  const targets = [];
  let verify = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run runtime -- --target linux-x64` forwards the separator itself,
    // and every "Fix:" message in this repo tells people to type that form.
    if (arg === "--") continue;
    if (arg === "--current") targets.push(currentTarget());
    else if (arg === "--verify") verify = true;
    else if (arg === "--target") {
      const value = argv[++i];
      if (!value) fail("--target needs a value, for example --target linux-x64");
      targets.push(value);
    } else if (arg.startsWith("--target=")) targets.push(arg.slice("--target=".length));
    else fail(`unknown argument ${arg}`);
  }
  return { targets: targets.length > 0 ? [...new Set(targets)] : Object.keys(pin.targets), verify };
}

function fail(message, fix) {
  process.stderr.write(`\npiorbit runtime: ${message}\n`);
  if (fix) process.stderr.write(`${fix}\n`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    fail(
      `downloading ${url} answered ${response.status} ${response.statusText}`,
      "Check the network, or set PIORBIT_NODE_MIRROR to a mirror of https://nodejs.org/dist.",
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The archive, from the cache when its hash already matches the pin. */
async function archiveFor(target, spec) {
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, spec.archive);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (sha256(bytes) === spec.sha256) return bytes;
    rmSync(cached, { force: true });
  }
  const url = `${BASE_URL}/v${pin.version}/${spec.archive}`;
  process.stdout.write(`  downloading ${spec.archive}\n`);
  const bytes = await download(url);
  const digest = sha256(bytes);
  if (digest !== spec.sha256) {
    fail(
      `${spec.archive} does not match the hash pinned for ${target}`,
      `  expected ${spec.sha256}\n  got      ${digest}\n` +
        `Nothing was written. If you meant to move to a new Node, update runtime.json from\n` +
        `https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt first.`,
    );
  }
  writeFileSync(cached, bytes);
  return bytes;
}

/** `tar` handles .tar.gz and .tar.xz; both ship on macOS and Linux build hosts. */
function extractTar(archivePath, member, destination) {
  const stripComponents = member.split("/").length - 1; // "<dir>/bin/node" -> strip 2, land on "node"
  try {
    execFileSync(
      "tar",
      ["-xf", archivePath, "-C", dirname(destination), `--strip-components=${stripComponents}`, member],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : String(error?.message ?? error);
    fail(
      `could not extract ${member} from ${archivePath}: ${detail}`,
      archivePath.endsWith(".xz")
        ? "This needs a tar that can read .xz (GNU tar with xz-utils, or bsdtar)."
        : "This needs `tar` on PATH.",
    );
  }
  const extracted = join(dirname(destination), member.slice(member.lastIndexOf("/") + 1));
  if (extracted !== destination) renameSync(extracted, destination);
}

/**
 * One member out of a zip, without a zip dependency. Node's Windows builds use
 * store (0) or deflate (8) only, which is the whole format we need.
 */
function findEocd(bytes) {
  const eocdSignature = 0x06054b50;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xffff; i--) {
    if (bytes.readUInt32LE(i) === eocdSignature) return i;
  }
  fail("the archive has no zip end-of-central-directory record");
  return -1;
}

function extractZip(bytes, member, destination) {
  const eocd = findEocd(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) fail("the zip central directory is damaged");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== member && !name.endsWith(`/${member}`)) continue;

    // The local header repeats the name and extra fields with its own lengths.
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? raw : inflateRawSync(raw);
    if (content.length !== uncompressedSize) {
      fail(`${member} unpacked to ${content.length} bytes, expected ${uncompressedSize}`);
    }
    writeFileSync(destination, content);
    return;
  }
  fail(`${member} is not in the archive`);
}

/**
 * A whole directory out of a tar, landing at `destination`.
 *
 * `--strip-components` counts the path segments of the member itself, so the
 * contents of `<root>/lib/node_modules/npm/` end up directly under
 * `destination` rather than four levels down inside it.
 */
function extractTarDir(archivePath, member, destination) {
  const stripComponents = member.split("/").length;
  mkdirSync(destination, { recursive: true });
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", destination, `--strip-components=${stripComponents}`, member], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : String(error?.message ?? error);
    fail(
      `could not extract ${member}/ from ${archivePath}: ${detail}`,
      archivePath.endsWith(".xz")
        ? "This needs a tar that can read .xz (GNU tar with xz-utils, or bsdtar)."
        : "This needs `tar` on PATH.",
    );
  }
}

/**
 * The same, out of a zip. Node's Windows archives use store (0) or deflate (8)
 * only, so this is the whole of the format that matters — and it is worth the
 * fifty lines rather than a dependency in the one script whose job is to be the
 * thing nothing else has to be trusted for.
 */
function extractZipDir(bytes, member, destination) {
  const eocd = findEocd(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const prefix = `${member}/`;
  let written = 0;

  for (let i = 0; i < entryCount; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) fail("the zip central directory is damaged");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    const at = name.indexOf(prefix);
    if (at < 0) continue;
    const relative = name.slice(at + prefix.length);
    if (relative === "") continue;
    // A zip path is always "/"-separated and may not escape the destination.
    if (relative.split("/").some((part) => part === ".." || part === "")) {
      if (!name.endsWith("/")) fail(`${name} is not a path this archive should contain`);
      continue;
    }

    const target = join(destination, ...relative.split("/"));
    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? raw : inflateRawSync(raw);
    if (content.length !== uncompressedSize) {
      fail(`${name} unpacked to ${content.length} bytes, expected ${uncompressedSize}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written++;
  }
  if (written === 0) fail(`${member}/ is not in the archive`);
}

async function fetchTarget(target, verify) {
  const spec = pin.targets[target];
  if (!spec) {
    fail(
      `no Node runtime is pinned for ${target}`,
      `Pinned targets: ${Object.keys(pin.targets).join(", ")}. Add one to runtime.json with its hash.`,
    );
  }

  const destinationDir = join(runtimeDir, target);
  const destination = join(destinationDir, spec.binary);
  const npmDir = join(destinationDir, "npm");
  const npmCli = join(npmDir, "bin", "npm-cli.js");
  const stampPath = join(destinationDir, ".pin.json");
  // `sha256` is the archive's, from runtime.json. `binarySha256` is the hash of
  // the file that came out of it, recorded here so `before-pack.cjs` can check
  // the binary it is about to package rather than only the note beside it —
  // otherwise replacing the binary and leaving the stamp ships the replacement.
  const stamp = { version: pin.version, sha256: spec.sha256, npm: true, binarySha256: "" };
  if (existsSync(destination) && existsSync(npmCli) && existsSync(stampPath)) {
    const previous = JSON.parse(readFileSync(stampPath, "utf8"));
    if (
      previous.version === stamp.version &&
      previous.sha256 === stamp.sha256 &&
      previous.npm === true &&
      typeof previous.binarySha256 === "string" &&
      previous.binarySha256 !== "" &&
      previous.binarySha256 === sha256Of(destination)
    ) {
      process.stdout.write(`  ${target}: node ${pin.version} and its package manager already in place\n`);
      if (verify) verifyBinary(target, destination);
      return;
    }
  }

  const bytes = await archiveFor(target, spec);
  mkdirSync(destinationDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "piorbit-runtime-"));
  try {
    const scratchBinary = join(scratch, spec.binary);
    const scratchNpm = join(scratch, "npm");
    if (spec.archive.endsWith(".zip")) {
      extractZip(bytes, spec.member, scratchBinary);
      extractZipDir(bytes, spec.npm, scratchNpm);
    } else {
      const archivePath = join(scratch, spec.archive);
      writeFileSync(archivePath, bytes);
      const archiveRoot = spec.archive.replace(/\.tar\.(gz|xz)$/, "");
      extractTar(archivePath, `${archiveRoot}/${spec.member}`, scratchBinary);
      extractTarDir(archivePath, `${archiveRoot}/${spec.npm}`, scratchNpm);
    }
    if (!existsSync(join(scratchNpm, "bin", "npm-cli.js"))) {
      fail(
        `${spec.archive} has no package manager at ${spec.npm}/bin/npm-cli.js`,
        `Every official Node archive carries one. If node ${pin.version} moved it, update the "npm" path for\n` +
          `${target} in runtime.json.`,
      );
    }
    chmodSync(scratchBinary, 0o755);
    rmSync(destination, { force: true });
    renameSync(scratchBinary, destination);
    rmSync(npmDir, { recursive: true, force: true });
    renameSync(scratchNpm, npmDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  stamp.binarySha256 = sha256Of(destination);
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  process.stdout.write(`  ${target}: node ${pin.version} -> runtime/${target}/${spec.binary}\n`);
  process.stdout.write(`  ${target}: its package manager -> runtime/${target}/npm (${readdirSync(npmDir).length} entries)\n`);
  if (verify) verifyBinary(target, destination);
}

/** SHA-256 of a file on disk, hex. */
function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The M5-T2 assertion, run only for the current machine's target: the binary we
 * shipped reports itself as a real node, not as Electron.
 */
function verifyBinary(target, binary) {
  if (target !== currentTarget()) {
    process.stdout.write(`  ${target}: not this machine, skipping the run check\n`);
    return;
  }
  const probe = spawnSync(binary, ["-p", "JSON.stringify({e:process.execPath,v:process.version,el:!!process.versions.electron})"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (probe.status !== 0) {
    fail(`${binary} did not run: ${(probe.stderr || probe.error?.message || "").trim()}`);
  }
  const report = JSON.parse(probe.stdout.trim());
  if (report.el) fail(`${binary} reports an Electron runtime; the host must be spawned from a plain node`);
  if (report.e !== binary) fail(`${binary} reports process.execPath ${report.e}`);
  process.stdout.write(`  ${target}: runs as ${report.v}, process.execPath = ${report.e}\n`);
}

const { targets, verify } = parseArgv(process.argv.slice(2));
process.stdout.write(`piorbit runtime: node ${pin.version}\n`);
for (const target of targets) await fetchTarget(target, verify);
