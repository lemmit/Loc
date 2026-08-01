// The `src/lib/format` helper surface — one list, shared by the frontends that
// have to name it.
//
// Pack templates call these straight from markup (`formatDateTime(...)` inside
// a `DateDisplay`), with no import-registration channel, so every frontend has
// to make them reachable in whatever file the markup lands in.  How differs:
// Vue and Svelte import them; Angular re-exposes them as component members
// (its templates evaluate against the instance).  WHAT is the same everywhere,
// and it was previously spelled out as a literal in each emitter — which is how
// a hoisted `DataGrid` child ended up calling `formatDateTime` with nothing
// providing it on three frontends at once.

/** Every symbol `src/lib/format` exports. */
export const FORMAT_MODULE_EXPORTS = [
  "EMPTY",
  "formatBool",
  "formatDateTime",
  "formatMoney",
  "formatNumber",
  "formatPlain",
  "isEmpty",
  "shortId",
] as const;

/** The subset that is CALLED as a function from markup — the ones a target
 *  detecting usage by `<name>(` in rendered output can find.  `EMPTY` is a
 *  constant and `isEmpty` is called from script rather than template. */
export const FORMAT_CALL_HELPERS = [
  "formatMoney",
  "formatDateTime",
  "formatNumber",
  "formatBool",
  "formatPlain",
  "shortId",
] as const;
