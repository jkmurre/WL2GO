#!/usr/bin/env bash
# Fails if a vendored binary links anything the user will not already have.
#
# Shared by all three build scripts. An allowlist, not a denylist: checking for
# /opt/homebrew catches the common case but silently passes anything else that
# happens to be on the build machine and absent on the operator's.
#
# Acceptable on macOS:
#   /usr/lib/...                  part of the OS
#   /System/Library/Frameworks/   part of the OS
#   @loader_path/...              ships beside the binary (e.g. libhamlib)
#   @rpath/, @executable_path/    likewise relative to the bundle
#
# Usage: assert_self_contained <path-to-binary> <label>

assert_self_contained() {
  local target="$1" label="$2"

  command -v otool >/dev/null 2>&1 || return 0
  [ -f "$target" ] || { echo "error: $label not found at $target" >&2; return 1; }

  echo "==> Dynamic dependencies:"
  otool -L "$target" | tail -n +2 | sed 's/^/    /'

  local offenders
  offenders="$(
    otool -L "$target" | tail -n +2 | awk '{print $1}' |
      grep -vE '^(/usr/lib/|/System/Library/Frameworks/|@loader_path/|@rpath/|@executable_path/)' || true
  )"

  # A dylib lists its own install name first; that is not a dependency.
  offenders="$(echo "$offenders" | grep -v "^$(basename "$target")$" || true)"
  offenders="$(echo "$offenders" | sed '/^[[:space:]]*$/d')"

  if [ -n "$offenders" ]; then
    echo "error: $label links libraries that will not exist on a clean machine:" >&2
    echo "$offenders" | sed 's/^/    /' >&2
    echo "       WL2GO ships as a self-contained app; this build must not be distributed." >&2
    return 1
  fi

  echo "==> $label is self-contained"
}
