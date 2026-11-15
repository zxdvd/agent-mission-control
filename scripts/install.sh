#!/bin/sh
# Installs only. Never starts a service or changes global configuration.
set -eu
ZIP=${1:?Usage: install.sh ARCHIVE.zip [INSTALL_DIR]}
BASE=${2:-"$HOME/.local/share/agent-workbench"}
ZIP=$(CDPATH= cd -- "$(dirname -- "$ZIP")" && pwd)/$(basename -- "$ZIP")
# ZIP's built-in integrity check needs no separate checksum file or user step.
unzip -tq "$ZIP" >/dev/null || { echo 'Invalid or damaged ZIP; nothing installed.' >&2; exit 1; }
mkdir -p "$BASE/releases" "$BASE/data" "$BASE/config"
BASE=$(CDPATH= cd -- "$BASE" && pwd)
STAGE=$(mktemp -d "$BASE/releases/.install.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
# Extract only known files from our release package.
unzip -q "$ZIP" agent-workbench VERSION PLATFORM run.sh install.sh README.md -d "$STAGE"
VERSION=$(cat "$STAGE/VERSION")
case "$VERSION" in ''|*[!0-9A-Za-z._-]*|.*) echo 'Invalid release version' >&2; exit 1;; esac
case "$(uname -s)" in Darwin) OS=darwin;; Linux) OS=linux;; *) echo 'Unsupported OS' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64) ARCH=amd64;; *) echo 'Unsupported CPU' >&2; exit 1;; esac
[ "$(cat "$STAGE/PLATFORM")" = "$OS/$ARCH" ] || { echo 'Release does not match this machine.' >&2; exit 1; }
[ ! -e "$BASE/releases/$VERSION" ] || { echo "Version $VERSION already installed; left unchanged." >&2; exit 1; }
chmod +x "$STAGE/agent-workbench" "$STAGE/run.sh" "$STAGE/install.sh"
mv "$STAGE" "$BASE/releases/$VERSION"
ln -sfn "releases/$VERSION" "$BASE/current"
printf 'Installed %s. Existing running processes were not restarted.\nStop the old process, then run:\n  %s/current/run.sh\n' "$VERSION" "$BASE"
