#!/usr/bin/env bash
# Publish master to the public repo (github.com/stlTechnology/hostalorgs) as a
# CLEAN copy: no history (old history holds prototype files we cannot publish),
# no internal worker mailboxes or notes. Each run adds one commit on top of the
# public repo's own history.
#   tools/publish.sh "message"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MSG="${1:?usage: tools/publish.sh \"commit message\"}"
PUB="${PUBLISH_DIR:-$HOME/.cache/hostalorgs-public}"
[ -d "$PUB/.git" ] || git clone -q https://github.com/stlTechnology/hostalorgs.git "$PUB"
git -C "$PUB" pull -q --ff-only
find "$PUB" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$ROOT" archive HEAD | tar -x -C "$PUB"
( cd "$PUB" && rm -rf .team .lane screens START-HERE.md REVIEW-SUGGESTIONS.md \
    validate-prompt.md NOTES.md AGENTS.md CLAUDE.md RENDER-NOTES.md )
# Refuse to publish anything that looks like a secret, private text or id/Valve
# data. Private words (names, internal domains) live OUTSIDE the repo, one per
# line, in ~/.config/hostalorgs-publish-deny, so this script never carries them.
DENY="$HOME/.config/hostalorgs-publish-deny"
PAT='sk-or-v1-[A-Za-z0-9]|sk-ant-[a-z]|gh[po]_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY'
if [ -s "$DENY" ]; then PAT="$PAT|$(paste -sd'|' "$DENY")"; fi
if grep -rnIE "$PAT" "$PUB" --exclude-dir=.git --exclude=publish.sh; then
  echo "FATAL: secret-like or private text above; not publishing" >&2; exit 1; fi
if find "$PUB" -path "$PUB/.git" -prune -o \( -iname "pak0.pak" -o -iname "2fort*" -o -iname "fortress.wad" \) -print | grep -q .; then
  echo "FATAL: id/Valve game data in the tree; not publishing" >&2; exit 1; fi
cd "$PUB"
git add -A
git -c user.name=stlTechnology -c user.email=stlTechnology@users.noreply.github.com \
  commit -q -m "$MSG" || { echo "nothing to publish"; exit 0; }
git push -q origin main
echo "published: $(git rev-parse --short HEAD) -> https://github.com/stlTechnology/hostalorgs"
