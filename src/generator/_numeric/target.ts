import type { NumericKind } from "./codec.js";

// ---------------------------------------------------------------------------
// The per-backend numeric-codec CONTRACT — the `_expr/target.ts` /
// `_walker/target.ts` shape applied to M-T9.36.
//
// `codec.ts` decides WHAT the wire form is (money = 4dp string, decimal =
// float64 number, int/long = integer).  This module decides WHERE that
// decision gets applied: five READ-BOUNDARY kinds, cross-referenced against
// the four `NumericKind`s.  A backend supplies ONE `NumericTarget` — a table
// of leaf render functions, one per (kind, boundary) it actually has code
// for — instead of every read-path re-typing its own coercion literal.
//
// `test/generator/_numeric/boundary-census.test.ts` is the enforcement: it
// scans each backend's fenced source tree for the RAW numeric-coercion
// signatures this contract owns (`.toFixed(`, `ToString("F`, `setScale(`,
// `Decimal.round(`, `money_str(`, …) and fails, naming file:line, on any
// occurrence OUTSIDE that backend's `numeric-codec.ts` leaf file — so a new
// read path cannot ship a raw literal instead of a seam call.
// ---------------------------------------------------------------------------

/** The five places a backend's emitted source reads a stored/derived number
 *  and must decide its wire form:
 *
 *   - `repo-read`       — repository/ORM hydration: a driver-materialised row
 *     value → the domain-typed field (TS drizzle `numeric()` column → JS
 *     `number`/`Decimal`; the SQL-backend analogues).
 *   - `projection-read` — a query-time `projection`'s per-row `select`, whole-
 *     table aggregate, or GROUP BY key (`aggregateCoercion`'s boundary, and
 *     its per-backend SQL-dialect renderings).
 *   - `dto-map`         — an aggregate's own wire projection (`to_wire` /
 *     `projectToResponse` / wire serializer), an operation's scalar return
 *     value, and realtime/pubsub broadcast payloads (the same "domain value →
 *     wire value" transform, reused for a socket push instead of an HTTP
 *     response body).
 *   - `find-param`      — an inbound numeric value from a request (body,
 *     query string) parsed INTO the domain type, the mirror direction of
 *     `dto-map`.
 *   - `seed-read`       — first-boot seed datasets constructing numeric field
 *     values.  Documented here for completeness: every backend renders seed
 *     values through the shared expression renderer (`_expr/target.ts`'s
 *     `money`/`decimal` literal arms), which already is the ONE seam for that
 *     boundary — no backend hand-writes a seed-numeric literal outside it, so
 *     no backend needs a `seed-read` entry in its `NumericTarget` today (see
 *     `docs/new-plan/waves/handoffs/wave-2-numeric-codec.md`).
 */
export type NumericBoundary =
  | "repo-read"
  | "projection-read"
  | "dto-map"
  | "find-param"
  | "seed-read";

/** One leaf: render `expr` (a source-text expression already known to hold a
 *  value of the given `NumericKind`) as its wire/domain form at one
 *  `NumericBoundary`.  `expr` is handed in fully formed — the leaf never
 *  recurses or inspects the IR, exactly like an `ExprTarget` leaf; it is a
 *  pure string-in, string-out formatter, which is what keeps a refactor that
 *  moves a literal INTO a leaf provably byte-identical (a plain literal
 *  extraction, not a rewrite). */
export type NumericLeaf = (expr: string) => string;

/** A backend's numeric codec table: for each `NumericKind`, the leaves it has
 *  registered per boundary.  A backend declares only the (kind, boundary)
 *  pairs it actually emits code for — e.g. a backend whose native integers
 *  never need wire narrowing declares no `int`/`long` leaves at all, and
 *  `numericEncode` below falls back to the identity transform for those. */
export type NumericTarget = {
  readonly lang: string;
} & {
  readonly [K in NumericKind]?: {
    readonly [B in NumericBoundary]?: NumericLeaf;
  };
};

/** Render `expr` (known to hold a `kind` value) at one `boundary`, through
 *  `target`.  Falls back to the identity transform when the backend has
 *  registered no leaf for this exact (kind, boundary) pair — the correct
 *  default for e.g. TS `decimal`/`int`/`long`, which are already JS numbers
 *  and need no textual transform at most boundaries. */
export function numericEncode(
  target: NumericTarget,
  kind: NumericKind,
  boundary: NumericBoundary,
  expr: string,
): string {
  const leaf = target[kind]?.[boundary];
  return leaf ? leaf(expr) : expr;
}
