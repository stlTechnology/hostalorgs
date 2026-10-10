#!/usr/bin/env bash
# M6 name-filter test (PROJECT.md abuse row: "Name length and character filter").
#
#   tests/test_name_filter.sh
#
# The filter itself is FTE's own SV_FixupName/SV_DeDupeName (sv_main.c): invalid
# characters (":", "\", "$", CR, LF, '"', 0xff) are dropped, the name is capped
# (40 bytes after the fixup's own bound), hidden markup and pictograms are
# rejected, a whitespace-only name becomes "unnamed", "console" becomes
# "unnamed", duplicates get "(1)" suffixes, and more than five changes inside
# five seconds mutes name changes. We do not reimplement that in QuakeC: the
# engine already does it on EVERY userinfo change (net_preparse.c calls
# SV_ExtractFromUserinfo), and a second filter in ctf.qc could only drift.
#
# What had never been proven is that it holds on the path a person actually
# uses -- a browser client setting a name, at connect (?name=...) and at
# runtime (console `name`, the key F opens). This drives one headless client
# through both paths and asserts the name the SERVER stores, read with the
# server's own `user <uid>` command: it prints the client's raw userinfo, into
# which SV_ExtractFromUserinfo has already written the sanitized name back. The
# status table is read first only to get the userid -- its name column is cut
# at 16 bytes and cannot prove the 40-byte cap.
#
# Cases and what each asserts:
#   Phase R (raw QW client, before the browser):
#     crafted userinfo a"b:c$d  -> unnamed. Measured: a value carrying `"` or
#         `$` is flagged by the info layer itself (InfoBuf_NeedsEncoding) and
#         SV_ExtractFromUserinfo blanks it wholesale before the fixup runs, so
#         nothing unsafe can even reach the name logic. A browser cannot send
#         these bytes at all (its own info buffer refuses them), so only a
#         crafted packet exercises that half of the filter.
#   Phase B (headless browser, both name paths):
#     probe            baseline: an ordinary name passes through unchanged
#     63 a's           exactly "a"*40 -- the fixup's length cap (the longest
#         input that reaches it: a value of 64+ bytes is "large" in the info
#         layer and is discarded wholesale instead)
#     64 a's           -> unnamed      (the "large" wholesale discard)
#     b:c              -> bc          (":" dropped by the fixup)
#     console          -> unnamed      (deleetstring's console guard)
#     \202\202         -> no invis chars survive (the markup scan)
#     "   " (runtime)  -> unnamed      (whitespace-only)
#     "" (runtime)     -> unnamed      (empty)
#     "Pro Be 42"      -> unchanged    (spaces survive, and the parser sees them)
#
# Negative control: every assertion reads the exact stored name. Without the
# fixup the long case would store 67 bytes and the raw case would store the
# raw bytes, so the checks bite on the unfiltered engine too. (We cannot cheaply
# re-run against a patched engine; the sensitivity is in the exact matches.)
# A backslash is unrepresentable in the info format itself (it is the key/value
# delimiter), so no transport can carry one in a name; it is the one character
# the test cannot reach, by construction rather than by omission.
#
# Name changes are spaced 2 s apart ON PURPOSE: FTE mutes name changes after 5
# inside 5 s, and the later cases must not be muted.

LOCK="${QWTF_WALK_LOCK:-/tmp/qwtf-walk.lock}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another walk/load suite holds $LOCK -- waiting for it to finish."
  flock 9
fi
exec node "$DIR/test_name_filter.js"
