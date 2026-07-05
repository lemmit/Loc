// ---------------------------------------------------------------------------
// Vanilla lifecycle-stamp helper.
//
// `contextStamps` (from `stamp onCreate`/`onUpdate`, or the `with audit`/
// `auditable` capability) become `Ecto.Changeset.put_change` pipe lines applied
// to the changeset right before `Repo.insert` / `Repo.update`.  A non-principal
// value renders directly (`now()` → `DateTime.utc_now()`) and a bare
// `currentUser` value resolves to the principal id read from the threaded
// actor as `current_user.<idKey>` (the actor is the `conn.assigns.current_user`
// map the Auth plug populated, threaded through `create_<agg>`/`update_<agg>`).
//
// `onUpdate` stamps run on BOTH insert and update (so a
// NOT-NULL `updated_at`/`updated_by` audit column is populated on the initial
// insert, created == updated), while `onCreate` stamps run on insert only.
//
// Threading: a principal-referencing stamp needs `current_user` in scope at the
// repository `insert`/`update` site, so the context delegate + controller add a
// `current_user` arg ONLY for aggregates whose stamps use the principal
// (`stampUsesPrincipal`).  Non-principal stamps (`createdAt := now()`) keep the
// original parameterless seam (byte-identical).
// ---------------------------------------------------------------------------

import type { AggregateIR, ExprIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { snake } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** Does the aggregate carry any lifecycle stamp at all? */
export function aggregateHasStamps(agg: AggregateIR): boolean {
  return (agg.contextStamps ?? []).length > 0;
}

/** Snake-cased names of every field a lifecycle stamp writes (`onCreate` /
 *  `onUpdate` assignment targets — audit `createdBy`, `tenantOwned`'s
 *  `tenantId`, `createdAt := now()`, …).  These are server-owned: the stamp
 *  `put_change`s them onto the changeset right before persist, so they must NOT
 *  be `cast` from client attrs (a client could spoof the value) nor
 *  `validate_required`d in `base_changeset` (that runs BEFORE the stamp and
 *  would reject a create whose stamped column the client never sends — the bug
 *  that 422'd `tenantOwned`'s create with "tenant_id can't be blank"). */
export function stampedFieldNames(agg: AggregateIR): Set<string> {
  return new Set(
    (agg.contextStamps ?? []).flatMap((r) => r.assignments.map((a) => snake(a.field))),
  );
}

/** Does any of the aggregate's stamps reference the request principal
 *  (`currentUser`)?  Gates the `current_user` threading through the
 *  create/update seam (delegate + controller). */
export function stampUsesPrincipal(agg: AggregateIR): boolean {
  return (agg.contextStamps ?? []).some((r) =>
    r.assignments.some((a) => exprUsesCurrentUser(a.value)),
  );
}

/** Does a stamp of one of the given lifecycle EVENTS reference the principal?
 *  The update seam keeps the threaded actor's ARITY whenever any stamp is
 *  principal-valued (callers are generated in lockstep), but an aggregate
 *  whose only principal stamp is `onCreate` (e.g. `tenantOwned`'s
 *  `tenantId := currentUser.tenantId`) never READS it there — the param is
 *  then emitted underscored so `mix compile --warnings-as-errors` stays
 *  green. */
export function stampUsesPrincipalFor(
  agg: AggregateIR,
  events: readonly ("create" | "update")[],
): boolean {
  return (agg.contextStamps ?? []).some(
    (r) =>
      events.includes(r.event as "create" | "update") &&
      r.assignments.some((a) => exprUsesCurrentUser(a.value)),
  );
}

/** Render one stamp assignment's value.  A bare `currentUser` ref resolves to
 *  the principal id read off the threaded `current_user` map — nil-safe as
 *  `current_user && current_user.<idKey>`, so an internal caller that didn't
 *  thread an actor (the `\\ nil` default) stamps `nil` rather than raising on a
 *  `nil.<idKey>` access (the write-side analogue of the tenancy-filter's
 *  fail-closed `^(current_user && current_user.f)`).  Everything else renders via
 *  the shared vanilla expression renderer (`now()` → `DateTime.utc_now()`). */
function renderStampValue(value: ExprIR, ctx: RenderCtx, principalIdKey: string): string {
  if (value.kind === "ref" && value.refKind === "current-user") {
    return `current_user && current_user.${principalIdKey}`;
  }
  // A claim-valued principal stamp (`tenantId := currentUser.tenantId`) gets
  // the same nil-safe guard as the bare-principal case: an internal caller
  // that didn't thread an actor (the `\\ nil` default) stamps `nil` instead of
  // raising on a `nil.<claim>` access.
  if (
    value.kind === "member" &&
    value.receiver.kind === "ref" &&
    value.receiver.refKind === "current-user"
  ) {
    return `current_user && current_user.${snake(value.member)}`;
  }
  return renderExpr(value, ctx);
}

/** The `Ecto.Changeset.put_change` pipe lines for the given lifecycle event(s),
 *  one per stamp assignment, at the requested indent.  `onUpdate` assignments
 *  are included on `insert` too, so the
 *  caller passes `["create", "update"]` at an insert site and `["update"]` at an
 *  update site.  Returns "" when no matching stamp exists. */
export function stampPutChanges(
  agg: AggregateIR,
  events: readonly ("create" | "update")[],
  contextModule: string,
  principalIdKey: string,
  indent: string,
): string {
  const ctx: RenderCtx = { thisName: "record", contextModule, foundation: "vanilla" };
  const lines = (agg.contextStamps ?? [])
    .filter((r) => events.includes(r.event))
    .flatMap((r) => r.assignments)
    .map(
      (a) =>
        `${indent}|> Ecto.Changeset.put_change(:${snake(a.field)}, ${renderStampValue(
          a.value,
          ctx,
          principalIdKey,
        )})`,
    );
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}
