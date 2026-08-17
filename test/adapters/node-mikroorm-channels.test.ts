// node MikroORM adapter — broker-channel parity (M-T6.23 slice 2).
//
// A deployable that wires a broker-bound `channelSource` gets `http/channels.ts`
// (the driver, the producer publish tee, the consumer loop), the broker deps in
// `package.json`, and boot-time transport wiring in `index.ts`.  On the MikroORM
// adapter it got NONE of it: `emit.ts` computed `channelBindings` as `[]` for a
// mikroorm deployable, so the module was never emitted while system compose
// still provisioned the broker sidecar and injected its URL — a stack that boots
// with a live broker nothing publishes to or reads from.  That was a
// `loom.mikroorm-unsupported` error (the honest interim); this suite is the
// emitter that replaced it.
//
// The transport module itself reads no `db` (it is persistence-independent), so
// what these pins are really guarding is the SEAM: the publish tee composed over
// the MikroORM outbox dispatcher, and the relay publishing drained
// `__loom_outbox` rows to the broker (slice 1 landed the outbox half).  Runtime
// proof: `npm run test:channels-mikroorm`; compile proof: `tsc --noEmit` on the
// generated tree.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function emit(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(src, { validation: true });
  const parseErrors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const irErrors = validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
  expect([...parseErrors, ...irErrors], "validation errors").toEqual([]);
  return generateSystems(doc.parseResult.value as Model).files;
}

/** Producer + consumer over a redis-bound `broadcast`/`ephemeral` channel — the
 *  shape that turns the broker transport on at BOTH ends (a producer tee on the
 *  emitter, a consumer loop on the reactor host). */
const sys = (persistence: string, transport = "redis") => `
system M {
  api A from Sales
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { orderRef: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { orderRef: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
      workflow Fulfil {
        orderId: Order id
        create(p: OrderPlaced) by p.orderRef {
          orderId := p.orderRef
        }
      }
    }
  }
  storage pg { type: postgres }
  storage bus { type: ${transport} }
  resource s { for: Orders, kind: state, use: pg }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable api {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    channels: [lifecycleBus]
    serves: A
    port: 8080
  }
}`;

/** A DURABLE (`queue`/`work`) broker channel with no local reactor — the
 *  pure-producer shape whose events must reach the broker through the OUTBOX
 *  relay (slice 1), not the inline tee. */
const durableProducer = (persistence: string) => `
system M {
  api A from Sales
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { orderRef: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { orderRef: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: work }
    }
  }
  storage pg { type: postgres }
  storage bus { type: rabbitmq }
  resource s { for: Orders, kind: state, use: pg }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable api {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    channels: [lifecycleBus]
    serves: A
    port: 8080
  }
}`;

describe("MikroORM broker channels", () => {
  it("emits http/channels.ts with the driver, tee and consumer loop", async () => {
    const files = await emit(sys("mikroorm"));
    const ch = files.get("api/http/channels.ts");
    expect(ch, "http/channels.ts was not emitted on the mikroorm adapter").toBeDefined();
    const src = ch as string;
    expect(src).toContain('import { Redis } from "ioredis";');
    expect(src).toContain("export function createChannelTransports()");
    expect(src).toContain("export function channelPublishTee(");
    expect(src).toContain("export async function startChannelConsumers(");
    // The transport module is persistence-independent: it must not reach for a
    // db handle on either adapter.
    expect(src).not.toContain("EntityManager");
    expect(src).not.toContain("drizzle");
  });

  it("declares the broker dependency in package.json", async () => {
    const pkg = (await emit(sys("mikroorm"))).get("api/package.json") as string;
    expect(pkg).toContain('"ioredis"');
    // …and still the mikro driver, not drizzle.
    expect(pkg).toContain('"@mikro-orm/postgresql"');
    expect(pkg).not.toContain('"drizzle-orm"');
  });

  it("wires the transports + consumer loop at boot, over the mikro EntityManager", async () => {
    const index = (await emit(sys("mikroorm"))).get("api/index.ts") as string;
    expect(index).toContain(
      'import { channelPublishTee, createChannelTransports, startChannelConsumers } from "./http/channels";',
    );
    expect(index).toContain("const channelTransports = createChannelTransports();");
    // `db` here is the EntityManager (mikro connection), and the tee wraps the
    // in-process dispatcher built on it.
    expect(index).toContain("const db = orm.em;");
    expect(index).toContain(
      "const app = createApp(db, channelPublishTee(channelTransports, inProcessEvents));",
    );
    expect(index).toContain(
      "const stopChannelConsumers = await startChannelConsumers(channelTransports, inProcessEvents);",
    );
    expect(index).toContain("await stopChannelConsumers();");
    // No drizzle schema import survives on this adapter.
    expect(index).not.toContain('import * as schema from "./db/schema";');
  });

  it("routes a DURABLE broker channel through the outbox relay in RELAY mode", async () => {
    // The producer-only durable shape: capture lands in `__loom_outbox` (slice
    // 1), and the relay's dispatcher rides the publish tee so drained rows
    // publish to the broker.  This is the composition that made the outbox the
    // prerequisite slice.
    const files = await emit(durableProducer("mikroorm"));
    const index = files.get("api/index.ts") as string;
    expect(index).toContain(
      "const stopOutboxRelay = startOutboxRelay(db, channelPublishTee(channelTransports, inProcessEvents, { fromRelay: true }));",
    );
    expect(index).toContain(
      "const app = createApp(db, channelPublishTee(channelTransports, createOutboxDispatcher(db, inProcessEvents)));",
    );
    // The workflow-less producer file carries the mikro outbox machinery.
    const wf = files.get("api/http/workflows.ts") as string;
    expect(wf).toContain('import { LoomOutboxRow } from "../db/entities";');
    expect(wf).toContain("export function startOutboxRelay(\n  db: EntityManager,");
    expect(wf).not.toContain('from "drizzle-orm"');
    // …and the outbox table is in the entity set so `updateSchema()` makes it.
    const entities = files.get("api/db/entities.ts") as string;
    expect(entities).toMatch(/export const entities = \[[^\]]*LoomOutboxRowSchema[^\]]*\];/);
  });

  it("emits the same transport module on the default (drizzle) adapter", async () => {
    // The gate keyed on the ADAPTER, so the drizzle leg is the control: both
    // adapters must now produce the same broker module.
    const mikro = (await emit(sys("mikroorm"))).get("api/http/channels.ts") as string;
    const drizzle = (await emit(sys("drizzle"))).get("api/http/channels.ts") as string;
    expect(drizzle).toBeDefined();
    expect(mikro).toBe(drizzle);
  });

  it("no longer refuses to generate (the honest gate it replaced)", async () => {
    // `validateMikroOrmSupport`'s broker clause is deleted, so none of these
    // shapes may raise a mikroorm ERROR any more — a re-added gate fails here.
    const services = createDddServices(NodeFileSystem);
    for (const src of [sys("mikroorm"), sys("mikroorm", "rabbitmq"), durableProducer("mikroorm")]) {
      const doc = await parseHelper(services.Ddd)(src, { validation: true });
      const diags = validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value as Model)));
      expect(
        diags.filter((d) => d.severity === "error" && d.code === "loom.mikroorm-unsupported"),
      ).toEqual([]);
    }
  });

  it("emits the realtime SSE wire alongside the broker transport (slice 5)", async () => {
    // This case was slice 2's honesty check — it asserted the neighbouring
    // realtime gap still WARNED, so an earlier slice could not silently absorb
    // it.  Slice 5 closed that gap, so the case flips here, in the PR that
    // closed it: a `delivery: broadcast` channel now gets BOTH the broker
    // transport and the browser-observable wire, and no diagnostic at all.
    const files = await emit(sys("mikroorm"));
    expect(files.get("api/http/realtime.ts")).toBeDefined();
    const app = files.get("api/http/index.ts") as string;
    expect(app).toContain('import { realtimeRoutes, realtimeTee } from "./realtime";');
    expect(app).toContain('app.route("/api/realtime", realtimeRoutes());');
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(sys("mikroorm"), { validation: true });
    expect(
      validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value as Model)))
        .filter((d) => d.code === "loom.mikroorm-unsupported")
        .map((d) => d.message),
    ).toEqual([]);
  });
});
