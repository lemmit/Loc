import type { NumericTarget } from "../_numeric/target.js";

// ---------------------------------------------------------------------------
// Python's `NumericTarget` (M-T9.36) — the ONE place the `money_str(...)` /
// `float(...)` / `Decimal(...)` numeric-codec call fragments live for the
// FastAPI/SQLAlchemy backend.  `money_str` itself is a RUNTIME helper emitted
// once into every generated project (`WIRE_PY` in `index.ts`) — this module
// is the TS-generator-side seam deciding WHERE that runtime helper (and its
// int/long/decimal counterparts) gets called, so the six read paths that used
// to spell `money_str(${expr})` by hand agree by construction.
// ---------------------------------------------------------------------------

export const PY_NUMERIC: NumericTarget = {
  lang: "python",
  money: {
    // An aggregate's own wire projection / a scalar op return / a workflow
    // state field all render through the SAME `money_str(...)` call the
    // runtime helper defines — the RS-12 fixed wire scale, once.
    "dto-map": (e) => `money_str(${e})`,
    // A query-time projection aggregate reads the driver's own `Decimal`
    // result through the identical formatter (#2549: it must not disagree
    // with the aggregate's own `to_wire`).  The empty-table re-wrap
    // (`Decimal(_ or 0)`) is the caller's concern, passed in as `expr`.
    "projection-read": (e) => `money_str(${e})`,
    // Event-sourced snapshot/event replay (`fromData`) reads an untyped
    // `dict` value — `cast(str, ...)` narrows the static type before parsing.
    "repo-read": (e) => `Decimal(cast(str, ${e}))`,
  },
  decimal: {
    // `numeric` hydrates lossy through Python `float` by design — money
    // exists precisely for the case that can't afford this (mirrors the TS
    // hydration split).
    "repo-read": (e) => `float(${e})`,
  },
  int: {
    "repo-read": (e) => `cast(int, ${e})`,
  },
  long: {
    "repo-read": (e) => `cast(int, ${e})`,
  },
};

/** `fromData`'s (`repository-eventsourced-builder.ts`) and `fromPayload`'s
 *  (`dispatch-builder.ts`, the dispatcher's own event-payload decode — the
 *  SAME shape) `decimal` arm: the SAME `repo-read` transform as
 *  `PY_NUMERIC.decimal["repo-read"]`, but reading an untyped `dict` value
 *  needs the union cast `hydrateScalar`'s typed-column read does not.  A
 *  second export rather than a second `NumericTarget` slot — see
 *  `javaMoneyProjectionKeyEncode` for the same pattern on the java backend. */
export function pyEventSourcedDecimalDecode(access: string): string {
  return `float(cast("int | float", ${access}))`;
}

/** `repository-document-builder.ts`'s `deserialize` `decimal` arm: the
 *  document-shape repository reads an untyped jsonb value, so it casts
 *  through the bare `float` type rather than `hydrateScalar`'s union —
 *  a THIRD shape sharing the `repo-read` boundary's underlying decision
 *  (lossy-by-design narrowing) with a third cast spelling. */
export function pyDocumentDecimalDecode(access: string): string {
  return `float(cast(float, ${access}))`;
}
