#!/bin/sh
# {{displayName}}'s Linux launcher.
#
# GENERATED from build/linux/launcher.sh.tpl by scripts/make-linux-assets.mjs.
# Every name comes from product.json (MX-T7); edit the template.
#
# `build/after-pack.cjs` renames Electron's own executable to `{{realBinary}}`
# and installs this script in its place, so that every route into the app runs
# it: the application menu, /usr/bin/{{binary}}, a double-clicked AppImage, and
# ./{{binary}} straight out of the tarball. It exists for exactly three
# decisions that cannot be made at build time, and it makes no others.
#
#   1. Window or command. One installed program is named `{{binary}}`, and a
#      person who types `{{binary}} doctor` means the command, not the window.
#   2. The sandbox. Chromium can only sandbox a renderer two ways on Linux, and
#      which ones exist depends on the kernel and on how the app was installed.
#   3. Fractional scaling on Wayland, which needs one feature flag to stay sharp.
#
# It is POSIX sh, not bash: the tarball has to work on Alpine and on anything
# else where /bin/bash is not a given.

set -eu

# --- identity, from product.json ---------------------------------------------
product={{displayName|json}}
binary={{binary|json}}
real_binary={{realBinary|json}}
scheme={{urlScheme|json}}
env_prefix={{envPrefix|json}}
# The one variable this script reads, resolved through the prefix so a rename
# does not leave a person's shell profile pointing at a name nothing answers to.
eval "disable_sandbox=\${${env_prefix}_DISABLE_SANDBOX-}"
disable_sandbox_var="${env_prefix}_DISABLE_SANDBOX"
# -----------------------------------------------------------------------------

# ---------------------------------------------------------------- paths ----

# $0 is a symlink on a deb/rpm install (/usr/bin/<name> -> /opt/<name>/<name>),
# so resolve it before looking for anything next to it.
self=$(readlink -f "$0" 2>/dev/null || echo "$0")
here=$(dirname "$self")
real="$here/$real_binary"
helper="$here/chrome-sandbox"

if [ ! -x "$real" ]; then
  echo "$product: the application files are incomplete — $real is missing." >&2
  echo "Reinstall $product; if you unpacked a tarball, unpack it again without" >&2
  echo "excluding any files." >&2
  exit 1
fi

# ------------------------------------------------------ what was passed ----

# Read the arguments once. Nothing below re-scans them.
user_chose_sandbox=0
user_chose_features=0
# Did AppRun invoke us?
#
# A *mounted* AppImage is easy: the AppImage runtime exports APPIMAGE and
# APPDIR into the environment before it runs anything. An *extracted* AppDir is
# not: electron-builder's AppRun assigns APPDIR itself (`APPDIR="$path"`, no
# `export`) and APPIMAGE likewise, so neither variable reaches us and neither
# is evidence of anything. install.sh now points the launcher symlink and the
# .desktop entry at this script rather than at AppRun, so that path should not
# happen at all — but "should not" is not a safety property, and the failure it
# used to produce was silent: piorbit running with no sandbox and no message.
#
# So the third test is the shape AppRun's injection actually has. AppRun builds
# `exec "$BIN" --no-sandbox "$@"`, always prepending, so an AppDir that has an
# AppRun beside us and hands us --no-sandbox as the *first* argument is that
# case and nothing else. A person typing `piorbit --no-sandbox` past this ends
# up in the same place by a different door: PIORBIT_DISABLE_SANDBOX=1, which is
# checked immediately below and survives.
from_apprun=0
if [ -n "${APPDIR-}" ] || [ -n "${APPIMAGE-}" ]; then
  from_apprun=1
elif [ -f "$here/AppRun" ] && [ "${1-}" = "--no-sandbox" ]; then
  from_apprun=1
fi

for arg in "$@"; do
  case "$arg" in
    --no-sandbox | --disable-setuid-sandbox | --disable-namespace-sandbox | --disable-gpu-sandbox)
      user_chose_sandbox=1
      ;;
    --enable-features=*)
      user_chose_features=1
      ;;
  esac
done

# AppRun probes for user namespaces with `unshare -Ur true` and, when the probe
# fails, quietly *prepends* --no-sandbox before handing over to us. That is
# a security decision made on the person's behalf without telling them, so we
# undo it and make the same decision out loud further down. A person who really
# wants no sandbox says so with that variable set to 1, which survives this.
if [ "$from_apprun" -eq 1 ] && [ "$disable_sandbox" != "1" ]; then
  stripped=0
  # Rotate the argument list once: take the head off, and put it back on the
  # tail unless it is the flag we are dropping. The sentinel marks where the
  # original list ended, since sh has no arrays to copy into.
  set -- ${1+"$@"} "--$binary-end-of-args"
  while [ "$1" != "--$binary-end-of-args" ]; do
    arg=$1
    shift
    if [ "$arg" = "--no-sandbox" ]; then
      stripped=1
    else
      set -- ${1+"$@"} "$arg"
    fi
  done
  shift # drop the sentinel
  if [ "$stripped" -eq 1 ]; then
    user_chose_sandbox=0
    echo "$product: ignoring the AppImage runtime's --no-sandbox; deciding for ourselves." >&2
  fi
fi

# -------------------------------------------------- window or command ----

# `~/.local/bin/{{binary}}` is the only thing on the person's PATH called
# {{binary}}, and it has two jobs. The window is what a menu entry, a
# {{urlScheme}}:// link and a bare `{{binary}}` mean. A first argument that is
# an ordinary word — `doctor`,
# `sessions`, `up` — is a command, and it goes to the CLI running on the same
# bundled Node the app itself uses, so a terminal and the window resolve the
# same agent directory and show the same sessions.
#
# Anything starting with `-` stays with the window, because those are Chromium's
# flags and Electron's own relaunch passes them. The four a person actually
# types to mean the command are named explicitly.
#
# This runs *after* AppRun's injected --no-sandbox has been stripped above, and
# it has to: on an installed copy the argument list AppRun hands over starts
# with that flag, so deciding here first would send `{{binary}} doctor` to the
# window and a person would get a staring match instead of a diagnosis.
cli="$here/resources/app.asar.unpacked/node_modules/@lasercode/cli/dist/main.js"
node="$here/resources/runtime/node"

run_cli() {
  if [ ! -x "$node" ] || [ ! -f "$cli" ]; then
    echo "$product: the $binary command is missing from this installation." >&2
    echo "Reinstall $product; the window may still open from your application menu." >&2
    exit 1
  fi
  exec "$node" "$cli" ${1+"$@"}
}

case "${1-}" in
  "") ;;                        # the window
  "$scheme"://*) ;;             # a link handed over by the desktop
  --help | -h | --version | -v) run_cli ${1+"$@"} ;;
  -*) ;;                        # a Chromium or Electron flag: the window
  *) run_cli ${1+"$@"} ;;
esac

# --------------------------------------------------------- the sandbox ----

# Chromium prefers the *namespace* sandbox: it puts each renderer in its own
# user namespace and a seccomp filter, and needs no privileges at all to do it.
# Only when the kernel refuses to hand an unprivileged process a user namespace
# does it fall back to the setuid helper, `chrome-sandbox`, which the deb and
# rpm install as root-owned mode 4755.
#
# A per-user install — the tarball, or an AppImage in ~/Downloads — has no root
# and therefore cannot have a setuid helper. That is fine, and it is why this
# passes no flag in the normal case: the namespace sandbox is the real sandbox,
# and it is the one that works without privileges. Verified on Ubuntu 24.04
# with a non-setuid helper: the renderer runs with Seccomp: 2 in a user
# namespace of its own.
#
# --no-sandbox is never added here on piorbit's own initiative. If neither
# mechanism is available the app says so and stops, because a coding agent with
# an unsandboxed renderer is a different product from the one that was
# installed.

can_make_user_namespace() {
  [ -e /proc/self/ns/user ] || return 1

  if command -v unshare >/dev/null 2>&1; then
    unshare --user --map-root-user true 2>/dev/null
    return $?
  fi

  # No unshare(1) to test with (busybox, a stripped container). Fall back to
  # the two knobs that switch the feature off, and believe the kernel when
  # neither of them says no.
  if [ -r /proc/sys/kernel/unprivileged_userns_clone ] &&
    [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then
    return 1
  fi
  if [ -r /proc/sys/user/max_user_namespaces ] &&
    [ "$(cat /proc/sys/user/max_user_namespaces)" = "0" ]; then
    return 1
  fi
  return 0
}

helper_is_installed_setuid() {
  [ -u "$helper" ] || return 1
  [ "$(stat -c %u "$helper" 2>/dev/null || echo -1)" = "0" ]
}

# Show a message on the screen when there is no terminal to show it in. A
# launcher started from the application menu has stderr pointed at the journal,
# which nobody reads at the moment the app fails to open. With a terminal, or
# with no display to draw a dialog on, the text on stderr is the whole message.
report() {
  echo "$1" >&2
  if [ -t 2 ]; then return 0; fi
  if [ -z "${DISPLAY-}" ] && [ -z "${WAYLAND_DISPLAY-}" ]; then return 0; fi
  # `LD_LIBRARY_PATH=` with nothing after it is deliberate: Electron points that
  # variable at its own bundled libraries, and a dialog helper that inherits it
  # loads the wrong libstdc++ and dies. Emptying it for the child is the fix.
  # shellcheck disable=SC1007
  if command -v zenity >/dev/null 2>&1; then
    LD_LIBRARY_PATH= zenity --error --title="$product" --width=520 --text "$1" 2>/dev/null || true
  elif command -v kdialog >/dev/null 2>&1; then
    LD_LIBRARY_PATH= kdialog --title "$product" --error "$1" 2>/dev/null || true
  fi
}

# Which sysctl is actually holding namespaces shut on *this* machine. Naming
# the wrong one is worse than naming none: the person runs a command, it
# succeeds, nothing changes, and they conclude the app is broken. Ubuntu 24.04
# uses the AppArmor knob; Debian's older patch uses unprivileged_userns_clone;
# either can be capped by user.max_user_namespaces.
namespace_fix=""
if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] &&
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  namespace_fix="        sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
fi
if [ -r /proc/sys/kernel/unprivileged_userns_clone ] &&
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ]; then
  namespace_fix="${namespace_fix:+$namespace_fix
}        sudo sysctl -w kernel.unprivileged_userns_clone=1"
fi
if [ -r /proc/sys/user/max_user_namespaces ] &&
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" = "0" ]; then
  namespace_fix="${namespace_fix:+$namespace_fix
}        sudo sysctl -w user.max_user_namespaces=15000"
fi
if [ -z "$namespace_fix" ]; then
  namespace_fix="        (no sysctl on this machine reports namespaces as disabled, so
        this is likely a container or a seccomp policy rather than a knob
        you can turn — option 1 or 3 is the way out.)"
fi

if [ "$user_chose_sandbox" -eq 0 ]; then
  if ! can_make_user_namespace && ! helper_is_installed_setuid; then
    if [ "$disable_sandbox" = "1" ]; then
      echo "$product: starting WITHOUT a sandbox because $disable_sandbox_var=1." >&2
      set -- --no-sandbox ${1+"$@"}
    else
      report "$product cannot start, because this machine offers no way to sandbox it.

Every page $product renders — an agent's answer, a diff, a preview — runs inside
a sandbox so that it cannot reach the rest of your computer. Linux provides two
ways to build one, and neither is available here:

  • the kernel will not give an ordinary program its own user namespace, and
  • the helper at
        $helper
    is not installed with root permissions.

Any one of these fixes it:

  1. Install the .deb or .rpm package instead of this copy. Installing as root
     sets the helper up correctly and this message goes away. This is the fix
     on Ubuntu 24.04 and anything based on it.

  2. Turn user namespaces back on, if your administrator allows it. Which knob
     depends on why they are off:
$namespace_fix

  3. Run this copy with no sandbox at all, accepting that anything $product
     renders can read the files your account can read:
        $disable_sandbox_var=1 $binary"
      exit 1
    fi
  fi
fi

# ------------------------------------------------- Wayland and X11 both ----

# Electron 44 picks the display server by itself — under a Wayland session it
# connects to Wayland, otherwise to X11 — so nothing here chooses a platform.
# (Checked against the shipped binary: --ozone-platform-hint no longer exists
# in this version, and a Wayland session yields a native Wayland client.)
#
# One thing does need saying. On Wayland at a fractional scale such as 125% or
# 150%, a client that does not speak wp-fractional-scale-v1 renders at 200% and
# lets the compositor shrink the result, and text comes out soft. Asking for
# the protocol makes Chromium render at the exact scale instead. The flag is a
# no-op where it is already the default, and unknown feature names are ignored,
# so this is safe across Electron versions.
#
# X11 needs nothing: Chromium reads Xft.dpi and renders at that scale. Forcing
# --force-device-scale-factor here would override whatever the person set in
# their own display settings, which is worse than doing nothing.
if [ "$user_chose_features" -eq 0 ]; then
  if [ -n "${WAYLAND_DISPLAY-}" ] || [ "${XDG_SESSION_TYPE-}" = "wayland" ]; then
    set -- --enable-features=WaylandFractionalScaleV1 ${1+"$@"}
  fi
fi

exec "$real" ${1+"$@"}
