# 21. Externs

The escape hatches from the model to hand-written code, each with a typed boundary Loom generates and checks. Four seams: an `extern` **operation** (the body declares only its preconditions; the aggregate runs them, then calls a co-located hook you own), an `extern` **commandHandler / queryHandler** (a bodyless application-layer handler whose scaffold-once impl file you own — the home for "one external-service call around one aggregate"), an `extern` **component** (a page region rendered by a hand-written module against a generated props interface), and an `extern` **function** (a typed pure frontend function with a generated signature + conformance shim). Reach for `extern` when the *decision* belongs outside the model — pricing, fraud scoring, a call to a system of record — while the invariants stay on the aggregate.

> **Grammar:** `Operation` (`extern?` after the param list), `CommandHandler` / `QueryHandler` (`extern?` prefix + bodyless `;`), `Component` (`extern?='extern' 'from' externPath`), `UiFunction` (`'extern' 'from' externPath`) · **Validators:** `loom.extern-body-not-precondition`, `loom.extern-on-private-operation`, `loom.extern-handler-has-body`, `loom.handler-missing-body`, `loom.extern-component-has-body`, `loom.component-missing-body`, `loom.extern-function-shadows-stdlib` · **Docs:** [`../extern.md`](../extern.md)

An extern operation's body is **preconditions only** — no assignment, no `emit`, no collection mutation (`loom.extern-body-not-precondition` names the offending statement kind; `extern` on a `private` operation is `loom.extern-on-private-operation`). The aggregate owns the surrounding lifecycle and your hook owns the mutation:

```
load aggregate → run preconditions → call your hook → run invariants → save → drain events
```

The generated hook file is **scaffold-once** on every backend: its first line carries a `loom:scaffold-once` marker, the writer keeps the on-disk copy whenever it already exists, and `ddd generate system` reports it as `preserved (scaffold-once): N`. The stub **throws** until you fill it in, so a forgotten implementation is a loud 500, never a silent success.

## `extern` operation

`operation name(params) extern { precondition … }` — the `extern` modifier (after the param list, see [Behavior & statements](06-behavior-and-statements.md)) replaces the body's mutation with a **domain extension point that is a member of the aggregate** — not an injected handler. Every tab below is from one five-deployable generation of `test/fixtures/corpus/extern.ddd`.

```ddd
aggregate Order {
  customerId: string
  status: OrderStatus
  riskScore: int
  invariant riskScore >= 0
  function isMutable(): bool = status == OrderStatus.Draft

  operation confirm() extern {
    precondition isMutable()
    precondition riskScore < 80
  }
  operation flag(score: int) extern { precondition score >= 0 }
}
```

::: tabs backend
== node
`domain/order.base.ts` is the regenerated abstract base: the operation runs the framework flow and calls a `protected abstract` hook; fields are `protected`, so nothing outside the class hierarchy can write them.
```ts
// domain/order.base.ts — regenerated every run
export abstract class OrderBase {
  protected _status: OrderStatus;
  // …
  checkConfirm(): void { /* the two preconditions */ }
  public confirm(): void {
    this.checkConfirm();
    this.confirmExtern();
    this._assertInvariants();
  }
  /** Extension point for `extern` operation `confirm`. */
  protected abstract confirmExtern(): void;
  protected abstract flagExtern(score: number): void;
  protected _raiseEvent(ev: Events.DomainEvent): void { this._events.push(ev); }
}
```
```ts
// domain/order.ts — loom:scaffold-once, yours
export class Order extends OrderBase {
  protected override confirmExtern(): void {
    throw new Error("extern operation 'confirm' on Order is not implemented — write its body in src/domain/order.ts");
  }
  protected override flagExtern(_score: number): void { /* … */ }
}
```
A missing override is a `tsc` error (the base method is `abstract`); an unfilled one throws at runtime.
== dotnet
```csharp
// Domain/Orders/Order.cs — sealed PARTIAL; the hook is an extended partial method
public sealed partial class Order
{
    public void Confirm()
    {
        if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
        if (!(this.RiskScore < 80)) throw new DomainException("Precondition failed: riskScore < 80");
        ConfirmCore();
        AssertInvariants();
    }
    private partial void ConfirmCore();
    private partial void FlagCore(int score);
}
```
```csharp
// Domain/Orders/Order.Extern.cs — loom:scaffold-once, yours; a MEMBER of Order → private state reachable
public sealed partial class Order
{
    private partial void ConfirmCore()
        => throw new NotImplementedException("extern operation 'confirm' on Order is not implemented — fill in this partial (Domain/Orders/Order.Extern.cs)");
    private partial void FlagCore(int score)
        => throw new NotImplementedException("…");
}
```
A missing implementation is `CS8795` at build time (an extended partial method must be implemented).
== java
```java
// features/orders/Order.java — the extern op is a real aggregate method
public void confirm() {
    if (!(this.isMutable())) throw new DomainException("Precondition failed: isMutable()");
    if (!(this.riskScore < 80)) throw new DomainException("Precondition failed: riskScore < 80");
    OrderExtern.confirm(this);
    this._assertInvariants();
}
```
```java
// features/orders/OrderExtern.java — loom:scaffold-once; same package → package-private fields + _raiseEvent
final class OrderExtern {
    private OrderExtern() {}
    static void confirm(Order order) {
        throw new UnsupportedOperationException("extern operation `confirm` on Order is not implemented — fill in OrderExtern.confirm(...)");
    }
    static void flag(Order order, int score) { /* … */ }
}
```
== python
```python
# app/domain/order.py
def confirm(self) -> None:
    if not (self._is_mutable()):
        raise DomainError("Precondition failed: isMutable()")
    if not (self._risk_score < 80):
        raise DomainError("Precondition failed: riskScore < 80")
    order_extern.confirm(self)
    self._assert_invariants()
```
```python
# app/domain/extern/order_extern.py — loom:scaffold-once, yours
def confirm(order: Order) -> None:
    raise NotImplementedError(
        "extern operation `confirm` on Order is not implemented — "
        "fill in app/domain/extern/order_extern.py"
    )

def flag(order: Order, score: int) -> None: ...
```
== elixir
```elixir
# lib/<app>/sales/order_extern.ex — regenerated @behaviour, one @callback per extern op
defmodule DElixir.Sales.OrderExtern do
  @callback confirm(DElixir.Sales.Order.t(), map()) ::
              {:ok, DElixir.Sales.Order.t()} | {:error, term()}
  @callback flag(DElixir.Sales.Order.t(), map()) ::
              {:ok, DElixir.Sales.Order.t()} | {:error, term()}
end
```
```elixir
# lib/<app>/sales.ex — the context function delegates between the preconditions and the persist
def confirm_order(%DElixir.Sales.Order{} = record, params) when is_map(params) do
  with :ok <- ensure(is_mutable(record), {:precondition_failed, "Precondition failed: isMutable()"}),
       :ok <- ensure(record.risk_score < 80, {:precondition_failed, "Precondition failed: riskScore < 80"}),
       {:ok, record} <- DElixir.Sales.OrderExternImpl.confirm(record, params) do
    # …force_change per scalar column off the returned struct, then persist
  end
end
```
```elixir
# lib/<app>/sales/order_extern_impl.ex — loom:scaffold-once, yours
defmodule DElixir.Sales.OrderExternImpl do
  @behaviour DElixir.Sales.OrderExtern
  @impl true
  def confirm(%DElixir.Sales.Order{} = _record, _params) do
    raise "extern operation `confirm` on Order is not implemented — fill in lib/d_elixir/sales/order_extern_impl.ex"
  end
  # …return {:ok, record} with the mutated struct, or {:error, term} to abort.
end
```
A new extern op regenerates the behaviour with a callback the impl doesn't satisfy, so `mix compile --warnings-as-errors` fails until you write it. The Elixir hook persists **scalar columns** off the returned struct; mutating a containment from an extern impl is a follow-up.
::: end

The HTTP route (and any workflow op-call) calls the operation exactly like a non-extern one — there is no handler registry, no `register*` call, and no boot-time verify on any backend:

```ts
// http/order.routes.ts — the confirm route body (node)
const aggregate = await repo.getById(Ids.OrderId(id));
aggregate.confirm();   // preconditions → hook → invariants, all inside the method
await repo.save(aggregate);
```

### Calling an extern from a workflow

A workflow invokes an extern op like any other public operation; the op-call is a plain `order.confirm()` on every backend and the method runs preconditions → hook → invariants internally. Parameterized externs pass their domain-typed args straight through (`order.flag(score)`).

```ddd
workflow confirmOrder {
  create(orderId: Order id) {
    let order = Orders.getById(orderId)
    order.confirm()              // confirm() is extern — the aggregate runs the dance
  }
}
```

## `extern` commandHandler / queryHandler

The application-layer twin: a **bodyless** `extern commandHandler` / `extern queryHandler` declares the signature (params + return contract) and hands the implementation to a scaffold-once impl file the generated route dispatch calls. Use it when the *whole* handler is an outbound call (a payment gateway, a quote service) rather than a DSL-expressible load → mutate → save. A non-extern handler must carry a `{ … }` body and an extern one must not — `loom.handler-missing-body` / `loom.extern-handler-has-body` pin the pairing.

```ddd
context Orders {
  extern queryHandler GetQuote(sku: string): string;
}
api OrdersApi from Sales {
  route GET "/quotes/{sku}" -> Orders.GetQuote
}
```

::: tabs backend
== node
```ts
// application/get-quote-handler-impl.ts — loom:scaffold-once, yours
export async function getQuoteImpl(sku: string): Promise<string> {
  throw new ExternHandlerError("GetQuote", "Orders",
    new Error("extern queryHandler 'GetQuote' is not implemented — fill in src/application/get-quote-handler-impl.ts"));
}
```
```ts
// http/ordersApi-routes.ts — the route imports and calls the impl
const result = await getQuoteImpl(sku);
return httpCtx.json(result as unknown, 200);
```
== dotnet
```csharp
// Application/Handlers/GetQuoteExternHandler.cs — loom:scaffold-once; Scrutor registers [ExternHandler] impls
[ExternHandler]
public sealed class GetQuoteExternHandler : IGetQuoteHandler
{
    public ValueTask<string> Handle(string sku, CancellationToken cancellationToken)
        => throw new NotImplementedException("extern queryHandler 'GetQuote' is not implemented — fill in Application/Handlers/GetQuoteExternHandler.cs");
}
```
== java
```java
// application/workflows/GetQuoteHandlerImpl.java — loom:scaffold-once; a @Service implementing GetQuotePort
@Service
public class GetQuoteHandlerImpl implements GetQuotePort {
    @Override
    public String handle(String sku) {
        throw new UnsupportedOperationException("extern queryHandler 'GetQuote' is not implemented — fill in GetQuoteHandlerImpl.java");
    }
}
```
== python
```python
# app/application/impl/get_quote_impl.py — loom:scaffold-once
async def get_quote_impl(sku: str) -> str:
    raise NotImplementedError(
        "extern queryHandler 'GetQuote' is not implemented — fill in app/application/impl/get_quote_impl.py"
    )
```
== elixir
```elixir
# lib/<app>/orders/handlers/get_quote_impl.ex — loom:scaffold-once; the generated
# GetQuote.run/1 delegates via Application.get_env(:app, GetQuote, GetQuoteImpl).run(params)
defmodule DElixir.Orders.Handlers.GetQuoteImpl do
  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
    _ = params
    raise "extern queryHandler `GetQuote` is not implemented — fill in lib/d_elixir/orders/handlers/get_quote_impl.ex"
  end
end
```
::: end

The impl file's path is deterministic and stable, so a rename never orphans your code. The bodied handler forms are covered in [Behavior & statements](06-behavior-and-statements.md#handler-bodies--commandhandler--queryhandler) (declaration surface: [Domain modeling](03-domain-modeling.md#commandhandler--queryhandler)); the `route … -> Ctx.Handler` binding is in [APIs, storage, resources & channels](14-apis-storage-resources-channels.md).

## `extern` component

`component X(params) extern from "<path>"` declares the typed param contract for a page region but **no** `body:` — rendering is handed to a hand-written module at the path. The generator emits `<Name>.props.ts` (the props interface the user types their component against) and a shim that re-exports the user module, and imports it at every call site.

```ddd
ui Console {
  component RiskBadge(score: int, label: string) extern from "./components/RiskBadge"

  page Orders {
    route: "/"
    body: Stack {
      Heading { "Orders", level: 1 },
      RiskBadge { score: 42, label: "Sample" }
    }
  }
}
```

::: tabs frontend
== react
```ts
// src/components/RiskBadge.props.ts — the contract your hand-written component satisfies
export interface RiskBadgeProps {
  score: number;
  label: string;
}
```
```tsx
// src/components/RiskBadge.tsx — generated shim re-exporting your module
export { default } from "../components/RiskBadge";
export type { RiskBadgeProps } from "./RiskBadge.props";
```
```tsx
// src/pages/orders.tsx — imported + invoked at the call site
import RiskBadge from "../components/RiskBadge";
// …
<RiskBadge score={42} label="Sample" />
```
== vue
`src/components/RiskBadge.props.ts` + `src/components/RiskBadge.ts` (the shim) — same contract, Vue-shaped call site.
== svelte
`src/lib/components/RiskBadge.props.ts` + `src/lib/components/RiskBadge.svelte` (the shim).
== angular
`src/components/RiskBadge.props.ts` + `src/components/RiskBadge.ts`; the page renders the user's component class through `NgComponentOutlet` (Angular has no JSX-family tag).
::: end

Feliz binds the component by **module** (segments of the `from` path PascalCased; the page renders `RiskBadge {| score = 42; label = "Sample" |}` and `open`s the module) and Phoenix/HEEx renders `<.live_component module={Widgets.RiskBadge} …>` from a `from "widgets/risk_badge"` path — neither emits a props/shim file, so a missing module fails `dotnet fable` / `mix compile`. Flutter has **no** extern component hatch yet (it carries the function hatch only) — and the gap is silent, not gated: the call renders as `const SizedBox.shrink() /* unknown layout component: RiskBadge */`, so the page compiles with the region missing. A `body:` on an `extern` component is `loom.extern-component-has-body`; a non-extern component with no `body:` is `loom.component-missing-body`.

## `extern` function

`function f(params): T extern from "<path>"` is a typed pure frontend function backed by a hand-written module. Loom emits a typed signature (`src/lib/extern/<name>.signature.ts`) plus a conformance shim (`src/lib/<name>.ts`) that re-exports the user's implementation annotated with that signature — so a missing module or a mismatched signature fails `tsc`. A `ui`-level `function` is extern-only; page bodies call it through the shim.

```ddd
ui Console {
  function initials(name: string): string extern from "./helpers/initials"

  page Orders {
    route: "/"
    body: Stack {
      Text { initials("Ann Bee") }
    }
  }
}
```

::: tabs frontend
== react
```ts
// src/lib/extern/initials.signature.ts — the Loom-derived signature
export type InitialsFn = (name: string) => string;
```
```ts
// src/lib/initials.ts — conformance shim; tsc fails here on a signature mismatch
import { initials as _impl } from "../helpers/initials";
import type { InitialsFn } from "./extern/initials.signature";

export const initials: InitialsFn = _impl;
```
== vue
`src/lib/extern/initials.signature.ts` + `src/lib/initials.ts` — identical shim.
== svelte
`src/lib/extern/initials.signature.ts` + `src/lib/initials.ts`.
== angular
`src/lib/extern/initials.signature.ts` + `src/lib/initials.ts`; the page component imports the shim and re-exposes it as a member so the template can call `{{ initials(…) }}`.
::: end

Feliz and Flutter call the function bare from the module the `from` path names; Phoenix/HEEx renders it fully qualified (`<%= Helpers.Format.initials(…) %>`). The function name may not shadow a walker-stdlib primitive (`loom.extern-function-shadows-stdlib` — `function Table(...)` is rejected).

When to reach for `extern`: the *decision* lives outside the model. For a purely internal mutation a plain `operation` is simpler — no extra file, no hook to fill. Keep invariants on the aggregate; `extern` is for the choice, not for relaxing the rules. An extern *operation* that really calls an external service belongs in an `extern commandHandler` instead — see [`../extern.md`](../extern.md) § "Migration".
