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

// `loom.match-await-arg-mismatch` — the awaited op call's args must match the op
// signature (the request payload is built by index-aligning args → params).
const ARG_CODE = "loom.match-await-arg-mismatch";

/** A `:id` detail page whose op signature + call args vary. */
const argSys = (opSig: string, callArgs: string, plat = "react") => `
system Demo {
  subdomain S {
    context C {
      error Rejected { reason: string }
      aggregate Order with crudish {
        code: string
        operation confirm(${opSig}): Order or Rejected { return Rejected { reason: code } }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page Detail(id: Order id) {
      route: "/orders/:id"
      state { m: string = "" }
      action go() {
        match await C.Order.confirm(${callArgs}) {
          Order o    => { m := o.code }
          Rejected r => { m := r.reason }
        }
      }
      body: Button { "Go", onClick: go }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: ${plat} targets: api ui: Web { C: api } port: 3001 }
}`;

describe("loom.match-await-arg-mismatch (senior-toolchain arity check)", () => {
  it("rejects too FEW args (a required param left unsupplied) on every frontend", async () => {
    for (const plat of ["react", "vue", "svelte", "angular", "feliz"]) {
      const codes = await codesOf(argSys("note: string", "", plat));
      expect(codes, `${plat} should reject 0 args for a 1-required-param op`).toContain(ARG_CODE);
    }
  });

  it("rejects too MANY args", async () => {
    expect(await codesOf(argSys("note: string", '"a", "b"'))).toContain(ARG_CODE);
  });

  it("is CLEAN when the arg count matches", async () => {
    expect(await codesOf(argSys("note: string", '"hi"'))).not.toContain(ARG_CODE);
    expect(await codesOf(argSys("", ""))).not.toContain(ARG_CODE);
  });

  it("allows an omitted TRAILING optional param", async () => {
    // `confirm(note: string?)` called with no args — the optional may be omitted.
    expect(await codesOf(argSys("note: string?", ""))).not.toContain(ARG_CODE);
    // …but a required param BEFORE an optional still must be supplied.
    expect(await codesOf(argSys("note: string, memo: string?", ""))).toContain(ARG_CODE);
    expect(await codesOf(argSys("note: string, memo: string?", '"hi"'))).not.toContain(ARG_CODE);
  });
});

const TYPE_CODE = "loom.match-await-arg-type";

describe("loom.match-await-arg-type (literal arg / param family check)", () => {
  it("rejects a literal whose family clashes with the param type", async () => {
    // numeric literal → string param
    expect(await codesOf(argSys("note: string", "42"))).toContain(TYPE_CODE);
    // string literal → numeric param
    expect(await codesOf(argSys("count: int", '"hi"'))).toContain(TYPE_CODE);
    // bool literal → string param
    expect(await codesOf(argSys("note: string", "true"))).toContain(TYPE_CODE);
  });

  it("is CLEAN when the literal family matches (incl. numeric widening)", async () => {
    expect(await codesOf(argSys("note: string", '"hi"'))).not.toContain(TYPE_CODE);
    expect(await codesOf(argSys("count: int", "42"))).not.toContain(TYPE_CODE);
    // an int literal for a decimal/money param is the same (numeric) family
    expect(await codesOf(argSys("price: decimal", "42"))).not.toContain(TYPE_CODE);
  });

  it("does not flag a NON-literal arg (a ref) — refs are the type-checker's job", async () => {
    // `m` is the page's `string` state; passing it to an `int` param is a real
    // mismatch, but it's a ref (not a literal we can prove), so this check skips it
    // — no false positive.
    expect(await codesOf(argSys("count: int", "m"))).not.toContain(TYPE_CODE);
  });
});
