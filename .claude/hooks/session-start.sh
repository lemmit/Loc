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

# Build-staleness guard — warn (never fail) when `out/` is older than `src/`.
#
# `out/` is gitignored and nothing rebuilds it on a checkout, so any `git
# switch` / `git checkout` that moves `src/` leaves the compiled toolchain
# behind while `bin/cli.js` keeps happily running the OLD emitters.  The failure
# is worse than a plain error because the output looks plausible: a generate
# that silently omits a file the current emitters do produce, or a Handlebars
# crash in a template unrelated to whatever you are working on.  Both happened
# (experience_gathered.md §69), and the first one cost a full investigation —
# emitter sources compared byte-identical across two commits while their OUTPUT
# differed, which is impossible unless the binary is not the source.
#
# Warn only: a rebuild can take minutes and the session may not need one.
check_build_staleness() {
  [ -d out ] || return 0
  [ -d src ] || return 0
  local newest_out newer
  # Newest compiled artefact; if out/ is empty there is nothing to compare.
  newest_out="$(find out -name '*.js' -type f -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)" || return 0
  [ -n "$newest_out" ] || return 0
  # Any TypeScript source newer than that artefact means out/ is behind.
  newer="$(find src -name '*.ts' -type f -newer "$newest_out" -print -quit 2>/dev/null)" || return 0
  if [ -n "$newer" ]; then
    echo "⚠ out/ is older than src/ — the compiled toolchain is STALE."
    echo "  \`bin/cli.js\` will run the previous emitters, so generated output"
    echo "  can silently disagree with the sources you are reading."
    echo "      npx tsc -b"
    echo "  (See experience_gathered.md §69.)"
  fi
}
check_build_staleness || true

# Idempotent + cache-friendly: the container state is cached after the hook
# completes, so if Biome and the generated Langium sources are already present
# there is nothing to do. `src/language/generated/` is gitignored and produced
# by the `prepare` lifecycle, so its presence is the real "ready" signal.
#
# But "files present" is NOT the same as "deps match the lockfile": a cached
# node_modules layer survives a `package-lock.json` bump, so a previously-cached
# install (e.g. Langium 3.x) can satisfy the file checks while the repo has since
# moved to ~4.3.0 — and the build/tests then explode on API mismatches
# (`this.getAllTypes is not a function`). Pin the readiness signal to a hash of
# the lockfile so any dependency bump forces a fresh, deterministic `npm ci`.
DEPS_STAMP="node_modules/.loom-deps-lockhash"
lock_hash() {
  { sha256sum package-lock.json 2>/dev/null || shasum -a 256 package-lock.json 2>/dev/null; } \
    | awk '{print $1}'
}
WANT_HASH="$(lock_hash || true)"
if [ -x node_modules/.bin/biome ] && [ -d src/language/generated ] \
  && [ -n "$WANT_HASH" ] && [ "$(cat "$DEPS_STAMP" 2>/dev/null || true)" = "$WANT_HASH" ]; then
  exit 0
fi

# Lockfile changed (or first provision): `npm ci` installs exactly what
# package-lock.json pins (vs `install`, which may keep a stale cached version
# that satisfies the semver range), then runs the `prepare` lifecycle
# (langium:generate + build), which produces src/language/generated/ — required
# before tsc, vitest, or the Biome gate can run.
npm ci

# Record the lockfile hash so the next session early-exits only while deps match.
[ -n "$WANT_HASH" ] && printf '%s' "$WANT_HASH" > "$DEPS_STAMP" || true
