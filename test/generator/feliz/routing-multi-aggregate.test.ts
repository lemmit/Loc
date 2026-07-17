// Feliz multi-aggregate routing — a scaffolded ui with more than one aggregate
// produces one List/New/Detail page PER aggregate.  Those pages are role-scoped
// (`List`/`New`/`Detail`), so the F# `Page` union cases + per-page view fns +
// the `pageCmd` byId arms must be AGGREGATE-QUALIFIED (`OrderList`,
// `orderDetailView`, `| ProductDetail id ->`) — the bare name collided across
// aggregates and Fable refused to compile (`error 37: Duplicate definition of
// union case 'List'`, `error 39: pattern discriminator 'Detail' is not
// defined`).  This pins the qualification so a regression fails a fast
// generator test rather than only the (dotnet-gated) full-stack build.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Two crudish aggregates → two List + two New + two Detail scaffold pages.
const MULTI = `
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Sales {
      aggregate Product with crudish { sku: string  derived display: string = sku }
      aggregate Order with crudish { ref: string  derived display: string = ref }
      repository Products for Product { }
      repository Orders for Order { }
    }
  }
  ui WebApp with scaffold(subdomains: [Sales]) { api Shop: ShopApi }
  storage db { type: postgres }
  resource st { for: Sales, kind: state, use: db }
  deployable api { platform: node contexts: [Sales] dataSources: [st] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(MULTI);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz multi-aggregate routing — aggregate-qualified Page cases", () => {
  it("emits distinct qualified Page union cases (no duplicate List/New/Detail)", async () => {
    const app = await appFs();
    for (const c of [
      "ProductList",
      "ProductNew",
      "ProductDetail of string",
      "OrderList",
      "OrderNew",
      "OrderDetail of string",
    ]) {
      expect(app).toContain(`  | ${c}`);
    }
    // The bare role-scoped cases (which collided) must NOT appear as union decls.
    expect(app).not.toContain("  | List\n");
    expect(app).not.toContain("  | New\n");
    expect(app).not.toContain("  | Detail of string");
  });

  it("emits distinct qualified per-page view functions (no duplicate detailView)", async () => {
    const app = await appFs();
    expect(app).toContain("let productListView (model: Model)");
    expect(app).toContain("let orderListView (model: Model)");
    expect(app).toContain("let productDetailView (model: Model)");
    expect(app).toContain("let orderDetailView (model: Model)");
    // The bare `detailView`/`listView` (which collided) must not be defined.
    expect(app).not.toContain("let detailView (model: Model)");
    expect(app).not.toContain("let listView (model: Model)");
  });

  it("keys the pageCmd byId arms on the qualified Detail case", async () => {
    const app = await appFs();
    expect(app).toContain(
      "  | ProductDetail id -> Cmd.OfAsync.perform Api.productById id ProductByIdLoaded",
    );
    expect(app).toContain(
      "  | OrderDetail id -> Cmd.OfAsync.perform Api.orderById id OrderByIdLoaded",
    );
    // No bare `| Detail id ->` arm (undefined discriminator after qualification).
    expect(app).not.toContain("  | Detail id ->");
  });
});
