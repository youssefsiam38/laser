#!/bin/bash
# Runs as root after the deb or the rpm has removed its files.
# fpm turns this into Debian's `postrm` and RPM's `%postun`, and both of them
# also call it in the middle of an *upgrade* — dpkg with `upgrade`, rpm with
# `1` — at a moment when the new version's files are already in place. Undoing
# the install there would break the upgrade, so that case returns immediately.
#
# What is left undoes exactly what after-install.sh did, in reverse order.

set -e

APP_DIR='/opt/${sanitizedProductName}'
EXE='${executable}'

case "${1:-}" in
    upgrade | failed-upgrade | abort-upgrade | abort-install | disappear | 1)
        exit 0
        ;;
esac

# ----------------------------------------------------- 5. updates ----

rm -f "/etc/apt/sources.list.d/$EXE.list"
rm -f "/etc/yum.repos.d/$EXE.repo"

# ----------------------------------------------------- 4. AppArmor ----

APPARMOR_TARGET="/etc/apparmor.d/$EXE"
if [ -f "$APPARMOR_TARGET" ]; then
    # Unload before deleting, or the policy stays enforced against a path that
    # no longer exists until the machine reboots.
    if apparmor_status --enabled >/dev/null 2>&1 &&
        ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove "$APPARMOR_TARGET" || true
    fi
    rm -f "$APPARMOR_TARGET"
fi

# ------------------------------------------------------- 1. PATH ----

if type update-alternatives >/dev/null 2>&1; then
    # --remove takes the real path, not the generic symlink.
    update-alternatives --remove "$EXE" "$APP_DIR/$EXE" || true
elif [ -L "/usr/bin/$EXE" ] && [ "$(readlink -f "/usr/bin/$EXE" 2>/dev/null)" = "$APP_DIR/$EXE" ]; then
    # Only our own symlink. On a machine that also has a home-directory install,
    # or a second copy registered some other way, /usr/bin/laser may not be
    # ours — and removing this package must not break that one.
    rm -f "/usr/bin/$EXE"
fi

# ------------------------------------------------------ 3. caches ----

# Same three caches as the install, so the menu entry, its icon and the
# laser:// handler disappear now rather than at the next login.
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash update-mime-database 2>/dev/null && [ -d /usr/share/mime ]; then
    update-mime-database /usr/share/mime || true
fi

if hash gtk-update-icon-cache 2>/dev/null && [ -d /usr/share/icons/hicolor ]; then
    gtk-update-icon-cache --force --quiet --ignore-theme-index /usr/share/icons/hicolor || true
fi

# Step 2 needs no undoing: chrome-sandbox lived inside $APP_DIR, which the
# package manager has already deleted.

exit 0
