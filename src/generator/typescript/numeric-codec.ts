import type { NumericTarget } from "../_numeric/target.js";
import { MONEY_WIRE_SCALE } from "../money-scale.js";

// ---------------------------------------------------------------------------
// TypeScript's `NumericTarget` (M-T9.36) — the ONE place `.toFixed(4)` /
// `new Decimal(...)` / `Number(...)` numeric-codec literals live for the
// node/Hono backend.  Shared verbatim by the Hono route layer
// (`src/platform/hono/v4/**`), which is the same generated-JS runtime.
//
// Each leaf is the BARE encode fragment — no null-guard, no `?? 0` default.
// Callers keep their own optional-handling exactly as before; only the inner
// literal moved here, which is what keeps the refactor byte-identical (see
// `docs/new-plan/waves/handoffs/wave-2-numeric-codec.md`).
// ---------------------------------------------------------------------------

export const TS_NUMERIC: NumericTarget = {
  lang: "typescript",
  money: {
    // Drizzle's `numeric()` column reads back as a STRING at runtime;
    // `new Decimal(...)` consumes it without precision loss (money does NOT
    // hydrate lossy through JS `number` the way `decimal` does).
    "repo-read": (e) => `new Decimal(${e})`,
    // The inbound wire boundary (`moneySchema`, emitted to every generated
    // project's `lib/schemas.ts` — `hono/v4/emit.ts`): a validated
    // decimal-formatted STRING parses the same way a stored column does.
    "find-param": (e) => `new Decimal(${e})`,
    // Domain value is already a `Decimal` instance — format to the FIXED
    // wire scale (RS-12): decimal.js `.toJSON()` strips trailing zeros
    // (`"12.50"` → `"12.5"`), so every dto-map / operation-scalar-return
    // boundary formats explicitly instead.
    "dto-map": (e) => `${e}.toFixed(${MONEY_WIRE_SCALE})`,
    // A query-time projection reads a RAW driver value (not yet a `Decimal`
    // instance) for an aggregate select or a GROUP BY key — re-wrap before
    // formatting to the same fixed scale the per-row `dto-map` path uses
    // (#2549: an aggregate/grouped read must not disagree with the
    // aggregate's own `toWire`).
    "projection-read": (e) => `new Decimal(${e}).toFixed(${MONEY_WIRE_SCALE})`,
  },
  decimal: {
    // `numeric` (decimal) columns hydrate lossy through JS `number` by
    // design — money exists precisely for the case that can't afford this.
    "repo-read": (e) => `Number(${e})`,
    // A raw aggregate/grouped-key driver value narrows the same way.
    "projection-read": (e) => `Number(${e})`,
  },
  int: {
    // int/long are already numbers coming off the ORM; a projection's raw
    // driver value (string, from a `numeric`-typed SQL aggregate provider,
    // or already a JS number) narrows through the same `Number(...)` rule as
    // decimal — one rule keeps the three shapes on one line at the call site.
    "projection-read": (e) => `Number(${e})`,
  },
  long: {
    "projection-read": (e) => `Number(${e})`,
  },
};
