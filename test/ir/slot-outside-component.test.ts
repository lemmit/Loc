// ---------------------------------------------------------------------------
// `loom.slot-outside-component` — `Slot { }` is a PLACEMENT contract.
//
// `Slot { }` renders the children a CALLER passed in.  Only a `component` has a
// caller, so only a component body can bind them: the walker's `usesChildren`
// flag makes the component shell declare the children parameter, and the call
// site's extra positionals fill it.
//
// A PAGE has no caller.  The same `Slot { }` in a page body emitted an UNBOUND
// children reference on every frontend, and the failure mode is per-target:
// React `{children}` and Feliz `props.children` do not compile (TS2304 / a
// missing record field), while Vue / Svelte / Angular / Flutter emit a slot
// nothing can ever fill — silent. Neither tier gated it, so the page shipped.
//
// It is one authoring mistake with six different symptoms, which is what makes
// it an IR-tier check rather than six per-target ones.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.slot-outside-component";

const wrap = (uiBody: string) => `
system Demo {
  subdomain S {
    context C {
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

async function diagnostics(uiBody: string) {
  const { model, errors } = await parseString(wrap(uiBody));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (uiBody: string): Promise<string[]> =>
  (await diagnostics(uiBody)).map((d) => d.code);

describe("loom.slot-outside-component — the gate", () => {
  it("flags `Slot { }` in a page body", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Slot { } } }`)).toContain(CODE);
  });

  it("flags it however deeply nested — a Slot inside a Card inside a Stack", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Stack { Card { "T", Text { "a" }, Slot { } } } }`),
    ).toContain(CODE);
  });

  it("is an error, names the page, and points at `component`", async () => {
    const d = (await diagnostics(`page X { route: "/x"  body: Slot { } }`)).find(
      (x) => x.code === CODE,
    );
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/page 'X'/);
    expect(d?.message).toMatch(/component/);
  });

  it("reports ONE diagnostic for a page spelling several slots", async () => {
    const hits = (
      await diagnostics(`page X { route: "/x"  body: Stack { Slot { }, Text { "a" }, Slot { } } }`)
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
  });
});

describe("loom.slot-outside-component — what it must NOT flag", () => {
  it("POSITIVE CONTROL: a component body's Slot { } is clean", async () => {
    expect(
      await codes(`
        component Panel(title: string) { body: Card { title, Slot { } } }
        page X { route: "/x"  body: Stack { Panel("Hi", Text { "inside" }) } }
      `),
    ).not.toContain(CODE);
  });

  it("a page that CALLS a Slot-using component is clean — the slot is the callee's", async () => {
    const cs = await codes(`
      component Panel(title: string) { body: Stack { Text { title }, Slot { } } }
      page X { route: "/x"  body: Panel("Hi", Text { "inside" }) }
    `);
    expect(cs).not.toContain(CODE);
  });

  it("a page with no Slot at all raises nothing", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Text { "a" } } }`)).not.toContain(CODE);
  });
});
