// `persistence: mikroorm` FEATURE gates (M-T6.23).
//
// The MikroORM adapter reached full parity with drizzle on the PERSISTENCE axis
// (M-T6.9), but five NON-persistence features stayed gated `&& !usingMikro` in
// the Hono emitter: query-time projections, realtime SSE, the transactional
// outbox, timers, and broker channel drivers.  ALL FIVE EMITTERS HAVE NOW LANDED
// (M-T6.23 slices 1–5), so every clause is deleted and every case here asserts
// EMISSION instead of rejection.  The suite is kept as the RATCHET: re-adding
// any clause — or re-gating any emitter on `!usingMikro` — turns these red.
// Each one used to generate a
// project with the feature SILENTLY absent — the model validated clean, the CLI
// reported success, and the emitted tree simply had no `scheduler.ts` /
// `http/channels.ts` / `http/realtime.ts` / `http/query-projections.ts` / outbox
// wiring.  `docs/old/proposals/integrity-audit-2026-07-residue.md` R1 recorded
// the projection case; the other four were unrecorded.
//
// This suite pins BOTH directions of each gate: the mikroorm deployable is
// rejected (honest failure instead of a silent drop), and the SAME model on the
// default drizzle adapter stays clean (the gate keys on the adapter, not on the
// feature).  Deleting a clause is how the gap gets closed for real — when an
// emitter lands, its `rejects …` case here flips to the drizzle expectation.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** A one-context system whose `platform:` clause and context body are the
 *  variables — so the mikroorm and drizzle legs of each case are the SAME
 *  model modulo the realization block. */
const SYS = (platformClause: string, body: string, systemTail = "", depTail = ""): string => `
system Shop {
  subdomain Orders {
    context Orders {
      aggregate Order with crudish {
        status: string
        operation place() {
          status := "Placed"
          emit OrderPlaced { orderRef: id }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { orderRef: Order id }
${body}
    }
  }
  api A from Orders
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
${systemTail}
  deployable d {
    platform: ${platformClause}
    contexts: [Orders]
    dataSources: [s]
${depTail}
    serves: A
    port: 3000
  }
}`;

async function mikroDiags(
  body: string,
  systemTail = "",
  depTail = "",
  severity: "error" | "warning" = "error",
): Promise<string[]> {
  const src = SYS("node { persistence: mikroorm }", body, systemTail, depTail);
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === severity && d.code === "loom.mikroorm-unsupported")
    .map((d) => d.message);
}

/** A react frontend targeting `d` — the realtime CONSUMER whose presence decides
 *  whether the missing SSE wire is a broken feature (error) or an unobserved
 *  omission (warning). */
const FRONTEND_TAIL = `  ui Web { framework: react
    area Orders { page List "/" { } }
  }
  deployable web {
    platform: react
    targets: d
    hosts: [Web]
    port: 5173
  }`;

async function drizzleErrorCodes(body: string, systemTail = "", depTail = ""): Promise<string[]> {
  const src = SYS("node", body, systemTail, depTail);
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

// --- The five feature bodies (ALL FIVE CLOSED — every case asserts emission) -

/** Query-time projection (`from … select …`) — `http/query-projections.ts`.
 *  CLOSED by M-T6.23 slice 4 (kept here as the ratchet). */
const QUERY_TIME_PROJECTION = `
      projection Board {
        rowId: Order id
        status: string
        from Order as o
        select rowId = o.id, status = o.status
      }`;

/** `delivery: broadcast` — the SSE wire (`GET /realtime/events`).  CLOSED by
 *  M-T6.23 slice 5 (kept here as the ratchet). */
const BROADCAST_CHANNEL = `
      channel Live { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }`;

/** A durable channel WITH a local reactor — the transactional outbox + relay.
 *  CLOSED by M-T6.23 slice 1 (kept here as the ratchet). */
const DURABLE_WITH_REACTOR = `
      channel Work { carries: OrderPlaced  delivery: queue  retention: work }
      workflow React {
        orderId: Order id
        create(p: OrderPlaced) by p.orderRef {
          orderId := p.orderRef
        }
      }`;

/** A durable channel with NO subscriber — nothing for a relay to drain, so both
 *  adapters emit the same thing and the gate must NOT fire. */
const DURABLE_NO_REACTOR = `
      channel Work { carries: OrderPlaced  delivery: queue  retention: work }`;

/** A `timerSource` — `scheduler.ts`.  CLOSED by M-T6.23 slice 3 (kept here as
 *  the ratchet). */
const TIMER_EVENT = `
      event SweepTick { at: datetime }`;
const TIMER_TAIL = `  timerSource sweep { for: SweepTick, cron: "0 3 * * *" }`;

/** A broker-bound `channelSource` — `http/channels.ts`.  CLOSED by M-T6.23
 *  slice 2 (kept here as the ratchet). */
const BROKER_CHANNEL = `
      channel Bus { carries: OrderPlaced  delivery: queue  retention: work }`;
const BROKER_TAIL = `  storage bus { type: rabbitmq }
  channelSource lifecycleBus { for: Bus, use: bus }`;
/** The deployable must actually WIRE the source — an unwired channelSource is
 *  not a binding on any adapter. */
const BROKER_DEP_TAIL = `    channels: [lifecycleBus]`;

describe("persistence: mikroorm — feature gates are honest, not silent", () => {
  it("CLOSED (slice 4): a query-time projection generates — its read routes emit", async () => {
    // R1 closed: `http/query-projections.ts` emits on this adapter (aggregations
    // push down through the mikro QueryBuilder; the repository-sourced shape was
    // always adapter-neutral).  Emitter pins live in
    // `test/adapters/node-mikroorm-query-projections.test.ts`; this is the
    // ratchet.
    expect(await mikroDiags(QUERY_TIME_PROJECTION)).toEqual([]);
    expect(await mikroDiags(QUERY_TIME_PROJECTION, "", "", "warning")).toEqual([]);
  });

  it("CLOSED (slice 5): a broadcast channel generates — no warning either", async () => {
    // The wire emits now, so the WARNING goes too.  This case is the reason the
    // warning existed in the first place (an unobserved missing endpoint), and
    // asserting BOTH severities empty is what stops a future slice from quietly
    // reintroducing a "soft" gap.
    expect(await mikroDiags(BROADCAST_CHANNEL)).toEqual([]);
    expect(await mikroDiags(BROADCAST_CHANNEL, "", "", "warning")).toEqual([]);
  });

  it("CLOSED (slice 5): a frontend targeting the backend generates too", async () => {
    // The consumer-dependent severity split is gone with the gap: the frontend's
    // `src/api/realtime.ts` EventSource now has a route to subscribe to, so the
    // case that used to be the hard ERROR is simply valid.
    expect(await mikroDiags(BROADCAST_CHANNEL, FRONTEND_TAIL)).toEqual([]);
    expect(await mikroDiags(BROADCAST_CHANNEL, FRONTEND_TAIL, "", "warning")).toEqual([]);
  });

  it("CLOSED (slice 1): a durable channel with a reactor generates — the outbox emits", async () => {
    // The clause this used to assert is gone: the adapter emits the
    // `LoomOutboxRow` EntitySchema + `createOutboxDispatcher` / `startOutboxRelay`
    // over the EntityManager, so the at-least-once contract is honoured here.
    // Emitter pins live in `test/adapters/node-mikroorm-outbox.test.ts`; this is
    // the ratchet — a re-added gate fails right here.
    expect(await mikroDiags(DURABLE_WITH_REACTOR)).toEqual([]);
    expect(await mikroDiags(DURABLE_WITH_REACTOR, "", "", "warning")).toEqual([]);
  });

  it("CLOSED (slice 3): an owned timerSource generates — scheduler.ts emits", async () => {
    // `scheduler.ts` emits on the adapter now: pg-boss for `cron:`, setInterval
    // + a transaction-scoped advisory lock for `every:`, with the
    // `loom_timer_runs` watermark and the lock query on the EntityManager.
    // Emitter pins live in `test/adapters/node-mikroorm-timers.test.ts`.
    expect(await mikroDiags(TIMER_EVENT, TIMER_TAIL)).toEqual([]);
    expect(await mikroDiags(TIMER_EVENT, TIMER_TAIL, "", "warning")).toEqual([]);
  });

  it("CLOSED (slice 2): a broker-bound channelSource generates — the driver emits", async () => {
    // Both halves of this shape now emit on the adapter: `http/channels.ts`
    // (driver + producer tee + consumer loop, slice 2) and the outbox relay its
    // durable events ride (slice 1).  Emitter pins live in
    // `test/adapters/node-mikroorm-channels.test.ts`; this is the ratchet.
    expect(await mikroDiags(BROKER_CHANNEL, BROKER_TAIL, BROKER_DEP_TAIL)).toEqual([]);
    expect(await mikroDiags(BROKER_CHANNEL, BROKER_TAIL, BROKER_DEP_TAIL, "warning")).toEqual([]);
  });

  it("does NOT fire for a durable channel with no subscriber (identical on both adapters)", async () => {
    expect(await mikroDiags(DURABLE_NO_REACTOR)).toEqual([]);
  });
});

describe("persistence: mikroorm — the gates key on the ADAPTER, not the feature", () => {
  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    ["query-time projection", QUERY_TIME_PROJECTION, "", ""],
    ["broadcast channel", BROADCAST_CHANNEL, "", ""],
    ["durable channel + reactor", DURABLE_WITH_REACTOR, "", ""],
    ["timerSource", TIMER_EVENT, TIMER_TAIL, ""],
    ["broker channelSource", BROKER_CHANNEL, BROKER_TAIL, BROKER_DEP_TAIL],
  ];

  for (const [label, body, tail, depTail] of cases) {
    it(`accepts a ${label} on the default (drizzle) adapter`, async () => {
      expect(await drizzleErrorCodes(body, tail, depTail)).not.toContain(
        "loom.mikroorm-unsupported",
      );
    });
  }
});
