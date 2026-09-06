# Packaging (M5-T5). Every non-obvious line has a reason; see README.md.
#
# GENERATED from electron-builder.yml.tpl by `pnpm identity:generate`.
# Every name in this file comes from product.json (MX-T7, D-36). Editing the
# generated copy is caught by `pnpm identity:check`, which runs inside
# `pnpm -r build` and `pnpm -r test`; edit the template instead.
#
# The three rules this file encodes:
#   1. Nothing that must be *executed* may live inside app.asar. An asar is an
#      archive, not a filesystem: the kernel cannot exec a path inside it, and a
#      spawned process cannot use it as a working directory. So the bundled Node
#      is an extraResource and the whole dependency tree is unpacked.
#   2. The app id may change exactly once — before anyone installs a build.
#      It keys macOS TCC grants (the microphone permission), the Windows
#      notification centre, and the update feed's identity, so changing it
#      after distribution makes this a different application: the microphone
#      permission is lost and the installed copy is orphaned rather than
#      upgraded. D-36 says the product may still be renamed, which is why the
#      value below is derived from product.json and why the rename has to
#      happen before the first public artifact, not after.
#   3. The bundled Node is signed with the app. An unsigned Mach-O inside a
#      hardened-runtime bundle fails notarization, and on Windows an unsigned
#      helper is what SmartScreen complains about.

appId: {{appId}}
productName: {{displayName}}
copyright: {{copyright}}

directories:
  output: out
  buildResources: build

# Resolves runtime/<platform>-<arch>/node into build/runtime/, downloading it
# if it is missing. See build/before-pack.cjs.
beforePack: build/before-pack.cjs

files:
  - dist/**/*
  - package.json
  - "!**/*.map"
  # Only a package's OWN top-level test and doc directories. The unanchored form
  # (`node_modules/**/{…}`) also deletes source directories that merely happen to
  # be called `doc`: `yaml/dist/doc/` is one, and without it the agent throws
  # ERR_MODULE_NOT_FOUND on the first import and the packaged app cannot open a
  # session at all. `*` is an unscoped package, `@*/*` a scoped one.
  # `scripts/clean-machine.mjs` catches this class; do not widen it again.
  - "!**/node_modules/*/{test,tests,__tests__,example,examples,docs,doc}/**"
  - "!**/node_modules/@*/*/{test,tests,__tests__,example,examples,docs,doc}/**"
  # Do not strip TypeScript from dependencies. Pi extensions are executable
  # source packages: pi-subagents, for example, exports index.ts and imports
  # its implementation from src/**/*.ts. Pi's resource loader transpiles that
  # source at runtime. Removing it produces an installer that launches but
  # cannot open any session with the bundled Subagents feature enabled.
  - "!**/node_modules/**/*.{md,markdown,map,flow}"
  # Prebuilt native audio bindings for every platform, ~28 MB, reachable from
  # exactly one function: pi-gpt-transcribe's openMic. Nothing here opens a
  # microphone — the browser does the capture and the worker only makes the
  # request — so this is weight with no code path to it. It is an optional
  # dependency of that package precisely so a consumer can leave it out.
  - "!**/node_modules/{decibri,@decibri}/**"

extraResources:
  # The stock Node the host is spawned from (M5-T2).
  - from: build/runtime
    to: runtime
  # The binary distribution must carry the complete AGPL terms and the exact
  # scope/dual-license/trademark notices beside the executable resources.
  - from: ../../LICENSE
    to: legal/LICENSE
  - from: ../../LICENSING.md
    to: legal/LICENSING.md
  - from: ../../COMMERCIAL.md
    to: legal/COMMERCIAL.md
  - from: ../../TRADEMARKS.md
    to: legal/TRADEMARKS.md

asar: true
asarUnpack:
  # The host, the worker, the CLI, Pi and everything they load run in the
  # bundled Node — a separate process that knows nothing about asar. All of it
  # has to be real files on disk.
  - node_modules/**/*

# @napi-rs/keyring ships prebuilt N-API binaries, and N-API is ABI-stable
# across Electron and Node, so there is nothing to rebuild. Rebuilding would
# only introduce a toolchain requirement on every build agent.
npmRebuild: false
buildDependenciesFromSource: false

protocols:
  - name: {{displayName}}
    schemes: [{{urlScheme}}]

# ---------------------------------------------------------------- macOS ----
mac:
  category: public.app-category.developer-tools
  darkModeSupport: true
  # dmg is what people download; zip is what electron-updater needs to apply
  # a delta, so both are published.
  target:
    - target: dmg
      arch: [arm64, x64]
    - target: zip
      arch: [arm64, x64]
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  # Signed as well as the app itself: an unsigned Mach-O anywhere in a hardened
  # bundle is a notarization failure.
  binaries:
    - Contents/Resources/runtime/node
  # electron-builder >= 26 notarizes with the notarytool credentials in the
  # environment (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID, or
  # APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER).
  notarize: true
  extendInfo:
    # Without this key macOS kills the process the moment it touches the
    # microphone — it is not a prompt string, it is the permission itself.
    NSMicrophoneUsageDescription: "{{displayName}} uses the microphone only while you are dictating a
      message to an agent. Nothing is recorded or sent anywhere unless you start dictation."
    # The app reads the directories you add as projects; macOS asks about the
    # protected ones by name.
    NSDesktopFolderUsageDescription: "{{displayName}} needs access to open a project you keep on your Desktop."
    NSDocumentsFolderUsageDescription: "{{displayName}} needs access to open a project you keep in Documents."
    NSDownloadsFolderUsageDescription: "{{displayName}} needs access to open a project you keep in Downloads."
    # The window draws its own titlebar; this keeps the system chrome dark when
    # the app is dark.
    NSRequiresAquaSystemAppearance: false

dmg:
  artifactName: ${productName}-${version}-${arch}.${ext}

# -------------------------------------------------------------- Windows ----
win:
  target:
    - target: nsis
      arch: [x64, arm64]
  # Azure Trusted Signing (formerly Azure Code Signing) is configured in
  # `build/before-pack.cjs`, from the environment, and only when all four
  # values are present. It is deliberately NOT written here: electron-builder
  # treats the presence of `azureSignOptions` as "sign with Azure" and fails
  # the build when the endpoint does not resolve, so a committed placeholder
  # turns a missing credential into a broken `--win` target rather than an
  # unsigned installer.
  #
  # To sign, export all four before `pnpm -F @lasercode/desktop dist -- --win`:
  #   {{env.azurePublisherName}}    the CN in the certificate profile
  #   {{env.azureEndpoint}}          https://<region>.codesigning.azure.net
  #   {{env.azureAccount}}           the code-signing account name
  #   {{env.azureProfile}}           the certificate profile name
  # plus the credentials electron-builder reads itself: AZURE_TENANT_ID,
  # AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  shortcutName: {{displayName}}
  artifactName: ${productName}-${version}-${arch}-setup.${ext}

# ---------------------------------------------------------------- Linux ----
#
# Four formats, two architectures, and one rule behind all of them: the app is
# self-contained, so a person installs it and nothing else. That makes the
# packaging the product's first impression, and the differences
# between the formats are differences in what the host machine has to provide.
#
#   AppImage   one file, no install, no root. Runs on any distribution.
#   deb / rpm  a real system package: menu entry, {{urlScheme}}:// handler, icon
#              cache, AppArmor profile, and a sandbox helper set up as root.
#   tar.gz     everything, unpacked wherever you like, with a {{setupScriptName}}
#              that wires up the menu entry per-user — the offline path, for a
#              machine that cannot reach GitHub. Named so rather than
#              `install.sh`, because the repository root already has one of
#              those and it also installs the tarball; two files with one name
#              in one product is a coin flip for whoever finds one. Built by
#              scripts/pack-tarball.mjs, not by electron-builder, because a
#              tarball also has to carry usr/share/{applications,icons,metainfo}
#              and a way to register them.
#
# `pnpm -F @lasercode/desktop dist:linux` builds all of them and prints the
# artifact table. `electron-builder --linux` still works and builds the three
# formats below.

# Root-level keys, written here because everything they change is Linux.

# build/after-pack.cjs renames Electron's executable to `{{realBinary}}` and puts
# a POSIX shell launcher at `{{binary}}`, so the application menu, the
# /usr/bin entry, a double-clicked AppImage and the tarball's own copy all run
# the same code. That code makes one decision — which sandbox this kernel can offer — and
# it never disables the sandbox on the person's behalf.
afterPack: build/after-pack.cjs

toolsets:
  # THE REASON THE APPIMAGE NEEDS NO ROOT AND NO LIBFUSE2.
  #
  # electron-builder's default AppImage runtime ("0.0.0") is the 2018 type-2
  # runtime, which mounts itself with FUSE 2. Debian 12, Ubuntu 22.04 and later,
  # and Fedora ship FUSE 3 and no libfuse2, so that runtime prints
  # "dlopen(): error loading libfuse.so.2" and stops — and the usual answer,
  # `sudo apt install libfuse2`, is a terminal and a root password we promised
  # nobody would need.
  #
  # "1.0.3" is the current statically linked runtime: it links libfuse3 itself,
  # and where FUSE is unavailable entirely (a container, a hardened kernel) it
  # extracts itself to a temporary directory and runs from there. Nothing to
  # install, nothing to elevate.
  appimage: "1.0.3"

linux:
  target:
    - target: AppImage
      arch: [x64, arm64]
    - target: deb
      arch: [x64, arm64]
    - target: rpm
      arch: [x64, arm64]

  # The binary, the icon name and the .desktop basename, all one value from
  # product.json. build/after-pack.cjs and build/linux/apparmor.tpl read the
  # same file, so `{{realBinary}}` is never spelled twice.
  executableName: {{binary}}

  # product.json's copy.summary, the same words the AppStream metainfo and the
  # tarball's .desktop entry use. scripts/make-linux-assets.mjs fails the build
  # if this generated copy is edited in place and drifts.
  synopsis: {{copy.summary|json}}
  # One sentence on purpose: electron-builder always writes the .desktop
  # entry's `Comment` from this and ignores an override, and `Comment` is what
  # GNOME prints under the name in search results. The longer text lives in the
  # AppStream metainfo, which is the only surface with room for it.
  description: {{copy.description|json}}

  # Becomes `Categories=Development;IDE;`. `IDE` is a registered additional
  # category under `Development`, and it is where a desktop menu files the kind
  # of thing this is.
  category: {{categories|join:;}}

  # fpm refuses to build a package without a maintainer, and it is right to:
  # `apt show` and `rpm -qi` both print this line.
  maintainer: {{maintainer}}
  vendor: {{displayName}}

  # build/icons/{16,32,48,64,128,256,512}x*.png, written by scripts/make-icons.mjs.
  # Every size is a real render of the mark rather than one image scaled down,
  # so the 16px tray-sized icon is legible instead of mush.
  icon: build/icons

  # Install the entry as `{{desktopFileName}}`, matching `desktopName` in
  # package.json and therefore Electron's own Wayland app_id and X11 WM_CLASS.
  # Without this the compositor cannot tell that the running window belongs to
  # the menu entry, and the taskbar shows a generic icon with no name.
  syncDesktopName: true

  desktop:
    entry:
      # Exec, Icon, Name, Comment, Categories, StartupWMClass and MimeType are
      # all computed by electron-builder — MimeType from the `protocols` block
      # above, which is what registers {{urlScheme}}:// with the desktop. Setting
      # them here would be silently overwritten. What is left is what nothing
      # else supplies:
      StartupNotify: "true"
      # What someone types into GNOME's overview or KDE's launcher when they
      # cannot remember the name.
      Keywords: {{keywords|join:;}};
      # The app posts notifications when an agent needs an answer; GNOME uses
      # this to offer per-app notification settings.
      X-GNOME-UsesNotifications: "true"

appImage:
  artifactName: ${productName}-${version}-${arch}.${ext}

# ------------------------------------------------- deb and rpm: depends ----
#
# Declared rather than guessed. electron-builder's defaults are a reasonable
# list for Electron in general and wrong for this one in two directions: they
# ask for libxss1 and libxtst6, which Electron 44 no longer links or dlopens,
# and they omit libsecret, which it does dlopen and which the app needs for the
# keychain.
#
# The list is every DT_NEEDED entry of the shipped `electron` and `node`
# binaries, mapped to the package that owns the library, plus the three
# libraries Electron opens by name at runtime (libsecret-1.so.0 for the
# keychain, libnotify.so.4 for notifications, libpulse for audio) and
# xdg-utils, which is how the app opens a provider's sign-in page in the
# browser. Transitive dependencies are left to the package manager.
#
# The names are the pre-t64 ones on purpose: Ubuntu 24.04's libfoo-t64
# packages all `Provides:` the classic name, so this list resolves on Debian
# 12, Ubuntu 22.04 and Ubuntu 24.04 alike, while `libgtk-3-0t64` would resolve
# on none of them but the newest.
deb:
  # Two things fpm will not do from its own options.
  #
  #   * The AppStream metainfo at the system path. /opt is not somewhere GNOME
  #     Software or KDE Discover look, so the copy build/after-pack.cjs places
  #     inside the app (for the AppImage's AppDir) does not count here.
  #   * The licence field. There is no LICENSE file in the repository and no
  #     `license` in package.json, so fpm writes "unknown"; the truth is that
  #     the work is not licensed for redistribution, and saying so is better
  #     than leaving a blank for someone to fill in with a guess.
  #
  # Order matters: fpm's option parser stops reading options at the first
  # positional argument, so every flag has to come before the source=destination
  # pair or it is silently taken as another path to package.
  #
  # The path is relative because electron-builder.yml cannot compute an absolute
  # one. build/after-pack.cjs checks that it resolves before any target is
  # built, and says what to do if it does not.
  fpm:
    - --license
    - Proprietary
    - build/linux/generated/{{metainfoFileName}}=/usr/share/metainfo/{{metainfoFileName}}
    - build/linux/package-repository-key.asc=/usr/share/keyrings/{{binary}}-archive-keyring.asc
  # electron-builder's default pattern is `${name}_${version}_${arch}`, and
  # `${name}` is this package's npm name — a scoped one — which fpm then
  # reads as a directory that does not exist. The file is named after the
  # program, the way `apt` and `dnf` name it in their own listings, and after
  # the architecture the way that format spells it: amd64 for Debian,
  # x86_64 for RPM and the AppImage, matching `uname -m` where it can.
  artifactName: {{binary}}_${version}_${arch}.${ext}

  # Written by us rather than left to electron-builder's defaults, so that the
  # install registers the {{urlScheme}}:// handler and refreshes the icon and desktop
  # caches, and the removal undoes exactly that and nothing more. fpm maps them
  # onto postinst/%post and postrm/%postun, and both of those also run in the
  # middle of an *upgrade* — the scripts handle that.
  afterInstall: build/linux/after-install.sh
  afterRemove: build/linux/after-remove.sh
  # Ubuntu 23.10 and later will not give an unconfined program its own user
  # namespace, and a user namespace is what Chromium's sandbox is made of.
  appArmorProfile: build/linux/apparmor.tpl
  depends:
    - libasound2
    - libatk-bridge2.0-0
    - libatk1.0-0
    - libatspi2.0-0
    - libcairo2
    - libcups2
    - libdbus-1-3
    - libexpat1
    - libgbm1
    - libgcc-s1
    - libglib2.0-0
    - libgtk-3-0
    - libnotify4
    - libnspr4
    - libnss3
    - libpango-1.0-0
    - libsecret-1-0
    - libstdc++6
    - libudev1
    - libx11-6
    - libxcb1
    - libxcomposite1
    - libxdamage1
    - libxext6
    - libxfixes3
    - libxkbcommon0
    - libxrandr2
    - xdg-utils
  recommends:
    # The tools the post-install script uses to register the menu entry and the
    # {{urlScheme}}:// handler. Present on every desktop install; the scripts check
    # for each one before calling it, so a server install still succeeds.
    - desktop-file-utils
    - shared-mime-info
    # libsecret talks to a secret-service daemon over D-Bus. Without one the
    # app still runs and says its device key is stored unencrypted instead.
    - gnome-keyring | kwalletmanager
    # Audio for dictation. Electron falls back to ALSA without it.
    - libpulse0
  packageCategory: devel
  priority: optional

rpm:
  # Two things fpm will not do from its own options.
  #
  #   * The AppStream metainfo at the system path. /opt is not somewhere GNOME
  #     Software or KDE Discover look, so the copy build/after-pack.cjs places
  #     inside the app (for the AppImage's AppDir) does not count here.
  #   * The licence field. There is no LICENSE file in the repository and no
  #     `license` in package.json, so fpm writes "unknown"; the truth is that
  #     the work is not licensed for redistribution, and saying so is better
  #     than leaving a blank for someone to fill in with a guess.
  #
  # Order matters: fpm's option parser stops reading options at the first
  # positional argument, so every flag has to come before the source=destination
  # pair or it is silently taken as another path to package.
  #
  # The path is relative because electron-builder.yml cannot compute an absolute
  # one. build/after-pack.cjs checks that it resolves before any target is
  # built, and says what to do if it does not.
  fpm:
    - --license
    - Proprietary
    - build/linux/generated/{{metainfoFileName}}=/usr/share/metainfo/{{metainfoFileName}}
    - build/linux/package-repository-key.asc=/etc/pki/rpm-gpg/RPM-GPG-KEY-{{binary}}
  artifactName: {{binary}}-${version}.${arch}.${ext}

  # Written by us rather than left to electron-builder's defaults, so that the
  # install registers the {{urlScheme}}:// handler and refreshes the icon and desktop
  # caches, and the removal undoes exactly that and nothing more. fpm maps them
  # onto postinst/%post and postrm/%postun, and both of those also run in the
  # middle of an *upgrade* — the scripts handle that.
  afterInstall: build/linux/after-install.sh
  afterRemove: build/linux/after-remove.sh
  # Ubuntu 23.10 and later will not give an unconfined program its own user
  # namespace, and a user namespace is what Chromium's sandbox is made of.
  appArmorProfile: build/linux/apparmor.tpl
  # Fedora, openSUSE and RHEL name the same libraries differently, and one or
  # two of them differently again between releases — hence the boolean
  # dependencies, which rpm has understood since 4.13.
  depends:
    - alsa-lib
    - at-spi2-atk
    - at-spi2-core
    - atk
    - cairo
    - cups-libs
    - dbus-libs
    - expat
    - glib2
    - gtk3
    - libX11
    - libXcomposite
    - libXdamage
    - libXext
    - libXfixes
    - libXrandr
    - libgcc
    - libnotify
    - libsecret
    - libstdc++
    - libxcb
    - libxkbcommon
    - mesa-libgbm
    - nspr
    - nss
    - pango
    - "(systemd-libs or libudev1)"
    - xdg-utils

# --------------------------------------------------------------- Updates ----
# Deliberately unset, and the app says so: `Updater` reports `unsupported`
# ("this build has no update feed") rather than an error, because a check that
# structurally cannot succeed must not be reported as a check that failed.
#
# It was `provider: github, owner: {{repositoryOwner}}, repo: {{repositoryName}}`, which does
# not work: that repository is private, and electron-updater fetches
# `…/releases/download/<tag>/latest.yml` unauthenticated, so every installed
# copy would get a 404 forever. The only supported alternative for a private
# repo is `private: true` plus a token baked into `app-update.yml` inside the
# shipped app, which is a credential in an artifact and a non-starter.
#
# Two ways to turn updates on, either of which makes the feed public:
#
#   1. A public releases repository (the usual split when the source stays
#      private):
#        publish:
#          provider: github
#          owner: {{repositoryOwner}}
#          repo: {{repositoryName}}-releases
#          releaseType: release
#
#   2. Any public feed URL:
#        publish:
#          provider: generic
#          url: https://downloads.example.com/{{name}}/${channel}
#
# Until one of those is true, README.md's "publish version A, install it,
# publish version B" cannot pass, and the app is honest about why. `null` is
# explicit rather than absent so electron-builder does not infer a GitHub feed
# from a `repository` field somebody adds to package.json later.
publish: null
