import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function parseExample(filename: string): Promise<{
  model: Model;
  errors: string[];
}> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.file(path.join(repoRoot, filename)));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? [])
    .filter((d) => d.severity === 1)
    .map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`);
  return { model: doc.parseResult.value as Model, errors };
}

describe("id-link & optional-containment syntax", () => {
  it("parses 'X id', 'X id[]', 'X id?', and 'contains x: Y?'", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        aggregate Customer { name: string  derived display: string = name }
        aggregate Order {
          customerId: Customer id
          relatedIds: Customer id[]
          referrerId: Customer id?
          entity Shipping { addr: string }
          contains shipping: Shipping?
        }
      }
      `,
      { validation: true },
    );
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
    expect(errors).toEqual([]);
    const ctx = (doc.parseResult.value as Model).members[0] as
      | import("../../../src/language/generated/ast.js").BoundedContext
      | undefined;
    const order = ctx!.members.find((m) => m.name === "Order") as
      | import("../../../src/language/generated/ast.js").Aggregate
      | undefined;
    const props = order!.members.filter(
      (m): m is import("../../../src/language/generated/ast.js").Property => m.$type === "Property",
    );
    const customerId = props.find((p) => p.name === "customerId");
    expect(customerId?.type.base.$type).toBe("IdType");
    const relatedIds = props.find((p) => p.name === "relatedIds");
    expect(relatedIds?.type.base.$type).toBe("IdType");
    expect(relatedIds?.type.array).toBe(true);
    const referrerId = props.find((p) => p.name === "referrerId");
    expect(referrerId?.type.base.$type).toBe("IdType");
    expect(referrerId?.type.optional).toBe(true);
    const containments = order!.members.filter(
      (m): m is import("../../../src/language/generated/ast.js").Containment =>
        m.$type === "Containment",
    );
    const shipping = containments.find((c) => c.name === "shipping");
    expect(shipping?.optional).toBe(true);
    expect(shipping?.collection).toBeFalsy();
  });
});

describe("A4 collection transformation ops — parse + validate clean", () => {
  it("parses all six ops in derived props with zero errors", async () => {
    // Element types are chosen so the correctness gates never fire: `join`
    // targets a string projection, `distinct` an int (scalar) projection.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Shop {
        aggregate Order {
          contains lines: OrderLine[]
          derived qtys: int[] = lines.map(l => l.qty)
          derived sortedQtys: int[] = lines.map(l => l.qty).sortBy(q => q)
          derived sortedDesc: int[] = lines.map(l => l.qty).sortBy(q => q, true)
          derived uniqQtys: int[] = lines.map(l => l.qty).distinct
          derived firstTwo: int[] = lines.map(l => l.qty).take(2)
          derived rest: int[] = lines.map(l => l.qty).skip(1)
          derived names: string = lines.map(l => l.name).join(", ")
          entity OrderLine { qty: int  name: string }
        }
        repository Orders for Order { }
      }
      `,
      { validation: true },
    );
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
    expect(errors).toEqual([]);
  });
});

describe("A4 reductions (min/max) — parse + validate clean", () => {
  it("parses min/max over comparable projections into optional `T?` derived with zero errors", async () => {
    // min/max reduce to the PROJECTED value, optional (empty → null): the
    // declared `T?` must match the λ-body element type.  Comparable bodies
    // only (money/int/string/datetime), so the reduction-non-comparable gate
    // never fires.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Shop {
        aggregate Order {
          contains lines: OrderLine[]
          derived cheapest: money? = lines.min(l => l.price)
          derived largestQty: int? = lines.max(l => l.qty)
          derived firstName: string? = lines.min(l => l.name)
          derived latest: datetime? = lines.max(l => l.at)
          entity OrderLine { qty: int  price: money  name: string  at: datetime }
        }
        repository Orders for Order { }
      }
      `,
      { validation: true },
    );
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
    expect(errors).toEqual([]);
  });
});

describe("parsing & validation of examples", () => {
  it("parses sales.ddd without errors", async () => {
    const { model, errors } = await parseExample("examples/sales.ddd");
    expect(errors).toEqual([]);
    const contexts = model.members.filter(
      (m): m is import("../../../src/language/generated/ast.js").BoundedContext =>
        m.$type === "BoundedContext",
    );
    expect(contexts).toHaveLength(1);
    const sales = contexts[0]!;
    expect(sales.name).toBe("Sales");
    const orderAgg = sales.members.find((m) => m.name === "Order");
    expect(orderAgg?.$type).toBe("Aggregate");
  });

  it("parses inventory.ddd without errors", async () => {
    const { errors } = await parseExample("examples/inventory.ddd");
    expect(errors).toEqual([]);
  });

  it("parses a view declaration (smoke)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context T {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order { }
        view ActiveOrders = Order where status == Confirmed
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );
    const ctx = (doc.parseResult.value as Model).members[0] as
      | import("../../../src/language/generated/ast.js").BoundedContext
      | undefined;
    const views = ctx!.members.filter((m) => m.$type === "View");
    expect(views).toHaveLength(1);
  });

  it("parses a workflow declaration (smoke)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer { name: string  derived display: string = name }
        aggregate Order {
          customerId: Customer id
          status: OrderStatus
          placedAt: datetime
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        event OrderPlaced { order: Order id, at: datetime }

        workflow placeOrder {
      create(customerId: Customer id, placedAt: datetime) {
          let customer = Customers.getById(customerId)
          let order = Order.create({
            customerId: customerId,
            status: Draft,
            placedAt: placedAt
          })
          emit OrderPlaced { order: order.id, at: placedAt }
        }
    }

        workflow noop transactional {
      create(amount: decimal) {
          precondition amount > 0
        }
    }
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );
    const ctx = (doc.parseResult.value as Model).members[0] as
      | import("../../../src/language/generated/ast.js").BoundedContext
      | undefined;
    const wfs = ctx!.members.filter((m) => m.$type === "Workflow");
    expect(wfs).toHaveLength(2);
  });

  it("parses a system with `user { ... }` and `auth: required`", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      system Acme {
        user {
          id: string
          role: string
          tenantId: string
        }

        subdomain Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order { }
          }
        }

        deployable api {
          platform: dotnet
          contexts: [Orders]
          port: 8080
          auth: required
        }
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );
    const sys = (doc.parseResult.value as Model).members[0] as
      | import("../../../src/language/generated/ast.js").System
      | undefined;
    const userBlock = sys!.members.find((m) => m.$type === "UserBlock") as
      | import("../../../src/language/generated/ast.js").UserBlock
      | undefined;
    expect(userBlock).toBeDefined();
    expect(userBlock!.fields.map((f) => f.name)).toEqual(["id", "role", "tenantId"]);
    const api = sys!.members.find(
      (m): m is import("../../../src/language/generated/ast.js").Deployable =>
        m.$type === "Deployable" && m.name === "api",
    );
    expect(api?.auth).toBe("required");
  });

  it("parses `requires` statements inside operation bodies", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
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
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );
  });

  it("parses per-module `permissions { ... }` blocks", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      system Acme {
        subdomain Sales {
          permissions {
            ordersConfirm,
            ordersCancel,
            ordersRead
          }
          context Orders {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order { }
          }
        }
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );
    const sys = (doc.parseResult.value as Model).members[0] as
      | import("../../../src/language/generated/ast.js").System
      | undefined;
    const sales = sys!.members.find(
      (m): m is import("../../../src/language/generated/ast.js").Module =>
        m.$type === "Subdomain" && m.name === "Sales",
    );
    expect(sales!.permissions).toHaveLength(1);
    expect(sales!.permissions[0]!.decls.map((d) => d.name)).toEqual([
      "ordersConfirm",
      "ordersCancel",
      "ordersRead",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Page metamodel — grammar smoke tests.
//
// The page metamodel adds six declaration-level keywords (`ui`, `page`,
// `component`, `scaffold`, `state`, `menu`) and two expression-level
// reserved tokens (`match`, `else`).  No IR / lowering / validator
// support yet — these tests confirm only that the grammar accepts the
// new constructs and that the existing identifier surface (especially
// the e2e `ui.workflows.<name>(...)` accessor) keeps parsing.
//
// See docs/page-metamodel.md.
// ---------------------------------------------------------------------------

// Parser-level probe: surfaces `parserErrors` directly (parseSnippet reads
// `doc.diagnostics`, which under validation-off never carries parser errors),
// for tests that assert a construct is a hard grammar rejection.
async function parseRaw(src: string): Promise<{ parserErrors: string[] }> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: false });
  return { parserErrors: doc.parseResult.parserErrors.map((e) => e.message) };
}

async function parseSnippet(src: string): Promise<{ errors: string[]; model: Model }> {
  // This is grammar-only — no IR / validator support for the new
  // constructs yet.  We disable validation so these tests fail iff
  // the parser rejects the input (which is what we're testing).  The
  // validator's view of the new constructs is exercised separately
  // separately.
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: false });
  return {
    errors: (doc.diagnostics ?? [])
      .filter((d) => d.severity === 1)
      .map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`),
    model: doc.parseResult.value as Model,
  };
}

describe("page metamodel — grammar smoke tests", () => {
  it("parses an empty `ui` block as a SystemMember", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a `ui` block with a `scaffold modules: …` directive", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain Sales { context S { } }
        ui WebApp with scaffold(subdomains: [Sales]) {
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses every scaffold selector kind", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui A with scaffold(subdomains: [M], contexts: [S], aggregates: [Order, Customer], workflows: [placeOrder], views: [ActiveOrders]) {
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a deployable's empty-block `ui:` sugar binding", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain M { context C { } }
        ui WebApp { }
        deployable api {
          platform: dotnet
          ui: WebApp
          port: 8080
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects the removed colon-less ui-block binding (framework lives on the ui decl now)", async () => {
    // `ui WebApp { framework: react }` inside a deployable (UiBlockBinding)
    // was removed — the framework belongs on the `ui` declaration, mounted
    // via `ui:` sugar.  The colon-less form is now a hard parse error (the
    // parser expects `ui : ID`), so we assert on parserErrors directly
    // (parseSnippet runs validation-off, so parser errors don't surface as
    // diagnostics).
    const { parserErrors } = await parseRaw(`
      system Acme {
        subdomain M { context C { } }
        ui WebApp { }
        deployable api {
          platform: static
          targets: api
          ui WebApp { framework: react }
          port: 3001
        }
      }
    `);
    expect(parserErrors.length).toBeGreaterThan(0);
  });

  it("parses the replacement idiom: `framework:` on the ui decl + `ui:` sugar mount", async () => {
    const { parserErrors } = await parseRaw(`
      system Acme {
        subdomain M { context C { } }
        ui WebApp { framework: react }
        deployable api {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    expect(parserErrors).toEqual([]);
  });

  it("parses a `page` with state, body, and menu metadata", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp {
          page OrderList {
            route: "/orders"
            state {
              filter: string = ""
            }
            body: List { of: Order }
            menu { section: "Sales", label: "Orders" }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a `component` with parameters and body", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp {
          component OrderPanel(order: Order) {
            body: Stack { items: [order.id, order.status] }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a `component` param typed as `slot`", async () => {
    // PR B: slot is a element-shaped param marker — values flow as
    // JSX from the caller, a bare ref in the body renders the
    // expression at that position.  Only meaningful on component
    // params; the validator pins the position restriction.
    const { errors } = await parseSnippet(`
      system S {
        ui WebApp {
          component DetailView(heading: slot, primaryAction: slot) {
            body: Stack { heading, primaryAction }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a top-level `component` declared as a `ModelMember`", async () => {
    // Top-level components live outside any `system { … }` so a
    // `.ddd` file becomes a shared component library.  Multi-file
    // imports make them visible workspace-wide; the parser admits
    // the declaration form at the model root unchanged.
    const { errors, model } = await parseSnippet(`
      component Hero(eyebrow: string, title: string) {
        body: Stack { eyebrow, title }
      }
    `);
    expect(errors).toEqual([]);
    const comp = model.members.find((m) => m.$type === "Component");
    expect(comp).toBeDefined();
    expect((comp as { name: string }).name).toBe("Hero");
  });

  it("parses a `page` with a `layout:` property (preset names)", async () => {
    // Grammar admits any ID at the layout position; the validator
    // restricts the v1 value set.  Both presets parse without error
    // (and the AST exposes the LayoutProp under `props`).
    const { errors, model } = await parseSnippet(`
      system Acme {
        ui WebApp {
          page Kiosk {
            route: "/kiosk"
            layout: none
            body: Heading("Kiosk")
          }
          page Dashboard {
            route: "/dash"
            layout: default
            body: Heading("Dash")
          }
        }
      }
    `);
    expect(errors).toEqual([]);
    const sys = model.members.find((m) => m.$type === "System")!;
    const ui = sys.members.find((m) => m.$type === "Ui")!;
    const pages = ui.members.filter((m) => m.$type === "Page");
    const kiosk = pages.find((p) => p.name === "Kiosk")!;
    const layoutProp = kiosk.props.find((p) => p.$type === "LayoutProp")!;
    expect(layoutProp.$type).toBe("LayoutProp");
    expect((layoutProp as { value: string }).value).toBe("none");
    const dash = pages.find((p) => p.name === "Dashboard")!;
    const dashLayout = dash.props.find((p) => p.$type === "LayoutProp")!;
    expect((dashLayout as { value: string }).value).toBe("default");
  });

  it("parses a `menu` block with internal and external links", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp {
          page Home { route: "/", body: Heading { "hi" } }
          menu {
            section "Main" {
              link Home { label: "Home" }
              link "Docs" -> "https://example.com"
            }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses `match { … } expressions in body and derived positions", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp {
          page X {
            route: "/x"
            body: match {
              true => List { of: Order }
              else => Empty {}
            }
          }
        }
        subdomain M {
          context C {
            enum Status { Draft, Confirmed }
            aggregate Order {
              status: Status
              derived label: string = match {
                status == Draft => "Pending"
                else            => "Closed"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses block-body lambdas with mutation statements", async () => {
    // Note: `:=` is currently restricted to operation bodies by the
    // validator, so we wrap the lambda inside an operation.  This test
    // exercises only the grammar acceptance of the block-body form.
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain M {
          context C {
            aggregate Order {
              total: int
              operation noop() {
                let f = x => {
                  let y = x
                  total := y
                }
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("accepts an empty `match { }` at the grammar level — validator will reject", async () => {
    // Empty match bodies are structurally parseable (both arms and
    // `else` are grammatically optional) but semantically useless —
    // the validator pass will warn / error on a match
    // with no arms and no `else`.  Keeping the grammar permissive is
    // the right split: parse-shape vs reachability-of-arms.
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp {
          page X { route: "/x", body: match { } }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("keeps `ui.workflows.<name>(...)` parseable as an LValue in e2e tests", async () => {
    // Critical regression: `ui` and `workflows` are keywords introduced
    // by the grammar but must remain admissible as soft member-access names
    // so the existing e2e test surface keeps parsing.
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain M { context C { } }
        ui A { }
        deployable api {
          platform: dotnet
          port: 8080
        }
        deployable web {
          platform: static
          targets: api
          ui: A
          port: 3001
        }
        test e2e "smoke" against web {
          ui.workflows.placeOrder({ customerId: "x" })
          let rows = ui.views.activeOrders()
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("keeps user fields named `order`/`label`/`hidden` parseable", async () => {
    // These would have been hard keywords if MenuMetaEntry kept its
    // typed alternatives — bare ID + validator-side check avoids the
    // collision.
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain M {
          context C {
            event Tick {
              order: int,
              label: string,
              hidden: bool
            }
            aggregate X { name: string }
            repository Xs for X { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("keeps a field named `state` parseable in property position", async () => {
    // `state` is a hard keyword only in the page `state { … }` block and the
    // storage-kind enum — neither begins an aggregate / VO / event member, so
    // it is admitted as a soft keyword in `Property.name` (it was already in
    // `LooseName`).  Without this, `aggregate Order { state: Status }` failed
    // to parse, which also blocked renaming the `Status` type-ref.
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain M {
          context C {
            enum Status { Open, Closed }
            aggregate Order {
              state: Status
              total: int
            }
            valueobject Snapshot { state: Status }
            event Changed { state: Status }
            repository Orders for Order { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("keeps `title` / `body` parseable as property names", async () => {
    // Live page-DSL keywords (`page X { title:, body: }`) that are also common
    // domain field names — admitted in `Property.name` alongside `state`.
    const { errors } = await parseSnippet(`
      system Acme {
        subdomain M {
          context C {
            aggregate Post {
              title: string
              body: string
            }
            repository Posts for Post { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("keeps the removed storage-role fossils (`primary`/`search`/`events`/`bi`) usable as identifiers", async () => {
    // These were keywords only as legacy `modules: { … }` storage roles, deleted
    // with D-STORAGE-SPLIT.  Dropping them from the soft-keyword lists makes them
    // ordinary identifiers — usable as field names AND still as the `theme`
    // `primary:` token key (which flows through `LooseName`'s `ID` branch).
    const { errors } = await parseSnippet(`
      system Acme {
        theme { primary: "#3b82f6" }
        subdomain M {
          context C {
            aggregate Metric {
              primary: bool
              search: string
              events: int
              bi: string
            }
            repository Metrics for Metric { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses examples/acme.ddd including its `ui WebApp` block", async () => {
    const { errors } = await parseExample("examples/acme.ddd");
    expect(errors).toEqual([]);
  });

  it("parses requirement / solution / testCase with resolved code refs", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      requirement US-001 {
        type: UserStory
        title: "User can log in"
        status: InProgress
        priority: 1
      }
      requirement AC-001 parent US-001 {
        type: AcceptanceCriteria
        title: "Valid credentials grant access"
      }
      system Shop {
        subdomain Identity {
          context Auth {
            aggregate LoginSession {
              operation start() {}
              test "successful start" verifies TC-001 {}
            }
          }
        }
        deployable AuthApi { platform: node  contexts: [Auth] }
      }
      solution SOL-001 for US-001 {
        title: "Login via aggregate"
        entitles [ Identity.Auth.LoginSession.start, AuthApi ]
      }
      testCase TC-001 verifies AC-001 {
        title: "Successful login"
        covers [ Identity.Auth.LoginSession.start ]
      }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );

    const members = (doc.parseResult.value as Model).members;
    const sol = members.find((m) => m.$type === "Solution") as
      | import("../../../src/language/generated/ast.js").Solution
      | undefined;
    // Qualified cross-reference resolved to the operation `start`.
    expect(sol?.entitles[0]?.ref?.$type).toBe("Operation");
    expect(sol?.entitles[0]?.ref?.name).toBe("start");
    expect(sol?.requirement.ref?.name).toBe("US-001");
  });

  it("resolves a code reference to a deployable whose name is a reserved word", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      requirement US-001 { type: UserStory  title: "x" }
      system S {
        subdomain M { context C { aggregate A { operation go() {} } } }
        deployable api { platform: node  contexts: [C] }
      }
      solution SOL-001 for US-001 { entitles [ M.C.A.go, api ] }
      `,
      { validation: true },
    );
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );
    const sol = (doc.parseResult.value as Model).members.find(
      (m) => m.$type === "Solution",
    ) as import("../../../src/language/generated/ast.js").Solution;
    expect(sol.entitles[1]?.ref?.$type).toBe("Deployable");
    expect(sol.entitles[1]?.ref?.name).toBe("api");
  });

  it("rejects an unresolved qualified code reference", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      requirement US-001 { type: UserStory  title: "x" }
      system Shop {
        subdomain Identity { context Auth { aggregate LoginSession { operation start() {} } } }
      }
      testCase TC-001 verifies US-001 {
        covers [ Identity.Auth.LoginSession.nonexistent ]
      }
      `,
      { validation: true },
    );
    const messages = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
    expect(messages.some((m) => m.includes("nonexistent"))).toBe(true);
  });
});
