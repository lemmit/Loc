// `scaffoldHandlers` (context) + `scaffoldApi` (api) stdlib macros
// (unfoldable-api-derivation.md, A3).  The two are a pair: `scaffoldHandlers`
// emits a `commandHandler` per public operation of every aggregate in the
// context; `scaffoldApi` emits the `route POST … -> Context.Handler` that binds
// to it.  Both derive names/paths from the SAME shared helper, so a route can
// never target a handler the other didn't emit.
//
// Two things are pinned here:
//   1. Expansion — the macros splice the expected CommandHandler / Route AST.
//   2. Equivalence — the macro output lowers to the SAME IR as the hand-written
//      explicit `commandHandler` + `route` form.

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

// The equivalent fully-explicit source the scaffold expands to.
const EXPLICIT = `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Order {
          status: string
          operation cancel() { status := "cancelled" }
        }
        repository Orders for Order { }
        commandHandler CancelOrder(orderId: Order id) {
          let o = Orders.getById(orderId)
          o.cancel()
        }
      }
    }
    api SalesApi from Sales {
      route POST "/orders/{orderId}/cancel" -> Ordering.CancelOrder
    }
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("scaffoldHandlers + scaffoldApi — expansion", () => {
  it("parses + validates the level-0 scaffolded form with no errors", async () => {
    const { errors } = await parseString(MACRO);
    expect(errors).toEqual([]);
  });

  it("scaffoldHandlers splices a CancelOrder commandHandler into the context", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const cmd = [...AstUtils.streamAllContents(model)].find(isCommandHandler) as CommandHandler;
    expect(cmd).toBeDefined();
    expect(cmd.name).toBe("CancelOrder");
    // Param: `orderId: Order id` — NOT `id` (reserved), derived <camel(agg)>Id.
    expect(cmd.params.map((p) => p.name)).toEqual(["orderId"]);
    // Body: `let o = Orders.getById(orderId)` then `o.cancel()`.
    expect(cmd.body.map((s) => s.$type)).toEqual(["LetStmt", "AssignOrCallStmt"]);
    expect(cmd.returnType).toBeUndefined();
  });

  it("scaffoldApi splices the POST route into the api's routes[]", async () => {
    const { model } = await parseString(MACRO, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    expect(
      api.routes.map(
        (r) => `${r.method} ${r.path} -> ${r.target.context.$refText}.${r.target.handler}`,
      ),
    ).toEqual(["POST /orders/{orderId}/cancel -> Ordering.CancelOrder"]);
  });
});

describe("scaffoldHandlers + scaffoldApi — equivalence with explicit form", () => {
  it("lowers to the SAME commandHandler + route IR as the hand-written form", async () => {
    const macro = await parseString(MACRO, { validate: false });
    const explicit = await parseString(EXPLICIT, { validate: false });

    const macroCtx = allContexts(lowerModel(macro.model)).find((c) => c.name === "Ordering")!;
    const explicitCtx = allContexts(lowerModel(explicit.model)).find((c) => c.name === "Ordering")!;

    // Command handlers lower identically (name, params, statement kinds, exit-save).
    const slice = (h: (typeof macroCtx.commandHandlers)[number]) => ({
      name: h.name,
      params: h.params.map((p) => p.name),
      statements: h.statements.map((s) => s.kind),
      saves: h.savesAtExit.map((s) => s.aggName),
      returnType: h.returnType,
    });
    expect(macroCtx.commandHandlers?.map(slice)).toEqual(explicitCtx.commandHandlers?.map(slice));

    // Routes lower identically.
    const macroApi = lowerModel(macro.model).systems[0]!.apis.find((a) => a.name === "SalesApi")!;
    const explicitApi = lowerModel(explicit.model).systems[0]!.apis.find(
      (a) => a.name === "SalesApi",
    )!;
    expect(macroApi.routes).toEqual(explicitApi.routes);
    expect(macroApi.routes).toEqual([
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
    // The api carries no `from` — its surface comes from `with scaffoldApi(...)`.
    // The printer must render the optional `from` + withClause correctly.
    const { model } = await parseString(MACRO, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi) as Api;
    const printed = printStructural(api);
    expect(printed).toContain("api SalesApi");
    expect(printed).not.toContain(" from ");
    expect(printed).toContain('route POST "/orders/{orderId}/cancel" -> Ordering.CancelOrder');
  });
});
