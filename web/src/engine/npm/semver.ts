// Minimal semver — just enough for the curated stacks the Loom
// generator emits (Phase B3).
//
// Generated package.json pins are `^`-ranges (e.g. "hono":"^4.12.0");
// transitive deps add `~`, exact, and `*`.  We support those forms
// plus a lone `>=`.  Prerelease/build metadata is ignored (none of
// the pinned deps resolve to prereleases).  Anything unrecognised is
// treated as "any" and the highest stable version wins — a loud
// console.warn flags it so B4 can tighten if a real dep needs more.

export interface Sv {
  major: number;
  minor: number;
  patch: number;
}

export function parse(v: string): Sv | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

export function cmp(a: Sv, b: Sv): number {
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch
  );
}

function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false; // skip prerelease-only / malformed
  const r = range.trim();
  if (r === "" || r === "*" || r === "x" || r === "latest") return true;

  if (r.startsWith("^")) {
    const b = parse(r.slice(1));
    if (!b) return false;
    if (cmp(v, b) < 0) return false;
    // caret: lock the left-most non-zero component.
    if (b.major > 0) return v.major === b.major;
    if (b.minor > 0) return v.major === 0 && v.minor === b.minor;
    return v.major === 0 && v.minor === 0 && v.patch === b.patch;
  }
  if (r.startsWith("~")) {
    const b = parse(r.slice(1));
    if (!b) return false;
    return cmp(v, b) >= 0 && v.major === b.major && v.minor === b.minor;
  }
  if (r.startsWith(">=")) {
    const b = parse(r.slice(2));
    return b ? cmp(v, b) >= 0 : false;
  }
  const exact = parse(r);
  if (exact) return cmp(v, exact) === 0;

  // eslint-disable-next-line no-console
  console.warn(`[npm-in-browser] unsupported range "${range}" — treating as any`);
  return true;
}

/** Highest stable version in `versions` satisfying `range`, or null. */
export function maxSatisfying(
  versions: string[],
  range: string,
): string | null {
  let best: { v: string; sv: Sv } | null = null;
  for (const v of versions) {
    if (v.includes("-")) continue; // skip prereleases
    if (!satisfies(v, range)) continue;
    const sv = parse(v);
    if (!sv) continue;
    if (!best || cmp(sv, best.sv) > 0) best = { v, sv };
  }
  return best?.v ?? null;
}
