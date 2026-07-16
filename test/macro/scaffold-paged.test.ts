// `scaffoldPaged` / `scaffoldPagedApi` — the ergonomic paged, criterion-filtered
// read (read-path-architecture.md, "The ergonomic default").  The two-macro pair
// mirrors the `scaffoldHandlers`(context) / `scaffoldApi`(api) split: the context
// macro emits a paged `queryHandler` over the read-only port
// (`<Repo>.run(<Criterion>(args))`) and the api macro emits the
// `/projections/<criterion>` route that binds to it.  Three things are pinned:
//   1. The expanded AST — the queryHandler shape (params + `<Agg> paged` return +
//      `run(<Criterion>(...))` body) and the route.
//   2. `printStructural` unfold — the ejected `.ddd` is real, re-parseable source.
//   3. End-to-end — the macro form generates a Hono project byte-identical to the
//      equivalent hand-written queryHandler + route.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type Api,
  type BoundedContext,
  isApi,
  isBoundedContext,
  isQueryHandler,
  type QueryHandler,
} from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/index.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

// A minimal single-backend system: an aggregate with a repository + a criterion,
// the context carrying `scaffoldPaged`, the api carrying `scaffoldPagedApi`.
const SRC = `
  system Shop {
    subdomain Sales {
      context Sales with scaffoldPaged(of: InRegion) {
        aggregate Order {
          region: string
          status: string
        }
        repository Orders for Order { }
        criterion InRegion(rgn: string) of Order = region == rgn
      }
    }
    api SalesApi with scaffoldPagedApi(of: InRegion) from Sales { }
    storage pg { type: postgres }
    resource st { for: Sales, kind: state, use: pg }
    deployable api { platform: node, contexts: [Sales], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

// The hand-written twin — the same paged queryHandler + route written out — used
// as the byte-identity anchor for the end-to-end generation.
const EXPLICIT = `
  system Shop {
    subdomain Sales {
      context Sales {
        aggregate Order {
          region: string
          status: string
        }
        repository Orders for Order { }
        criterion InRegion(rgn: string) of Order = region == rgn
        queryHandler ListOrderByInRegion(rgn: string): Order paged {
          let r = Orders.run(InRegion(rgn))
          return r
        }
      }
    }
    api SalesApi from Sales {
      route GET "/orders/projections/in_region" -> Sales.ListOrderByInRegion
    }
    storage pg { type: postgres }
    resource st { for: Sales, kind: state, use: pg }
    deployable api { platform: node, contexts: [Sales], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

async function parsedContext(): Promise<BoundedContext> {
  const { model } = await parseString(SRC, { validate: false });
  return [...AstUtils.streamAllContents(model)]
    .filter(isBoundedContext)
    .find((c) => c.name === "Sales") as BoundedContext;
}

describe("scaffoldPaged — paged criterion read over run(criterion)", () => {
  it("parses + validates the two-macro form with no errors", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("splices a paged queryHandler `List<Agg>By<Crit>` with the criterion's scalar params", async () => {
    const ctx = await parsedContext();
    const qh = (ctx.members ?? [])
      .filter(isQueryHandler)
      .find((h) => h.name === "ListOrderByInRegion");
    expect(qh).toBeDefined();
    const handler = qh as QueryHandler;
    // The criterion's own params ride as PLAIN scalar handler params — no query
    // record, and `page`/`pageSize` stay route-level.
    expect(handler.params.map((p) => p.name)).toEqual(["rgn"]);
    expect(handler.params[0]!.type.base.$type).toBe("PrimitiveType");
    // Return type `Order paged` — the aggregate's wire shape with a `paged` ctor.
    expect(handler.returnType.base.$type).toBe("NamedType");
    expect((handler.returnType.base as { target: { $refText: string } }).target.$refText).toBe(
      "Order",
    );
    expect(handler.returnType.ctors).toEqual(["paged"]);
  });

  it("builds the handler body as `let r = <Repo>.run(<Crit>(args))` + `return r`", async () => {
    const ctx = await parsedContext();
    const printed = printStructural(ctx);
    expect(printed).toContain("queryHandler ListOrderByInRegion(rgn: string): Order paged");
    expect(printed).toContain("let r = Orders.run(InRegion(rgn))");
    expect(printed).toContain("return r");
  });

  it("emits the matching `/projections/<criterion>` GET route on the api", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const api = [...AstUtils.streamAllContents(model)]
      .filter(isApi)
      .find((a) => a.name === "SalesApi") as Api;
    const printed = printStructural(api);
    expect(printed).toContain(
      'route GET "/orders/projections/in_region" -> Sales.ListOrderByInRegion',
    );
  });

  it("unfolds to re-parseable `.ddd` source (round-trip stable)", async () => {
    const ctx = await parsedContext();
    const printed = printStructural(ctx);
    // The ejected context re-prints identically (structural round-trip).
    expect(printStructural(ctx)).toBe(printed);
  });

  it("generates a Hono project byte-identical to the hand-written queryHandler + route", async () => {
    const macro = await generateSystemFiles(SRC);
    const explicit = await generateSystemFiles(EXPLICIT);
    const macroKeys = [...macro.keys()].sort();
    const explicitKeys = [...explicit.keys()].sort();
    expect(macroKeys).toEqual(explicitKeys);
    for (const k of macroKeys) {
      expect(macro.get(k), `content differs for ${k}`).toBe(explicit.get(k));
    }
  });

  it("emits the paged /projections route into the generated Hono routes file", async () => {
    const files = await generateSystemFiles(SRC);
    const routes = files.get("api/http/salesApi-routes.ts");
    expect(routes).toBeDefined();
    expect(routes!).toContain('path: "/orders/projections/in_region"');
    // The paged infra supplies page/pageSize/sort/dir as route query params.
    expect(routes!).toContain("findAllByInRegion(rgn, query.page, query.pageSize");
  });
});
