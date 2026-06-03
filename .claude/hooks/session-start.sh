#!/bin/bash
#
# SessionStart hook — ensure the project's npm dependencies are installed so the
# Biome lint gate (.claude/hooks/biome-gate.sh), the build, and the tests can
# actually run. Without this, a fresh remote container has no node_modules and
# the Biome Stop-gate silently skips (it can't lint what isn't installed).
#
set -euo pipefail

# Only the remote (Claude Code on the web) container needs provisioning; a local
# developer manages their own dependencies.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Staleness guard — warn (never fail) when this checkout is behind origin/main.
# Branching a refactor from a stale base is the one trap that bit us before
# (see experience_gathered.md → "Stacked refactor PRs: rebase before you
# branch"): disjoint-file PRs merge cleanly and hide the drift until a later,
# overlapping PR conflicts *after* CI has already passed. A heads-up at session
# start nudges new work onto a fresh base. Fully fail-open — any git/network
# hiccup just skips the notice. Runs before the idempotent early-exit below so
# it fires every session, not only on first provision.
check_staleness() {
  local branch behind
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 0
  timeout 20 git fetch --quiet origin main 2>/dev/null || return 0
  behind="$(git rev-list --count HEAD..origin/main 2>/dev/null)" || return 0
  if [ -n "$behind" ] && [ "$behind" -gt 0 ]; then
    echo "⚠ This checkout (${branch}) is ${behind} commit(s) behind origin/main."
    echo "  Starting new work? Branch from a fresh main to avoid stale-base merge conflicts:"
    echo "      git fetch origin main && git switch -c <branch> origin/main"
    echo "  (See experience_gathered.md → 'Stacked refactor PRs: rebase before you branch'.)"
  fi
}
check_staleness || true

# Idempotent + cache-friendly: the container state is cached after the hook
# completes, so if Biome and the generated Langium sources are already present
# there is nothing to do. `src/language/generated/` is gitignored and produced
# by the `prepare` lifecycle, so its presence is the real "ready" signal.
if [ -x node_modules/.bin/biome ] && [ -d src/language/generated ]; then
  exit 0
fi

# `npm install` runs the `prepare` lifecycle (langium:generate + build +
# build:web), which produces src/language/generated/ — required before tsc,
# vitest, or the Biome gate can run. `install` (vs `ci`) reuses the cached
# node_modules layer when present.
npm install
