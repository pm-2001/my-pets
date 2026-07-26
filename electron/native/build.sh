#!/usr/bin/env bash
# Compiles the deskscan helper. Requires Xcode Command Line Tools (swiftc).
#
# Produces a universal (arm64 + x86_64) binary when both slices can be built, so
# a packaged copy runs on any Mac without recompiling; falls back to a host-arch
# build otherwise.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/../../dist-electron/native"
mkdir -p "$OUT"
SRC="$DIR/deskscan.swift"
FINAL="$OUT/deskscan"

slice() {
  swiftc -O -target "$1" \
    -framework CoreGraphics -framework Foundation \
    -o "$2" "$SRC"
}

ARM="$OUT/deskscan.arm64"
X86="$OUT/deskscan.x86_64"

if slice "arm64-apple-macos11" "$ARM" 2>/dev/null \
  && slice "x86_64-apple-macos11" "$X86" 2>/dev/null \
  && lipo -create "$ARM" "$X86" -output "$FINAL" 2>/dev/null; then
  rm -f "$ARM" "$X86"
  echo "built universal $FINAL"
else
  rm -f "$ARM" "$X86"
  # Cross-compilation unavailable — build for this machine's architecture only.
  swiftc -O -framework CoreGraphics -framework Foundation -o "$FINAL" "$SRC"
  echo "built host-arch $FINAL"
fi
