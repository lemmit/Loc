// ---------------------------------------------------------------------------
// `loom.page-primitive-extra-children` — the ARITY half of the multi-child
// sweep (A7).
//
// `Card` (#2567) and `Tab` are CONTAINERS: they were reading one positional and
// dropping the rest, and the fix was to render them all.  Three siblings read
// one positional for the same reason and CANNOT be fixed that way, because
// there is no second slot in any design pack to render into:
//
//   Stat(label, value)            two stacked text elements — `{{{label}}}` and
//                                 `{{{value}}}`, on all 15 packs
//   KeyValueRow(label, value)     a `<dt>`/`<dd>` pair; the value cell takes ONE
//                                 already-walked element on Feliz and Flutter
//   Modal(trigger:, OperationForm(…))
//                                 `primitive-modal` renders the TRIGGER button
//                                 and nothing else
//
// So the extra positional was read by NOBODY: the content vanished from every
// frontend while still landing in `.loom/messages.en.json` — translators got a
// key nothing renders, the same tell `Tab` had.  This is the honest gate, the
// other half of #2567's fix-or-gate rule.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.page-primitive-extra-children";

const wrap = (uiBody: string) => `
system Demo {
  subdomain S {
    context C {
      valueobject Money {
        amount: decimal
        currency: string
      }
      aggregate Customer {
        name: string
        operation archive() { }
      }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: react
    api Shop: A
    ${uiBody}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: static  targets: api  port: 3001  ui: Web { Shop: api } }
}`;

async function diagnostics(uiBody: string) {
  const { model, errors } = await parseString(wrap(uiBody));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (uiBody: string): Promise<string[]> =>
  (await diagnostics(uiBody)).map((d) => d.code);

describe("loom.page-primitive-extra-children — the gate", () => {
  it("flags a third positional on `Stat`", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Stat { "Revenue", "10", Text { "extra" } } }`),
    ).toContain(CODE);
  });

  it("flags a third positional on `KeyValueRow`", async () => {
    expect(
      await codes(
        `page X { route: "/x"  body: KeyValueRow { "Status", Text { "a" }, Text { "b" } } }`,
      ),
    ).toContain(CODE);
  });

  it("flags a stray child alongside an op-form `Modal`", async () => {
    expect(
      await codes(`
        page X {
          route: "/x/:id"
          body: Modal { trigger: Button { "Archive" }, OperationForm { of: Customer, op: archive }, Text { "note" } }
        }
      `),
    ).toContain(CODE);
  });

  it("is an error, names the host, and names the primitive", async () => {
    const d = (
      await diagnostics(`page X { route: "/x"  body: Stat { "R", "10", Text { "extra" } } }`)
    ).find((x) => x.code === CODE);
    expect(d?.severity).toBe("error");
    // The HOST lives in `source` (the CLI prints `${code} ${source}: …`); the
    // message must not repeat it — see F2-FFE-9.
    expect(d?.source).toBe("page 'X'");
    expect(d?.message).toMatch(/Stat/);
  });

  // MEMBERSHIP (`fixed-slot-arity-membership-incomplete`).  The gate's own
  // header described the class, but the table listed exactly `Stat` /
  // `KeyValueRow` / the op-form `Modal` — every OTHER fixed-arity read in the
  // primitive table stayed unguarded, so `EnumBadge { "x", "dropped" }` and
  // `Image { "/a.png", "/dropped.png", alt: "a" }` both parsed `0 error(s)`
  // and both emitted only positional 0.  Membership now comes from
  // `WALKER_PRIMITIVE_ARGS`, one declaration per primitive.
  it.each([
    ['EnumBadge { "x", "dropped" }', "EnumBadge"],
    ['Image { "/a.png", "/dropped.png", alt: "a" }', "Image"],
    ['Text { "keep", "dropped" }', "Text"],
    ['Money { 10, "dropped" }', "Money"],
    ['Heading { "H", "dropped" }', "Heading"],
    ['Anchor { "L", "dropped", to: "/x" }', "Anchor"],
    ['Alert { "msg", "dropped" }', "Alert"],
    ['Badge { "b", "dropped" }', "Badge"],
    ['Loader { "dropped" }', "Loader"],
    ['Icon { "dropped", name: "star" }', "Icon"],
  ])("flags the extra positional on %s", async (body, name) => {
    const d = await diagnostics(`page X { route: "/x"  body: ${body} }`);
    const hit = d.find((x) => x.code === CODE);
    expect(hit, `${name}: no ${CODE} raised`).toBeDefined();
    expect(hit?.message).toMatch(new RegExp(name));
  });

  it("reports ONE diagnostic per primitive, however often the page repeats it", async () => {
    const hits = (
      await diagnostics(`
        page X {
          route: "/x"
          body: Stack {
            Stat { "A", "1", Text { "x" } },
            Stat { "B", "2", Text { "y" } }
          }
        }
      `)
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
  });
});

describe("loom.page-primitive-extra-children — what it must NOT flag", () => {
  it("POSITIVE CONTROL: the declared two-slot shapes are clean", async () => {
    expect(
      await codes(`
        page X {
          route: "/x"
          body: Stack { Stat { "Revenue", "10" }, KeyValueRow { "Status", Text { "Open" } } }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a state-controlled Modal IS a children container", async () => {
    // `Modal { …children, open: <stateBool> }` walks EVERY positional
    // (`emitControlledModal`), so several children there are correct.
    expect(
      await codes(`
        page X {
          route: "/x"
          state { shown: bool = false }
          body: Modal { Text { "a" }, Text { "b" }, open: shown }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: an op-form Modal with only the form child is clean", async () => {
    expect(
      await codes(`
        page X {
          route: "/x/:id"
          body: Modal { trigger: Button { "Archive" }, OperationForm { of: Customer, op: archive } }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a real container takes as many children as it likes", async () => {
    expect(
      await codes(`
        page X {
          route: "/x"
          body: Card { "T", Text { "a" }, Text { "b" }, Text { "c" } }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a `Column`'s header AND accessor lambda are both slots", async () => {
    // Two positionals, both read (`emitColumn`: `positionals[0]` header,
    // `positionals[1]` accessor).  Capping `Column` at one rejected 342 shipped
    // scaffolded pages across the corpus — the reason this gate's membership is
    // pinned to the emitters rather than eyeballed.
    expect(
      await codes(`
        page X {
          route: "/x"
          body: QueryView {
            of: Shop.Customer.all,
            data: rows => Table { rows: rows, Column { "Name", o => Text { o.name } } }
          }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a value object sharing a primitive's NAME is not the primitive", async () => {
    // `Money(9.99, "USD").currency` in `web/src/examples/expression-showcase.ddd`
    // constructs the VO `Money`; the walker hands the whole member access to
    // `emitExpr` and never dispatches the `Money` PRIMITIVE.  Reading it as one
    // rejected shipped source over an arity that does not apply to it.
    expect(
      await codes(`
        page X {
          route: "/x"
          body: Stat { "vo", Money(9.99, "USD").currency }
        }
      `),
    ).not.toContain(CODE);
  });
});
