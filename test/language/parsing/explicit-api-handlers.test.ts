// Explicit application- + transport-layer surface (unfoldable-api-derivation.md
// Layers 3-4): `commandHandler` / `queryHandler` as context members and
// `route <METHOD> <PATH> -> <Context>.<Handler>` as an api-body member.
// Grammar surface only — no backend reads these yet.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type CommandHandler,
  isApi,
  isCommandHandler,
  isQueryHandler,
  type QueryHandler,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Order {
          code: string
          status: string
          operation cancel() { status := "cancelled" }
        }
        repository Orders for Order { }

        commandHandler CancelOrder(id: Order id) {
          let o = Orders.getById(id)
          o.cancel()
        }
        queryHandler GetOrder(id: Order id): Order {
          let o = Orders.getById(id)
        }
      }
    }
    api SalesApi from Sales {
      route POST   "/orders/{id}/cancellations" -> Ordering.CancelOrder
      route GET    "/orders/{id}"               -> Ordering.GetOrder
    }
    storage pg { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: pg }
    deployable api { platform: node, contexts: [Ordering], dataSources: [orderingState], serves: SalesApi, port: 4000 }
  }
`;

describe("explicit api handlers + routes — grammar surface", () => {
  it("parses commandHandler + queryHandler + route with no errors", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("produces CommandHandler / QueryHandler context-member AST nodes", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const nodes = [...AstUtils.streamAllContents(model)];
    expect(nodes.some(isCommandHandler)).toBe(true);
    expect(nodes.some(isQueryHandler)).toBe(true);
  });

  it("commandHandler may omit a return type; queryHandler requires one", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const nodes = [...AstUtils.streamAllContents(model)];
    const cmd = nodes.find(isCommandHandler) as CommandHandler;
    const qry = nodes.find(isQueryHandler) as QueryHandler;
    expect(cmd.returnType).toBeUndefined();
    expect(qry.returnType).toBeDefined();
  });

  it("attaches routes to the Api with a HandlerRef target", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const api = [...AstUtils.streamAllContents(model)].find(isApi)!;
    expect(
      api.routes.map(
        (r) => `${r.method} ${r.path} -> ${r.target.context.$refText}.${r.target.handler}`,
      ),
    ).toEqual([
      "POST /orders/{id}/cancellations -> Ordering.CancelOrder",
      "GET /orders/{id} -> Ordering.GetOrder",
    ]);
  });
});
