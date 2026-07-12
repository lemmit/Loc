// Workflow-sourced views on Hono (workflow-instance-views.md): `view X =
// <Workflow> where <pred>` emits a GET /views/<x> route reading the saga-state
// table with the predicate lowered to a Drizzle `where`, plus a `<View>Row` /
// `<View>Response` schema over the workflow's instance wire shape.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Order { total: int }
        enum FulfillmentStatus { Pending, Shipped }
        event PaymentReceived { order: Order id, amount: int }
        channel Lifecycle { carries: PaymentReceived  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment {
          orderId: Order id
          status: FulfillmentStatus
          create(paid: PaymentReceived) by paid.order { let x = paid.amount }
        }
        view ActiveFulfillments = OrderFulfillment where status == Pending
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: node  contexts: [Ops]  port: 3000 }
  }
`;

async function viewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/views.ts"));
  expect(path, "views.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono workflow-sourced view", () => {
  it("emits a <View>Row / <View>Response schema from the saga instance shape", async () => {
    const vf = await viewsFile();
    expect(vf).toMatch(/const ActiveFulfillmentsRow = z\.object\(\{/);
    expect(vf).toMatch(/orderId: z\.string\(\)/);
    expect(vf).toMatch(/status: FulfillmentStatusSchema/);
    expect(vf).toContain("const ActiveFulfillmentsResponse = z.array(ActiveFulfillmentsRow)");
  });

  it("emits a GET /active_fulfillments route reading the saga table with the lowered filter", async () => {
    const vf = await viewsFile();
    expect(vf).toContain('path: "/active_fulfillments",');
    expect(vf).toMatch(
      /db\.select\(\)\.from\(schema\.orderFulfillments\)\.where\(eq\(schema\.orderFulfillments\.status, "Pending"\)\)/,
    );
    // schema is a value import (db.select().from) + the drizzle op is imported.
    expect(vf).toContain('import * as schema from "../db/schema";');
    expect(vf).toMatch(/import \{ eq \} from "drizzle-orm";/);
  });
});

// An event-sourced workflow has no `<Wf>State` table, so a `view = <ESWorkflow>`
// can't push its filter into a SQL `where`.  Instead the route group-folds the
// workflow's `stream_type` slice of the shared per-context `<ctx>_events` log
// via the file-local `loadAll<T>` helper (the same one the ES instance LIST
// emits) and applies the filter IN-MEMORY with `.filter`.  The
// operationId / route path / projected wire shape stay identical to the state
// path — OpenAPI parity by construction.
const ES_SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentReceived { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentReceived { order: p.order, amount: 0 } }
    apply(pr: PaymentReceived) { total := total + pr.amount }
  }
  view BigTallies = Tally where total > 100
} } api A from O storage pg { type: postgres } deployable api { platform: node contexts: [O] serves: A port: 8080 } }`;

async function esViewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(ES_SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/views.ts"));
  expect(path, "views.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono event-sourced workflow-sourced view", () => {
  it("emits a <View>Row / <View>Response schema from the ES instance shape", async () => {
    const vf = await esViewsFile();
    expect(vf).toMatch(/const BigTalliesRow = z\.object\(\{/);
    expect(vf).toMatch(/orderId: z\.string\(\)/);
    expect(vf).toMatch(/total: z\.number\(\)\.int\(\)/);
    expect(vf).toContain("const BigTalliesResponse = z.array(BigTalliesRow)");
  });

  it("emits the file-local group-fold helper the ES instance LIST also uses", async () => {
    const vf = await esViewsFile();
    expect(vf).toContain("async function loadAllTally(");
    expect(vf).toContain(
      "function foldTally(key: string, events: Events.DomainEvent[]): TallyState {",
    );
    expect(vf).toContain(".from(schema.oEvents)");
  });

  it("group-folds the stream and applies the filter IN-MEMORY (no SQL where)", async () => {
    const vf = await esViewsFile();
    expect(vf).toContain("const rows = (await loadAllTally(db)).filter((r) => r.total > 100);");
    // The ES read does NOT push the predicate into a Drizzle query.
    expect(vf).not.toMatch(/db\.select\(\)\.from\([^)]*\)\.where\(/);
  });

  it("keeps the same operationId + route path as the state path", async () => {
    const vf = await esViewsFile();
    expect(vf).toContain('path: "/big_tallies",');
    expect(vf).toContain('operationId: "bigTalliesView",');
  });
});
