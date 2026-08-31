// ---------------------------------------------------------------------------
// `loom.op-form-needs-route-id` — the semantic residue of F2-CFE-5.
//
// `OperationForm { of: <Agg>, op: <op> }` names the operation but no RECORD, so
// every frontend resolves the target from the page's route `:id`
// (`emitFormOfOperationByName` pushes `idExpr: 'id ?? ""'`).  Wave 2 fixed the
// COMPILE half — the shells now actually bind that `id` — which left the
// semantic half: on a route with no `:id` the form renders and submits against
// an empty id.
//
// Measured on `main` before this gate: `page A { route: "/a" body: Stack {
// OperationForm { of: Item, op: activate } } }` parsed with 0 diagnostics and
// emitted `const activate = useActivateItem(id ?? "");` under a `useParams`
// destructure that can only ever yield `undefined`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.op-form-needs-route-id";

const wrap = (pages: string) => `
system Demo {
  subdomain S {
    context Shop {
      aggregate Item with crudish {
        name: string
        operation activate() { }
      }
      repository Items for Item { }
    }
  }
  api ShopApi from S
  ui Web {
    framework: react
    api Shop: ShopApi
    ${pages}
  }
  storage primarySql { type: postgres }
  resource shopState { for: Shop, kind: state, use: primarySql }
  deployable api { platform: node contexts: [Shop] dataSources: [shopState] serves: ShopApi port: 3000 }
  deployable web { platform: static targets: api ui: Web { Shop: api } port: 3001 }
}`;

async function codes(pages: string): Promise<string[]> {
  const { model, errors } = await parseString(wrap(pages));
  if (errors.length) throw new Error(`unexpected parse errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

describe("loom.op-form-needs-route-id — the gate", () => {
  it("flags a by-name OperationForm on a route with no `:id`", async () => {
    expect(
      await codes(
        `page A { route: "/a"  body: Stack { OperationForm { of: Item, op: activate } } }`,
      ),
    ).toContain(CODE);
  });

  it("flags it inside a `Modal` trigger shape too", async () => {
    expect(
      await codes(
        `page A { route: "/a"  body: Modal { trigger: Button { "Go" }, OperationForm { of: Item, op: activate } } }`,
      ),
    ).toContain(CODE);
  });

  it("stays quiet on a detail route that declares `:id`", async () => {
    expect(
      await codes(
        `page B(id: Item id) { route: "/b/:id"  body: Stack { OperationForm { of: Item, op: activate } } }`,
      ),
    ).not.toContain(CODE);
  });

  it("stays quiet on the INSTANCE spelling, which carries its own record", async () => {
    expect(
      await codes(
        `page C { route: "/c"  body: QueryView {
           of: Shop.Item.all,
           single: true,
           loading: Skeleton { count: 1 },
           error: Alert { "err" },
           empty: Empty { "none" },
           data: row => OperationForm { row.activate }
         } }`,
      ),
    ).not.toContain(CODE);
  });

  it("reports each (aggregate, operation) pair once per page", async () => {
    const raised = (
      await codes(
        `page A { route: "/a"  body: Stack {
           OperationForm { of: Item, op: activate },
           OperationForm { of: Item, op: activate }
         } }`,
      )
    ).filter((c) => c === CODE);
    expect(raised).toHaveLength(1);
  });
});
