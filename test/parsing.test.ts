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
