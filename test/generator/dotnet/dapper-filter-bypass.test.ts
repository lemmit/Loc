// `persistence: dapper` honours the `ignoring` filter-bypass clause
// (named-filter-bypass.md §11) — the Dapper twin of `filter-bypass.test.ts`
// (which covers the EF adapter's `.IgnoreQueryFilters(…)`).
//
// Dapper has no EF `HasQueryFilter`, so there is nothing to "ignore": the
// capability predicate is SPLICED into every SELECT's WHERE by the emitter, and
// the bypass is therefore expressed by OMITTING that conjunct from the
// generated SQL.  Before this gate the emitter had zero `bypass` references —
// `ignoring softDeletable` on a `persistence: dapper` deployable compiled
// green and still filtered the rows out, which is the silent shape of the bug
// (`bypassSupported` passes the whole `dotnet` family on the strength of the
// EF adapter alone).
//
// Two paths, because the bypass arrives differently:
//   - a repository `find … ignoring <Cap>` is STATIC (part of the declaration)
//     → the predicate is simply never emitted into that method's SQL;
//   - a retrieval `Run<Name>Async` takes a RUNTIME `FilterBypass bypass` port
//     param (bound by a workflow's inline `Repo.run(...) ignoring …`), so the
//     SQL is composed per call from the capability predicates the caller did
//     not name.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    capability tenantScoped { tenantKey: string  filter this.tenantKey == "acme" }
    subdomain D { context C {
      criterion BigOrders() of Order = this.total > 0
      aggregate Order with softDeletable, tenantScoped { total: int }
      repository OrderRepo for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
        find allRows(): Order[] ignoring *
        find normal(): Order[] where this.total > 0
      }
      workflow Sweep {
        create(x: int) {
          let xs = OrderRepo.findAll(BigOrders()) ignoring softDeletable
          for o in xs { }
        }
      }
    }}
    storage primary { type: postgres }
    deployable api { platform: dotnet { persistence: dapper }  contexts: [C]  port: 3000 }
  }
`;

let cache: Map<string, string> | undefined;
async function repo(): Promise<string> {
  cache ??= await generateSystemFiles(SRC);
  const key = [...cache.keys()].find((k) =>
    k.endsWith("Infrastructure/Repositories/OrderRepository.cs"),
  );
  expect(key, "OrderRepository.cs not emitted").toBeDefined();
  return cache.get(key!)!;
}

/** The body of one emitted repository method, so an assertion about `recent()`
 *  can't be satisfied by SQL belonging to `normal()`. */
function method(src: string, signatureFragment: string): string {
  const start = src.indexOf(signatureFragment);
  expect(start, `method ${signatureFragment} not emitted`).toBeGreaterThan(-1);
  const end = src.indexOf("\n    public ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("dapper ignoring filter-bypass emission", () => {
  it("a find with no `ignoring` still carries every capability predicate", async () => {
    const normal = method(await repo(), "public async Task<List<Order>> Normal(");
    expect(normal).toContain("(is_deleted = FALSE)");
    expect(normal).toContain("(tenant_key = 'acme')");
  });

  it("`find … ignoring <Cap>` OMITS that capability's predicate, keeping the others", async () => {
    const recent = method(await repo(), "public async Task<List<Order>> Recent(");
    // The whole point: the bypassed capability's conjunct is gone from the SQL.
    expect(recent).not.toContain("is_deleted = FALSE");
    // …and the capability that was NOT named still scopes the read.
    expect(recent).toContain("(tenant_key = 'acme')");
    expect(recent).toContain("(total > 0)");
  });

  it("`find … ignoring *` drops every capability predicate", async () => {
    const all = method(await repo(), "public async Task<List<Order>> AllRows(");
    expect(all).not.toContain("is_deleted = FALSE");
    expect(all).not.toContain("tenant_key = 'acme'");
    expect(all).toContain("FROM orders");
    expect(all).not.toContain("WHERE");
  });

  it("a retrieval composes its WHERE from the runtime FilterBypass (capability names, not EF filter names)", async () => {
    const run = method(
      await repo(),
      "public async Task<IReadOnlyList<Order>> RunFindAllByBigOrdersAsync(",
    );
    // Each spliced capability predicate is guarded by the DOMAIN capability
    // name the `ignoring` clause spells — the adapter owns the mapping, the
    // port stays ORM-neutral (audit S7).
    expect(run).toContain('bypass.Capabilities?.Contains("softDeletable") != true');
    expect(run).toContain('bypass.Capabilities?.Contains("tenantScoped") != true');
    expect(run).toContain("!bypass.All");
    // Composed, not baked: the predicates join the SQL only when kept.
    expect(run).toContain('string.Join(" AND ", __caps)');
    // The retrieval's own predicate is NOT bypassable — it is the query.
    expect(run).toContain("WHERE (total > 0)");
  });

  it("the inline workflow read still passes a DOMAIN FilterBypass to the Dapper repository", async () => {
    const files = await generateSystemFiles(SRC);
    const key = [...files.keys()].find((k) => k.endsWith("Application/Workflows/SweepHandler.cs"));
    expect(key, "SweepHandler.cs not emitted").toBeDefined();
    expect(files.get(key!)).toContain('bypass: FilterBypass.Bypass("softDeletable")');
  });
});
