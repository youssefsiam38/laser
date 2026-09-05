/**
 * Put the right stock Node next to the app before electron-builder packs it.
 *
 * electron-builder's `${platform}`/`${arch}` macros are not reliable enough to
 * point `extraResources` at `runtime/<platform>-<arch>/` directly, and getting
 * it wrong ships a macOS binary inside a Windows installer — a mistake nobody
 * notices until the app will not start on a stranger's machine. So the target
 * is resolved here, from the context electron-builder hands us, and copied to
 * one fixed path that the config can name literally.
 *
 * It also downloads the runtime if it is missing, so `pnpm dist` works from a
 * clean checkout on a build agent, and it configures Windows code signing from
 * the environment — present, and the installer is signed; absent, and it is an
 * honest unsigned installer rather than a build that refuses to run.
 */
const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

/** electron-builder's Arch enum, which is an index rather than a name. */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

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

  // One fixed staging directory, cleaned each time, so a previous platform's
  // binary can never survive into this build.
  const staging = join(packageRoot, "build", "runtime");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  copyFileSync(source, join(staging, binary));
  console.log(`piorbit: staged ${target} node for packaging`);
};
