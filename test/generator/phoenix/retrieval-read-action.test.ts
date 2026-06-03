// Phoenix/Ash emission for `retrieval` (PR3-D-1): a context retrieval
// emits an Ash read action (filter via ^arg binding + sort via prepare
// build + offset pagination) plus a `run_<name>_<agg>` code-interface
// define.  The workflow `for` loop (reduce_while) is a follow-up slice —
// for-each stays gated for now.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Shop {
      aggregate Customer { name: string  region: string  active: bool }
      repository Customers for Customer {}
      criterion InRegion(rgn: string) of Customer = region == rgn
      retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name desc] }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  ui W {}
  deployable api { platform: phoenixLiveView  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`;

async function files() {
  return (await generateSystems(await parseValid(SRC))).files;
}

describe("phoenix generator — retrieval read action", () => {
  it("emits an Ash read action with ^arg filter, sort, and offset pagination", async () => {
    const out = await files();
    const resource = out.get("api/lib/api/shop/customer.ex")!;
    expect(resource).toMatch(/read :by_region do/);
    expect(resource).toMatch(/argument :rgn, :string/);
    expect(resource).toMatch(/pagination offset\?: true, required\?: false/);
    expect(resource).toMatch(/prepare build\(sort: \[name: :desc\]\)/);
    // ^arg binding + bare attribute (no `record.` receiver).
    expect(resource).toMatch(/filter expr\(region == \^arg\(:rgn\)\)/);
    expect(resource).not.toMatch(/filter expr\(record\./);
  });

  it("exposes the retrieval as a run_<name>_<agg> code-interface define", async () => {
    const out = await files();
    const domain = out.get("api/lib/api/shop.ex")!;
    expect(domain).toMatch(/define :run_by_region_customer, action: :by_region, args: \[:rgn\]/);
  });

  it("maps non-string retrieval args to the matching Ash type", async () => {
    const out = (
      await generateSystems(
        await parseValid(`
system Sys {
  subdomain Sales {
    context Shop {
      aggregate Order { total: decimal  rank: int }
      repository Orders for Order {}
      criterion Big(floor: decimal) of Order = total > floor
      retrieval BigOrders(floor: decimal, topRank: int) of Order { where: Big(floor) }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  ui W {}
  deployable api { platform: phoenixLiveView  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`),
      )
    ).files;
    const resource = out.get("api/lib/api/shop/order.ex")!;
    expect(resource).toMatch(/argument :floor, :decimal/);
    expect(resource).toMatch(/argument :top_rank, :integer/);
  });
});
