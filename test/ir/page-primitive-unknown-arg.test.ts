// ---------------------------------------------------------------------------
// `loom.page-primitive-unknown-arg` — the NAMED-ARGUMENT half of the
// silent-drop sweep (the twin of `loom.page-primitive-extra-children`).
//
// Every emitter reads its named arguments BY NAME — `stringNamed(call,
// "variant")`, `namedArgValue(call, "of")`.  A name outside the primitive's
// vocabulary is read by nobody, so it and its content vanish from all seven
// render targets.  Unlike the extra-positional case it does not even reach
// `.loom/messages.en.json`, and on a fixed-slot primitive it DISPLACES the
// positional the content was meant to fill.
//
// Measured on `main` before this gate, `Card { title: "Bob's card", Text{"x"} }`
// + `Tabs { Tab { title: "One", Text{"first"} } }` parsed with 0 diagnostics
// and emitted a captionless card and a tab labelled "Tab 1"; neither caption
// appeared in the message catalog.  The shipped `examples/showcase.ddd` had the
// same defect at a larger scale — `Section { heading:, body: Stack{…} }`
// rendered as a literal `<section />`, dropping the whole inline-emphasis demo.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.page-primitive-unknown-arg";

const wrap = (uiBody: string) => `
system Demo {
  subdomain S {
    context C {
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

describe("loom.page-primitive-unknown-arg — the gate", () => {
  it("flags `title:` on a `Card` (a container whose caption is positional 0)", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Card { title: "Cap", Text { "x" } } }`),
    ).toContain(CODE);
  });

  it("flags `title:` on a `Tab`, which displaces the caption and renders 'Tab 1'", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Tabs { Tab { title: "One", Text { "a" } } } }`),
    ).toContain(CODE);
  });

  it("flags `body:` on a `Section` — the showcase's whole inline demo", async () => {
    expect(
      await codes(
        `page X { route: "/x"  body: Section { heading: "Inline", body: Stack { Bold { "b" } } } }`,
      ),
    ).toContain(CODE);
  });

  it("reports each (primitive, argument) pair once, however many sites repeat it", async () => {
    const diags = (
      await diagnostics(
        `page X { route: "/x"  body: Stack { Card { title: "a" }, Card { title: "b" } } }`,
      )
    ).filter((d) => d.code === CODE);
    expect(diags).toHaveLength(1);
  });

  it("names the accepted vocabulary in the message", async () => {
    const [d] = (await diagnostics(`page X { route: "/x"  body: Card { title: "Cap" } }`)).filter(
      (x) => x.code === CODE,
    );
    expect(d?.message).toContain("`Card` accepts `variant:`, `shadow:`");
  });

  it("says so when the primitive takes children only", async () => {
    const [d] = (await diagnostics(`page X { route: "/x"  body: Stack { heading: "h" } }`)).filter(
      (x) => x.code === CODE,
    );
    expect(d?.message).toContain("takes positional children only");
  });

  it("fires inside a `component` body too", async () => {
    expect(
      await codes(
        `component Panel() { body: Card { title: "Cap", Text { "x" } } }
         page X { route: "/x"  body: Panel { } }`,
      ),
    ).toContain(CODE);
  });

  // --- what must stay quiet -------------------------------------------------

  it("accepts every argument the emitters read", async () => {
    expect(
      await codes(
        `page X {
           route: "/x"
           body: Stack {
             Card { "Cap", variant: "outline", shadow: "sm", testid: "c" },
             Alert { "msg", title: "T", color: "red" },
             Modal { trigger: Button { "Go" }, title: "Dlg", OperationForm { of: Customer, op: archive } },
             CodeBlock { "x = 1", language: "ts", title: "sample.ts" },
             Icon { name: "star", size: "md", label: "Star" },
             Container { size: "xl", Text { "in" } },
             Section { id: "s", Text { "in" } },
             Grid { cols: 2, Text { "in" } },
             Divider { label: "or" },
             Toolbar { label: "Actions", Button { "Go" } }
           }
         }`,
      ),
    ).not.toContain(CODE);
  });

  it("leaves a user `component`'s own named parameters alone", async () => {
    expect(
      await codes(
        `component Panel(heading: string) { body: Text { heading } }
         page X { route: "/x"  body: Panel { heading: "H" } }`,
      ),
    ).not.toContain(CODE);
  });

  // --- the `style:` arm -----------------------------------------------------
  // An object-literal `style: { … }` is lifted off the call by `hoistStyleArg`
  // during lowering and never reaches the gate.  Anything else is DROPPED
  // there — silently, until now.

  it("passes an object-literal `style:`", async () => {
    expect(
      await codes(
        `page X { route: "/x"  body: Card { style: { padding: "1rem" }, Text { "x" } } }`,
      ),
    ).not.toContain(CODE);
  });

  it("flags a non-object `style:`, which lowering drops", async () => {
    const [d] = (
      await diagnostics(
        `page X { route: "/x"  body: Card { style: "padding: 1rem", Text { "x" } } }`,
      )
    ).filter((x) => x.code === CODE);
    expect(d?.message).toContain("OBJECT LITERAL");
  });
});
