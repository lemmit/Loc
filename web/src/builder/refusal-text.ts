// The PURE half of the builder write-back guard: the wording and the shapes,
// with no React import.
//
// Split out of `refusal.tsx` because the root vitest project — which is where
// `test/playground/*` runs — installs only the repo's own dependencies.  A
// test that reached the message through the `.tsx` pulled `react` in from
// `web/node_modules`, which exists on a developer machine and NOT on the CI
// shard, so `palette-blockers.test.ts` passed locally and failed on `main`'s
// runner with "Cannot find package 'react'".  Anything a headless test needs
// belongs on this side of the line; `refusal.tsx` re-exports it so no call
// site had to change.

export const REFUSAL_MESSAGE = "Apply produced invalid source — not written";

/** Why a write was refused, in words the line can show. */
export const REFUSAL_WHY = {
  /** The helper returned null — nothing to splice (the target wasn't found,
   *  or the edit had no legal placement). */
  noEdit: "the edit could not be produced — nothing was written",
  /** The candidate exists but the parser rejects it. */
  noParse: "the rewrite would not parse — not written",
} as const;

export interface RefusalDetail {
  /** The construct / action the user was editing — "aggregate Order",
   *  "field total", "+ Repository". */
  what: string;
  why: string;
  /** The source at the time of the refusal and the rejected candidate, when
   *  there was one — drives *Show candidate*. */
  before?: string;
  candidate?: string;
}

/** The message a refusal renders — exported so tests can pin the wording
 *  without a DOM. */
export function refusalMessage(detail: RefusalDetail | null): string {
  if (!detail) return REFUSAL_MESSAGE;
  return `${detail.what}: ${detail.why}`;
}
