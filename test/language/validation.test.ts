import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

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
          sku: string display
          desc: string
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects multiple `display` fields on an aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          sku: string display
          name: string display
        }
      }
    `);
    expect(errors.some((e) => /multiple 'display' fields/i.test(e))).toBe(true);
  });

  it("rejects `display` on a non-string field", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          qty: int display
        }
      }
    `);
    expect(errors.some((e) => /must have type 'string'/i.test(e))).toBe(true);
  });

  it("rejects a react deployable without 'targets:'", async () => {
    const { errors } = await parse(`
      system S {
        module M { context T { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, port: 3001 }
      }
    `);
    expect(errors.some((e) => /targets/i.test(e))).toBe(true);
  });

  it("rejects 'targets:' on a non-react deployable", async () => {
    const { errors } = await parse(`
      system S {
        module M { context T { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable other { platform: hono, modules: M, targets: api, port: 3010 }
      }
    `);
    expect(errors.some((e) => /targets/i.test(e))).toBe(true);
  });

  it("rejects a react deployable targeting another react deployable", async () => {
    const { errors } = await parse(`
      system S {
        module M { context T { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable webA { platform: react, targets: api, port: 3001 }
        deployable webB { platform: react, targets: webA, port: 3002 }
      }
    `);
    expect(errors.some((e) => /frontend/i.test(e) && /target/i.test(e))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Page metamodel — Slice 3 validator obligations.
  // ---------------------------------------------------------------------------

  describe("page metamodel (Slice 3)", () => {
    it("rejects duplicate ui block names within a system", async () => {
      const { errors } = await parse(`
        system S {
          ui WebApp { }
          ui WebApp { }
        }
      `);
      expect(errors.some((e) => /Duplicate ui block 'WebApp'/.test(e))).toBe(true);
    });

    it("rejects 'ui:' on a 'platform: hono' deployable", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, ui: WebApp, port: 3000 }
        }
      `);
      expect(errors.some((e) => /'ui:' binding is only valid/.test(e))).toBe(true);
    });

    it("accepts 'ui:' on a 'platform: dotnet' deployable (fullstack mode)", async () => {
      // Part B: dotnet flipped from backend-only to dual-mode.  A
      // dotnet deployable that declares `ui:` becomes a fullstack
      // service that hosts an embedded React SPA from wwwroot/.
      // Backend-only dotnet (no `ui:`) keeps working unchanged.
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: dotnet, modules: M, ui: WebApp, port: 8080 }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects a 'platform: static' deployable without a 'ui:' binding", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          deployable api { platform: hono, modules: M, port: 3000 }
          deployable web { platform: static, targets: api, port: 3001 }
        }
      `);
      expect(errors.some((e) => /Static deployable 'web' must declare a 'ui:'/.test(e))).toBe(true);
    });

    it("accepts a 'platform: static' deployable with a 'ui:' binding", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("accepts a 'platform: react' deployable with a 'ui:' binding", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
          deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("rejects an unknown framework value in the ui-block binding", async () => {
      // The grammar's Framework enum currently only admits 'react',
      // so this surfaces as a parse error.  Either way the diagnostic
      // surface is the same — the user can't sneak in an unsupported
      // framework today.
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
          deployable web {
            platform: static
            targets: api
            ui WebApp { framework: blazor-wasm }
            port: 3001
          }
        }
      `);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects a scaffold target that is not a declared module", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp {
            scaffold modules: NotAModule
          }
        }
      `);
      expect(errors.some((e) => /no module 'NotAModule' is declared/.test(e))).toBe(true);
    });

    it("rejects a scaffold target of the wrong kind (aggregate listed as module)", async () => {
      const { errors } = await parse(`
        system S {
          module Sales {
            context Orders {
              aggregate Order { x: int }
              repository Orders for Order { }
            }
          }
          ui WebApp {
            scaffold modules: Order
          }
        }
      `);
      expect(errors.some((e) => /no module 'Order' is declared/.test(e))).toBe(true);
    });

    it("rejects the same target listed twice within one scaffold directive", async () => {
      const { errors } = await parse(`
        system S {
          module Sales { context Orders { aggregate Order { x: int } repository Orders for Order { } } }
          ui WebApp {
            scaffold aggregates: Order, Order
          }
        }
      `);
      expect(errors.some((e) => /lists 'Order' more than once/.test(e))).toBe(true);
    });

    it("accepts well-formed scaffold directives (modules / aggregates / views)", async () => {
      const { errors } = await parse(`
        system S {
          module Sales {
            context Orders {
              aggregate Order { status: string }
              repository Orders for Order { }
              view ActiveOrders = Order where status == "open"
            }
          }
          ui WebApp {
            scaffold modules: Sales
            scaffold aggregates: Order
            scaffold views: ActiveOrders
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

    it("rejects a menu link to a page declared in a different ui", async () => {
      // Slice 10 — page links are real Langium cross-references
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
    // HEEx packs (ashPhoenix) need `phoenixLiveView`.  Custom packs warn
    // (validator can't read pack.json); `design:` on a non-UI deployable
    // warns that the value will be dropped.
    it("rejects a heex pack on a react frontend", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
          deployable web {
            platform: react
            targets: api
            ui: WebApp
            port: 3001
            design: ashPhoenix
          }
        }
      `);
      expect(
        errors.some((e) =>
          /Design pack 'ashPhoenix' is a heex pack but framework 'react' renders tsx/.test(e),
        ),
      ).toBe(true);
    });

    it("rejects a tsx pack on a phoenixLiveView fullstack deployable", async () => {
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable fullstack {
            platform: phoenixLiveView
            modules: M
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
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
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
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
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
      // Phase 0 of pack versioning: explicit pin works alongside
      // the bareword form.  Validates `parseBuiltinDesignRef` is
      // wired into Rule 14 — pinned form resolves to the same
      // {family, format} as the bareword.
      const { errors } = await parse(`
        system S {
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
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
          module M { context T { } }
          ui WebApp { }
          deployable api { platform: hono, modules: M, port: 3000 }
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
          module M { context T { } }
          deployable api {
            platform: hono
            modules: M
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
});

describe("Loom IR validation (post-lowering)", async () => {
  const { validateLoomModel } = await import("../../src/ir/validate.js");
  const { toLoomModel, parseString } = await import("../_helpers/index.js");

  // Note: does NOT assert parse validity — these tests feed deliberately
  // invalid sources and assert on IR-level validateLoomModel diagnostics.
  async function loomFrom(src: string) {
    return toLoomModel((await parseString(src)).model);
  }

  it("rejects api.<unknown> in test e2e", async () => {
    const loom = await loomFrom(`
      system S {
        module M { context T { aggregate Order { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
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
        module M { context T { aggregate Order { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
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
        module M { context T { aggregate Order { customerId: string } } }
        deployable api { platform: hono, modules: M, port: 3000 }
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
        module M { context T { aggregate Order { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
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
        aggregate Order { sku: string display }
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
          sku: string display
          test "money builds" {
            let m = Money(1.0, "USD")
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
          sku: string display
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
          sku: string display
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
          sku: string display
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
        aggregate Order { sku: string display }
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

  it("rejects Id<X> referencing a non-mounted aggregate (react deployable)", async () => {
    const loom = await loomFrom(`
      system S {
        module Customers { context C { aggregate Customer { name: string display } } }
        module Sales {
          context T {
            aggregate Order {
              customerId: Id<Customer>
            }
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references Id<Customer>, but 'Customer' is not mounted/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects Id<X> targeting an aggregate without a 'display' field (react deployable)", async () => {
    const loom = await loomFrom(`
      system S {
        module M {
          context T {
            aggregate Customer { email: string }
            aggregate Order { customerId: Id<Customer> }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references Id<Customer>, but 'Customer' has no 'display' field/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects where-clause referencing an unknown aggregate field", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Task { name: string display }
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
        aggregate Task { name: string display, alt: string }
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

  it("accepts Id<X> when the target is mounted AND has a display field", async () => {
    const loom = await loomFrom(`
      system S {
        module M {
          context T {
            aggregate Customer { name: string display }
            aggregate Order { customerId: Id<Customer> }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("accepts a well-formed full-form view (fields + bind)", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          contains lines: OrderLine[]
          entity OrderLine { quantity: int, invariant quantity > 0 }
        }
        repository Orders for Order { }
        view OrderSummary {
          orderId: Id<Order>
          status: OrderStatus
          lineCount: int
          from Order where status == Confirmed
          bind orderId = id, status = status, lineCount = lines.count
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects a full-form view with a field missing its bind", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order { status: string }
        repository Orders for Order { }
        view X {
          a: string
          b: string
          from Order
          bind a = status
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /field 'b' has no bind expression/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects a full-form view with a stray bind (no matching field)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order { status: string }
        repository Orders for Order { }
        view X {
          a: string
          from Order
          bind a = status, ghost = status
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" && /bind 'ghost' has no matching declared field/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects duplicate binds on the same field", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order { status: string }
        repository Orders for Order { }
        view X {
          a: string
          from Order
          bind a = status, a = status
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /field 'a' is bound more than once/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Workflow validation
  // -----------------------------------------------------------------------

  it("accepts a well-formed workflow (factory + getById + op-call + emit)", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer {
          name: string display
          creditLimit: decimal
          operation deductCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit - amount
          }
        }
        aggregate Order {
          customerId: Id<Customer>
          status: OrderStatus
          placedAt: datetime
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        event OrderPlaced { order: Id<Order>, at: datetime }
        workflow placeOrder(customerId: Id<Customer>, amount: decimal, placedAt: datetime) {
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
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("accepts a transactional workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string display
          creditLimit: decimal
          operation addCredit(amount: decimal) {
            precondition amount > 0
            creditLimit := creditLimit + amount
          }
        }
        repository Customers for Customer { }
        workflow topUp(customerId: Id<Customer>, amount: decimal) transactional {
          precondition amount > 0
          let c = Customers.getById(customerId)
          c.addCredit(amount)
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
          name: string display
          private operation secret() { }
        }
        repository Customers for Customer { }
        workflow w(customerId: Id<Customer>) {
          let c = Customers.getById(id)
          c.secret()
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /'Customer\.secret' is private/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts a parameterless extern op-call from a workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string display
          operation confirm() extern { precondition name.length > 0 }
        }
        repository Customers for Customer { }
        workflow w(customerId: Id<Customer>) {
          let c = Customers.getById(customerId)
          c.confirm()
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
          name: string display
          creditLimit: decimal
          operation deduct(amount: decimal) extern { precondition amount > 0 }
        }
        repository Customers for Customer { }
        workflow w(customerId: Id<Customer>, amount: decimal) {
          let c = Customers.getById(customerId)
          c.deduct(amount)
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects unknown repo method from a workflow", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer { name: string display }
        repository Customers for Customer { }
        workflow w(customerId: Id<Customer>) {
          let c = Customers.byMagic(id)
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
          name: string display
          email: string
        }
        repository Customers for Customer { }
        workflow makeOne(name: string) {
          let c = Customer.create({ name: name })
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /missing required field 'email'/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects a repo find returning an array (no iteration vocab in v1)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Customer {
          name: string display
          tier: string
        }
        repository Customers for Customer {
          find byTier(tier: string): Customer[] where this.tier == tier
        }
        workflow w(tier: string) {
          let cs = Customers.byTier(tier)
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
        aggregate Customer { name: string display }
        repository Customers for Customer { }
        workflow w(customerId: Id<Customer>) {
          emit Nope { x: id }
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /emit refers to unknown event/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // View validation
  // -----------------------------------------------------------------------

  it("accepts a well-formed view with a queryable filter", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order { }
        view ActiveOrders = Order where status == Confirmed
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects view with an unknown source aggregate", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order { status: OrderStatus }
        repository Orders for Order { }
        view ActiveOrders = NoSuch where status == Confirmed
      }
    `);
    const diags = validateLoomModel(loom);
    // Langium's cross-ref drops to "Unknown" sentinel when it can't
    // resolve, so the validator surfaces "source 'Unknown' is not an
    // aggregate".  Either rejection mechanism is fine for the user;
    // the test asserts the diagnostic exists in some recognisable form.
    expect(
      diags.some((d) => d.severity === "error" && /is not an aggregate in context/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects view filter using a collection lambda (not queryable)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          customerId: string
          status: string
          contains lines: OrderLine[]
          entity OrderLine { quantity: int }
        }
        repository Orders for Order { }
        view BadOrders = Order where lines.any(l => l.quantity > 0)
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /where-clause is not queryable/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects view filter referencing an unknown field", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          customerId: string
          status: string
        }
        repository Orders for Order { }
        view BadOrders = Order where this.unknownField == "x"
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some((d) => d.severity === "error" && /references unknown field/.test(d.message)),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects view name colliding with an aggregate", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order { status: string }
        repository Orders for Order { }
        view Order = Order where status == "x"
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) => d.severity === "error" && /view 'Order' collides with the aggregate/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts every isolation level on a transactional workflow", async () => {
    for (const level of ["readUncommitted", "readCommitted", "repeatableRead", "serializable"]) {
      const loom = await loomFrom(`
        context T {
          aggregate Customer {
            name: string display
            creditLimit: decimal
            operation addCredit(amount: decimal) {
              precondition amount > 0
              creditLimit := creditLimit + amount
            }
          }
          repository Customers for Customer { }
          workflow w(customerId: Id<Customer>, amount: decimal) transactional(${level}) {
            let c = Customers.getById(customerId)
            c.addCredit(amount)
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
          name: string display
        }
        repository Customers for Customer { }
        workflow w(customerId: Id<Customer>) {
          let c = Customers.getById(id)
          c.name := "X"
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
  // Slice 2 — `requires` clauses
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
        module Sales {
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
  // Slice 1A — auth + currentUser plumbing
  // ---------------------------------------------------------------------------

  it("accepts an auth-required deployable when the system has a user block", async () => {
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          role: string
        }
        module M {
          context T {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order { }
          }
        }
        deployable api { platform: dotnet, modules: M, port: 8080, auth: required }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("rejects auth: required when the system has no user block", async () => {
    const loom = await loomFrom(`
      system Acme {
        module M { context T { aggregate Order { x: int } repository Orders for Order { } } }
        deployable api { platform: dotnet, modules: M, port: 8080, auth: required }
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
        module M { context T { aggregate Order { x: int } repository Orders for Order { } } }
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
        module M {
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
        module M {
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
        module M {
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

  it("accepts currentUser inside a repository find filter (slice 1C)", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string }
        module M {
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

  it("accepts currentUser inside a view where filter (slice 1C)", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string, customerId: string }
        module M {
          context T {
            aggregate Order { customerId: string, status: string }
            repository Orders for Order { }
            view MyOrders = Order where customerId == currentUser.customerId
          }
        }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects workflow calls to a currentUser-bound find (slice 1C deferred)", async () => {
    const loom = await loomFrom(`
      system Acme {
        user { id: string, customerId: string }
        module M {
          context T {
            aggregate Customer {
              name: string display
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer {
              find me(): Customer where id == currentUser.id
            }
            workflow doIt() {
              let c = Customers.me()
              c.addCredit(1.0)
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
  // Slice 1B — per-module `permissions { ... }`
  // -------------------------------------------------------------------------

  it("lowers permissions.X to its '<module>.<name>' runtime string", async () => {
    const loom = await loomFrom(`
      system Acme {
        user {
          id: string
          permissions: string[]
        }
        module Sales {
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
    const op = loom.systems[0]!.modules[0]!.contexts[0]!.aggregates[0]!.operations[0]!;
    const pre = op.statements.find((s) => s.kind === "precondition");
    const json = JSON.stringify(pre);
    expect(json).toContain('"value":"sales.ordersCancel"');
    // The module's permissions catalogue is exposed on the IR.
    const mod = loom.systems[0]!.modules[0]!;
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
        module Sales {
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
        module Sales {
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
        module Sales {
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
  // Slice 21.C — DSL extensions: matches / check / private invariant.
  // -------------------------------------------------------------------
  describe("slice 21.C — DSL extensions", () => {
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
            email: string display check email.length <= 120
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

  describe("traceability (Slice 12)", () => {
    it("accepts a well-formed requirement / solution / testCase", async () => {
      const { errors } = await parse(`
        requirement US-001 { type: UserStory  title: "Login"  status: InProgress  priority: 1 }
        requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "Valid creds" }
        system S {
          module M { context C { aggregate A { operation go() {} } } }
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
        system S { module M { context C { aggregate A { operation go() {} } } } }
        solution SOL-001 for US-001 { entitles [ M.C.A.missing ] }
      `);
      expect(errors.some((e) => /missing/.test(e))).toBe(true);
    });
  });
});
