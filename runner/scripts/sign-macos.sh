#!/usr/bin/env bash
#
# Developer ID sign + notarize the macOS runner binary, so a downloaded copy actually runs.
#
# WHY THIS IS NOT OPTIONAL
# -----------------------
# scripts/package-binary.mjs leaves the binary ad-hoc signed ("Signature=adhoc", no team identifier).
# That is fine for a binary you built yourself, and useless for one you downloaded: the browser marks
# the file com.apple.quarantine, and Gatekeeper refuses to run an ad-hoc-signed quarantined executable.
# It is not a warning the user can click through from the terminal — the process is SIGKILLed:
#
#     $ ./stewra-runner-macos-arm64 --version
#     zsh: killed        (exit 137)      + "Apple could not verify ... is free of malware"
#
# (Verified on macOS 15 / Darwin 24.6 with the quarantine attribute set by hand.)
#
# A Developer ID signature plus a notarization ticket removes that gate entirely.
#
# NO STAPLING
# -----------
# `stapler` only staples app bundles, dmgs and installer packages — a bare Mach-O executable has
# nowhere to put the ticket. That is expected and fine: Gatekeeper looks the ticket up online by the
# binary's cdhash on first run. The upload IS the artifact being notarized; the binary itself is
# unchanged by notarization, so publish the signed binary, not the zip.
#
# Running on exFAT is safe here, unlike the .app bundle (see bridge/scripts/package-mac.sh): a lone
# Mach-O carries its signature inside its own bytes and seals no sibling files, so there is no
# AppleDouble sidecar for codesign to record and later fail to find.
#
# Prereq: the notary keychain profile from bridge/scripts/notarize-dmg.sh (default: stewra-notary).
#
# Usage: runner/scripts/sign-macos.sh <path-to-binary> [keychain-profile]
set -euo pipefail

BIN="${1:?usage: sign-macos.sh <path-to-binary> [keychain-profile]}"
NOTARY_PROFILE="${2:-stewra-notary}"
# Full common name, including the "Developer ID Application:" prefix — codesign takes the identity
# verbatim (electron-builder is the odd one out in adding the prefix itself).
IDENTITY="${STEWRA_MAC_IDENTITY:-Developer ID Application: Nurturing Lab Limited Company (35JR7LFXPF)}"
ENTITLEMENTS="$(dirname "$0")/runner.entitlements"

[ -f "$BIN" ] || { echo "ERROR: no such binary: $BIN" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "ERROR: missing $ENTITLEMENTS" >&2; exit 1; }

echo ">> signing with: $IDENTITY"
# --force replaces the ad-hoc signature; --timestamp gets a trusted timestamp so the signature stays
# valid after the certificate expires; --options runtime is what notarization requires.
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$BIN"

codesign --verify --strict --verbose=2 "$BIN"

echo ">> submitting to Apple notary service (this can take a few minutes) ..."
# notarytool only accepts zip/dmg/pkg, so wrap the binary. ditto is the Apple-blessed zip writer.
zip="${TMPDIR:-/tmp}/$(basename "$BIN").zip"
rm -f "$zip"
ditto -c -k "$BIN" "$zip"
xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
rm -f "$zip"

echo ">> verifying the notarized binary ..."
# Gatekeeper's own verdict, checked the way it will be checked on a user's machine. `-t exec` is the
# assessment type for a plain executable; the ticket is fetched online, so this needs a network.
spctl -a -vvv -t exec "$BIN" 2>&1 || true

echo ">> shasum:"
shasum -a 256 "$BIN"
echo ">> DONE — signed + notarized (no staple; ticket resolves online)."
