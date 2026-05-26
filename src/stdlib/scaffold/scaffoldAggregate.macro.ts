import type { Aggregate } from "../../macro-api/index.js";
import { defineMacro } from "../../macro-api/index.js";
import { pagesForAggregate } from "./_pages.js";

/** Synthesise the three default pages for one aggregate: List, New,
 * Detail.
 *
 * Composability: the top-level `scaffold` macro and the per-context
 * `scaffoldContext` composer both invoke this leaf via `invokeMacro`
 * so the one-level unfold action exposes per-aggregate granularity —
 * users can drill into a single aggregate's scaffold without
 * flattening the whole UI. */
export default defineMacro({
  name: "scaffoldAggregate",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises List/New/Detail pages for the named aggregate.  Leaf of " +
    "the scaffold-macro family — invoked by `scaffoldContext` / " +
    "`scaffoldModule` / `scaffold` for each aggregate they cover.",
  params: {
    of: { kind: "ref", of: "Aggregate" },
  },
  expand({ args }) {
    return pagesForAggregate(args.of as Aggregate);
  },
});
