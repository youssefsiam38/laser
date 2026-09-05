#!/usr/bin/env node
/**
 * Build every Linux package format, check the result, and say what came out.
 *
 *   pnpm -F @piorbit/desktop dist:linux
 *   pnpm -F @piorbit/desktop dist:linux -- --targets appimage,deb --arch x64
 *
 * Four formats and two architectures need four different toolchains, and three
 * of those toolchains are not installed on a typical machine. The important
 * thing this script does is therefore not the building: it is failing *before*
 * a twenty-minute build with a sentence that names the missing program and the
 * command that installs it, instead of after it with a stack trace from fpm.
 *
 * What it runs, in order:
 *
 *   1. preflight — every external program each requested target needs
 *   2. prepack   — TypeScript, icons, the AppStream metainfo, the pinned Node
 *   3. electron-builder for AppImage, deb and rpm
 *   4. scripts/pack-tarball.mjs for the .tar.gz
 *   5. validate the .desktop entry that actually shipped and the metainfo
 *   6. SHA256SUMS, then the artifact table
 *
 * On downloads: electron-builder fetches fpm and the AppImage runtime from
 * GitHub the first time they are needed, and verifies each against a SHA-256
 * compiled into app-builder-lib — which is pinned by the lockfile, so the hash
 * lives in git here too. Nothing in this build trusts a hash that arrived
 * alongside the file it describes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { METAINFO_FILE_NAME, EXECUTABLE, identity } from "../build/linux/product.mjs";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(packageRoot, "out");
const generatedDir = join(packageRoot, "build", "linux", "generated");
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

const ALL_TARGETS = ["appimage", "deb", "rpm", "tar.gz"];
const ALL_ARCHES = ["x64", "arm64"];

// --------------------------------------------------------------- args ----

function optionValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`--${name} needs a value, for example --${name} ${name === "arch" ? "x64" : "appimage,deb"}.`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`
${identity.name}: ${message}\n\n`);
  process.exit(1);
}

/**
 * Anything this script does not understand is a mistake, not a pass-through.
 *
 * It used to ignore unknown arguments, and `--x64` — which is what
 * electron-builder calls that flag, and what a person naturally writes —
 * silently built *both* architectures. On this machine that is a wasted hour;
 * on a build agent it is an arm64 artifact assembled from x64 parts.
 */
const KNOWN_FLAGS = new Set(["--targets", "--arch", "--skip-prepack", "--help", "-h"]);
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--") continue; // pnpm's separator, forwarded verbatim
  if (KNOWN_FLAGS.has(arg)) {
    if (arg === "--targets" || arg === "--arch") i++; // its value
    continue;
  }
  if (arg.startsWith("--x") || arg.startsWith("--arm")) {
    fail(`unknown option "${arg}". This script spells it \`--arch ${arg.slice(2)}\`, not \`${arg}\`.`);
  }
  fail(`unknown option "${arg}". It takes --targets <list>, --arch <list> and --skip-prepack.`);
}

const targets = (optionValue("targets") ?? ALL_TARGETS.join(",")).split(",").map((t) => t.trim().toLowerCase());
const arches = (optionValue("arch") ?? ALL_ARCHES.join(",")).split(",").map((a) => a.trim());

for (const target of targets) {
  if (!ALL_TARGETS.includes(target)) {
    fail(`unknown target "${target}". Choose from ${ALL_TARGETS.join(", ")}.`);
  }
}
for (const arch of arches) {
  if (!ALL_ARCHES.includes(arch)) fail(`unknown architecture "${arch}". Choose from ${ALL_ARCHES.join(", ")}.`);
}

// ---------------------------------------------------------- preflight ----

const has = (program) => spawnSync("sh", ["-c", `command -v ${program}`], { stdio: "ignore" }).status === 0;

/**
 * One entry per program that a target genuinely cannot be built without, with
 * the command that installs it on each of the three places this gets built.
 */
const REQUIREMENTS = [
  {
    program: "rpmbuild",
    neededBy: ["rpm"],
    why: "fpm shells out to rpmbuild to assemble an .rpm; there is no pure-JavaScript path.",
    install: [
      ["Debian, Ubuntu", "sudo apt-get install rpm"],
      ["Fedora, RHEL", "sudo dnf install rpm-build"],
      ["Arch", "sudo pacman -S rpm-tools"],
      ["macOS", "brew install rpm"],
    ],
  },
  {
    program: "xz",
    neededBy: ["rpm", "deb"],
    why: "both package formats compress their payload with xz.",
    install: [
      ["Debian, Ubuntu", "sudo apt-get install xz-utils"],
      ["Fedora, RHEL", "sudo dnf install xz"],
      ["macOS", "brew install xz"],
    ],
  },
  {
    program: "tar",
    neededBy: ["tar.gz"],
    why: "the .tar.gz is assembled with GNU tar, for --transform and --sort.",
    install: [
      ["Debian, Ubuntu", "sudo apt-get install tar"],
      ["macOS", "brew install gnu-tar"],
    ],
  },
];

/** Not fatal — the build is fine without them, the checking is not. */
const VALIDATORS = [
  { program: "desktop-file-validate", package: "desktop-file-utils", checks: "the .desktop entry" },
  { program: "appstreamcli", package: "appstream", checks: "the AppStream metainfo" },
  { program: "dpkg-deb", package: "dpkg", checks: "what the .deb actually contains" },
  { program: "apparmor_parser", package: "apparmor", checks: "the AppArmor profile the .deb installs" },
];

function preflight() {
  const missing = REQUIREMENTS.filter(
    (requirement) => requirement.neededBy.some((t) => targets.includes(t)) && !has(requirement.program),
  );
  if (missing.length > 0) {
    const lines = missing.map((requirement) => {
      const blocked = requirement.neededBy.filter((t) => targets.includes(t));
      return [
        `  ${requirement.program} — needed for ${blocked.join(" and ")}`,
        `      ${requirement.why}`,
        ...requirement.install.map(([where, command]) => `      ${where.padEnd(16)} ${command}`),
      ].join("\n");
    });
    const remaining = targets.filter((t) => !missing.some((m) => m.neededBy.includes(t)));
    fail(
      `this machine cannot build every target you asked for.\n\n${lines.join("\n\n")}\n\n` +
        (remaining.length > 0
          ? `To build the rest now:\n      pnpm -F @piorbit/desktop dist:linux -- --targets ${remaining.join(",")}`
          : `Install the programs above, or build on a machine that has them.`),
    );
  }

  const unavailable = VALIDATORS.filter((validator) => !has(validator.program));
  for (const validator of unavailable) {
    process.stdout.write(
      `${identity.name}: ${validator.program} is not installed, so ${validator.checks} will not be checked ` +
        `(install the "${validator.package}" package to check it).\n`,
    );
  }
}

// -------------------------------------------------------------- steps ----

function run(command, args, label) {
  process.stdout.write(`\n── ${label}\n`);
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit" });
  if (result.status !== 0) {
    fail(`${label} failed (${command} exited ${result.status ?? result.signal}).`);
  }
}

function prepack() {
  run("pnpm", ["run", "prepack:app"], "TypeScript, icons and the pinned Node");
  run(process.execPath, [join(packageRoot, "scripts", "make-linux-assets.mjs")], "AppStream metainfo and .desktop entry");
}

function buildWithElectronBuilder() {
  const builderTargets = ALL_TARGETS.filter((t) => t !== "tar.gz").filter((t) => targets.includes(t));
  // The tarball is built from the packed directory, so ask for `dir` when it is
  // the only thing wanted and nothing else would produce one.
  const positional = builderTargets.length > 0 ? builderTargets.map(nameForBuilder) : ["dir"];
  const args = ["--linux", ...positional, ...arches.map((arch) => `--${arch}`)];
  run(join(packageRoot, "node_modules", ".bin", "electron-builder"), args, `electron-builder ${positional.join(", ")}`);
}

const nameForBuilder = (target) => ({ appimage: "AppImage", deb: "deb", rpm: "rpm" })[target];

function buildTarballs() {
  if (!targets.includes("tar.gz")) return;
  for (const arch of arches) {
    run(process.execPath, [join(packageRoot, "scripts", "pack-tarball.mjs"), "--arch", arch], `tar.gz ${arch}`);
  }
}

// --------------------------------------------------------- validation ----

const problems = [];

function validateDesktopFile(path, origin) {
  if (!has("desktop-file-validate")) return;
  const result = spawnSync("desktop-file-validate", [path], { encoding: "utf8" });
  if (result.status !== 0) {
    problems.push(`${origin}: desktop-file-validate rejected it\n${result.stdout}${result.stderr}`.trimEnd());
  } else {
    process.stdout.write(`${identity.name}: ${origin} — desktop entry valid\n`);
  }
}

function validateMetainfo() {
  if (!has("appstreamcli")) return;
  const path = join(generatedDir, METAINFO_FILE_NAME);
  const result = spawnSync("appstreamcli", ["validate", "--no-net", path], { encoding: "utf8" });
  if (result.status !== 0) {
    problems.push(`AppStream metainfo: appstreamcli rejected it\n${result.stdout}${result.stderr}`.trimEnd());
  } else {
    process.stdout.write(`${identity.name}: AppStream metainfo valid\n`);
  }
}

/**
 * Check the entry that actually ships, not the one we generated. They are
 * different files: electron-builder writes the deb's and the rpm's from
 * `linux.desktop` in electron-builder.yml, and only the tarball uses ours.
 */
function validateShippedDeb() {
  const deb = readdirSync(outDir).find((file) => file.endsWith(".deb"));
  if (!deb || !has("dpkg-deb")) return;
  const temp = mkdtempSync(join(tmpdir(), `${identity.name}-deb-`));
  try {
    const payload = execFileSync("dpkg-deb", ["--fsys-tarfile", join(outDir, deb)], {
      maxBuffer: 1024 * 1024 * 1024,
      encoding: "buffer",
    });
    execFileSync("tar", ["--extract", "--directory", temp, `./usr/share/applications/${EXECUTABLE}.desktop`], {
      input: payload,
      maxBuffer: 1024 * 1024 * 1024,
    });
    const shipped = join(temp, "usr", "share", "applications", `${EXECUTABLE}.desktop`);
    validateDesktopFile(shipped, `${deb} → /usr/share/applications/${EXECUTABLE}.desktop`);
    process.stdout.write(`\n${readFileSync(shipped, "utf8").trim()}\n\n`);

    const control = execFileSync("dpkg-deb", ["--field", join(outDir, deb), "Depends", "Recommends"], {
      encoding: "utf8",
    });
    process.stdout.write(`${control.trim()}\n`);

    // The AppStream metainfo has to be at the system path, not only inside
    // /opt, or no store shows the application at all.
    const metainfoPath = `./usr/share/metainfo/${METAINFO_FILE_NAME}`;
    if (!execFileSync("dpkg-deb", ["--contents", join(outDir, deb)], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 256,
    }).includes(metainfoPath)) {
      problems.push(`${deb}: no ${metainfoPath}, so GNOME Software and KDE Discover would not list ${identity.name}`);
    }

    // The profile that lets the app open a user namespace on Ubuntu 24.04. A
    // syntax error in it is silent at build time and fatal at install time.
    if (has("apparmor_parser")) {
      execFileSync("tar", ["--extract", "--directory", temp, `./opt/${EXECUTABLE}/resources/apparmor-profile`], {
        input: payload,
        maxBuffer: 1024 * 1024 * 1024,
      });
      const profile = join(temp, "opt", EXECUTABLE, "resources", "apparmor-profile");
      const parsed = spawnSync("apparmor_parser", ["--skip-kernel-load", "--debug", profile], { encoding: "utf8" });
      if (parsed.status !== 0) {
        problems.push(`${deb}: apparmor_parser rejected the bundled profile\n${parsed.stderr}`.trimEnd());
      } else {
        process.stdout.write(`${identity.name}: AppArmor profile parses\n`);
      }
    }
  } catch (error) {
    problems.push(`could not read ${deb}: ${error.message}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ results ----

const EXTENSIONS = [".AppImage", ".deb", ".rpm", ".tar.gz"];

function artifacts() {
  return readdirSync(outDir)
    .filter((file) => EXTENSIONS.some((extension) => file.endsWith(extension)))
    .sort()
    .map((file) => {
      const path = join(outDir, file);
      return {
        file,
        size: statSync(path).size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    });
}

function report(found) {
  if (found.length === 0) {
    fail(`electron-builder reported success but ${outDir} holds no package. Nothing was produced.`);
  }
  const manifest = found.map((a) => `${a.sha256}  ${a.file}`).join("\n");
  writeFileSync(join(outDir, "SHA256SUMS"), `${manifest}\n`);

  const width = Math.max(...found.map((a) => a.file.length));
  process.stdout.write(`\n${identity.name} ${version} — Linux artifacts in ${outDir}\n\n`);
  for (const artifact of found) {
    const megabytes = `${(artifact.size / 1024 / 1024).toFixed(1)} MB`.padStart(9);
    process.stdout.write(`  ${artifact.file.padEnd(width)}  ${megabytes}  ${artifact.sha256.slice(0, 16)}…\n`);
  }
  process.stdout.write(`\n  SHA256SUMS${" ".repeat(Math.max(0, width - 10))}  checksums for all of the above\n`);
}

// -------------------------------------------------------------- main ----

preflight();
if (!process.argv.includes("--skip-prepack")) prepack();
buildWithElectronBuilder();
buildTarballs();

if (!existsSync(outDir)) fail(`no ${outDir}: electron-builder produced nothing.`);
validateDesktopFile(join(generatedDir, `${EXECUTABLE}.desktop`), "tar.gz → usr/share/applications");
validateMetainfo();
validateShippedDeb();
report(artifacts());

if (problems.length > 0) {
  process.stderr.write(`
${identity.name}: the packages were built, but ${problems.length} check did not pass:\n\n`);
  for (const problem of problems) process.stderr.write(`  ${problem.split("\n").join("\n  ")}\n\n`);
  process.exit(1);
}
