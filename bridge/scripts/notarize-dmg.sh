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

# Do NOT assess the dmg itself with `spctl -t open --context context:primary-signature`. electron-builder
# signs the .app, not the dmg container, so that check answers
#
#     rejected / source=no usable signature
#
# on a perfectly good notarized+stapled dmg — it is reporting that the container has no signature of its
# own, not that Gatekeeper would block anything. Printing "rejected" at the end of a successful run is
# worse than printing nothing.
#
# The verdict that matters is the one for the app the user drags to /Applications, so mount the dmg and
# ask about that. Expect: accepted / source=Notarized Developer ID.
echo ">> assessing the .app inside (what the user actually launches) ..."
mnt="$(mktemp -d)"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$mnt" >/dev/null
app="$(find "$mnt" -maxdepth 1 -name '*.app' -print -quit)"
if [ -n "$app" ] && spctl -a -t exec "$app" >/dev/null 2>&1; then
  spctl -a -vvv -t exec "$app" 2>&1 | sed 's/^/   /'
  verdict=0
else
  echo "   FAILED — Gatekeeper would reject the app in this dmg; do not publish it" >&2
  verdict=1
fi
hdiutil detach "$mnt" >/dev/null 2>&1 || true
rmdir "$mnt" 2>/dev/null || true
[ "$verdict" -eq 0 ] || exit 1

echo ">> shasum:"
shasum -a 256 "$DMG"
echo ">> DONE — notarized + stapled."
