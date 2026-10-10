#!/usr/bin/env bash
# Build stamp: writes build.json with build date and git sha.
#
#   scripts/build_stamp.sh               -> web/build.json, sha = short HEAD
#   scripts/build_stamp.sh <webdir>      -> <webdir>/build.json, sha = short HEAD
#   scripts/build_stamp.sh <webdir> <sha> -> <webdir>/build.json with that sha
#
# install_service.sh --deploy calls it with the SNAPSHOT's web dir and the
# deployed commit (0469), so the live menu shows what is actually deployed and
# not whatever is checked out in the working tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$ROOT/web}"
SHA_ARG="${2:-}"

# Generate build timestamp in America/Chicago timezone
built=$(TZ=America/Chicago date '+%F %H:%M %Z')

# Get short git sha
sha=${SHA_ARG:-$(git rev-parse --short HEAD)}

# Write build.json
printf '{"built":"%s","sha":"%s"}' "$built" "$sha" > "$TARGET/build.json"

echo "Build stamp written: $TARGET/build.json: $built, sha=$sha"
