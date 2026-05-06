import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateTypeScript } from "../src/generator/typescript/index.js";
import type { Model } from "../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe("typescript generator", () => {
  it("emits the expected file set for sales.ddd", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const keys = [...files.keys()].sort();
    expect(keys).toContain("domain/ids.ts");
    expect(keys).toContain("domain/value-objects.ts");
    expect(keys).toContain("domain/events.ts");
    expect(keys).toContain("domain/order.ts");
    expect(keys).toContain("db/schema.ts");
    expect(keys).toContain("db/repositories/order-repository.ts");
    expect(keys).toContain("http/order.routes.ts");
    expect(keys).toContain("http/index.ts");
    expect(keys).toContain("package.json");
    expect(keys).toContain("tsconfig.json");
    expect(keys).toContain("index.ts");
  });

  it("renders the Order aggregate with branded ids and operations", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const order = files.get("domain/order.ts")!;
    expect(order).toMatch(/export class Order/);
    expect(order).toMatch(/Ids\.OrderId/);
    expect(order).toMatch(/public confirm\(\)/);
    expect(order).toMatch(/this\._lines\.length > 0/); // collection .count → .length
    expect(order).toMatch(/OrderStatus\.Confirmed/); // enum value qualified
    expect(order).toMatch(/this\._events\.push\({ type: "OrderConfirmed"/);
  });

  it("renders OrderLine with implicit id and parent injection", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const order = files.get("domain/order.ts")!;
    expect(order).toMatch(/OrderLine\._create\(\{ id: Ids\.newOrderLineId\(\), parentId: this\._id/);
  });

  it("emits a vitest test file when `test` blocks are declared", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const tests = files.get("domain/order.test.ts")!;
    expect(tests).toMatch(/import { describe, it, expect } from "vitest"/);
    expect(tests).toMatch(/it\("money literal builds"/);
    expect(tests).toMatch(/expect\(\(\) => \{ new Money\(-1\.0, "USD"\); \}\)\.toThrow\(\)/);
  });

  it("emits Dockerfile + .dockerignore", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const dockerfile = files.get("Dockerfile")!;
    expect(dockerfile).toMatch(/FROM node:22-alpine AS build/);
    expect(dockerfile).toMatch(/FROM node:22-alpine AS runtime/);
    expect(dockerfile).toMatch(/CMD \["node", "out\/index\.js"\]/);
    const dockerignore = files.get(".dockerignore")!;
    expect(dockerignore).toMatch(/node_modules/);
  });

  it("Hono routes use @hono/zod-openapi and expose /openapi.json", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const orderRoutes = files.get("http/order.routes.ts")!;
    expect(orderRoutes).toMatch(/from "@hono\/zod-openapi"/);
    expect(orderRoutes).toMatch(/createRoute\(\{/);
    expect(orderRoutes).toMatch(/operationId: "createOrder"/);
    expect(orderRoutes).toMatch(/operationId: "getOrderById"/);
    expect(orderRoutes).toMatch(/operationId: "addLineOrder"/);
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/app\.doc\("\/openapi\.json"/);
    expect(httpIndex).toMatch(/openapi: "3\.1\.0"/);
    expect(httpIndex).toMatch(/from "hono\/cors"/);
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@hono/zod-openapi"]).toBeTruthy();
  });

  it("emits a full wire-shape OrderResponse + findAll route + repo serializer", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const orderRoutes = files.get("http/order.routes.ts")!;
    // Response carries every aggregate field + parts + derived.
    expect(orderRoutes).toMatch(/OrderResponse = z\.object/);
    expect(orderRoutes).toMatch(/customerId:/);
    expect(orderRoutes).toMatch(/lines: z\.array\(OrderLineResponse\)/);
    expect(orderRoutes).toMatch(/total: MoneySchema/);
    // GET /  (the auto-included `all` find).
    expect(orderRoutes).toMatch(/path: "\/",[\s\S]+?operationId: "allOrder"/);
    // Repository emits a serializer used by route handlers.
    const repo = files.get("db/repositories/order-repository.ts")!;
    expect(repo).toMatch(/toWire\(root: Order\): unknown/);
    expect(repo).toMatch(/async all\(\): Promise<Order\[\]>/);
  });

  it("lowers `where` filter expressions to Drizzle operators (not a TODO comment)", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const repo = files.get("db/repositories/order-repository.ts")!;
    // sales.ddd's `activeForCustomer` declares
    //   where this.customerId == forCustomer && this.status == Draft
    // Both branches lower cleanly; the `&&` becomes `and(...)`.
    expect(repo).toMatch(
      /\.where\(and\(eq\(schema\.orders\.customerId, forCustomer\), eq\(schema\.orders\.status, "Draft"\)\)\)/,
    );
    // Slice B: `as never` casts are gone from generated finds.
    expect(repo).not.toMatch(/as never/);
    // No TODO fallback for this find.
    expect(repo).not.toMatch(/TODO: translate where-clause[\s\S]*activeForCustomer/);
    // The import line picks up `and` (in addition to the always-present
    // `eq` / `inArray`).
    expect(repo).toMatch(/import \{[^}]*\band\b[^}]*\} from "drizzle-orm"/);
  });

  it("`all()` hydrates singular containments (not just collections)", async () => {
    // Regression for an earlier bug: the bulk-find path only loaded
    // ONE collection containment per find and silently dropped
    // singular containments.  The generated `all()` referenced an
    // undefined variable for `contains shipping: Address` — `npx tsc`
    // caught it as a no-undef use, but more importantly the
    // generated runtime code couldn't compile.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context T {
        aggregate Order {
          sku: string display
          contains shipping: Address
          entity Address { street: string }
        }
      }
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);
    const repo = files.get("db/repositories/order-repository.ts")!;
    // The `all()` method now eagerly loads `shipping` via inArray +
    // builds a per-parent map keyed by parentId; hydrate looks up
    // the singular row with `?? null`.
    expect(repo).toMatch(/async all\(\): Promise<Order\[\]>/);
    expect(repo).toMatch(
      /const shippingRows = await this\.db\.select\(\)\.from\(schema\.addresses\)\.where\(inArray\(schema\.addresses\.parentId, __ids\)\)/,
    );
    expect(repo).toMatch(/const shippingByParent = new Map<string, Address>\(\);/);
    expect(repo).toMatch(/shipping: shippingByParent\.get\(root\.id\) \?\? null/);
  });

  it("emits a typed extern handler registry + verify gate for extern operations", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          function isMutable(): bool = status == Draft
          operation confirm() extern {
            precondition isMutable()
          }
        }
        repository Orders for Order { }
      }
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);

    // 1. Per-aggregate extern handler module.
    const extern = files.get("domain/order-extern.ts")!;
    expect(extern).toMatch(/export type ConfirmOrderRequest = Record<string, never>/);
    expect(extern).toMatch(
      /export type ConfirmOrderHandler = \(aggregate: Order, request: ConfirmOrderRequest\) => Promise<void>/,
    );
    expect(extern).toMatch(/externHandlers\.confirmOrder = fn/);
    expect(extern).toMatch(/verifyOrderExternHandlersRegistered/);
    expect(extern).toMatch(/Missing extern handler for 'confirm' on aggregate 'Order'/);

    // 2. Aggregate exposes setters + raiseEvent + assertInvariants.
    const order = files.get("domain/order.ts")!;
    expect(order).toMatch(/set status\(v: OrderStatus\)/);
    expect(order).toMatch(/raiseEvent\(ev: Events\.DomainEvent\)/);
    expect(order).toMatch(/assertInvariants\(\): void/);
    // 3. The user-named method is replaced by `checkConfirm` (preconditions only).
    expect(order).toMatch(/checkConfirm\(\): void/);
    expect(order).not.toMatch(/public confirm\(\)/);

    // 4. Route dispatches through the registry, not a domain method.
    const routes = files.get("http/order.routes.ts")!;
    expect(routes).toMatch(/from "..\/domain\/order-extern\.js"/);
    expect(routes).toMatch(/aggregate\.checkConfirm\(\)/);
    expect(routes).toMatch(/externHandlers\.confirmOrder/);
    expect(routes).toMatch(/await handler\(aggregate, body\)/);
    expect(routes).toMatch(/aggregate\.assertInvariants\(\)/);
    expect(routes).not.toMatch(/aggregate\.confirm\(\)/);

    // 5. http/index.ts wires the verify gate at startup.
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/verifyOrderExternHandlersRegistered/);
  });

  it("emits Hono workflow routes for non-transactional workflow", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
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
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);
    const wf = files.get("http/workflows.ts")!;

    // Imports + Zod schema for params.
    expect(wf).toMatch(/import \{ Customer \} from "..\/domain\/customer\.js"/);
    expect(wf).toMatch(/import \{ CustomerRepository \} from "..\/db\/repositories\/customer-repository\.js"/);
    expect(wf).toMatch(/PlaceOrderRequest = z\.object\(\{[\s\S]+?customerId: z\.string\(\)/);

    // Body wires repos on `db`, runs precondition, calls op, factory,
    // emit, then saves both, then dispatches events.
    expect(wf).toMatch(/const customers = new CustomerRepository\(db, events\);/);
    expect(wf).toMatch(/const orders = new OrderRepository\(db, events\);/);
    expect(wf).toMatch(/if \(!\(amount > 0\)\) throw new DomainError/);
    expect(wf).toMatch(/const customer = await customers\.getById\(customerId\);/);
    expect(wf).toMatch(/customer\.deductCredit\(amount\);/);
    expect(wf).toMatch(/const order = Order\.create\(\{ customerId: customerId, status: OrderStatus\.Draft, placedAt: placedAt \}\);/);
    expect(wf).toMatch(/workflowEvents\.push\(\{ type: "OrderPlaced", order: order\.id, at: placedAt \}\);/);
    expect(wf).toMatch(/await customers\.save\(customer\);/);
    expect(wf).toMatch(/await orders\.save\(order\);/);
    expect(wf).toMatch(/for \(const ev of workflowEvents\) await events\.dispatch\(ev\);/);
    // Non-transactional: no db.transaction wrapper.
    expect(wf).not.toMatch(/db\.transaction\(/);

    // http/index.ts mounts /workflows.
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/import \{ workflowsRoutes \} from "\.\/workflows\.js";/);
    expect(httpIndex).toMatch(/app\.route\("\/workflows", workflowsRoutes\(db, events\)\);/);
  });

  it("emits a transactional workflow wrapped in db.transaction", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
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
          let target = Customers.getById(customerId)
          target.addCredit(amount)
        }
      }
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);
    const wf = files.get("http/workflows.ts")!;
    expect(wf).toMatch(/await db\.transaction\(async \(tx\) => \{/);
    expect(wf).toMatch(/const customers = new CustomerRepository\(tx, events\);/);
    // Save inside the tx callback.
    const txOpen = wf.indexOf("db.transaction(async");
    const saveIdx = wf.indexOf("await customers.save(target);");
    const txClose = wf.indexOf("});", txOpen);
    expect(saveIdx).toBeGreaterThan(txOpen);
    expect(saveIdx).toBeLessThan(txClose);
  });

  it("Drizzle schema emits indexes for find-referenced columns + part FKs", async () => {
    // sales.ddd's Order.byCustomer + activeForCustomer drive
    // `customerId` and `status` indexes on the orders table; the
    // OrderLine part gets a parentId index so findById's eager-load
    // join doesn't sequential-scan.
    const model = await buildModel("examples/sales.ddd");
    const files = generateTypeScript(model);
    const schema = files.get("db/schema.ts")!;
    expect(schema).toMatch(/import \{[^}]*\bindex\b[^}]*\} from "drizzle-orm\/pg-core"/);
    expect(schema).toMatch(/orderCustomerIdIdx: index\("orders_customer_id_idx"\)\.on\(table\.customerId\)/);
    expect(schema).toMatch(/orderStatusIdx: index\("orders_status_idx"\)\.on\(table\.status\)/);
    expect(schema).toMatch(
      /orderLineParentIdIdx: index\("order_lines_parent_id_idx"\)\.on\(table\.parentId\)/,
    );
  });
});
