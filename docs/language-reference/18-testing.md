# 18. Testing

In-language tests live beside the domain they exercise. A `test "…" { }` block on an aggregate, value object or domain service is an **executable unit test** of pure domain logic; the same block nested directly in a `context` (or hoisted anywhere with `for <Context>`) is an **in-process integration test** over the wired repositories; a `test e2e "…" against <Deployable> { }` drives a *running* deployable end-to-end. One `expect(<actual>).<matcher>(…)` assertion vocabulary serves all three, and the e2e **surface is chosen automatically from the target deployable's platform** — a backend target lowers to a vitest+fetch suite, a frontend target to a Playwright spec over generated page objects. Reach for it when you want the spec generated and traced alongside the code it covers.

> **Grammar:** `TestBlock` (`test … [for <Subject>] [verifies TC] { }`), `TestSubject` (`Aggregate | ValueObject | DomainService | BoundedContext`), `TestE2E` (`test e2e … against … [verifies TC]`), `TestStatement`, `ExpectStmt` · **Matchers:** [`src/util/intrinsic-matchers.ts`](../../src/util/intrinsic-matchers.ts) · **Validators:** `loom.test-needs-target`, `loom.test-redundant-for`, `loom.context-test-unsupported` ([`src/language/validators/test-placement.ts`](../../src/language/validators/test-placement.ts)); `loom.aggregate-test-context`, `loom.integration-find-must-bind`, `loom.e2e-unsupported-statement`, `loom.e2e-unresolved-ref`, `loom.e2e-unresolved-call`, `loom.e2e-unknown-{aggregate,method,workflow}` ([`src/ir/validate/checks/test-checks.ts`](../../src/ir/validate/checks/test-checks.ts)); `expect`/matcher arity ([`src/language/validators/match.ts`](../../src/language/validators/match.ts)) · **Docs:** [`../testing.md`](../testing.md), [`../traceability.md`](../traceability.md), [`../conformance.md`](../conformance.md), [`../old/proposals/test-placement.md`](../old/proposals/test-placement.md)

> **Output sourcing.** Every fragment below is generated from one scratch `SalesSystem` (`node bin/cli.js generate system tests.ddd -o out`, 2026-09-03): a `Sales` context with a `Money` value object, `Product` / `Order` aggregates, a `Pricing` domain service, one hoisted and one context-level `test`, and two `test e2e` blocks — one `against api` (node), one `against webApp` (react); a second `dotnet` deployable supplies the xUnit tabs.

## `test "…"` — an in-process unit test

`test name=STRING ('for' target)? ('verifies' TraceId)? { TestStatement* }`. Nested in an **aggregate**, **value object** or **domain service**, the enclosing declaration is the subject. The body may `let`, construct (`Order.create({…})`, `Money { … }`), call operations and pure functions, and `expect`. A statement that mutates aggregate state from the test itself (`n := 2`) or guards it (`precondition` / `requires` / `emit`) is rejected with `loom.aggregate-test-context` — the test has no `this`. The optional `verifies TC-xxx` back-links the test to a `testCase` in the traceability graph ([Requirements & traceability](19-requirements-traceability.md)).

```ddd
valueobject Money {
  amount: decimal
  currency: string
  invariant amount >= 0
  test "money keeps its amount" {
    let m = Money { amount: 5.00, currency: "USD" }
    expect(m.amount).toBe(5.00)
  }
}

aggregate Order with crudish {
  customerId: string
  status: OrderStatus
  contains lines: OrderLine[]
  entity OrderLine { productId: Product id  qty: int }
  operation addLine(productId: Product id, qty: int) { precondition qty > 0  lines += OrderLine { productId: productId, qty: qty } }
  operation confirm() { precondition lines.count > 0  status := Confirmed }

  test "adding a line then confirming yields a confirmed order" verifies TC-001 {
    let order = Order.create({ customerId: "c-1", status: Draft })
    order.addLine("00000000-0000-0000-0000-000000000002", 2)
    order.confirm()
    expect(order.status).toBe(Confirmed)
    expect(order.lines.count).toBe(1)
    expect(order.addLine("00000000-0000-0000-0000-000000000002", 0)).toThrow()
  }
}

domainService Pricing {
  operation lineTotal(unit: Money, qty: int): decimal { return unit.amount * qty }
  test "lineTotal multiplies" {
    expect(Pricing.lineTotal(Money { amount: 2.50, currency: "USD" }, 4)).toBe(10.00)
  }
}
```

The block lowers to one runnable spec per subject, emitted next to the domain class on **all five backends** (`domain/order.test.ts` on node, `Tests/<App>.Tests/Orders/OrderTests.cs` on .NET, `src/test/java/…/AccountTests.java` on Java, `tests/test_order.py` on Python, `test/<ctx>/order_test.exs` on Elixir). Enum literals resolve to the generated enum, id strings to the branded constructors, and `.count` becomes the backend-native length.

::: tabs backend
== node
```ts
// api/domain/order.test.ts
import { describe, it, expect } from "vitest";
import { Order } from "./order";
import { OrderStatus } from "./value-objects";

describe("Order", () => {
  it("adding a line then confirming yields a confirmed order", () => {
    const order = Order.create({ customerId: "c-1", status: OrderStatus.Draft });
    order.addLine("00000000-0000-0000-0000-000000000002", 2);
    order.confirm();
    expect(order.status).toBe(OrderStatus.Confirmed);
    expect(order.lines.length).toBe(1);
    expect(() => { order.addLine("00000000-0000-0000-0000-000000000002", 0); }).toThrow();
  });
});
```
```ts
// api/domain/pricing.test.ts — the domain-service subject
describe("Pricing", () => {
  it("lineTotal multiplies", () => {
    expect(Pricing.lineTotal(new Money(2.50, "USD"), 4)).toBe(10.00);
  });
});
```
== dotnet
```csharp
// api_dotnet/Tests/ApiDotnet.Tests/Orders/OrderTests.cs — xUnit + AwesomeAssertions
public sealed class OrderTests
{
    [Fact(DisplayName = "adding a line then confirming yields a confirmed order")]
    public void Adding_a_line_then_confirming_yields_a_confirmed_order()
    {
        var order = Order.Create(customerId: "c-1", status: OrderStatus.Draft);
        order.AddLine(new ProductId(Guid.Parse("00000000-0000-0000-0000-000000000002")), 2);
        order.Confirm();
        order.Status.Should().Be(OrderStatus.Confirmed);
        order.Lines.Count.Should().Be(1);
        Assert.Throws<DomainException>(() => { order.AddLine(new ProductId(Guid.Parse("00000000-0000-0000-0000-000000000002")), 0); });
    }
}
```
```csharp
// Tests/ApiDotnet.Tests/Services/PricingTests.cs
[Fact(DisplayName = "lineTotal multiplies")]
public void LineTotal_multiplies()
{
    Pricing.LineTotal(new Money(2.50m, "USD"), 4).Should().Be(10.00m);
}
```
::: end

The test name becomes the vitest `it(...)` label verbatim; on xUnit it is both the `[Fact(DisplayName = …)]` and a snake-cased method name. The subject name is the `describe(...)` / class scope.

### Placement — `for <Subject>`

A `test` may live outside its subject. Reachability is not a home: the `for` head names the subject exactly when nothing encloses it.

| Where the `test` sits | `for` | Subject |
|---|---|---|
| nested in an aggregate / value object / domain service | forbidden (`loom.test-redundant-for`) | the enclosing declaration |
| nested in a `context`, no `for` | — | the **context** (integration test, below) |
| nested in a `context`, `for <Agg\|VO\|Service>` | required to hoist | that declaration — lands in its file (`order.test.ts` above also carries the hoisted test) |
| nested in a `context`, `for <that context>` | redundant (`loom.test-redundant-for`) | the context |
| at file root | required (`loom.test-needs-target`) | the named subject |

```ddd
context Sales {
  aggregate Order with crudish { … }
  test "an order starts as Draft" for Order {           // hoisted — emitted into order.test.ts / OrderTests.cs
    let order = Order.create({ customerId: "c-2", status: Draft })
    expect(order.status).toBe(Draft)
  }
}
```

### Context integration tests

A `test` nested directly in a `context` (no `for`) is an **in-process integration test** — it boots the context's repositories against a real Postgres (`LOOM_PG_URL`, migrations applied) with **no HTTP**, so cross-aggregate persistence can be asserted without a deployable. Emitted on node, python, dotnet, java, and elixir (`test/<ctx>.integration.test.ts`, `Tests/<App>.Tests/<Ctx>IntegrationTests.cs`, …); a context hosted only on a frontend deployable warns `loom.context-test-unsupported`.

```ddd
context Sales {
  test "a saved order can be read back" {
    let o = Order.create({ customerId: "c-3", status: Draft })
    let read = Order.findById(o.id)
    expect(read.customerId).toBe("c-3")
  }
}
```

The persistence vocabulary is the aggregate-rooted `<Agg>.findById(id)` (a `let`-bound read — inside `expect(...)` it is `loom.integration-find-must-bind`); a factory-`let` is saved for you. Emitted (node):

```ts
// api/test/sales.integration.test.ts
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.LOOM_PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./db/migrations" });
  repos = { order: new OrderRepository(db, NoopDomainEventDispatcher) };
});

describe("Sales (integration)", () => {
  it("a saved order can be read back", async () => {
    const o = Order.create({ customerId: "c-3", status: OrderStatus.Draft });
    await repos.order.save(o);
    // …
  });
});
```

> A repository call spelled the workflow way (`Orders.save(o)` / `Orders.getById(…)`) is **not** part of this vocabulary and is currently rendered verbatim (an unresolved identifier in the emitted test) without a diagnostic — use `<Agg>.findById` and let the factory save.

## `test e2e "…" against <Deployable>` — a live end-to-end test

`test e2e name=STRING 'against' deployable=[Deployable] ('verifies' TraceId)? { … }` is a system-level test (declared in the `system` body, not inside an aggregate) that drives a deployment. The body talks to the deployable through a **magic dispatcher** — `api.<aggregate>.<verb>(…)` against a backend, `ui.<aggregate>.<verb>(…)` against a frontend — plus `let` and `expect`. Domain mutations and guards are rejected (`loom.e2e-unsupported-statement`); an e2e body resolves no domain names, so a bare enum value (`st: On` instead of `"On"`) is `loom.e2e-unresolved-ref` and an unknown function `loom.e2e-unresolved-call` (the conversions `money(…)`, `decimal(…)`, `string(…)`, `int(…)` are built in); an unknown aggregate / verb / workflow is caught against the deployable's hosted contexts (`loom.e2e-unknown-aggregate`, `loom.e2e-unknown-method` — which also covers a folded projection's `byKey` / `list`, `loom.e2e-unknown-workflow`).

The verb vocabulary per aggregate is `create`, `getById`, `all` (the paged list), every **public** operation, every repository `find`, `update` / `destroy` when declared, plus the reserved `api.workflows.<name>(…)` and `api.<projection>.byKey(…)` / `.list()`.

### Against a backend — vitest + fetch

```ddd
test e2e "create, add a line to, and confirm an order" against api {
  let prod = api.products.create({ sku: "WIDGET-2", price: { amount: 5.00, currency: "USD" } })
  let ord  = api.orders.create({ customerId: "c-9", status: "Draft" })
  api.orders.addLine(ord, { productId: prod.id, qty: 3 })
  api.orders.confirm(ord)
  let read = api.orders.getById(ord)
  expect(read.status).toBe("Confirmed")
  expect(read.lines.length).toBe(1)
  api.orders.destroy(ord)
  expect(api.orders.getById(ord)).toThrow(404)
}
```

`api.<agg>.create(...)` → `POST /api/<plural>`, `getById` → `GET /api/<plural>/{id}`, an operation `addLine` → `POST /api/<plural>/{id}/add_line`, `destroy` → `DELETE /api/<plural>/{id}` (asserted as 204 + empty body). The suite reads its base URL from `E2E_<DEPLOYABLE>_BASE` (defaulting to the compose port) and forwards a principal when the target is `auth: required` — `E2E_BEARER_TOKEN` (OIDC) or `E2E_DEV_CLAIMS` (base64-JSON into `x-loom-dev-claims`).

```ts
// e2e/SalesSystem.e2e.test.ts — emitted once at the output root
const ENDPOINTS: Record<string, string> = {
  api: process.env.E2E_API_BASE ?? "http://localhost:3000",
  api_dotnet: process.env.E2E_API_DOTNET_BASE ?? "http://localhost:3002",
  web_app: process.env.E2E_WEB_APP_BASE ?? "http://localhost:3001",
};
// __post / __get / __delete helpers elided — they fetch, check status before parsing, throw on !ok.

describe("SalesSystem e2e", () => {
  it("create, add a line to, and confirm an order against api", async () => {
    const base = ENDPOINTS.api;
    const prod = await __post(`${base}/api/products`, ({ sku: "WIDGET-2", price: ({ amount: 5.00, currency: "USD" }) }));
    // …
  });
});
```

> The api-e2e suite is emitted as a single vitest+fetch file regardless of backend platform (it talks HTTP, so it is target-language-neutral) — there is no per-backend xUnit/ExUnit api-e2e variant. Only the in-process `test` blocks diverge per backend.

### Against a frontend — Playwright over page objects

The *same* DSL, retargeted at a frontend deployable, lowers to a Playwright spec. `ui.<agg>.create(...)` walks the generated List → New → Detail page objects; `getById` re-opens the Detail page; an operation calls the detail-page method. No fetch — it drives the rendered UI.

```ddd
test e2e "place and confirm an order through the UI" against webApp verifies TC-001 {
  let prod = ui.products.create({ sku: "UI-WIDGET", price: { amount: 5.00, currency: "USD" } })
  let ord  = ui.orders.create({ customerId: "c-8", status: "Draft" })
  ui.orders.addLine(ord, { productId: prod.id, qty: 2 })
  ui.orders.confirm(ord)
  let read = ui.orders.getById(ord)
  expect(read.status).toHaveText("Confirmed")
  expect(read.lines).toHaveCount(1)
}
```

```ts
// web_app/e2e/SalesSystem.ui.spec.ts
import { test, expect } from "./fixtures";
import { ProductListPage } from "./pages/product";
import { OrderListPage, OrderDetailPage } from "./pages/order";

test("place and confirm an order through the UI", async ({ page }) => {
  const prod = await (async () => {   const __list = await new ProductListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ sku: "UI-WIDGET", price: ({ amount: 5.00, currency: "USD" }) }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  const ord = await (async () => {   const __list = await new OrderListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ customerId: "c-8", status: "Draft" }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.addLine(({ productId: prod.id, qty: 2 })));
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.confirm());
  const read = await new OrderDetailPage(page, ord.id).goto();
  await expect(read.field("status")).toHaveText("Confirmed");
  await expect(read.linesRows()).toHaveCount(1);
});
```

`ui.workflows.<name>(…)` resolves through the generated workflow page object. The page objects (`web_app/e2e/pages/<agg>.ts`) are emitted from the same UI shape under [`src/generator/_frontend/`](../../src/generator/_frontend/) and shared across the frontends.

## Automatic api-vs-ui dispatch

There is **no DSL keyword** selecting the surface — the test's kind comes from the **target deployable's platform** (`descriptorFor(platform).isFrontend`): a frontend-only platform lowers to `ui` (Playwright), a backend to `api` (vitest+fetch). Both magic receivers are always bound, so the body's `api.` / `ui.` root must simply match what the kind renders. Retargeting a test from `against api` to `against webApp` and swapping the receiver is the *only* change needed to move from fetch to Playwright; the call shapes are identical.

| Target platform | Kind | Lowers to | Call shape |
|---|---|---|---|
| `node` / `dotnet` / `java` / `python` | `api` | vitest + `fetch` | `POST`/`GET`/`DELETE` against `/api/<plural>` |
| `react` / `vue` / `svelte` / `angular` / `feliz` / `flutter` (and `static`) | `ui` | Playwright spec | generated page-object navigation |
| `elixir` (fullstack — may mount a HEEx ui) | either | decided per block by its call root: a `ui.…` body → Playwright, an `api.…` body → fetch | — |

## Matchers — the `expect(<actual>).<matcher>(…)` vocabulary

A bare `expect <bool>` is rejected: every `expect` **must** end in an intrinsic matcher (`checkExpectMatcher` — *"'expect' requires a matcher — write 'expect(<actual>).toBe(<expected>)' (or .toThrow(), .toHaveText(…), …), not a bare expression."*). The catalogue is a fixed table — adding one is a table entry plus a per-backend lowering, no renderer special-case.

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

### `toThrow()` — the throw assertion

`expect(<call>).toThrow()` asserts the call rejects. The lowering recognises the matcher and rewrites the `expect` into an `expect-throws` IR node, so every backend renders it as its idiomatic throw assertion. The bare form is valid in both unit and e2e bodies; the single-argument form `toThrow(<status>)` **pins an HTTP status** and is only legal in a `test e2e` body (*"'toThrow(<status>)' pins an HTTP status and is only valid in a 'test e2e' block; use a bare 'toThrow()' in an in-process test."*) — the argument is an integer literal (`toThrow(404)`).

```ddd
// unit test — wrap the mutating call
expect(order.addLine("…", 0)).toThrow()
// api e2e — the negative path, pinned to a status
expect(api.orders.getById(ord)).toThrow(404)
```

::: tabs backend
== node
```ts
// unit: the actual is wrapped in a thunk so vitest can catch the throw
expect(() => { order.addLine("00000000-0000-0000-0000-000000000002", 0); }).toThrow();
// e2e: the pinned status becomes a status-match against the fetch error
await expect(__get(`${base}/api/orders/${ord.id}`)).rejects.toThrow(/→ 404/);
```
== dotnet
```csharp
Assert.Throws<DomainException>(() => { order.AddLine(new ProductId(Guid.Parse("00000000-0000-0000-0000-000000000002")), 0); });
```
::: end

## Tracing tests back to requirements

The optional `verifies TC-xxx` clause on both `test` and `test e2e` links the spec to a `testCase`, which in turn `verifies` a `requirement`. `ddd generate system` emits the coverage/gaps rollup under `.loom/`, and `ddd verify --results <results.json>` joins an external test-results file onto that graph to produce per-requirement Definition-of-Done verdicts. The wiring (`requirement → solution → testCase → test`) is covered in [Requirements & traceability](19-requirements-traceability.md); cross-backend behavioral execution of these suites is [`../conformance.md`](../conformance.md).
