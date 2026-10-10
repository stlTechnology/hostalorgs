#!/usr/bin/env bash
# Deploy a FROZEN SNAPSHOT of the served tree for the play-test services.
#
#   scripts/deploy_snapshot.sh [<commit>]     # prints the deploy directory
#
# Why this exists (reviewer 0054): the owner's first play-test died with
# "Host_EndGame: Server disconnected - map model file does not match
# (maps/corridor.bsp)". The play server had loaded corridor.bsp out of the
# live build tree, and while the owner was connected I rebuilt
# web/id1/maps/corridor.bsp. The page served the NEW file and the server still
# held the OLD one, so every client was refused.
#
# The fix is to stop sharing the live tree. The services read a directory that
# only changes when someone deploys, so a rebuild cannot reach a running
# play-test. Both units are pointed at ONE directory, so the server and the page
# always serve the same bytes.
#
#   build/deploy/<commit>/web/      the snapshot itself
#   build/deploy/<commit>/DEPLOYED_COMMIT   which commit it is
#
# The deploy is driven by `git archive`, so what is deployed is exactly what is
# committed -- an uncommitted rebuild cannot leak into a play-test, which is
# precisely how the owner was disconnected.
#
# Re-extracting every time is deliberate: it is a few MB, and it means the
# directory cannot drift from the commit it claims to be.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT="${1:-$(git -C "$ROOT" rev-parse HEAD)}"
DEPLOY_BASE="${QWTF_DEPLOY_BASE:-$ROOT/build/deploy}"
DIR="$DEPLOY_BASE/$COMMIT"

# Refuse a dirty-tree commit reference rather than silently deploying HEAD.
git -C "$ROOT" rev-parse --verify --quiet "$COMMIT^{commit}" >/dev/null || {
  echo "FATAL: '$COMMIT' is not a commit in $ROOT" >&2; exit 1; }

mkdir -p "$DIR"
# git archive has no exclude, so extract to a temp dir and swap, or a stale file
# from a previous deploy of the same commit would survive. Same commit means the
# same content, so a plain re-extract is already correct; the temp swap just
# makes it obvious if a deploy is interrupted.
TMP="$DIR.tmp.$$"
rm -rf "$TMP"
mkdir -p "$TMP"
git -C "$ROOT" archive "$COMMIT" web | tar -x -C "$TMP"
[ -f "$TMP/web/index.html" ] || {
  echo "FATAL: snapshot of $COMMIT has no web/index.html" >&2
  rm -rf "$TMP"; exit 1; }
rm -rf "$DIR"
mv "$TMP" "$DIR"

printf '%s\n' "$COMMIT" > "$DIR/DEPLOYED_COMMIT"
echo "$DIR"