#!/usr/bin/env node
/**
 * The plain .tar.gz, for every Linux that is neither Debian nor Fedora.
 *
 * electron-builder can emit a `tar.gz` target, and it is not enough: it
 * archives the packed application directory and nothing else, so what comes out
 * is a folder of binaries with no menu entry, no icon, no piorbit:// handler
 * and no way to get any of them without knowing where freedesktop puts things.
 * A person who chooses the tarball is usually the person with the least help
 * available, which is the wrong moment to hand them the least finished artifact.
 *
 * So the tarball is assembled here instead, from the same packed directory:
 *
 *     piorbit-<version>-<arch>/
 *       piorbit                the launcher (build/linux/launcher.sh)
 *       piorbit-bin            Electron
 *       resources/, locales/…  the app
 *       usr/share/applications/piorbit.desktop
 *       usr/share/icons/hicolor/<size>x<size>/apps/piorbit.png
 *       usr/share/metainfo/dev.piorbit.desktop.metainfo.xml
 *       piorbit-setup.sh       registers the above for one user, no root
 *
 * The archive is byte-for-byte reproducible: entries sorted, uid/gid zeroed,
 * every mtime pinned to SOURCE_DATE_EPOCH or the commit date, and gzip told not
 * to stamp the time into its header. Two builds of one commit produce one file,
 * which is what makes a published checksum worth anything.
 *
 *   node scripts/pack-tarball.mjs --arch x64
 *   node scripts/pack-tarball.mjs                 # every arch already packed
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_ID, EXECUTABLE, ICON_SIZES } from "../build/linux/product.mjs";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const outDir = join(packageRoot, "out");
const generatedDir = join(packageRoot, "build", "linux", "generated");

/** electron-builder's own naming: x64 has no suffix, everything else does. */
const UNPACKED_DIR = { x64: "linux-unpacked", arm64: "linux-arm64-unpacked" };

/**
 * The archive is named after what `uname -m` prints, not after what Node calls
 * the architecture, because the first thing any install script does is run
 * `uname -m` and paste the answer into a filename. The AppImage and the rpm
 * already use these spellings; the deb uses Debian's own (amd64, arm64).
 */
const MACHINE_NAME = { x64: "x86_64", arm64: "aarch64" };

/**
 * One timestamp for every entry. `tar --mtime` accepts @epoch, and gzip is told
 * `-n` so it does not write its own clock into the header.
 */
function sourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH);
  try {
    return Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: packageRoot, encoding: "utf8" }).trim());
  } catch {
    // No git (a source tarball on a build agent). Pin to the Unix epoch rather
    // than to "now", so the archive stays reproducible even here.
    return 0;
  }
}

/**
 * The files that belong in the tarball and nowhere else. They are staged
 * outside the packed application directory on purpose: dropping them in there
 * would put a second .desktop entry inside the AppImage and a stray
 * /opt/piorbit/usr/share tree inside the deb.
 */
function stageExtras() {
  const stage = join(generatedDir, "tarball-extra");
  rmSync(stage, { recursive: true, force: true });

  const desktopSource = join(generatedDir, `${EXECUTABLE}.desktop`);
  if (!existsSync(desktopSource)) {
    throw new Error(
      `piorbit: ${desktopSource} is missing, so the tarball would have no menu entry.\n` +
        `Run \`pnpm -F @piorbit/desktop linux:assets\`.`,
    );
  }

  const applications = join(stage, "usr", "share", "applications");
  mkdirSync(applications, { recursive: true });
  copyFileSync(desktopSource, join(applications, `${EXECUTABLE}.desktop`));

  for (const size of ICON_SIZES) {
    const icon = join(packageRoot, "build", "icons", `${size}x${size}.png`);
    if (!existsSync(icon)) {
      throw new Error(
        `piorbit: ${icon} is missing, so the tarball would install a menu entry with no icon.\n` +
          `Run \`pnpm -F @piorbit/desktop icons\`.`,
      );
    }
    const dir = join(stage, "usr", "share", "icons", "hicolor", `${size}x${size}`, "apps");
    mkdirSync(dir, { recursive: true });
    copyFileSync(icon, join(dir, `${EXECUTABLE}.png`));
  }

  const installer = join(stage, "piorbit-setup.sh");
  copyFileSync(join(packageRoot, "build", "linux", "piorbit-setup.sh"), installer);
  execFileSync("chmod", ["0755", installer]);
  return stage;
}

/** GNU tar only: --transform and --sort are not in BSD tar. */
function assertGnuTar() {
  let banner = "";
  try {
    banner = execFileSync("tar", ["--version"], { encoding: "utf8" });
  } catch {
    throw new Error("piorbit: `tar` is not on PATH, so the .tar.gz cannot be built. Install GNU tar.");
  }
  if (!banner.includes("GNU tar")) {
    throw new Error(
      "piorbit: the .tar.gz needs GNU tar for --transform and --sort, and `tar --version` reports:\n" +
        `  ${banner.split("\n")[0]}\n` +
        "Install GNU tar (`brew install gnu-tar` on macOS) and put it on PATH before this one.",
    );
  }
}

function packOne(arch) {
  const appDir = join(outDir, UNPACKED_DIR[arch]);
  if (!existsSync(appDir)) return null;

  const name = `${EXECUTABLE}-${version}-${MACHINE_NAME[arch]}`;
  const output = join(outDir, `${name}.tar.gz`);
  const stage = stageExtras();
  const epoch = sourceDateEpoch();

  // The metainfo is already inside appDir at usr/share/metainfo/ — build/
  // after-pack.cjs put it there for the AppImage's AppDir, and the two trees
  // merge under one usr/share/ in the archive.
  const metainfo = join(appDir, "usr", "share", "metainfo", `${APP_ID}.metainfo.xml`);
  if (!existsSync(metainfo)) {
    throw new Error(
      `piorbit: ${metainfo} is missing from the packed application, so the tarball would install\n` +
        `nothing for GNOME Software or KDE Discover to show. Repack with \`pnpm -F @piorbit/desktop pack\`.`,
    );
  }

  rmSync(output, { force: true });

  // Two passes into one uncompressed archive, then gzip.
  //
  // The obvious single command — two `--directory` sections in one `tar
  // --create` — does not work: GNU tar defers reading a directory's contents,
  // and by the time it walks the first `.` the working directory has already
  // moved to the second section, so every entry comes back as "File removed
  // before we read it". Appending is the supported way to add a second tree,
  // and `--append` cannot write to a compressed file, hence the temporary.
  const scratch = `${output}.tar`;
  rmSync(scratch, { force: true });

  const deterministic = [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--mtime=@${epoch}`,
    "--format=gnu",
    // Everything lands under one directory, so unpacking in a home directory
    // does not scatter 300 MB of files across it. The pattern is `^\.` rather
    // than `^\./` because tar stores the root of the tree as `.` with no
    // slash, and that entry has to be renamed too or the archive unpacks a
    // stray `./` alongside the real directory.
    `--transform=s,^\\.,${name},`,
  ];

  try {
    execFileSync("tar", ["--create", "--file", scratch, ...deterministic, "--directory", appDir, "."], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    execFileSync("tar", ["--append", "--file", scratch, ...deterministic, "--directory", stage, "."], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    // -n: do not write the source filename or the current time into the gzip
    // header, which is the last thing that would make two builds differ.
    execFileSync("sh", ["-c", `gzip -9 -n -c ${JSON.stringify(scratch)} > ${JSON.stringify(output)}`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } finally {
    rmSync(scratch, { force: true });
  }

  return { arch, file: output, size: statSync(output).size };
}

assertGnuTar();

const requested = process.argv.includes("--arch")
  ? [process.argv[process.argv.indexOf("--arch") + 1]]
  : Object.keys(UNPACKED_DIR);

for (const arch of requested) {
  if (!UNPACKED_DIR[arch]) {
    throw new Error(`piorbit: unknown --arch ${arch}. Use x64 or arm64.`);
  }
}

const built = requested.map(packOne).filter(Boolean);

if (built.length === 0) {
  throw new Error(
    `piorbit: nothing to archive — no packed application under ${outDir}.\n` +
      `Run \`pnpm -F @piorbit/desktop pack\` (or dist:linux, which does both) first.`,
  );
}

for (const artifact of built) {
  process.stdout.write(`piorbit tarball: ${artifact.file} (${(artifact.size / 1024 / 1024).toFixed(1)} MB)\n`);
}
