// `store` surface parsing (named-actions-and-stores.md §3, Stage 5).  A
// `store Name { … }` is a `ui` member (sibling to `page` / `component`) whose
// body interleaves `state {}` blocks and `action`s (`StoreDecl: StateBlock |
// ActionDecl`).  There is NO `use` clause and NO lifetime surface (the
// persist/sync ladder was kept out of the grammar — those words collide with
// common identifiers); a store is referenced purely by DOTTED name elsewhere.
//
// This pins the AST shape only — lowering / validation / emission live in
// `test/ir/store.test.ts` and the per-frontend generator suites.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type { ActionDecl, Model, StateBlock, Store } from "../../../src/language/generated/ast.js";
import { parseRawResult, parseString } from "../../_helpers/parse.js";

async function storeOf(uiBody: string): Promise<Store> {
  const { model, errors } = await parseString(
    `
    system Demo {
      subdomain S { context C { aggregate Order with crudish { customerId: string } } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: Web, port: 3001 }
    }
  `,
    { validate: false },
  );
  expect(errors).toEqual([]);
  return [...AstUtils.streamAllContents(model as Model)].find(
    (n): n is Store => n.$type === "Store",
  )!;
}

describe("store — parsing", () => {
  it("parses a `store` UiMember with a state block and two actions", async () => {
    const store = await storeOf(`
      store Cart {
        state { lines: string[] = [ ] }
        action add(l: string) { lines += l }
        action clear() { lines := [ ] }
      }
    `);

    expect(store.$type).toBe("Store");
    expect(store.name).toBe("Cart");

    // Body interleaves a StateBlock and ActionDecls, in source order.
    const kinds = store.decls.map((d) => d.$type);
    expect(kinds).toEqual(["StateBlock", "ActionDecl", "ActionDecl"]);

    const state = store.decls.find((d): d is StateBlock => d.$type === "StateBlock")!;
    expect(state.fields.map((f) => f.name)).toEqual(["lines"]);

    const actions = store.decls.filter((d): d is ActionDecl => d.$type === "ActionDecl");
    expect(actions.map((a) => a.name)).toEqual(["add", "clear"]);
    // The first action carries a typed payload param; `clear` is nullary.
    expect(actions[0]!.params.map((p) => p.name)).toEqual(["l"]);
    expect(actions[1]!.params).toEqual([]);
    // Each action body is a statement block (reused verbatim from page/component).
    expect(actions[0]!.stmts.length).toBe(1);
    expect(actions[1]!.stmts.length).toBe(1);
  });

  it("parses a store with interleaved state and action declarations", async () => {
    const store = await storeOf(`
      store Cart {
        state { count: int = 0 }
        action bump() { count += 1 }
        state { total: decimal = 0 }
      }
    `);
    expect(store.decls.map((d) => d.$type)).toEqual(["StateBlock", "ActionDecl", "StateBlock"]);
  });

  it("a store carries NO route — it is not a page (rejects `route:` in a store body)", () => {
    // `StoreDecl` is `StateBlock | ActionDecl` only; a `route:` clause (a page
    // member) inside a store body is a hard parse error — the store surface is
    // deliberately narrower than a page's.  (Use the raw parser so lexer/parser
    // errors are surfaced directly, not gated behind validation.)
    const result = parseRawResult(
      `system Demo { ui Web { store Cart { route: "/cart" state { count: int = 0 } } } }`,
    );
    expect(result.parserErrors.length).toBeGreaterThan(0);
  });
});
