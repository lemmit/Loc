import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("validation", () => {
  it("flags non-bool invariants", async () => {
    const { errors } = await parse(`
      context T {
        valueobject V {
          n: int
          invariant n + 1
        }
      }
    `);
    expect(errors.some((e) => /invariant/i.test(e) && /bool/i.test(e))).toBe(true);
  });

  it("flags wrong-arity intrinsic matcher calls", async () => {
    // The compiler knows the test-matcher surface, so it enforces arity:
    // `toHaveText` takes exactly one argument.
    const { errors } = await parse(`
      context T {
        aggregate A {
          name: string
          derived bad: bool = name.toHaveText("a", "b")
        }
      }
    `);
    expect(errors.some((e) => /matcher/i.test(e) && /argument/i.test(e))).toBe(true);
  });

  it("flags a bare-boolean 'expect' with no matcher", async () => {
    // Assertions are method-based: `expect` must carry a matcher.  The bare
    // `expect <bool>` form is rejected (use `expect(x).toBe(y)`).
    const { errors } = await parse(`
      context T {
        aggregate A {
          name: string
          derived display: string = name
          test "name is set" {
            let a = A.create({ name: "y" })
            expect a.name == "y"
          }
        }
      }
    `);
    expect(errors.some((e) => /expect/i.test(e) && /matcher/i.test(e))).toBe(true);
  });

  it("flags 'toThrow(<status>)' used outside a 'test e2e' block", async () => {
    // The status argument pins a live HTTP rejection, so it is only valid in an
    // e2e block; an in-process unit test must use a bare `toThrow()`.
    const { errors } = await parse(`
      context T {
        aggregate A {
          name: string
          derived display: string = name
          operation rename(n: string) { name := n }
          test "rename to empty is rejected" {
            let a = A.create({ name: "y" })
            expect(a.rename("")).toThrow(400)
          }
        }
      }
    `);
    expect(errors.some((e) => /toThrow/.test(e) && /e2e/i.test(e))).toBe(true);
  });

  it("flags a non-integer-literal 'toThrow' status argument", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M {
          context C {
            aggregate Account {
              balance: int
              invariant balance >= 0
              derived display: string = "acct"
            }
            repository Accounts for Account { }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        test e2e "negative balance is rejected" against api {
          expect(api.accounts.create({ balance: -1 })).toThrow("400")
        }
      }
    `);
    expect(errors.some((e) => /toThrow/.test(e) && /integer/i.test(e))).toBe(true);
  });

  it("flags non-bool preconditions", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          operation tweak(y: int) {
            precondition x + y
          }
        }
      }
    `);
    expect(errors.some((e) => /precondition/i.test(e) && /bool/i.test(e))).toBe(true);
  });

  it("flags emit field shape mismatch", async () => {
    const { errors } = await parse(`
      context T {
        event Done { who: string }
        aggregate A {
          name: string
          operation finish() {
            emit Done { who: 42 }
          }
        }
      }
    `);
    expect(errors.some((e) => /Done/.test(e) || /string/.test(e))).toBe(true);
  });

  it("rejects assignment to a derived property", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          derived doubled: int = x * 2
          operation tweak() {
            doubled := 0
          }
        }
      }
    `);
    expect(errors.some((e) => /derived/i.test(e))).toBe(true);
  });

  it("accepts a well-typed aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          invariant x >= 0
          operation bump() {
            precondition x >= 0
            x := x + 1
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("accepts a single string `display` field on an aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          sku: string
          derived display: string = sku
          desc: string
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects multiple `derived display` fields on an aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          sku: string
          derived display: string = sku
          name: string
          derived display: string = name
        }
      }
    `);
    expect(errors.some((e) => /multiple 'derived display' fields/i.test(e))).toBe(true);
  });

  it("rejects `derived display` with a non-string return type", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          qty: int
          derived display: int = qty
        }
      }
    `);
    expect(errors.some((e) => /must have type 'string'/i.test(e))).toBe(true);
  });

  it("rejects a react deployable without 'targets:'", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context T { aggregate A { x: int } } }
        deployable api { platform: node, contexts: [T], port: 3000 }
        deployable web { platform: react, port: 3001 }
      }
    `);
    expect(errors.some((e) => /targets/i.test(e))).toBe(true);
  });

  it("rejects 'targets:' on a non-react deployable", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context T { aggregate A { x: int } } }
        deployable api { platform: node, contexts: [T], port: 3000 }
        deployable other { platform: node, contexts: [T], targets: api, port: 3010 }
      }
    `);
    expect(errors.some((e) => /targets/i.test(e))).toBe(true);
  });

  it("rejects a react deployable targeting another react deployable", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context T { aggregate A { x: int } } }
        deployable api { platform: node, contexts: [T], port: 3000 }
        deployable webA { platform: react, targets: api, port: 3001 }
        deployable webB { platform: react, targets: webA, port: 3002 }
      }
    `);
    expect(errors.some((e) => /frontend/i.test(e) && /target/i.test(e))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Page metamodel validator obligations.
  // ---------------------------------------------------------------------------

  describe("v2 hard cut: legacy constructor call forms", () => {
    it('rejects positional VO call (Money(10, "USD")) — must use BuilderCall', async () => {
      const { errors } = await parse(`
        context Sales {
          valueobject Money { amount: decimal  currency: string }
          aggregate Order {
            derived total: Money = Money(0.0, "USD")
          }
        }
      `);
      expect(errors.some((e) => /v2 syntax.*construct 'Money' with builder-call/.test(e))).toBe(
        true,
      );
    });

    it("rejects entity-part call (LineItem(...)) — must use BuilderCall", async () => {
      const { errors } = await parse(`
        context Sales {
          aggregate Order {
            entity LineItem { qty: int }
            contains lines: LineItem[]
            operation addLine(qty: int) {
              lines += LineItem(qty)
            }
          }
        }
      `);
      expect(errors.some((e) => /v2 syntax.*entity part 'LineItem'.*builder-call/.test(e))).toBe(
        true,
      );
    });

    it("accepts the BuilderCall form", async () => {
      const { errors } = await parse(`
        context Sales {
          valueobject Money { amount: decimal  currency: string }
          aggregate Order {
            derived total: Money = Money { amount: 0.0, currency: "USD" }
          }
        }
      `);
      expect(errors.some((e) => /v2 syntax/.test(e))).toBe(false);
    });
  });

  describe("v2 BuilderCall — unknown type names", () => {
    it("rejects a typo on a VO name", async () => {
      const { errors } = await parse(`
        context Sales {
          valueobject Money { amount: decimal  currency: string }
          aggregate Order {
            derived total: Money = Mony { amount: 0.0, currency: "USD" }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type 'Mony'/.test(e))).toBe(true);
    });

    it("special-cases the `Aggregate { }` literal — points at `.create({ … })`", async () => {
      // An aggregate root is constructed through its `create({ … })` factory,
      // not the value-object `{ }` builder literal.  Reaching for `Task { … }`
      // must NOT surface the generic "unknown builder type" hint (which talks
      // about walker primitives and misroutes the fix) — it names the remedy.
      const { errors } = await parse(`
        system S {
          subdomain M {
            context C {
              aggregate Task with crudish {
                title: string
                test "bare literal" {
                  let t = Task { title: "x" }
                  expect(t.title).toBe("x")
                }
              }
              repository Tasks for Task { }
            }
          }
        }
      `);
      // The targeted diagnostic fires…
      expect(
        errors.some((e) => /'Task' is an aggregate — construct it with 'Task\.create\(/.test(e)),
      ).toBe(true);
      // …and the generic builder-type error does NOT (it would misdirect).
      expect(errors.some((e) => /Unknown builder type 'Task'/.test(e))).toBe(false);
    });

    it("rejects a typo on a walker primitive name", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page P {
              route: "/p"
              body: Stak { Heading { "hi" } }
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type 'Stak'/.test(e))).toBe(true);
    });

    it("rejects the retired polymorphic `Form` (split into the named-leaf forms)", async () => {
      // The polymorphic `Form { creates: | runs: | of: | <inst>.<op> }`
      // dispatcher was replaced by the four named-leaf primitives
      // (CreateForm / OperationForm / WorkflowForm / DestroyForm).  Plain
      // `Form` must stay rejected so the old spelling can't silently
      // resurface, and the diagnostic hint must not advertise it as a
      // valid primitive.
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate Order { status: string } } }
          ui WebApp { page P { route: "/p"  body: Form { of: Order } } }
        }
      `);
      expect(errors.some((e) => /Unknown builder type 'Form'/.test(e))).toBe(true);
      // The hint suggests a real primitive, never the retired `Form`.
      expect(errors.some((e) => /e\.g\., Stack, Form, Card/.test(e))).toBe(false);
    });

    it("rejects the removed `scaffold*` body sentinels (no longer admissible)", async () => {
      // The hand-written `scaffold*` page-body primitives (and their IR
      // phase ⑤c expander) were removed — the only scaffold surface is now
      // the `with scaffold(...)` page macro, which emits full unfoldable
      // trees.  A bare `scaffoldList { of: X }` in a page body must fail
      // validation as an unknown builder type.
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate Order { name: string } repository Orders for Order {} } }
          ui WebApp { page P { route: "/p"  body: scaffoldList { of: Order } } }
        }
      `);
      expect(errors.some((e) => /Unknown builder type 'scaffoldList'/.test(e))).toBe(true);
    });

    it("accepts a known walker primitive", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page P { route: "/p"  body: Stack { Heading { "hi" } } }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type/.test(e))).toBe(false);
    });

    it("accepts a user-defined component", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            component PageBox(title: string) { body: Card { title } }
            page P { route: "/p"  body: PageBox { "hi" } }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type/.test(e))).toBe(false);
    });

    it("accepts a root-level (model-scope) value object constructed by name", async () => {
      // A `valueobject` declared at file scope — outside any context — is
      // an ambient shared-kernel type.  Constructing it by bare name from a
      // context in the SAME document must resolve: the enclosing context's
      // VOs were already accepted, this covers the file-level ones (gap
      // fix — previously rejected as an unknown builder type).
      const { errors } = await parse(`
        valueobject Weight { grams: decimal  invariant grams >= 0 }
        context C {
          aggregate Parcel {
            w: Weight
            derived display: string = "p"
            operation reweigh(extra: decimal) {
              w := Weight { grams: w.grams + extra }
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type/.test(e))).toBe(false);
    });

    it("accepts a record payload constructed by name in a `return` (exception-less)", async () => {
      // A record payload (`error`/`payload`/…) is a structural record, so it's
      // constructible with the builder-call form — the producer-side surface
      // for exception-less returns (exception-less.md).  `NotFound { … }` must
      // resolve where it previously failed as an unknown builder type.
      const { errors } = await parse(`
        context Shop {
          error NotFound { resource: string }
          aggregate Order {
            code: string
            operation lookup(): string or NotFound {
              return NotFound { resource: code }
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type/.test(e))).toBe(false);
    });

    it("rejects a typo on a payload name", async () => {
      const { errors } = await parse(`
        context Shop {
          error NotFound { resource: string }
          aggregate Order {
            code: string
            operation lookup(): string or NotFound {
              return NotFund { resource: code }
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown builder type 'NotFund'/.test(e))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Page metamodel validator obligations.
  // ---------------------------------------------------------------------------
  describe("page metamodel", () => {
    it("rejects duplicate ui block names within a system", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp { }
          ui WebApp { }
        }
      `);
      expect(errors.some((e) => /Duplicate ui block 'WebApp'/.test(e))).toBe(true);
    });

    it("rejects 'ui:' on a 'platform: node' deployable", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], ui: WebApp, port: 3000 }
        }
      `);
      expect(errors.some((e) => /binding is only valid on platforms that mount a UI/.test(e))).toBe(
        true,
      );
    });

    it("accepts 'ui:' on a 'platform: dotnet' deployable (fullstack mode)", async () => {
      // dotnet flipped from backend-only to dual-mode.  A
      // dotnet deployable that declares `ui:` becomes a fullstack
      // service that hosts an embedded React SPA from wwwroot/.
      // Backend-only dotnet (no `ui:`) keeps working unchanged.
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: dotnet, contexts: [T], ui: WebApp, port: 8080 }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects a 'platform: static' deployable without a 'ui:' binding", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web { platform: static, targets: api, port: 3001 }
        }
      `);
      expect(errors.some((e) => /Static deployable 'web' must declare a 'ui:'/.test(e))).toBe(true);
    });

    it("accepts a 'platform: static' deployable with a 'ui:' binding", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("accepts a 'platform: react' deployable with a 'ui:' binding", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects an unknown framework value on the ui declaration", async () => {
      // Framework now lives on the `ui` declaration (the deployable's
      // colon-less block-binding form was removed).  The grammar's
      // Framework enum rejects an unsupported value as a parse error.
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { framework: blazor-wasm }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web {
            platform: static
            targets: api
            ui: WebApp
            port: 3001
          }
        }
      `);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects a scaffold target that is not a declared module", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp with scaffold(subdomains: [NotAModule]) {
          }
        }
      `);
      // Phase 4: error originates from the macro expander, which
      // uses the registered macro's arg kind ('Subdomain') in the message.
      expect(errors.some((e) => /unknown Subdomain 'NotAModule'/.test(e))).toBe(true);
    });

    it("rejects a scaffold target of the wrong kind (aggregate listed as module)", async () => {
      const { errors } = await parse(`
        system S {
          subdomain Sales {
            context Orders {
              aggregate Order { x: int }
              repository Orders for Order { }
            }
          }
          ui WebApp with scaffold(subdomains: [Order]) {
          }
        }
      `);
      // Order is an Aggregate, not a Subdomain — the lookup against
      // the Subdomain inventory misses, surfacing as 'unknown Subdomain'.
      expect(errors.some((e) => /unknown Subdomain 'Order'/.test(e))).toBe(true);
    });

    it("silently dedupes the same target listed twice within one scaffold call", async () => {
      // The legacy directive raised an error here.  The macro
      // version treats duplicate ref-list elements as benign:
      // the second occurrence emits pages with names that already
      // exist, which the expander's override-by-name rule drops
      // silently.  Outcome is the same number of pages either way.
      const { errors, model } = await parse(`
        system S {
          subdomain Sales { context Orders { aggregate Order { x: int } repository Orders for Order { } } }
          ui WebApp with scaffold(aggregates: [Order, Order]) {
          }
        }
      `);
      expect(errors).toEqual([]);
      // Sanity check: one List page (deduped), not two.
      const { isArea, isPage, isSystem, isUi } = await import(
        "../../../src/language/generated/ast.js"
      );
      type Page = import("../../../src/language/generated/ast.js").Page;
      type Node = import("langium").AstNode;
      const sys = (model.members ?? []).find(isSystem);
      const ui = (sys?.members ?? []).find(isUi);
      // Pages nest in the scaffold's per-aggregate `area`, so collect recursively.
      const collectPages = (members: readonly Node[]): Page[] =>
        (members ?? []).flatMap((m) =>
          isPage(m) ? [m] : isArea(m) ? collectPages(m.members) : [],
        );
      const orderListPages = collectPages(ui?.members ?? []).filter((p) => p.name === "List");
      expect(orderListPages.length).toBe(1);
    });

    it("accepts well-formed scaffold directives (modules / aggregates)", async () => {
      const { errors } = await parse(`
        system S {
          subdomain Sales {
            context Orders {
              aggregate Order { status: string }
              repository Orders for Order { }
            }
          }
          ui WebApp with scaffold(subdomains: [Sales], aggregates: [Order]) {
          }
        }
      `);
      // Match expressions in body/etc. emit warnings; we only check
      // for the absence of errors here.
      expect(errors).toEqual([]);
    });

    it("rejects two pages with the same name in the same ui", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X { route: "/x", body: f() }
            page X { route: "/y", body: g() }
          }
        }
      `);
      expect(errors.some((e) => /Duplicate page 'X' in ui 'WebApp'/.test(e))).toBe(true);
    });

    it("rejects more than one ui-level menu block per ui", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X { route: "/x", body: f() }
            menu { section "Main" { link X } }
            menu { section "Other" { link X } }
          }
        }
      `);
      expect(errors.some((e) => /more than one 'menu \{ \.\.\. \}' block/.test(e))).toBe(true);
    });

    it("rejects more than one body / route / title / requires on a single page", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/a"
              route: "/b"
              body: f()
              body: g()
            }
          }
        }
      `);
      expect(
        errors.some(
          (e) =>
            /declares more than one 'route'/.test(e) || /declares more than one 'body'/.test(e),
        ),
      ).toBe(true);
    });

    it("rejects unknown menu metadata keys on a page", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/x"
              body: f()
              menu { sectionx: "Sales" }
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown menu metadata key 'sectionx'/.test(e))).toBe(true);
    });

    it("accepts the recognised menu metadata keys (section / label / order / hidden)", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/x"
              body: f()
              menu { section: "Sales", label: "X", order: 1, hidden: false }
            }
          }
        }
      `);
      // Body call is fine; match warnings don't apply here.
      expect(errors).toEqual([]);
    });

    it("accepts the recognised layout preset values (default / none)", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page Dash {
              route: "/dash"
              layout: default
              body: f()
            }
            page Kiosk {
              route: "/kiosk"
              layout: none
              body: g()
            }
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects an unknown layout value on a page", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/x"
              layout: weird
              body: f()
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown layout 'weird'/.test(e))).toBe(true);
    });

    it("rejects two `layout:` properties on the same page using the display name", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/x"
              layout: none
              layout: default
              body: f()
            }
          }
        }
      `);
      expect(errors.some((e) => /more than one 'layout' property/.test(e))).toBe(true);
    });

    it("Phase 8: `layout:` is allowed on scaffold-synthesised pages (v1 restriction lifted)", async () => {
      // The singleton Home body shape here is what the scaffold stdlib
      // synthesises for the index page (`src/macros/stdlib/scaffold/_pages.ts`).
      // Phase 8 lifts the v1 restriction so a scaffold Home / OrdersList can
      // opt into a named-layout SystemMember chrome.  The presets
      // `default` / `none` are similarly admitted on these pages.
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page Home {
              route: "/"
              layout: none
              body: Home {}
            }
            page OrdersList {
              route: "/orders"
              layout: default
              body: Stack { Heading { "Orders" } }
            }
          }
        }
      `);
      const matches = errors.filter((e) =>
        /'layout' is not allowed on scaffold-synthesised pages/.test(e),
      );
      expect(matches).toEqual([]);
    });

    it("rejects a menu link to a page declared in a different ui", async () => {
      // page links are real Langium cross-references
      // again now that scaffold expansion runs at the AST level
      // and synthesised pages are first-class AST nodes.  Cross-
      // ui resolution fails through Langium's standard linker
      // ("Could not resolve reference to Page named 'X'") because
      // the default scope provider scopes `[Page:LooseName]`
      // resolution to the containing ui.
      const { errors } = await parse(`
        system S {
          ui A {
            page Home { route: "/", body: f() }
          }
          ui B {
            menu {
              section "Main" { link Home }
            }
          }
        }
      `);
      expect(errors.some((e) => /Could not resolve reference to Page named 'Home'/.test(e))).toBe(
        true,
      );
    });

    it("rejects unknown menu-link property names", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page Home { route: "/", body: f() }
            menu {
              section "Main" {
                link Home { foo: "bar" }
              }
            }
          }
        }
      `);
      expect(errors.some((e) => /Unknown menu link property 'foo'/.test(e))).toBe(true);
    });

    it("rejects an empty 'match { }' expression", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            page X { route: "/x", body: match { } }
          }
        }
      `);
      expect(errors.some((e) => /Empty 'match \{ \}'/.test(e))).toBe(true);
    });

    it("warns on a non-exhaustive 'match' (no else arm)", async () => {
      const { errors, warnings } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/x"
              state { step: int = 0 }
              body: match {
                step == 0 => f()
                step == 1 => g()
              }
            }
          }
        }
      `);
      expect(errors).toEqual([]);
      expect(warnings.some((w) => /no 'else' arm/.test(w))).toBe(true);
    });

    it("accepts an exhaustive 'match' with else", async () => {
      const { warnings } = await parse(`
        system S {
          ui WebApp {
            page X {
              route: "/x"
              state { step: int = 0 }
              body: match {
                step == 0 => f()
                else      => g()
              }
            }
          }
        }
      `);
      expect(warnings.some((w) => /no 'else' arm/.test(w))).toBe(false);
    });

    // Rule 14 — design-pack format must match the deployable's framework.
    // TSX packs (mantine/shadcn/mui/chakra) need a `react` framework;
    // HEEx packs (coreComponents) need `phoenixLiveView`.  Custom packs warn
    // (validator can't read pack.json); `design:` on a non-UI deployable
    // warns that the value will be dropped.
    it("rejects a heex pack on a react frontend", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web {
            platform: react
            targets: api
            ui: WebApp
            port: 3001
            design: coreComponents
          }
        }
      `);
      expect(
        errors.some((e) =>
          /Design pack 'coreComponents' is a heex pack but framework 'react' renders tsx/.test(e),
        ),
      ).toBe(true);
    });

    it("rejects a tsx pack on a phoenix fullstack deployable", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable fullstack {
            platform: elixir
            contexts: [T]
            ui: WebApp
            port: 4000
            design: shadcn
          }
        }
      `);
      expect(
        errors.some((e) =>
          /Design pack 'shadcn' is a tsx pack but framework 'phoenixLiveView' renders heex/.test(e),
        ),
      ).toBe(true);
    });

    it("accepts a matching tsx pack on a react frontend", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web {
            platform: react
            targets: api
            ui: WebApp
            port: 3001
            design: shadcn
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("warns (does not error) on a custom design pack path", async () => {
      const { errors, warnings } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web {
            platform: react
            targets: api
            ui: WebApp
            port: 3001
            design: "./my-custom-pack"
          }
        }
      `);
      expect(errors).toEqual([]);
      expect(
        warnings.some((w) =>
          /Custom design pack '\.\/my-custom-pack'.*not checked at parse time/.test(w),
        ),
      ).toBe(true);
    });

    it('accepts a pinned built-in version (`design: "mantine@v7"`)', async () => {
      // Pack versioning: explicit pin works alongside
      // the bareword form.  Validates `parseBuiltinDesignRef` is
      // wired into Rule 14 — pinned form resolves to the same
      // {family, format} as the bareword.
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web {
            platform: react
            targets: api
            ui: WebApp
            port: 3001
            design: "mantine@v7"
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects an unknown version of a known built-in family", async () => {
      // `mantine@v999` is a registered family but not a registered
      // version → distinctive error listing the available versions
      // for the family.  Catches typos and forward-references to
      // versions that haven't shipped yet.
      const { errors } = await parse(`
        system S {
          subdomain M { context T { } }
          ui WebApp { }
          deployable api { platform: node, contexts: [T], port: 3000 }
          deployable web {
            platform: react
            targets: api
            ui: WebApp
            port: 3001
            design: "mantine@v999"
          }
        }
      `);
      expect(
        errors.some(
          (e) =>
            /no version 'v999' of pack family 'mantine'/.test(e) &&
            /Available: 'mantine@v7'/.test(e),
        ),
      ).toBe(true);
    });

    it("warns when 'design:' is set on a deployable with no UI mount", async () => {
      const { errors, warnings } = await parse(`
        system S {
          subdomain M { context T { } }
          deployable api {
            platform: node
            contexts: [T]
            port: 3000
            design: shadcn
          }
        }
      `);
      expect(errors).toEqual([]);
      expect(
        warnings.some((w) =>
          /Design pack 'shadcn' set on deployable 'api'.*has no UI mount.*ignored/.test(w),
        ),
      ).toBe(true);
    });
  });

  describe("type-position references (X id vs bare name)", () => {
    it("rejects a bare aggregate name in property position with a fixit pointing at 'X id'", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Customer { name: string  derived display: string = name }
          aggregate Order { customer: Customer }
        }
      `);
      expect(
        errors.some((e) =>
          /References across aggregate boundaries need an id link.*'Customer id'/.test(e),
        ),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects a bare aggregate name in operation-parameter position", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Customer { name: string  derived display: string = name }
          aggregate Order {
            customerId: string
            operation assignTo(c: Customer) { customerId := "x" }
          }
        }
      `);
      expect(
        errors.some((e) => /'Customer id'/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects a cross-aggregate entity-part reference (scope keeps it out of resolution)", async () => {
      // The scope provider restricts NamedType.target to same-aggregate
      // entity-parts; a cross-aggregate use surfaces as a "Could not
      // resolve reference" diagnostic.  The user's fixit is to spell
      // out the owner aggregate's id (`Order id`) — same as the message
      // emitted by the storage-position validator for any aggregate
      // ref that resolves.
      const { errors } = await parse(`
        context T {
          aggregate Order {
            entity OrderLine { qty: int }
            contains lines: OrderLine[]
          }
          aggregate Invoice {
            line: OrderLine
          }
        }
      `);
      expect(
        errors.some((e) => /OrderLine/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects an optional collection containment ('[]?' is redundant)", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Order {
            entity OrderLine { qty: int }
            contains lines: OrderLine[]?
          }
        }
      `);
      expect(
        errors.some((e) =>
          /Containment 'lines' is both a collection and optional.*drop the '\?'/.test(e),
        ),
        errors.join("\n"),
      ).toBe(true);
    });

    it("accepts a singular optional containment ('X?')", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Order {
            entity Shipping { addr: string }
            contains shipping: Shipping?
          }
        }
      `);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it("accepts a bare aggregate name in a find return type (queries return domain objects)", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Customer { name: string  derived display: string = name }
          repository Customers for Customer {
            find byName(n: string): Customer? where this.name == n
          }
        }
      `);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it("accepts an event name as a workflow create parameter type", async () => {
      // Transport types (`event` / payload) are offered in scope only in a
      // workflow `create`/`handle` parameter, so `create(e: PaymentReceived)`
      // resolves where a bare event name elsewhere would not.
      const { errors } = await parse(`
        context T {
          aggregate Order { total: int }
          repository Orders for Order { }
          event PaymentReceived { order: Order id, amount: int }
          workflow Fulfillment {
            create(paid: PaymentReceived) by paid.order { let a = paid.amount }
          }
        }
      `);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it("accepts a payload (command) name as a workflow handle parameter type", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Order { total: int }
          repository Orders for Order { }
          command SettleOrder { order: Order id, note: string }
          workflow Fulfillment {
            handle settle(c: SettleOrder) { let n = c.note }
          }
        }
      `);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it("keeps an event name out of scope in an aggregate field position", async () => {
      // Outside a workflow command param, a bare event name is not offered as
      // a type — it surfaces as an unresolved reference rather than silently
      // typing the field as the event's transport record.
      const { errors } = await parse(`
        context T {
          aggregate Order { total: int }
          event PaymentReceived { order: Order id, amount: int }
          aggregate Bad { x: PaymentReceived }
        }
      `);
      expect(
        errors.some((e) => /PaymentReceived/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("keeps an event name out of the 'X id' slot ('PaymentReceived id' is meaningless)", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Order { total: int }
          event PaymentReceived { order: Order id, amount: int }
          aggregate Bad { x: PaymentReceived id }
        }
      `);
      expect(
        errors.some((e) => /PaymentReceived/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });
  });

  describe("slot type position", () => {
    it("admits `slot` on a component parameter", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp {
            component DetailView(heading: slot, primaryAction: slot) {
              body: Stack { heading, primaryAction }
            }
          }
        }
      `);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it("rejects `slot` on an aggregate field", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Order { thing: slot }
        }
      `);
      expect(
        errors.some((e) => /'slot' is only valid on a component's parameter list/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects `slot` on a value-object field", async () => {
      const { errors } = await parse(`
        context T {
          valueobject V { x: slot }
        }
      `);
      expect(
        errors.some((e) => /'slot' is only valid on a component's parameter list/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects `slot` on an operation parameter", async () => {
      const { errors } = await parse(`
        context T {
          aggregate Order {
            status: string
            operation tag(label: slot) {
              status := "Tagged"
            }
          }
        }
      `);
      expect(
        errors.some((e) => /'slot' is only valid on a component's parameter list/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // DataSource declaration checks — kind ↔ storage.type compatibility
  // and per-knob compatibility.  See
  // src/language/validators/datasource.ts.
  // -------------------------------------------------------------------
  describe("resource configuration", () => {
    it("rejects kind: cache backed by a relational storage", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage pg { type: postgres }
          resource cCache { for: C, kind: cache, use: pg }
        }
      `);
      expect(
        errors.some((e) =>
          /resource 'cCache' kind 'cache' is incompatible with storage 'pg' of type 'postgres'/.test(
            e,
          ),
        ),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects kind: state backed by a kv storage (redis)", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage r { type: redis }
          resource cState { for: C, kind: state, use: r }
        }
      `);
      expect(
        errors.some((e) =>
          /resource 'cState' kind 'state' is incompatible with storage 'r' of type 'redis'/.test(e),
        ),
        errors.join("\n"),
      ).toBe(true);
    });

    it("accepts kind: cache backed by redis", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage pg { type: postgres }
          storage r { type: redis }
          resource cState { for: C, kind: state, use: pg }
          resource cCache { for: C, kind: cache, use: r, ttl: 60 }
        }
      `);
      expect(errors.filter((e) => /dataSource/.test(e))).toEqual([]);
    });

    it("rejects 'ttl' on kind: state", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage pg { type: postgres }
          resource cState { for: C, kind: state, use: pg, ttl: 60 }
        }
      `);
      expect(
        errors.some((e) => /resource 'cState': 'ttl' is only meaningful on kind: cache/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects 'every' and 'retain' on kind: state", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage pg { type: postgres }
          resource cState { for: C, kind: state, use: pg, every: 100, retain: 5 }
        }
      `);
      expect(
        errors.some((e) => /'every' is a snapshot-policy knob/.test(e)),
        errors.join("\n"),
      ).toBe(true);
      expect(
        errors.some((e) => /'retain' is a snapshot-policy knob/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects 'keyPrefix' on a relational storage", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage pg { type: postgres }
          resource cState { for: C, kind: state, use: pg, keyPrefix: "x:" }
        }
      `);
      expect(
        errors.some((e) =>
          /resource 'cState': 'keyPrefix' is only meaningful on a key-value storage/.test(e),
        ),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects 'schema' / 'tablePrefix' on a kv storage", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage r { type: redis }
          resource cCache {
            for: C, kind: cache, use: r,
            schema: "x", tablePrefix: "p_"
          }
        }
      `);
      expect(
        errors.some((e) => /'schema' is only meaningful on a relational storage/.test(e)),
        errors.join("\n"),
      ).toBe(true);
      expect(
        errors.some((e) => /'tablePrefix' is only meaningful on a relational storage/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("rejects 'isolationLevel' on kind: cache", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage r { type: redis }
          resource cCache {
            for: C, kind: cache, use: r,
            isolationLevel: serializable
          }
        }
      `);
      expect(
        errors.some((e) => /'isolationLevel' is not meaningful on kind: cache/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });

    it("accepts 'every' / 'retain' on kind: eventLog", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C {
            aggregate A persistedAs: eventLog { x: int }
          } }
          storage pg { type: postgres }
          resource cLog { for: C, kind: eventLog, use: pg, every: 100, retain: 5 }
        }
      `);
      expect(errors.filter((e) => /dataSource/.test(e))).toEqual([]);
    });

    it("rejects duplicate resource names within a system", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { aggregate A { x: int } } }
          storage pg { type: postgres }
          resource cState { for: C, kind: state, use: pg }
          resource cState { for: C, kind: state, use: pg }
        }
      `);
      expect(
        errors.some((e) => /Duplicate resource 'cState'/.test(e)),
        errors.join("\n"),
      ).toBe(true);
    });
  });
});

describe("Loom IR validation (post-lowering)", async () => {
  const { validateLoomModel } = await import("../../../src/ir/validate/validate.js");
  const { toLoomModel, parseString } = await import("../../_helpers/index.js");

  // Note: does NOT assert parse validity — these tests feed deliberately
  // invalid sources and assert on IR-level validateLoomModel diagnostics.
  async function loomFrom(src: string) {
    return toLoomModel((await parseString(src)).model);
  }

  it("rejects api.<unknown> in test e2e", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context T { aggregate Order { x: int } } }
        deployable api { platform: node, contexts: [T], port: 3000 }
        test e2e "missing aggregate" against api {
          let _ = api.unknown.create({})
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /unknown aggregate 'api\.unknown'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("rejects api.<known>.<unknownVerb> in test e2e", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context T { aggregate Order { x: int } } }
        deployable api { platform: node, contexts: [T], port: 3000 }
        test e2e "bad verb" against api {
          let _ = api.orders.frobnicate({})
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /unknown method 'api\.orders\.frobnicate'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("accepts well-formed api e2e tests with no diagnostics", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context T { aggregate Order { customerId: string } } }
        storage pg { type: postgres }
        resource tState { for: T, kind: state, use: pg }
        deployable api {
          platform: node, contexts: [T], dataSources: [tState], port: 3000
        }
        test e2e "good" against api {
          let o = api.orders.create({ customerId: "c-1" })
          let read = api.orders.getById(o)
          let listed = api.orders.all({})
          expect read.customerId == "c-1"
        }
      }
    `);
    const diags = validateLoomModel(loom);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("rejects a mutation statement in a test e2e body", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context T { aggregate Order { x: int } } }
        deployable api { platform: node, contexts: [T], port: 3000 }
        test e2e "mutating body" against api {
          x := 1
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /not supported in an e2e test body/.test(d.message),
      ),
    ).toBe(true);
  });

  it("rejects find with non-queryable where (collection op)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          customerId: string
          contains lines: OrderLine[]
          entity OrderLine { qty: int }
        }
        repository Orders for Order {
          find big(): Order[] where this.lines.count > 0
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /find 'big': where-clause is not queryable/.test(d.message) &&
          /collection projection '\.count'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects find with non-queryable where (lambda)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          customerId: string
          contains lines: OrderLine[]
          entity OrderLine { qty: int }
        }
        repository Orders for Order {
          find anyBig(): Order[] where this.lines.any(l => l.qty > 5)
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" && /find 'anyBig': where-clause is not queryable/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts queryable where clauses (binary, &&, refs)", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Open, Closed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order {
          find activeForCustomer(c: string): Order[]
            where this.customerId == c && this.status == Open
        }
      }
    `);
    const diags = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(diags).toEqual([]);
  });

  it("rejects find name 'save' (collides with auto-emitted save method)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order { sku: string  derived display: string = sku }
        repository Orders for Order {
          find save(s: string): Order[] where this.sku == s
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /find 'save': name collides with the auto-emitted/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects mutating statements inside aggregate-level test blocks", async () => {
    // Aggregate `test "..." { ... }` blocks have no `this` aggregate
    // bound — `assign` / `add` / `remove` / `emit` / `precondition`
    // and private-operation `call` are all structurally nonsensical.
    // Earlier the generator emitted `// TODO: ...` comments into
    // generated test files; now the validator rejects them instead.
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          status: int
          test "bad mutation" {
            status := 1
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /test 'bad mutation': 'status := \.\.\.' mutates state\./.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts well-formed aggregate-level test blocks (let + expect only)", async () => {
    const loom = await loomFrom(`
      context T {
        valueobject Money { amount: decimal, currency: string }
        aggregate Order {
          sku: string
          derived display: string = sku
          test "money builds" {
            let m = Money { amount: 1.0, currency: "USD" }
            expect m.amount == 1.0
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("accepts a well-formed extern operation (precondition-only body)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          sku: string
          derived display: string = sku
          operation confirm() extern {
            precondition sku.length > 0
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects 'private operation X() extern' (no caller for the handler)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          sku: string
          derived display: string = sku
          private operation foo() extern { precondition sku.length > 0 }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" && /'extern' isn't valid on a private operation/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects mutating statements in an extern operation body", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          sku: string
          derived display: string = sku
          operation foo() extern {
            precondition sku.length > 0
            sku := "X"
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /'extern' bodies may only contain 'precondition' statements \(found 'assign'\)/.test(
            d.message,
          ),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects find name 'saveAsync' (.NET-specific reserved name)", async () => {
    // Reserved-name set is the union of every platform's
    // `reservedRepositoryFindNames` — `saveAsync` collides on .NET
    // (Pascal-cased to `SaveAsync()`) but not on Hono.  We catch it
    // either way so a context generated for both platforms stays
    // valid on both.
    const loom = await loomFrom(`
      context T {
        aggregate Order { sku: string  derived display: string = sku }
        repository Orders for Order {
          find saveAsync(s: string): Order[] where this.sku == s
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /find 'saveAsync': name collides with the auto-emitted/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects X id referencing a non-mounted aggregate (react deployable)", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain Customers { context C { aggregate Customer { name: string  derived display: string = name } } }
        subdomain Sales {
          context T {
            aggregate Order {
              customerId: Customer id
            }
          }
        }
        deployable api { platform: node, contexts: [T], port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references Customer id, but 'Customer' is not mounted/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects X id targeting an aggregate without a 'derived display' (react deployable)", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M {
          context T {
            aggregate Customer { email: string }
            aggregate Order { customerId: Customer id }
          }
        }
        deployable api { platform: node, contexts: [T], port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references Customer id, but 'Customer' has no 'derived display'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects where-clause referencing an unknown aggregate field", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Task { name: string  derived display: string = name }
        repository Tasks for Task {
          find byUnknown(p: string): Task[] where this.unknownField == p
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" && /references unknown field 'this\.unknownField'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects where-clause comparing two columns (no value side)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Task { name: string, alt: string  derived display: string = name }
        repository Tasks for Task {
          find both(): Task[] where this.name == this.alt
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /comparison between two columns \('this\.name' vs 'this\.alt'\)/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts X id when the target is mounted AND has a display field", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M {
          context T {
            aggregate Customer { name: string  derived display: string = name }
            aggregate Order { customerId: Customer id }
          }
        }
        storage pg { type: postgres }
        resource tState { for: T, kind: state, use: pg }
        deployable api {
          platform: node, contexts: [T], dataSources: [tState], port: 3000
        }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Workflow validation
  // -----------------------------------------------------------------------

  it("accepts a well-formed workflow (factory + getById + op-call + emit)", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation deductCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit - amount
          }
        }
        aggregate Order {
          customerId: Customer id
          status: OrderStatus
          placedAt: datetime
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        event OrderPlaced { order: Order id, at: datetime }
        workflow placeOrder {
      create(customerId: Customer id, amount: decimal, placedAt: datetime) {
          precondition amount > 0
          let customer = Customers.getById(customerId)
          customer.deductCredit(amount)
          let order = Order.create({
            customerId: customerId,
            status: Draft,
            placedAt: placedAt
          })
          emit OrderPlaced { order: order.id, at: placedAt }
        }
    }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("accepts a transactional workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow topUp transactional {
      create(customerId: Customer id, amount: decimal) {
          precondition amount > 0
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
    }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects calling a private op from a workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          private operation hush() { }
        }
        repository Customers for Customer { }
        workflow w {
      create(customerId: Customer id) {
          let c = Customers.getById(id)
          c.hush()
        }
    }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /'Customer\.hush' is private/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts a parameterless extern op-call from a workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          operation confirm() extern { precondition name.length > 0 }
        }
        repository Customers for Customer { }
        workflow w {
      create(customerId: Customer id) {
          let c = Customers.getById(customerId)
          c.confirm()
        }
    }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("accepts a parameterized extern op-call from a workflow (v13.2 lift)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          creditLimit: decimal
          operation deduct(amount: decimal) extern { precondition amount > 0 }
        }
        repository Customers for Customer { }
        workflow w {
      create(customerId: Customer id, amount: decimal) {
          let c = Customers.getById(customerId)
          c.deduct(amount)
        }
    }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects unknown repo method from a workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer { name: string  derived display: string = name }
        repository Customers for Customer { }
        workflow w {
      create(customerId: Customer id) {
          let c = Customers.byMagic(id)
        }
    }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /repository 'Customers' has no method 'byMagic'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects Agg.create({...}) with missing required fields", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          email: string
        }
        repository Customers for Customer { }
        workflow makeOne {
      create(name: string) {
          let c = Customer.create({ name: name })
        }
    }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /missing required field 'email'/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("does not require a managed field in a workflow create (the server stamps it)", async () => {
    // `managed` fields are server-populated, so the canonical create the
    // workflow invokes is parameterized by the *create-input* fields,
    // which drop managed/token/internal.  Omitting `openedAt` is valid
    // (gap fix — was wrongly reported as a missing required field).
    const loom = await loomFrom(`
      context T {
        aggregate Ticket {
          subject: string
          derived display: string = subject
          openedAt: datetime managed
        }
        repository Tickets for Ticket { }
        workflow open {
          create(subject: string) {
            let t = Ticket.create({ subject: subject })
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects passing a managed field to a workflow create (not a create input)", async () => {
    // The flip side: a managed field is not a legal create argument either
    // (the backend create-call has no parameter for it), so providing one
    // is an unknown-field error rather than being silently accepted.
    const loom = await loomFrom(`
      context T {
        aggregate Ticket {
          subject: string
          derived display: string = subject
          openedAt: datetime managed
        }
        repository Tickets for Ticket { }
        workflow open {
          create(subject: string) {
            let t = Ticket.create({ subject: subject, openedAt: "2026-01-01T00:00:00Z" })
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /has unknown field 'openedAt'/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects a repo find returning an array (no iteration vocab in v1)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
          tier: string
        }
        repository Customers for Customer {
          find byTier(tier: string): Customer[] where this.tier == tier
        }
        workflow w {
      create(tier: string) {
          let cs = Customers.byTier(tier)
        }
    }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /returns an array; v1 supports only single non-nullable aggregates/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects emit with unknown event from a workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer { name: string  derived display: string = name }
        repository Customers for Customer { }
        workflow w {
      create(customerId: Customer id) {
          emit Nope { x: id }
        }
    }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /emit refers to unknown event/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts every isolation level on a transactional workflow", async () => {
    for (const level of ["readUncommitted", "readCommitted", "repeatableRead", "serializable"]) {
      const loom = await loomFrom(`
        context T {
          aggregate Customer {
            name: string
            derived display: string = name
            creditLimit: decimal
            operation addCredit(amount: decimal) {
              precondition amount > 0
              creditLimit := creditLimit + amount
            }
          }
          repository Customers for Customer { }
          workflow w transactional(${level}) {
      create(customerId: Customer id, amount: decimal) {
            let c = Customers.getById(customerId)
            c.addCredit(amount)
          }
    }
        }
      `);
      const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
      expect(errors, `level=${level}: ${JSON.stringify(errors)}`).toEqual([]);
      // IR carries the level verbatim.
      expect(loom.contexts[0]!.workflows[0]!.isolation).toBe(level);
    }
  });

  it("rejects mutation forms (`:=`) inside a workflow body", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string
          derived display: string = name
        }
        repository Customers for Customer { }
        workflow w {
      create(customerId: Customer id) {
          let c = Customers.getById(id)
          c.name := "X"
        }
    }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /isn't a recognised workflow form/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // `requires` clauses
  // ---------------------------------------------------------------------------

  it("rejects a non-bool `requires` expression", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order {
          status: string
          operation cancel() {
            requires "not-a-bool"
            status := "cancelled"
          }
        }
        repository Orders for Order { }
      }
    `);
    expect(errors.some((e) => /'requires' must be of type 'bool'/.test(e))).toBe(true);
  });

  it("accepts `requires` alongside `precondition` in operation bodies", async () => {
    const { errors } = await parse(`
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              status: string
              operation cancel() {
                requires currentUser.role == "manager"
                precondition status != "cancelled"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // auth + currentUser plumbing
  // ---------------------------------------------------------------------------

  it("accepts an auth-required deployable when the system has a user block", async () => {
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          role: string
        }
        subdomain M {
          context T {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order { }
          }
        }
        storage pg { type: postgres }
        resource tState { for: T, kind: state, use: pg }
        deployable api {
          platform: dotnet, contexts: [T], dataSources: [tState],
          port: 8080, auth: required
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("rejects auth: required when the system has no user block", async () => {
    const loom = await loomFrom(`
      system Acme {
        subdomain M { context T { aggregate Order { x: int } repository Orders for Order { } } }
        deployable api { platform: dotnet, contexts: [T], port: 8080, auth: required }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /'auth: required' but system 'Acme' declares no 'user/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects duplicate user-block field names", async () => {
    // Property declarations under `user { ... }` are whitespace-
    // separated, not comma-separated — the grammar uses `fields+=Property*`.
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          id: int
        }
        subdomain M { context T { aggregate Order { x: int } repository Orders for Order { } } }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" && /user block declares field 'id' more than once/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects currentUser inside an aggregate invariant", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string, role: string }
        subdomain M {
          context T {
            aggregate Order {
              status: string
              invariant currentUser.role == "admin"
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /currentUser is only available in per-request handlers/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects currentUser inside a derived property", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string }
        subdomain M {
          context T {
            aggregate Order {
              x: string
              derived label: string = currentUser.id
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /currentUser is only available in per-request handlers/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts currentUser inside an operation body's precondition", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string, role: string }
        subdomain M {
          context T {
            aggregate Order {
              status: string
              operation cancel() {
                precondition currentUser.role == "manager"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("accepts currentUser inside a repository find filter", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string }
        subdomain M {
          context T {
            aggregate Order { customerId: string }
            repository Orders for Order {
              find mine(): Order[] where customerId == currentUser.id
            }
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects workflow calls to a currentUser-bound find", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string, customerId: string }
        subdomain M {
          context T {
            aggregate Customer {
              name: string
              derived display: string = name
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer {
              find me(): Customer where id == currentUser.id
            }
            workflow doIt {
      create() {
              let c = Customers.me()
              c.addCredit(1.0)
            }
    }
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /references a currentUser-bound find/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // per-module `permissions { ... }`
  // -------------------------------------------------------------------------

  it("lowers permissions.X to its '<module>.<name>' runtime string", async () => {
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          permissions: string[]
        }
        subdomain Sales {
          permissions { ordersConfirm, ordersCancel }
          context Orders {
            aggregate Order {
              status: string
              operation cancel() {
                precondition currentUser.permissions.contains(permissions.ordersCancel)
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
    // Walk the operation IR and assert the permissions ref turned
    // into the runtime-string literal.  This is the contract every
    // backend renders against.
    const op = loom.systems[0]!.subdomains[0]!.contexts[0]!.aggregates[0]!.operations[0]!;
    const pre = op.statements.find((s) => s.kind === "precondition");
    const json = JSON.stringify(pre);
    expect(json).toContain('"value":"sales.ordersCancel"');
    // The module's permissions catalogue is exposed on the IR.
    const mod = loom.systems[0]!.subdomains[0]!;
    expect(mod.permissions.map((p) => p.runtimeString)).toEqual([
      "sales.ordersConfirm",
      "sales.ordersCancel",
    ]);
  });

  it("rejects permissions.<unknown> with a friendly diagnostic", async () => {
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          permissions: string[]
        }
        subdomain Sales {
          permissions { ordersConfirm }
          context Orders {
            aggregate Order {
              status: string
              operation cancel() {
                precondition currentUser.permissions.contains(permissions.ordersDelete)
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /permissions\.ordersDelete: no permission named 'ordersDelete'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects duplicate permission names within a module", async () => {
    const loom = await loomFrom(`
      system Acme {
        subdomain Sales {
          permissions {
            ordersConfirm,
            ordersConfirm
          }
          context T {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /permission 'ordersConfirm' is declared more than once/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects permissions.X from a context whose module has no permissions block", async () => {
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          permissions: string[]
        }
        subdomain Sales {
          context Orders {
            aggregate Order {
              status: string
              operation cancel() {
                precondition currentUser.permissions.contains(permissions.anything)
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /permissions\.anything: no permission named 'anything'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  // -------------------------------------------------------------------
  // resource coverage — every backend deployable must declare a
  // matching resource per (hosted-context, persistenceStrategy→kind)
  // pair.  See validateDataSourceCoverage in src/ir/validate/validate.ts.
  // -------------------------------------------------------------------

  it("rejects a backend deployable that hosts a state-based aggregate without a kind:state dataSource", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        deployable api { platform: node, contexts: [C], port: 3000 }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(
      errors.some(
        (d) =>
          /Deployable 'api' hosts aggregate 'C\.A'/.test(d.message) &&
          /kind: state/.test(d.message),
      ),
      JSON.stringify(errors),
    ).toBe(true);
  });

  it("rejects a backend deployable that hosts an eventSourced aggregate without a kind:eventLog dataSource", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C {
          aggregate Invoice persistedAs: eventLog { amount: int }
        } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        deployable api {
          platform: node, contexts: [C], dataSources: [cState], port: 3000
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    // The state binding doesn't cover the eventSourced aggregate.
    expect(
      errors.some(
        (d) =>
          /Deployable 'api' hosts aggregate 'C\.Invoice'/.test(d.message) &&
          /kind: eventLog/.test(d.message),
      ),
      JSON.stringify(errors),
    ).toBe(true);
  });

  it("accepts when every hosted (context, kind) has a matching dataSource", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        deployable api {
          platform: node, contexts: [C], dataSources: [cState], port: 3000
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("doesn't fire for frontend-only deployables (react / static)", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        deployable api {
          platform: node, contexts: [C], dataSources: [cState], port: 3000
        }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("doesn't fire for empty contexts (no aggregates)", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context Empty { } }
        deployable api { platform: node, contexts: [Empty], port: 3000 }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Inverse of the coverage rule: a resource listed on a deployable
  // that doesn't match any aggregate in the hosted contexts is dead
  // config.  Emitted as a warning (not error) because it may stage a
  // binding for an aggregate the user is about to add.
  // -------------------------------------------------------------------

  it("warns on kind: eventLog binding when the context has only stateBased aggregates", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        resource cLog   { for: C, kind: eventLog, use: pg }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cLog], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.some(
        (d) =>
          /lists resource 'cLog' \(kind: eventLog\)/.test(d.message) &&
          /no aggregate is persistedAs\(eventLog\)/.test(d.message),
      ),
      JSON.stringify(warnings),
    ).toBe(true);
  });

  it("warns on kind: state binding when every aggregate is eventSourced", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C {
          aggregate A persistedAs: eventLog { x: int }
        } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        resource cLog   { for: C, kind: eventLog, use: pg }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cLog], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.some(
        (d) =>
          /lists resource 'cState' \(kind: state\)/.test(d.message) &&
          /every aggregate is persistedAs\(eventLog\)/.test(d.message),
      ),
      JSON.stringify(warnings),
    ).toBe(true);
  });

  it("warns on kind: snapshot binding when no aggregate is eventSourced", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        resource cSnap  { for: C, kind: snapshot, use: pg }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cSnap], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.some(
        (d) =>
          /lists resource 'cSnap' \(kind: snapshot\)/.test(d.message) &&
          /no aggregate is persistedAs\(eventLog\)/.test(d.message),
      ),
      JSON.stringify(warnings),
    ).toBe(true);
  });

  it("does NOT warn on kind: cache or kind: replica when an aggregate exists", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        storage r  { type: redis }
        resource cState   { for: C, kind: state, use: pg }
        resource cCache   { for: C, kind: cache, use: r }
        resource cReplica { for: C, kind: replica, use: pg }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cCache, cReplica], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.filter((d) => /lists dataSource/.test(d.message)),
      JSON.stringify(warnings),
    ).toEqual([]);
  });

  it("does NOT warn when every listed resource matches a hosted aggregate", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C {
          aggregate A { x: int }
          aggregate B persistedAs: eventLog { y: int }
        } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        resource cLog   { for: C, kind: eventLog, use: pg }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cLog], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(warnings, JSON.stringify(warnings)).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Honest-note pass: knobs accepted by the AST validator but not yet
  // consumed by any emitter.  Today: ttl / every / retain /
  // isolationLevel / readonly / keyPrefix.  These warn at IR-validate
  // time so authors don't believe a no-op value has effect.
  // -------------------------------------------------------------------

  it("warns when 'ttl' is set on a kind: cache dataSource", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        storage r  { type: redis }
        resource cState { for: C, kind: state, use: pg }
        resource cCache { for: C, kind: cache, use: r, ttl: 60 }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cCache], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.some(
        (d) =>
          /resource 'cCache' sets 'ttl'/.test(d.message) &&
          /no Redis-backed cache adapter is implemented yet/.test(d.message),
      ),
      JSON.stringify(warnings),
    ).toBe(true);
  });

  it("warns when 'every' and 'retain' are set on a kind: eventLog dataSource", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C {
          aggregate A persistedAs: eventLog { x: int }
        } }
        storage pg { type: postgres }
        resource cLog { for: C, kind: eventLog, use: pg, every: 100, retain: 5 }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cLog], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.some((d) => /resource 'cLog' sets 'every'/.test(d.message)),
      JSON.stringify(warnings),
    ).toBe(true);
    expect(
      warnings.some((d) => /resource 'cLog' sets 'retain'/.test(d.message)),
      JSON.stringify(warnings),
    ).toBe(true);
  });

  it("does NOT warn when 'isolationLevel' is set on a kind: state resource (now wired through resolveWorkflowIsolation)", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg,
          isolationLevel: serializable
        }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.filter((d) => /isolationLevel/.test(d.message)),
      JSON.stringify(warnings),
    ).toEqual([]);
  });

  it("warns when 'keyPrefix' is set on a kind: cache dataSource", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        storage r  { type: redis }
        resource cState { for: C, kind: state, use: pg }
        resource cCache { for: C, kind: cache, use: r, keyPrefix: "x:" }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState, cCache], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.some((d) => /resource 'cCache' sets 'keyPrefix'/.test(d.message)),
      JSON.stringify(warnings),
    ).toBe(true);
  });

  it("does NOT warn when only 'schema' / 'tablePrefix' are set (both are wired)", async () => {
    const loom = await loomFrom(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg,
          schema: "custom", tablePrefix: "p_"
        }
        deployable api {
          platform: node, contexts: [C],
          dataSources: [cState], port: 3000
        }
      }
    `);
    const warnings = validateLoomModel(loom).filter((d) => d.severity === "warning");
    expect(
      warnings.filter((d) => /sets '/.test(d.message)),
      JSON.stringify(warnings),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------
  // DSL extensions: matches / check / private invariant.
  // -------------------------------------------------------------------
  describe("DSL extensions", () => {
    it("accepts a valid `string.matches(literal)` invariant", async () => {
      const { errors } = await parse(`
        context T {
          aggregate A {
            email: string
            invariant email.matches("^[^@]+@.+$")
          }
          repository As for A { }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects a `matches` argument that is not a string literal", async () => {
      const { errors } = await parse(`
        context T {
          aggregate A {
            email: string
            pattern: string
            invariant email.matches(pattern)
          }
          repository As for A { }
        }
      `);
      expect(errors.some((e) => /'matches' argument must be a string literal/.test(e))).toBe(true);
    });

    it("rejects a `matches` pattern that doesn't compile as a regex", async () => {
      const { errors } = await parse(`
        context T {
          aggregate A {
            email: string
            invariant email.matches("[invalid")
          }
          repository As for A { }
        }
      `);
      expect(errors.some((e) => /not a valid regular expression/.test(e))).toBe(true);
    });

    it("accepts a property with a bool `check` clause", async () => {
      const { errors } = await parse(`
        context T {
          aggregate A {
            email: string check email.length <= 120
            derived display: string = email
          }
          repository As for A { }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects a property `check` clause that doesn't type to bool", async () => {
      const { errors } = await parse(`
        context T {
          aggregate A {
            n: int check n + 1
          }
          repository As for A { }
        }
      `);
      expect(errors.some((e) => /Property check on 'n'/.test(e) && /bool/.test(e))).toBe(true);
    });

    it("accepts `private invariant` (server-only opt-out)", async () => {
      const { errors } = await parse(`
        context T {
          aggregate A {
            email: string
            private invariant email.matches("^[^@]+@.+$")
          }
          repository As for A { }
        }
      `);
      expect(errors).toEqual([]);
    });
  });

  describe("traceability", () => {
    it("accepts a well-formed requirement / solution / testCase", async () => {
      const { errors } = await parse(`
        requirement US-001 { type: UserStory  title: "Login"  status: InProgress  priority: 1 }
        requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "Valid creds" }
        system S {
          subdomain M { context C { aggregate A { operation go() {} } } }
        }
        solution SOL-001 for US-001 { title: "x"  entitles [ M.C.A.go ] }
        testCase TC-001 verifies AC-001 { title: "t"  covers [ M.C.A.go ] }
      `);
      expect(errors).toEqual([]);
    });

    it("flags missing required type/title, unknown keys, and bad enum values", async () => {
      const { errors } = await parse(`
        requirement R1 { status: Nope }
        requirement R2 { type: Bogus  title: 5  foo: 1 }
      `);
      expect(errors.some((e) => /missing the required 'type'/.test(e))).toBe(true);
      expect(errors.some((e) => /missing the required 'title'/.test(e))).toBe(true);
      expect(errors.some((e) => /status must be one of/.test(e))).toBe(true);
      expect(errors.some((e) => /type must be one of/.test(e))).toBe(true);
      expect(errors.some((e) => /title must be a string literal/.test(e))).toBe(true);
      expect(errors.some((e) => /Unknown requirement property 'foo'/.test(e))).toBe(true);
    });

    it("flags a cyclic parent chain", async () => {
      const { errors } = await parse(`
        requirement A parent B { type: UserStory  title: "a" }
        requirement B parent A { type: UserStory  title: "b" }
      `);
      expect(errors.some((e) => /cyclic parent chain/.test(e))).toBe(true);
    });

    it("rejects an unresolved code reference", async () => {
      const { errors } = await parse(`
        requirement US-001 { type: UserStory  title: "x" }
        system S { subdomain M { context C { aggregate A { operation go() {} } } } }
        solution SOL-001 for US-001 { entitles [ M.C.A.missing ] }
      `);
      expect(errors.some((e) => /missing/.test(e))).toBe(true);
    });
  });
});
