import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

const wrap = (body: string) =>
  `system S { subdomain M { context C {
    ${body}
  }}}`;

describe("seed — parsing", () => {
  it("parses a named declarative seed dataset", async () => {
    const { errors } = await parseString(
      wrap(`
        aggregate Product { sku: string = "x" }
        repository Products for Product { }
        seed demo {
          Product { sku: "DEMO-1" }
          Product { sku: "DEMO-2" }
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("parses an anonymous (default-dataset) seed and the `raw` modifier", async () => {
    const { errors } = await parseString(
      wrap(`
        aggregate Product { sku: string = "x" }
        repository Products for Product { }
        seed raw {
          Product { sku: "A" }
        }
      `),
    );
    expect(errors).toEqual([]);
  });
});

describe("seed — validation (negative)", () => {
  it("flags a duplicate field within one row", async () => {
    const { errors } = await parseString(
      wrap(`
        aggregate Product { sku: string = "x" }
        repository Products for Product { }
        seed demo {
          Product { sku: "A", sku: "B" }
        }
      `),
    );
    expect(errors.some((e) => /Duplicate field 'sku'/.test(e))).toBe(true);
  });

  it("flags a seed row that references an aggregate from another context", async () => {
    const { errors } = await parseString(
      `system S { subdomain M {
        context Other {
          aggregate Widget { name: string = "x" }
          repository Widgets for Widget { }
        }
        context Home {
          aggregate Thing { name: string = "x" }
          repository Things for Thing { }
          seed demo {
            Widget { name: "nope" }
          }
        }
      }}`,
    );
    expect(errors.some((e) => /may only populate aggregates of its own context/.test(e))).toBe(
      true,
    );
  });
});

describe("seed — raw explicit-id path", () => {
  const base = `
    enum St { Draft, Done }
    aggregate Customer with crudish { name: string }
    aggregate Order with crudish { customerId: Customer id status: St }
    repository Customers for Customer { }
    repository Orders for Order { }
  `;

  it("parses a `raw` dataset with explicit id + literal FK columns", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed reference raw {
          Customer { id: "c1", name: "Acme" }
          Order { id: "o1", customerId: "c1", status: Draft }
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("flags an explicit `id` on the (non-raw) domain path", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed demo {
          Customer { id: "c1", name: "Acme" }
        }
      `),
    );
    expect(errors.some((e) => /explicit `id` requires `seed raw/.test(e))).toBe(true);
  });

  it("flags a value-object column on a raw row", async () => {
    const { errors } = await parseString(
      wrap(`
        valueobject Money { amount: decimal  currency: string }
        aggregate Product with crudish { price: Money }
        repository Products for Product { }
        seed reference raw {
          Product { id: "p1", price: Money { amount: 1.0, currency: "USD" } }
        }
      `),
    );
    expect(errors.some((e) => /raw rows\s+support scalar/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The four cross-backend seed crossings (`F2-SEED-*`,
// targets-completeness-2026-08-30).  Each parsed 0 errors / 0 warnings on main
// and then produced a DIFFERENT wrong thing per backend; the fix is one
// AST-tier rule all five inherit, so each test below is the gate's only proof.
// ---------------------------------------------------------------------------

describe("seed — dataset-name collision (F2-SEED-DATASET-NAME-COLLISION)", () => {
  const widget = `
    aggregate Widget with crudish { name: string }
    repository Widgets for Widget { }
  `;

  it("flags two datasets colliding under the PascalCase seeder name (default / Default)", async () => {
    const { errors } = await parseString(
      wrap(`${widget}
        seed default { Widget { name: "a" } }
        seed Default { Widget { name: "b" } }
      `),
    );
    expect(errors.some((e) => /Seed dataset 'Default' collides with 'default'/.test(e))).toBe(true);
  });

  it("flags two datasets colliding under the snake_case seeder name (demoSet / demo_set)", async () => {
    const { errors } = await parseString(
      wrap(`${widget}
        seed demoSet { Widget { name: "a" } }
        seed demo_set { Widget { name: "b" } }
      `),
    );
    expect(errors.some((e) => /Seed dataset 'demo_set' collides with 'demoSet'/.test(e))).toBe(
      true,
    );
  });

  it("does NOT flag names that collide under neither transform, nor same-name blocks (which merge)", async () => {
    const { errors } = await parseString(
      wrap(`${widget}
        seed ab { Widget { name: "a" } }
        seed a_b { Widget { name: "b" } }
        seed demoSet { Widget { name: "c" } }
        seed demoSet { Widget { name: "d" } }
      `),
    );
    expect(errors).toEqual([]);
  });
});

describe("seed — raw × shape: document (F2-SEED-RAW-DOCUMENT)", () => {
  const article = `
    aggregate Article shape: document, with crudish { title: string  viewCount: int }
    repository Articles for Article { }
  `;

  it("flags a raw row on a document-shaped aggregate (no per-field columns to INSERT into)", async () => {
    const { errors } = await parseString(
      wrap(`${article}
        seed wired raw {
          Article { id: "11111111-1111-1111-1111-111111111111", title: "Anchor", viewCount: 4 }
        }
      `),
    );
    expect(
      errors.some((e) => /shape: document` aggregate is stored as \(id, data, version\)/.test(e)),
    ).toBe(true);
  });

  it("leaves the DOMAIN path on a document aggregate alone — it is correct on every backend", async () => {
    const { errors } = await parseString(
      wrap(`${article}
        seed demo { Article { title: "Anchor", viewCount: 4 } }
      `),
    );
    expect(errors).toEqual([]);
  });
});

describe("seed — event-sourced + abstract rows (F2-SEED-EVENTSOURCED)", () => {
  it("flags a seed row on an event-sourced aggregate rather than dropping it", async () => {
    const { errors } = await parseString(
      wrap(`
        event Opened { account: Account id, owner: string }
        aggregate Account persistedAs: eventLog {
          owner: string
          balance: int
          create open(owner: string) { emit Opened { account: id, owner: owner } }
          apply(e: Opened) { owner := e.owner  balance := 0 }
        }
        repository Accounts for Account { }
        seed default { Account { owner: "seeded-alice" } }
      `),
    );
    expect(errors.some((e) => /Seed row on event-sourced aggregate 'Account'/.test(e))).toBe(true);
  });

  it("flags a seed row on an abstract base — the other half of the same silent per-row drop", async () => {
    const { errors } = await parseString(
      wrap(`
        abstract aggregate Base { name: string }
        aggregate Child extends Base with crudish { extra: int }
        repository Children for Child { }
        seed default { Base { name: "x" } }
      `),
    );
    expect(errors.some((e) => /Seed row on abstract aggregate 'Base'/.test(e))).toBe(true);
  });
});

describe("seed — tenantOwned domain path (F2-SEED-TENANT-NULL)", () => {
  const sys = (seedBlock: string) => `system S {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain M { context C {
      aggregate Invoice with tenantOwned, crudish { label: string  amount: int }
      aggregate Org with crudish { name: string }
      repository Invoices for Invoice { }
      ${seedBlock}
    }}
  }`;

  it("flags the domain seed path on a tenantOwned aggregate (no principal ⇒ NULL tenant)", async () => {
    const { errors } = await parseString(
      sys(`seed default { Invoice { label: "Seeded", amount: 5 } }`),
    );
    expect(
      errors.some((e) =>
        /Seed row on tenant-owned aggregate 'Invoice' uses the domain create path/.test(e),
      ),
    ).toBe(true);
  });

  it("accepts the raw path, which can carry the tenant columns explicitly", async () => {
    const { errors } = await parseString(
      sys(`seed wired raw {
        Invoice { id: "11111111-1111-1111-1111-111111111111", tenantId: "acme", dataKey: "acme", label: "Seeded", amount: 5 }
      }`),
    );
    expect(errors).toEqual([]);
  });
});
