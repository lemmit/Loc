// `Repo.findAll(<Criterion>) sort: [...] loads: [...]` shaping (criterion.md,
// use site 3).  The trailing clauses thread into the synthetic
// `findAllBy<Criterion>` retrieval, so the existing retrieval emitters apply
// `.orderBy(...)` + the load shape on every backend — no new per-backend code.
// A content hash in the retrieval name keeps distinct shapes distinct while
// identical shapes dedupe; the language validator rejects the clauses on any
// non-findAll binding.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (body: string): string => `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order ids guid { code: string  status: Status  region: string }
      repository Orders for Order { }
      criterion ActiveOrder of Order = status != Cancelled
      command C {}
      workflow W { create(c: C) { ${body} } }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: hono  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function retrievals(body: string) {
  const { model } = await parseString(SYS(body), { validate: false });
  return allContexts(enrichLoomModel(lowerModel(model)))[0]!.retrievals;
}

async function langiumErrors(body: string): Promise<string[]> {
  const { diagnostics } = await parseString(SYS(body), { validate: true });
  return (diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
}

describe("findAll shaping — sort: / loads: thread into the synthetic retrieval", () => {
  it("a sorted findAll synthesises a retrieval carrying the sort terms", async () => {
    const rs = await retrievals(
      `let xs = Orders.findAll(ActiveOrder) sort: [region desc, code asc]
       for o in xs { }`,
    );
    const ret = rs.find((r) => r.name.startsWith("findAllByActiveOrderShaped"));
    expect(ret).toBeDefined();
    expect(ret?.sort.map((s) => [s.path[0]?.name, s.direction])).toEqual([
      ["region", "desc"],
      ["code", "asc"],
    ]);
    // The criterion still reifies (the predicate fn is shared).
    expect(ret?.criterionRef?.name).toBe("ActiveOrder");
  });

  it("an unshaped and a shaped findAll over one criterion get distinct retrievals", async () => {
    const rs = await retrievals(
      `let a = Orders.findAll(ActiveOrder)
       let b = Orders.findAll(ActiveOrder) sort: [code asc]
       for o in a { }
       for o in b { }`,
    );
    expect(rs.some((r) => r.name === "findAllByActiveOrder")).toBe(true);
    expect(rs.some((r) => r.name.startsWith("findAllByActiveOrderShaped"))).toBe(true);
  });

  it("identical shaping dedupes to one retrieval", async () => {
    const rs = await retrievals(
      `let a = Orders.findAll(ActiveOrder) sort: [code desc]
       let b = Orders.findAll(ActiveOrder) sort: [code desc]
       for o in a { }
       for o in b { }`,
    );
    expect(rs.filter((r) => r.name.startsWith("findAllByActiveOrderShaped"))).toHaveLength(1);
  });

  it("emits .orderBy(...) on Hono", async () => {
    const files = await generateSystemFiles(
      SYS(`let xs = Orders.findAll(ActiveOrder) sort: [code desc]
        for o in xs { }`),
    );
    const repo = [...files].find(([k]) => /order-repository\.ts$/.test(k))?.[1] ?? "";
    expect(repo).toContain(".orderBy(desc(schema.orders.code))");
  });

  it("rejects sort: / loads: on a non-findAll binding", async () => {
    const errs = await langiumErrors(`let n = c sort: [code desc]`);
    expect(errs.some((m) => /only allowed on a 'Repo.findAll/.test(m))).toBe(true);
  });

  it("rejects an unknown sort field via the retrieval validator", async () => {
    const { model } = await parseString(
      SYS(`let xs = Orders.findAll(ActiveOrder) sort: [nope desc]
        for o in xs { }`),
      { validate: false },
    );
    const { validateLoomModel } = await import("../../src/ir/validate/validate.js");
    const codes = validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
    expect(codes).toContain("loom.retrieval-sort-unknown-field");
  });
});
