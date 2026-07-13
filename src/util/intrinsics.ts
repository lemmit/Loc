// Canonical scalar-intrinsic catalogue — the single source for typing,
// lowering, completion, queryability validation, and per-backend rendering
// of built-in operations on scalar receivers (`s.trim()`, later
// `s.substring(...)`, `n.round(...)`, `d.abs()`, ...).
//
// The sibling of `collection-ops.ts` for non-collection receivers.  Pure
// data: zero language / AST dependencies, so this lives at a leaf under
// src/util/ and every layer (language, ir, generator, system) imports from
// here without back-edges into language/.
//
// Each backend supplies a snippet per op key in its `ExprTarget.intrinsic`
// leaf table; `test/generator/intrinsic-completeness.test.ts` pins that
// every catalogue row has a snippet on every backend (in-memory and — for
// `queryable` rows — in each backend's find-predicate renderer), so adding
// a row here fails CI until every target is filled.  See
// docs/old/plans/stdlib.md (Phase A).

/** Scalar receiver types an intrinsic can be declared on. */
export type IntrinsicReceiver = "string" | "int" | "long" | "decimal" | "money" | "datetime";

/** Parameter type of an intrinsic — primitive names only (no lambdas here;
 *  lambda-taking ops stay in `collection-ops.ts`). A trailing `?` marks the
 *  parameter optional. */
export type IntrinsicParam =
  | "string"
  | "int"
  | "long"
  | "decimal"
  | "money"
  | "bool"
  | "string?"
  | "int?";

/** Return type of an intrinsic. `"receiver"` means "same type as the
 *  receiver" (e.g. numeric `abs` on int stays int, on decimal stays
 *  decimal); `"string[]"` is a string collection (collection ops apply
 *  to the result). */
export type IntrinsicReturn =
  | "string"
  | "int"
  | "long"
  | "decimal"
  | "money"
  | "bool"
  | "datetime"
  | "receiver"
  | "string[]";

export interface IntrinsicSignature {
  receiver: IntrinsicReceiver;
  name: string;
  params: ReadonlyArray<IntrinsicParam>;
  returns: IntrinsicReturn;
  /** May this intrinsic appear in a queryable position (`find ... where`,
   *  view filter, criterion, capability filter)?  Non-queryable intrinsics
   *  in a where-position fail IR validation with
   *  `loom.intrinsic-not-queryable` rather than silently degrading. */
  queryable: boolean;
  /** Free-form display signature for completion-item details
   *  (e.g. `"(): string"`).  Not parsed; purely informational. */
  signature: string;
}

// Cross-backend semantics contract (each op behaves the same from `.ddd`
// source on every backend; edge behaviour is pinned here, not per backend):
//   - `toUpper` / `toLower` — full-string case mapping in the platform's
//     default (invariant-leaning) mapping; queryable as SQL upper()/lower().
//   - `substring(start, len?)` — 0-BASED and CLAMPING (JS `slice`
//     semantics): out-of-range start yields "", len past the end truncates,
//     omitted len runs to the end.  Non-negative arguments expected.
//   - `startsWith` / `endsWith` / `contains` — ordinal (culture-free)
//     comparison.  A string-receiver `contains` is an intrinsic, NOT the
//     collection op — lowering keys the `isCollectionOp` flag off the
//     receiver type, so the two never collide.
//   - `replace(find, repl)` — replaces ALL occurrences; `find` is a literal
//     string, never a pattern (use `matches` for regex).
//   - `split(sep)` — literal separator; keeps empty segments (including a
//     trailing one), like JS/Python/Elixir defaults.
//   - numeric `abs` — absolute value; keeps the receiver type.  SQL `abs()`.
//     (The `money` primitive is a bare precise-decimal scalar — Decimal /
//     BigDecimal / C# decimal per backend — with no currency component, so
//     numeric intrinsics on it are plain scalar transforms.  `decimal` is
//     binary floating point on the TS and Python backends; money is the
//     precise type there.)
//   - `round(places?)` — HALF-AWAY-FROM-ZERO ("commercial" rounding, the
//     money-safe mode), NOT banker's half-even; backends whose native
//     default is half-even (.NET `Math.Round`, Python decimal) must force
//     the mode.  `places` defaults to 0; the result keeps the receiver
//     type.  SQL `round(numeric, n)` on Postgres is already
//     half-away-from-zero.  On float-backed `decimal` (TS/Python) the mode
//     is honoured at float precision (best-effort, like all float math).
//   - `floor` / `ceil` — toward −∞ / +∞ to a whole number; the result KEEPS
//     the receiver type (`floor` on decimal/money is a whole-valued
//     decimal/money, not an int).  SQL `floor()` / `ceil()`.
//   - `min(other)` / `max(other)` — two-value comparison returning the
//     receiver type.  SQL `LEAST()` / `GREATEST()` (two-value, not the
//     aggregate min/max).  A column-typed `other` is allowed in queryable
//     position (`LEAST(col_a, col_b)` is legitimate SQL).
export const INTRINSIC_SIGNATURES: ReadonlyArray<IntrinsicSignature> = [
  // ---- string ------------------------------------------------------------
  {
    receiver: "string",
    name: "trim",
    params: [],
    returns: "string",
    queryable: true,
    signature: "(): string",
  },
  {
    receiver: "string",
    name: "toUpper",
    params: [],
    returns: "string",
    queryable: true,
    signature: "(): string",
  },
  {
    receiver: "string",
    name: "toLower",
    params: [],
    returns: "string",
    queryable: true,
    signature: "(): string",
  },
  {
    receiver: "string",
    name: "substring",
    params: ["int", "int?"],
    returns: "string",
    queryable: false,
    signature: "(start: int, len?: int): string",
  },
  {
    receiver: "string",
    name: "startsWith",
    params: ["string"],
    returns: "bool",
    queryable: false,
    signature: "(s: string): bool",
  },
  {
    receiver: "string",
    name: "endsWith",
    params: ["string"],
    returns: "bool",
    queryable: false,
    signature: "(s: string): bool",
  },
  {
    receiver: "string",
    name: "contains",
    params: ["string"],
    returns: "bool",
    queryable: false,
    signature: "(s: string): bool",
  },
  {
    receiver: "string",
    name: "replace",
    params: ["string", "string"],
    returns: "string",
    queryable: false,
    signature: "(find: string, repl: string): string",
  },
  {
    receiver: "string",
    name: "split",
    params: ["string"],
    returns: "string[]",
    queryable: false,
    signature: "(sep: string): string[]",
  },
  // ---- numerics (A3 math batch) -------------------------------------------
  // abs / min / max on all four numeric receivers; round / floor / ceil only
  // where they change anything (decimal, money) — on int/long they would be
  // identities, and an identity row would just be noise in completion.
  ...(["int", "long", "decimal", "money"] as const).flatMap((receiver): IntrinsicSignature[] => [
    {
      receiver,
      name: "abs",
      params: [],
      returns: "receiver",
      queryable: true,
      signature: `(): ${receiver}`,
    },
    {
      receiver,
      name: "min",
      params: [receiver],
      returns: "receiver",
      queryable: true,
      signature: `(other: ${receiver}): ${receiver}`,
    },
    {
      receiver,
      name: "max",
      params: [receiver],
      returns: "receiver",
      queryable: true,
      signature: `(other: ${receiver}): ${receiver}`,
    },
  ]),
  ...(["decimal", "money"] as const).flatMap((receiver): IntrinsicSignature[] => [
    {
      receiver,
      name: "round",
      params: ["int?"],
      returns: "receiver",
      queryable: true,
      signature: `(places?: int): ${receiver}`,
    },
    {
      receiver,
      name: "floor",
      params: [],
      returns: "receiver",
      queryable: true,
      signature: `(): ${receiver}`,
    },
    {
      receiver,
      name: "ceil",
      params: [],
      returns: "receiver",
      queryable: true,
      signature: `(): ${receiver}`,
    },
  ]),
];

/** Number of REQUIRED parameters (the prefix before any `?`-marked ones). */
export function intrinsicMinArity(sig: IntrinsicSignature): number {
  return sig.params.filter((p) => !p.endsWith("?")).length;
}

/** Stable lookup key for an intrinsic — receiver-qualified so a future
 *  numeric `round` and a hypothetical string `round` never collide.
 *  Accepts any primitive name so render-site callers can key directly
 *  off `receiverType.name`; unknown receivers simply never match. */
export function intrinsicKey(receiver: string, name: string): string {
  return `${receiver}.${name}`;
}

const BY_KEY = new Map(INTRINSIC_SIGNATURES.map((s) => [intrinsicKey(s.receiver, s.name), s]));

/** Look up an intrinsic by receiver primitive + member name; undefined when
 *  no such intrinsic exists (the member falls through to the existing
 *  unknown-member diagnostics). */
export function intrinsicFor(receiver: string, name: string): IntrinsicSignature | undefined {
  return BY_KEY.get(`${receiver}.${name}`);
}

/** Resolve an intrinsic's return type to a concrete primitive name —
 *  `"receiver"` folds to the actual receiver primitive. */
export function intrinsicReturnType(sig: IntrinsicSignature, receiver: string): string {
  return sig.returns === "receiver" ? receiver : sig.returns;
}

/** Every intrinsic declared on the given receiver type (completion items). */
export function intrinsicsForReceiver(receiver: string): ReadonlyArray<IntrinsicSignature> {
  return INTRINSIC_SIGNATURES.filter((s) => s.receiver === receiver);
}
