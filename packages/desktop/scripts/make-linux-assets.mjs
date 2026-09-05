#!/usr/bin/env node
/**
 * The four files no packaging tool will write for us, all derived from
 * `product.json` (MX-T7):
 *
 *   build/linux/generated/<appId>.metainfo.xml
 *       AppStream. Without it the app appears in GNOME Software and KDE
 *       Discover as a bare package name with no description and no icon —
 *       which is how a native application is told apart from something that
 *       was dropped on the machine.
 *
 *   build/linux/generated/<binary>.desktop
 *       The menu entry for the tarball. The deb, the rpm and the AppImage get
 *       theirs from electron-builder's `linux.desktop` block; a tarball has no
 *       packaging step to generate one, so it ships its own.
 *
 *   build/linux/generated/<binary>-setup.sh
 *       The tarball's own registrar, rendered from build/linux/setup.sh.tpl.
 *
 *   build/linux/generated/launcher.sh
 *       The one entry point every install format runs, rendered from
 *       build/linux/launcher.sh.tpl and installed by build/after-pack.cjs.
 *
 * The first three are validated by `scripts/build-linux.mjs` with
 * desktop-file-validate and appstreamcli when those exist on the build machine.
 *
 *   node scripts/make-linux-assets.mjs
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_ID,
  BRANDING,
  CATEGORIES,
  DESCRIPTION,
  DESCRIPTION_MORE,
  DESCRIPTION_RELAY,
  DESKTOP_FILE_NAME,
  DEVELOPER_ID,
  EXECUTABLE,
  HOMEPAGE,
  ICON_SIZES,
  KEYWORDS,
  METADATA_LICENSE,
  METAINFO_FILE_NAME,
  PROJECT_LICENSE,
  SETUP_SCRIPT_NAME,
  SUMMARY,
  URL_SCHEME,
  VENDOR,
  identity,
} from "../build/linux/product.mjs";
import { renderShellTemplate } from "../../../scripts/identity/template.mjs";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
export const generatedDir = join(packageRoot, "build", "linux", "generated");
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

/**
 * electron-builder.yml is generated from electron-builder.yml.tpl, so the two
 * can no longer disagree about the identity fields. The copy is still worth an
 * assertion: a person editing the generated YAML in place would otherwise ship
 * a deb whose description differs from the AppStream one, and that edit is
 * exactly the mistake this build is supposed to catch rather than overwrite.
 */
export function assertBuilderConfigAgrees() {
  const configPath = join(packageRoot, "electron-builder.yml");
  const config = readFileSync(configPath, "utf8");
  // A YAML folded scalar (`>-`) wraps the description across lines, so compare
  // word by word rather than character by character.
  const flattened = config.replace(/\s+/g, " ");
  const drift = [
    ["synopsis", SUMMARY],
    ["description", DESCRIPTION],
  ].filter(([, text]) => !flattened.includes(text.replace(/\s+/g, " ")));
  if (drift.length > 0) {
    throw new Error(
      `${identity.name}: ${configPath} and product.json disagree about ${drift
        .map(([field]) => `linux.${field}`)
        .join(" and ")}.\n` +
        `Package descriptions come from product.json's "copy"; run \`pnpm identity:generate\` so a person\n` +
        `reading the deb, the rpm, the AppImage and GNOME Software is told the same thing.\n\n` +
        drift.map(([field, text]) => `  ${field}: ${JSON.stringify(text)}`).join("\n"),
    );
  }
}

/**
 * A date that is the same for everyone who builds this commit. AppStream wants
 * one on every release, and `new Date()` would make two builds of one tag
 * differ (M10-T7 asks for a release that is reproducible from a tag).
 */
function releaseDate() {
  if (process.env.SOURCE_DATE_EPOCH) {
    return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().slice(0, 10);
  }
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: packageRoot, encoding: "utf8" }).trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const escapeXml = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Screenshots are URLs, not files: AppStream clients fetch them over HTTPS.
 * There is nowhere public to serve them from until a download host exists, and
 * pointing at a URL that 404s would put a broken image in GNOME Software —
 * worse than none. So the block is emitted only when the host is named, and its
 * absence is announced rather than hidden.
 */
function screenshots(quiet) {
  const base = process.env[identity.env.screenshotBaseUrl];
  if (!base) {
    if (!quiet) {
      console.log(
        `${identity.name}: no ${identity.env.screenshotBaseUrl}, so the metainfo ships without screenshots.\n` +
          "         Set it to a public HTTPS directory holding session.png and phone.png to include them.",
      );
    }
    return "";
  }
  const trimmed = base.replace(/\/$/, "");
  return `
  <screenshots>
    <screenshot type="default">
      <caption>A session in progress, with the agent's plan beside its work</caption>
      <image type="source">${escapeXml(`${trimmed}/session.png`)}</image>
    </screenshot>
    <screenshot>
      <caption>The same session mirrored to a phone over the encrypted relay</caption>
      <image type="source">${escapeXml(`${trimmed}/phone.png`)}</image>
    </screenshot>
  </screenshots>
`;
}

export function renderMetainfo({ quiet = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/make-linux-assets.mjs from product.json — do not edit by hand. -->
<component type="desktop-application">
  <id>${APP_ID}</id>
  <launchable type="desktop-id">${DESKTOP_FILE_NAME}</launchable>
  <name>${escapeXml(identity.displayName)}</name>
  <summary>${escapeXml(SUMMARY)}</summary>
  <metadata_license>${METADATA_LICENSE}</metadata_license>
  <project_license>${PROJECT_LICENSE}</project_license>
  <developer id="${escapeXml(DEVELOPER_ID)}">
    <name>${escapeXml(VENDOR)}</name>
  </developer>
  <description>
    <p>${escapeXml(DESCRIPTION)}</p>
    <p>${escapeXml(DESCRIPTION_MORE)}</p>
    <p>${escapeXml(DESCRIPTION_RELAY)}</p>
  </description>
  <categories>
${CATEGORIES.map((category) => `    <category>${category}</category>`).join("\n")}
  </categories>
  <keywords>
${KEYWORDS.map((keyword) => `    <keyword>${escapeXml(keyword)}</keyword>`).join("\n")}
  </keywords>
  <provides>
    <binary>${EXECUTABLE}</binary>
  </provides>
  <url type="homepage">${escapeXml(HOMEPAGE)}</url>
  <url type="bugtracker">${escapeXml(identity.issuesUrl)}</url>
  <branding>
    <color type="primary" scheme_preference="light">${BRANDING.light}</color>
    <color type="primary" scheme_preference="dark">${BRANDING.dark}</color>
  </branding>
  <content_rating type="oars-1.1"/>
  <releases>
    <release version="${version}" date="${releaseDate()}"/>
  </releases>${screenshots(quiet)}
</component>
`;
}

/**
 * The tarball's menu entry. `Exec` is rewritten to an absolute path by the
 * tarball's own setup script, which is the only thing that knows where the
 * person unpacked it; the value here is the one that works when ~/.local/bin is
 * on PATH, so the file is valid and launchable as shipped.
 */
export function renderDesktopEntry() {
  return `[Desktop Entry]
Name=${identity.displayName}
Comment=${SUMMARY}
Exec=${EXECUTABLE} %U
Icon=${EXECUTABLE}
Terminal=false
Type=Application
StartupNotify=true
StartupWMClass=${identity.displayName}
Categories=${CATEGORIES.join(";")};
Keywords=${KEYWORDS.join(";")};
MimeType=x-scheme-handler/${URL_SCHEME};
X-GNOME-UsesNotifications=true
`;
}

/** The tarball's registrar, from build/linux/setup.sh.tpl. */
export function renderSetupScript() {
  return renderShellTemplate(readFileSync(join(packageRoot, "build", "linux", "setup.sh.tpl"), "utf8"), identity);
}

/**
 * The launcher that every route into the app runs, from
 * build/linux/launcher.sh.tpl. `build/after-pack.cjs` installs it in place of
 * Electron's own executable.
 */
export function renderLauncher() {
  return renderShellTemplate(readFileSync(join(packageRoot, "build", "linux", "launcher.sh.tpl"), "utf8"), identity);
}

/** Everything this script owns, as `{ name, contents, mode }` — one list, two readers. */
export function linuxAssets({ quiet = false } = {}) {
  return [
    { name: METAINFO_FILE_NAME, contents: renderMetainfo({ quiet }), mode: 0o644 },
    { name: DESKTOP_FILE_NAME, contents: renderDesktopEntry(), mode: 0o644 },
    { name: SETUP_SCRIPT_NAME, contents: renderSetupScript(), mode: 0o755 },
    { name: "launcher.sh", contents: renderLauncher(), mode: 0o755 },
  ];
}

/**
 * Write them, removing anything left over from a previous name. A rename that
 * left `oldname.desktop` behind would ship two menu entries, one of them dead.
 */
export function writeLinuxAssets({ quiet = false } = {}) {
  assertBuilderConfigAgrees();
  mkdirSync(generatedDir, { recursive: true });
  const assets = linuxAssets({ quiet });
  const keep = new Set(assets.map((asset) => asset.name));
  // Only the three shapes this script owns. `tarball-extra/` is staged in the
  // same directory by pack-tarball.mjs and must survive.
  const ours = /(\.desktop|\.metainfo\.xml|-setup\.sh|^launcher\.sh)$/;
  for (const existing of readdirSync(generatedDir)) {
    if (ours.test(existing) && !keep.has(existing)) rmSync(join(generatedDir, existing), { force: true });
  }
  for (const asset of assets) {
    const path = join(generatedDir, asset.name);
    writeFileSync(path, asset.contents);
    // `mode` on writeFileSync applies only when the file is created, and this
    // script is re-run over its own output on every build.
    chmodSync(path, asset.mode);
  }
  return assets;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assets = writeLinuxAssets();
  process.stdout.write(
    `${identity.name} linux assets: ${assets
      .map((asset) => `build/linux/generated/${asset.name}`)
      .join(", ")} (icons: ${ICON_SIZES.join(", ")})\n`,
  );
}
