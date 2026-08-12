// node MikroORM adapter — the realtime SSE wire (M-T6.23 slice 5, the last of
// the five).
//
// A `delivery: broadcast` channel makes its carried events UI-observable at
// `GET /realtime/events`: `http/realtime.ts` exports `realtimeTee(inner)` (the
// dispatcher decorator that copies every dispatched event onto the stream) and
// `realtimeRoutes()` (the SSE endpoint).  On the MikroORM adapter neither was
// emitted, so a `broadcast` channel lost the wire while keeping its routing half
// — which is why the interim gate had a CONSUMER-DEPENDENT severity: an error
// when a frontend targeted the backend (its EventSource would poll a 404),
// a warning otherwise.
//
// Both the gap and that severity split are gone: the module reads no `db` at all
// (`realtimeTee` decorates a dispatcher, `realtimeRoutes()` takes no handle), so
// the wire was adapter-independent all along.
//
// Runtime proof (booted, real Postgres): with the stream open, `place()` on an
// order delivers `event: OrderPlaced` + its JSON payload to the connected
// client — see the PR body.

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

/** A `delivery: broadcast` channel plus a folded projection, so the tee has to
 *  compose OVER another decorator (the fold) rather than sit alone. */
const sys = (persistence: string, frontend: boolean) => `
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
      channel Live { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
      projection Board keyed by orderRef {
        orderRef: Order id
        status: string
        on(e: OrderPlaced) { orderRef := e.orderRef  status := "Placed" }
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
${
  frontend
    ? `  ui Web {
    api Sales: A
    page Home { route: "/"  title: "Home"  body: Stack { Heading { "Home", level: 1 } } }
  }`
    : ""
}
  deployable d {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 4000
  }
${
  frontend
    ? `  deployable web {
    platform: react
    targets: d
    ui: Web { Sales: d }
    port: 5173
  }`
    : ""
}
}`;

describe("MikroORM realtime SSE wire", () => {
  it("emits http/realtime.ts with the tee and the SSE route", async () => {
    const files = await emit(sys("mikroorm", false));
    const rt = files.get("d/http/realtime.ts");
    expect(rt, "http/realtime.ts was not emitted on the mikroorm adapter").toBeDefined();
    const src = rt as string;
    expect(src).toContain("export function realtimeTee(inner: DomainEventDispatcher)");
    expect(src).toContain("export function realtimeRoutes()");
    // The module is persistence-INDEPENDENT: it must not reach for a db handle
    // on either adapter — that is why this slice is a gate deletion, not a port.
    expect(src).not.toContain("EntityManager");
    expect(src).not.toContain("drizzle");
    expect(src).not.toContain("db");
  });

  it("composes the tee over the projection fold on the mikro dispatcher", async () => {
    const app = (await emit(sys("mikroorm", false))).get("d/http/index.ts") as string;
    expect(app).toContain('import { realtimeRoutes, realtimeTee } from "./realtime";');
    // Order matters: the tee wraps the fold, so a folded event still reaches the
    // wire (the fold runs, then the copy).
    expect(app).toContain("realtimeTee(projectionTee(db, NoopDomainEventDispatcher))");
    expect(app).toContain('app.route("/api/realtime", realtimeRoutes());');
  });

  it("gives a frontend's EventSource a route to subscribe to", async () => {
    // The frontend emits `src/api/realtime.ts` off the target's PLATFORM, not its
    // persistence — which is exactly why the missing wire used to be a hard
    // ERROR for this shape.  Both halves must now exist.
    const files = await emit(sys("mikroorm", true));
    expect(files.get("d/http/realtime.ts")).toBeDefined();
    const client = files.get("web/src/api/realtime.ts");
    expect(client, "the frontend realtime client was not emitted").toBeDefined();
    expect(client as string).toContain("EventSource");
  });

  it("emits the same module on the default (drizzle) adapter", async () => {
    // The gate keyed on the ADAPTER, so drizzle is the control: byte-identical.
    const mikro = (await emit(sys("mikroorm", false))).get("d/http/realtime.ts") as string;
    const drizzle = (await emit(sys("drizzle", false))).get("d/http/realtime.ts") as string;
    expect(drizzle).toBeDefined();
    expect(mikro).toBe(drizzle);
  });

  it("raises no mikroorm diagnostic at all — the last of the five is closed", async () => {
    // Both severities, both shapes (with and without a frontend consumer): the
    // consumer-dependent split is gone with the gap it described.
    const services = createDddServices(NodeFileSystem);
    for (const frontend of [false, true]) {
      const doc = await parseHelper(services.Ddd)(sys("mikroorm", frontend), { validation: true });
      const diags = validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value as Model)))
        .filter((d) => d.code === "loom.mikroorm-unsupported")
        .map((d) => `${d.severity}: ${d.message}`);
      expect(diags).toEqual([]);
    }
  });
});
