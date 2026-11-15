#!/bin/sh
# Build in the cloud; the target machine needs no Go or Node installation.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${1:?Usage: scripts/package.sh VERSION [GOOS] [GOARCH]}
case "$VERSION" in ''|*[!0-9A-Za-z._-]*|.*) echo 'Invalid version' >&2; exit 1;; esac
OS=${2:-$(go env GOOS)}
ARCH=${3:-$(go env GOARCH)}
case "$OS/$ARCH" in darwin/arm64|darwin/amd64|linux/arm64|linux/amd64) ;; *) echo "Unsupported target: $OS/$ARCH" >&2; exit 1;; esac
NAME="agent-workbench-$VERSION-$OS-$ARCH"
OUT="$ROOT/dist"
mkdir -p "$OUT"
[ ! -e "$OUT/$NAME.zip" ] || { echo 'Archive exists; use a new version or remove the old build explicitly.' >&2; exit 1; }
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
(cd "$ROOT/web" && npm ci && npm run build)
(cd "$ROOT" && CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" go build -buildvcs=false -trimpath -o "$STAGE/agent-workbench" .)
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
printf '%s/%s\n' "$OS" "$ARCH" > "$STAGE/PLATFORM"
cp "$ROOT/scripts/run.sh" "$ROOT/scripts/install.sh" "$STAGE/"
# Only these declared README placeholders are rendered. VERSION and target have
# already been restricted to characters safe in filenames, shell quotes and sed.
sed -e "s/@ARCHIVE_NAME@/$NAME.zip/g" -e "s/@RELEASE_VERSION@/$VERSION/g" \
  "$ROOT/README.md" > "$STAGE/README.md"
chmod +x "$STAGE/agent-workbench" "$STAGE/run.sh" "$STAGE/install.sh"
(cd "$STAGE" && zip -q -X "$OUT/$NAME.zip" agent-workbench VERSION PLATFORM run.sh install.sh README.md)
printf 'Built: %s\n' "$OUT/$NAME.zip"
