#!/usr/bin/env bash
#
# Build the macOS .dmg. Use this instead of calling `electron-builder --mac` directly.
#
# THE TRAP
# --------
# The .app bundle must be assembled and signed on a filesystem that stores extended attributes
# natively (APFS/HFS+). This repo often lives on an external drive formatted exFAT, which cannot.
# There, macOS falls back to writing an AppleDouble sidecar next to each file — Contents/Resources/
# ends up holding ._app.asar, ._icon.icns and dozens more.
#
# codesign seals whatever it finds in the bundle, so those sidecars get recorded in
# _CodeSignature/CodeResources as genuine resources:
#
#     <key>Resources/._app.asar</key>
#     <key>Resources/._icon.icns</key>
#
# The dmg's interior is HFS+, which absorbs sidecars back into native xattrs. The standalone ._ files
# stop existing, so the seal no longer matches what is there. This is invisible locally — `codesign
# --verify --deep --strict` passes, and the binaries are byte-identical on disk and inside the dmg —
# but Apple's notary service rejects the submission with "The signature of the binary is invalid."
# (Observed: 63 sidecars sealed; submission 5ed54398 came back Invalid.)
#
# A FINISHED dmg is safe on any filesystem: its signature and stapled ticket live inside the file's
# own bytes, and nothing seals its neighbours (an inert ._Stewra-Bridge.dmg may appear beside it —
# verified harmless, hash and Gatekeeper verdict unchanged). So: build on a native filesystem, then
# copy just the dmg back into release/, where scripts/package-release.mjs expects to find it.
#
# Override the staging location with STEWRA_MAC_BUILD_DIR if $TMPDIR is unsuitable.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="release"
mkdir -p "$OUT_DIR"

# Probe the behaviour rather than matching filesystem names: set an xattr, see whether a sidecar
# appears. This catches exFAT, FAT32, and any network mount that degrades the same way, without this
# script needing to know the list.
probe="$OUT_DIR/.xattr-probe"
: > "$probe"
xattr -w com.stewra.probe 1 "$probe" 2>/dev/null || true
if [ -e "$OUT_DIR/._.xattr-probe" ]; then native_xattr=0; else native_xattr=1; fi
rm -f "$probe" "$OUT_DIR/._.xattr-probe"

if [ "$native_xattr" -eq 1 ]; then
  echo ">> $(pwd) stores xattrs natively — building in place"
  build_dir="$OUT_DIR"
else
  build_dir="${STEWRA_MAC_BUILD_DIR:-${TMPDIR:-/tmp}/stewra-bridge-mac}"
  echo ">> $(pwd) cannot store xattrs natively"
  echo ">> AppleDouble sidecars would be sealed into the signature and fail notarization"
  echo ">> staging the build in $build_dir"
  # Start clean: a stale bundle here would be signed and shipped as if it were this build.
  rm -rf "$build_dir"
  mkdir -p "$build_dir"
fi

npx electron-builder --mac -c.directories.output="$build_dir" "$@"

# --- guards -------------------------------------------------------------------------------------
# Both failure modes are silent, so assert against them rather than trusting the build.

# -print -quit rather than `| head -1`: head closing the pipe early would SIGPIPE find, and pipefail
# would turn that into an abort.
app="$(find "$build_dir" -maxdepth 2 -name '*.app' -type d -print -quit)"
if [ -z "$app" ]; then
  echo "!! no .app produced in $build_dir" >&2
  exit 1
fi

sidecars="$(find "$app" -name '._*' | wc -l | tr -d ' ')"
# `|| true`: grep exits 1 when it matches nothing, which is the PASSING case here — without this,
# pipefail + set -e abort the script precisely when the build is clean.
sealed="$(grep -o '<key>[^<]*\._[^<]*</key>' "$app/Contents/_CodeSignature/CodeResources" 2>/dev/null | wc -l | tr -d ' ' || true)"
if [ "$sidecars" != "0" ] || [ "$sealed" != "0" ]; then
  echo "!! $sidecars AppleDouble file(s) in the bundle, $sealed sealed into CodeResources" >&2
  echo "!! this WILL be rejected by the notary service — build on an APFS/HFS+ path" >&2
  echo "!! (set STEWRA_MAC_BUILD_DIR to one, e.g. \$HOME/stewra-bridge-build)" >&2
  exit 1
fi

# app.asar is ~24 MB. An order-of-magnitude jump means a directory that should have been excluded got
# packed in — see the '!release/**' entry in electron-builder.yml.
asar_bytes="$(wc -c < "$app/Contents/Resources/app.asar" | tr -d ' ')"
if [ "$asar_bytes" -gt 104857600 ]; then
  echo "!! app.asar is $asar_bytes bytes (>100 MB) — a build-output dir was almost certainly packed in" >&2
  exit 1
fi

codesign --verify --deep --strict "$app"
echo ">> signature verifies; app.asar $asar_bytes bytes; 0 AppleDouble files"

# --- collect ------------------------------------------------------------------------------------
if [ "$build_dir" != "$OUT_DIR" ]; then
  shopt -s nullglob
  dmgs=("$build_dir"/*.dmg)
  if [ ${#dmgs[@]} -eq 0 ]; then
    echo "!! no .dmg produced in $build_dir" >&2
    exit 1
  fi
  for d in "${dmgs[@]}"; do
    cp -f "$d" "$OUT_DIR/"
    echo ">> $(basename "$d") -> $OUT_DIR/"
  done
fi

echo ">> next: bash scripts/notarize-dmg.sh \"$OUT_DIR\"/*.dmg"
