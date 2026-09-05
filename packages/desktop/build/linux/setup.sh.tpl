#!/bin/sh
# Ships inside {{displayName}}'s .tar.gz as {{setupScriptName}} — the offline path.
#
# Generated from build/linux/setup.sh.tpl by scripts/make-linux-assets.mjs.
# Every name below comes from product.json (MX-T7); do not edit the generated
# copy, edit the template.
#
# The tarball is the format for machines that are not Debian and not Fedora, or
# where nobody has a root password, or that cannot reach GitHub at all. So this
# asks for nothing and downloads nothing: it registers the copy you already
# unpacked, for your account only, under ~/.local — the menu entry, the icon,
# the {{urlScheme}}:// handler and a `{{binary}}` command on PATH.
#
#   ./{{setupScriptName}}              register this directory
#   ./{{setupScriptName}} --uninstall  remove everything it created
#
# It is deliberately NOT called install.sh. The repository root has an
# install.sh that fetches a release and installs it, `--format tar` included,
# and two files with one name in one product is a coin flip for whoever finds
# one of them. If you got here from a download page rather than a one-line
# install command, this is the script you want.
#
# It never moves or copies the application itself. The directory you unpacked
# is where it stays, and deleting that directory (after --uninstall) is the
# whole of getting rid of {{displayName}}.

set -eu

# --- identity, from product.json ---------------------------------------------
display={{displayName|json}}
binary={{binary|json}}
scheme={{urlScheme|json}}
desktop_name={{desktopFileName|json}}
metainfo_name={{metainfoFileName|json}}
setup_name={{setupScriptName|json}}
icon_sizes="{{iconSizes|spaced}}"
# -----------------------------------------------------------------------------

app_dir=$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
bin_dir=$HOME/.local/bin
desktop_file=$data_home/applications/$desktop_name
metainfo_file=$data_home/metainfo/$metainfo_name
icon_root=$data_home/icons/hicolor

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
# and then undoing it would take the menu entry, the icons and the command
# belonging to the copy the person actually installed.
points_at_us() {
    # points_at_us <symlink>
    [ -L "$1" ] || return 1
    [ "$(readlink -f "$1" 2>/dev/null)" = "$(readlink -f "$app_dir/$binary" 2>/dev/null)" ]
}

entry_is_ours() {
    [ -f "$desktop_file" ] || return 1
    grep -q "^Exec=$app_dir/$binary" "$desktop_file"
}

uninstall() {
    kept=""
    if entry_is_ours; then
        rm -f "$desktop_file" "$metainfo_file"
        for size in $icon_sizes; do
            rm -f "$icon_root/${size}x${size}/apps/$binary.png"
        done
    elif [ -f "$desktop_file" ]; then
        kept="yes"
    fi
    if points_at_us "$bin_dir/$binary"; then
        rm -f "$bin_dir/$binary"
    elif [ -e "$bin_dir/$binary" ]; then
        kept="yes"
    fi
    refresh_caches
    if [ -n "$kept" ]; then
        echo "Another $display is installed on this account — its menu entry, icons and"
        echo "\`$binary\` command point somewhere other than"
        echo "    $app_dir"
        echo "so they were left alone. Nothing that belongs to this unpacked copy remains."
    else
        echo "$display is no longer in your application menu, and $scheme:// links no"
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
    echo "$setup_name takes no arguments, or --uninstall." >&2
    exit 2
fi

if [ ! -x "$app_dir/$binary" ]; then
    echo "This does not look like an unpacked $display: there is no $binary" >&2
    echo "program next to $setup_name. Unpack the .tar.gz again and run" >&2
    echo "the $setup_name inside it." >&2
    exit 1
fi

# Registering this copy takes over the menu entry and the command from whatever
# held them. Say so before doing it, rather than leaving someone to discover
# later that their installed copy stopped launching.
if [ -f "$desktop_file" ] && ! grep -q "^Exec=$app_dir/$binary" "$desktop_file"; then
    echo "Note: $display is already registered on this account, pointing at"
    echo "    $(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$desktop_file" | head -n 1)"
    echo "Registering this copy replaces the menu entry, the icons and the \`$binary\`"
    echo "command. The other copy stays on disk and can be re-registered the same way."
    echo
fi

mkdir -p "$bin_dir" "$data_home/applications" "$data_home/metainfo"

# The .desktop entry, with Exec pointing at wherever this copy actually lives.
# The shipped file says `Exec=<binary>`, which only works when ~/.local/bin is
# on PATH; an absolute path works even when it is not.
sed "s|^Exec=$binary |Exec=${app_dir}/$binary |" \
    "$app_dir/usr/share/applications/$desktop_name" >"$desktop_file"
chmod 0644 "$desktop_file"

cp -f "$app_dir/usr/share/metainfo/$metainfo_name" "$metainfo_file"
chmod 0644 "$metainfo_file"

for size in $icon_sizes; do
    source_icon="$app_dir/usr/share/icons/hicolor/${size}x${size}/apps/$binary.png"
    [ -f "$source_icon" ] || continue
    mkdir -p "$icon_root/${size}x${size}/apps"
    cp -f "$source_icon" "$icon_root/${size}x${size}/apps/$binary.png"
done

ln -sf "$app_dir/$binary" "$bin_dir/$binary"

refresh_caches

echo "$display is installed for $(id -un)."
echo
echo "  Application menu   $display (search for it if it does not appear at once)"
echo "  Command            $bin_dir/$binary"
echo "  Links              $scheme:// URLs now open this copy"
echo "  Remove it          $app_dir/$setup_name --uninstall"

case ":${PATH}:" in
    *":$bin_dir:"*) ;;
    *)
        echo
        echo "One thing is not finished: $bin_dir is not on your PATH, so typing"
        echo "\`$binary\` in a terminal will not find it. The menu entry works either"
        echo "way. To fix the command as well, add this line to ~/.profile (bash, sh)"
        echo "or ~/.zshrc (zsh) and open a new terminal:"
        echo
        echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
        ;;
esac
