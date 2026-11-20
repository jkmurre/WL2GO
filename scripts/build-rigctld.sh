#!/usr/bin/env bash
# Builds Hamlib's rigctld from upstream source and vendors it into resources/bin/.
#
# Hamlib publishes no macOS binary, and a Homebrew-style build links dylibs from
# /opt/homebrew that a user will not have. This builds from the official release
# tarballs and makes the result relocatable, so the app ships everything it needs.
#
# libusb is linked statically, so the only companion file is libhamlib's own
# shared library. (Hamlib's fully-static build produces an empty archive: its
# ~90 per-manufacturer convenience libraries defeat libtool's static path.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$REPO_ROOT/.build"

HAMLIB_VERSION="${HAMLIB_VERSION:-4.7.2}"
LIBUSB_VERSION="${LIBUSB_VERSION:-1.0.30}"

HAMLIB_URL="https://github.com/Hamlib/Hamlib/releases/download/${HAMLIB_VERSION}/hamlib-${HAMLIB_VERSION}.tar.gz"
LIBUSB_URL="https://github.com/libusb/libusb/releases/download/v${LIBUSB_VERSION}/libusb-${LIBUSB_VERSION}.tar.bz2"
# Checked before anything is extracted. Hamlib's matches its own published
# SHA256SUM-4.7.2; both match GitHub's recorded release-asset digests.
HAMLIB_SHA256="${HAMLIB_SHA256:-ae1fcf2dbc80ea0786ea8f047b09399c3f7737d1930442f61a031708ed33e88f}"
LIBUSB_SHA256="${LIBUSB_SHA256:-fea36f34f9156400209595e300840767ab1a385ede1dc7ee893015aea9c6dbaf}"

HAMLIB_DIR="$BUILD_ROOT/hamlib-${HAMLIB_VERSION}"
LIBUSB_DIR="$BUILD_ROOT/libusb-${LIBUSB_VERSION}"
# Deliberately outside the source tree: libusb ships an INSTALL doc file, and on
# a case-insensitive macOS filesystem that collides with an install/ directory.
LIBUSB_PREFIX="$BUILD_ROOT/libusb-prefix"

for tool in curl tar make cc shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found." >&2; exit 1; }
done

# Downloads a tarball to disk, refuses it unless its SHA-256 matches, then
# extracts it into $BUILD_ROOT. Never pipes the network straight into tar.
fetch_verified() {
  local url="$1" sha="$2" tarflags="$3"
  local file="$BUILD_ROOT/.download-$(basename "$url")"
  mkdir -p "$BUILD_ROOT"
  curl -fsSL -o "$file" "$url"
  if ! echo "$sha  $file" | shasum -a 256 -c - > /dev/null 2>&1; then
    echo "error: checksum mismatch for $(basename "$url")" >&2
    echo "       expected $sha" >&2
    echo "       got      $(shasum -a 256 "$file" | cut -d' ' -f1)" >&2
    rm -f "$file"
    exit 1
  fi
  tar "$tarflags" "$file" -C "$BUILD_ROOT"
  rm -f "$file"
}

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

EXE_NAME="rigctld"
[ "$NODE_PLATFORM" = "win32" ] && EXE_NAME="rigctld.exe"

OUT_DIR="$REPO_ROOT/resources/bin/$NODE_PLATFORM/$NODE_ARCH"

echo "==> Building rigctld (Hamlib $HAMLIB_VERSION) for $NODE_PLATFORM/$NODE_ARCH"

# ------------------------------------------------------------------ libusb --

if [ ! -f "$LIBUSB_PREFIX/lib/libusb-1.0.a" ]; then
  echo "==> Building static libusb $LIBUSB_VERSION"
  rm -rf "$LIBUSB_DIR" "$LIBUSB_PREFIX"
  fetch_verified "$LIBUSB_URL" "$LIBUSB_SHA256" xjf
  (
    cd "$LIBUSB_DIR"
    ./configure --disable-shared --enable-static --disable-udev \
      --prefix="$LIBUSB_PREFIX" > /tmp/wl2go-libusb-conf.log 2>&1
    make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > /tmp/wl2go-libusb-make.log 2>&1
    make install > /tmp/wl2go-libusb-install.log 2>&1
  )
fi
echo "==> libusb: $LIBUSB_PREFIX/lib/libusb-1.0.a"

# Static linking needs libusb's private dependencies spelled out; they are what
# its pkg-config file records as Libs.private.
case "$NODE_PLATFORM" in
  darwin) LIBUSB_PRIVATE="-lobjc -Wl,-framework,IOKit -Wl,-framework,CoreFoundation -Wl,-framework,Security" ;;
  linux)  LIBUSB_PRIVATE="-ludev -lpthread" ;;
  *)      LIBUSB_PRIVATE="" ;;
esac

# ------------------------------------------------------------------ Hamlib --

if [ ! -d "$HAMLIB_DIR" ]; then
  echo "==> Downloading Hamlib $HAMLIB_VERSION"
  fetch_verified "$HAMLIB_URL" "$HAMLIB_SHA256" xzf
fi

echo "==> Configuring Hamlib"
(
  cd "$HAMLIB_DIR"
  make distclean > /dev/null 2>&1 || true
  # Setting LIBUSB_CFLAGS/LIBUSB_LIBS explicitly makes PKG_CHECK_MODULES skip
  # pkg-config entirely, which matters because pkg-config is not part of the
  # Xcode command line tools. Language bindings and extras are all dropped:
  # we only need the daemon.
  ./configure \
    --enable-shared --disable-static \
    --without-cxx-binding --without-perl-binding --without-python-binding \
    --without-tcl-binding --without-lua-binding --without-xml-support \
    --without-indi --without-readline \
    LIBUSB_CFLAGS="-I$LIBUSB_PREFIX/include/libusb-1.0" \
    LIBUSB_LIBS="$LIBUSB_PREFIX/lib/libusb-1.0.a $LIBUSB_PRIVATE" \
    > /tmp/wl2go-hamlib-conf.log 2>&1

  grep -q "checking for libusb-1.0\.\.\. yes" /tmp/wl2go-hamlib-conf.log \
    || echo "    warning: libusb not detected; USB-native rigs will be unsupported" >&2
)

echo "==> Compiling Hamlib (this takes a few minutes)"
( cd "$HAMLIB_DIR" && make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > /tmp/wl2go-hamlib-make.log 2>&1 )

# ----------------------------------------------------------------- vendor --

RIGCTLD_BIN="$(find "$HAMLIB_DIR/tests" -path "*.libs/rigctld" -type f | head -1)"
[ -n "$RIGCTLD_BIN" ] || RIGCTLD_BIN="$HAMLIB_DIR/tests/rigctld"
[ -f "$RIGCTLD_BIN" ] || { echo "error: rigctld was not built" >&2; exit 1; }

mkdir -p "$OUT_DIR"
cp "$RIGCTLD_BIN" "$OUT_DIR/$EXE_NAME"
chmod +x "$OUT_DIR/$EXE_NAME"

if [ "$NODE_PLATFORM" = "darwin" ]; then
  # Ship libhamlib beside the binary and make the reference relative, so the
  # pair works from inside the app bundle rather than needing /usr/local.
  DYLIB_SRC="$(find "$HAMLIB_DIR/src/.libs" -name "libhamlib.*.dylib" -type f | head -1)"
  [ -n "$DYLIB_SRC" ] || { echo "error: libhamlib dylib not found" >&2; exit 1; }
  DYLIB_NAME="$(basename "$DYLIB_SRC")"

  cp "$DYLIB_SRC" "$OUT_DIR/$DYLIB_NAME"
  chmod u+w "$OUT_DIR/$DYLIB_NAME" "$OUT_DIR/$EXE_NAME"

  install_name_tool -id "@loader_path/$DYLIB_NAME" "$OUT_DIR/$DYLIB_NAME"
  OLD_REF="$(otool -L "$OUT_DIR/$EXE_NAME" | awk '/libhamlib/ {print $1; exit}')"
  [ -n "$OLD_REF" ] && install_name_tool -change "$OLD_REF" "@loader_path/$DYLIB_NAME" "$OUT_DIR/$EXE_NAME"
elif [ "$NODE_PLATFORM" = "linux" ]; then
  DYLIB_SRC="$(find "$HAMLIB_DIR/src/.libs" -name "libhamlib.so.*" -type f | head -1)"
  if [ -n "$DYLIB_SRC" ]; then
    cp "$DYLIB_SRC" "$OUT_DIR/$(basename "$DYLIB_SRC")"
    command -v patchelf >/dev/null 2>&1 && patchelf --set-rpath '$ORIGIN' "$OUT_DIR/$EXE_NAME"
  fi
fi

echo "$HAMLIB_VERSION" > "$REPO_ROOT/resources/bin/RIGCTLD_VERSION"

echo "==> Built $(du -h "$OUT_DIR/$EXE_NAME" | cut -f1) -> ${OUT_DIR#"$REPO_ROOT"/}/$EXE_NAME"

# shellcheck source=scripts/assert-self-contained.sh
. "$(dirname "$0")/assert-self-contained.sh"
assert_self_contained "$OUT_DIR/$EXE_NAME" "rigctld"
