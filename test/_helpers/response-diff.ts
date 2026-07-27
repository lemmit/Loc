// ---------------------------------------------------------------------------
// Cross-backend response differential (M-T9.11, slice a).
//
// The runtime-value companion to test/_helpers/openapi-normalize.ts: that one
// diffs the OpenAPI *spec* shape across backends; this one diffs the JSON a
// booted backend actually *returns*.  The spec-diff is blind to values, and
// the RS-rule registry (docs/conformance-semantics.md) is a reactive, hand-
// written allowlist — so an *unnamed* runtime divergence (enum casing,
// []-vs-null, a leaked field) sails through both.  This module is the sensor
// that surfaces those proactively.
//
// A `normalized semantic diff, NOT a byte diff`: the same POST yields a fresh
// uuid and a millisecond-drifted timestamp on every backend, so a byte compare
// would be 100% noise.  normalizeBody() collapses the legitimately-varying
// LEAF VALUES to canonical tokens (`<uuid>`, `<timestamp>`) while KEEPING the
// keys — so a differing timestamp value is silenced, but a *missing*
// timestamp key still surfaces as a key-set divergence.  What survives the
// normalization is the contract: field names, enum casing, absence shape, list
// membership, decimal value.
//
// Pure functions only — no I/O.  Fast-suite tested (response-diff.test.ts);
// the booted-backend runner (test/behavioral/differential.mjs) is the thin
// wrapper, exactly as e2e.test.ts wraps openapi-normalize.
// ---------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A single point of disagreement between two backends' responses, at a JSON
 *  path, bucketed by the KIND of divergence — the report groups by `kind` so a
 *  systemic class (every enum mis-cased) reads as one bucket, not N rows. */
export interface Divergence {
  readonly path: string;
  readonly kind: DivergenceKind;
  readonly a: Json | undefined;
  readonly b: Json | undefined;
}

export type DivergenceKind =
  /** both strings, equal case-insensitively, differ in case — `pending` vs `PENDING` */
  | "enum-casing"
  /** one side null, the other an empty collection/absent — `[]` vs `null` */
  | "null-vs-empty"
  /** a key present on one side, absent on the other (a leaked/dropped field) */
  | "key-set"
  /** array vs object vs scalar — a structural shape break */
  | "type-mismatch"
  /** same-length arrays, same element multiset, different order */
  | "ordering"
  /** scalar values genuinely differ (and it isn't just casing) */
  | "value";

export interface NormalizeOpts {
  /** Leaf VALUES matching these are collapsed to a canonical token so their
   *  per-run variance doesn't register as a divergence.  Keys are always kept. */
  readonly volatileValue?: readonly VolatileValueRule[];
  /** Object KEYS whose value is volatile regardless of its shape (e.g. `id`,
   *  `traceId`).  Value collapses to `<volatile:key>`; the key stays. */
  readonly volatileKey?: (key: string) => boolean;
}

export interface VolatileValueRule {
  readonly token: string;
  readonly test: (s: string) => boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 datetime, tolerant of the precision/offset spellings that legitimately
// differ per backend (`…Z`, `…+00:00`, `.000Z`, no-fraction) — the whole point
// is that these normalize to ONE token so the value stops being a divergence.
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The default allowlist — uuids and ISO timestamps by value-shape, plus the
 *  conventional volatile key names.  A real gate tunes this; the point of the
 *  registry is that every entry is an EXPLICIT reviewed decision, not a silent
 *  filter (cf. the openapi-normalize `isInfraPath` note). */
export const DEFAULT_NORMALIZE: NormalizeOpts = {
  volatileValue: [
    { token: "<uuid>", test: (s) => UUID_RE.test(s) },
    { token: "<timestamp>", test: (s) => ISO_DT_RE.test(s) },
  ],
  volatileKey: (k) => k === "id" || /Id$/.test(k) || k === "traceId",
};

/** Collapse legitimately-varying leaf values to tokens and sort object keys, so
 *  two backends' responses become structurally comparable.  Keys are never
 *  dropped — absence is contract, so it must remain visible to diffBodies. */
export function normalizeBody(value: Json, opts: NormalizeOpts = DEFAULT_NORMALIZE): Json {
  const walk = (v: Json, volatileByKey: boolean): Json => {
    if (v === null) return null;
    if (typeof v === "string") {
      if (volatileByKey) return "<volatile:key>";
      for (const rule of opts.volatileValue ?? []) if (rule.test(v)) return rule.token;
      return v;
    }
    if (typeof v !== "object") return v; // number | boolean
    if (Array.isArray(v)) return v.map((e) => walk(e, false));
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = walk(v[k], !!opts.volatileKey?.(k));
    }
    return out;
  };
  return walk(value, false);
}

const isObj = (v: Json | undefined): v is { [k: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isEmptyColl = (v: Json | undefined): boolean =>
  (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

/** Diff two ALREADY-normalized bodies, producing typed, path-tagged
 *  divergences.  Recurses objects/arrays; classifies leaf mismatches into the
 *  DivergenceKind buckets so the report reads as a taxonomy, not a dump. */
export function diffBodies(a: Json, b: Json, path = "$"): Divergence[] {
  // null-vs-empty: [] / {} on one side, null on the other — the RS-8/absence class.
  if ((a === null && isEmptyColl(b)) || (b === null && isEmptyColl(a))) {
    return [{ path, kind: "null-vs-empty", a, b }];
  }
  const shape = (v: Json): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  if (shape(a) !== shape(b)) return [{ path, kind: "type-mismatch", a, b }];

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [{ path, kind: "value", a, b }];
    // same length, same multiset, different order → ordering (a real drop-in break)
    if (
      a.length > 0 &&
      JSON.stringify([...a].map(stable).sort()) === JSON.stringify([...b].map(stable).sort()) &&
      JSON.stringify(a.map(stable)) !== JSON.stringify(b.map(stable))
    ) {
      return [{ path, kind: "ordering", a, b }];
    }
    return a.flatMap((_, i) => diffBodies(a[i], b[i], `${path}[${i}]`));
  }

  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => {
      const inA = k in a;
      const inB = k in b;
      if (inA !== inB) {
        return [
          {
            path: `${path}.${k}`,
            kind: "key-set",
            a: inA ? a[k] : undefined,
            b: inB ? b[k] : undefined,
          },
        ];
      }
      return diffBodies(a[k], b[k], `${path}.${k}`);
    });
  }

  if (a === b) return [];
  if (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()) {
    return [{ path, kind: "enum-casing", a, b }];
  }
  return [{ path, kind: "value", a, b }];
}

const stable = (v: Json): string => JSON.stringify(v);

/** One backend's captured collection reads, keyed by normalized endpoint path. */
export interface BackendCapture {
  readonly backend: string;
  /** path (e.g. `/products`) → the normalized 200 body */
  readonly reads: Readonly<Record<string, Json>>;
}

export interface PairDiff {
  readonly a: string;
  readonly b: string;
  readonly path: string;
  readonly divergences: readonly Divergence[];
}

/** Pairwise-diff every backend against every other (the all-pairs shape of the
 *  openapi parity harness) over their shared endpoints.  Only endpoints present
 *  in BOTH members of a pair are compared. */
export function diffAllPairs(captures: readonly BackendCapture[]): PairDiff[] {
  const out: PairDiff[] = [];
  for (let i = 0; i < captures.length; i++) {
    for (let j = i + 1; j < captures.length; j++) {
      const A = captures[i];
      const B = captures[j];
      for (const path of Object.keys(A.reads).sort()) {
        if (!(path in B.reads)) continue;
        const divergences = diffBodies(A.reads[path], B.reads[path], "$");
        if (divergences.length) out.push({ a: A.backend, b: B.backend, path, divergences });
      }
    }
  }
  return out;
}

/** Render the bucketed, non-blocking markdown report — grouped by
 *  DivergenceKind so a systemic class is one heading, not scattered rows. */
export function renderReport(pairs: readonly PairDiff[]): string {
  const total = pairs.reduce((n, p) => n + p.divergences.length, 0);
  if (total === 0) {
    return "# Cross-backend response differential\n\n✅ No divergences — all backends agree on every shared collection read.\n";
  }
  const byKind = new Map<DivergenceKind, string[]>();
  for (const p of pairs) {
    for (const d of p.divergences) {
      const row = `- \`${p.a}\` ↔ \`${p.b}\` at \`${p.path}${d.path.slice(1)}\` — ${JSON.stringify(d.a)} ≠ ${JSON.stringify(d.b)}`;
      const bucket = byKind.get(d.kind) ?? [];
      bucket.push(row);
      byKind.set(d.kind, bucket);
    }
  }
  const lines = [
    "# Cross-backend response differential",
    "",
    `⚠️ **${total}** divergence(s) across **${pairs.length}** backend-pair × endpoint cells.`,
    "",
    "> Non-blocking report (M-T9.11 slice a). Each bucket is a candidate RS-rule:",
    "> pick the correct side, name it in `test/conformance/semantics-rules.ts`, fix the other backend(s).",
    "",
  ];
  const ORDER: DivergenceKind[] = [
    "type-mismatch",
    "key-set",
    "null-vs-empty",
    "enum-casing",
    "ordering",
    "value",
  ];
  for (const kind of ORDER) {
    const rows = byKind.get(kind);
    if (!rows?.length) continue;
    lines.push(`## ${kind} (${rows.length})`, "", ...rows, "");
  }
  return `${lines.join("\n")}\n`;
}
