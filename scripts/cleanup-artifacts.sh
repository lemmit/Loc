#!/usr/bin/env bash
# Local emergency Actions-storage recovery.
#
# Mirrors .github/workflows/cleanup-artifacts.yml, but runs on your
# machine via the gh CLI so it works even when the Actions storage
# quota is exhausted (which blocks artifact uploads) and regardless of
# which branch the workflow file lives on (workflow_dispatch requires
# the workflow to be on the default branch; this does not).
#
# Requires: gh (authenticated: `gh auth status`), jq.
#
# Usage:
#   scripts/cleanup-artifacts.sh            # delete ALL artifacts (full recovery)
#   scripts/cleanup-artifacts.sh 2          # delete artifacts older than 2 days
#   REPO=lemmit/loc scripts/cleanup-artifacts.sh
set -euo pipefail

REPO="${REPO:-lemmit/loc}"
MAX_AGE_DAYS="${1:-0}"

command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "error: jq not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: run 'gh auth login' first" >&2; exit 1; }

cutoff_epoch=$(( $(date -u +%s) - MAX_AGE_DAYS * 86400 ))
if [ "$MAX_AGE_DAYS" -eq 0 ]; then
  echo "Deleting ALL artifacts in $REPO ..."
else
  echo "Deleting artifacts in $REPO older than ${MAX_AGE_DAYS}d ..."
fi

deleted=0
freed_bytes=0
page=1
while :; do
  batch=$(gh api -X GET \
    "repos/$REPO/actions/artifacts?per_page=100&page=$page" \
    --jq '.artifacts[] | [.id, .name, .size_in_bytes, .created_at] | @tsv')
  [ -z "$batch" ] && break

  while IFS=$'\t' read -r id name size created; do
    [ -z "${id:-}" ] && continue
    created_epoch=$(date -u -d "$created" +%s 2>/dev/null \
      || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$created" +%s)
    if [ "$created_epoch" -ge "$cutoff_epoch" ]; then
      continue
    fi
    gh api -X DELETE "repos/$REPO/actions/artifacts/$id" >/dev/null
    deleted=$(( deleted + 1 ))
    freed_bytes=$(( freed_bytes + ${size:-0} ))
    echo "  deleted $name (#$id, ${size:-0} B, $created)"
  done <<< "$batch"

  page=$(( page + 1 ))
done

freed_mb=$(awk "BEGIN { printf \"%.1f\", $freed_bytes / 1048576 }")
echo "Done: deleted $deleted artifact(s), freed ~${freed_mb} MB."
