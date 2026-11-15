#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
case "$(uname -s)" in Darwin) OS=darwin;; *) OS=linux;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; *) ARCH=amd64;; esac
make_package() {
  V=$1
  mkdir -p "$TMP/stage"
  printf '#!/bin/sh\nprintf "version=%s args=%%s\\n" "$*"\n' "$V" > "$TMP/stage/agent-workbench"
  printf '%s\n' "${3:-$V}" > "$TMP/stage/VERSION"
  printf '%s\n' "${2:-$OS/$ARCH}" > "$TMP/stage/PLATFORM"
  cp "$ROOT/scripts/run.sh" "$ROOT/scripts/install.sh" "$ROOT/README.md" "$TMP/stage/"
  # Store the first member uncompressed, without extra fields, so the CRC test
  # below can alter its first payload byte (30-byte header + 15-byte filename).
  (cd "$TMP/stage" && zip -q -X -0 "$TMP/$V.zip" agent-workbench VERSION PLATFORM run.sh install.sh README.md)
}
make_package 0.1.0
make_package 0.1.1
BASE="$TMP/install with spaces"
[ ! -e "$TMP/0.1.0.zip.sha256" ]
# Exercise the documented ZIP-only bootstrap, including its bundled installer.
INSTALLER=$(unzip -p "$TMP/0.1.0.zip" install.sh) &&
  sh -c "$INSTALLER" install.sh "$TMP/0.1.0.zip" "$BASE"
printf 'db-content' > "$BASE/data/workbench.db"
printf 'config-content' > "$BASE/config/test.conf"
"$BASE/current/run.sh" | grep 'version=0.1.0'
# Old sidecars are not part of the ZIP-only installation contract, even if stale.
printf 'obsolete checksum\n' > "$TMP/0.1.1.zip.sha256"
sh "$ROOT/scripts/install.sh" "$TMP/0.1.1.zip" "$BASE"
"$BASE/current/run.sh" | grep 'version=0.1.1'
[ "$(cat "$BASE/data/workbench.db")" = db-content ]
[ "$(cat "$BASE/config/test.conf")" = config-content ]
if sh "$ROOT/scripts/install.sh" "$TMP/0.1.1.zip" "$BASE"; then echo 'FAIL duplicate accepted'; exit 1; fi
ln -sfn releases/0.1.0 "$BASE/current"
"$BASE/current/run.sh" | grep 'version=0.1.0'
assert_rejected() {
  if sh "$ROOT/scripts/install.sh" "$1" "$BASE"; then echo "FAIL invalid archive accepted: $1"; exit 1; fi
  [ "$(readlink "$BASE/current")" = releases/0.1.0 ]
  [ "$(cat "$BASE/data/workbench.db")" = db-content ]
  [ "$(cat "$BASE/config/test.conf")" = config-content ]
  [ "$(find "$BASE/releases" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 2 ]
}
make_package 0.1.2
cp "$TMP/0.1.2.zip" "$TMP/corrupt.zip"
printf '!' | dd of="$TMP/corrupt.zip" bs=1 seek=45 conv=notrunc 2>/dev/null
if unzip -tq "$TMP/corrupt.zip" > "$TMP/zip-test.log" 2>&1; then echo 'FAIL CRC fixture is not damaged'; exit 1; fi
grep 'bad CRC' "$TMP/zip-test.log"
assert_rejected "$TMP/corrupt.zip"
printf 'not a ZIP\n' > "$TMP/invalid.zip"
assert_rejected "$TMP/invalid.zip"
cp "$TMP/0.1.2.zip" "$TMP/missing-file.zip"
zip -qd "$TMP/missing-file.zip" README.md
assert_rejected "$TMP/missing-file.zip"
make_package 0.1.3 unsupported/platform
assert_rejected "$TMP/0.1.3.zip"
make_package 0.1.4 "$OS/$ARCH" ../invalid
assert_rejected "$TMP/0.1.4.zip"
printf 'PASS: ZIP-only install, update, ignored legacy sidecar, data/config retention, duplicate rejection, rollback, CRC/malformed ZIP rejection, missing-file rejection, platform/version rejection\n'
