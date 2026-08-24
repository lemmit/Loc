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
// Scope — deliberately ONLY `mix deps.get`.  `mix compile` (and every other mix
// task) must keep failing fast: a compile error is the signal these gates
// exist to deliver, and retrying it would only triple the time to a red X.
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
  const chain = MIX_DEPS_GET_BACKOFF_S.reduce(
    (acc, wait, i) =>
      `${acc} || { echo loom-retry: ${cmd} failed, attempt ${i + 2} of ${MIX_DEPS_GET_ATTEMPTS} after ${wait}s; sleep ${wait}; ${cmd}; }`,
    cmd,
  );
  // Brace-grouped — see "Why the whole thing is brace-grouped" above.
  return `{ ${chain}; }`;
}
