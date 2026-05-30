#!/usr/bin/env bash
#
# Stop-hook Biome gate.
#
# Mirrors the `npm run lint` (biome ci .) step in .github/workflows/test.yml so
# the same check that gates CI also runs the moment an agent finishes a turn.
# Agents kept pushing branches that only failed Biome once they reached CI;
# this turns that late, remote failure into an immediate, local, blocking one.
#
# Behaviour:
#   * biome not installed (fresh container) -> skip (can't lint, never block).
#   * no work this session (clean tree, no  -> skip (nothing to gate).
#     commits ahead of origin/main)
#   * `npm run lint` passes                 -> pass.
#   * lint fails, first stop                -> BLOCK (exit 2); the Biome output
#                                              is fed back to the agent, which
#                                              must fix before it can finish.
#   * lint fails, already looped once        -> release with a loud warning, so
#                                              a genuinely-stuck agent can't get
#                                              trapped in an infinite Stop loop.
#
set -uo pipefail

input="$(cat)"

# Loop guard: Claude sets stop_hook_active=true when it is *already* continuing
# because a previous Stop hook blocked it. We only hard-block on the first pass.
stop_hook_active=false
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  stop_hook_active=true
fi

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" 2>/dev/null || exit 0

# Can't lint without Biome installed (e.g. a fresh container before `npm ci`).
# Never block on infrastructure we don't control — just let the stop proceed.
if [ ! -x node_modules/.bin/biome ]; then
  exit 0
fi

# Only gate when the agent actually did work this session: either an uncommitted
# change, or a commit on this branch that isn't on origin/main yet.
dirty=false
[ -n "$(git status --porcelain --ignore-submodules 2>/dev/null)" ] && dirty=true

ahead=false
base="$(git merge-base HEAD origin/main 2>/dev/null)"
if [ -n "$base" ] && [ -n "$(git rev-list "$base"..HEAD 2>/dev/null)" ]; then
  ahead=true
fi

if [ "$dirty" = false ] && [ "$ahead" = false ]; then
  exit 0
fi

# biome ci . is fast (sub-second to a few seconds); run it exactly as CI does.
if lint_output="$(npm run --silent lint 2>&1)"; then
  exit 0
fi

if [ "$stop_hook_active" = true ]; then
  # We already forced one fix cycle and Biome still fails. Release to avoid an
  # infinite Stop loop, but make the unresolved failure impossible to miss.
  {
    echo "⚠️  Biome gate STILL failing after a fix attempt. This WILL fail CI"
    echo "    (npm run lint in .github/workflows/test.yml). Releasing the stop to"
    echo "    avoid an infinite loop — DO NOT push until 'npm run lint' is clean."
    echo
    echo "$lint_output"
  } >&2
  exit 0
fi

# First failure: block, and hand the agent the exact error CI would have shown.
{
  echo "Biome gate failed. This is the same check that gates CI:"
  echo "  'npm run lint' (biome ci .) in .github/workflows/test.yml."
  echo
  echo "Fix it before finishing. Usually: 'npm run format' to auto-fix, then"
  echo "re-run 'npm run lint' to confirm it's clean. Biome output:"
  echo
  echo "$lint_output"
} >&2
exit 2
