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
    deployable api { platform: hono  contexts: [Ops]  port: 3000 }
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
