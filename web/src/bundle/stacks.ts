// ---------------------------------------------------------------------------
// Stack-driven bundler hints.
//
// Phase 0.5 PR B follow-up to the stack scaffold (PR A).  The bundler
// previously sniffed the React major out of the project's package.json
// to pick between v18 and v19 behaviours (PRs #151 / #152).  This file
// names those behaviours per *stack id* — the cross-cutting framework
// baseline the pack declares in `pack.json: { "stack": "vN" }`.
//
// Why a TypeScript module rather than reading `stacks/<id>/stack.json`:
// the JSON file lives in the toolchain repo and documents the stack;
// the bundler runs against an already-generated project that doesn't
// ship `stacks/`.  So the bundler can't read it at runtime.  Instead
// we mirror the bundler-relevant subset here in code that's compiled
// into the playground worker.  When a new stack lands, both files
// update together — same PR, same review.
//
// The bundler doesn't see `pack.json` either, but it does see the
// emitted `package.json` (via `harvestVersions`).  React's pinned
// range there is a reliable proxy for the stack: `^18.x` → v1,
// `^19.x` → v2.  `stackHintsForReactMajor` does that lookup.
// ---------------------------------------------------------------------------

export interface StackBundlerHints {
  /** Stack id this set of hints belongs to.  Carried for diagnostic
   *  logging and for `assertStacksCoverBundlerInputs` below. */
  id: string;

  /** When true, keep `import "react"` and `import "react-dom"`
   *  external in the emitted bundle and satisfy them via the
   *  iframe importmap.  When false, bundle them inline.
   *
   *  Stack v1 (React 18): true.  esm.sh's React-18 build dedupes
   *  cleanly through the importmap and the v18 RDC shim glues the
   *  rest together.
   *
   *  Stack v2 (React 19): **false**.  esm.sh resolves transitive
   *  React imports to a canonical path (`/react@19.2.6/...`) that
   *  the bundle can't easily route back through the importmap
   *  facade URL — even with `?external=react` on the react-dom
   *  fetch (PR #152's attempt), the live preview still hit
   *  `TypeError: dispatcher.getOwner is not a function`.  Inlining
   *  React keeps the entire runtime in one module graph: one
   *  `ReactSharedInternals`, one dispatcher, no two-Reacts class
   *  of error.  The bundle grows by ~200 KB minified; that's a
   *  perfectly fine cost for a known-good preview. */
  externalReactRuntime: boolean;

  /** When externalReactRuntime is true, the query string appended
   *  to the iframe importmap's react-dom URL.  Stack v1's value
   *  pins react-dom's resolution to the project's React major and
   *  produces a wrapper module that re-exports the dev build.
   *  Ignored for stack v2 (the importmap doesn't emit a
   *  react/react-dom entry there). */
  importmapReactDomQuery: (reactRange: string) => string;

  /** Whether to register the React-18 `react-dom/client` shim
   *  (`web/src/bundle/plugin.ts`'s `RDC_SHIM_NAMESPACE`).  v18 needs
   *  it to silence the `usingClientEntryPoint` deprecation warning;
   *  v19 dropped namespace forwarding entirely and the shim
   *  *introduces* the bug it was meant to prevent (see PR #151). */
  rdcShim: boolean;
}

const STACK_V1: StackBundlerHints = {
  id: "v1",
  externalReactRuntime: true,
  importmapReactDomQuery: (reactRange) =>
    `?dev=false&deps=react@${reactRange}`,
  rdcShim: true,
};

const STACK_V2: StackBundlerHints = {
  id: "v2",
  externalReactRuntime: false,
  importmapReactDomQuery: () => `?external=react&dev=false`,
  rdcShim: false,
};

export const STACKS: Record<string, StackBundlerHints> = {
  v1: STACK_V1,
  v2: STACK_V2,
};

/** Resolve stack hints from the React major declared in a project's
 *  `package.json`.  Used by the bundler — it sees the
 *  already-emitted package.json (via `harvestVersions`), not the
 *  pack manifest.  The React pin is a reliable proxy for the stack
 *  because the stack-package-deps partial is what supplied that pin
 *  in the first place.
 *
 *  Defaults to stack v1 when no `react` version was harvested
 *  (legacy mode, smoke scripts that build a stripped Hono-only
 *  project) — the v1 behaviour is the more conservative one and
 *  matches the pre-stacks default. */
export function stackHintsForReactMajor(
  reactRange: string | undefined,
): StackBundlerHints {
  if (!reactRange) return STACK_V1;
  const major = Number(/(\d+)/.exec(reactRange)?.[1] ?? "0");
  if (major >= 19) return STACK_V2;
  return STACK_V1;
}
