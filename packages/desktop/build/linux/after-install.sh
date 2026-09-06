#!/bin/bash
# Runs as root after the deb or the rpm has unpacked its files.
# fpm turns this into Debian's `postinst` and RPM's `%post`, so it has to be
# correct under both: dpkg passes `configure <old-version>`, rpm passes `1` for
# a first install and `2` for an upgrade. Only the final guarded step needs to
# distinguish an upgrade from a first install.
#
# It does six things and nothing else. after-remove.sh reverses the persistent
# first five; the last is a one-time process signal and leaves nothing behind:
#
#   1. put `laser` on PATH
#   2. give Chromium a usable sandbox on kernels that need the setuid helper
#   3. refresh the three caches that make the menu entry, its icon and the
#      laser:// handler appear without a logout
#   4. install the AppArmor profile that lets the app open a user namespace on
#      Ubuntu 24.04 and later
#   5. register the signed native package repository, so the operating
#      system's normal updater discovers and announces later releases
#   6. on an upgrade, ask the running bundled daemon to reload the new files
#
# Every step is guarded: a machine without `gtk-update-icon-cache` or without
# AppArmor installs cleanly, it just does not get that step.

set -e

APP_DIR='/opt/${sanitizedProductName}'
EXE='${executable}'
BIN="$APP_DIR/$EXE"

# ------------------------------------------------------------ 1. PATH ----

if type update-alternatives >/dev/null 2>&1; then
    # A previous version may have left a plain symlink where update-alternatives
    # now wants to manage one; remove it first or the install below is ignored.
    if [ -L "/usr/bin/$EXE" ] && [ -e "/usr/bin/$EXE" ] &&
        [ "$(readlink "/usr/bin/$EXE")" != "/etc/alternatives/$EXE" ]; then
        rm -f "/usr/bin/$EXE"
    fi
    update-alternatives --install "/usr/bin/$EXE" "$EXE" "$BIN" 100 ||
        ln -sf "$BIN" "/usr/bin/$EXE"
else
    ln -sf "$BIN" "/usr/bin/$EXE"
fi

# --------------------------------------------------------- 2. sandbox ----

# Chromium sandboxes each renderer in a user namespace and needs no privileges
# to do it. The setuid helper is the fallback for kernels that refuse an
# unprivileged process a namespace, and it is only worth the extra attack
# surface of a setuid binary on exactly those kernels.
#
# The obvious test — "can I unshare a user namespace?" — is worthless here,
# because this script runs as root and root always can. So ask the two kernel
# knobs that switch the feature off for everybody instead. That is the state
# the person's own account will meet when they start the app.
needs_setuid_helper() {
    if [ -r /proc/sys/kernel/unprivileged_userns_clone ] &&
        [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then
        return 0
    fi
    if [ -r /proc/sys/user/max_user_namespaces ] &&
        [ "$(cat /proc/sys/user/max_user_namespaces)" = "0" ]; then
        return 0
    fi
    # Ubuntu 23.10+ may leave both generic namespace knobs enabled while
    # AppArmor denies user namespaces to unconfined programs. The launcher
    # probes through /usr/bin/unshare, which is deliberately unconfined and is
    # therefore denied even when Laser's own profile grants `userns` to the
    # Electron binary. Native packages have a root-owned helper available, so
    # enable that deterministic fallback instead of making launch depend on a
    # probe performed under a different AppArmor profile.
    if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] &&
        [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "1" ]; then
        return 0
    fi
    return 1
}

if [ -e "$APP_DIR/chrome-sandbox" ]; then
    if needs_setuid_helper; then
        chown root:root "$APP_DIR/chrome-sandbox" || true
        chmod 4755 "$APP_DIR/chrome-sandbox" || true
    else
        chmod 0755 "$APP_DIR/chrome-sandbox" || true
    fi
fi

# ---------------------------------------------------------- 3. caches ----

# update-desktop-database is what registers laser:// : it reads the
# MimeType= line out of the .desktop entry and writes the mimeinfo cache the
# desktop environment consults when something opens a laser:// link.
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash update-mime-database 2>/dev/null && [ -d /usr/share/mime ]; then
    update-mime-database /usr/share/mime || true
fi

# Without this the menu entry appears with a generic gear until the next login.
if hash gtk-update-icon-cache 2>/dev/null && [ -d /usr/share/icons/hicolor ]; then
    gtk-update-icon-cache --force --quiet --ignore-theme-index /usr/share/icons/hicolor || true
fi

# -------------------------------------------------------- 4. AppArmor ----

# Ubuntu 23.10 and later refuse an unconfined program its own user namespace
# unless a profile grants `userns`. Without this, Chromium falls back to the
# setuid helper — which step 2 deliberately did not install on these kernels,
# because they *can* do namespaces. The profile is what closes that circle.
#
# The dry run guards Ubuntu 22.04 and Debian 12, whose AppArmor does not know
# abi/4.0: there the profile is skipped and the app runs fine without it.
if apparmor_status --enabled >/dev/null 2>&1; then
    APPARMOR_SOURCE="$APP_DIR/resources/apparmor-profile"
    APPARMOR_TARGET="/etc/apparmor.d/$EXE"
    if [ -f "$APPARMOR_SOURCE" ] &&
        apparmor_parser --skip-kernel-load --debug "$APPARMOR_SOURCE" >/dev/null 2>&1; then
        cp -f "$APPARMOR_SOURCE" "$APPARMOR_TARGET"
        # Loading a policy into the running kernel is meaningless inside a
        # chroot (image builders), so skip it there and let the next boot do it.
        if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_TARGET" || true
        fi
    else
        echo "$EXE: this version of AppArmor does not understand the bundled profile; skipping it."
    fi
fi

# -------------------------------------------------------- 5. updates ----

REPO_OWNER='youssefsiam38'
REPO_NAME='laser'
PAGES_BASE="https://$REPO_OWNER.github.io/$REPO_NAME"

# The key itself is owned by the package (the fpm mapping in
# electron-builder.yml); these small source files are created here because the
# URL needs shell variables that fpm does not expand. Do not run apt-get update
# from a dpkg maintainer script: dpkg already holds the package-manager lock.
# Ubuntu's apt-daily/GNOME Software refresh will pick it up normally.
APT_KEY="/usr/share/keyrings/$EXE-archive-keyring.asc"
if [ -f "$APT_KEY" ] && [ -d /etc/apt/sources.list.d ]; then
    printf 'deb [arch=amd64,arm64 signed-by=%s] %s/apt stable main\n' "$APT_KEY" "$PAGES_BASE" \
        >"/etc/apt/sources.list.d/$EXE.list"
fi

RPM_KEY="/etc/pki/rpm-gpg/RPM-GPG-KEY-$EXE"
if [ -f "$RPM_KEY" ] && [ -d /etc/yum.repos.d ]; then
    cat >"/etc/yum.repos.d/$EXE.repo" <<EOF
[$EXE]
name=$EXE
baseurl=$PAGES_BASE/rpm/\$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file://$RPM_KEY
metadata_expire=6h
EOF
fi

# ------------------------------------------------- 6. daemon refresh ----

# dpkg gives postinst `configure <old-version>` on an upgrade; rpm gives `%post`
# the argument 2. Once the new files are completely in place, retire only a
# daemon whose first three argv entries identify this exact native install.
# SIGHUP is a graceful host shutdown: the desktop supervisor immediately starts
# it again from the newly installed files. A command-started host stays stopped
# until the person next opens Laser or runs `laser up`.
if [ -n "${2:-}" ] || [ "${1:-}" = "2" ]; then
    NODE="$APP_DIR/resources/runtime/node"
    CLI="$APP_DIR/resources/app.asar.unpacked/node_modules/@lasercode/cli/dist/main.js"
    for command_file in /proc/[0-9]*/cmdline; do
        [ -r "$command_file" ] || continue
        command_line=$(tr '\0' ' ' <"$command_file" 2>/dev/null || true)
        case "$command_line" in
            "$NODE $CLI __daemon "*)
                pid=${command_file#/proc/}
                pid=${pid%/cmdline}
                kill -HUP "$pid" 2>/dev/null || true
                ;;
        esac
    done
fi

exit 0
