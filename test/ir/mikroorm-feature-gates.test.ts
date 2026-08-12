// `persistence: mikroorm` FEATURE gates (M-T6.23).
//
// The MikroORM adapter reached full parity with drizzle on the PERSISTENCE axis
// (M-T6.9), but five NON-persistence features stayed gated `&& !usingMikro` in
// the Hono emitter: query-time projections, realtime SSE, the transactional
// outbox, timers, and broker channel drivers.  FOUR are still gated — the
// outbox EMITTER landed (slice 1), so its clause is deleted and its case here
// asserts emission instead of rejection.  Each one used to generate a
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

// --- The five feature bodies (one now CLOSED — see the outbox case) ---------

/** Query-time projection (`from … select …`) — `http/query-projections.ts`. */
const QUERY_TIME_PROJECTION = `
      projection Board {
        rowId: Order id
        status: string
        from Order as o
        select rowId = o.id, status = o.status
      }`;

/** `delivery: broadcast` — the SSE wire (`GET /realtime/events`). */
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

/** A `timerSource` — `scheduler.ts`. */
const TIMER_EVENT = `
      event SweepTick { at: datetime }`;
const TIMER_TAIL = `  timerSource sweep { for: SweepTick, cron: "0 3 * * *" }`;

/** A broker-bound `channelSource` — `http/channels.ts`. */
const BROKER_CHANNEL = `
      channel Bus { carries: OrderPlaced  delivery: queue  retention: work }`;
const BROKER_TAIL = `  storage bus { type: rabbitmq }
  channelSource lifecycleBus { for: Bus, use: bus }`;
/** The deployable must actually WIRE the source — an unwired channelSource is
 *  not a binding on any adapter. */
const BROKER_DEP_TAIL = `    channels: [lifecycleBus]`;

describe("persistence: mikroorm — feature gates are honest, not silent", () => {
  it("rejects a query-time projection (R1: emitted zero projection routes)", async () => {
    const msgs = await mikroDiags(QUERY_TIME_PROJECTION);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("query-time projection 'Board'");
    expect(msgs[0]).toContain("/projections/board");
  });

  it("warns (not errors) on a broadcast channel with no realtime consumer", async () => {
    // The fold/saga routing half of the channel works on this adapter, so a
    // model with no frontend must keep generating — the missing wire is recorded,
    // not fatal.  This is what keeps the fold/saga corpus features valid here.
    expect(await mikroDiags(BROADCAST_CHANNEL)).toEqual([]);
    const warns = await mikroDiags(BROADCAST_CHANNEL, "", "", "warning");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("'delivery: broadcast' channel");
    expect(warns[0]).toContain("fold/saga routing half of the channel is unaffected");
  });

  it("rejects a broadcast channel when a frontend targets the backend", async () => {
    // The frontend emits `src/api/realtime.ts` off the target's PLATFORM, so its
    // EventSource would poll a 404 — a broken feature, not a silent omission.
    const msgs = await mikroDiags(BROADCAST_CHANNEL, FRONTEND_TAIL);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("GET /realtime/events");
    expect(msgs[0]).toContain("frontend targeting it subscribes to");
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

  it("rejects an owned timerSource (scheduler.ts was never written)", async () => {
    const msgs = await mikroDiags(TIMER_EVENT, TIMER_TAIL);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("timerSource 'sweep'");
    expect(msgs[0]).toContain("scheduler.ts");
  });

  it("rejects a broker-bound channelSource (compose started a broker nothing used)", async () => {
    const msgs = await mikroDiags(BROKER_CHANNEL, BROKER_TAIL, BROKER_DEP_TAIL);
    // The broker DRIVER is the only remaining omission for this shape — the
    // `queue/work` channel's outbox half now emits (slice 1), so this is the one
    // diagnostic left.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("channelSource 'lifecycleBus'");
    expect(msgs[0]).toContain("http/channels.ts");
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
