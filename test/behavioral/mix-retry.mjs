// The .mjs SHELL TWIN of `mixDepsGet()` from test/e2e/support/mix-retry.ts —
// the bounded-retry `mix deps.get` snippet for behavioral harnesses that build
// one blocking shell chain (deps → ecto → phx.server) and so cannot use
// run-elixir.mjs's per-step execFileSync loop. Kept byte-identical to the TS
// helper's zero-arg output by the parity test in mix-retry.test.ts; the
// quote-free / brace-grouping invariants are documented in the TS helper's
// header and apply here unchanged.

/** Total `mix deps.get` attempts (1 initial + MIX_DEPS_GET_BACKOFF_S.length). */
export const MIX_DEPS_GET_ATTEMPTS = 3;

/** Seconds to sleep before attempt 2, before attempt 3, … */
export const MIX_DEPS_GET_BACKOFF_S = [5, 20];

/** `mix deps.get` wrapped in the bounded retry, as one compound shell command. */
export function mixDepsGetShell() {
  const cmd = "mix deps.get";
  const chain = MIX_DEPS_GET_BACKOFF_S.reduce(
    (acc, wait, i) =>
      `${acc} || { echo loom-retry: ${cmd} failed, attempt ${i + 2} of ${MIX_DEPS_GET_ATTEMPTS} after ${wait}s; sleep ${wait}; ${cmd}; }`,
    cmd,
  );
  return `{ ${chain}; }`;
}

/**
 * The `mix local.hex` / `mix local.rebar` INSTALL, each wrapped in the same
 * bounded retry — twin of `mixLocalInstall()` in the TS helper, parity-pinned
 * alongside `mixDepsGetShell()` in mix-retry.test.ts.
 *
 * Added after the pairwise elixir leg lost 17 of 25 cases to this one
 * un-retried call timing out against builds.hex.pm under concurrent load.
 */
export function mixLocalInstallShell() {
  const wrap = (cmd) => {
    const chain = MIX_DEPS_GET_BACKOFF_S.reduce(
      (acc, wait, i) =>
        `${acc} || { echo loom-retry: ${cmd} failed, attempt ${i + 2} of ${MIX_DEPS_GET_ATTEMPTS} after ${wait}s; sleep ${wait}; ${cmd}; }`,
      cmd,
    );
    return `{ ${chain}; }`;
  };
  return `${wrap("mix local.hex --force")} && ${wrap("mix local.rebar --force")}`;
}
