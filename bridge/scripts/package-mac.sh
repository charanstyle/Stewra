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

# Which arch this run is building — electron-builder takes it from the flags (`npm run package:mac --
# --x64`), defaulting to the host. Known here so the staging dir and the collected update-feed yml can
# be suffixed per arch: back-to-back arm64 + x64 runs must not clobber each other's output.
case "$(uname -m)" in
  x86_64) arch="x64" ;;          # electron-builder's name for it; keep the suffixes consistent
  *) arch="$(uname -m)" ;;
esac
for flag in "$@"; do
  case "$flag" in
    --x64) arch="x64" ;;
    --arm64) arch="arm64" ;;
  esac
done

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
  build_dir="${STEWRA_MAC_BUILD_DIR:-${TMPDIR:-/tmp}/stewra-bridge-mac}-$arch"
  echo ">> $(pwd) cannot store xattrs natively"
  echo ">> AppleDouble sidecars would be sealed into the signature and fail notarization"
  echo ">> staging the build in $build_dir"
  # Start clean: a stale bundle here would be signed and shipped as if it were this build.
  rm -rf "$build_dir"
  mkdir -p "$build_dir"
fi

# PASS 1 of 2: build and sign the .app only. The dmg is built separately, below, AFTER the app has
# been notarized and stapled — a bundle sealed inside a read-only disk image can no longer be stapled,
# and an app with no ticket of its own forces Gatekeeper online on first launch. See notarize-app.sh.
npx electron-builder --mac --dir --publish never -c.directories.output="$build_dir" "$@"

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

# --- notarize the app, then build the dmg around it -----------------------------------------------
NOTARY_PROFILE="${STEWRA_NOTARY_PROFILE:-stewra-notary}"
if [ -n "${STEWRA_SKIP_NOTARIZE:-}" ]; then
  echo ">> STEWRA_SKIP_NOTARIZE set — skipping app notarization"
  notarized=0
elif xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  bash "$(dirname "$0")/notarize-app.sh" "$app" "$NOTARY_PROFILE"
  notarized=1
else
  # Deliberately not fatal: a contributor without notary credentials should still get a signed build.
  # It must be loud, though — the difference is invisible in the artifact and only shows up on a user's
  # machine, offline, at first launch.
  echo "!! no usable notary keychain profile '$NOTARY_PROFILE' — building an UN-NOTARIZED dmg" >&2
  echo "!! the app inside will carry no ticket; first launch will need a network. Do not publish it." >&2
  notarized=0
fi

# PASS 2 of 2: wrap the (now stapled) .app in the dmg AND the zip. --prepackaged makes electron-builder
# reuse this exact bundle instead of rebuilding and re-signing it, which would discard the ticket just
# stapled in. The zip is not optional: it is the artifact electron-updater actually applies on macOS
# (Squirrel.Mac cannot update from a dmg) — and building it here, after stapling, is what puts a
# ticketed app inside it. This pass also emits latest-mac.yml, the update feed the packaged app polls.
#
# --prepackaged takes the path to the .app ITSELF, not the directory containing it. Pointing it at the
# parent does not fail — electron-builder copies that directory into the image under the app's name,
# producing a dmg holding "Stewra Bridge.app/Stewra Bridge.app". The dmg builds, is the right size, and
# is entirely broken ("bundle format unrecognized"). Hence the assertion below.
npx electron-builder --mac dmg zip --prepackaged "$app" --publish never \
  -c.directories.output="$build_dir" "$@"

# Inspect what actually ended up in the image rather than trusting that pass 2 did the right thing.
# Both failure modes here produce a dmg of entirely plausible size that nothing else complains about.
staged_dmg="$(find "$build_dir" -maxdepth 1 -name '*.dmg' -print -quit)"
if [ -z "$staged_dmg" ]; then
  echo "!! no .dmg produced in $build_dir" >&2
  exit 1
fi
mnt="$(mktemp -d)"
hdiutil attach "$staged_dmg" -nobrowse -readonly -mountpoint "$mnt" >/dev/null
inner="$(find "$mnt" -maxdepth 1 -name '*.app' -print -quit)"
# Structure first: a wrong --prepackaged argument yields Stewra Bridge.app/Stewra Bridge.app, where
# Contents/ is one level deeper than macOS will look.
structure_ok=0
[ -n "$inner" ] && [ -d "$inner/Contents" ] && structure_ok=1
# Then the ticket, which is the reason for building in two passes at all.
ticket_ok=0
xcrun stapler validate "$inner" >/dev/null 2>&1 && ticket_ok=1
hdiutil detach "$mnt" >/dev/null 2>&1 || true
rmdir "$mnt" 2>/dev/null || true

if [ "$structure_ok" -ne 1 ]; then
  echo "!! the .app in the dmg has no Contents/ — check the --prepackaged argument (it takes the" >&2
  echo "!! .app itself; given its parent, electron-builder nests the bundle inside itself)" >&2
  exit 1
fi
if [ "$notarized" -eq 1 ] && [ "$ticket_ok" -ne 1 ]; then
  echo "!! the .app inside the dmg has no stapled ticket, though it had one before pass 2 —" >&2
  echo "!! electron-builder rebuilt or re-signed it instead of reusing the prepackaged bundle" >&2
  exit 1
fi
echo ">> dmg contents verified: valid bundle$([ "$ticket_ok" -eq 1 ] && echo ', ticket stapled')"

# --- the update feed must describe the zip that was actually built ---------------------------------
# electron-updater downloads the zip named in latest-mac.yml and REFUSES it if the sha512 differs. A
# mismatch here (a stale yml from an earlier pass, a zip rebuilt out of band) ships an auto-update that
# every installed bridge downloads and then rejects, forever — silent in the release, loud on every
# user's machine. Assert the pair agrees before anything leaves this script.
staged_zip="$(find "$build_dir" -maxdepth 1 -name '*.zip' -print -quit)"
yml="$build_dir/latest-mac.yml"
if [ -z "$staged_zip" ]; then
  echo "!! no .zip produced in $build_dir — macOS auto-update has nothing to apply" >&2
  exit 1
fi
if [ ! -f "$yml" ]; then
  echo "!! no latest-mac.yml produced in $build_dir — check the publish config in electron-builder.yml" >&2
  exit 1
fi
zip_sha512="$(openssl dgst -sha512 -binary "$staged_zip" | base64 | tr -d '\n')"
if ! grep -qF "$zip_sha512" "$yml"; then
  echo "!! latest-mac.yml's sha512 does not match $(basename "$staged_zip")" >&2
  echo "!! shipping this pair would make every installed bridge download and reject the update" >&2
  exit 1
fi
if ! grep -qF "$(basename "$staged_zip")" "$yml"; then
  echo "!! latest-mac.yml does not reference $(basename "$staged_zip") by name" >&2
  exit 1
fi
echo ">> latest-mac.yml verified against $(basename "$staged_zip")"

# --- collect ------------------------------------------------------------------------------------
# The dmg (for the download page), the zip and the update feed (for auto-update) all travel together —
# scripts/package-release.mjs stages all of them and hard-fails on a dmg without its update pair.
#
# The yml lands as latest-mac-<arch>.yml: both arch runs write "latest-mac.yml" internally, and the
# second run would silently replace the first's — an updater feed that only ever mentions one arch.
# scripts/merge-latest-mac.mjs combines the per-arch copies into the single latest-mac.yml a release
# actually ships.
if [ "$build_dir" != "$OUT_DIR" ]; then
  shopt -s nullglob
  dmgs=("$build_dir"/*.dmg)
  if [ ${#dmgs[@]} -eq 0 ]; then
    echo "!! no .dmg produced in $build_dir" >&2
    exit 1
  fi
  # *.blockmap enables differential downloads; electron-updater falls back to a full download when a
  # blockmap is absent, so they ride along when produced but nothing asserts on them.
  for d in "${dmgs[@]}" "$build_dir"/*.zip "$build_dir"/*.blockmap; do
    cp -f "$d" "$OUT_DIR/"
    echo ">> $(basename "$d") -> $OUT_DIR/"
  done
  cp -f "$build_dir/latest-mac.yml" "$OUT_DIR/latest-mac-$arch.yml"
  echo ">> latest-mac.yml -> $OUT_DIR/latest-mac-$arch.yml"
else
  mv -f "$OUT_DIR/latest-mac.yml" "$OUT_DIR/latest-mac-$arch.yml"
  echo ">> latest-mac.yml -> $OUT_DIR/latest-mac-$arch.yml"
fi

echo ">> next: bash scripts/notarize-dmg.sh \"$OUT_DIR\"/*.dmg"
echo ">> then (after building BOTH arches): node scripts/merge-latest-mac.mjs"
