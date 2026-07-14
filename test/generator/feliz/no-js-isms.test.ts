// Feliz "no JS-isms" guard — a cheap, docker-free catch for the class of bug
// where a walker primitive / expression rides the shared (JSX-shaped) engine and
// emits JavaScript spliced into F# that won't Fable-compile.  Two real bugs
// shipped this way before a `.ddd` happened to trigger them: `Action { x.op }`
// emitted `x.mutateAsync({})`, and `currentUser.<field>` in a body emitted
// `/* unresolved */ undefined.email`.  Neither was in a CI example, so the
// per-example Fable-compile legs never saw them.
//
// This test generates BROAD Feliz apps (a full scaffold + a rich explicit-page
// app spanning most primitives) and asserts the emitted `App.fs` contains none
// of the JS-leak signatures below — tokens that are valid JS but NEVER appear in
// valid F#.  It's a structural smoke, not a compile (the feliz-build CI leg still
// proves compilation on the real examples); its job is to make the whole CLASS
// fail fast in the fast vitest suite instead of surfacing one `.ddd` at a time.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Tokens that are valid JavaScript but never valid F# — a match is a JS leak
 *  from the shared walker into the Feliz output. */
const JS_ISMS: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: /\bundefined\b/,
    why: "JS `undefined` (F# uses None / ()) — the walker's unresolved-ref fallback",
  },
  { re: /mutateAsync|\.mutate\(/, why: "React-query mutation (the shared emitAction React path)" },
  { re: /\buse(State|Navigate|Params|Form|Session|Memo|Effect)\b/, why: "a React hook" },
  { re: /\/\*/, why: "a JS block comment (F# uses `(*`)" },
  { re: / => /, why: "a JS arrow (F# uses `->`)" },
  { re: /\$\{/, why: "a JS template-literal placeholder" },
];

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

/** Assert `app` (an emitted App.fs) carries no JS-ism, reporting the first
 *  offending line + which signature matched for a readable failure. */
function expectNoJsIsms(app: string, label: string): void {
  const lines = app.split("\n");
  for (const { re, why } of JS_ISMS) {
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) {
      throw new Error(
        `${label}: JS-ism leaked into the Feliz output (${why})\n  App.fs:${idx + 1}: ${lines[idx]!.trim()}`,
      );
    }
  }
  // Belt-and-suspenders: the whole thing should still compile-shape as F# —
  // a bare `undefined`/`=>` anywhere is a fail even if line-splitting missed it.
  for (const { re } of JS_ISMS) expect(app).not.toMatch(re);
}

// A full scaffold app — Home dashboard + List (Toolbar/Breadcrumbs/Paper/Table/
// IdLink/Alert/Skeleton/Empty/KeyValueRow) + New (CreateForm, every scalar
// widget: number/checkbox/enum-select/FK-select/VO/array) + Detail (Modal →
// OperationForm, DestroyForm) + a WorkflowForm — the widest primitive spread.
const SCAFFOLD = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      enum Status { active inactive }
      valueobject Contact { email: string  phone: string }
      aggregate Category with crudish { name: string }
      aggregate Product with crudish {
        name:     string
        price:    money
        inStock:  bool
        note:     string?
        status:   Status
        category: Category id?
        contact:  Contact
        tags:     string[]?
        operation deactivate() { inStock := false }
        operation rename(newName: string) { name := newName }
      }
      repository Products for Product { }
      repository Categories for Category { }
      workflow restock transactional {
        create(sku: string, qty: int) { precondition qty > 0  let p = Product.create(name: sku, price: 0) }
      }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp with scaffold(aggregates: [Product, Category], workflows: [restock]) {
    api Shop: ShopApi
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

// A rich explicit-page app — List (Table/For over a QueryView data lambda,
// Money/EnumBadge/Badge/Divider) + Detail (byId QueryView, KeyValueRow, Card,
// Bold/Italic, a one-click Action, DestroyForm).  Covers the hand-authored page
// surface the scaffold doesn't (Action, explicit Table row lambda, inline text
// primitives).
const RICH = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      enum Status { active inactive }
      aggregate Product {
        name:   string
        price:  money
        status: Status
        stock:  int
        operation activate() { status := Status.active }
      }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Products {
      route: "/"
      body: Stack {
        Heading { "Products", level: 1 },
        Badge { "beta" },
        Divider { },
        QueryView {
          of: Shop.Product.all,
          loading: Skeleton { },
          error: Alert { "Failed" },
          empty: Text { "None" },
          data: rows => Table {
            each: rows,
            row: p => Stack {
              Text { p.name },
              Money { p.price },
              EnumBadge { p.status },
              Button { "Open", to: "/p/:id" }
            }
          }
        }
      }
    }
    page ProductDetail {
      route: "/p/:id"
      body: QueryView {
        of: Shop.Product.byId(id), single: true,
        loading: Text { "…" }, error: Text { "err" }, empty: Text { "none" },
        data: p => Stack {
          Heading { p.name, level: 1 },
          KeyValueRow { "Stock", Text { p.stock } },
          Card { p.name, Bold { "In stock" }, Italic { "maybe" } },
          Action { p.activate },
          DestroyForm { of: Product }
        }
      }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

// An auth app that reads `currentUser.<claim>` in a body — the case that used to
// emit `/* unresolved */ undefined.email`.  Now the read-side of the gate resolves
// it to a `model.CurrentUser` option-match.
const CURRENT_USER = `
system Shop {
  user { id: string  email: string }
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Home {
      route: "/"
      body: Stack { Heading { "Hi", level: 1 }, Text { currentUser.email } }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 auth: required }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 auth: ui }
}
`;

describe("feliz output carries no JS-isms", () => {
  it("scaffold app (widest primitive + form spread)", async () => {
    expectNoJsIsms(await appFs(SCAFFOLD), "scaffold");
  });

  it("rich explicit-page app (Action / Table row lambda / inline primitives)", async () => {
    expectNoJsIsms(await appFs(RICH), "rich");
  });

  it("currentUser.<claim> in a body (the read-side auth gap)", async () => {
    const app = await appFs(CURRENT_USER);
    expectNoJsIsms(app, "currentUser");
    // The concrete resolution: an option-match against the decoded claims.
    expect(app).toContain(
      '(match model.CurrentUser with Some currentUser -> currentUser.Email | None -> "")',
    );
  });
});
