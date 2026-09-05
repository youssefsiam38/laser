/**
 * The product copy that every Linux artifact repeats, in one place.
 *
 * A `.desktop` entry, an AppStream `metainfo.xml`, a `deb` control file and an
 * `rpm` spec all want the same three sentences. Writing them four times is how
 * three of them go stale. So they live here, and `make-linux-assets.mjs`
 * asserts that `electron-builder.yml` still carries the same words — the two
 * files that genuinely cannot import each other are checked against each other
 * instead of trusted.
 *
 * Nothing here names the agent that runs underneath (M10-T8): a person reading
 * a package description should learn what piorbit does, not which engine it
 * happens to pin this month.
 */

/** The freedesktop application id. Never changes; see electron-builder.yml. */
export const APP_ID = "dev.piorbit.desktop";

/** The binary, the icon name, and the `.desktop` basename all use this. */
export const EXECUTABLE = "piorbit";

/**
 * The real Electron binary, next to the launcher.
 *
 * `build/after-pack.cjs` renames Electron's own executable to this and puts a
 * small POSIX shell launcher in its place, so that every way of starting
 * piorbit — the application menu, `/usr/bin/piorbit`, a double-clicked
 * AppImage, `./piorbit` out of the tarball — goes through the same code that
 * decides about the sandbox and the display server.
 */
export const REAL_BINARY = `${EXECUTABLE}-bin`;

/** One line. Debian's `Description` first line, AppStream's `<summary>`. */
export const SUMMARY = "A control room for coding agents";

/**
 * One sentence, and it has to stay one sentence.
 *
 * This is the `.desktop` entry's `Comment`, which GNOME prints under the name
 * in search results and KDE shows as the launcher tooltip — both of them
 * ellipsise anything long. electron-builder always writes `Comment` from the
 * description and ignores an override, so the length is decided here or
 * nowhere. The paragraphs that need more room are below, and only AppStream
 * shows them.
 */
export const DESCRIPTION =
  "Runs coding agent sessions across every project on this machine, and mirrors them to your phone.";

/**
 * The rest of the story, for the two places with room to tell it: GNOME
 * Software and KDE Discover both render the whole AppStream `<description>`.
 */
export const DESCRIPTION_MORE =
  "Everything is configured inside the window: providers, models, extensions and projects. piorbit brings its own runtime and its own agent, so there is nothing to install first and nothing on your machine for it to disagree with.";

export const DESCRIPTION_RELAY =
  "The phone is not a second application. It is the same interface, reached over an end-to-end encrypted relay that piorbit runs itself, so a session left on the desktop is the session picked up on the train.";

export const HOMEPAGE = "https://github.com/youssefsiam38/piorbit";

/**
 * `LicenseRef-` is AppStream's way of naming a licence that is not on the SPDX
 * list. The repository ships no LICENSE file, so claiming an open-source
 * licence here would be a lie that GNOME Software would repeat.
 */
export const PROJECT_LICENSE = "LicenseRef-proprietary";

/** The licence of the metainfo file itself, which is the AppStream convention. */
export const METADATA_LICENSE = "CC0-1.0";

/** Freedesktop menu categories. `IDE` is registered under `Development`. */
export const CATEGORIES = ["Development", "IDE"];

/**
 * Search terms. These are what someone types into GNOME's overview or KDE's
 * launcher when they cannot remember the name.
 */
export const KEYWORDS = ["agent", "ai", "assistant", "coding", "developer", "automation", "llm", "chat"];

/** The one URL scheme piorbit answers to. See src/deep-links.ts. */
export const URL_SCHEME = "piorbit";

/** Icon sizes that scripts/make-icons.mjs emits into build/icons/. */
export const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

/** From build/icon.png's palette, which is DESIGN.md's accent and ground. */
export const BRANDING = { light: "#4DA3FF", dark: "#0B0F14" };
