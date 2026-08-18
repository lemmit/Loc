// ---------------------------------------------------------------------------
// `loom.sub-primitive-misplaced` — `Tab` and `Column` are PLACEMENT contracts.
//
// Both are `group: "sub"` in the walker registry: they carry NO top-level
// renderer, because their parent consumes them inline (`emitTabs` scans its
// positional args for `Tab(...)`; `emitTable` / `emitDataGrid` scan theirs for
// `Column(...)`).
//
// Spelled anywhere else — `Stack { Tab("x") }`, a bare `Column(...)` in a page
// body, a `Column` under `Tabs` — the call reaches the walker's own dispatch,
// finds a registered primitive with no `tsx` entry, and emits a COMMENT
// (`walker-core.ts`) or an EEx comment (`heex-walker-core.ts`).  The element
// and everything nested inside it silently disappear from the page, and no
// build gate notices: it still compiles on every frontend.
//
// One authoring mistake, seven identical symptoms → an IR-tier check, exactly
// like its sibling `loom.slot-outside-component`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.sub-primitive-misplaced";

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

describe("loom.sub-primitive-misplaced — the gate", () => {
  it("flags a `Tab` under a `Stack` in a PAGE body", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Tab("one") } }`)).toContain(CODE);
  });

  it("flags a bare `Column` in a PAGE body", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Column("name") } }`)).toContain(CODE);
  });

  it("flags a `Tab` in a COMPONENT body", async () => {
    expect(
      await codes(`
        component Panel() { body: Stack { Tab("one") } }
        page X { route: "/x"  body: Panel() }
      `),
    ).toContain(CODE);
  });

  it("flags a `Column` in a COMPONENT body", async () => {
    expect(
      await codes(`
        component Panel() { body: Stack { Column("name") } }
        page X { route: "/x"  body: Panel() }
      `),
    ).toContain(CODE);
  });

  it("flags the two crossed over — `Column` under `Tabs`, `Tab` under `Table`", async () => {
    expect(await codes(`page X { route: "/x"  body: Tabs { Column("name") } }`)).toContain(CODE);
    expect(await codes(`page X { route: "/x"  body: Table { rows: [ ], Tab("one") } }`)).toContain(
      CODE,
    );
  });

  it("flags it however deeply nested — a Tab inside a Card inside a Stack", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Stack { Card { "T", Tab("one") } } }`),
    ).toContain(CODE);
  });

  it("is an error, names the page, the primitive, and its legal parent", async () => {
    const d = (await diagnostics(`page X { route: "/x"  body: Stack { Tab("one") } }`)).find(
      (x) => x.code === CODE,
    );
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/page 'X'/);
    expect(d?.message).toMatch(/`Tab`/);
    expect(d?.message).toMatch(/'Tabs'/);
  });

  it("names BOTH legal parents for `Column`", async () => {
    const d = (await diagnostics(`page X { route: "/x"  body: Stack { Column("n") } }`)).find(
      (x) => x.code === CODE,
    );
    expect(d?.message).toMatch(/'Table' or 'DataGrid'/);
  });

  it("reports ONE diagnostic per primitive, however many times it is misplaced", async () => {
    const hits = (
      await diagnostics(`page X { route: "/x"  body: Stack { Tab("a"), Text { "x" }, Tab("b") } }`)
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
  });
});

describe("loom.sub-primitive-misplaced — what it must NOT flag", () => {
  it("POSITIVE CONTROL: `Tab` as a direct child of `Tabs` is clean", async () => {
    expect(
      await codes(
        `page X { route: "/x"  body: Tabs { Tab("One", Text { "a" }), Tab("Two", Text { "b" }) } }`,
      ),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: `Column` as a direct child of `Table` is clean", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Table { rows: [ ], Column("Name", r => r) } }`),
    ).not.toContain(CODE);
  });

  it("a `Tabs` nested inside a `Stack` still admits its own `Tab`s", async () => {
    expect(
      await codes(
        `page X { route: "/x"  body: Stack { Card { "T", Tabs { Tab("One", Text { "a" }) } } } }`,
      ),
    ).not.toContain(CODE);
  });

  it("a page with neither primitive raises nothing", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Text { "a" } } }`)).not.toContain(CODE);
  });
});
