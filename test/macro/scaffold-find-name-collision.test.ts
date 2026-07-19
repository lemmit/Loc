// Regression: two aggregates in ONE context can declare a repository find of
// the same name.  Their scaffolded query handlers / contract records / routes
// must stay distinct per aggregate.
//
// From `docs/audits/repo-code-review-2026-07.md` C2: `targetHandlerName` used a
// bare `<Find>` for the find kind (unlike every other kind, which suffixes the
// aggregate name).  So `Orders.byStatus` and `Customers.byStatus` both derived
// handler `ByStatus`; the expander's scope-local override-by-name silently
// dropped the second `queryHandler` (and `ByStatusQuery` record) BEFORE
// validation, while `scaffoldApi` still emitted BOTH routes (`/orders/by_status`
// and `/customers/by_status`) — so one route bound to the surviving handler and
// served the WRONG aggregate's data, with no diagnostic.  Qualifying the find
// handler name (`ByStatusOrder` / `ByStatusCustomer`) keeps them distinct.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type Api,
  isApi,
  isPayloadDecl,
  isQueryHandler,
} from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const COLLIDING = `
  system Shop {
    subdomain Sales {
      context Ordering with scaffoldHandlers {
        aggregate Order {
          status: string
        }
        repository Orders for Order {
          find byStatus(status: string): Order[] where this.status == status
        }
        aggregate Customer {
          status: string
        }
        repository Customers for Customer {
          find byStatus(status: string): Customer[] where this.status == status
        }
      }
    }
    api SalesApi with scaffoldApi(of: Sales)
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("scaffold: same-named finds on two aggregates stay distinct", () => {
  it("emits BOTH query handlers, aggregate-qualified — neither is dropped", async () => {
    const { model } = await parseString(COLLIDING, { validate: false });
    const handlers = [...AstUtils.streamAllContents(model)]
      .filter(isQueryHandler)
      .map((h) => h.name);
    expect(handlers).toContain("ByStatusOrder");
    expect(handlers).toContain("ByStatusCustomer");
    // The old bug collapsed both to a single bare `ByStatus`.
    expect(handlers).not.toContain("ByStatus");
  });

  it("emits BOTH query contract records, aggregate-qualified", async () => {
    const { model } = await parseString(COLLIDING, { validate: false });
    const records = [...AstUtils.streamAllContents(model)].filter(isPayloadDecl).map((p) => p.name);
    expect(records).toContain("ByStatusOrderQuery");
    expect(records).toContain("ByStatusCustomerQuery");
    expect(records).not.toContain("ByStatusQuery");
  });

  it("binds each route to its own aggregate's handler", async () => {
    const { model } = await parseString(COLLIDING, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    const routes = api.routes.map((r) => `${r.method} ${r.path} -> ${r.target.handler}`);
    expect(routes).toContain("GET /orders/by_status -> ByStatusOrder");
    expect(routes).toContain("GET /customers/by_status -> ByStatusCustomer");
  });

  it("parses clean — no duplicate-handler diagnostics", async () => {
    const { errors } = await parseString(COLLIDING, { validate: true });
    expect(errors).toEqual([]);
  });
});
