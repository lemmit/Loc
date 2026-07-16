import { isRepository } from "../../../language/generated/ast.js";
import type { BoundedContext, Criterion, TypeRef } from "../../api/index.js";
import {
  callExpr,
  cloneTypeRef,
  defineMacro,
  letStmt,
  memberAccess,
  namedType,
  nameRef,
  param,
  queryHandler,
  returnStmt,
} from "../../api/index.js";
import { criterionAggName, pagedHandlerName } from "./_paged-shared.js";

/** Emit the ergonomic paged, criterion-filtered read (read-path-architecture.md,
 * "The ergonomic default").  A named, paged, filtered list read — the single
 * most common read — is one line over the read-only port (`Repo.run(<criterion>)`)
 * rather than a hand-written `query` + `response` + `queryHandler` + `route`
 * quartet:
 *
 *   context Sales with scaffoldPaged(of: InRegion) {
 *     aggregate Order { region: string  ... }
 *     repository Orders for Order { }
 *     criterion InRegion(rgn: string) of Order = region == rgn
 *   }
 *
 *   ↓ Sales gains
 *
 *   queryHandler ListOrderByInRegion(rgn: string): Order paged {
 *     let r = Orders.run(InRegion(rgn))
 *     return r
 *   }
 *
 * The handler returns the aggregate's wire shape (`Order paged`); the read-rewire
 * (M-T5.10) AUTO-PROJECTS that to `OrderResponse paged`, so no `response` record
 * is hand-rolled.  The criterion's own params ride as PLAIN scalar handler params
 * (`rgn: string`); `page` / `pageSize` / `sort` / `dir` are route-level query
 * params supplied by the paged infra, never handler params.  Pairs with
 * `scaffoldPagedApi`, which emits the matching `route` from the SAME criterion —
 * a route can never target a handler this macro didn't emit. */
export default defineMacro({
  name: "scaffoldPaged",
  target: "context",
  apiVersion: 1,
  description:
    "Emits a paged queryHandler over the read-only port (Repo.run(<criterion>)) " +
    "for the named criterion — the criterion's params become the handler's " +
    "scalar params, the aggregate's wire shape (auto-projected) its paged return.",
  params: {
    of: { kind: "ref", of: "Criterion" },
  },
  expand({ target, args }) {
    const ctx = target as BoundedContext;
    const crit = args.of as Criterion;
    const aggName = criterionAggName(crit);
    // The repository that runs the criterion — the one whose aggregate ref
    // matches the criterion's target.  No repo → nothing to `run` through, so
    // the macro emits nothing (mirrors `scaffoldPagedApi`, which also skips).
    const repo = (ctx.members ?? [])
      .filter(isRepository)
      .find((r) => r.aggregate?.$refText === aggName);
    if (!repo) return [];

    // The criterion's declared params → the handler's params, each cloned
    // through the factories so a `Money` / `X id` type keeps its resolved type
    // after splicing (a hand-rolled ref never re-links, silently → `string`).
    const critParams = crit.params.filter((p) => p.type != null);
    const params = critParams.map((p) => param(p.name, cloneTypeRef(p.type as TypeRef)));
    const body = [
      // `let r = <Repo>.run(<Criterion>(<crit-params>))` — the read-only port.
      // No `page:` arg: paging is route-level (query params), per retrieval.md's
      // page-is-call-only decision.
      letStmt(
        "r",
        memberAccess(nameRef(repo.name), "run", {
          call: true,
          args: [
            callExpr(
              crit.name,
              critParams.map((p) => ({ value: nameRef(p.name) })),
            ),
          ],
        }),
      ),
      returnStmt(nameRef("r")),
    ];
    // Return `<Agg> paged` — the aggregate's wire shape; the read-rewire projects
    // it to `<Agg>Response paged` at the transport boundary.
    return [
      queryHandler(
        pagedHandlerName(aggName, crit.name),
        params,
        namedType(aggName, { paged: true }),
        body,
      ),
    ];
  },
});
