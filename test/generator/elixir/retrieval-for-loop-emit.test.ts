// Phoenix/Ash workflow `for` loop emission (PR3-D-2): a `Repo.run` + `for`
// loop renders as the `run_<name>_<agg>!` bang call binding the page
// struct, then an `Enum.reduce_while` over `.results` whose body op-call
// threads `{:cont}`/`{:halt}`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

function sys(transactional: string): string {
  return `
system Sys {
  subdomain Sales {
    context Shop {
      aggregate Customer {
        name: string
        region: string
        active: bool
        operation deactivate() { active := false }
      }
      repository Customers for Customer {}
      criterion InRegion(rgn: string) of Customer = region == rgn
      retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name desc] }
      workflow deactivateRegion ${transactional} {
        create(rgn: string) {
          let matched = Customers.run(ByRegion(rgn), page: { offset: 0, limit: 100 })
          for c in matched { c.deactivate() }
        }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  ui W {}
  deployable api { platform: elixir  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`;
}

async function workflow(transactional = ""): Promise<string> {
  const files = (await generateSystems(await parseValid(sys(transactional)))).files;
  return files.get("api/lib/api/shop/workflows/deactivate_region.ex")!;
}

describe("phoenix generator — workflow for-loop", () => {
  it("binds Repo.run via the bang variant with a page keyword opt", async () => {
    const wf = await workflow();
    expect(wf).toMatch(
      /matched = Api\.Shop\.run_by_region_customer!\(rgn, page: \[offset: 0, limit: 100\]\)/,
    );
  });

  it("renders the loop as Enum.reduce_while over .results with cont/halt op-calls", async () => {
    const wf = await workflow();
    expect(wf).toMatch(/Enum\.reduce_while\(matched\.results, \{:ok, nil\}, fn c, _acc ->/);
    expect(wf).toMatch(/case Api\.Shop\.deactivate_customer\(c\) do/);
    expect(wf).toMatch(/\{:ok, updated\} -> \{:cont, \{:ok, updated\}\}/);
    expect(wf).toMatch(/err -> \{:halt, err\}/);
    // No throw / "not yet support" gate text leaks through.
    expect(wf).not.toMatch(/does not yet support/);
  });

  it("nests the bind + reduce_while inside Ash.transaction for a transactional workflow", async () => {
    const wf = await workflow("transactional");
    const txStart = wf.indexOf("Ash.transaction");
    const reduce = wf.indexOf("Enum.reduce_while");
    const caseResult = wf.indexOf("case result do");
    expect(txStart).toBeGreaterThanOrEqual(0);
    // reduce_while sits between the transaction open and the result case.
    expect(reduce).toBeGreaterThan(txStart);
    expect(caseResult).toBeGreaterThan(reduce);
  });
});
