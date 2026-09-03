// Policy-derived realtime routing (channels.md — "Realtime topology": rooms +
// policy-derived routing v1).  Pure over the IR: derives, per bounded context,
// whether its realtime SSE wire scopes delivery by tenant, which carried events
// are tenant-scoped, the id-reference fields kept when a tenant-scoped event
// must degrade to a refetch ticket, and the PRINCIPAL claim member the room key
// is read from.
//
// The single DataKey v1 derives is the TENANT — the equality part of the
// `tenantOwned` read policy (`this.tenantId == currentUser.<claim>`), the
// canonical multi-tenancy scoping column.  Row column and principal claim are
// DIFFERENT names: the capability owns `tenantId` on the row, while the
// principal side is whatever `tenancy by user.<claim>` bound, so the plan
// carries the claim and each backend cases it for its own principal type.  A
// context with no tenant-owned aggregate keeps v1 broadcast-to-all
// (byte-identical output); finer-than-tenant (per-owner) rooms are a v2 knob.
//
// Classification is FAIL-CLOSED (A4).  In a context that hosts a tenant-owned
// aggregate, an event is global only when it is PROVABLY tenant-agnostic —
// it touches a `crossTenant` aggregate (by carried `<Agg> id` reference or by
// emitting site) and touches no tenant-owned one.  Everything else in such a
// context is tenant-scoped: routed to the emitter's tenant room when the tenant
// key is derivable, and degraded to the id-only refetch ticket when it is not.
// So an event carrying no id reference never broadcasts its full scalar payload
// to every tenant's clients.

import type { AggregateIR, BoundedContextIR, EventIR, StmtIR, SystemIR } from "../types/loom-ir.js";
import { realtimeEventTypes } from "./channels.js";
import { tenancyPrincipalClaim } from "./tenant-stance.js";
import { walkStmtChildren } from "./walk.js";

/** Aggregate names carrying the `tenantOwned` capability — the tenant column +
 *  claim stamp + `this.tenantId == currentUser.<claim>` read filter. */
function tenantOwnedAggregateNames(ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  for (const agg of ctx.aggregates) {
    if (agg.capabilities?.includes("tenantOwned")) out.add(agg.name);
  }
  return out;
}

/** Aggregate names declared `crossTenant` — shared reference data that opted
 *  OUT of tenant scoping.  The only positive evidence that an event out of a
 *  tenant-owned context is legitimately global. */
function crossTenantAggregateNames(ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  for (const agg of ctx.aggregates) {
    if (agg.crossTenant) out.add(agg.name);
  }
  return out;
}

/** The `<Agg> id` reference fields on an event (the id-typed fields).  These
 *  survive when a tenant-scoped event degrades to a refetch ticket. */
function idRefFields(ev: EventIR): { field: string; target: string }[] {
  const out: { field: string; target: string }[] = [];
  for (const f of ev.fields) {
    if (f.type.kind === "id") out.push({ field: f.name, target: f.type.targetName });
  }
  return out;
}

/** Event name → the aggregates whose action bodies `emit` it.  The emitting
 *  aggregate's stance classifies an event that carries no id reference at all
 *  (workflow-only emitters contribute nothing, which is why absence of evidence
 *  falls to the tenant-scoped default rather than to global). */
function emittersByEvent(ctx: BoundedContextIR): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const record = (event: string, agg: string): void => {
    const seen = out.get(event);
    if (seen) seen.add(agg);
    else out.set(event, new Set([agg]));
  };
  const scan = (s: StmtIR, agg: AggregateIR): void => {
    if (s.kind === "emit") record(s.eventName, agg.name);
    walkStmtChildren(
      s,
      () => {},
      (child) => scan(child, agg),
    );
  };
  for (const agg of ctx.aggregates) {
    for (const op of [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])]) {
      for (const s of op.statements) scan(s, agg);
    }
  }
  return out;
}

export interface RealtimeRoomPlan {
  /** The context scopes realtime delivery by tenant — true iff it hosts a
   *  `tenantOwned` aggregate whose events reach the broadcast wire.  False ⇒
   *  v1 broadcast-to-all (byte-identical output). */
  readonly tenantScoped: boolean;
  /** Broadcast-carried event types delivered only to the emitter's tenant room
   *  — everything a tenant-owned context carries except the events provably
   *  about `crossTenant` (shared) data. */
  readonly tenantEventTypes: ReadonlySet<string>;
  /** Per-tenant-event id-reference field names, kept when a tenant-scoped
   *  event is dispatched with no ambient request and degrades to a ticket.
   *  Empty for an event that carries no id reference — the ticket is then its
   *  `type` alone, which is the point: no scalar payload crosses tenants. */
  readonly eventIdFields: ReadonlyMap<string, readonly string[]>;
  /** The principal member holding the tenant room key — the system's
   *  `tenancy by user.<claim>`.  Each backend cases it for its own principal
   *  type (`OrgId` / `orgId` / `org_id`); NONE may spell `tenantId`, which is
   *  the ROW column, not the claim. */
  readonly tenantClaimField: string;
}

/** Derive the realtime room plan for a bounded context (pure).  A context with
 *  no tenant-owned aggregate — or none whose events reach the broadcast wire —
 *  is `tenantScoped: false`, so the emitter keeps its v1 broadcast output.
 *  `sys` supplies the tenancy declaration; it is required (never optional) so a
 *  caller that has no system in hand states that fact rather than silently
 *  inheriting the `tenantId` default. */
export function realtimeRoomPlan(
  ctx: BoundedContextIR,
  sys: Pick<SystemIR, "tenancy"> | undefined,
): RealtimeRoomPlan {
  const carried = realtimeEventTypes(ctx);
  const tenantAggs = tenantOwnedAggregateNames(ctx);
  const tenantEventTypes = new Set<string>();
  const eventIdFields = new Map<string, readonly string[]>();
  if (tenantAggs.size > 0) {
    const crossAggs = crossTenantAggregateNames(ctx);
    const emitters = emittersByEvent(ctx);
    const byName = new Map(ctx.events.map((e) => [e.name, e]));
    for (const type of carried) {
      const ev = byName.get(type);
      if (!ev) continue;
      const refs = idRefFields(ev);
      const sources = [...refs.map((r) => r.target), ...(emitters.get(type) ?? [])];
      // Global only on positive evidence: the event is about shared
      // (`crossTenant`) data and about no tenant-owned data.  Absent evidence
      // — an id-less event out of a tenant-owned context — is tenant-scoped.
      const touchesTenant = sources.some((n) => tenantAggs.has(n));
      const touchesShared = sources.some((n) => crossAggs.has(n));
      if (!touchesTenant && touchesShared) continue;
      tenantEventTypes.add(type);
      eventIdFields.set(
        type,
        refs.map((r) => r.field),
      );
    }
  }
  return {
    tenantScoped: tenantEventTypes.size > 0,
    tenantEventTypes,
    eventIdFields,
    tenantClaimField: tenancyPrincipalClaim(sys),
  };
}
