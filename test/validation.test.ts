import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";

async function parseSource(source: string): Promise<{ errors: string[]; warnings: string[] }> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.parse(`file:///inmem-${Math.random().toString(36).slice(2)}.ddd`));
  doc.textDocument = {
    uri: doc.textDocument.uri,
    languageId: "ddd",
    version: 1,
    getText: () => source,
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
    lineCount: source.split("\n").length,
  } as never;
  // Force re-build by rebuilding from text
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const d of doc.diagnostics ?? []) {
    if (d.severity === 1) errors.push(d.message);
    else if (d.severity === 2) warnings.push(d.message);
  }
  return { errors, warnings };
}

// Convenience: parse from a string by writing to a temp file (URI.parse on
// in-memory text isn't picked up by the Langium document builder in the
// standard config — use the langium/test parseHelper instead).
import { parseHelper } from "langium/test";

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

void parseSource; // keep helper around; use `parse` below

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
    expect(errors.some((e) => /frontend/i.test(e) && /target/i.test(e))).toBe(
      true,
    );
  });
});

describe("Loom IR validation (post-lowering)", async () => {
  const { lowerModel } = await import("../src/ir/lower.js");
  const { enrichLoomModel } = await import("../src/ir/enrichments.js");
  const { validateLoomModel } = await import("../src/ir/validate.js");
  const { parseHelper } = await import("langium/test");
  const { createDddServices } = await import("../src/language/ddd-module.js");

  async function loomFrom(src: string) {
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(src, { validation: true });
    const model = doc.parseResult.value as import("../src/language/generated/ast.js").Model;
    return enrichLoomModel(lowerModel(model));
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
        (d) =>
          d.severity === "error" &&
          /unknown aggregate 'api\.unknown'/.test(d.message),
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
        (d) =>
          d.severity === "error" &&
          /unknown method 'api\.orders\.frobnicate'/.test(d.message),
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
          d.severity === "error" &&
          /find 'anyBig': where-clause is not queryable/.test(d.message),
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
          /test 'bad mutation': 'status := \.\.\.' mutates state\./.test(
            d.message,
          ),
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
          d.severity === "error" &&
          /'extern' isn't valid on a private operation/.test(d.message),
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
          d.severity === "error" &&
          /references unknown field 'this\.unknownField'/.test(d.message),
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
        (d) =>
          d.severity === "error" &&
          /field 'b' has no bind expression/.test(d.message),
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
          d.severity === "error" &&
          /bind 'ghost' has no matching declared field/.test(d.message),
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
        (d) =>
          d.severity === "error" &&
          /field 'a' is bound more than once/.test(d.message),
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
      diags.some(
        (d) =>
          d.severity === "error" &&
          /'Customer\.secret' is private/.test(d.message),
      ),
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
      diags.some(
        (d) =>
          d.severity === "error" &&
          /missing required field 'email'/.test(d.message),
      ),
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
          /returns an array; v1 supports only single non-nullable aggregates/.test(
            d.message,
          ),
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
      diags.some(
        (d) =>
          d.severity === "error" &&
          /emit refers to unknown event/.test(d.message),
      ),
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
      diags.some(
        (d) =>
          d.severity === "error" &&
          /is not an aggregate in context/.test(d.message),
      ),
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
      diags.some(
        (d) =>
          d.severity === "error" &&
          /where-clause is not queryable/.test(d.message),
      ),
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
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references unknown field/.test(d.message),
      ),
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
        (d) =>
          d.severity === "error" &&
          /view 'Order' collides with the aggregate/.test(d.message),
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
        (d) =>
          d.severity === "error" &&
          /isn't a recognised workflow form/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
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
            aggregate Order { customerId: string, status: string }
            repository Orders for Order { }
          }
        }
        deployable api { platform: dotnet, modules: M, port: 8080, auth: required }
      }
    `);
    const errors = validateLoomModel(loom).filter(
      (d) => d.severity === "error",
    );
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
          d.severity === "error" &&
          /user block declares field 'id' more than once/.test(d.message),
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
          /currentUser is only available in per-request handlers/.test(
            d.message,
          ),
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
          /currentUser is only available in per-request handlers/.test(
            d.message,
          ),
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
    const errors = validateLoomModel(loom).filter(
      (d) => d.severity === "error",
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("rejects currentUser inside a repository find filter (slice 1A scope)", async () => {
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
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /currentUser is only available in per-request handlers/.test(
            d.message,
          ),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });
});
