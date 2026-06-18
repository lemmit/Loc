import type { Aggregate } from "../../api/index.js";
import { defineMacro } from "../../api/index.js";
import { areaForAggregate } from "./_pages.js";

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
    "`scaffoldSubdomain` / `scaffold` for each aggregate they cover.",
  params: {
    of: { kind: "ref", of: "Aggregate" },
  },
  expand({ args }) {
    const agg = args.of as Aggregate;
    // An `abstract aggregate` base owns no table, repository, or HTTP
    // routes — only the polymorphic union reader is emitted, as
    // infrastructure (see docs/inheritance.md).  There is no data
    // endpoint to back List/Detail/New pages, so scaffolding them
    // produces pages whose api hooks resolve to nothing (the React
    // walker emits `/* unresolved */ undefined` sentinels that fail
    // strict tsc).  Skip the base; its concrete `extends` subtypes
    // each get their own pages.
    if (agg.isAbstract) return [];
    // Return one `area <Plural> { List, New, Detail }` block (not loose pages)
    // so the generated page tree groups by aggregate and unfolds to a real
    // area block.
    return [areaForAggregate(agg)];
  },
});
