// ---------------------------------------------------------------------------
// Backend package manifest (see docs/packaging-split.md).
//
// The small, declarative descriptor a backend package ships so the
// core can resolve `platform: node` / `platform: "hono@v4"`
// *automagically* without statically importing every backend.
//
// Today this is paired with an in-tree discovery seam (backends are
// still bundled; the static registry is the fallback — byte-identical).
// The end goal promotes this object to a real `loom` key in each
// backend package's `package.json`, with the resolver reading the
// consuming project's dependency closure instead of the in-tree set.
//
// `family` + `loomVersion` are exactly the two halves
// `parseBuiltinPlatformRef` splits a `hono@v4` ref into.  Keep this
// shape minimal — it is a public contract; additive fields are a
// minor change, shape changes are a breaking ABI bump every backend
// package must republish for (mirrors the `PlatformSurface`
// contract policy).
// ---------------------------------------------------------------------------

export interface LoomBackendManifest {
  /** Discriminates backend packages from future design-pack
   *  packages discovered through the same mechanism. */
  readonly kind: "backend";
  /** The `platform:` bareword this package provides (`"node"`). */
  readonly family: string;
  /** The `@vN` pin segment (`"v4"`).  `family@loomVersion` is the
   *  canonical identity; the npm package version is independent
   *  (release cadence) and intentionally not encoded here. */
  readonly loomVersion: string;
  /** SemVer range of the `PlatformSurface` contract this package
   *  was built against.  The resolver refuses a backend whose
   *  range doesn't satisfy the running core — a loud early error
   *  instead of a deep crash once packages ship separately. */
  readonly core: string;
}

/** The `PlatformSurface` contract version `@loom/core` currently
 *  publishes.  Bump the major when `surface.ts` changes shape
 *  (every backend package must then republish against the new
 *  range); minor for additive, backward-compatible fields. */
export const PLATFORM_SURFACE_CONTRACT = "1.0.0";
