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
  deployable api { platform: elixir  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`;

async function files() {
  return (await generateSystems(await parseValid(SRC))).files;
}

describe("phoenix generator — retrieval read action", () => {
  it("emits an Ash read action with reified-criterion filter, sort, and offset pagination", async () => {
    const out = await files();
    const resource = out.get("api/lib/api/shop/customer.ex")!;
    expect(resource).toMatch(/read :by_region do/);
    expect(resource).toMatch(/argument :rgn, :string/);
    expect(resource).toMatch(/pagination offset\?: true, required\?: false/);
    expect(resource).toMatch(/prepare build\(sort: \[name: :desc\]\)/);
    // The `where: InRegion(rgn)` reifies to a boolean calculation the read
    // action filters by — not an inlined predicate.
    expect(resource).toMatch(/filter expr\(in_region\(rgn: \^arg\(:rgn\)\)\)/);
    expect(resource).not.toMatch(/filter expr\(region == \^arg\(:rgn\)\)/);
  });

  it("reifies the named criterion as a boolean calculation", async () => {
    const out = await files();
    const resource = out.get("api/lib/api/shop/customer.ex")!;
    // `criterion InRegion(rgn) = region == rgn` → a `:boolean` calculation
    // whose body matches the derived-calc receiver form (`record.<attr>`) and
    // whose param becomes a calc argument bound via `^arg`.
    expect(resource).toMatch(
      /calculate :in_region, :boolean, expr\(record\.region == \^arg\(:rgn\)\) do\n\s*argument :rgn, :string\n\s*end/,
    );
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
  deployable api { platform: elixir  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`),
      )
    ).files;
    const resource = out.get("api/lib/api/shop/order.ex")!;
    expect(resource).toMatch(/argument :floor, :decimal/);
    expect(resource).toMatch(/argument :top_rank, :integer/);
  });
});

// PR4 — `loads` / loadPlan fetch realisation on Phoenix/Ash.  A retrieval
// maps to `prepare build(load: [...])` on the read action, eager-loading
// every owned containment relationship (`has_many`/`has_one`) so a
// downstream operation can read `record.<part>` without a `%NotLoaded{}`
// crash.  Every retrieval loads the **whole** aggregate: explicit `loads:`
// narrowing is gated at IR validation (see retrieval-validator.test.ts —
// not supported until per-operation autoload lands), so even a retrieval
// that carries a narrowing `loads:` still loads every containment here.
// Cross-aggregate refs stay ids; embedded/document aggregates fold parts
// inline and emit no load.
const LOAD_SRC = `
system Sys {
  subdomain Sales {
    context Shop {
      aggregate Order {
        status: string
        contains lines: Line[]
        contains note: Note
        entity Line { sku: string }
        entity Note { text: string }
      }
      repository Orders for Order {}
      criterion Open(s: string) of Order = status == s
      retrieval Recent(s: string) of Order { where: Open(s) sort: [status asc] }
      retrieval Slim(s: string) of Order { where: Open(s) loads: [this.lines] }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  ui W {}
  deployable api { platform: elixir  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`;

/** Slice the body of one `read :<name> do … end` action out of a resource
 *  module so an assertion can't accidentally match a sibling action. */
function readAction(resource: string, name: string): string {
  const m = resource.match(new RegExp(`read :${name} do[\\s\\S]*?\\n {4}end`));
  expect(m, `read :${name} action not found`).not.toBeNull();
  return m![0];
}

describe("phoenix generator — retrieval load plan", () => {
  it("whole(T) eager-loads every owned containment relationship", async () => {
    const out = (await generateSystems(await parseValid(LOAD_SRC))).files;
    const recent = readAction(out.get("api/lib/api/shop/order.ex")!, "recent");
    expect(recent).toMatch(/prepare build\(load: \[:lines, :note\]\)/);
  });

  it("does not narrow — a retrieval carrying an explicit `loads:` still loads the whole aggregate", async () => {
    const out = (await generateSystems(await parseValid(LOAD_SRC))).files;
    // `Slim` declares `loads: [this.lines]`, but narrowing is gated at IR
    // validation, so the emitter loads every owned containment regardless
    // (whole-only) — `note` is loaded even though it is not in `loads:`.
    const slim = readAction(out.get("api/lib/api/shop/order.ex")!, "slim");
    expect(slim).toMatch(/prepare build\(load: \[:lines, :note\]\)/);
  });

  it("emits no load for embedded aggregates (parts fold inline)", async () => {
    const out = (
      await generateSystems(
        await parseValid(`
system Sys {
  subdomain Sales {
    context Shop {
      aggregate Order shape(embedded) {
        status: string
        contains lines: Line[]
        entity Line { sku: string }
      }
      repository Orders for Order {}
      criterion Open(s: string) of Order = status == s
      retrieval Recent(s: string) of Order { where: Open(s) }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  ui W {}
  deployable api { platform: elixir  contexts: [Shop]  dataSources: [st]  ui: W  port: 4000 }
}
`),
      )
    ).files;
    const recent = readAction(out.get("api/lib/api/shop/order.ex")!, "recent");
    expect(recent).not.toMatch(/prepare build\(load:/);
  });
});
