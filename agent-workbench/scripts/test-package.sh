#!/bin/sh
# Exercise real packaging/installation without compiling or publishing a release.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/repo/scripts" "$TMP/repo/web" "$TMP/bin"
cp "$ROOT/scripts/package.sh" "$ROOT/scripts/install.sh" "$ROOT/scripts/run.sh" "$TMP/repo/scripts/"
cp "$ROOT/README.md" "$TMP/repo/"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/npm"
cat > "$TMP/bin/go" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = build ]
shift
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    shift
    printf '#!/bin/sh\nprintf "package-test-binary\\n"\n' > "$1"
    exit 0
  fi
  shift
done
exit 1
EOF
chmod +x "$TMP/bin/npm" "$TMP/bin/go"
PATH="$TMP/bin:$PATH"
export PATH
case "$(uname -s)" in Darwin) OS=darwin; OTHER=linux;; Linux) OS=linux; OTHER=darwin;; *) echo 'Unsupported test OS' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64) ARCH=amd64;; *) echo 'Unsupported test CPU' >&2; exit 1;; esac
VERSION=9.8.7-readme-test.2
check_package() {
  TARGET_OS=$1
  TARGET_ARCH=$2
  NAME="agent-workbench-$VERSION-$TARGET_OS-$TARGET_ARCH.zip"
  ZIP="$TMP/repo/dist/$NAME"
  sh "$TMP/repo/scripts/package.sh" "$VERSION" "$TARGET_OS" "$TARGET_ARCH"
  unzip -tq "$ZIP"
  unzip -p "$ZIP" README.md > "$TMP/packaged-readme"
  grep -F "ZIP='./$NAME'" "$TMP/packaged-readme"
  grep -F "releases/$VERSION/" "$TMP/packaged-readme"
  grep -F "current -> releases/$VERSION" "$TMP/packaged-readme"
  if grep -E '@ARCHIVE_NAME@|@RELEASE_VERSION@' "$TMP/packaged-readme"; then
    echo 'FAIL unresolved README placeholder'; exit 1
  fi
  [ "$(unzip -p "$ZIP" VERSION)" = "$VERSION" ]
  [ "$(unzip -p "$ZIP" PLATFORM)" = "$TARGET_OS/$TARGET_ARCH" ]
  [ "$(unzip -Z1 "$ZIP" | wc -l | tr -d ' ')" = 6 ]
  [ ! -e "$ZIP.sha256" ]
  [ ! -e "$TMP/repo/dist/install.sh" ]
  cmp "$TMP/repo/README.md" "$ROOT/README.md"
}
check_package "$OS" "$ARCH"
# Run the documented snippet verbatim against the ZIP it names, in a path with
# spaces. It must install the chosen version without writing a loose installer.
awk '
  /^## 安装 \/ 更新$/ { section = 1; next }
  section && /^```sh$/ { code = 1; next }
  code && /^```$/ { exit }
  code { print }
' "$TMP/packaged-readme" > "$TMP/readme-install.sh"
[ -s "$TMP/readme-install.sh" ]
mkdir -p "$TMP/download with spaces"
cp "$ZIP" "$TMP/download with spaces/"
(cd "$TMP/download with spaces" && HOME="$TMP/home with spaces" sh "$TMP/readme-install.sh")
BASE="$TMP/home with spaces/.local/share/agent-workbench"
[ "$(readlink "$BASE/current")" = "releases/$VERSION" ]
"$BASE/current/run.sh" | grep '^package-test-binary$'
[ ! -e "$TMP/download with spaces/install.sh" ]
cp "$ZIP" "$TMP/before.zip"
if sh "$TMP/repo/scripts/package.sh" "$VERSION" "$OS" "$ARCH"; then
  echo 'FAIL archive overwrite accepted'; exit 1
fi
cmp "$ZIP" "$TMP/before.zip"
check_package "$OTHER" arm64
[ "$(find "$TMP/repo/dist" -type f | wc -l | tr -d ' ')" = 2 ]
printf 'PASS: version/platform README rendering, documented ZIP-only install, source preservation, package contents, overwrite rejection (stubbed builds)\n'
