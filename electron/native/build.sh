#!/usr/bin/env bash
# Compiles the deskscan helper. Requires Xcode Command Line Tools (swiftc).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/../../dist-electron/native"
mkdir -p "$OUT"

swiftc -O \
  -framework CoreGraphics \
  -framework Foundation \
  -o "$OUT/deskscan" \
  "$DIR/deskscan.swift"

echo "built $OUT/deskscan"
