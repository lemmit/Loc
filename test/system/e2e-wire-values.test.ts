// A `test e2e` body speaks WIRE, and four places in the renderer still spoke
// DOMAIN.  Each was invisible until a fixture first wrote the shape, because
// every one of them emits syntactically valid TypeScript that is wrong only at
// run time — the class this repo keeps finding by actually booting its output.
//
// All four were found in one sitting, writing the first runtime callers for
// `projection-aggregation` / `projection-groupby` (the e2e-less corpus
// fixtures):
//
//  1. a `money` literal in a request body rendered as a bare JSON NUMBER, where
//     every backend's create schema is a STRING (`moneySchema` / `decimal` /
//     `BigDecimal`) → 422 on the first `create` that carried money;
//  2. a numeric conversion (`decimal(row.revenue)`) rendered the domain idiom
//     `.toNumber()` — a decimal.js method that a wire STRING does not have —
//     and, keyed off the DECLARED type, dropped the coercion entirely wherever
//     the member was placeholder-typed (which, inside an e2e body, is
//     everywhere);
//  3. an inline api call as a receiver rendered `await __get(…).placedAt`,
//     which reads the member off the PROMISE (`undefined`) and leaves the
//     request in flight — the assertion compares undefined and the late
//     response lands after the case's database has closed;
//  4. `contains` on a wire STRING rendered `.contains(…)`, a method no JS value
//     has, because the collection-op marker is only set for typed receivers.
//
// Mutation-proven, each by the failure that found it: reverting (1) 422s the
// create, (2) compares "40.00" to 40, (3) reads undefined, (4) throws
// TypeError — see the projection fixtures' behavioral runs.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SYS = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        code: string
        total: money
        placedAt: datetime
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }

  test e2e "wire forms" against d {
    let o = api.orders.create({ code: "C1", total: money("10.00"), placedAt: "2026-08-01T09:00:00Z" })
    expect(api.orders.getById(o).code).toBe("C1")
    let read = api.orders.getById(o)
    expect(decimal(read.total)).toBe(10)
    expect(string(read.placedAt).contains("2026-08-01")).toBe(true)
  }
}
`;

async function spec(): Promise<string> {
  const files = await generateSystemFiles(SYS);
  const path = [...files.keys()].find((p) => p.endsWith(".e2e.test.ts"));
  expect(path, "an e2e suite was emitted").toBeTruthy();
  return files.get(path as string) as string;
}

describe("e2e renderer — wire forms, not domain idioms", () => {
  it("sends a money literal as a JSON string", async () => {
    const src = await spec();
    expect(src).toContain(`total: "10.00"`);
    // The bare-number form is what 422'd; keep it out for good.
    expect(src).not.toMatch(/total: 10\.00\b/);
  });

  it("numifies a converted wire value instead of calling a Decimal method", async () => {
    const src = await spec();
    expect(src).toContain("__num(read.total)");
    expect(src).not.toContain(".toNumber()");
    // The helper it references must actually be emitted into the suite.
    expect(src).toContain("function __num(");
  });

  it("parenthesizes an awaited call before a member access", async () => {
    const src = await spec();
    expect(src).toMatch(/expect\(\(await __get\(`[^`]+`\)\)\.code\)/);
    // `await x.code` reads `.code` off the promise — never emit it again.
    expect(src).not.toMatch(/expect\(await __get\(`[^`]+`\)\.code\)/);
  });

  it("dispatches `contains` on an untyped receiver through the helper", async () => {
    const src = await spec();
    expect(src).toContain("__contains(String(read.placedAt), ");
    expect(src).not.toContain(".contains(");
    expect(src).toContain("function __contains(");
  });

  it("emits no helper the body does not use", async () => {
    // The helpers are usage-derived (`body.includes("__x(")`) — the same
    // derive-don't-stamp rule the rest of the emitters follow, and what keeps
    // `test:biome-gen` from flagging a dead symbol.
    const src = await spec();
    expect(src).not.toContain("function __instant(");
    expect(src).not.toContain("function __delete(");
  });
});
