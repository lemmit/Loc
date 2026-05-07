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

  describe("slice 16.A — container basics", () => {
    it("http/index.ts mounts /ready that pings the DB and returns 503 on failure", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model);
      const httpIndex = files.get("http/index.ts")!;
      expect(httpIndex).toMatch(/app\.get\("\/ready"/);
      // Drizzle ping via sql`select 1` — cheap, dialect-agnostic.
      expect(httpIndex).toMatch(/db\.execute\(sql`select 1`\)/);
      expect(httpIndex).toMatch(/from "drizzle-orm"/);
      // 503 envelope with one-line cause.
      expect(httpIndex).toMatch(/status: "not_ready"/);
      expect(httpIndex).toMatch(/, 503\)/);
    });

    it("root index.ts captures the server and listens for SIGTERM/SIGINT", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model);
      const idx = files.get("index.ts")!;
      expect(idx).toMatch(/const server = serve\(/);
      expect(idx).toMatch(/process\.on\("SIGTERM"/);
      expect(idx).toMatch(/process\.on\("SIGINT"/);
      expect(idx).toMatch(/server\.close/);
      expect(idx).toMatch(/pool\.end\(\)/);
    });

    it("root index.ts fails fast on missing DATABASE_URL", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model);
      const idx = files.get("index.ts")!;
      expect(idx).toMatch(/if \(!process\.env\.DATABASE_URL\)/);
      expect(idx).toMatch(/DATABASE_URL is required/);
    });
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

  describe("slice 16.B — extern handler exception envelope", () => {
    it("domain/errors.ts exports ExternHandlerError", async () => {
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model);
      const errors = files.get("domain/errors.ts")!;
      expect(errors).toMatch(/export class ExternHandlerError extends Error/);
      // Carries op + agg names + the inner cause.
      expect(errors).toMatch(/readonly opName: string;/);
      expect(errors).toMatch(/readonly aggName: string;/);
      expect(errors).toMatch(/readonly cause: unknown;/);
      // Message embeds op + agg + inner.
      expect(errors).toMatch(/Extern handler '\$\{opName\}' on '\$\{aggName\}' threw/);
    });

    it("per-aggregate routes wrap the user handler call and onError maps ExternHandlerError to 500", async () => {
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
      const routes = files.get("http/order.routes.ts")!;
      // Imports the new error type.
      expect(routes).toMatch(
        /import \{ DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError \} from "\.\.\/domain\/errors\.js"/,
      );
      // Wraps the handler call in try/catch.
      expect(routes).toMatch(/try \{\s+await handler\(aggregate, body\);/);
      // Domain-layer errors re-throw unchanged.
      expect(routes).toMatch(/if \(err instanceof DomainError\) throw err;/);
      expect(routes).toMatch(/if \(err instanceof ForbiddenError\) throw err;/);
      expect(routes).toMatch(/if \(err instanceof AggregateNotFoundError\) throw err;/);
      // Anything else wraps as ExternHandlerError with op + agg names.
      expect(routes).toMatch(
        /throw new ExternHandlerError\("confirm", "Order", err\);/,
      );
      // onError checks ExternHandlerError before the generic 500.
      expect(routes).toMatch(/if \(err instanceof ExternHandlerError\)/);
      // Generic 500 fallback survives unchanged for unknown errors.
      expect(routes).toMatch(/return c\.json\(\{ error: "internal" \}, 500\)/);
    });

    it("does NOT register a defaultHook on OpenAPIHono (Zod's 400 stays the contract)", async () => {
      // The framework's default 400 envelope for Zod-OpenAPI schema
      // failures is the published contract for request-validation
      // errors.  Forking it would break every OpenAPI-generated
      // client.  Pin the absence.
      const model = await buildModel("examples/sales.ddd");
      const files = generateTypeScript(model);
      const httpIndex = files.get("http/index.ts")!;
      const orderRoutes = files.get("http/order.routes.ts")!;
      expect(httpIndex).not.toMatch(/defaultHook/);
      expect(orderRoutes).not.toMatch(/defaultHook/);
    });

    it("workflow extern op-call wraps the user handler the same way", async () => {
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
            operation confirm() extern { precondition isMutable() }
          }
          repository Orders for Order { }
          workflow confirmOne(orderId: Id<Order>) {
            let order = Orders.getById(orderId)
            order.confirm()
          }
        }
      `, { validation: true });
      const files = generateTypeScript(doc.parseResult.value as Model);
      const wf = files.get("http/workflows.ts")!;
      // Same import line as the per-aggregate router.
      expect(wf).toMatch(
        /import \{ DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError \} from "\.\.\/domain\/errors\.js"/,
      );
      // Try/catch around the workflow's handler invocation.
      expect(wf).toMatch(/try \{\s+await __handler\(order/);
      expect(wf).toMatch(
        /throw new ExternHandlerError\("confirm", "Order", err\);/,
      );
      // onError chain knows about ExternHandlerError.
      expect(wf).toMatch(/if \(err instanceof ExternHandlerError\)/);
    });

    it("per-aggregate extern registry re-exports ExternHandlerError", async () => {
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
            operation confirm() extern { precondition isMutable() }
          }
          repository Orders for Order { }
        }
      `, { validation: true });
      const files = generateTypeScript(doc.parseResult.value as Model);
      const extern = files.get("domain/order-extern.ts")!;
      // User handler code can import ExternHandlerError straight
      // from the per-aggregate file rather than reaching for
      // domain/errors.js itself.
      expect(extern).toMatch(
        /export \{ ExternHandlerError \} from "\.\/errors\.js"/,
      );
    });
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

  it("emits a Hono /views router + per-view repository method", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order { }
        view ActiveOrders = Order where status == Confirmed
      }
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);

    // 1. http/views.ts mounts the route; reuses the aggregate's
    //    list response schema for OpenAPI symmetry.
    const views = files.get("http/views.ts")!;
    expect(views).toMatch(
      /import \{ OrderResponse, OrderListResponse \} from "\.\/order\.routes\.js"/,
    );
    expect(views).toMatch(/path: "\/active_orders"/);
    expect(views).toMatch(/operationId: "activeOrdersView"/);
    expect(views).toMatch(/schema: OrderListResponse/);
    expect(views).toMatch(/await repo\.activeOrders\(\)/);
    expect(views).toMatch(/rows\.map\(\(r\) => repo\.toWire\(r\)\)/);

    // 2. http/index.ts mounts /views.
    const httpIndex = files.get("http/index.ts")!;
    expect(httpIndex).toMatch(/import \{ viewsRoutes \} from "\.\/views\.js"/);
    expect(httpIndex).toMatch(/app\.route\("\/views", viewsRoutes\(db, events\)\)/);

    // 3. The repository file gained an activeOrders() method whose
    //    Drizzle query embeds the lowered predicate.
    const repo = files.get("db/repositories/order-repository.ts")!;
    expect(repo).toMatch(/async activeOrders\(\): Promise<Order\[\]>/);
    expect(repo).toMatch(/eq\(schema\.orders\.status, "Confirmed"\)/);

    // 4. The aggregate routes file's response schema is exported so
    //    the views router can import it without duplicating shapes.
    const aggRoutes = files.get("http/order.routes.ts")!;
    expect(aggRoutes).toMatch(/export const OrderResponse = z\.object/);
    expect(aggRoutes).toMatch(/export const OrderListResponse =/);
  });

  it("emits a custom-shape view with per-row projection (full form)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
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
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);
    const views = files.get("http/views.ts")!;

    // Custom Zod schema declared at top of the file.
    expect(views).toMatch(
      /const OrderSummaryRow = z\.object\(\{[\s\S]+?orderId: z\.string\(\),[\s\S]+?status: z\.enum\(\["Draft", "Confirmed"\]\),[\s\S]+?lineCount: z\.number\(\)\.int\(\),[\s\S]+?\}\)/,
    );
    expect(views).toMatch(
      /const OrderSummaryResponse = z\.array\(OrderSummaryRow\)/,
    );

    // Route uses the custom response schema.
    expect(views).toMatch(/schema: OrderSummaryResponse/);

    // Body projects through bind expressions rooted at row var `r`.
    expect(views).toMatch(/orderId: r\.id/);
    expect(views).toMatch(/status: r\.status/);
    expect(views).toMatch(/lineCount: r\.lines\.length/);
    expect(views).toMatch(
      /projected as z\.infer<typeof OrderSummaryResponse>/,
    );
  });

  it("rewrites Id<X> follow refs to bulk-load + map lookups (slice 3)", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Customer { name: string display, email: string }
        aggregate Order {
          customerId: Id<Customer>
          status: OrderStatus
        }
        repository Customers for Customer { }
        repository Orders for Order { }
        view CustomerOrders {
          orderId: Id<Order>
          customerName: string
          customerEmail: string
          status: OrderStatus
          from Order where status == Confirmed
          bind orderId = id, customerName = customerId.name, customerEmail = customerId.email, status = status
        }
      }
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);
    const views = files.get("http/views.ts")!;

    // Foreign aggregate's repo is imported and instantiated.
    expect(views).toMatch(
      /import \{ CustomerRepository \} from "..\/db\/repositories\/customer-repository\.js"/,
    );
    expect(views).toMatch(/const customerRepo = new CustomerRepository\(db, events\)/);
    // Bulk load + map by id.
    expect(views).toMatch(
      /const customerById = new Map\(\(await customerRepo\.findManyByIds\(rows\.map\(\(r\) => r\.customerId\)\)\)\.map\(\(__a\) => \[__a\.id as string, __a\]\)\)/,
    );
    // Projection rewrites the Id-follow refs.
    expect(views).toMatch(/customerName: customerById\.get\(r\.customerId as string\)!\.name/);
    expect(views).toMatch(/customerEmail: customerById\.get\(r\.customerId as string\)!\.email/);

    // Repo gained findManyByIds.
    const customerRepo = files.get("db/repositories/customer-repository.ts")!;
    expect(customerRepo).toMatch(
      /async findManyByIds\(ids: Ids\.CustomerId\[\]\): Promise<Customer\[\]>/,
    );
    expect(customerRepo).toMatch(
      /\.where\(inArray\(schema\.customers\.id, ids\)\)/,
    );
  });

  it("workflow op-call to a parameterless extern emits the dispatch dance", async () => {
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
          operation confirm() extern { precondition isMutable() }
        }
        repository Orders for Order { }
        workflow placeAndConfirm(orderId: Id<Order>) {
          let order = Orders.getById(orderId)
          order.confirm()
        }
      }
    `, { validation: true });
    const files = generateTypeScript(doc.parseResult.value as Model);
    const wf = files.get("http/workflows.ts")!;

    // Per-aggregate extern registry is imported with an alias.
    expect(wf).toMatch(
      /import \{ externHandlers as orderExternHandlers \} from "..\/domain\/order-extern\.js"/,
    );
    // Body: order.checkConfirm → handler lookup + invocation → assertInvariants.
    expect(wf).toMatch(/order\.checkConfirm\(\);/);
    expect(wf).toMatch(/const __handler = orderExternHandlers\.confirmOrder;/);
    expect(wf).toMatch(/await __handler\(order, \{\} as Record<string, never>\);/);
    expect(wf).toMatch(/order\.assertInvariants\(\);/);
    // Save still happens at workflow exit.
    expect(wf).toMatch(/await orders\.save\(order\);/);
  });

  it("workflow op-call to parameterized extern emits the dispatch dance with object-literal request", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
        aggregate Order {
          customerId: string
          status: string
          function isMutable(): bool = status == "Draft"
          operation deduct(amount: decimal) extern {
            precondition isMutable()
            precondition amount > 0
          }
        }
        repository Orders for Order { }
        workflow chargeOrder(orderId: Id<Order>, amount: decimal) {
          let order = Orders.getById(orderId)
          order.deduct(amount)
        }
      }
    `, { validation: true });
    const wf = generateTypeScript(doc.parseResult.value as Model).get("http/workflows.ts")!;
    expect(wf).toMatch(/order\.checkDeduct\(amount\);/);
    expect(wf).toMatch(/await __handler\(order, \{ amount: amount \}\);/);
  });

  it("multi-hop Id<X>.Id<Y>.field follow loads aggregates in dependency order", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Region { name: string display, countryCode: string }
        aggregate Customer { name: string display, regionId: Id<Region> }
        aggregate Order { customerId: Id<Customer>, status: OrderStatus }
        repository Regions for Region { }
        repository Customers for Customer { }
        repository Orders for Order { }
        view OrdersWithRegion {
          orderId: Id<Order>
          regionName: string
          countryCode: string
          from Order where status == Confirmed
          bind orderId = id,
               regionName = customerId.regionId.name,
               countryCode = customerId.regionId.countryCode
        }
      }
    `, { validation: true });
    const wf = generateTypeScript(doc.parseResult.value as Model).get(
      "http/views.ts",
    )!;

    // Both auxiliaries loaded; Customer first, then Region keyed by
    // customer.regionId values.
    expect(wf).toMatch(
      /const customerById = new Map\(\(await customerRepo\.findManyByIds\(rows\.map\(\(r\) => r\.customerId\)\)\)/,
    );
    expect(wf).toMatch(
      /const regionByCustomerId = new Map\(\(await regionRepo\.findManyByIds\(\[\.\.\.customerById\.values\(\)\]\.map\(\(__a\) => __a\.regionId\)\)\)/,
    );
    // Chained projection.
    expect(wf).toMatch(
      /regionName: regionByCustomerId\.get\(customerById\.get\(r\.customerId as string\)!\.regionId as string\)!\.name/,
    );
  });

  it("emits explicit isolationLevel for transactional(level) workflows", async () => {
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
        workflow ser(customerId: Id<Customer>, amount: decimal) transactional(serializable) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow rr(customerId: Id<Customer>, amount: decimal) transactional(repeatableRead) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow ru(customerId: Id<Customer>, amount: decimal) transactional(readUncommitted) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow rc(customerId: Id<Customer>, amount: decimal) transactional(readCommitted) {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
        workflow plain(customerId: Id<Customer>, amount: decimal) transactional {
          let c = Customers.getById(customerId)
          c.addCredit(amount)
        }
      }
    `, { validation: true });
    const wf = generateTypeScript(doc.parseResult.value as Model).get("http/workflows.ts")!;
    expect(wf).toMatch(/\}, \{ isolationLevel: "serializable" \}\);/);
    expect(wf).toMatch(/\}, \{ isolationLevel: "repeatable read" \}\);/);
    expect(wf).toMatch(/\}, \{ isolationLevel: "read uncommitted" \}\);/);
    expect(wf).toMatch(/\}, \{ isolationLevel: "read committed" \}\);/);
    // Bare `transactional` doesn't emit an isolationLevel — exactly
    // four occurrences across the file (one per leveled workflow).
    expect(wf.match(/isolationLevel/g)?.length).toBe(4);
    // The `plain` route still has the transaction wrapper, just without the option.
    expect(wf).toMatch(/operationId: "plainWorkflow"/);
    expect(wf).toMatch(/await db\.transaction\(async \(tx\) =>/);
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

  // -------------------------------------------------------------------------
  // Slice 1A — auth scaffolding
  // -------------------------------------------------------------------------

  describe("auth scaffolding (slice 1A)", () => {
    async function emitForAuthSystem(src: string): Promise<Map<string, string>> {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(src, { validation: true });
      const { lowerModel } = await import("../src/ir/lower.js");
      const { enrichLoomModel } = await import("../src/ir/enrichments.js");
      const { generateTypeScriptForContexts } = await import(
        "../src/generator/typescript/index.js"
      );
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const sys = loom.systems[0]!;
      const dep = sys.deployables.find((d) => d.platform === "hono")!;
      const contexts = sys.modules.flatMap((m) => m.contexts);
      return generateTypeScriptForContexts(contexts, { deployable: dep, sys });
    }

    const SRC_AUTH_REQUIRED = `
      system Acme {
        user {
          id: string
          role: string
        }
        module Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
              operation cancel() {
                precondition currentUser.role == "manager"
                status := "cancelled"
              }
            }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: hono
          modules: Sales
          port: 3000
          auth: required
        }
      }
    `;

    const SRC_NO_AUTH = `
      system Acme {
        user { id: string }
        module Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        deployable api {
          platform: hono
          modules: Sales
          port: 3000
        }
      }
    `;

    it("emits auth/* files when deployable opts in via `auth: required`", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const keys = [...files.keys()];
      expect(keys).toContain("auth/user-types.ts");
      expect(keys).toContain("auth/verifier.ts");
      expect(keys).toContain("auth/middleware.ts");
    });

    it("does NOT emit auth/* files when the deployable has no `auth: required`", async () => {
      const files = await emitForAuthSystem(SRC_NO_AUTH);
      const keys = [...files.keys()];
      expect(keys).not.toContain("auth/user-types.ts");
      expect(keys).not.toContain("auth/middleware.ts");
    });

    it("http/index.ts mounts authMiddleware after cors() and asserts verifier registration", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const httpIndex = files.get("http/index.ts")!;
      expect(httpIndex).toMatch(/app\.use\("\*", authMiddleware\);/);
      expect(httpIndex).toMatch(/assertUserVerifierRegistered\(\);/);
      const cors = httpIndex.indexOf('app.use("*", cors())');
      const auth = httpIndex.indexOf('app.use("*", authMiddleware)');
      expect(cors).toBeGreaterThan(0);
      expect(auth).toBeGreaterThan(cors);
    });

    it("middleware bypasses /health, /openapi.json, /swagger", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const mw = files.get("auth/middleware.ts")!;
      expect(mw).toMatch(/"\/health"/);
      expect(mw).toMatch(/"\/openapi\.json"/);
      expect(mw).toMatch(/"\/swagger"/);
    });

    it("aggregate operation referencing currentUser gains a User parameter and the route threads currentUser into the call", async () => {
      const files = await emitForAuthSystem(SRC_AUTH_REQUIRED);
      const order = files.get("domain/order.ts")!;
      expect(order).toMatch(/cancel\([^)]*currentUser: User[^)]*\)/);
      expect(order).toMatch(/currentUser\.role/);
      const route = files.get("http/order.routes.ts")!;
      expect(route).toMatch(/c\.get\("currentUser"\)/);
      expect(route).toMatch(/aggregate\.cancel\(currentUser\)/);
    });

    // -----------------------------------------------------------------------
    // Slice 1C — currentUser inside find / view filters
    // -----------------------------------------------------------------------

    const SRC_FILTER_AUTH = `
      system Acme {
        user {
          id: string
          customerId: string
        }
        module Sales {
          context Orders {
            aggregate Order {
              customerId: string
              status: string
            }
            repository Orders for Order {
              find mine(): Order[] where customerId == currentUser.customerId
            }
            view MyOrders = Order where customerId == currentUser.customerId
          }
        }
        deployable api {
          platform: hono
          modules: Sales
          port: 3000
          auth: required
        }
      }
    `;

    it("repository find with currentUser filter gains a User parameter and imports the type", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const repo = files.get("db/repositories/order-repository.ts")!;
      expect(repo).toMatch(
        /import type \{ User \} from "\.\.\/\.\.\/auth\/user-types\.js";/,
      );
      expect(repo).toMatch(/async mine\([^)]*currentUser: User[^)]*\)/);
    });

    it("find route reads c.get(\"currentUser\") and threads it into the repo call", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const route = files.get("http/order.routes.ts")!;
      expect(route).toMatch(/c\.get\("currentUser"\)/);
      expect(route).toMatch(/repo\.mine\(currentUser\)/);
    });

    it("view route reads c.get(\"currentUser\") and threads it into the repo call", async () => {
      const files = await emitForAuthSystem(SRC_FILTER_AUTH);
      const views = files.get("http/views.ts")!;
      expect(views).toMatch(/httpCtx\.get\("currentUser"\)/);
      expect(views).toMatch(/repo\.myOrders\(currentUser\)/);
    });

    // -----------------------------------------------------------------------
    // Slice 2 — `requires` clauses
    // -----------------------------------------------------------------------

    const SRC_REQUIRES = `
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
        deployable api {
          platform: hono
          modules: Sales
          port: 3000
          auth: required
        }
      }
    `;

    it("`requires` lowers to a ForbiddenError throw inside the aggregate method", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const order = files.get("domain/order.ts")!;
      expect(order).toMatch(/throw new ForbiddenError\(/);
      expect(order).toMatch(
        /import \{ DomainError, ForbiddenError \} from "\.\/errors\.js";/,
      );
    });

    it("errors.ts exports ForbiddenError", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const errors = files.get("domain/errors.ts")!;
      expect(errors).toMatch(/export class ForbiddenError extends Error/);
    });

    it("http/<aggregate>.routes.ts maps ForbiddenError to 403 in app.onError", async () => {
      const files = await emitForAuthSystem(SRC_REQUIRES);
      const route = files.get("http/order.routes.ts")!;
      expect(route).toMatch(
        /if \(err instanceof ForbiddenError\) return c\.json\(\{ error: err\.message \}, 403\);/,
      );
    });
  });
});
