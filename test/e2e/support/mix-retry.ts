// ---------------------------------------------------------------------------
// Bounded retry around `mix deps.get`, as a SHELL SNIPPET.
//
// Why: hex.pm answers a tarball fetch with a transient 500 often enough to kill
// an otherwise-green CI cell —
//
//   Request failed (500) ... Package fetch failed and no cached copy available
//     (repo.hex.pm/tarballs/ecto-3.14.2.tar)
//
// (run 32690823157, cell `vanilla-tenancy-registry`; twice in 24h).  The elixir
// workflows already retry the docker image pull with backoff (added after
// #2380 — "a transient hiccup costs seconds, not the cell"); `mix deps.get` is
// the same failure class one step later and had no retry at all.
//
// Scope — the two TOOLCHAIN-FETCH steps only: `mix deps.get` and the
// `mix local.hex` / `mix local.rebar` install that precedes it.  `mix compile`
// (and every other mix task) must keep failing fast: a compile error is the
// signal these gates exist to deliver, and retrying it would only triple the
// time to a red X.  Neither fetch step can ever produce that signal — both fail
// with a network message and no emitted code is even read — so retrying them
// costs nothing a green run would have paid anyway.
//
// `local.hex` was added to that scope after the pairwise elixir leg's first full
// run: 17 of 25 cases failed with BYTE-IDENTICAL text —
//
//   ** (Mix) request timed out after 60000ms
//   Could not install Hex because Mix could not download metadata at
//     https://builds.hex.pm/installs/hex.csv
//
// — under concurrent load from sibling docker builds sharing one egress proxy.
// One of those exact cases then compiled clean in 67s when re-run alone.  Every
// case is a fresh `docker run --rm`, and `--force` re-fetches `hex.csv` however
// warm the mounted `~/.hex` cache is, so this is one un-retried network call per
// case — the single most-repeated remote fetch in the elixir gates, and until
// now the only one with no backoff at all.  The header below already noted that
// a `local.hex` failure falls through into the fetch's retry groups; that made
// it a correctness hazard for the CHAIN, and it was also the step most likely to
// fail.
//
// ── The quote-free invariant ────────────────────────────────────────────────
// The returned snippet is spliced into command lines with three different
// quoting shapes:
//
//   docker run … bash -c '… && SNIPPET && mix compile …'   (single-quoted)
//   docker run … sh   -c "… && SNIPPET && mix compile"     (double-quoted)
//   execSync(`… && SNIPPET`, { cwd, shell: "/bin/bash" })  (bare)
//
// so it must survive all three unchanged.  A `$` would be expanded by the OUTER
// shell inside the double-quoted form (`$((i*5))` → `0`, `$i` → empty), and a
// quote of either flavour would terminate the enclosing string.  The snippet
// therefore uses NO shell variables, NO arithmetic expansion, and NO quotes —
// just a literal `||` chain of `{ …; }` groups, which is POSIX-portable and
// identical under every quoting shape.  `assertQuoteFree` keeps callers honest.
//
// ── Why the whole thing is brace-grouped ────────────────────────────────────
// `&&` and `||` have EQUAL precedence in the shell and associate LEFT.  A bare
// `fetch || retry1 || retry2` spliced into `hex && fetch… && compile` parses as
//
//   ((((hex && fetch) || retry1) || retry2) && compile)
//
// — so a failure of `mix local.hex` (the command BEFORE the fetch) would fall
// through into the retry groups, and a fetch that then succeeded would let
// `mix compile` run anyway.  Observed for real in the hexpm image.  Wrapping
// the chain in `{ …; }` makes it ONE compound command, so it composes into an
// `&&` chain exactly like the bare `mix deps.get` it replaces.
// ---------------------------------------------------------------------------

/** Total `mix deps.get` attempts (1 initial + `MIX_DEPS_GET_BACKOFF_S.length`). */
export const MIX_DEPS_GET_ATTEMPTS = 3;

/** Seconds to sleep before attempt 2, before attempt 3, … */
export const MIX_DEPS_GET_BACKOFF_S = [5, 20] as const;

/**
 * Build a bounded-retry `||` chain for one quote-free command, brace-grouped so
 * it composes into an `&&` chain exactly like the bare command it replaces.
 * Shared by {@link mixDepsGet} and {@link mixLocalInstall} — the two differ only
 * in which command they wrap.
 */
function retryChain(cmd: string, backoff: readonly number[], attempts: number): string {
  const chain = backoff.reduce(
    (acc, wait, i) =>
      `${acc} || { echo loom-retry: ${cmd} failed, attempt ${i + 2} of ${attempts} after ${wait}s; sleep ${wait}; ${cmd}; }`,
    cmd,
  );
  // Brace-grouped — see "Why the whole thing is brace-grouped" above.
  return `{ ${chain}; }`;
}

function assertQuoteFree(args: string): void {
  if (/["'$`\\]/.test(args)) {
    throw new Error(
      `mixDepsGet(${JSON.stringify(args)}): args must be quote-free and shell-inert — ` +
        `the snippet is spliced into single-quoted, double-quoted AND bare command lines ` +
        `(see the header of test/e2e/support/mix-retry.ts).`,
    );
  }
}

/**
 * `mix deps.get [args]` wrapped in a bounded retry — 3 attempts with a 5s then
 * 20s backoff — as a single shell command string.
 *
 * Composes into an `&&` chain exactly like the bare command it replaces: it
 * succeeds (status 0) as soon as one attempt succeeds, and carries the LAST
 * attempt's non-zero status out when all three fail, so `… && mix compile`
 * still short-circuits and the harness still throws.
 *
 * @param args extra flags for the fetch, e.g. `"--only prod"` (quote-free).
 */
export function mixDepsGet(args = ""): string {
  assertQuoteFree(args);
  const cmd = ["mix", "deps.get", args.trim()].filter(Boolean).join(" ");
  return retryChain(cmd, MIX_DEPS_GET_BACKOFF_S, MIX_DEPS_GET_ATTEMPTS);
}

/**
 * `mix local.hex --force && mix local.rebar --force`, each wrapped in the same
 * bounded retry — the Hex/rebar INSTALL that every containerised elixir gate
 * runs before its fetch.
 *
 * Each is retried independently so a flaky `local.hex` does not drag a
 * successful `local.rebar` through a needless sleep, and the pair composes into
 * the caller's `&&` chain exactly like the two bare commands it replaces.
 *
 * Same quote-free, brace-grouped invariants as {@link mixDepsGet} — it is
 * spliced into the same single-quoted `docker run … bash -c '…'` lines.
 */
export function mixLocalInstall(): string {
  return [
    retryChain("mix local.hex --force", MIX_DEPS_GET_BACKOFF_S, MIX_DEPS_GET_ATTEMPTS),
    retryChain("mix local.rebar --force", MIX_DEPS_GET_BACKOFF_S, MIX_DEPS_GET_ATTEMPTS),
  ].join(" && ");
}
