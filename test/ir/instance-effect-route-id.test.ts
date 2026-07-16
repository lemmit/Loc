// `loom.instance-effect-needs-route-id` (M-T6.17) — the target-agnostic gate.
//
// An aggregate INSTANCE-op `match await <api>.<Agg>.<op>()` in a page action acts
// on the record identified by the page's route `:id`.  On a paramless page there
// is no record in scope, so it is user error on EVERY frontend — the Feliz
// generator gates it, and the JS frontends would otherwise POST an empty-id
// (`id ?? ""`) request.  This check rejects it uniformly, on any frontend.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.instance-effect-needs-route-id";

/** A ui with one page whose route + body we vary, hosted on `plat`. */
const sys = (plat: string, route: string, body: string, action: string) => `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        operation reserve(): Order or OrderMissing { return OrderMissing { missingRef: customerId } }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page P${route.includes(":id") ? "(id: Order id)" : ""} {
      route: "${route}"
      state { draftName: string = "" }
      ${action}
      body: ${body}
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: ${plat} targets: api ui: Web { C: api } port: 3001 }
}`;

const RESERVE_ACTION = `action reserveNow() {
        match await C.Order.reserve() {
          Order o => { draftName := o.customerId }
          else    => { draftName := "x" }
        }
      }`;

async function codesOf(src: string): Promise<string[]> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected parse errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

describe("loom.instance-effect-needs-route-id (M-T6.17)", () => {
  it("rejects a paramless-page instance-op `match await` on EVERY frontend", async () => {
    for (const plat of ["react", "vue", "svelte", "angular", "feliz"]) {
      const codes = await codesOf(
        sys(plat, "/home", 'Button { "Go", onClick: reserveNow }', RESERVE_ACTION),
      );
      expect(codes, `${plat} should reject a paramless-page instance effect`).toContain(CODE);
    }
  });

  it("is CLEAN on a `:id` detail page (the record is the route id)", async () => {
    for (const plat of ["react", "feliz"]) {
      const codes = await codesOf(
        sys(plat, "/orders/:id", 'Button { "Go", onClick: reserveNow }', RESERVE_ACTION),
      );
      expect(codes, `${plat} :id page must be clean`).not.toContain(CODE);
    }
  });

  it("does not false-positive on a paramless page with NO async effect", async () => {
    const codes = await codesOf(sys("react", "/home", 'Heading { "Home", level: 1 }', ""));
    expect(codes).not.toContain(CODE);
  });
});
