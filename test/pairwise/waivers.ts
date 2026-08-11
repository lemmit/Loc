// ---------------------------------------------------------------------------
// M-T9.29 — the pairwise-combination corpus: the RATCHETING WAIVER REGISTER.
//
// Every entry below is a KNOWN, RECORDED finding: a crossing where the
// pipeline throws instead of answering.  The register exists so the gate can
// be green today (it names the debt) while failing loudly on anything NEW —
// and it RATCHETS in both directions:
//
//   - a crossing that crashes with NO matching waiver fails the gate  (new bug)
//   - a waiver that matched NOTHING in the run fails the gate         (stale)
//
// The second direction is the one that makes this a register rather than a
// suppression list: when someone fixes a crossing, the gate tells them to
// delete its entry in the same PR.  CLAUDE.md's waiver rule, applied here.
//
// Each entry cites `docs/audits/pairwise-corpus-findings-2026-08.md`, which
// carries the diagnosis (file:line, why it throws, what the fix would be).
// ---------------------------------------------------------------------------

import type { PairwiseCase } from "./axes.js";

/** `*` matches any value of that axis; a `|`-separated list matches any of. */
export interface Waiver {
  readonly platform: string;
  readonly persistence: string;
  readonly capability: string;
  readonly shape: string;
  readonly authz: string;
  /** Findings-register id (`F1`, `F2`, …) + one-line summary. */
  readonly reason: string;
}

function matches(pattern: string, value: string): boolean {
  return pattern === "*" || pattern.split("|").includes(value);
}

export function waiverFor(
  w: readonly Waiver[],
  c: PairwiseCase,
  platform: string,
): Waiver | undefined {
  return w.find(
    (x) =>
      matches(x.platform, platform) &&
      matches(x.persistence, c.persistence) &&
      matches(x.capability, c.capability) &&
      matches(x.shape, c.shape) &&
      matches(x.authz, c.authz),
  );
}

export const GENERATION_WAIVERS: readonly Waiver[] = [
  {
    // F1 — `shape: document` × `policy { allow … }`: the read ladder's
    // `authz-filter` ExprIR reaches the GENERIC expression dispatcher instead
    // of the backend's query-filter translator, and
    // `src/generator/_expr/target.ts` throws its internal invariant.  Fires on
    // the three backends whose document read path renders the filter through
    // `renderExprWith`; .NET/EF and Elixir do not, so they generate.
    platform: "node|java|python",
    persistence: "*",
    capability: "*",
    shape: "document",
    authz: "policyAllow",
    reason:
      "F1 — document shape × policy allow ladder: 'authz-filter' hits the generic ExprIR dispatcher and throws (renderExprWith invariant)",
  },
  {
    // F2 — dapper × `policy { allow … }`: the Dapper SQL translator refuses
    // the capability filter by THROWING out of phase ⑧ with a user-facing
    // message.  Sibling of #2492 (`policy { deny }` × dapper), fixed as
    // M-T6.29 — that fix covered the deny sentinel, not the allow ladder, so
    // the class is still live one rung over.
    platform: "dotnet",
    persistence: "dapper",
    capability: "*",
    shape: "relational|embedded",
    authz: "policyAllow",
    reason:
      "F2 — dapper × policy allow ladder: codegen throws 'outside the Dapper SQL subset' instead of raising a loom.* diagnostic",
  },
];
