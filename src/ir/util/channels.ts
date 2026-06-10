// Channel-derived helpers (channels.md / dispatch-delivery-semantics.md).
//
// Pure over the IR — shared by the schema emitter, the migrations builder,
// and the per-backend dispatch wiring, so "which events are durable" has one
// definition.

import type { BoundedContextIR } from "../types/loom-ir.js";

/** Event types carried by a channel that asks for durability
 *  (`retention: log | work`).  These route through the transactional
 *  outbox (`__loom_outbox` + relay) instead of the inline in-process
 *  dispatch; an `ephemeral` channel keeps the at-most-once path.
 *  (dispatch-delivery-semantics.md — `retention` is the opt-in knob.) */
export function durableEventTypes(ctx: BoundedContextIR): ReadonlySet<string> {
  const out = new Set<string>();
  for (const ch of ctx.channels ?? []) {
    if (ch.retention === "log" || ch.retention === "work") {
      for (const ev of ch.carries) out.add(ev);
    }
  }
  return out;
}

/** Event types carried by a `delivery: broadcast` channel — the
 *  UI-observable set (channels.md, Part I realtime).  The backend exposes
 *  these on the SSE wire (`GET /realtime/events`); `queue` channels are
 *  work distribution, never browser-observable. */
export function realtimeEventTypes(ctx: BoundedContextIR): ReadonlySet<string> {
  const out = new Set<string>();
  for (const ch of ctx.channels ?? []) {
    if (ch.delivery === "broadcast") {
      for (const ev of ch.carries) out.add(ev);
    }
  }
  return out;
}
