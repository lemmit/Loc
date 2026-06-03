// .NET emission for `retrieval` (PR3-C): a context retrieval emits a
// Run<Name>Async repository method (where + sort + paging), and a
// workflow `Repo.run` + `for` loop renders as the method call + a
// `foreach` with a per-iteration SaveAsync.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
      operation deactivate() { active := false }
    }
    repository Customers for Customer { }
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name desc] }

    workflow deactivateRegion {
      create(rgn: string) {
      let matched = Customers.run(ByRegion(rgn), page: { offset: 0, limit: 100 })
      for c in matched {
        c.deactivate()
      }
    }
    }
  }
`;

async function files() {
  return generateDotnet(await parseValid(SRC));
}

describe(".NET generator — retrieval", () => {
  it("emits a Run<Name>Async repository method (where + sort + paging)", async () => {
    const out = await files();
    const repo = out.get("Infrastructure/Repositories/CustomerRepository.cs")!;
    expect(repo).toMatch(
      /public async Task<IReadOnlyList<Customer>> RunByRegionAsync\(string rgn, \(int\? offset, int\? limit\)\? page = null, CancellationToken ct = default\)/,
    );
    // `where: InRegion(rgn)` is exactly one named criterion → reified
    // (Slice 2b): the query consumes the criterion's `ToExpression()` rather
    // than inlining the predicate.
    expect(repo).toMatch(
      /var query = _db\.Customers\.Where\(new InRegionCriterion\(rgn\)\.ToExpression\(\)\)\.OrderByDescending\(x => x\.Name\)\.AsQueryable\(\);/,
    );
    expect(repo).toMatch(/if \(p\.offset is \{ \} off\) query = query\.Skip\(off\);/);
    expect(repo).toMatch(/if \(p\.limit is \{ \} lim\) query = query\.Take\(lim\);/);
    expect(repo).toMatch(/var result = await query\.ToListAsync\(ct\);/);
  });

  it("declares the method on the repository interface", async () => {
    const out = await files();
    const iface = out.get("Domain/Customers/ICustomerRepository.cs")!;
    expect(iface).toMatch(
      /Task<IReadOnlyList<Customer>> RunByRegionAsync\(string rgn, \(int\? offset, int\? limit\)\? page = null, CancellationToken ct = default\);/,
    );
  });

  it("renders the workflow Repo.run + for loop as the call + a foreach with SaveAsync", async () => {
    const out = await files();
    const handler = [...out.entries()].find(
      ([k, v]) => k.includes("DeactivateRegion") && v.includes("RunByRegionAsync"),
    )?.[1];
    expect(handler).toBeDefined();
    expect(handler!).toMatch(
      /var matched = await _customers\.RunByRegionAsync\(cmd\.Rgn, \(0, 100\), ct\);/,
    );
    expect(handler!).toMatch(/foreach \(var c in matched\)/);
    expect(handler!).toMatch(/c\.Deactivate\(\);/);
    expect(handler!).toMatch(/await _customers\.SaveAsync\(c, ct\);/);
  });
});

// PR4 — the retrieval `loadPlan` is a no-op on EF Core: owned containments
// (`OwnsOne`/`OwnsMany`) are always materialised with their owner, so
// `whole(T)` is satisfied for free and an explicit `loads:` can neither
// widen nor narrow the query (you can't project an owned navigation away).
// This guards against a future contributor "honouring" loads with a
// spurious `.Include` / projection that would diverge whole from explicit.
const LOADS_SRC = `
  context Sales {
    aggregate Order {
      status: string
      contains lines: Line[]
      contains notes: Note[]
      entity Line { sku: string }
      entity Note { text: string }
    }
    repository Orders for Order { }
    criterion Open(s: string) of Order = status == s
    retrieval Recent(s: string) of Order { where: Open(s) }
    retrieval Slim(s: string) of Order { where: Open(s) loads: [this.lines] }
  }
`;

/** The single `var query = _db.… .AsQueryable();` line of a Run<Name>Async. */
function queryLine(repo: string, method: string): string {
  const body = repo.slice(repo.indexOf(`Run${method}Async`));
  const m = body.match(/var query = _db\.[^\n]*\.AsQueryable\(\);/);
  expect(m, `query line for Run${method}Async not found`).not.toBeNull();
  return m![0];
}

describe(".NET generator — retrieval loadPlan (owned-type no-op)", () => {
  it("maps owned containments to OwnsMany (always loaded with the owner)", async () => {
    const out = await generateDotnet(await parseValid(LOADS_SRC));
    const cfg = out.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/\.OwnsMany<Line>\("_lines"/);
    expect(cfg).toMatch(/\.OwnsMany<Note>\("_notes"/);
  });

  it("whole and explicit-`loads` retrievals emit the identical query (no Include, no narrowing)", async () => {
    const out = await generateDotnet(await parseValid(LOADS_SRC));
    const repo = out.get("Infrastructure/Repositories/OrderRepository.cs")!;
    // Explicit `loads: [this.lines]` neither narrows nor Includes — the
    // query body is byte-identical to the default-whole retrieval's.
    expect(queryLine(repo, "Slim")).toBe(queryLine(repo, "Recent"));
    expect(repo).not.toMatch(/\.Include\(/);
  });
});
