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
