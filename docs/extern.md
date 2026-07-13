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
 backends — Hono, .NET, **Python**, **Java**, and **Elixir/Phoenix**.  Two
> idioms exist, as `docs/proposals/extern-domain-extension-point.md` re-homes
> `extern` from an injected application-layer handler to a domain-internal
> extension point:
> - **Domain hook (co-located, scaffold-once)** — **.NET** (a `partial`-method
>   hook), **Java** (a co-located `<Agg>Extern` class), **Python** (a
>   scaffold-once hook module), and **Elixir** (a generated `@behaviour` + a
>   scaffold-once impl module) — each reaches the aggregate's own private state
>   directly (no injected registry, no setter widening); see the per-backend
>   sections below.  A missing hook is a compile error (or fails loudly at
>   runtime); an unfilled one throws.
> - **Injected handler (typed per-op interface + register/verify gate)** —
>   **Hono** (walked through below; same shape: a typed per-op
>   handler interface / registry + a fail-fast-at-startup check for a missing
>   implementation).  These migrate to the domain-hook idiom in later slices.
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

On .NET an extern operation is a **domain extension point** — a partial-method
hook the aggregate *owns* — not an injected application-layer handler.  The
generated aggregate is `sealed partial`; its `Confirm(...)` method runs the
preconditions, calls a `private partial ConfirmCore(...)` hook, then re-asserts
invariants:

```csharp
// generated Domain/Orders/Order.cs — sealed PARTIAL, setters stay private
public sealed partial class Order
{
    public OrderStatus Status { get; private set; }

    public void Confirm()
    {
        if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
        ConfirmCore();          // ← the hand-written domain hook
        AssertInvariants();     // ← the aggregate's own guard still fires
    }

    private partial void ConfirmCore();   // extension point (extended partial → must be implemented)
}
```

You implement the hook in the **co-located, scaffold-once** partial
`Domain/Orders/Order.Extern.cs`.  Because the hook is a *member* of `Order`, it
reaches the aggregate's own `private` state natively — no setter widening:

```csharp
// Domain/Orders/Order.Extern.cs — a MEMBER of Order → full private access
public sealed partial class Order
{
    private partial void ConfirmCore()
    {
        // Your business decision — talk to the billing engine, etc.
        Status = OrderStatus.Confirmed;                       // private setter, reached natively
        _domainEvents.Add(new OrderConfirmed(Id, DateTime.UtcNow));
    }
}
```

There is no injected `I<Op><Agg>Handler`, no dev-stub, no `[ExternHandler]`
attribute, no Scrutor scan, and **no `I<Agg>Mutator`** — the aggregate's setters
stay plain `private` for *every* aggregate (finding S10 is fixed by
construction, not contained: no external holder ever gets write access).  The
auto Mediator command handler simply calls `aggregate.Confirm()` directly, and
a workflow op-call is likewise a plain `order.Confirm()`.

`Order.Extern.cs` is **scaffold-once**: Loom writes it on the first `generate`
(each `ConfirmCore` body `throw`s `NotImplementedException` until you fill it)
and **never overwrites it again** (a `loom:scaffold-once` marker on line 1 tells
the writer to keep your copy).  The hook is declared `private partial`, an
*extended* partial method — so a **missing** implementation is a **compile
error**, not a silent no-op:

```
Domain/Orders/Order.cs(58,26): error CS8795: Partial method 'Order.ConfirmCore()'
must have an implementation part because it has accessibility modifiers.
```

An **unfilled** implementation is a loud runtime `NotImplementedException` (never
the silent success the old dev-stub reported).  Both directions fail loudly.

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

## Python (FastAPI + SQLAlchemy)

Python uses a **co-located domain extension point**, not an injected handler
registry.  The extern op is a real method on the aggregate — it runs its
preconditions, delegates the mutation to a user-owned hook function, then
re-asserts invariants:

```python
# app/domain/order.py — generated, regenerated every run
class Order:
    def confirm(self) -> None:
        if not (self._is_mutable()):
            raise DomainError("Precondition failed: isMutable()")
        if not (self._risk_score < 80):
            raise DomainError("Precondition failed: riskScore < 80")
        order_extern.confirm(self)      # ← the hook
        self._assert_invariants()       # invariants re-run after it mutates
```

The hook lives in a **scaffold-once** module, `app/domain/extern/<agg>_extern.py`
— generated once with a loud raising stub, then **yours** (a `generate system`
re-run never overwrites it; see *Regeneration preservation* below).  It receives
the loaded aggregate and mutates its **own private state directly** — no
per-field setters are minted, so the aggregate stays encapsulated:

```python
# app/domain/extern/order_extern.py — scaffolded once, then yours
# loom:scaffold-once — this file is yours. …
from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.domain.events import OrderConfirmed
from app.domain.value_objects import OrderStatus

if TYPE_CHECKING:
    from app.domain.order import Order


def confirm(order: Order) -> None:
    # Your business decision — a bespoke state transition, a computed score, …
    order._status = OrderStatus.Confirmed
    order.raise_event(OrderConfirmed(order=order.id, at=datetime.now(UTC)))
```

The generated stub each op starts as **raises loudly** until you fill it in, so a
missing implementation is never a silent success:

```python
def confirm(order: Order) -> None:
    raise NotImplementedError(
        "extern operation `confirm` on Order is not implemented — "
        "fill in app/domain/extern/order_extern.py"
    )
```

The aggregate imports the hook module at load time; the hook imports the
aggregate **`TYPE_CHECKING`-only** (annotations are deferred via
`from __future__ import annotations`), so there is no import cycle and the whole
project still passes `ruff` + `mypy --strict`.  The auto route drives the op
exactly like a non-extern one (`found.confirm()` → save), and a workflow can
call it too (`order.confirm()`).

> **External-service case.** If the op needs to *talk to an external service*
> rather than run pure domain logic, that is the case-2 home — an
> `extern commandHandler` / `queryHandler` (see the end of this doc), not the
> aggregate-op hook above.

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

## Java (Spring Boot / JPA)

Java uses the same **co-located domain extension point** as Elixir — the extern
op is a member of the aggregate's own lifecycle, delegating to a scaffold-once
hook you own.  One file is generated per aggregate that declares an extern op:

- **`<Agg>Extern`** (`.../features/<plural>/<Agg>Extern.java`) — a **scaffold-once**
  class co-located with the aggregate (SAME package → it reaches the entity's
  package-private fields + `_raiseEvent` natively; Java never had the .NET/Hono
  S10 setter leak, so no widening is needed).  One `static` method per extern op,
  taking the loaded aggregate.  Scaffolded once with a loud-throwing stub, then
  **yours** — a `generate system` re-run never overwrites it (the
  `loom:scaffold-once` marker).

The generated aggregate method runs the preconditions, delegates to the hook, and
re-asserts invariants (the same load → preconditions → hook → invariants → save
flow as the other backends):

```java
// Order.java (generated) — the extern op is a real aggregate method
public void confirm() {
    if (!(this.isMutable())) throw new DomainException("Precondition failed: isMutable()");
    OrderExtern.confirm(this);   // ← delegate to the co-located hook
    this._assertInvariants();    // ← invariants re-run, always
}
```

The scaffolded hook **fails loudly** until you fill it in — a missing
implementation is a 500 with a clear message, never a silent success:

```java
// Order/OrderExtern.java — SCAFFOLD-ONCE, yours to edit
// loom:scaffold-once — this file is yours.  Loom scaffolds it on the first
// `generate` and NEVER overwrites it again …
package com.example.features.orders;

import com.example.domain.enums.*;
import com.example.domain.events.*;

final class OrderExtern {
    private OrderExtern() {}

    static void confirm(Order order) {
        // Reaches Order's package-private fields directly; raise events via
        // order._raiseEvent(...).  The framework re-asserts invariants + saves.
        order.status = OrderStatus.Confirmed;
        order._raiseEvent(new OrderConfirmed(order.id(), java.time.Instant.now()));
        // throw new UnsupportedOperationException("extern operation `confirm` …");
    }
}
```

The service (and any workflow's `order.confirm()`) calls the op directly —
`repository.getById(id)` → `aggregate.confirm()` → `repository.save(...)` — with
no injected handler and no DI.  Adding a *new* extern op later regenerates the
aggregate with a `<Agg>Extern.<newOp>(...)` call the scaffold-once file doesn't
yet define, so `gradle testClasses` fails until you implement it — loud at
compile time too.

## When to reach for `extern`

Use `extern` when the *decision* belongs outside the model — pricing,
risk scoring, fraud rules, calls to a system of record you don't own,
or anything else that should be unit-testable in isolation from the
aggregate.  Keep the *invariants* on the aggregate — `extern` is for
the choice, not for relaxing the rules.

For purely internal mutations (toggle a flag, append an item) plain
`operation` is simpler and faster: no DI surface, no extra interface,
no separate user file to maintain.

### Migration — an extern op that calls an external service → `extern commandHandler`

An extern *operation* is now **pure domain logic** the DSL can't express (case 1):
compute a score, apply a bespoke state transition — code that runs *inside* the
aggregate's lifecycle and touches only its own state.  If your extern op instead
**calls out to an external service** (case 2 — a billing engine, a VCS sync, a
third-party API — e.g. a `syncFromVcs()`), that is an *application-layer*
concern, not a domain hook: it belongs in an
[`extern commandHandler` / `extern queryHandler`](#extern-application-layer-handlers-commandhandler--queryhandler)
(below), which orchestrates from the application layer and can inject the port
it needs.  Re-home such an op by deleting it from the aggregate and declaring a
bodyless `extern commandHandler` routed from your `api`.

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
load → preconditions → user hook → `AssertInvariants` → workflow's normal
save-at-exit.  On **.NET** the extern op is an ordinary aggregate method, so the
workflow op-call is a plain `order.Confirm()` (no injected handler, no dispatch
dance) — identical to a non-extern op-call.  On the injected-handler backends
(Hono / Python / Java) the user handler is imported / DI-injected and dispatched
(load → `Check<Op>` preconditions → `<handler>(...)` → `AssertInvariants`).

Parameterized externs work too — on .NET the workflow passes the domain-typed
command args straight to the aggregate method (`order.Deduct(command.Amount)`);
on the injected-handler backends the domain args are converted to wire shape at
the request-construction boundary (direct property pickoff on Hono into a typed
object literal).

## `extern` application-layer handlers (commandHandler / queryHandler)

The `extern` operations above are the aggregate-*member* escape hatch (business
logic inside one aggregate's lifecycle). The **application-layer** twin is a
bodyless `extern commandHandler` / `extern queryHandler` — the "case-2" home:
**one external-service call around one aggregate**, at the application layer,
routed straight from an `api`. Like an extern operation it has no DSL body; Loom
scaffolds a **user-owned impl file once** and the generated dispatch calls it,
preserving your implementation across regenerations.

```ddd
context Ordering {
  aggregate Order { code: string }
  repository Orders for Order { }

  // Bodyless (`;`) — the signature is the contract; the impl is yours.
  extern commandHandler PlaceOrder(code: string): Order id;
  extern queryHandler   GetQuote(sku: string): string;   // external read-projection
}

api SalesApi from Ordering {
  route POST "/orders"       -> Ordering.PlaceOrder
  route GET  "/quotes/{sku}" -> Ordering.GetQuote
}
```

A non-extern handler still requires a `{ … }` body; an `extern` one must be
bodyless. The validator pins the pairing: `loom.extern-handler-has-body`
(an `extern` handler with a body) and `loom.handler-missing-body` (a non-extern
handler written `;`).

Each backend expresses the same intent idiomatically — the generated dispatch
wires the route + DTO exactly as a normal handler but calls a scaffold-once,
user-owned impl instead of a DSL-lowered body:

| Backend | Generated dispatch | Scaffold-once user impl (`loom:scaffold-once`) |
|---|---|---|
| Hono | route imports the impl module | `src/application/<kebab>-handler-impl.ts` — `throw new ExternHandlerError(...)` |
| .NET | Mediator handler ctor-injects `I<Name>Handler`; Scrutor registers the `[ExternHandler]` impl + a startup verify | `Application/Handlers/<Name>ExternHandler.cs` — `throw new NotImplementedException(...)` |
| Java | `@Service` handler ctor-injects `<Name>Port` (Spring auto-wires) | `<Name>HandlerImpl.java` — `throw new UnsupportedOperationException(...)` |
| Python | `app/application/<snake>.py` dispatch imports + calls the impl | `app/application/impl/<snake>_impl.py` — `raise NotImplementedError(...)` |
| Elixir | `run/1` delegates via `Application.get_env` (config-swappable) | `lib/<app>/<ctx>/handlers/<snake>_impl.ex` — `raise "... not implemented"` |

The impl file's path is **deterministic and stable** — a rename would orphan
your code, so it never changes. The stub **fails loudly** (throws/raises) until
you fill it in, so a forgotten implementation surfaces as a 500 naming the file,
never a silent no-op. The generated Hono impl for the example above:

```ts
// src/application/place-order-handler-impl.ts
// loom:scaffold-once — this file is yours.  Loom scaffolds it on the first
// `generate` and NEVER overwrites it again …
import { ExternHandlerError } from "../domain/errors";
import * as Ids from "../domain/ids";

export async function placeOrderImpl(code: string): Promise<Ids.OrderId> {
  throw new ExternHandlerError(
    "PlaceOrder",
    "Ordering",
    new Error("extern commandHandler 'PlaceOrder' is not implemented — fill in src/application/place-order-handler-impl.ts"),
  );
}
```

Use it when the *whole* handler is an outbound call (a payment gateway, a quote
service, an external search) rather than a DSL-expressible load→mutate→save. For
that, write a normal bodied `commandHandler` / `queryHandler`.
