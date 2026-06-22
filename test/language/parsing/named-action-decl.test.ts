// Named, typed page/component event handlers — `action name(p: T) { … }`
// (named-actions-and-stores.md, Proposal A Stage 1).  Covers the new
// `ActionDecl` member grammar on BOTH page and component, plus the
// disambiguation that keeps the lowercase declaration keyword from colliding
// with the three other `action`-related grammar positions:
//   (a) a member access named `.action`;
//   (b) the `ActionType` component param-slot (`action(Order)` — a
//       handler-typed PARAM, a different position);
//   (c) the `Action {}` render primitive (PascalCase builder-call in body
//       position).

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type {
  ActionDecl,
  Component,
  Model,
  Page,
  Ui,
} from "../../../src/language/generated/ast.js";

async function parse(src: string) {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  return { model: doc.parseResult.value as Model, errors };
}

function firstUi(model: Model): Ui {
  for (const m of model.members) {
    if (m.$type === "System") {
      for (const sm of m.members) if (sm.$type === "Ui") return sm as Ui;
    }
  }
  throw new Error("no ui found");
}

describe("named `action` declarations", () => {
  it("parses an `action name(p: T) { … }` member on a page (params + body)", async () => {
    const { model, errors } = await parse(`
      system Demo {
        subdomain S { context C { aggregate Customer { name: string } } }
        ui Web {
          page NewCustomer {
            route: "/new"
            state { step: int = 0  draft: string = "" }
            action next() { step := step + 1 }
            action setName(c: Customer) { draft := c.name }
            body: Stack { Text { draft } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Web, port: 3001 }
      }
    `);
    expect(errors).toHaveLength(0);
    const page = firstUi(model).members.find((m) => m.$type === "Page") as Page;
    const actions = page.props.filter((p): p is ActionDecl => p.$type === "ActionDecl");
    expect(actions.map((a) => a.name)).toEqual(["next", "setName"]);
    // Nullary `next()` carries no params; `setName(c: Customer)` carries one.
    expect(actions[0]!.params).toHaveLength(0);
    expect(actions[1]!.params).toHaveLength(1);
    expect(actions[1]!.params[0]!.name).toBe("c");
    // Body reuses the existing Statement rule (a `:=` assignment).
    expect(actions[0]!.stmts).toHaveLength(1);
  });

  it("admits `action` members on a component too", async () => {
    const { model, errors } = await parse(`
      system Demo {
        subdomain S { context C { } }
        ui Web {
          component Counter() {
            state { n: int = 0 }
            action bump() { n := n + 1 }
            body: Stack { Text { n } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Web, port: 3001 }
      }
    `);
    expect(errors).toHaveLength(0);
    const comp = firstUi(model).members.find((m) => m.$type === "Component") as Component;
    const actions = comp.decls.filter((d): d is ActionDecl => d.$type === "ActionDecl");
    expect(actions.map((a) => a.name)).toEqual(["bump"]);
  });

  it("coexists with `.action` member access, the `action(T)` param slot, and the `Action {}` primitive", async () => {
    // (a) `o.action` — member access named `action` (soft after `.`).
    // (b) `onPick: action(Customer)` — the ActionType param slot (a
    //     handler-typed component PARAM).
    // (c) `Action { … }` — the PascalCase render primitive in body position.
    // (d) the new lowercase `action confirm()` member declaration.
    const { errors } = await parse(`
      system Demo {
        subdomain S {
          context C {
            aggregate Order {
              name: string
              action: string
              operation confirm() { }
            }
          }
        }
        ui Web {
          component Picker(onPick: action(Order)) {
            body: Stack { Text { "pick" } }
          }
          page Console(o: Order id) {
            route: "/c/:id"
            action confirm() { }
            body: Stack {
              Action { o.confirm },
              Text { o.action }
            }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Web, port: 3001 }
      }
    `);
    // All four `action`/`Action` forms parse together with no lex/parse error.
    expect(errors).toHaveLength(0);
  });
});
