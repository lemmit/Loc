# Extern operations

When an aggregate's operation needs business logic that lives outside the
DSL — talking to a third-party service, picking a strategy from a config
table, calling an internal billing engine — declare it `extern`:

```ddd
aggregate Order {
    customerId: string
    status: OrderStatus
    placedAt: datetime
    contains lines: OrderLine[]

    function isMutable(): bool = status == Draft

    operation confirm() extern {
        precondition isMutable()
        precondition lines.count > 0
    }
}
```

> **Backend coverage.** `extern` *operations* now ship on **all five**
> backends — Hono, .NET, **Python**, **Java**, and **Elixir/Phoenix**.  The two
> handler-registry layouts walked through below (.NET and Hono) are
> representative for those two; Python and Java emit the same shape (a typed
> per-op handler interface / registry, a register/verify gate, and a
> fail-fast-at-startup check for a missing implementation).  **Elixir** uses a
> different, co-located idiom — a generated `@behaviour` + a scaffold-once
> user-owned impl module — described under *Elixir/Phoenix* below.  (This is
> Slice 1 of `docs/proposals/extern-domain-extension-point.md`, which re-homes
> `extern` from an injected application-layer handler to a domain-internal
> extension point; the remaining backends migrate in later slices.)
>
> Two **frontend** extern hatches exist alongside the operation one:
> `function … extern from "…"` (a typed frontend-function hook — React, Vue,
> Svelte) and `component … extern from "…"` (hand-written page component —
> React, Vue, Svelte).

An `extern` operation's body contains **only** `precondition` statements
— no assignment, no `emit`, no collection mutation.  The framework owns
the surrounding plumbing:

```
load aggregate → run preconditions → call user handler → run invariants → save → drain events
```

The user handler decides what actually happens.

## .NET (ASP.NET Core + Mediator)

The generator emits a per-op interface in
`Application/<Aggregate>/Handlers/`:

```csharp
public interface IConfirmOrderHandler
{
    Task HandleAsync(Order aggregate, ConfirmRequest request, CancellationToken ct);
}
```

You implement it in the same project and decorate with
`[ExternHandler]`:

```csharp
using Sales.Application.Orders.Handlers;
using Sales.Application.Orders.Requests;
using Sales.Domain.Common;
using Sales.Domain.Enums;
using Sales.Domain.Events;
using Sales.Domain.Orders;

[ExternHandler]
public sealed class ConfirmOrderHandler : IConfirmOrderHandler
{
    public Task HandleAsync(Order order, ConfirmRequest request, CancellationToken ct)
    {
        // Your business decision — talk to the billing engine, etc.
        order.Status = OrderStatus.Confirmed;
        order.RaiseEvent(new OrderConfirmed(order.Id, DateTime.UtcNow));
        return Task.CompletedTask;
    }
}
```

The Scrutor scan in `Program.cs` picks it up automatically.  Aggregates
with at least one extern op widen their property setters to `internal`
and expose `internal void RaiseEvent(IDomainEvent ev)` so handlers in
the same assembly can mutate state and raise events.

If you forget to provide an implementation, **startup fails**:

```
System.InvalidOperationException: Missing [ExternHandler] for
Sales.Application.Orders.Handlers.IConfirmOrderHandler
(operation 'confirm' on aggregate 'Order'). Add a class decorated
with [ExternHandler] that implements this interface.
```

## Hono (TypeScript)

The generator emits `domain/<agg>-extern.ts` with a typed registry,
register helper, and verify gate:

```ts
import type { Order } from "./order.js";

export type ConfirmOrderRequest = Record<string, never>;
export type ConfirmOrderHandler =
  (aggregate: Order, request: ConfirmOrderRequest) => Promise<void>;

export function registerConfirmOrderHandler(fn: ConfirmOrderHandler): void;
export function verifyOrderExternHandlersRegistered(): void;
```

You register your handler before `app.listen()`:

```ts
import { registerConfirmOrderHandler } from "./domain/order-extern.js";

registerConfirmOrderHandler(async (order, _request) => {
  // Your business decision.
  order.status = "Confirmed";
  order.raiseEvent({
    type: "OrderConfirmed",
    order: order.id,
    at: new Date(),
  });
});
```

Aggregates with at least one extern op expose public setters per
property plus `raiseEvent(ev)` and `assertInvariants()` on the root.
The route handler runs `aggregate.checkConfirm()` (preconditions only),
dispatches to the registered handler, then runs invariants and saves.

`createApp(...)` calls `verifyOrderExternHandlersRegistered()` at
startup, so a missing handler fails fast.

## Elixir/Phoenix (plain Ecto)

Elixir uses a **co-located domain extension point** rather than an injected
handler registry: the extern op is a member of the aggregate's own module tree,
scaffolded once and owned by you thereafter.  Two files are generated per
aggregate that has an extern op:

- **`<Ctx>.<Agg>Extern`** (`lib/<app>/<ctx>/<agg>_extern.ex`) — a generated
  `@behaviour` with one `@callback` per extern op.  Regenerated every run, so it
  always tracks the operation signatures.
- **`<Ctx>.<Agg>ExternImpl`** (`lib/<app>/<ctx>/<agg>_extern_impl.ex`) — the
  hand-written implementation.  **Scaffolded once** with a raising stub, then
  **yours** — a `generate system` re-run never overwrites it (see
  *Regeneration preservation* below).

For the `confirm()` extern op above, the generated behaviour + delegating
context is:

```elixir
# lib/sales/sales/order_extern.ex — generated behaviour (one @callback per op)
defmodule Sales.Sales.OrderExtern do
  @callback confirm(Sales.Sales.Order.t(), map()) ::
              {:ok, Sales.Sales.Order.t()} | {:error, term()}
end

# lib/sales/sales.ex — the context delegates the op to the user hook
def confirm_order(%Sales.Sales.Order{} = record, params) when is_map(params) do
  with :ok <- ensure(is_mutable(record), :precondition_failed),
       {:ok, record} <- Sales.Sales.OrderExternImpl.confirm(record, params) do
    record
    |> Ecto.Changeset.change(%{})
    |> Ecto.Changeset.force_change(:status, record.status)
    # …one force_change per scalar column, off the returned struct…
    |> Sales.Sales.OrderRepository.persist_change()
  end
end
```

The scaffolded impl **fails loudly** until you fill it in — a missing
implementation is an HTTP 500 with a clear message, never a silent success:

```elixir
# lib/sales/sales/order_extern_impl.ex — SCAFFOLD-ONCE, yours to edit
# loom:scaffold-once — this file is yours.  Loom scaffolds it on the first
# `generate` and NEVER overwrites it again …
defmodule Sales.Sales.OrderExternImpl do
  @behaviour Sales.Sales.OrderExtern

  @impl true
  def confirm(%Sales.Sales.Order{} = record, _params) do
    # Replace the raise with your logic — mutate the struct and return {:ok, record}:
    {:ok, %{record | status: :Confirmed}}
    # raise "extern operation `confirm` on Order is not implemented — …"
  end
end
```

The hook runs **after** the preconditions and **before** the framework
re-asserts invariants and persists (the same load → preconditions → hook →
invariants → save flow as the other backends).  Mutate the struct and return
`{:ok, record}`; the context persists every scalar column off the returned
struct via `force_change`.  Return `{:error, term}` to abort the write.
Adding a *new* extern op later regenerates the behaviour with a new `@callback`
the scaffold-once impl doesn't yet satisfy, so `mix compile
--warnings-as-errors` fails until you implement it — loud at compile time too.

> Scope: the Elixir hook persists **scalar columns**.  Mutating a containment
> or reference collection from an extern impl is a follow-up.

### Regeneration preservation (scaffold-once)

The Elixir extern impl is the first user of Loom's **scaffold-once** mechanic
(`src/util/scaffold-once.ts`): a generated file carries a `loom:scaffold-once`
marker in its first-line comment, and the CLI writer, on seeing that marker,
**keeps the on-disk copy** whenever the file already exists — writing it only on
the first `generate`.  `ddd generate system` reports these as
`preserved (scaffold-once): N`.  The mechanic is in-band (no side-channel), so a
backend opts a file into it by emitting one comment line; the other extern
slices (.NET partial classes, TS/Python/Java overridable hooks) reuse it.

## When to reach for `extern`

Use `extern` when the *decision* belongs outside the model — pricing,
risk scoring, fraud rules, calls to a system of record you don't own,
or anything else that should be unit-testable in isolation from the
aggregate.  Keep the *invariants* on the aggregate — `extern` is for
the choice, not for relaxing the rules.

For purely internal mutations (toggle a flag, append an item) plain
`operation` is simpler and faster: no DI surface, no extra interface,
no separate user file to maintain.

## Calling an extern from a workflow

A workflow can invoke a parameterless extern op as if it were any
other public operation:

```ddd
workflow placeAndConfirm(orderId: Order id) {
  let order = Orders.getById(orderId)
  order.confirm()   // confirm() is extern — workflow runs the dance
}
```

The generators emit the same lifecycle the auto HTTP route does:
load → `Check<Op>` preconditions → `IXAggHandler.HandleAsync(...)` /
`externHandlers.<op><Agg>(...)` user dispatch → `AssertInvariants`
→ workflow's normal save-at-exit.  The user handler interface gets
DI-injected on .NET (one extra ctor parameter per distinct extern
called) or imported from the per-aggregate `<agg>-extern.js`
registry on Hono.

Parameterized externs work too — the workflow's domain args are
converted to wire shape at the request-construction boundary
(`projectToResponse`-style on .NET via `domainToRequestExpr`,
direct property pickoff on Hono into a typed object literal).
That same conversion fixes a latent bug in the auto Mediator
handler for parameterized externs (commit history: domain types
were passed to a wire-typed request constructor; `domainToRequestExpr`
now wraps each arg).
