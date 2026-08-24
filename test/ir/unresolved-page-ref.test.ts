// ---------------------------------------------------------------------------
// `loom.unresolved-page-ref` — the last silent-drop door in a page body (A17).
//
// A bare name in a rendered slot resolves at emit time against the route
// params, the `state { }` fields, the `derived` bindings, an enclosing lambda's
// parameter, a `<Store>.<field>` read, or a `let`.  Anything else lowers to
// `refKind: "unknown"` and the walker emits a COMMENT in its place
// (`walker-core.ts` — `{/* ref: nosuchthing */}` on React/Vue/Svelte/Angular,
// `Html.none` on Feliz, `SizedBox.shrink()` on Flutter).
//
// So `Text { nosuchthing }` passed phases ④ AND ⑦ and shipped a page with the
// content gone, on all six frontends.  The CALL spelling of the same typo
// (`Text { Nosuchthing(x) }`) has been gated since `loom.unknown-page-element`;
// the REF spelling was gated nowhere.  This closes the last entry point of the
// #2554/#2567/#2568 silent-drop class.
//
// The gate is deliberately scoped to the walker's own resolution: the direct
// positional arguments of a RENDERED call, never a member/method-call RECEIVER
// — `Status.Open` and `Shop.Thing.all` both root at an `unknown` ref BY DESIGN
// (an enum name, an api handle), and the member walk resolves them.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.unresolved-page-ref";

const wrap = (uiBody: string) => `
system Demo {
  subdomain S {
    context C {
      enum Status { Open, Closed }
      aggregate Customer { name: string  status: Status }
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

describe("loom.unresolved-page-ref — the gate", () => {
  it("flags a bare unresolved ref in a text slot", async () => {
    expect(await codes(`page X { route: "/x"  body: Text { nosuchthing } }`)).toContain(CODE);
  });

  it("flags it however deeply nested — inside a Card inside a Stack", async () => {
    expect(
      await codes(`page X { route: "/x"  body: Stack { Card { "T", Text { nosuchthing } } } }`),
    ).toContain(CODE);
  });

  it("flags it inside a compound expression a rendered slot interpolates", async () => {
    // The slot renders the whole ternary; the unresolved name is one operand
    // deep, which is still `/* unresolved */ undefined` in the emitted code.
    expect(
      await codes(`page X { route: "/x"  body: Text { nosuchthing ? "yes" : "no" } }`),
    ).toContain(CODE);
  });

  it("flags it in a COMPONENT body too — a component has the same resolution set", async () => {
    expect(
      await codes(`
        component Panel(title: string) { body: Stack { Text { title }, Text { nosuchthing } } }
        page X { route: "/x"  body: Panel("Hi") }
      `),
    ).toContain(CODE);
  });

  it("is an error, names the host, and names the ref", async () => {
    const d = (await diagnostics(`page X { route: "/x"  body: Text { nosuchthing } }`)).find(
      (x) => x.code === CODE,
    );
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/page 'X'/);
    expect(d?.message).toMatch(/nosuchthing/);
  });

  it("reports ONE diagnostic per name, however often the page repeats the typo", async () => {
    const hits = (
      await diagnostics(
        `page X { route: "/x"  body: Stack { Text { nosuchthing }, Text { nosuchthing } } }`,
      )
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
  });
});

describe("loom.unresolved-page-ref — what it must NOT flag", () => {
  it("POSITIVE CONTROL: a route parameter resolves", async () => {
    expect(
      await codes(`page X(kind: string) { route: "/x/:kind"  body: Text { kind } }`),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a `state` field and a `derived` binding resolve", async () => {
    expect(
      await codes(`
        page X {
          route: "/x"
          state { n: string = "a" }
          derived d: string = n
          body: Stack { Text { n }, Text { d } }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a lambda-bound name inside a QueryView data arm resolves", async () => {
    expect(
      await codes(`
        page X {
          route: "/x"
          body: QueryView {
            of: Shop.Customer.all,
            loading: Skeleton { },
            error: Alert { "e" },
            empty: Empty { "none" },
            data: rows => Stack { Text { "rows" } }
          }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: an enum-name RECEIVER is not a rendered ref", async () => {
    // `Status` lowers to `refKind: "unknown"` by design — it is the receiver of
    // a member walk, not a value the slot reads.  A check that flagged it would
    // reject a shipped shape, which is why the walk stops at receivers.
    expect(await codes(`page X { route: "/x"  body: Text { Status.Open } }`)).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: an api HANDLE receiver is not a rendered ref either", async () => {
    expect(
      await codes(`
        page X {
          route: "/x"
          body: QueryView {
            of: Shop.Customer.all,
            loading: Skeleton { },
            error: Alert { "e" },
            empty: Empty { "none" },
            data: rows => Text { "ok" }
          }
        }
      `),
    ).not.toContain(CODE);
  });

  it("a page with no unresolved names raises nothing", async () => {
    expect(await codes(`page X { route: "/x"  body: Stack { Text { "a" } } }`)).not.toContain(CODE);
  });
});
