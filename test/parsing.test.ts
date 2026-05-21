import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

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

describe("parsing & validation of examples", () => {
  it("parses sales.ddd without errors", async () => {
    const { model, errors } = await parseExample("examples/sales.ddd");
    expect(errors).toEqual([]);
    const contexts = model.members.filter(
      (m): m is import("../src/language/generated/ast.js").BoundedContext =>
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
    expect(
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => d.message),
    ).toEqual([]);
    const ctx = (doc.parseResult.value as Model).members[0] as
      | import("../src/language/generated/ast.js").BoundedContext
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
        aggregate Customer { name: string display }
        aggregate Order {
          customerId: Id<Customer>
          status: OrderStatus
          placedAt: datetime
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        event OrderPlaced { order: Id<Order>, at: datetime }

        workflow placeOrder(customerId: Id<Customer>, placedAt: datetime) {
          let customer = Customers.getById(customerId)
          let order = Order.create({
            customerId: customerId,
            status: Draft,
            placedAt: placedAt
          })
          emit OrderPlaced { order: order.id, at: placedAt }
        }

        workflow noop(amount: decimal) transactional {
          precondition amount > 0
        }
      }
      `,
      { validation: true },
    );
    expect(
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => d.message),
    ).toEqual([]);
    const ctx = (doc.parseResult.value as Model).members[0] as
      | import("../src/language/generated/ast.js").BoundedContext
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

        module Sales {
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
          modules: Sales
          port: 8080
          auth: required
        }
      }
      `,
      { validation: true },
    );
    expect(
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => d.message),
    ).toEqual([]);
    const sys = (doc.parseResult.value as Model).members[0] as
      | import("../src/language/generated/ast.js").System
      | undefined;
    const userBlock = sys!.members.find((m) => m.$type === "UserBlock") as
      | import("../src/language/generated/ast.js").UserBlock
      | undefined;
    expect(userBlock).toBeDefined();
    expect(userBlock!.fields.map((f) => f.name)).toEqual([
      "id",
      "role",
      "tenantId",
    ]);
    const api = sys!.members.find(
      (m): m is import("../src/language/generated/ast.js").Deployable =>
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
        module Sales {
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
    expect(
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => d.message),
    ).toEqual([]);
  });

  it("parses per-module `permissions { ... }` blocks", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
      system Acme {
        module Sales {
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
    expect(
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => d.message),
    ).toEqual([]);
    const sys = (doc.parseResult.value as Model).members[0] as
      | import("../src/language/generated/ast.js").System
      | undefined;
    const sales = sys!.members.find(
      (m): m is import("../src/language/generated/ast.js").Module =>
        m.$type === "Module" && m.name === "Sales",
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
// Page metamodel — grammar smoke tests (Slice 1).
//
// The page metamodel adds six declaration-level keywords (`ui`, `page`,
// `component`, `scaffold`, `state`, `menu`) and two expression-level
// reserved tokens (`match`, `else`).  No IR / lowering / validator
// support yet — these tests confirm only that the grammar accepts the
// new constructs and that the existing identifier surface (especially
// the e2e `ui.workflows.<name>(...)` accessor) keeps parsing.
//
// See docs/page-metamodel.md and /root/.claude/plans/yes-make-full-plan-tingly-sunbeam.md.
// ---------------------------------------------------------------------------

async function parseSnippet(
  src: string,
): Promise<{ errors: string[]; model: Model }> {
  // Slice 1 is grammar-only — no IR / validator support for the new
  // constructs yet.  We disable validation so these tests fail iff
  // the parser rejects the input (which is what we're testing).  The
  // validator's view of the new constructs is exercised separately
  // in Slice 3.
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

describe("page metamodel — grammar smoke tests (Slice 1)", () => {
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
        module Sales { context S { } }
        ui WebApp {
          scaffold modules: Sales
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses every scaffold selector kind", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui A {
          scaffold modules: M
          scaffold contexts: C
          scaffold aggregates: Order, Customer
          scaffold workflows: placeOrder
          scaffold views: ActiveOrders
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a deployable's empty-block `ui:` sugar binding", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        module M { context C { } }
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

  it("parses a deployable's full ui-block binding with framework", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        module M { context C { } }
        ui WebApp { }
        deployable api {
          platform: static
          targets: api
          ui WebApp { framework: react }
          port: 3001
        }
      }
    `);
    expect(errors).toEqual([]);
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
            body: List(of: Order)
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
            body: Stack(items: [order.id, order.status])
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("parses a `menu` block with internal and external links", async () => {
    const { errors } = await parseSnippet(`
      system Acme {
        ui WebApp {
          page Home { route: "/", body: Heading("hi") }
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
              true => List(of: Order)
              else => Empty()
            }
          }
        }
        module M {
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
        module M {
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

  it("accepts an empty `match { }` at the grammar level — Slice 3 validator will reject", async () => {
    // Empty match bodies are structurally parseable (both arms and
    // `else` are grammatically optional) but semantically useless —
    // the validator pass in Slice 3 will warn / error on a match
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
    // by Slice 1 but must remain admissible as soft member-access names
    // so the existing e2e test surface keeps parsing.
    const { errors } = await parseSnippet(`
      system Acme {
        module M { context C { } }
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
        module M {
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
        module Identity {
          context Auth {
            aggregate LoginSession {
              operation start() {}
              test "successful start" verifies TC-001 {}
            }
          }
        }
        deployable AuthApi { platform: hono  modules: Identity }
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
    expect(
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => d.message),
    ).toEqual([]);

    const members = (doc.parseResult.value as Model).members;
    const sol = members.find((m) => m.$type === "Solution") as
      | import("../src/language/generated/ast.js").Solution
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
        module M { context C { aggregate A { operation go() {} } } }
        deployable api { platform: hono  modules: M }
      }
      solution SOL-001 for US-001 { entitles [ M.C.A.go, api ] }
      `,
      { validation: true },
    );
    expect(
      (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message),
    ).toEqual([]);
    const sol = (doc.parseResult.value as Model).members.find(
      (m) => m.$type === "Solution",
    ) as import("../src/language/generated/ast.js").Solution;
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
        module Identity { context Auth { aggregate LoginSession { operation start() {} } } }
      }
      testCase TC-001 verifies US-001 {
        covers [ Identity.Auth.LoginSession.nonexistent ]
      }
      `,
      { validation: true },
    );
    const messages = (doc.diagnostics ?? [])
      .filter((d) => d.severity === 1)
      .map((d) => d.message);
    expect(messages.some((m) => m.includes("nonexistent"))).toBe(true);
  });
});
