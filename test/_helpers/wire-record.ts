// ---------------------------------------------------------------------------
// Cross-backend runtime wire differential — the per-request recorder + the
// canonical-golden differ (M-T9.11 slices b + c).
//
// Slice (a) (`response-diff.ts`) proved the sensor works but ran ALL-PAIRS over
// the full five-backend compose stack: nightly-shaped, and — the lesson the
// first report taught — pairwise disagreement alone names no WINNER.  RS-11 is
// the proof: three backends agreed on `version: 0` and were all three WRONG
// (the `versioned` capability declares `version: int token = 1`), so a
// majority vote would have broken the one correct backend.
//
// This module is the answer to both problems at once:
//
//   1. ORACLE.  Instead of diffing backends against each other, each backend is
//      diffed against a COMMITTED canonical recording — `wire-golden/<case>.json`
//      — which is a reviewed answer key.  A wire change becomes a visible diff
//      on a checked-in file that a human approves.
//   2. PER-PR, AT ZERO NEW BOOT COST.  If A ≡ golden and B ≡ golden then A ≡ B,
//      so the N-way differential decomposes into N INDEPENDENT one-way gates —
//      each of which rides a backend's ALREADY-per-PR behavioral workflow
//      (`behavioral-e2e*.yml`) instead of needing its own compose boot.
//
// Alignment is free: every `test/behavioral/run-*.mjs` dispatches the SAME
// emitted api suite through ONE fetch chokepoint, and `runTests` is strictly
// sequential — so request N is the same code path on every backend and the
// SEQUENCE ORDINAL is a stable key (ids are not — they differ per run, which is
// exactly what defeated slice (a)'s index alignment on derived `seqTag`).
//
// Pure functions only — no I/O, no fs.  Fast-suite tested (wire-record.test.ts);
// `test/behavioral/wire-differential.mjs` is the thin booted-runner wrapper.
// ---------------------------------------------------------------------------

import {
  DEFAULT_NORMALIZE,
  type DivergenceKind,
  diffBodies,
  type Json,
  type NormalizeOpts,
  normalizeBody,
} from "./response-diff.js";

export type { Json } from "./response-diff.js";

/** One recorded request/response pair, already normalized — the unit the golden
 *  stores and the differ compares.  `seq` is the ordinal within the case's
 *  suite run (0-based); `path` is TEMPLATED (volatile segments → `{id}`) so a
 *  per-run uuid in the URL isn't mistaken for a contract difference. */
export interface WireEntry {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: Json;
}

/** One backend's full recording for one case. */
export interface WireRecording {
  /** Case name — a corpus feature id or a `systems/*.ddd` basename. */
  readonly case: string;
  readonly backend: string;
  readonly entries: readonly WireEntry[];
}

/** The committed answer key.  `oracle` records WHICH backend the bytes were
 *  captured from and WHY that backend is the reference for this case — the
 *  golden is a reviewed decision, not "whatever ran first". */
export interface WireGolden {
  readonly case: string;
  readonly oracle: string;
  readonly entries: readonly WireEntry[];
}

// ── path templating ────────────────────────────────────────────────────────

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_SEG = /^\d+$/;
// A ULID/base32-ish or long opaque token — id-shaped enough that a per-run
// value in a path segment would otherwise read as a route difference.
const OPAQUE_SEG = /^[0-9A-Za-z_-]{20,}$/;

/** True when a URL path segment is a per-run identifier rather than a route
 *  literal.  Deliberately conservative — a false positive silently merges two
 *  distinct routes, so only uuid / all-digits / long-opaque qualify. */
export function isVolatileSegment(seg: string): boolean {
  return UUID_SEG.test(seg) || INT_SEG.test(seg) || OPAQUE_SEG.test(seg);
}

/** `http://x/api/products/6f0f…?page=2` → `/api/products/{id}?page=2`.
 *  Host/port are dropped (each backend listens on its own), volatile segments
 *  collapse to `{id}`, query params sort by key and their values run through the
 *  same volatile-VALUE normalization the bodies use. */
export function templatePath(url: string, opts: NormalizeOpts = DEFAULT_NORMALIZE): string {
  let pathname: string;
  let search: string;
  try {
    const u = new URL(url, "http://loom.invalid");
    pathname = u.pathname;
    search = u.search;
  } catch {
    const q = url.indexOf("?");
    pathname = q === -1 ? url : url.slice(0, q);
    search = q === -1 ? "" : url.slice(q);
  }
  const templated = pathname
    .split("/")
    .map((seg) => (isVolatileSegment(seg) ? "{id}" : seg))
    .join("/");
  if (!search) return templated;
  const params = [...new URLSearchParams(search).entries()]
    .map(([k, v]) => {
      for (const rule of opts.volatileValue ?? [])
        if (rule.test(v)) return [k, rule.token] as const;
      return [k, opts.volatileKey?.(k) ? "<volatile:key>" : v] as const;
    })
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`);
  return params.length ? `${templated}?${params.join("&")}` : templated;
}

/** The wire gate's normalization: the shared defaults PLUS a rule for
 *  path-shaped strings.  An RFC 7807 problem body carries
 *  `instance: "/api/listings/<uuid>/discontinue"` — a per-run value embedded in
 *  a ROUTE.  The default value-shape rules don't fire (it isn't a bare uuid), so
 *  without this the error golden could never match twice; collapsing the whole
 *  string to one token would instead discard the route, which is the part a
 *  divergence actually shows up in.  Templating keeps the route and drops the
 *  id, exactly as the request `path` is templated. */
export const WIRE_NORMALIZE: NormalizeOpts = {
  ...DEFAULT_NORMALIZE,
  volatileValue: [
    ...(DEFAULT_NORMALIZE.volatileValue ?? []),
    {
      token: "<path>",
      test: (s) => s.startsWith("/") && s.split("/").some(isVolatileSegment),
      rewrite: (s) =>
        s
          .split("/")
          .map((seg) => (isVolatileSegment(seg) ? "{id}" : seg))
          .join("/"),
    },
  ],
};

/** Build one normalized `WireEntry` from a raw dispatch result.  A non-JSON body
 *  (empty 204, a text/plain error) is kept as a string so the differ still sees
 *  it; JSON is parsed then normalized (uuids/timestamps → tokens, keys sorted,
 *  keys NEVER dropped — absence is contract). */
export function toWireEntry(
  seq: number,
  method: string,
  url: string,
  status: number,
  bodyText: string,
  opts: NormalizeOpts = WIRE_NORMALIZE,
): WireEntry {
  let body: Json;
  const trimmed = bodyText.trim();
  if (trimmed === "") {
    body = "";
  } else {
    try {
      body = normalizeBody(JSON.parse(trimmed) as Json, opts);
    } catch {
      body = trimmed;
    }
  }
  return { seq, method: method.toUpperCase(), path: templatePath(url, opts), status, body };
}

// ── the differ ─────────────────────────────────────────────────────────────

/** Divergence kinds beyond the body-level ones `response-diff` classifies:
 *  the recording can also disagree on HOW MANY requests were made, on WHICH
 *  request was made at an ordinal, or on the response STATUS. */
export type RecordDivergenceKind = "request-count" | "request" | "status" | DivergenceKind;

export interface RecordDivergence {
  readonly seq: number;
  /** `GET /api/products` — the request the divergence sits on, for the report. */
  readonly request: string;
  readonly kind: RecordDivergenceKind;
  /** JSON path within the body (`$…`), or `$` for whole-entry divergences. */
  readonly path: string;
  readonly golden: Json | undefined;
  readonly actual: Json | undefined;
}

/** Seq-aligned diff of an actual recording against the golden.
 *
 *  A request-count or per-ordinal request mismatch SHORT-CIRCUITS the rest of
 *  the comparison for that recording: once the sequences desynchronize, every
 *  later ordinal compares unrelated requests and the report becomes noise (the
 *  contamination that made slice (a)'s `seqTag` finding unreadable). */
export function diffRecording(
  golden: readonly WireEntry[],
  actual: readonly WireEntry[],
): RecordDivergence[] {
  const out: RecordDivergence[] = [];
  if (golden.length !== actual.length) {
    return [
      {
        seq: -1,
        request: "(recording)",
        kind: "request-count",
        path: "$",
        golden: golden.length,
        actual: actual.length,
      },
    ];
  }
  for (let i = 0; i < golden.length; i++) {
    const g = golden[i];
    const a = actual[i];
    const label = `${g.method} ${g.path}`;
    if (g.method !== a.method || g.path !== a.path) {
      out.push({
        seq: i,
        request: label,
        kind: "request",
        path: "$",
        golden: `${g.method} ${g.path}`,
        actual: `${a.method} ${a.path}`,
      });
      // Desynchronized — everything after this ordinal is meaningless.
      return out;
    }
    if (g.status !== a.status) {
      out.push({
        seq: i,
        request: label,
        kind: "status",
        path: "$",
        golden: g.status,
        actual: a.status,
      });
    }
    for (const d of diffBodies(g.body, a.body)) {
      out.push({ seq: i, request: label, kind: d.kind, path: d.path, golden: d.a, actual: d.b });
    }
  }
  return out;
}

// ── waivers ────────────────────────────────────────────────────────────────

/** An EXPLICIT, reviewed exception: "this backend is known to diverge here, and
 *  here is why + what closes it."  Same contract as the corpus `COMPILE_SKIP`
 *  maps — a gap is a line of code someone signed, never a silent filter.
 *
 *  `path` is a glob over the divergence's body path with array indices already
 *  collapsed to `[*]`:  `**.version` (suffix, any depth) · `$[*].amount`
 *  (exact, any index) · `$.total` (exact). */
export interface WireWaiver {
  /** Backends this waiver applies to.  A divergence on any OTHER backend gates. */
  readonly backends: readonly string[];
  /** Cases it applies to; omit for every case. */
  readonly cases?: readonly string[];
  /** Glob over the request label (`"POST /api/*"`), where `*` matches exactly
   *  ONE path segment.  Omit for every request.  Needed because some
   *  divergences are scoped by the ENDPOINT rather than by a body path — e.g.
   *  "this backend over-returns on every create POST", where the extra keys
   *  are different field names on every aggregate. */
  readonly request?: string;
  /** Body path glob; `"**"` matches any path (use only with a `request` or
   *  `kinds` scope, never on its own). */
  readonly path: string;
  /** Divergence kinds it covers; omit for every kind at that path. */
  readonly kinds?: readonly RecordDivergenceKind[];
  /** Why this is tolerated AND what closes it — an RS-rule id or a mission id. */
  readonly reason: string;
}

/** Array indices → `[*]`, so one waiver covers every element of a collection. */
export function generalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, "[*]");
}

/** Glob match for waiver paths.  `**` matches any path; `**.x` matches `x` at
 *  ANY depth; otherwise the pattern must equal the generalized path exactly. */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "**") return true;
  const p = generalizePath(path);
  if (pattern.startsWith("**.")) {
    const suffix = `.${pattern.slice(3)}`;
    return p.endsWith(suffix);
  }
  return pattern === p;
}

/** Glob match for a request label (`"POST /api/products"`).  `*` matches
 *  exactly ONE path segment, so `POST /api/*` covers every collection create
 *  but NOT `POST /api/orders/{id}/confirm`. */
export function requestMatches(pattern: string, request: string): boolean {
  const rx = new RegExp(
    `^${pattern
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  return rx.test(request);
}

export function waiverCovers(
  w: WireWaiver,
  backend: string,
  caseName: string,
  d: RecordDivergence,
): boolean {
  if (!w.backends.includes(backend)) return false;
  if (w.cases && !w.cases.includes(caseName)) return false;
  if (w.kinds && !w.kinds.includes(d.kind)) return false;
  if (w.request && !requestMatches(w.request, d.request)) return false;
  return pathMatches(w.path, d.path);
}

export interface WaiverSplit {
  /** Divergences no waiver covers — these FAIL the gate. */
  readonly gating: readonly RecordDivergence[];
  /** Divergences a waiver covered, tagged with the waiver that did it. */
  readonly waived: readonly (RecordDivergence & { readonly reason: string })[];
  /** Indices into the supplied waiver list that matched nothing. */
  readonly usedWaivers: ReadonlySet<number>;
}

export function applyWaivers(
  divergences: readonly RecordDivergence[],
  backend: string,
  caseName: string,
  waivers: readonly WireWaiver[],
): WaiverSplit {
  const gating: RecordDivergence[] = [];
  const waived: (RecordDivergence & { reason: string })[] = [];
  const usedWaivers = new Set<number>();
  for (const d of divergences) {
    const hit = waivers.findIndex((w) => waiverCovers(w, backend, caseName, d));
    if (hit === -1) {
      gating.push(d);
    } else {
      usedWaivers.add(hit);
      waived.push({ ...d, reason: waivers[hit].reason });
    }
  }
  return { gating, waived, usedWaivers };
}

/** Waivers that apply to this backend + these cases but matched nothing — the
 *  RATCHET half.  A divergence that got fixed must take its waiver with it, or
 *  the list only ever grows and stops meaning anything.  Scoped so it cannot
 *  false-fire: a case-scoped waiver is only checked when ALL its cases ran. */
export function staleWaivers(
  waivers: readonly WireWaiver[],
  backend: string,
  ranCases: readonly string[],
  used: ReadonlySet<number>,
): WireWaiver[] {
  const ran = new Set(ranCases);
  return waivers.filter((w, i) => {
    if (used.has(i)) return false;
    if (!w.backends.includes(backend)) return false;
    if (w.cases) return w.cases.every((c) => ran.has(c));
    return ranCases.length > 0;
  });
}

// ── report ─────────────────────────────────────────────────────────────────

/** How many waived rows to print before collapsing to a count. */
const WAIVED_SHOWN = 6;

const short = (v: Json | undefined): string => {
  const s = JSON.stringify(v ?? null);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/** Human-readable gate output.  Groups by divergence kind so a systemic class
 *  (every enum mis-cased) reads as ONE heading rather than N scattered rows. */
export function renderWireReport(backend: string, caseName: string, split: WaiverSplit): string {
  const lines: string[] = [];
  // Waived divergences are LISTED, not just counted: a tolerated divergence
  // that drifts (a different value, a wider path) would otherwise hide behind
  // its own waiver, which is the failure mode the registry exists to prevent.
  // Capped like the gating list so a systemic waiver (elixir over-returns every
  // field of every create) can't bury the rest of the log.
  for (const w of split.waived.slice(0, WAIVED_SHOWN)) {
    lines.push(
      `  ~ wire: waived #${w.seq} ${w.request} at ${w.path} — golden ${short(w.golden)} ≠ ${backend} ${short(w.actual)}  [${w.reason.split(" — ")[0]}]`,
    );
  }
  if (split.waived.length > WAIVED_SHOWN) {
    lines.push(`  ~ wire: … ${split.waived.length - WAIVED_SHOWN} more waived`);
  }
  if (split.gating.length === 0) {
    lines.push(
      `  ⟐ wire: matches golden${split.waived.length ? ` (${split.waived.length} waived)` : ""}`,
    );
    return lines.join("\n");
  }
  lines.push(
    `  ✗ wire: ${split.gating.length} divergence(s) from wire-golden/${caseName}.json on ${backend}`,
  );
  const byKind = new Map<RecordDivergenceKind, RecordDivergence[]>();
  for (const d of split.gating) {
    const b = byKind.get(d.kind) ?? [];
    b.push(d);
    byKind.set(d.kind, b);
  }
  const ORDER: RecordDivergenceKind[] = [
    "request-count",
    "request",
    "status",
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
    lines.push(`      ${kind} (${rows.length}):`);
    for (const d of rows.slice(0, 8)) {
      lines.push(
        `        #${d.seq} ${d.request} at ${d.path} — golden ${short(d.golden)} ≠ ${backend} ${short(d.actual)}`,
      );
    }
    if (rows.length > 8) lines.push(`        … ${rows.length - 8} more`);
  }
  return lines.join("\n");
}
