// Canonical money wire/storage scale — the single source of truth every
// backend's money serialization derives from.
//
// `money` persists as `NUMERIC(19,4)` on every SQL backend (see
// `python/py-columns.ts`, `typescript/emit/schema.ts`, `typescript/emit/
// mikroorm.ts`), so the canonical WIRE representation of a money value is a
// decimal string at exactly `MONEY_WIRE_SCALE` fractional digits.  RS-12
// (`docs/conformance-semantics.md`) fixes this as the cross-backend contract:
// a money field reads back with the SAME scale on every backend's wire, rather
// than each backend's decimal library normalizing (node/decimal.js strips
// trailing zeros) or echoing the as-parsed input scale.  Formatting money to
// this fixed scale at the wire boundary is the one lossless choice that keeps
// the storage precision intact.

/** Fractional-digit count money carries on the wire (and in `NUMERIC(19,4)`). */
export const MONEY_WIRE_SCALE = 4;

/** Total significant digits of the money storage type (`NUMERIC(19,4)`). */
export const MONEY_PRECISION = 19;
