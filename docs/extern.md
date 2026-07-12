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

> **Backend coverage.** `extern` *operations* ship on four of the five
> backends — Hono, .NET, **Python**, and **Java**.  Elixir/Phoenix has no
> extern escape hatch (the surface no-ops there).  The two handler-registry
> layouts walked through below (.NET and Hono) are representative; Python
> and Java emit the same shape (a typed per-op handler interface / registry,
> a register/verify gate, and a fail-fast-at-startup check for a missing
> implementation).
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
    public Task HandleAsync(IOrderMutator order, ConfirmRequest request, CancellationToken ct)
    {
        // Your business decision — talk to the billing engine, etc.
        order.Status = OrderStatus.Confirmed;
        order.RaiseDomainEvent(new OrderConfirmed(order.Id, DateTime.UtcNow));
        return Task.CompletedTask;
    }
}
```

The Scrutor scan in `Program.cs` picks it up automatically.  The handler
receives the aggregate as a narrow **`I<Agg>Mutator`** (S10 containment):
the concrete `Order` keeps its setters `private`, and the mutator interface
— implemented explicitly (read `Id` + get/set per field + `RaiseDomainEvent`)
— is the only write surface.  So a handler mutates and raises exactly as
before, but `order.Status = …` on a plain `Order` no longer compiles
anywhere else in the app (`CS0272`).

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
import type { OrderEditor } from "./order.js";

export type ConfirmOrderRequest = Record<string, never>;
export type ConfirmOrderHandler =
  (editor: OrderEditor, request: ConfirmOrderRequest) => Promise<void>;

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

S10 containment: the handler receives a narrow **`OrderEditor`** (read `id`
+ get/set per field + `raiseEvent`), NOT the live `Order`.  The aggregate
mints it via an in-class `_externEditor()`, and its own fields stay
`private` behind read-only getters — so `order.status = …` on a plain
`Order` no longer type-checks (`TS2540`) anywhere else in the app.  The
route runs `aggregate.checkConfirm()` (preconditions only), hands the
handler `aggregate._externEditor()`, then runs invariants and saves.

`createApp(...)` calls `verifyOrderExternHandlersRegistered()` at
startup, so a missing handler fails fast.

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
