# 21. Externs

The escape hatches from the model to hand-written code, each with a typed boundary Loom generates and checks. Three seams: an `extern` **operation** (the body declares only its preconditions; the framework runs them, then dispatches to a user-registered backend handler), an `extern` **component** (a page region rendered by a hand-written module against a generated props interface), and an `extern` **function** (a typed pure frontend function with a generated signature + conformance shim). Reach for `extern` when the *decision* belongs outside the model — pricing, fraud scoring, a call to a system of record — while the invariants stay on the aggregate.

> **Grammar:** `Operation` (`extern?`), `Component` (`extern?='extern' 'from' externPath`), `UiFunction` (`'extern' 'from' externPath`) · **Validators:** `loom.extern-component-has-body`, `loom.extern-function-shadows-stdlib` · **Docs:** [`../extern.md`](../extern.md)

An extern operation's body is **preconditions only** — no assignment, no `emit`, no collection mutation. The framework owns the surrounding lifecycle and the user handler owns the mutation:

```
load aggregate → run preconditions → call user handler → run invariants → save → drain events
```

The runnable showcase is [`web/src/examples/extern-showcase.ddd`](../../web/src/examples/extern-showcase.ddd) — files-only (both seams need a user module to boot/build), so it documents the generated *contract*.

## `extern` operation

`operation name(params) extern { precondition … }` — the `extern` modifier (after the param list, see [Behavior & statements](06-behavior-and-statements.md)) replaces the body's mutation with a generated handler registry. Each backend emits a typed per-op handler interface/type, a register-or-discover mechanism, a startup verify gate that fails fast on a missing implementation, and a dev-stub so the project still boots out of the box.

```ddd
aggregate Order with crudish {
  reference: string
  status: OrderStatus
  riskScore: int

  invariant reference.length > 0
  function isMutable(): bool = status == Draft

  operation confirm() extern {
    precondition isMutable()
    precondition riskScore < 80
  }
}
```

The preconditions stay in the aggregate as a `check<Op>()` method (run before dispatch); the business decision moves to the handler.

::: tabs backend
== node
```ts
// domain/order-extern.ts — typed registry + register helper + startup gate
export type ConfirmOrderRequest = Record<string, never>;
export type ConfirmOrderHandler = (aggregate: Order, request: ConfirmOrderRequest) => Promise<void>;

export const externHandlers = { confirmOrder: null as ConfirmOrderHandler | null };

export function registerConfirmOrderHandler(fn: ConfirmOrderHandler): void {
  externHandlers.confirmOrder = fn;
}
export function verifyOrderExternHandlersRegistered(): void {
  if (externHandlers.confirmOrder === null) {
    throw new Error("Missing extern handler for 'confirm' on aggregate 'Order'. Call registerConfirmOrderHandler(...) before app.listen().");
  }
}
// dev-stub so the project boots; the user's real handler overwrites it
registerConfirmOrderHandler(async () => { /* replace via registerConfirmOrderHandler(...) */ });
```
== dotnet
```csharp
// Application/Orders/Handlers/IConfirmOrderHandler.cs — implement + [ExternHandler]
public interface IConfirmOrderHandler
{
    Task HandleAsync(Order aggregate, ConfirmOrderRequest request, CancellationToken cancellationToken);
}

// Application/Orders/Handlers/DevStubConfirmOrderHandler.cs — permissive dev stub
[ExternHandler]
public sealed class DevStubConfirmOrderHandler : IConfirmOrderHandler
{
    public Task HandleAsync(Order aggregate, ConfirmOrderRequest request, CancellationToken ct)
        => Task.CompletedTask;
}
```
== java
```java
// features/orders/ConfirmOrderHandler.java — provide a @Primary bean to override the dev stub
public interface ConfirmOrderHandler {
    void handle(Order aggregate);
}
```
== python
```python
# app/domain/order_handlers.py — module-level register + verify + dev-stub
ConfirmOrderHandler = Callable[[Order, ConfirmOrderRequest], Awaitable[None]]

confirm: ConfirmOrderHandler | None = None

def register_confirm_order_handler(fn: ConfirmOrderHandler) -> None:
    global confirm
    confirm = fn

def verify_order_extern_handlers_registered() -> None:
    if confirm is None:
        raise RuntimeError(
            "Missing extern handler for 'confirm' on aggregate 'Order'. "
            "Register one via register_confirm_order_handler(...) before serving."
        )

async def _confirm_dev_stub(aggregate: Order, request: ConfirmOrderRequest) -> None:
    return None

register_confirm_order_handler(_confirm_dev_stub)
```
::: end

> Honest gap: Elixir/Phoenix has **no** extern operation hatch — the surface no-ops there (no `*-extern` / handler module is emitted). The four backends above each emit the same shape (typed per-op handler, a register-or-discover mechanism, a fail-fast-at-startup gate). .NET/Java discover the implementation by DI scan (`[ExternHandler]` Scrutor scan / a `@Primary` bean); Hono/Python register explicitly into a module-level registry.

The auto HTTP route loads the aggregate, runs the preconditions via `check<Op>()`, dispatches to the registered handler, re-asserts invariants, then saves. On Hono:

```ts
// http/order.routes.ts — the confirm route body
const aggregate = await repo.getById(Ids.OrderId(id));
aggregate.checkConfirm();                       // preconditions only
const handler = externHandlers.confirmOrder;
if (!handler) throw new Error("Missing extern handler for confirmOrder…");
try {
  await handler(aggregate, body);
} catch (err) {
  if (err instanceof DomainError) throw err;
  if (err instanceof ForbiddenError) throw err;
  if (err instanceof AggregateNotFoundError) throw err;
  throw new ExternHandlerError("confirm", "Order", err);   // wraps unexpected handler errors
}
aggregate.assertInvariants();
await repo.save(aggregate);
```

`checkConfirm()` carries exactly the declared preconditions, no mutation:

```ts
// domain/order.ts
checkConfirm(): void {
  if (!(this.isMutable())) throw new DomainError("Precondition failed: isMutable()");
  if (!(this._riskScore < 80)) throw new DomainError("Precondition failed: riskScore < 80");
}
```

An aggregate with at least one extern op also widens its property setters and exposes `raiseEvent(ev)` / `assertInvariants()` (TS) — or `internal` setters + `internal void RaiseEvent(...)` on .NET — so the same-assembly handler can mutate state and raise events. The startup verify gate is wired into app boot (`verifyOrderExternHandlersRegistered()` is called from `http/index.ts` before serving), so a forgotten handler fails fast rather than 500-ing at request time.

### Calling an extern from a workflow

A workflow invokes a parameterless extern op like any other public operation; the generators emit the same load → preconditions → handler → invariants → save dance the HTTP route does.

```ddd
workflow confirmOrder {
  create(orderId: Order id) {
    let order = Orders.getById(orderId)
    order.confirm()              // confirm() is extern — workflow runs the dance
  }
}
```

The handler is DI-injected on .NET (one extra ctor parameter per distinct extern called) or imported from the per-aggregate `<agg>-extern` registry on Hono. See [`../extern.md`](../extern.md) for the parameterized-extern request-construction detail.

## `extern` component

`component X(params) extern from "<path>"` declares the typed param contract for a page region but **no** `body:` — rendering is handed to a hand-written module at the path. The generator emits `<Name>.props.ts` (the props interface the user types their component against) and a shim that re-exports the user module, and imports it at every call site. This is a frontend-only feature (React, Vue, Svelte).

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
  score: string;
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
::: end

> Honest gap: only the React generator's emitted output is excerpted above (the showcase pins a `react` deployable). Vue and Svelte support the same surface with their framework-shaped props/shim emission. Note `score: int` surfaces as `score: string` in the props interface — the props mirror the *wire* shape of each param.

A `body:` on an `extern` component is a validation error (`loom.extern-component-has-body`): "its rendering is owned by the hand-written module … Remove the body, or drop 'extern from' to make it a normal component." The inverse — a non-extern component with no `body:` — is also rejected.

## `extern` function

`function f(params): T extern from "<path>"` is a typed pure frontend function backed by a hand-written module. Loom emits a typed signature (`src/lib/extern/<name>.signature.ts`) plus a conformance shim (`src/lib/<name>.ts`) that re-exports the user's implementation annotated with that signature — so a missing module or a mismatched signature fails `tsc`. The v1 surface is extern-only; page bodies call it through the shim.

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
```tsx
// src/pages/orders.tsx — called through the shim
import { initials } from "../lib/initials";
// …
<Text>{initials("Ann Bee")}</Text>
```
::: end

The function name may not shadow a walker-stdlib primitive (`loom.extern-function-shadows-stdlib`). When to reach for `extern`: the *decision* lives outside the model. For a purely internal mutation a plain `operation` is simpler — no DI surface, no extra interface, no user file. Keep invariants on the aggregate; `extern` is for the choice, not for relaxing the rules.
