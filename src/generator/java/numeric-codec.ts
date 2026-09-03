import type { NumericTarget } from "../_numeric/target.js";
import { MONEY_WIRE_SCALE } from "../money-scale.js";

// ---------------------------------------------------------------------------
// Java's `NumericTarget` (M-T9.36) — the ONE place `.setScale(4,
// RoundingMode.HALF_UP).toPlainString()` / `.doubleValue()` / `((Number)
// x).intValue()` numeric-codec literals live for the Spring Boot / JPA
// backend.  Consumed by `emit/wire.ts` (the `dto-map` / `find-param`
// boundaries — an aggregate's own DTO projection) and
// `emit/query-projection-reads.ts` (the `projection-read` boundary — JPQL
// aggregate + GROUP BY key reads).
// ---------------------------------------------------------------------------

export const JAVA_NUMERIC: NumericTarget = {
  lang: "java",
  money: {
    // money → wire string at the FIXED money scale (RS-12): bare
    // `toPlainString()` echoes the value's own scale, so pin it to the
    // canonical `NUMERIC(19,4)` scale for a wire value byte-consistent with
    // the other backends.
    "dto-map": (e) =>
      `${e}.setScale(${MONEY_WIRE_SCALE}, java.math.RoundingMode.HALF_UP).toPlainString()`,
    // Inbound wire string → domain `BigDecimal` (`wireToDomain`).
    "find-param": (e) => `new BigDecimal(${e})`,
    // JPQL hands back an aggregate result whose runtime type is
    // PROVIDER-chosen (a `BigDecimal` for one provider, a `Double` for
    // another), so re-wrap through `.toString()` before pinning the fixed
    // scale — the same #2549 rule `dto-map` applies on a per-row read.
    "projection-read": (e) =>
      `new java.math.BigDecimal(${e}.toString()).setScale(${MONEY_WIRE_SCALE}, java.math.RoundingMode.HALF_UP).toPlainString()`,
  },
  decimal: {
    // decimal → the response's `double` component (RS-24 / M-T6.46).  The
    // DOMAIN value keeps every digit `MathContext.DECIMAL128` produced; the
    // narrowing is the wire boundary's job, exactly as on .NET (#2575).
    "dto-map": (e) => `${e}.doubleValue()`,
    // A JPQL aggregate/grouped-key value narrows the same way, cast through
    // `Number` rather than a direct cast (the provider's runtime type
    // varies: `BigDecimal` for a `sum`, `Double` for an `avg`).
    "projection-read": (e) => `((Number) ${e}).doubleValue()`,
    // A channel envelope's untyped `data` map value reconstructs into the
    // domain `BigDecimal` the same way `String.valueOf` normalises a JSON
    // number OR string entry before parsing.
    "find-param": (e) => `new BigDecimal(String.valueOf(${e}))`,
  },
  int: {
    "projection-read": (e) => `((Number) ${e}).intValue()`,
    "find-param": (e) => `((Number) ${e}).intValue()`,
  },
  long: {
    "projection-read": (e) => `((Number) ${e}).longValue()`,
    "find-param": (e) => `((Number) ${e}).longValue()`,
  },
};

/** `groupKeyCoerce`'s money arm (`emit/query-projection-reads.ts`) — the SAME
 *  `projection-read` transform as `JAVA_NUMERIC.money["projection-read"]`,
 *  spelled with the SHORT `BigDecimal` name because that call site already
 *  imports it (`imports.add("java.math.BigDecimal")`) rather than the fully-
 *  qualified name `jpqlCoerce`'s aggregate arm uses.  A second export rather
 *  than a second `NumericTarget` slot: the leaf contract is one function per
 *  (kind, boundary), and this is the SAME boundary with a qualification
 *  difference the byte-identical refactor gate must preserve exactly (see
 *  docs/new-plan/waves/handoffs/wave-2-numeric-codec.md). */
export function javaMoneyProjectionKeyEncode(read: string): string {
  return `new BigDecimal(${read}.toString()).setScale(${MONEY_WIRE_SCALE}, java.math.RoundingMode.HALF_UP).toPlainString()`;
}
