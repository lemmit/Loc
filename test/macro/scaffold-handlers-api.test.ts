// `scaffoldHandlers` (context) + `scaffoldApi` (api) stdlib macros
// (unfoldable-api-derivation.md, A3 + A3.2).  The two are a pair:
// `scaffoldHandlers` emits a `commandHandler` / `queryHandler` per eligible
// source of every aggregate in the context (operation, create, repository find,
// get-by-id read, and destroy when the aggregate has a canonical `destroy { }`);
// `scaffoldApi` emits the `route <M> … -> Context.Handler` that binds to it.
// Both derive names / methods / paths from the SAME shared helper, so a route
// can never target a handler the other didn't emit.
//
// Two things are pinned here:
//   1. Expansion — the macros splice the expected CommandHandler / QueryHandler /
//      Route AST for each source kind.
//   2. Equivalence — the macro output lowers to the SAME IR as the hand-written
//      explicit `commandHandler`/`queryHandler` + `route` form.
//
// `destroy` is emitted only for an aggregate carrying a canonical (unnamed)
// `destroy { }` — the handler body loads by id then `<Repo>.delete(o)` (a
// first-class `repo-delete` handler statement); the last test pins that.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import {
  type Api,
  type CommandHandler,
  isApi,
  isCommandHandler,
  isQueryHandler,
  type QueryHandler,
} from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/index.js";
import { parseString } from "../_helpers/parse.js";

// Level-0 surface: the whole application/transport layer is scaffolded — the
// context declares only the domain (aggregate + repository), the api only the
// `with scaffoldApi(of: Sales)` call.
const MACRO = `
  system Shop {
    subdomain Sales {
      context Ordering with scaffoldHandlers {
        aggregate Order {
          status: string
          operation cancel() { status := "cancelled" }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi with scaffoldApi(of: Sales)
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

// The equivalent fully-explicit source the scaffold expands to.  Note the
// get-by-id queryHandler + route are now part of the scaffolded surface.
const EXPLICIT = `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Order {
          status: string
          operation cancel() { status := "cancelled" }
        }
        repository Orders for Order { }
        queryHandler GetOrder(orderId: Order id): Order {
          let o = Orders.getById(orderId)
          return o
        }
        commandHandler CancelOrder(orderId: Order id) {
          let o = Orders.getById(orderId)
          o.cancel()
        }
      }
    }
    api SalesApi from Sales {
      route GET  "/orders/{orderId}"        -> Ordering.GetOrder
      route POST "/orders/{orderId}/cancel" -> Ordering.CancelOrder
    }
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("scaffoldHandlers + scaffoldApi — expansion (operation + get-by-id)", () => {
  it("parses + validates the level-0 scaffolded form with no errors", async () => {
    const { errors } = await parseString(MACRO);
    expect(errors).toEqual([]);
  });

  it("scaffoldHandlers splices a CancelOrder commandHandler into the context", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const cmd = [...AstUtils.streamAllContents(model)]
      .filter(isCommandHandler)
      .find((c) => c.name === "CancelOrder") as CommandHandler;
    expect(cmd).toBeDefined();
    // Param: `orderId: Order id` — NOT `id` (reserved), derived <camel(agg)>Id.
    expect(cmd.params.map((p) => p.name)).toEqual(["orderId"]);
    // Body: `let o = Orders.getById(orderId)` then `o.cancel()`.
    expect(cmd.body.map((s) => s.$type)).toEqual(["LetStmt", "AssignOrCallStmt"]);
    expect(cmd.returnType).toBeUndefined();
  });

  it("scaffoldHandlers splices a GetOrder get-by-id queryHandler into the context", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const q = [...AstUtils.streamAllContents(model)]
      .filter(isQueryHandler)
      .find((h) => h.name === "GetOrder") as QueryHandler;
    expect(q).toBeDefined();
    expect(q.params.map((p) => p.name)).toEqual(["orderId"]);
    expect(q.body.map((s) => s.$type)).toEqual(["LetStmt", "ReturnStmt"]);
    // Return type is the bare aggregate.
    expect(q.returnType.base.$type).toBe("NamedType");
  });

  it("scaffoldApi splices the get-by-id + operation routes into the api's routes[]", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    expect(
      api.routes.map(
        (r) => `${r.method} ${r.path} -> ${r.target.context.$refText}.${r.target.handler}`,
      ),
    ).toEqual([
      "GET /orders/{orderId} -> Ordering.GetOrder",
      "POST /orders/{orderId}/cancel -> Ordering.CancelOrder",
    ]);
  });
});

describe("scaffoldHandlers + scaffoldApi — equivalence with explicit form", () => {
  it("lowers to the SAME command/query handlers + routes IR as the hand-written form", async () => {
    const macro = await parseString(MACRO, { validate: false });
    const explicit = await parseString(EXPLICIT, { validate: false });

    const macroCtx = allContexts(lowerModel(macro.model)).find((c) => c.name === "Ordering")!;
    const explicitCtx = allContexts(lowerModel(explicit.model)).find((c) => c.name === "Ordering")!;

    const sliceCmd = (h: (typeof macroCtx.commandHandlers)[number]) => ({
      name: h.name,
      params: h.params.map((p) => p.name),
      statements: h.statements.map((s) => s.kind),
      saves: h.savesAtExit.map((s) => s.aggName),
      returnType: h.returnType,
    });
    const sliceQry = (h: NonNullable<typeof macroCtx.queryHandlers>[number]) => ({
      name: h.name,
      params: h.params.map((p) => p.name),
      statements: h.statements.map((s) => s.kind),
      saves: h.savesAtExit.map((s) => s.aggName),
    });
    expect(macroCtx.commandHandlers?.map(sliceCmd)).toEqual(
      explicitCtx.commandHandlers?.map(sliceCmd),
    );
    expect(macroCtx.queryHandlers?.map(sliceQry)).toEqual(explicitCtx.queryHandlers?.map(sliceQry));

    // Routes lower identically.
    const macroApi = lowerModel(macro.model).systems[0]!.apis.find((a) => a.name === "SalesApi")!;
    const explicitApi = lowerModel(explicit.model).systems[0]!.apis.find(
      (a) => a.name === "SalesApi",
    )!;
    expect(macroApi.routes).toEqual(explicitApi.routes);
    expect(macroApi.routes).toEqual([
      {
        method: "GET",
        path: "/orders/{orderId}",
        target: { context: "Ordering", handler: "GetOrder" },
      },
      {
        method: "POST",
        path: "/orders/{orderId}/cancel",
        target: { context: "Ordering", handler: "CancelOrder" },
      },
    ]);
  });

  it("IR-validates the scaffolded form with no errors (generation gate)", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const { validateLoomModel } = await import("../../src/ir/validate/validate.js");
    const errors = validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.severity === "error")
      .map((d) => `${d.code}: ${d.message}`);
    expect(errors).toEqual([]);
  });

  it("unfolds (prints) the scaffolded api head without a `from` clause", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    const printed = printStructural(api);
    expect(printed).toContain("api SalesApi");
    expect(printed).not.toContain(" from ");
    expect(printed).toContain('route POST "/orders/{orderId}/cancel" -> Ordering.CancelOrder');
  });
});

// A3.2 — create (commandHandler → POST /coll) + find (queryHandler → GET
// /coll/<find>) source kinds, plus the deliberate destroy deferral.
const A32 = `
  system Shop {
    subdomain Sales {
      context Ordering with scaffoldHandlers {
        aggregate Order {
          code: string
          status: string
          create(code: string) { code := code  status := "new" }
          operation cancel() { status := "cancelled" }
          destroy { }
        }
        repository Orders for Order {
          find byStatus(status: string): Order[] where this.status == status
        }
      }
    }
    api SalesApi with scaffoldApi(of: Sales)
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("scaffoldHandlers + scaffoldApi — A3.2 create / find source kinds", () => {
  it("parses + validates the create/find scaffolded form with no errors", async () => {
    const { errors } = await parseString(A32);
    expect(errors).toEqual([]);
  });

  it("emits a CreateOrder commandHandler over the create-input fields, returning Order id", async () => {
    const { model } = await parseString(A32, { validate: false });
    const cmd = [...AstUtils.streamAllContents(model)]
      .filter(isCommandHandler)
      .find((c) => c.name === "CreateOrder") as CommandHandler;
    expect(cmd).toBeDefined();
    // Params are the aggregate's create-input fields (not the create action's
    // declared params) so the factory-let sets every non-null field.
    expect(cmd.params.map((p) => p.name)).toEqual(["code", "status"]);
    // Body: `let o = Order.create({ code, status })` then `return o.id`.
    expect(cmd.body.map((s) => s.$type)).toEqual(["LetStmt", "ReturnStmt"]);
    // Return type `Order id`.
    expect(cmd.returnType?.base.$type).toBe("IdType");
  });

  it("emits a ByStatus queryHandler running the repository find, returning Order[]", async () => {
    const { model } = await parseString(A32, { validate: false });
    const q = [...AstUtils.streamAllContents(model)]
      .filter(isQueryHandler)
      .find((h) => h.name === "ByStatus") as QueryHandler;
    expect(q).toBeDefined();
    expect(q.params.map((p) => p.name)).toEqual(["status"]);
    expect(q.body.map((s) => s.$type)).toEqual(["LetStmt", "ReturnStmt"]);
    // Return type is the find's declared `Order[]`.
    expect(q.returnType.array).toBe(true);
    expect(q.returnType.base.$type).toBe("NamedType");
  });

  it("emits POST /orders (create) + GET /orders/by_status (find) routes", async () => {
    const { model } = await parseString(A32, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    const routes = api.routes.map((r) => `${r.method} ${r.path} -> ${r.target.handler}`);
    expect(routes).toContain("POST /orders -> CreateOrder");
    expect(routes).toContain("GET /orders/by_status -> ByStatus");
    // Full ordered surface: get-by-id, find, create, operation, destroy.
    expect(routes).toEqual([
      "GET /orders/{orderId} -> GetOrder",
      "GET /orders/by_status -> ByStatus",
      "POST /orders -> CreateOrder",
      "POST /orders/{orderId}/cancel -> CancelOrder",
      "DELETE /orders/{orderId} -> DestroyOrder",
    ]);
  });

  it("emits a DestroyOrder commandHandler + DELETE /orders/{orderId} route (canonical destroy)", async () => {
    const { model } = await parseString(A32, { validate: false });
    // The aggregate carries a canonical `destroy { }`, so the destroy target is
    // emitted: a void commandHandler whose body loads by id then `Orders.delete(o)`.
    const cmd = [...AstUtils.streamAllContents(model)]
      .filter(isCommandHandler)
      .find((c) => c.name === "DestroyOrder") as CommandHandler;
    expect(cmd).toBeDefined();
    expect(cmd.params.map((p) => p.name)).toEqual(["orderId"]);
    // Body: `let o = Orders.getById(orderId)` then `Orders.delete(o)`.
    expect(cmd.body.map((s) => s.$type)).toEqual(["LetStmt", "AssignOrCallStmt"]);
    // Void — no return value after a delete.
    expect(cmd.returnType).toBeUndefined();
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    const routes = api.routes.map((r) => `${r.method} ${r.path} -> ${r.target.handler}`);
    expect(routes).toContain("DELETE /orders/{orderId} -> DestroyOrder");
  });

  it("IR-validates the create/find scaffolded form with no errors (generation gate)", async () => {
    const { model } = await parseString(A32, { validate: false });
    const { validateLoomModel } = await import("../../src/ir/validate/validate.js");
    const errors = validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.severity === "error")
      .map((d) => `${d.code}: ${d.message}`);
    expect(errors).toEqual([]);
  });
});
