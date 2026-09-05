#!/bin/sh
# Ships inside piorbit's .tar.gz as piorbit-setup.sh — the offline path.
#
# The tarball is the format for machines that are not Debian and not Fedora, or
# where nobody has a root password, or that cannot reach GitHub at all. So this
# asks for nothing and downloads nothing: it registers the copy you already
# unpacked, for your account only, under ~/.local — the menu entry, the icon,
# the piorbit:// handler and a `piorbit` command on PATH.
#
#   ./piorbit-setup.sh              register this directory
#   ./piorbit-setup.sh --uninstall  remove everything it created
#
# It is deliberately NOT called install.sh. The repository root has an
# install.sh that fetches a release and installs it, `--format tar` included,
# and two files with one name in one product is a coin flip for whoever finds
# one of them. If you got here from a download page rather than a one-line
# install command, this is the script you want.
#
# It never moves or copies the application itself. The directory you unpacked
# is where it stays, and deleting that directory (after --uninstall) is the
# whole of getting rid of piorbit.

set -eu

app_dir=$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
bin_dir=$HOME/.local/bin
desktop_file=$data_home/applications/piorbit.desktop
metainfo_file=$data_home/metainfo/dev.piorbit.desktop.metainfo.xml
icon_root=$data_home/icons/hicolor
icon_sizes="16 32 48 64 128 256 512"

refresh_caches() {
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$data_home/applications" 2>/dev/null || true
    fi
    if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d "$icon_root" ]; then
        gtk-update-icon-cache --force --quiet --ignore-theme-index "$icon_root" 2>/dev/null || true
    fi
}

# These paths are byte-identical to the ones the repository's install.sh writes
# for a home-directory install. So nothing is removed without first checking it
# points at *this* unpacked copy: otherwise unpacking a tarball to try a build
# and then undoing it would take the menu entry, the icons and the `piorbit`
# command belonging to the copy the person actually installed.
points_at_us() {
    # points_at_us <symlink>
    [ -L "$1" ] || return 1
    [ "$(readlink -f "$1" 2>/dev/null)" = "$(readlink -f "$app_dir/piorbit" 2>/dev/null)" ]
}

entry_is_ours() {
    [ -f "$desktop_file" ] || return 1
    grep -q "^Exec=$app_dir/piorbit" "$desktop_file"
}

uninstall() {
    kept=""
    if entry_is_ours; then
        rm -f "$desktop_file" "$metainfo_file"
        for size in $icon_sizes; do
            rm -f "$icon_root/${size}x${size}/apps/piorbit.png"
        done
    elif [ -f "$desktop_file" ]; then
        kept="yes"
    fi
    if points_at_us "$bin_dir/piorbit"; then
        rm -f "$bin_dir/piorbit"
    elif [ -e "$bin_dir/piorbit" ]; then
        kept="yes"
    fi
    refresh_caches
    if [ -n "$kept" ]; then
        echo "Another piorbit is installed on this account — its menu entry, icons and"
        echo "\`piorbit\` command point somewhere other than"
        echo "    $app_dir"
        echo "so they were left alone. Nothing that belongs to this unpacked copy remains."
    else
        echo "piorbit is no longer in your application menu, and piorbit:// links no"
        echo "longer open it."
    fi
    echo "The application itself is still at:"
    echo "    $app_dir"
    echo "Delete that directory to finish removing it."
}

if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    exit 0
fi

if [ "${1:-}" != "" ]; then
    echo "piorbit-setup.sh takes no arguments, or --uninstall." >&2
    exit 2
fi

if [ ! -x "$app_dir/piorbit" ]; then
    echo "This does not look like an unpacked piorbit: there is no piorbit" >&2
    echo "program next to piorbit-setup.sh. Unpack the .tar.gz again and run" >&2
    echo "the piorbit-setup.sh inside it." >&2
    exit 1
fi

# Registering this copy takes over the menu entry and the `piorbit` command from
# whatever held them. Say so before doing it, rather than leaving someone to
# discover later that their installed copy stopped launching.
if [ -f "$desktop_file" ] && ! grep -q "^Exec=$app_dir/piorbit" "$desktop_file"; then
    echo "Note: piorbit is already registered on this account, pointing at"
    echo "    $(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$desktop_file" | head -n 1)"
    echo "Registering this copy replaces the menu entry, the icons and the \`piorbit\`"
    echo "command. The other copy stays on disk and can be re-registered the same way."
    echo
fi

mkdir -p "$bin_dir" "$data_home/applications" "$data_home/metainfo"

# The .desktop entry, with Exec pointing at wherever this copy actually lives.
# The shipped file says `Exec=piorbit`, which only works when ~/.local/bin is on
# PATH; an absolute path works even when it is not.
sed "s|^Exec=piorbit |Exec=${app_dir}/piorbit |" \
    "$app_dir/usr/share/applications/piorbit.desktop" >"$desktop_file"
chmod 0644 "$desktop_file"

cp -f "$app_dir/usr/share/metainfo/dev.piorbit.desktop.metainfo.xml" "$metainfo_file"
chmod 0644 "$metainfo_file"

for size in $icon_sizes; do
    source_icon="$app_dir/usr/share/icons/hicolor/${size}x${size}/apps/piorbit.png"
    [ -f "$source_icon" ] || continue
    mkdir -p "$icon_root/${size}x${size}/apps"
    cp -f "$source_icon" "$icon_root/${size}x${size}/apps/piorbit.png"
done

ln -sf "$app_dir/piorbit" "$bin_dir/piorbit"

refresh_caches

echo "piorbit is installed for $(id -un)."
echo
echo "  Application menu   piorbit (search for it if it does not appear at once)"
echo "  Command            $bin_dir/piorbit"
echo "  Links              piorbit:// URLs now open this copy"
echo "  Remove it          $app_dir/piorbit-setup.sh --uninstall"

case ":${PATH}:" in
    *":$bin_dir:"*) ;;
    *)
        echo
        echo "One thing is not finished: $bin_dir is not on your PATH, so typing"
        echo "\`piorbit\` in a terminal will not find it. The menu entry works either"
        echo "way. To fix the command as well, add this line to ~/.profile (bash, sh)"
        echo "or ~/.zshrc (zsh) and open a new terminal:"
        echo
        echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
        ;;
esac
