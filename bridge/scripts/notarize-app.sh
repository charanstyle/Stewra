#!/usr/bin/env bash
#
# Notarize + staple a Developer-ID-signed .app, BEFORE it is wrapped in a .dmg.
#
# WHY THE APP AND NOT ONLY THE DMG
# --------------------------------
# Stapling the dmg attaches a ticket to the *container*. The .app the user drags to /Applications
# comes out carrying no ticket of its own, so on first launch Gatekeeper has to fetch the ticket from
# Apple over the network. With a connection that is invisible. Without one the launch is blocked —
# and "install the app, get on a plane, open it" is an ordinary thing for people to do.
#
# Observed on the 1.0.0 dmg before this existed:
#     $ xcrun stapler validate "Stewra Bridge.app"
#     Stewra Bridge.app does not have a ticket stapled to it.
# while the dmg around it validated fine. Gatekeeper still accepted the app — by going online.
#
# Stapling the app puts the ticket inside the bundle, so it travels with the app wherever it is
# copied and first launch verifies with no network at all.
#
# ORDER MATTERS
# -------------
# The ticket has to be in the bundle before the dmg is built around it — you cannot staple an app that
# is already sealed inside a read-only disk image. That is why scripts/package-mac.sh builds in two
# passes: `--dir` to produce the signed .app, this script, then `--prepackaged` to build the dmg from
# the stapled bundle. The dmg is then notarized and stapled too (scripts/notarize-dmg.sh), because the
# dmg is what carries the quarantine flag when it is downloaded.
#
# Stapling does not invalidate the signature: the ticket is written to Contents/CodeResources' sibling
# and is excluded from the seal by design. The script re-verifies afterwards rather than trusting that.
#
# Prereq: the notary keychain profile (see scripts/notarize-dmg.sh for how to create it).
#
# Usage: bridge/scripts/notarize-app.sh <path-to.app> [keychain-profile]
set -euo pipefail

APP="${1:?usage: notarize-app.sh <path-to.app> [keychain-profile]}"
NOTARY_PROFILE="${2:-stewra-notary}"
[ -d "$APP" ] || { echo "ERROR: no such app bundle: $APP" >&2; exit 1; }

echo ">> submitting $(basename "$APP") to the Apple notary service ..."
# notarytool takes zip/dmg/pkg, never a bare bundle. --keepParent preserves the .app directory itself
# inside the archive; without it the zip contains the bundle's *contents* and the submission is junk.
zip="${TMPDIR:-/tmp}/$(basename "$APP").zip"
rm -f "$zip"
ditto -c -k --keepParent "$APP" "$zip"
xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
rm -f "$zip"

echo ">> stapling the ticket into the bundle ..."
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# The whole point of stapling the app is offline verification, so verify that specifically rather than
# just asserting the ticket exists. --no-cache stops spctl answering from a previously cached online
# result, and this is the state a user's Mac is in when it opens the app with no connection.
echo ">> checking the bundle verifies offline ..."
codesign --verify --deep --strict "$APP"
spctl -a -vvv --no-cache -t exec "$APP" 2>&1 | sed 's/^/   /'

echo ">> DONE — app notarized and stapled (ticket travels inside the bundle)."
