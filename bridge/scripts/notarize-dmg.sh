#!/usr/bin/env bash
# Notarize + staple a Developer-ID-signed .dmg so macOS Gatekeeper accepts it with a clean double-click.
#
# Prereq (one-time, run in an interactive login session on the Mac build machine so the keychain is
# unlocked): store notary credentials in a keychain profile named below —
#   xcrun notarytool store-credentials "$NOTARY_PROFILE" --team-id 35JR7LFXPF
# (it prompts for the Apple ID and an app-specific password from appleid.apple.com — never passed on the CLI).
#
# Usage: bridge/scripts/notarize-dmg.sh <path-to.dmg> [keychain-profile]
set -euo pipefail

DMG="${1:?usage: notarize-dmg.sh <path-to.dmg> [keychain-profile]}"
NOTARY_PROFILE="${2:-stewra-notary}"
[ -f "$DMG" ] || { echo "ERROR: no such dmg: $DMG" >&2; exit 1; }

echo ">> submitting to Apple notary service (this can take a few minutes) ..."
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo ">> stapling the notarization ticket into the dmg ..."
xcrun stapler staple "$DMG"

echo ">> validating ..."
xcrun stapler validate "$DMG"
# Assess as a distributed dmg (offline check against the stapled ticket).
spctl -a -vvv -t open --context context:primary-signature "$DMG" 2>&1 || true

echo ">> shasum:"
shasum -a 256 "$DMG"
echo ">> DONE — notarized + stapled."
