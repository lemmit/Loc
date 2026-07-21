# 18. Testing

In-language tests live beside the domain they exercise. A `test "…" { }` block on an aggregate is an **executable unit test** of value-object invariants and pure domain logic; a `test e2e "…" against <Deployable> { }` drives a *running* deployable end-to-end. The same `expect(<actual>).<matcher>(…)` assertion vocabulary serves both, and the e2e **surface is chosen automatically from the target deployable's platform** — a backend target lowers to a vitest+fetch (or xUnit) suite, a frontend target to a Playwright spec over generated page objects. Reach for it when you want the spec generated and traced alongside the code it covers.

> **Grammar:** `TestBlock` (`test`), `TestE2E` (`test e2e … against`), `TestStatement`, `ExpectStmt` · **Matchers:** [`src/util/intrinsic-matchers.ts`](../../src/util/intrinsic-matchers.ts) · **Validators:** `loom.aggregate-test-context`, `loom.e2e-unsupported-statement`, `loom.e2e-unknown-{aggregate,method,workflow,view}` ([`src/ir/validate/checks/test-checks.ts`](../../src/ir/validate/checks/test-checks.ts)), `expect`/matcher arity ([`src/language/validators/match.ts`](../../src/language/validators/match.ts)) · **Docs:** [`../traceability.md`](../traceability.md), [`../conformance.md`](../conformance.md)

> **Output sourcing.** Every fragment below is generated, not transcribed. The `node`/UI tabs come from `node bin/cli.js generate system web/src/examples/sales-system.ddd -o out` (the wired example carried in the repo: a `Sales` context with `test` blocks on `Order`, `test e2e … against api`, `test e2e … against webApp`, plus `storage`/`resource`/two deployables). The `dotnet` unit tab and the `toHaveText`/`toHaveCount` UI form come from `generate system examples/acme.ddd -o out`.

## `test "…"` — an in-process unit test

`test name=STRING ('verifies' TraceId)? { TestStatement* }` declares an aggregate-level unit test. It is bound to a **value-object / pure-function context** — there is *no* `this` aggregate instance, so the body may only `let`, call a pure `function`, and `expect`. A statement that mutates aggregate state (`:=` / `+=` / `-=` / `emit`) or guards an op (`precondition` / `requires`) is rejected with `loom.aggregate-test-context` rather than silently emitted. The optional `verifies TC-xxx` back-links the test to a `testCase` in the traceability graph.

```ddd
aggregate Order with crudish {
  customerId: Customer id
  status: OrderStatus
  placedAt: datetime
  contains lines: OrderLine[]

  operation addLine(productId: Product id, qty: int) { /* … */ }
  operation confirm() { /* … */ }

  test "adding a line then confirming yields a confirmed order" verifies TC-001 {
    let order = Order.create({
      customerId: "00000000-0000-0000-0000-000000000001",
      status: Draft,
      placedAt: "2024-01-01T00:00:00Z"
    })
    order.addLine("00000000-0000-0000-0000-000000000002", 2)
    order.confirm()
    expect(order.status).toBe(Confirmed)
    expect(order.lines.count).toBe(1)
  }
}
```

The block lowers to one runnable spec per aggregate, emitted next to the domain class. `Order.create({…})` re-cases id fields to their branded constructors, enum literals resolve to the generated enum, and `.count` becomes the backend-native length.

::: tabs backend
== node
```ts
// api/domain/order.test.ts
import { describe, it, expect } from "vitest";
import { Order } from "./order";
import { OrderStatus } from "./value-objects";
import * as Ids from "./ids";

describe("Order", () => {
  it("adding a line then confirming yields a confirmed order", () => {
    const order = Order.create({ customerId: Ids.CustomerId("00000000-0000-0000-0000-000000000001"), status: OrderStatus.Draft, placedAt: new Date("2024-01-01T00:00:00Z") });
    order.addLine("00000000-0000-0000-0000-000000000002", 2);
    order.confirm();
    expect(order.status).toBe(OrderStatus.Confirmed);
    expect(order.lines.length).toBe(1);
  });
});
```
== dotnet
```csharp
// api/Tests/Api.Tests/Orders/OrderTests.cs — xUnit + AwesomeAssertions
using Xunit;
using Api.Domain.Orders;
using Api.Domain.Enums;

namespace Api.Tests.Orders;

public sealed class OrderTests
{
    [Fact(DisplayName = "confirming an order with no lines is rejected")]
    public void Confirming_an_order_with_no_lines_is_rejected()
    {
        var order = Order.Create(customerId: "cust-001", status: OrderStatus.Draft, placedAt: DateTime.UtcNow);
        Assert.Throws<DomainException>(() => { order.Confirm(); });
    }
}
```
::: end

The test name becomes the vitest `it(...)` label verbatim; on xUnit it is both the `[Fact(DisplayName = …)]` and a snake-cased method name. The aggregate name is the `describe(...)` / class scope.

## `test e2e "…" against <Deployable>` — a live end-to-end test

`test e2e name=STRING 'against' deployable=[Deployable] ('verifies' TraceId)? { … }` is a system-level test (declared in the `system` body, not inside an aggregate) that drives a deployment. The body talks to the deployable through a **magic dispatcher** — `api.<aggregate>.<verb>(…)` against a backend, `ui.<aggregate>.<verb>(…)` against a frontend — plus `let` and `expect`. Domain mutations and guards are rejected here too (`loom.e2e-unsupported-statement`); an unknown aggregate/verb/workflow/view is caught against the deployable's hosted contexts (`loom.e2e-unknown-*`).

The verb vocabulary per aggregate is `create`, `getById`, every **public** operation, every repository `find`, plus the reserved `api.workflows.<name>(…)` and `api.views.<name>()`.

### Against a backend — vitest + fetch

```ddd
test e2e "create, add a line to, and confirm an order" against api {
  let prod = api.products.create({ sku: "WIDGET-2", price: { amount: 5.00, currency: "USD" } })
  let cust = api.customers.create({ name: "Buyer", email: "buyer@acme.test" })
  let ord  = api.orders.create({ customerId: cust.id, status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
  api.orders.addLine(ord, { productId: prod.id, qty: 3 })
  api.orders.confirm(ord)
  let read = api.orders.getById(ord)
  expect(read.status).toBe("Confirmed")
  expect(read.lines.length).toBe(1)
}
```

`api.<agg>.create(...)` → `POST /api/<plural>`, `getById` → `GET /api/<plural>/{id}`, an operation `addLine` → `POST /api/<plural>/{id}/add_line`. The suite reads its base URL from `E2E_<DEPLOYABLE>_BASE` (defaulting to the compose port).

::: tabs backend
== node
```ts
// e2e/SalesSystem.e2e.test.ts
import { describe, it, expect } from "vitest";

const ENDPOINTS: Record<string, string> = {
  api: process.env.E2E_API_BASE ?? "http://localhost:3000",
  web_app: process.env.E2E_WEB_APP_BASE ?? "http://localhost:3001",
};
// __post / __get helpers elided — they fetch, check status before parsing, throw on !ok.

describe("SalesSystem e2e", () => {
  it("create, add a line to, and confirm an order against api", async () => {
    const base = ENDPOINTS.api;
    const prod = await __post(`${base}/api/products`, ({ sku: "WIDGET-2", price: ({ amount: 5.00, currency: "USD" }) }));
    const cust = await __post(`${base}/api/customers`, ({ name: "Buyer", email: "buyer@acme.test" }));
    const ord  = await __post(`${base}/api/orders`, ({ customerId: cust.id, status: "Draft", placedAt: "2024-01-01T00:00:00Z" }));
    await __post(`${base}/api/orders/${ord.id}/add_line`, ({ productId: prod.id, qty: 3 }));
    await __post(`${base}/api/orders/${ord.id}/confirm`, {});
    const read = await __get(`${base}/api/orders/${ord.id}`);
    expect(read.status).toBe("Confirmed");
    expect(read.lines.length).toBe(1);
  });
});
```
::: end

> Honest gap: the api-e2e suite is emitted as a single vitest+fetch file regardless of backend platform (it talks HTTP, so it is target-language-neutral) — there is no per-backend xUnit/ExUnit api-e2e variant. Only the **in-process unit** `test` block diverges per backend (node/dotnet tabs above).

### Against a frontend — Playwright over page objects

The *same* DSL, retargeted at a `platform: react` (or vue / svelte) deployable, lowers to a Playwright spec. `ui.<agg>.create(...)` walks the generated List → New → Detail page objects; `getById` re-opens the Detail page; an operation calls the detail-page method. No fetch — it drives the rendered UI.

```ddd
test e2e "place and confirm an order through the UI" against webApp verifies TC-003 {
  let prod = ui.products.create({ sku: "UI-WIDGET", price: { amount: 5.00, currency: "USD" } })
  let cust = ui.customers.create({ name: "UI Buyer", email: "ui@buyer.test" })
  let ord  = ui.orders.create({ customerId: cust.id, status: "Draft", placedAt: "2024-01-01T00:00:00Z" })
  ui.orders.addLine(ord, { productId: prod.id, qty: 2 })
  ui.orders.confirm(ord)
  let read = ui.orders.getById(ord)
  expect(read.status).toBe("Confirmed")
  expect(read.lines.length).toBe(1)
}
```

```ts
// web_app/e2e/SalesSystem.ui.spec.ts
import { test, expect } from "./fixtures";
import { ProductListPage } from "./pages/product";
import { CustomerListPage } from "./pages/customer";
import { OrderListPage, OrderDetailPage } from "./pages/order";

test("place and confirm an order through the UI", async ({ page }) => {
  const prod = await (async () => { const __list = await new ProductListPage(page).goto(); const __new = await __list.create(); await __new.fill(({ sku: "UI-WIDGET", price: ({ amount: 5.00, currency: "USD" }) })); const __detail = await __new.submit(); return { id: __detail.id }; })();
  const cust = await (async () => { const __list = await new CustomerListPage(page).goto(); const __new = await __list.create(); await __new.fill(({ name: "UI Buyer", email: "ui@buyer.test" })); const __detail = await __new.submit(); return { id: __detail.id }; })();
  const ord  = await (async () => { const __list = await new OrderListPage(page).goto(); const __new = await __list.create(); await __new.fill(({ customerId: cust.id, status: "Draft", placedAt: "2024-01-01T00:00:00Z" })); const __detail = await __new.submit(); return { id: __detail.id }; })();
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.addLine(({ productId: prod.id, qty: 2 })));
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.confirm());
  const read = await new OrderDetailPage(page, ord.id).goto();
  expect((await read.field("status").innerText())).toBe("Confirmed");
  expect((await read.linesRows().count())).toBe(1);
});
```

`ui.workflows.<name>(…)` resolves through the generated workflow page object (`new PlaceOrderWorkflowPage(page).run(…)`). The page objects (`web_app/e2e/pages/<agg>.ts`) are emitted from the same UI shape under [`src/generator/_frontend/`](../../src/generator/_frontend/) and shared across the JSX/markup frontends.

## Automatic api-vs-ui dispatch

There is **no DSL keyword** selecting the surface — `magicId` is `"ui"` when the target deployable's platform is a frontend, else `"api"`. The body's `api.` / `ui.` receiver must match (it is resolved against the deployable's hosted contexts). Retargeting a test from `against api` to `against webApp` and swapping the receiver is the *only* change needed to move from fetch to Playwright; the call shapes are identical.

| Target platform | `magicId` | Lowers to | Call shape |
|---|---|---|---|
| `node` / `dotnet` / `java` / `python` / backend | `api` | vitest + `fetch` | `POST`/`GET` against `/api/<plural>` |
| `react` / `vue` / `svelte` / frontend | `ui` | Playwright spec | generated page-object navigation |

## Matchers — the `expect(<actual>).<matcher>(…)` vocabulary

A bare `expect <bool>` is rejected: every `expect` **must** end in an intrinsic matcher (`checkExpectMatcher` — *"'expect' requires a matcher"*). The catalogue is a fixed table — adding one is a table entry plus a per-backend lowering, no renderer special-case.

| Matcher | Arity | Reads | Notes |
|---|---|---|---|
| `toBe(x)` | 1 | value | strict equality |
| `toBeGreaterThan(x)` / `…OrEqual(x)` | 1 | value | numeric comparison |
| `toBeLessThan(x)` / `…OrEqual(x)` | 1 | value | numeric comparison |
| `toHaveText(s)` | 1 | locator | auto-retrying DOM-text assertion (ui) |
| `toHaveCount(n)` | 1 | locator | auto-retrying row/element count (ui) |
| `toBeVisible()` | 0 | locator | element is visible (ui) |
| `toThrow()` / `toThrow(<status>)` | 0–1 | value | the throw assertion (below) |

Each `on: "locator"` matcher is **web-first**: against a UI it asserts on the live, auto-retrying Playwright locator rather than a snapshotted value — `expect(read.status).toHaveText("Confirmed")` lowers to `await expect(read.field("status")).toHaveText("Confirmed")`, and `expect(read.lines).toHaveCount(1)` to `await expect(read.linesRows()).toHaveCount(1)`. A `not.` prefix negates any `negatable` matcher. Arity is enforced by `checkMatcherArity`; `toThrow` is exempt (variable arity) and validated separately.

```ddd
// against a UI deployable — locator matchers
expect(read.status).toHaveText("Confirmed")
expect(read.lines).toHaveCount(1)
```

```ts
// web_app/e2e/…ui.spec.ts
await expect(read.field("status")).toHaveText("Confirmed");
await expect(read.linesRows()).toHaveCount(1);
```

### `toThrow()` — the throw assertion

`expect(<call>).toThrow()` asserts the call rejects. The lowering recognises the matcher and rewrites the `expect` into an `expect-throws` IR node, so every backend renders it as its idiomatic throw assertion. The bare form is valid in both unit and e2e bodies; the single-argument form `toThrow(<status>)` **pins an HTTP status** and is only legal in an `test e2e` body (`'toThrow(<status>)' … only valid in a 'test e2e' block`) — the argument must be an integer literal (`toThrow(404)`).

```ddd
// unit test — wrap the mutating call
expect(order.addLine("…", 1)).toThrow()
```

::: tabs backend
== node
```ts
// the actual is wrapped in a thunk so vitest can catch the throw
expect(() => { order.addLine("00000000-0000-0000-0000-000000000002", 1); }).toThrow();
```
== dotnet
```csharp
Assert.Throws<DomainException>(() => { order.Confirm(); });
```
::: end

In an api-e2e body, `expect(api.orders.confirm(ord)).toThrow(409)` asserts the live `POST` rejects with that status; the renderer translates the pinned status into a `→ N` status-match against the fetch error.

## Tracing tests back to requirements

The optional `verifies TC-xxx` clause on both `test` and `test e2e` links the spec to a `testCase`, which in turn `verifies` a `requirement`. `ddd generate system` emits the coverage/gaps rollup under `.loom/`, and `ddd verify --results <results.json>` joins an external test-results file onto that graph to produce per-requirement Definition-of-Done verdicts. The wiring (`requirement → solution → testCase → test`) is covered in [`../traceability.md`](../traceability.md); cross-backend behavioral execution of these suites is [`../conformance.md`](../conformance.md).
