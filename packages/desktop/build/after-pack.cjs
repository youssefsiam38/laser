/**
 * Linux only: put piorbit's launcher where every route into the app runs it.
 *
 * electron-builder names the Electron executable after the product, and each
 * Linux format then points at that name in its own way — the AppImage's AppRun
 * execs `$APPDIR/piorbit`, the deb and the rpm symlink `/usr/bin/piorbit` at
 * `/opt/piorbit/piorbit`, the tarball is extracted and `./piorbit` is
 * double-clicked. So this renames Electron's binary to `piorbit-bin` and
 * installs `build/linux/launcher.sh` in its place. One file, four formats, one
 * decision about the sandbox.
 *
 * It also drops the AppStream metainfo into `usr/share/metainfo/` inside the
 * packed directory. That is where an AppImage's AppDir wants it, and it is
 * where the tarball's install.sh reads it from, so the two formats that carry
 * their own `usr/share` tree are both served by one copy. The deb and the rpm
 * get a second copy at the system path through `fpm:` in electron-builder.yml,
 * because /opt is not a place GNOME Software or KDE Discover look.
 *
 * Runs after electron-builder has copied every file and before any target is
 * built, which is the only moment all four formats share.
 */
const { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } = require("node:fs");
const { dirname, join } = require("node:path");

const GENERATED = join(__dirname, "linux", "generated");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const appOutDir = context.appOutDir;
  const executable = context.packager.executableName;
  const launcher = join(appOutDir, executable);
  const real = join(appOutDir, `${executable}-bin`);

  if (existsSync(real)) {
    // A rebuild into the same directory: the rename already happened and
    // `launcher` is our script, not Electron. Refresh the script and stop.
    copyFileSync(join(__dirname, "linux", "launcher.sh"), launcher);
    chmodSync(launcher, 0o755);
  } else {
    if (!existsSync(launcher)) {
      throw new Error(
        `piorbit: expected Electron's executable at ${launcher} and it is not there. ` +
          `electron-builder names it after linux.executableName; if that changed, ` +
          `build/after-pack.cjs and build/linux/apparmor.tpl have to change with it.`,
      );
    }
    renameSync(launcher, real);
    copyFileSync(join(__dirname, "linux", "launcher.sh"), launcher);
    chmodSync(launcher, 0o755);
    chmodSync(real, 0o755);
  }

  const metainfoSource = join(GENERATED, "dev.piorbit.desktop.metainfo.xml");
  if (!existsSync(metainfoSource)) {
    throw new Error(
      `piorbit: ${metainfoSource} is missing, so GNOME Software and KDE Discover would show this ` +
        `package with no name and no description.\nRun \`pnpm -F @piorbit/desktop linux:assets\`.`,
    );
  }
  const metainfoTarget = join(appOutDir, "usr", "share", "metainfo", "dev.piorbit.desktop.metainfo.xml");
  mkdirSync(dirname(metainfoTarget), { recursive: true });
  copyFileSync(metainfoSource, metainfoTarget);

  assertFpmPathsResolve(context);

  console.log(`piorbit: ${executable} is now the launcher; Electron is ${executable}-bin`);
};

/**
 * The deb and the rpm hand fpm a `source=destination` pair for the AppStream
 * metainfo, and electron-builder.yml can only express `source` as a path
 * relative to the working directory — YAML has nowhere to compute an absolute
 * one from. fpm resolves it against its own cwd, which is whatever cwd
 * electron-builder was started in.
 *
 * Checked here, before any target is built, because fpm's own failure for this
 * is `{level: :fatal, message: "File not found"}` twenty minutes into a build.
 */
function assertFpmPathsResolve(context) {
  const usesFpm = (context.targets ?? []).some((target) => target.name === "deb" || target.name === "rpm");
  if (!usesFpm) return;
  const relative = "build/linux/generated/dev.piorbit.desktop.metainfo.xml";
  if (existsSync(relative)) return;
  throw new Error(
    `piorbit: the .deb and .rpm hand fpm the path "${relative}", and from this working directory\n` +
      `  ${process.cwd()}\n` +
      `it does not resolve. Build them from the desktop package instead:\n` +
      `  pnpm -F @piorbit/desktop dist:linux`,
  );
}
