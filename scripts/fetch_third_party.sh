#!/usr/bin/env bash
# Fetch the GPL/open third-party sources the project builds on, at PINNED
# commits, into third_party/ (git-ignored). See .team/PLAN.md and PROJECT.md.
#
# Idempotent: re-running is a no-op for anything already present at the right
# commit. Delete third_party/ to force a clean fetch.
#
# Licences (PROJECT.md requires these recorded in ASSETS-CREDITS.md):
#   fteqw        GPL v2      engine + web client + dedicated server
#   ericw-tools  GPL v2      qbsp / qvis / qrad, map compiler
#   LibreQuake   see ASSETS-CREDITS.md -- OPENLY LICENSED game assets, used as
#                the id1 content replacement. NOT id/Valve data.
#
# Deliberately NOT fetched: any Quake pak, TF QuakeC, TF models/maps, or
# anything named "Team Fortress" / "2fort".

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/third_party"

# repo-url                                       dest-dir   pinned commit
PINS=(
  "https://github.com/fte-team/fteqw.git|fteqw|f937b9d88f71fc4429db5fe56c6a98d922711b2e|sub"
  "https://github.com/ericwa/ericw-tools.git|ericw-tools|36eec1da2a194467e6baac2f444c2dd04b57d266|sub"
  "https://github.com/lavenderdotpet/LibreQuake.git|LibreQuake|4d2da523331f00211c97c90dc5af8672a2967618"
)

mkdir -p "$DEST"

have() { command -v "$1" >/dev/null 2>&1; }
have git   || { echo "FATAL: git not found" >&2; exit 1; }
have curl  || { echo "note: curl not found, using git for connectivity only" >&2; }

for pin in "${PINS[@]}"; do
  url="${pin%%|*}"; rest="${pin#*|}"
  name="${rest%%|*}"; rest="${rest#*|}"
  want="${rest%%|*}"; subs="${rest#*|}"

  # Optional filter for narrow builds (the container image needs fteqw only and
  # would otherwise clone ericw-tools and LibreQuake for nothing). Default: all.
  if [ -n "${QWTF_FETCH_ONLY:-}" ]; then
    case ",$QWTF_FETCH_ONLY," in
      *",$name,"*) ;;
      *) continue;;
    esac
  fi

  target="$DEST/$name"

  if [ -d "$target/.git" ]; then
    have_commit="$(git -C "$target" rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$have_commit" = "$want" ]; then
      echo "  $name: already at ${want:0:12} (skipped)"
      continue
    fi
    echo "  $name: at ${have_commit:0:12}, moving to ${want:0:12}"
    git -C "$target" fetch --quiet origin "$want" || {
      echo "FATAL: could not fetch $want for $name" >&2; exit 1; }
    git -C "$target" checkout --quiet --detach "$want"
  else
    echo "  $name: cloning -> third_party/$name"
    rm -rf "$target"
    recurse=()
    [ "$subs" = "sub" ] && recurse=(--recurse-submodules --shallow-submodules)
    git clone --quiet "${recurse[@]}" "$url" "$target"
    git -C "$target" checkout --quiet --detach "$want"
  fi

  # Submodules are pinned by the parent commit, so init+update is idempotent.
  if [ "$subs" = "sub" ]; then
    git -C "$target" submodule update --init --recursive --quiet
  fi

  got="$(git -C "$target" rev-parse HEAD)"
  if [ "$got" != "$want" ]; then
    echo "FATAL: $name is at $got, expected $want" >&2; exit 1
  fi
  nsub=$(git -C "$target" submodule status 2>/dev/null | grep -c '^-' || true)
  if [ "$subs" = "sub" ] && [ "$nsub" != "0" ]; then
    echo "FATAL: $name has $nsub uninitialised submodule(s)" >&2; exit 1
  fi
  echo "  $name: ${got:0:12} ok$([ "$subs" = sub ] && echo " (submodules ok)")"
done

echo "third_party ready:"
for pin in "${PINS[@]}"; do
  rest="${pin#*|}"; name="${rest%%|*}"
  [ -d "$DEST/$name/.git" ] || continue   # filtered out by QWTF_FETCH_ONLY
  printf '  %-14s %s\n' "$name" "$(git -C "$DEST/$name" rev-parse --short HEAD)"
done