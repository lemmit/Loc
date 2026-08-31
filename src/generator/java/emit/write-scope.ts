import type { EnrichedAggregateIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { desugarAuthzFilterInApp } from "../../_expr/authz-filter-inapp.js";
import { renderJavaExpr } from "../render-expr.js";
import { javaNotFoundThrow } from "./common.js";

// ---------------------------------------------------------------------------
// The IN-APP write-scope guard for java's BLOB-shaped repositories
// (`shape: document` and the event-sourced stream, authorization Phase 3 P3.1).
//
// The relational / embedded shapes push the write scope into a SpEL-principal
// `findByIdForWrite` @Query (src/generator/java/emit/repository.ts): a row the
// caller may READ but not WRITE reads as empty → 404, no existence leak.  A
// document blob and an event stream have no queryable state columns to build
// that @Query over, so those two shapes had NO write-scope guard at all —
// `getById` (which IS the command load on java: the read route calls
// `findById`, every mutation calls `getById`) fell through to the read-scoped
// load, and a denied write silently succeeded.
//
// The fix is the one node/mikroorm already uses on the same two shapes: check
// the scope IN-APP over the loaded aggregate, in the same place these
// repositories already evaluate their capability READ filters.
// ---------------------------------------------------------------------------

/** True when the aggregate's write scope denies EVERY row (`policy { deny write
 *  on X }`) — the in-app form is the constant `false`, so a command load can
 *  answer not-found without loading anything (and without emitting the
 *  `if (!(false))` a constant-condition lint would flag). */
export function writeScopeDeniesAll(agg: EnrichedAggregateIR): boolean {
  const f = agg.writeScopeFilter;
  return f !== undefined && f.kind === "authz-filter" && f.filter.kind === "deny";
}

/** True when the in-app write-scope guard reads the request principal, so the
 *  emitting repository must inject `CurrentUserAccessor` even when none of its
 *  READ filters do. */
export function writeScopeUsesPrincipal(agg: EnrichedAggregateIR): boolean {
  const f = agg.writeScopeFilter;
  return f !== undefined && !writeScopeDeniesAll(agg) && exprUsesCurrentUser(f);
}

/** The `getById` command-load body for a blob shape, or null when the aggregate
 *  has no write-scope narrowing (the caller then keeps its byte-identical
 *  read-scoped load).  `hasAccessor` says whether the enclosing class already
 *  binds `currentUser` — the caller injects `CurrentUserAccessor` under
 *  {@link writeScopeUsesPrincipal}. */
export function javaBlobWriteGuardLines(
  agg: EnrichedAggregateIR,
  idClass: string,
  logLine: string,
): readonly string[] | null {
  if (!agg.writeScopeFilter) return null;
  const notFound = `throw ${javaNotFoundThrow(agg.name)};`;
  if (writeScopeDeniesAll(agg)) {
    return [
      `    @Override`,
      `    public ${agg.name} getById(${idClass} id) {`,
      `        // policy { deny write on ${agg.name} } — no row is in write scope.`,
      `        ${notFound}`,
      `    }`,
    ];
  }
  const pred = renderJavaExpr(desugarAuthzFilterInApp(agg.writeScopeFilter, agg.name), {
    thisName: "rec",
    agg,
    accessorProps: true,
  });
  const usesPrincipal = writeScopeUsesPrincipal(agg);
  return [
    `    @Override`,
    `    public ${agg.name} getById(${idClass} id) {`,
    `        var found = findById(id);`,
    logLine,
    `        var rec = found.orElseThrow(() ->`,
    `            ${javaNotFoundThrow(agg.name)});`,
    // Fail-closed on an unauthenticated scope: a null principal writes nothing,
    // mirroring the relational path's null-safe SpEL @Query (which matches no
    // row when `@currentUserAccessor.user()` is null).
    ...(usesPrincipal
      ? [
          `        var currentUser = currentUserAccessor.user();`,
          `        if (currentUser == null || !(${pred})) ${notFound}`,
        ]
      : [`        if (!(${pred})) ${notFound}`]),
    `        return rec;`,
    `    }`,
  ];
}
