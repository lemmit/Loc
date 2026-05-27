import type { BoundedContext } from "../../api/index.js";
import { aggregatesIn, defineMacro, viewsIn, workflowsIn } from "../../api/index.js";

/** Composer: invokes `scaffoldAggregate` / `scaffoldWorkflow` /
 * `scaffoldView` for each member of one bounded context.
 *
 * Unfolding `with scaffoldContext(of: Sales)` produces one
 * `with scaffoldAggregate(of: <Agg>)` per aggregate, plus the
 * workflow/view leaves.  The user can then drill into a single
 * aggregate's scaffold without touching the others. */
export default defineMacro({
  name: "scaffoldContext",
  target: "ui",
  apiVersion: 1,
  description:
    "Fans `scaffoldAggregate` / `scaffoldWorkflow` / `scaffoldView` across " +
    "every member of the named bounded context.  Mid-level composer in the " +
    "scaffold-macro family.",
  params: {
    of: { kind: "ref", of: "BoundedContext" },
  },
  expand({ target, args, invokeMacro }) {
    const ctx = args.of as BoundedContext;
    const out: unknown[] = [];
    for (const a of aggregatesIn(ctx)) {
      out.push(...invokeMacro("scaffoldAggregate", { target, args: { of: a } }));
    }
    for (const w of workflowsIn(ctx)) {
      out.push(...invokeMacro("scaffoldWorkflow", { target, args: { of: w } }));
    }
    for (const v of viewsIn(ctx)) {
      out.push(...invokeMacro("scaffoldView", { target, args: { of: v } }));
    }
    return out as never[];
  },
});
