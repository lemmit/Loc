#!/usr/bin/env bash
# PreToolUse(Bash) hook — block a `git push` when the current branch would
# NOT merge cleanly into origin/main, so upstream drift is caught before the
# push rather than as a stale/conflicted PR.
#
# Design: this hook is conservative. It only ever *denies* on a DEFINITE
# merge conflict; on any uncertainty (not a git repo, no origin/main, fetch
# offline, git too old for `merge-tree --write-tree`) it FAILS OPEN — exits 0
# and lets the push proceed — mirroring the biome-gate's "never block when the
# tool isn't available" stance. A deny is surfaced to Claude as a reason so it
# rebases onto origin/main and resolves first.
#
# Wired as PreToolUse(matcher: "Bash"); the push detection happens in-script
# (below) so it doesn't depend on a settings-level command matcher.
set -uo pipefail

# --- read the tool call ----------------------------------------------------
input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)" || exit 0

# Only act on a real `git … push` invocation; defer (allow) everything else.
# Matches `git push`, `git -C dir push`, `git --no-pager push`, and pushes
# inside compound commands / retry loops.  Read-only commands that merely
# mention "push" in a string are not git pushes and fall through.
if ! [[ "$command" =~ (^|[^[:alnum:]_/.])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+push([[:space:]]|$) ]]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Don't gate a push of the trunk itself (nothing to merge it into).
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
case "$branch" in main|master|HEAD|"") exit 0 ;; esac

# --- best-effort refresh of origin/main (offline → fail open) --------------
timeout 20 git fetch origin main --quiet >/dev/null 2>&1 || true
git rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

# --- conflict dry-run ------------------------------------------------------
# `git merge-tree --write-tree` (git >= 2.38): exit 0 = clean, 1 = conflicts,
# >1 = usage/version error → fail open.
mt="$(git merge-tree --write-tree origin/main HEAD 2>/dev/null)"; rc=$?
[ "$rc" -gt 1 ] && exit 0          # error / unsupported → allow
if [ "$rc" -eq 0 ] && ! printf '%s' "$mt" | grep -q '^CONFLICT'; then
  exit 0                            # clean → allow
fi

# --- definite conflict → deny ----------------------------------------------
files="$(printf '%s' "$mt" | grep -iE '^CONFLICT' | sed 's/^/  - /' | head -20)"
reason="git push blocked: branch '${branch}' does not merge cleanly into origin/main.
Rebase onto the latest origin/main and resolve the conflict(s) before pushing:
    git fetch origin main && git rebase origin/main
Conflicting:
${files}"

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
