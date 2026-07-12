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

  it("inline `Repo.findAll(...) ignoring <Cap>` passes a DOMAIN FilterBypass (capability names), not EF filter names (audit S7)", async () => {
    const handler = get(await files(), "Application/Workflows/SweepHandler.cs");
    // The call site names the DOMAIN capability (`softDeletable`), NOT the EF
    // filter name (`IsDeletedFilter`) — the adapter owns that translation.
    expect(handler).toContain('bypass: FilterBypass.Bypass("softDeletable")');
    expect(handler).toContain("bypass: FilterBypass.BypassAll()");
    expect(handler).not.toContain("ignoreFilters");
    expect(handler).not.toContain("IsDeletedFilter");
  });

  it("the port's retrieval method takes a domain FilterBypass; the adapter translates it to EF filter names (audit S7)", async () => {
    const repo = get(await files(), "Infrastructure/Repositories/OrderRepository.cs");
    // Domain-termed port param — no EF `IgnoreQueryFilters` vocabulary in the
    // signature.
    expect(repo).toContain("FilterBypass bypass = default");
    expect(repo).not.toContain("bool ignoreAllFilters");
    expect(repo).not.toContain("string[]? ignoreFilters");
    // Adapter-side: `bypass.All` → IgnoreQueryFilters(); a named capability is
    // translated to its EF filter name via the generated (cap → filter) map.
    expect(repo).toContain("if (bypass.All) __q = __q.IgnoreQueryFilters();");
    expect(repo).toContain(
      'new (string Capability, string Filter)[] { ("softDeletable", "IsDeletedFilter") }',
    );
    expect(repo).toContain(
      ".Where(m => bypass.Capabilities.Contains(m.Capability)).Select(m => m.Filter).ToArray()",
    );
  });

  it("the interface port also takes the domain FilterBypass (no EF vocabulary)", async () => {
    const iface = get(await files(), "Domain/Orders/IOrderRepository.cs");
    expect(iface).toContain("FilterBypass bypass = default");
    expect(iface).not.toContain("ignoreFilters");
  });
});
