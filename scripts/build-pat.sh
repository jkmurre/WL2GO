#!/usr/bin/env bash
# Builds Pat from source and vendors the binary into resources/bin/.
#
# Defaults to the host platform/arch. Set GOOS/GOARCH to cross-compile, e.g.
#   GOOS=windows GOARCH=amd64 npm run build:pat
set -euo pipefail

PAT_VERSION="${PAT_VERSION:-v1.0.0}"
# The commit v1.0.0 pointed at when reviewed. Tags can be moved; this cannot.
PAT_COMMIT="${PAT_COMMIT:-2e6a8d14baf0268f4e2aa4d01784a54ca935cf52}"
PAT_REPO="https://github.com/la5nta/pat.git"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/.build/pat"
VENDOR_DIR="$REPO_ROOT/vendor/pat"

command -v go >/dev/null 2>&1 || {
  # Patch 0002 raises the module's go directive to 1.26.0; MIN_GO_VERSION below sets the real floor.
  echo "error: Go toolchain not found. Patched Pat requires Go 1.27.4 or later (see MIN_GO_VERSION below)." >&2
  exit 1
}
command -v git >/dev/null 2>&1 || { echo "error: git not found." >&2; exit 1; }

# Pat's HTTP server is linked from the Go standard library, so stdlib fixes
# only reach the binary through the toolchain. 1.27.4 fixes GO-2026-6859
# (net/http MaxBytesReader crash), which govulncheck finds reachable in Pat.
# Raise this when govulncheck reports a newer stdlib fix.
MIN_GO_VERSION="1.27.4"
GO_VERSION="$(go env GOVERSION)"; GO_VERSION="${GO_VERSION#go}"
if [ "$(printf '%s\n%s\n' "$MIN_GO_VERSION" "$GO_VERSION" | sort -V | head -n1)" != "$MIN_GO_VERSION" ]; then
  echo "error: Go $GO_VERSION is older than $MIN_GO_VERSION, which carries security fixes Pat needs." >&2
  exit 1
fi

GOOS_TARGET="${GOOS:-$(go env GOHOSTOS)}"
GOARCH_TARGET="${GOARCH:-$(go env GOHOSTARCH)}"

# Go and Node name platforms differently; resources/bin/ is keyed by Node's
# process.platform / process.arch, since that is what resolves the path at runtime.
case "$GOOS_TARGET" in
  darwin)  NODE_PLATFORM="darwin" ;;
  linux)   NODE_PLATFORM="linux" ;;
  windows) NODE_PLATFORM="win32" ;;
  *) echo "error: unsupported GOOS '$GOOS_TARGET'" >&2; exit 1 ;;
esac

case "$GOARCH_TARGET" in
  amd64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) echo "error: unsupported GOARCH '$GOARCH_TARGET'" >&2; exit 1 ;;
esac

EXE_NAME="pat"
[ "$GOOS_TARGET" = "windows" ] && EXE_NAME="pat.exe"

OUT_DIR="$REPO_ROOT/resources/bin/$NODE_PLATFORM/$NODE_ARCH"
OUT_PATH="$OUT_DIR/$EXE_NAME"

echo "==> Building Pat $PAT_VERSION for $GOOS_TARGET/$GOARCH_TARGET -> $NODE_PLATFORM/$NODE_ARCH"

# Fetch the pinned tag. Re-clone if the cached checkout is at a different version.
NEEDS_CLONE=1
if [ -d "$BUILD_DIR/.git" ]; then
  CURRENT_TAG="$(git -C "$BUILD_DIR" describe --tags --exact-match 2>/dev/null || echo "")"
  [ "$CURRENT_TAG" = "$PAT_VERSION" ] && NEEDS_CLONE=0
fi

if [ "$NEEDS_CLONE" = "1" ]; then
  echo "==> Cloning $PAT_REPO at $PAT_VERSION"
  rm -rf "$BUILD_DIR"
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone --depth 1 --branch "$PAT_VERSION" "$PAT_REPO" "$BUILD_DIR"
else
  echo "==> Reusing cached checkout at $PAT_VERSION"
  # A reused checkout still carries the patches from the previous build, and
  # git apply refuses to apply a patch twice. Back to pristine first.
  git -C "$BUILD_DIR" checkout -- .
  git -C "$BUILD_DIR" clean -fdq
fi

HEAD_COMMIT="$(git -C "$BUILD_DIR" rev-parse HEAD)"
if [ "$HEAD_COMMIT" != "$PAT_COMMIT" ]; then
  echo "error: Pat $PAT_VERSION is at $HEAD_COMMIT, expected $PAT_COMMIT." >&2
  echo "       Upstream may have moved the tag. Review the change before updating the pin." >&2
  exit 1
fi

# The patch series keeps the upstream checkout pristine; see each patch header.
echo "==> Applying WL2GO patches"
for patch in "$VENDOR_DIR"/patches/*.patch; do
  [ -e "$patch" ] || continue
  echo "    $(basename "$patch")"
  git -C "$BUILD_DIR" apply "$patch"
done

mkdir -p "$OUT_DIR"

# cgo is REQUIRED: github.com/albenik/go-serial implements its termios calls in
# cgo-only files, so CGO_ENABLED=0 fails to compile with "retrieveTermSettings
# undefined". Serial support is core to WL2GO (Modules 7/9), and upstream's own
# make.bash builds darwin with cgo on. Cross-compiling therefore needs a cross
# C toolchain; host builds just work.
IS_CROSS=0
[ "$GOOS_TARGET" != "$(go env GOHOSTOS)" ] && IS_CROSS=1
[ "$GOARCH_TARGET" != "$(go env GOHOSTARCH)" ] && IS_CROSS=1

CGO_VALUE="${CGO_ENABLED:-1}"
if [ "$IS_CROSS" = "1" ] && [ "$CGO_VALUE" = "1" ]; then
  echo "note: cross-compiling with cgo requires a cross C toolchain (CC=...)." >&2
  echo "      If this fails, install one or build on the target platform." >&2
fi

(
  cd "$BUILD_DIR"
  CGO_ENABLED="$CGO_VALUE" GOOS="$GOOS_TARGET" GOARCH="$GOARCH_TARGET" \
    go build -trimpath -o "$OUT_PATH" .
)

chmod +x "$OUT_PATH"
echo "$PAT_VERSION" > "$REPO_ROOT/resources/bin/PAT_VERSION"

echo "==> Built $(du -h "$OUT_PATH" | cut -f1) -> ${OUT_PATH#"$REPO_ROOT"/}"

# shellcheck source=scripts/assert-self-contained.sh
. "$(dirname "$0")/assert-self-contained.sh"
assert_self_contained "$OUT_PATH" "pat"
