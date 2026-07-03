// ---------------------------------------------------------------------------
// Backend package manifest (see docs/packaging-split.md).
//
// The small, declarative descriptor a backend package ships so the
// core can resolve `platform: node` / `platform: "node@v4"`
// *automagically* without statically importing every backend.
//
// Today this is paired with an in-tree discovery seam (backends are
// still bundled; the static registry is the fallback — byte-identical).
// The end goal promotes this object to a real `loom` key in each
// backend package's `package.json`, with the resolver reading the
// consuming project's dependency closure instead of the in-tree set.
//
// `family` + `loomVersion` are exactly the two halves
// `parseBuiltinPlatformRef` splits a `node@v4` ref into.  Keep this
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

/** Parse `"1.2.3"` (ignoring any `-prerelease` / `+build` suffix) into a
 *  `[major, minor, patch]` triple, or `null` when it isn't a `x.y.z`
 *  version. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Does concrete `version` satisfy the manifest `range`?  Supports the range
 *  forms Loom backend/design-pack manifests actually use — an exact version,
 *  a caret (`^1.2.3`), a tilde (`~1.2.3`), a single comparator
 *  (`>=`/`>`/`<=`/`<`/`=`), and the wildcards `*` / `x` / `""`.  A range it
 *  cannot parse is treated as UNsatisfied (the caller warns + skips), so an
 *  unreadable pin fails closed rather than silently loading an incompatible
 *  backend.  Deliberately not a full semver implementation — the gate only
 *  ever compares a manifest range against the single running
 *  `PLATFORM_SURFACE_CONTRACT`. */
export function coreRangeSatisfies(range: string, version: string): boolean {
  const ver = parseVersion(version);
  if (!ver) return false;
  const r = range.trim();
  if (r === "" || r === "*" || r === "x" || r === "X") return true;

  if (r.startsWith("^") || r.startsWith("~")) {
    const base = parseVersion(r.slice(1));
    if (!base) return false;
    if (cmp(ver, base) < 0) return false; // must be at least the base
    if (r[0] === "^") {
      // Caret: same left-most non-zero component.  ^1.2.3 → [1.x], ^0.2.3
      // → [0.2.x], ^0.0.3 → [0.0.3].
      if (base[0] > 0) return ver[0] === base[0];
      if (base[1] > 0) return ver[0] === 0 && ver[1] === base[1];
      return ver[0] === 0 && ver[1] === 0 && ver[2] === base[2];
    }
    // Tilde: same major.minor (or same major when only `~1` given, but we
    // require x.y.z here).
    return ver[0] === base[0] && ver[1] === base[1];
  }

  const cmpMatch = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(r);
  if (!cmpMatch) return false;
  const op = cmpMatch[1] ?? "=";
  const base = parseVersion(cmpMatch[2]!);
  if (!base) return false;
  const c = cmp(ver, base);
  switch (op) {
    case "=":
      return c === 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    default:
      return false;
  }
}
