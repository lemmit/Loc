// Phoenix/Ash reified criteria — `find` path.  A repository `find` whose
// `where` is *exactly* a named `criterion` references the same `:boolean` Ash
// calculation a `retrieval` does (`filter expr(<calc>(arg: ^arg(:p)))`), instead
// of inlining the predicate.  A composed/anonymous `where` keeps inlining (the
// "if it has a name" rule).  A criterion shared by a find and a retrieval emits
// one calculation.  Behaviour — and cross-backend wire parity — is unchanged.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Shop {
      aggregate Customer { name: string  region: string  active: bool }
      repository Customers for Customer {
        find in_region(rgn: string): Customer[] where InRegion(rgn)
        find active_in_region(rgn: string): Customer[] where Active && InRegion(rgn)
      }
      criterion InRegion(rgn: string) of Customer = region == rgn
      criterion Active of Customer = active == true
      retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name desc] }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  ui W {}
  deployable api { platform: phoenixLiveView  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`;

async function customerResource(): Promise<string> {
  const out = (await generateSystems(await parseValid(SRC))).files;
  return out.get("api/lib/api/shop/customer.ex")!;
}

describe("phoenix generator — reified criteria (find)", () => {
  it("a single-criterion find filters by the reified calculation", async () => {
    const resource = await customerResource();
    expect(resource).toMatch(
      /read :in_region do[\s\S]*?filter expr\(in_region\(rgn: \^arg\(:rgn\)\)\)/,
    );
    // Not inlined.
    expect(resource).not.toMatch(/read :in_region do[\s\S]*?filter expr\(record\.region == /);
  });

  it("a composed find `where` stays inline", async () => {
    const resource = await customerResource();
    // `Active && InRegion(rgn)` has no single criterionRef → inlined predicate.
    expect(resource).toMatch(
      /read :active_in_region do[\s\S]*?filter expr\(record\.active == true and record\.region == /,
    );
  });

  it("a criterion shared by a find and a retrieval emits exactly one calculation", async () => {
    const resource = await customerResource();
    const calcs = resource.match(/calculate :in_region, :boolean,/g) ?? [];
    expect(calcs.length).toBe(1);
  });
});
