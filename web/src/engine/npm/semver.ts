// Semver range satisfaction for the npm-in-browser planner.
//
// `planInstall` reads each (transitive) dependency's package.json
// version range and picks the highest published version that
// satisfies it.  Real dependency trees use the full range grammar —
// `^`, `~`, `>=x <y`, `||`, hyphen (`a - b`), and `x`-ranges
// (`1.x`) — not just the caret pins the generator emits.  An
// over-permissive parser (the old "unknown → treat as highest")
// could pick a too-high major for a transitive dep that asked for
// `<2`, so this implements the common grammar precisely.
//
// Scope: stable releases only.  Prerelease/build metadata is
// stripped and prerelease versions are skipped by `maxSatisfying`
// (none of the stacks resolve to prereleases).  Range prereleases
// (`>=1.2.3-beta`) are not modelled.

export interface Sv {
  major: number;
  minor: number;
  patch: number;
}

export function parse(v: string): Sv | null {
  const m = /^[v=\s]*(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

export function cmp(a: Sv, b: Sv): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// A partial version: components are null when absent or wildcard
// (`x`/`X`/`*`).  `1.2.x` → {1,2,null}; `*` → {null,null,null}.
interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
}

function parsePartial(s: string): Partial | null {
  const t = s.trim().replace(/^[v=]/, "");
  if (t === "" || t === "*" || t === "x" || t === "X") {
    return { major: null, minor: null, patch: null };
  }
  const parts = t.split(".");
  const conv = (p: string | undefined): number | null => {
    if (p === undefined || p === "" || p === "x" || p === "X" || p === "*") return null;
    return /^\d+$/.test(p) ? +p : NaN;
  };
  const major = conv(parts[0]);
  const minor = conv(parts[1]);
  const patch = conv(parts[2]);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
  return { major, minor, patch };
}

const lower = (p: Partial): Sv => ({
  major: p.major ?? 0,
  minor: p.minor ?? 0,
  patch: p.patch ?? 0,
});

// Smallest version NOT in the partial's range (exclusive upper), or
// null when the partial is unbounded above (`*`, or a bare major).
function upperExclusive(p: Partial): Sv | null {
  if (p.major === null) return null;
  if (p.minor === null) return { major: p.major + 1, minor: 0, patch: 0 };
  if (p.patch === null) return { major: p.major, minor: p.minor + 1, patch: 0 };
  return { major: p.major, minor: p.minor, patch: p.patch + 1 };
}

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Bound {
  op: Exclude<Op, "=">;
  sv: Sv;
}

// Caret upper bound: lock the left-most non-zero specified component.
function caretUpper(p: Partial): Sv {
  const M = p.major ?? 0;
  if (M > 0 || p.minor === null) return { major: M + 1, minor: 0, patch: 0 };
  const m = p.minor;
  if (m > 0 || p.patch === null) return { major: 0, minor: m + 1, patch: 0 };
  return { major: 0, minor: 0, patch: (p.patch ?? 0) + 1 };
}

// Expand one whitespace-delimited comparator token into primitive
// bounds (`>=`/`>`/`<=`/`<`).  Returns [] for "any".
function expandToken(tok: string): Bound[] {
  if (tok === "" || tok === "*" || tok === "x" || tok === "X" || tok === "latest") {
    return [];
  }
  if (tok[0] === "^") {
    const p = parsePartial(tok.slice(1));
    if (!p) return INVALID;
    return [{ op: ">=", sv: lower(p) }, { op: "<", sv: caretUpper(p) }];
  }
  if (tok[0] === "~") {
    const p = parsePartial(tok.slice(1));
    if (!p) return INVALID;
    const up: Sv =
      p.minor === null
        ? { major: (p.major ?? 0) + 1, minor: 0, patch: 0 }
        : { major: p.major as number, minor: p.minor + 1, patch: 0 };
    return [{ op: ">=", sv: lower(p) }, { op: "<", sv: up }];
  }
  const opMatch = /^(>=|<=|>|<|=)/.exec(tok);
  const op = (opMatch?.[1] ?? "") as Op | "";
  const p = parsePartial(tok.slice(op.length));
  if (!p) return INVALID;
  switch (op) {
    case ">=":
      return [{ op: ">=", sv: lower(p) }];
    case ">": {
      const up = upperExclusive(p);
      // `>1.2.3` → strictly greater; `>1.2` → `>=1.3.0`.
      return p.patch !== null
        ? [{ op: ">", sv: lower(p) }]
        : up
          ? [{ op: ">=", sv: up }]
          : INVALID;
    }
    case "<":
      return [{ op: "<", sv: lower(p) }];
    case "<=": {
      const up = upperExclusive(p);
      return p.patch !== null
        ? [{ op: "<=", sv: lower(p) }]
        : up
          ? [{ op: "<", sv: up }]
          : [];
    }
    default: {
      // bare or `=`: an exact-or-partial range [lower, upperExclusive).
      const up = upperExclusive(p);
      const bs: Bound[] = [{ op: ">=", sv: lower(p) }];
      if (up) bs.push({ op: "<", sv: up });
      return bs;
    }
  }
}

const INVALID: Bound[] = [{ op: ">", sv: { major: Infinity, minor: 0, patch: 0 } }];

function testBound(v: Sv, b: Bound): boolean {
  const c = cmp(v, b.sv);
  switch (b.op) {
    case ">=": return c >= 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    case "<": return c < 0;
  }
}

// One AND-clause (space-separated comparators, incl. hyphen ranges)
// → bounds the version must satisfy together.
function clauseBounds(clause: string): Bound[] {
  const c = clause.trim();
  if (c === "") return [];
  const hy = c.split(/\s+-\s+/);
  if (hy.length === 2) {
    const lo = parsePartial(hy[0]);
    const hi = parsePartial(hy[1]);
    if (!lo || !hi) return INVALID;
    const up = upperExclusive(hi);
    const bs: Bound[] = [{ op: ">=", sv: lower(lo) }];
    // `a - 2.3.4` is inclusive of the full hi; `a - 2.3` → `<2.4.0`.
    if (hi.patch !== null) bs.push({ op: "<=", sv: lower(hi) });
    else if (up) bs.push({ op: "<", sv: up });
    return bs;
  }
  return c.split(/\s+/).flatMap(expandToken);
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const orClauses = range.trim().split(/\s*\|\|\s*/);
  return orClauses.some((clause) => clauseBounds(clause).every((b) => testBound(v, b)));
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
