import type { NumericTarget } from "../../_numeric/target.js";
import { MONEY_WIRE_SCALE } from "../../money-scale.js";

// ---------------------------------------------------------------------------
// Elixir's `NumericTarget` (M-T9.36) — the ONE place `Decimal.round(_,
// ${MONEY_WIRE_SCALE})` / `Decimal.to_float(...)` numeric-codec fragments
// live for the vanilla Phoenix/Ecto backend.  These generate the BODY of
// per-module `defp __money_round/1` / `__money_wire/1` / `__decimal_num/1`
// helpers (`controller-serialize.ts`, `operation-returns-emit.ts`,
// `query-projections-emit.ts`, `realtime-emit.ts`, `wire-serialize.ts`) — each
// module still emits its OWN private helper (Elixir has no cross-module
// private function), but the LITERAL decision inside every one of them now
// comes from here instead of five re-typed copies.
// ---------------------------------------------------------------------------

export const ELIXIR_NUMERIC: NumericTarget = {
  lang: "elixir",
  money: {
    // dto-map: a `%Decimal{}` already at domain precision.  `Decimal.round/2`
    // pins the fixed RS-12 wire scale; Jason's `Decimal.Encoder` renders the
    // result AS that scale's string, so no explicit `to_string` is needed —
    // the operation scalar-return (`controller-serialize.ts`,
    // `operation-returns-emit.ts`), realtime broadcast (`realtime-emit.ts`),
    // an aggregate's own `to_wire` (`wire-serialize.ts`), and a query-time
    // projection's per-ROW money select (`query-projections-emit.ts`'s
    // `__money_round`) all render through this one shape.
    "dto-map": (e) => `Decimal.round(${e}, ${MONEY_WIRE_SCALE})`,
    // projection-read: a query-time projection's aggregate / GROUP BY key
    // result (`__money_wire/1`) — explicitly piped through `to_string()`
    // rather than left to Jason's encoder.
    "projection-read": (e) => `${e} |> Decimal.round(${MONEY_WIRE_SCALE}) |> to_string()`,
    // find-param: an operation param binds straight off the decoded request
    // map (`coerceOpParam`) — `to_string` first so a JSON number and a JSON
    // string both land on the same `%Decimal{}`, the wire allowing either.
    "find-param": (e) => `Decimal.new(to_string(${e}))`,
  },
  decimal: {
    // dto-map: RS-24 — a plain `decimal` is a JSON NUMBER on every other
    // backend, but Jason encodes a bare `%Decimal{}` as a STRING, so narrow
    // here.
    "dto-map": (e) => `Decimal.to_float(${e})`,
    // projection-read: Ecto returns a numeric aggregate/grouping-key column
    // as a `%Decimal{}`, a raw Postgrex value, or (a transformed fragment
    // key) already a string — re-derive through the string form before
    // narrowing so every source shape lands on the identical float.
    "projection-read": (e) => `Decimal.to_float(Decimal.new(to_string(${e})))`,
    // find-param: the SAME op-param coercion `money` uses — a `decimal` field
    // also needs a bare wire string/number cast into `%Decimal{}` before
    // `force_change` can dump it (see `coerceOpParam`'s doc comment).
    "find-param": (e) => `Decimal.new(to_string(${e}))`,
  },
};
