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

    workflow deactivateRegion(rgn: string) {
      let matched = Customers.run(ByRegion(rgn), page: { offset: 0, limit: 100 })
      for c in matched {
        c.deactivate()
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
    expect(repo).toMatch(
      /var query = _db\.Customers\.Where\(x => x\.Region == rgn\)\.OrderByDescending\(x => x\.Name\)\.AsQueryable\(\);/,
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
