#!/usr/bin/env bash
# Builds ardopcf from upstream source and vendors the binary into resources/bin/.
#
# Upstream (github.com/pflarue/ardop) ships no macOS build: its Makefile has
# only Windows and Linux branches, and the Linux one links ALSA, which does not
# exist on macOS. This script builds against a PortAudio backend instead, so one
# audio implementation serves every platform.
#
# Everything applied on top of upstream lives in vendor/ardopcf/ as our own
# source file plus a small patch series, keeping the upstream checkout pristine
# and the delta auditable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/ardopcf"
BUILD_DIR="$REPO_ROOT/.build/ardopcf"
PA_DIR="$REPO_ROOT/.build/portaudio"

ARDOPCF_VERSION="${ARDOPCF_VERSION:-$(cat "$VENDOR_DIR/ARDOPCF_VERSION")}"
PORTAUDIO_VERSION="${PORTAUDIO_VERSION:-$(cat "$VENDOR_DIR/PORTAUDIO_VERSION")}"
# Tags can be moved; commits cannot. Each *_COMMIT file is the commit its tag
# pointed at when we last reviewed it, so a retagged upstream fails the build.
ARDOPCF_COMMIT="${ARDOPCF_COMMIT:-$(cat "$VENDOR_DIR/ARDOPCF_COMMIT")}"
PORTAUDIO_COMMIT="${PORTAUDIO_COMMIT:-$(cat "$VENDOR_DIR/PORTAUDIO_COMMIT")}"

ARDOPCF_REPO="https://github.com/pflarue/ardop.git"
PORTAUDIO_REPO="https://github.com/PortAudio/portaudio.git"

for tool in git cc make; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found." >&2; exit 1; }
done

# resources/bin/ is keyed by Node's process.platform / process.arch, since that
# is what resolves the path at runtime.
case "$(uname -s)" in
  Darwin) NODE_PLATFORM="darwin" ;;
  Linux)  NODE_PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) NODE_PLATFORM="win32" ;;
  *) echo "error: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64|amd64)  NODE_ARCH="x64" ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

EXE_NAME="ardopcf"
[ "$NODE_PLATFORM" = "win32" ] && EXE_NAME="ardopcf.exe"

OUT_DIR="$REPO_ROOT/resources/bin/$NODE_PLATFORM/$NODE_ARCH"
OUT_PATH="$OUT_DIR/$EXE_NAME"

echo "==> Building ardopcf $ARDOPCF_VERSION for $NODE_PLATFORM/$NODE_ARCH"

# ---------------------------------------------------------------- PortAudio --

clone_at_tag() {
  local repo="$1" dir="$2" tag="$3" commit="$4"
  local current=""
  [ -d "$dir/.git" ] && current="$(git -C "$dir" describe --tags --exact-match 2>/dev/null || echo "")"

  if [ "$current" = "$tag" ]; then
    echo "==> Reusing cached $(basename "$dir") at $tag"
    git -C "$dir" checkout -q -- . 2>/dev/null || true
  else
    echo "==> Cloning $repo at $tag"
    rm -rf "$dir"
    mkdir -p "$(dirname "$dir")"
    git clone --depth 1 --branch "$tag" "$repo" "$dir" 2>&1 | sed 's/^/    /'
  fi

  local head
  head="$(git -C "$dir" rev-parse HEAD)"
  if [ "$head" != "$commit" ]; then
    echo "error: $(basename "$dir") tag $tag is at $head, expected $commit." >&2
    echo "       Upstream may have moved the tag. Review the change before updating the pin." >&2
    exit 1
  fi
}

clone_at_tag "$PORTAUDIO_REPO" "$PA_DIR" "$PORTAUDIO_VERSION" "$PORTAUDIO_COMMIT"

if [ ! -f "$PA_DIR/install/lib/libportaudio.a" ]; then
  echo "==> Building static PortAudio $PORTAUDIO_VERSION"
  (
    cd "$PA_DIR"
    ./configure --enable-static --disable-shared --prefix="$PA_DIR/install" > /tmp/wl2go-pa-configure.log 2>&1
    # PortAudio v19.7.0 predates several clang warnings and compiles with
    # -Werror, so warnings that are not bugs break the build on modern
    # toolchains. Drop -Werror rather than pinning an unreleased commit.
    sed -i.bak 's/ -Werror//g' Makefile && rm -f Makefile.bak
    make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > /tmp/wl2go-pa-make.log 2>&1
    make install > /tmp/wl2go-pa-install.log 2>&1
  )
fi
echo "==> PortAudio: $PA_DIR/install/lib/libportaudio.a"

# ------------------------------------------------------------------ ardopcf --

clone_at_tag "$ARDOPCF_REPO" "$BUILD_DIR" "$ARDOPCF_VERSION" "$ARDOPCF_COMMIT"

echo "==> Applying WL2GO patches"
for patch in "$VENDOR_DIR"/patches/*.patch; do
  [ -e "$patch" ] || continue
  echo "    $(basename "$patch")"
  git -C "$BUILD_DIR" apply "$patch"
done

echo "==> Installing the PortAudio backend"
mkdir -p "$BUILD_DIR/src/portaudio"
cp "$VENDOR_DIR/src/portaudio/PaSound.c" "$BUILD_DIR/src/portaudio/"

# Upstream embeds the web GUI by converting it to C with its own txt2c helper.
echo "==> Generating embedded web GUI sources"
(
  cd "$BUILD_DIR"
  cc lib/txt2c/txt2c.c -o lib/txt2c/txt2c
  ./lib/txt2c/txt2c webgui/webgui.html src/common/gen-webgui.html.c webgui_html
  ./lib/txt2c/txt2c webgui/webgui.js src/common/gen-webgui.js.c webgui_js
)

echo "==> Compiling"
(
  cd "$BUILD_DIR"
  make clean > /dev/null 2>&1 || true
  make AUDIO=portaudio \
       PORTAUDIO_CFLAGS="-I$PA_DIR/install/include" \
       PORTAUDIO_LIBS="$PA_DIR/install/lib/libportaudio.a" \
       -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > /tmp/wl2go-ardopcf-make.log 2>&1
)

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/$EXE_NAME" "$OUT_PATH"
chmod +x "$OUT_PATH"
echo "$ARDOPCF_VERSION" > "$REPO_ROOT/resources/bin/ARDOPCF_VERSION"

echo "==> Built $(du -h "$OUT_PATH" | cut -f1) -> ${OUT_PATH#"$REPO_ROOT"/}"

# shellcheck source=scripts/assert-self-contained.sh
. "$(dirname "$0")/assert-self-contained.sh"
assert_self_contained "$OUT_PATH" "ardopcf"
