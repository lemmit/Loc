// node/Hono emission of a query-time projection `from <Workflow>` — the read
// goes to the workflow's saga-state table (`db.select().from(schema.<wf>)`), NOT
// a (non-existent) workflow repository.  The `where` pushes to SQL; the `select`
// projects instance fields off each row.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    subdomain D { context C {
      aggregate Order { total: int  operation place() { emit OrderPlaced { order: id } } }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      event Paid { order: Order id }
      workflow Fulfil {
        orderId: Order id
        attempts: int
        create(p: OrderPlaced) by p.order { emit Paid { order: p.order } }
      }
      projection ActiveFulfils {
        orderId: Order id
        attempts: int
        from Fulfil as f where f.attempts > 0
        select orderId = f.orderId, attempts = f.attempts
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: node  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

let cache: Map<string, string> | undefined;
async function routes(): Promise<string> {
  cache ??= (await generateSystems(await parseValid(SRC))).files;
  const k = [...cache.keys()].find((key) => key.endsWith("http/query-projections.ts"));
  expect(k, "query-projections.ts not emitted").toBeDefined();
  return cache.get(k!)!;
}

describe("node/Hono projection `from <Workflow>` emission", () => {
  it("reads the saga-state table directly (no workflow repository)", async () => {
    const r = await routes();
    expect(r).toContain(
      "const rows = await db.select().from(schema.fulfils).where(gt(schema.fulfils.attempts, 0));",
    );
    // A workflow has no repository — the broken `<Wf>Repository` reference must
    // never be emitted.
    expect(r).not.toContain("FulfilRepository");
  });

  it("imports the Drizzle operator the `where` needs", async () => {
    const r = await routes();
    expect(r).toContain('import { gt } from "drizzle-orm";');
  });

  it("projects instance fields off each row", async () => {
    const r = await routes();
    expect(r).toContain("orderId: r.orderId");
    expect(r).toContain("attempts: r.attempts");
  });
});
