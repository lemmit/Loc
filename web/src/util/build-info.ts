// ---------------------------------------------------------------------------
// Build identity for the deployed playground.
//
// GitHub Pages overwrites the site on every deploy, and the bundle ships
// minified with no sourcemap (`vite.config.ts` sets no `build.sourcemap`).
// A crash report therefore carries minified frames whose only resolution key
// is *which build produced them* — rebuild that SHA and the frames mean
// something again.  Without it a stack is unresolvable prose.
//
// The value is injected at bundle time by a `define` in `web/vite.config.ts`
// (from `GITHUB_SHA` in CI, `git rev-parse` locally, `"dev"` when neither is
// available).  This module is the ONLY reader, and it is deliberately
// react-free / DOM-free so the crash-report assembler that consumes it stays
// unit-testable from the root vitest suite (which has no `web/node_modules`).
// ---------------------------------------------------------------------------

export interface BuildInfo {
  /** Short commit SHA of the deploy, or `"dev"` when unknown. */
  sha: string;
  /** ISO timestamp of the bundle build; `""` when unknown. */
  builtAt: string;
}

/** What a build with no injected identity reports. */
export const DEV_BUILD: BuildInfo = { sha: "dev", builtAt: "" };

// Injected by vite `define`.  Declared (not imported) so this module still
// evaluates under plain node/vitest, where the identifier does not exist —
// `typeof` on an undeclared binding is the one safe probe.
declare const __LOOM_BUILD__: BuildInfo | undefined;

/** The identity of the running bundle.  Never throws. */
export function buildInfo(): BuildInfo {
  try {
    if (typeof __LOOM_BUILD__ !== "undefined" && __LOOM_BUILD__) {
      const { sha, builtAt } = __LOOM_BUILD__;
      return {
        sha: typeof sha === "string" && sha ? sha : DEV_BUILD.sha,
        builtAt: typeof builtAt === "string" ? builtAt : "",
      };
    }
  } catch {
    // Some bundlers rewrite the identifier into a throwing accessor; a
    // missing build id must never be the thing that breaks a crash report.
  }
  return DEV_BUILD;
}

/** `abc123def (2026-07-30T…)` — the one-line form used in reports. */
export function formatBuild(b: BuildInfo): string {
  return b.builtAt ? `${b.sha} (${b.builtAt})` : b.sha;
}
