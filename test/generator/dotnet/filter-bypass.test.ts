// .NET emission of the `ignoring` filter-bypass clause (named-filter-bypass.md
// §11) — the only honoring backend this slice.  A bypassed capability filter
// resolves to its EF named query filter and the read installs
// `.IgnoreQueryFilters(["<Name>"])` (or the parameterless overload for `*`) on
// the `_db.<Set>` IQueryable before `.Where(...)`.
//
// Covered: repository find, view (via mergeViewsAsFinds), and inline
// `Repo.findAll(...)` in a workflow body.  The EF filter name must match the
// `HasQueryFilter("<Name>", ...)` the entity configuration emits.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      criterion BigOrders() of Order = this.total > 0
      aggregate Order with softDeletable { total: int }
      repository OrderRepo for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
        find allRows(): Order[] ignoring *
        find normal(): Order[] where this.total > 0
      }
      view ActiveOrders = Order where this.total > 0 ignoring softDeletable
      workflow Sweep {
        create(x: int) {
          let xs = OrderRepo.findAll(BigOrders()) ignoring softDeletable
          let ys = OrderRepo.findAll(BigOrders()) ignoring *
          for o in xs { }
          for o in ys { }
        }
      }
    }}
    storage primary { type: postgres }
    deployable api { platform: dotnet  contexts: [C]  port: 3000 }
  }
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= (await generateSystems(await parseValid(SRC))).files;
  return cache;
}

function get(map: Map<string, string>, suffix: string): string {
  const k = [...map.keys()].find((key) => key.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return map.get(k!)!;
}

describe("dotnet ignoring filter-bypass emission", () => {
  it("emits the EF named filter the bypass resolves against", async () => {
    const cfg = get(
      await files(),
      "Infrastructure/Persistence/Configurations/OrderConfiguration.cs",
    );
    expect(cfg).toContain('builder.HasQueryFilter("IsDeletedFilter",');
  });

  it('find `ignoring <Cap>` → IgnoreQueryFilters(["<Name>"]) before Where', async () => {
    const repo = get(await files(), "Infrastructure/Repositories/OrderRepository.cs");
    expect(repo).toContain(
      '_db.Orders.IgnoreQueryFilters(["IsDeletedFilter"]).Where(x => x.Total > 0)',
    );
  });

  it("find `ignoring *` → parameterless IgnoreQueryFilters()", async () => {
    const repo = get(await files(), "Infrastructure/Repositories/OrderRepository.cs");
    expect(repo).toContain("_db.Orders.IgnoreQueryFilters().ToListAsync");
  });

  it("the view bypass rides the synthesized find", async () => {
    const repo = get(await files(), "Infrastructure/Repositories/OrderRepository.cs");
    expect(repo).toContain("public async Task<List<Order>> ActiveOrders(");
    // recent + the view both resolve to the same named filter → two installs.
    const named = [...repo.matchAll(/IgnoreQueryFilters\(\["IsDeletedFilter"\]\)/g)];
    expect(named.length).toBe(2);
  });

  it("inline `Repo.findAll(...) ignoring <Cap>` passes ignoreFilters; `*` passes ignoreAllFilters", async () => {
    const handler = get(await files(), "Application/Workflows/SweepHandler.cs");
    expect(handler).toContain('ignoreFilters: ["IsDeletedFilter"]');
    expect(handler).toContain("ignoreAllFilters: true");
  });

  it("the shared retrieval method exposes the bypass parameters", async () => {
    const repo = get(await files(), "Infrastructure/Repositories/OrderRepository.cs");
    expect(repo).toContain("bool ignoreAllFilters = false, string[]? ignoreFilters = null");
    expect(repo).toContain("if (ignoreAllFilters) __q = __q.IgnoreQueryFilters();");
  });
});
