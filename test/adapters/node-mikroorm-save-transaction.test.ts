// G2667-C4 — the MikroORM `save` had no transaction.
//
// Every mikro save opened only `this.em.fork({ keepTransactionContext: true })`
// and then ran its statements one after another: the root upsert, then the
// full-list replace of each reference set, then the full child sync of each
// containment.  `keepTransactionContext` only JOINS an ambient transaction, and
// the generated server has no `RequestContext` middleware (see `mikroConfig`'s
// `allowGlobalContext` comment), so on an ordinary route there was nothing to
// join — a save that failed after the root write left the children stale, with
// no rollback.  The drizzle sibling has always wrapped the same statements in
// `this.db.transaction(...)` (`repository-save-builder.ts`).
//
// All THREE mikro save emitters shared the shape (relational, embedded,
// document/blob), so all three are pinned.  The relational case is the one that
// makes the bug visible: assoc + containment writes are extra statements.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

function sys(shape: string): string {
  return `
  system S {
    subdomain D { context C {
      aggregate Order ${shape} with crudish {
        total: int
        tags: Tag id[]
        contains lines: Line[]
        entity Line { sku: string  qty: int }
      }
      aggregate Tag with crudish { label: string }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api {
      platform: node { persistence: mikroorm }
      contexts: [C]
      dataSources: [cState]
      port: 3000
    }
  }`;
}

async function saveMethod(shape: string): Promise<string> {
  const files = await generateSystemFiles(sys(shape));
  const k = [...files.keys()].find((key) => key.endsWith("db/repositories/order-repository.ts"));
  expect(k, "order-repository.ts not emitted").toBeDefined();
  const file = files.get(k!)!;
  const start = file.indexOf("  async save(");
  expect(start, "save() not emitted").toBeGreaterThanOrEqual(0);
  const end = file.indexOf("\n  }\n", start);
  return file.slice(start, end);
}

describe.each([
  ["", "relational"],
  ["shape: embedded,", "embedded"],
  ["shape: document,", "document"],
])("mikroorm save runs in one transaction (%s → %s)", (shape) => {
  it("opens a real transaction around the write statements", async () => {
    const body = await saveMethod(shape);
    expect(body).toContain(
      "await this.em.fork({ keepTransactionContext: true }).transactional(async (em) => {",
    );
    // The bare fork-without-transaction form is the defect itself.
    expect(body).not.toContain("const em = this.em.fork({ keepTransactionContext: true });");
  });

  it("the version CAS read is INSIDE the transaction, not before it", async () => {
    const body = await saveMethod(shape);
    // A read-then-write guard outside a transaction is a race by construction.
    const tx = body.indexOf(".transactional(");
    const read = body.indexOf("await em.findOne(");
    expect(read, "the CAS findOne is emitted").toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(tx);
  });

  it("event dispatch stays OUTSIDE the transaction (after commit)", async () => {
    const body = await saveMethod(shape);
    // Dispatching inside would fan handlers out on uncommitted state — the
    // drizzle sibling drains after the tx closes for the same reason.
    expect(body.indexOf("});")).toBeLessThan(body.indexOf("aggregate.pullEvents()"));
  });
});

describe("mikroorm relational save — the multi-statement case the row names", () => {
  it("the assoc replace and the containment sync are in the same transaction", async () => {
    const body = await saveMethod("");
    const tx = body.indexOf(".transactional(");
    const close = body.indexOf("\n    });", tx);
    const inside = body.slice(tx, close);
    // Full-list replace of the `tags` reference set…
    expect(inside).toContain("await em.nativeDelete(OrderTagsRow,");
    expect(inside).toContain("await em.insert(OrderTagsRow,");
    // …and the full child sync of the `lines` containment.
    expect(inside).toContain("await em.nativeDelete(LineRow,");
    expect(inside).toContain("await em.upsert(LineRow,");
  });
});
