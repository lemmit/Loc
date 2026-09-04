import type { NumericTarget } from "../_numeric/target.js";
import { MONEY_WIRE_SCALE } from "../money-scale.js";

// ---------------------------------------------------------------------------
// .NET's `NumericTarget` (M-T9.36) — the ONE place `ToString("F4"...)` /
// `double.Parse(...)` numeric-codec literals live for the dotnet backend.
// Consumed by `dto-mapping.ts` (the `dto-map` boundary — an aggregate's own
// wire projection) and `query-projection-emit.ts` (the `projection-read`
// boundary — a query-time projection's per-row/aggregate/grouped read).
//
// Each leaf is the BARE encode fragment, applied to whatever receiver
// expression the call site already built (`domainExpr`, `${read}!.Value`,
// `(${read} ?? 0m)`, …) — the null-guard / receiver-shaping stays exactly as
// each boundary had it, so moving the literal in is a byte-identical
// extraction (see docs/new-plan/waves/handoffs/wave-2-numeric-codec.md).
// ---------------------------------------------------------------------------

/** `System.Decimal` → the `double` a declared `decimal` crosses the wire as
 *  (#2563/RS-24) — **correctly rounded**, which the language's own `(double)d`
 *  cast is not.
 *
 *  `(double)d` runs `DecCalc.VarR8FromDec`: `(double)mantissa / 10^scale`.
 *  When the mantissa exceeds 2^53 — every value whose shortest round-trip
 *  repr needs 17 significant digits — the NUMERATOR is rounded to a double
 *  first and the quotient is then rounded again, so the result need not be
 *  the nearest double to the stored decimal.  MEASURED on .NET 10.0.11 over
 *  3M random doubles in [0,100) written out as Postgres `numeric` and read
 *  back: 9.2% (275,923 of 3,000,000) do not round-trip
 *  (`99.52989333734583` comes back `99.52989333734584`), while
 *  `double.Parse` of the same digits misses zero times.  Every one of the
 *  other four backends ships the true nearest double, so the .NET row is the
 *  odd one out on the wire-golden differential.
 *
 *  `decimal.ToString` is exact (a base-10 type carries no hidden precision)
 *  and `double.Parse` is correctly rounded on .NET Core 3.0+ (the generated
 *  TFM is `net10.0`), so the pair is the nearest double to the stored value —
 *  the same number node reads out of the same `numeric` column.
 *  `InvariantCulture` on BOTH halves pins the decimal separator, so a
 *  container locale cannot turn `1.5` into `1,5` and then fail to parse it.
 *
 *  Cost is one string alloc + parse per decimal field per row, at a JSON
 *  boundary that already allocates an order of magnitude more.  Both `dto-
 *  map` and `projection-read` boundaries render through this one helper (the
 *  `NumericTarget.decimal` leaf for both) so the two hops cannot drift.  The
 *  type is fully qualified so no `using` wiring is needed at either site. */
export function csDecimalToWireDouble(domainExpr: string): string {
  return (
    `double.Parse(${domainExpr}.ToString(System.Globalization.CultureInfo.InvariantCulture), ` +
    `System.Globalization.CultureInfo.InvariantCulture)`
  );
}

export const CS_NUMERIC: NumericTarget = {
  lang: "dotnet",
  money: {
    // An aggregate's own wire projection reads a fully-qualified culture ref
    // (the DTO mapper carries no `using System.Globalization;` of its own).
    "dto-map": (e) =>
      `${e}.ToString("F${MONEY_WIRE_SCALE}", System.Globalization.CultureInfo.InvariantCulture)`,
    // The projection emitter already brings `CultureInfo` into scope, so its
    // read path spells the short form — same fixed scale (RS-12), same
    // rounding (#2549: a projection read must not disagree with the
    // aggregate's own `ToWire`).
    "projection-read": (e) => `${e}.ToString("F${MONEY_WIRE_SCALE}", CultureInfo.InvariantCulture)`,
  },
  decimal: {
    "dto-map": csDecimalToWireDouble,
    "projection-read": csDecimalToWireDouble,
  },
};
