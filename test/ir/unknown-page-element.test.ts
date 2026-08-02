// `loom.unknown-page-element` (F4) — the call form of a construct whose brace
// form was already gated.
//
// `Fooo { … }` in a page body has always been rejected by the language
// validator (`loom.unknown-builder-type`).  The CALL spelling of the same
// thing — `Fooo(…)` — slipped through every tier, and the two render-tree
// positions fail differently:
//
//   Stack { Fooo(1) }     → `{/* unknown layout component: Fooo */}`  visible
//   Text(Fooo(x))         → `<Text></Text>`                           SILENT
//
// The second is reachable by an ordinary typo and silently deletes the page
// content.  This suite pins the gate, and — as importantly — the four things
// it must not flag, each of which IS resolvable by the walker.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.unknown-page-element";

const wrap = (uiBody: string) => `
system Demo {
  subdomain S {
    context C {
      valueobject Money { amount: decimal  currency: string }
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: react
    api C: A
    ${uiBody}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: static  targets: api  port: 3001  ui: Web { C: api } }
}`;

async function codes(uiBody: string): Promise<string[]> {
  const { model, errors } = await parseString(wrap(uiBody));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

describe("loom.unknown-page-element — the gate", () => {
  it("flags the SILENT case: an unknown call in a user-visible text slot", async () => {
    expect(await codes(`page X { route: "/x"  body: Text(Fooo(1)) }`)).toContain(CODE);
  });

  it("flags the visible case too: an unknown call in layout position", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Fooo(1) } }`)).toContain(CODE);
  });

  it("names the offender and says the content is dropped", async () => {
    const { model } = await parseString(wrap(`page X { route: "/x"  body: Text(Fooo(1)) }`));
    const d = validateLoomModel(enrichLoomModel(lowerModel(model))).find((x) => x.code === CODE)!;
    expect(d.severity).toBe("error");
    expect(d.message).toContain("`Fooo(…)`");
    expect(d.message).toContain("DROPPED");
  });

  it("covers a component body and a page `derived`, not just the body", async () => {
    expect(
      await codes(`component Panel() { body: Text(Fooo(1)) }
                   page X { route: "/x"  body: Text("ok") }`),
    ).toContain(CODE);
    expect(
      await codes(`page X { route: "/x"  derived n: string = Fooo(1)  body: Text("ok") }`),
    ).toContain(CODE);
  });

  it("reports ONE diagnostic per (host, name)", async () => {
    const { model } = await parseString(
      wrap(`page X { route: "/x"  body: Stack { Text(Fooo(1)), Text(Fooo(2)), Text(Barr(3)) } }`),
    );
    const found = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.code === CODE,
    );
    expect(found.map((d) => d.message.match(/`(\w+)\(…\)`/)?.[1]).sort()).toEqual(["Barr", "Fooo"]);
  });
});

describe("loom.unknown-page-element — what the walker CAN resolve", () => {
  it("a stdlib walker primitive is fine", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Badge { "x" } } }`)).not.toContain(
      CODE,
    );
  });

  it("a declared user component is fine", async () => {
    expect(
      await codes(`component Panel(label: string) { body: Text { label } }
                   page X { route: "/x"  body: Stack { Panel { label: "hi" } } }`),
    ).not.toContain(CODE);
  });

  it("a value-object construction is fine — a VO is a plain wire record", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Text(Money(1.0, "USD").currency) }`),
    ).not.toContain(CODE);
  });

  it("a primitive cast is fine (`string(n)` is a cast node, not a call)", async () => {
    expect(
      await codes(`page X { route: "/x"  state { n: int = 1 }  body: Text(string(n)) }`),
    ).not.toContain(CODE);
  });

  it("a ui `extern` function is fine", async () => {
    expect(
      await codes(`function fmt(v: string): string extern from "./fmt"
                   page X { route: "/x"  body: Text(fmt("x")) }`),
    ).not.toContain(CODE);
  });
});
