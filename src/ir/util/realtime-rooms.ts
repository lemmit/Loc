// Policy-derived realtime routing (channels.md — "Realtime topology": rooms +
// policy-derived routing v1).  Pure over the IR: derives, per bounded context,
// whether its realtime SSE wire scopes delivery by tenant, which carried events
// are tenant-scoped, and the id-reference fields kept when a tenant-scoped
// event must degrade to a refetch ticket.
//
// The single DataKey v1 derives is the TENANT (`currentUser.tenantId`) — the
// equality part of the `tenantOwned` read policy (`this.tenantId ==
// currentUser.tenantId`), the canonical multi-tenancy scoping column.  A
// context with no tenant-owned aggregate keeps v1 broadcast-to-all
// (byte-identical output); finer-than-tenant (per-owner) rooms are a v2 knob.

import type { BoundedContextIR, EventIR } from "../types/loom-ir.js";
import { realtimeEventTypes } from "./channels.js";

/** Aggregate names carrying the `tenantOwned` capability — the tenant column +
 *  claim stamp + `this.tenantId == currentUser.tenantId` read filter. */
function tenantOwnedAggregateNames(ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  for (const agg of ctx.aggregates) {
    if (agg.capabilities?.includes("tenantOwned")) out.add(agg.name);
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

export interface RealtimeRoomPlan {
  /** The context scopes realtime delivery by tenant — true iff it hosts a
   *  `tenantOwned` aggregate whose events reach the broadcast wire.  False ⇒
   *  v1 broadcast-to-all (byte-identical output). */
  readonly tenantScoped: boolean;
  /** Broadcast-carried event types whose payload references a `tenantOwned`
   *  aggregate — delivered only to the emitter's tenant room. */
  readonly tenantEventTypes: ReadonlySet<string>;
  /** Per-tenant-event id-reference field names, kept when a tenant-scoped
   *  event is dispatched with no ambient request and degrades to a ticket. */
  readonly eventIdFields: ReadonlyMap<string, readonly string[]>;
}

/** Derive the realtime room plan for a bounded context (pure).  A context with
 *  no tenant-owned aggregate — or none whose events reach the broadcast wire —
 *  is `tenantScoped: false`, so the emitter keeps its v1 broadcast output. */
export function realtimeRoomPlan(ctx: BoundedContextIR): RealtimeRoomPlan {
  const carried = realtimeEventTypes(ctx);
  const tenantAggs = tenantOwnedAggregateNames(ctx);
  const tenantEventTypes = new Set<string>();
  const eventIdFields = new Map<string, readonly string[]>();
  if (tenantAggs.size > 0) {
    const byName = new Map(ctx.events.map((e) => [e.name, e]));
    for (const type of carried) {
      const ev = byName.get(type);
      if (!ev) continue;
      const refs = idRefFields(ev);
      // Tenant-scoped: the event carries a reference to a tenant-owned
      // aggregate, so its audience is the emitter's tenant.
      if (refs.some((r) => tenantAggs.has(r.target))) {
        tenantEventTypes.add(type);
        eventIdFields.set(
          type,
          refs.map((r) => r.field),
        );
      }
    }
  }
  return {
    tenantScoped: tenantEventTypes.size > 0,
    tenantEventTypes,
    eventIdFields,
  };
}
