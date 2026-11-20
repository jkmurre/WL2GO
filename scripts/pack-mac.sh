#!/usr/bin/env bash
# Packages WL2GO into a double-clickable .app for local use.
#
# Apple Silicon refuses to launch ANY unsigned executable, so a locally built
# app must carry at least an ad-hoc signature ("-"). Real Developer ID signing
# and notarization are Module 11; this only makes the app runnable on this Mac.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Collecting third-party licenses"
node scripts/collect-licenses.mjs

echo "==> Packaging with electron-builder"
npx electron-builder --mac --arm64 --dir

APP_PATH="$(find "$REPO_ROOT/release" -maxdepth 2 -name "*.app" -type d | head -1)"
if [ -z "$APP_PATH" ]; then
  echo "error: no .app produced under release/" >&2
  exit 1
fi

echo "==> Ad-hoc signing nested binaries in $(basename "$APP_PATH")"
# Sign vendored subprocess binaries individually first. --deep does not reliably
# reach files under Resources/, and an unsigned child binary fails at spawn time
# with a SIGKILL that surfaces as a confusing "modem failed to start" style error.
BIN_DIR="$APP_PATH/Contents/Resources/bin"
if [ -d "$BIN_DIR" ]; then
  # Shared libraries are matched by name as well as by permission bit: a .dylib
  # is not necessarily executable, but Gatekeeper still requires it to be signed.
  while IFS= read -r -d '' bin; do
    # Only Mach-O files are signable; anything else here would be a binary for
    # another platform that should not have been packaged in the first place.
    if file -b "$bin" | grep -q "Mach-O"; then
      echo "    signing ${bin#"$BIN_DIR"/}"
      codesign --force --sign - --timestamp=none "$bin"
    else
      echo "    warning: skipping non-Mach-O file ${bin#"$BIN_DIR"/}" >&2
    fi
  done < <(find "$BIN_DIR" -type f \( -perm +111 -o -name "*.dylib" -o -name "*.so" -o -name "*.so.*" \) -print0)
fi

echo "==> Ad-hoc signing the app bundle"
codesign --force --deep --sign - --timestamp=none "$APP_PATH"

echo "==> Verifying signature"
codesign --verify --verbose=2 "$APP_PATH" 2>&1 | sed 's/^/    /'

# Release notes travel next to the .app (not inside it, so they don't disturb
# the signature), ready to zip up with it for a release.
cp "$REPO_ROOT/RELEASE_NOTES.md" "$(dirname "$APP_PATH")/RELEASE_NOTES.md"
echo "==> Release notes: $(dirname "$APP_PATH")/RELEASE_NOTES.md"

echo
echo "==> Done: $APP_PATH"
echo "    Double-click it in Finder, or: open '$APP_PATH'"
