/**
 * Linux only: put the product's launcher where every route into the app runs it.
 *
 * electron-builder names the Electron executable after the product, and each
 * Linux format then points at that name in its own way — the AppImage's AppRun
 * execs `$APPDIR/<binary>`, the deb and the rpm symlink `/usr/bin/<binary>` at
 * `/opt/<binary>/<binary>`, the tarball is extracted and `./<binary>` is
 * double-clicked. So this renames Electron's binary to `<binary>-bin` and
 * installs the generated launcher in its place. One file, four formats, one
 * decision about the sandbox.
 *
 * Every name comes from product.json, through build/linux/product.mjs (MX-T7).
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

  // product.mjs is ESM and this hook is CJS, so the identity arrives through a
  // dynamic import rather than a second copy of the names.
  const { identity, METAINFO_FILE_NAME } = await import("./linux/product.mjs");
  const launcherSource = join(GENERATED, "launcher.sh");
  if (!existsSync(launcherSource)) {
    throw new Error(
      `${identity.name}: ${launcherSource} is missing, so the packaged app would start Electron ` +
        `directly and make no decision about the sandbox.\nRun \`pnpm -F @piorbit/desktop linux:assets\`.`,
    );
  }

  const appOutDir = context.appOutDir;
  const executable = context.packager.executableName;
  const launcher = join(appOutDir, executable);
  const real = join(appOutDir, `${executable}-bin`);

  if (existsSync(real)) {
    // A rebuild into the same directory: the rename already happened and
    // `launcher` is our script, not Electron. Refresh the script and stop.
    copyFileSync(launcherSource, launcher);
    chmodSync(launcher, 0o755);
  } else {
    if (!existsSync(launcher)) {
      throw new Error(
        `${identity.name}: expected Electron's executable at ${launcher} and it is not there. ` +
          `electron-builder names it after linux.executableName; if that changed, ` +
          `build/after-pack.cjs and build/linux/apparmor.tpl have to change with it.`,
      );
    }
    renameSync(launcher, real);
    copyFileSync(launcherSource, launcher);
    chmodSync(launcher, 0o755);
    chmodSync(real, 0o755);
  }

  const metainfoSource = join(GENERATED, METAINFO_FILE_NAME);
  if (!existsSync(metainfoSource)) {
    throw new Error(
      `${identity.name}: ${metainfoSource} is missing, so GNOME Software and KDE Discover would show this ` +
        `package with no name and no description.\nRun \`pnpm -F @piorbit/desktop linux:assets\`.`,
    );
  }
  const metainfoTarget = join(appOutDir, "usr", "share", "metainfo", METAINFO_FILE_NAME);
  mkdirSync(dirname(metainfoTarget), { recursive: true });
  copyFileSync(metainfoSource, metainfoTarget);

  assertFpmPathsResolve(context, identity, METAINFO_FILE_NAME);

  console.log(`${identity.name}: ${executable} is now the launcher; Electron is ${executable}-bin`);
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
function assertFpmPathsResolve(context, identity, metainfoFileName) {
  const usesFpm = (context.targets ?? []).some((target) => target.name === "deb" || target.name === "rpm");
  if (!usesFpm) return;
  const relative = `build/linux/generated/${metainfoFileName}`;
  if (existsSync(relative)) return;
  throw new Error(
    `${identity.name}: the .deb and .rpm hand fpm the path "${relative}", and from this working directory\n` +
      `  ${process.cwd()}\n` +
      `it does not resolve. Build them from the desktop package instead:\n` +
      `  pnpm -F @piorbit/desktop dist:linux`,
  );
}
