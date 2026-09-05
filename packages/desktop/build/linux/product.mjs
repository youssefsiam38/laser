/**
 * The product copy that every Linux artifact repeats — read, not written.
 *
 * A `.desktop` entry, an AppStream `metainfo.xml`, a `deb` control file and an
 * `rpm` spec all want the same three sentences. Writing them four times is how
 * three of them go stale. Since MX-T7 they are not written here either: this
 * file is a typed view onto `product.json` at the repository root, which is the
 * one place the product is named (D-36). Change the name there and every
 * artifact below follows on the next `pnpm identity:generate`.
 *
 * Nothing here names the agent that runs underneath (M10-T8): a person reading
 * a package description should learn what the product does, not which engine it
 * happens to pin this month.
 */
import { identity } from "../../../../scripts/identity/identity.mjs";

/** The freedesktop application id. From product.json's `appId`. */
export const APP_ID = identity.appId;

/** The binary, the icon name, and the `.desktop` basename all use this. */
export const EXECUTABLE = identity.binary;

/**
 * The real Electron binary, next to the launcher.
 *
 * `build/after-pack.cjs` renames Electron's own executable to this and puts a
 * small POSIX shell launcher in its place, so that every way of starting the
 * app — the application menu, `/usr/bin/<binary>`, a double-clicked AppImage,
 * `./<binary>` out of the tarball — goes through the same code that decides
 * about the sandbox and the display server.
 */
export const REAL_BINARY = identity.realBinary;

/** One line. Debian's `Description` first line, AppStream's `<summary>`. */
export const SUMMARY = identity.copy.summary;

/**
 * One sentence, and it has to stay one sentence.
 *
 * This is the `.desktop` entry's `Comment`, which GNOME prints under the name
 * in search results and KDE shows as the launcher tooltip — both of them
 * ellipsise anything long. electron-builder always writes `Comment` from the
 * description and ignores an override, so the length is decided in product.json
 * or nowhere. The paragraphs that need more room are below, and only AppStream
 * shows them.
 */
export const DESCRIPTION = identity.copy.description;

/**
 * The rest of the story, for the two places with room to tell it: GNOME
 * Software and KDE Discover both render the whole AppStream `<description>`.
 */
export const DESCRIPTION_MORE = identity.copy.descriptionMore;

export const DESCRIPTION_RELAY = identity.copy.descriptionRelay;

export const HOMEPAGE = identity.homepage;

/** AppStream's developer id — the app id without its last segment. */
export const DEVELOPER_ID = identity.developerId;

/** Who the deb's `Maintainer`, the rpm's `Vendor` and AppStream's developer name credit. */
export const VENDOR = identity.vendor;
export const MAINTAINER = identity.maintainer;

/**
 * `LicenseRef-` is AppStream's way of naming a licence that is not on the SPDX
 * list. The repository ships no LICENSE file, so claiming an open-source
 * licence here would be a lie that GNOME Software would repeat.
 */
export const PROJECT_LICENSE = identity.license.project;

/** The licence of the metainfo file itself, which is the AppStream convention. */
export const METADATA_LICENSE = identity.license.metadata;

/** Freedesktop menu categories. `IDE` is registered under `Development`. */
export const CATEGORIES = identity.categories;

/**
 * Search terms. These are what someone types into GNOME's overview or KDE's
 * launcher when they cannot remember the name.
 */
export const KEYWORDS = identity.keywords;

/** The one URL scheme the app answers to. See src/deep-links.ts. */
export const URL_SCHEME = identity.urlScheme;

/** Icon sizes that scripts/make-icons.mjs emits into build/icons/. */
export const ICON_SIZES = identity.iconSizes;

/** From build/icon.png's palette, which is DESIGN.md's accent and ground. */
export const BRANDING = { light: identity.branding.light, dark: identity.branding.dark };

/** Basenames that carry the product name, so no script spells one out. */
export const DESKTOP_FILE_NAME = identity.desktopFileName;
export const METAINFO_FILE_NAME = identity.metainfoFileName;
export const SETUP_SCRIPT_NAME = identity.setupScriptName;

/** Re-exported so the packaging scripts have one import for everything. */
export { identity };
