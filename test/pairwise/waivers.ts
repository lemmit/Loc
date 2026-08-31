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
  // EMPTY, and that is the target state.  F1 (`shape: document` × `policy
  // { allow … }` — the `authz-filter` sentinel reaching the generic expression
  // dispatcher and blowing `renderExprWith`'s invariant) was the only entry;
  // #2527 fixed it by desugaring the sentinel to ordinary `ExprIR` for the
  // in-app document path (`src/generator/_expr/authz-filter-inapp.ts`), and the
  // entry is deleted here.
  //
  // It outlived its fix by weeks for a structural reason worth recording: this
  // leg had NO CI workflow, so the stale-waiver ratchet — which fails the gate
  // the moment a waived crossing stops crashing — never got to fire.  A ratchet
  // that nothing runs is a comment.  `pairwise.yml` now runs it.
  //
  // NOTE — there is deliberately no entry for `dapper × policy allow`.  An
  // early build of this harness recorded one, because it ran phases ①–④ only:
  // without phase ⑦ the crossing reached codegen and threw.  With
  // `validateLoomModel` wired in, it is refused by name
  // (`loom.dapper-unsupported`), which is the contract being honoured, not a
  // bug.  The stale-waiver ratchet is what surfaced the mistake — the entry
  // stopped matching and the gate said so.  Left here as the worked example of
  // why the register ratchets in both directions.
];
