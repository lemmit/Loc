# 6. Behavior & statements

How an aggregate changes state: the four action members — `operation` (a mutating method), `create` / `destroy` (lifecycle factory / terminator), and the event-sourcing `apply` fold — plus the statement vocabulary their bodies share (`precondition`, `requires`, `let`, `emit`, `return`, the assignment family `:=` / `+=` / `-=`, and the effect-form `match`). The same statements also fill a page `action` and an application-layer `commandHandler` / `queryHandler`. Reach for it when you need a domain method that validates, mutates, raises an event, or returns a typed outcome.

> **Grammar:** `Operation`, `Create`, `Destroy`, `Apply`, `CommandHandler` / `QueryHandler`, `Statement` (`PreconditionStmt`, `RequiresStmt`, `LetStmt`, `EmitStmt` / `EmitField`, `ReturnStmt`, `AssignOrCallStmt` / `LValue`, `MatchStmt` / `VariantStmtArm`; `ForStmt` / `IfLetStmt` are workflow-body only — see [Workflows](13-workflows.md)) · **Validators:** `loom.this-id-in-create`, `loom.extern-body-not-precondition`, `loom.lifecycle-body-dropped` / `loom.named-lifecycle-dropped` / `loom.lifecycle-guard-unreadable` / `loom.lifecycle-guard-event-sourced`, `loom.applier-*` / `loom.emitted-event-*`, `loom.audited-backend-unsupported` / `loom.audited-returning-operation-unsupported`, `loom.when-unsupported` / `loom.operation-return-unsupported` / `loom.unmapped-error-status`, `loom.missing-effect-marker` / `loom.effect-in-lambda` / `loom.match-await-*` / `loom.instance-effect-needs-route-id`, `loom.handler-*` / `loom.query-handler-saves` / `loom.command-handler-multi-aggregate` (`src/language/validators/statements.ts`, `handlers.ts`; `src/ir/validate/checks/structural-checks.ts`, `system-checks.ts`, `api-checks.ts`, `ui-checks.ts`) · **Lowering:** [`src/ir/lower/lower-stmt.ts`](../../src/ir/lower/lower-stmt.ts), `lower-members.ts`, `lower-workflow.ts` (handler bodies); shared dispatch in [`_stmt/target.ts`](../../src/generator/_stmt/target.ts) · **Docs:** [`../language.md`](../language.md), [`../actions.md`](../actions.md), [`../workflow.md`](../workflow.md), [`../auth.md`](../auth.md)

Every aggregate body lowers through one shared `lowerStatement`, so an `operation`, a `create`, a `destroy`, and an `apply` all draw from the same statement set; the **kind tag** (not the body syntax) carries the lifecycle asymmetry. The lowered `StmtIR` has **11 kinds** — `precondition`, `requires`, `let`, `assign`, `add`, `remove`, `emit`, `call`, `expression`, `return`, `variant-match` — and `src/generator/_stmt/target.ts` owns the dispatch once; each backend's `render-stmt.ts` is a leaf table. Every tab below was generated from one scratch system with one deployable per backend (`node bin/cli.js generate system … -o out`) and excerpted; statements are separated by newlines (there is no `;` statement separator). The C# tabs are excerpted one step further than the rest: the .NET emitter weaves a C#10 `#line (a,b)-(c,d) "…ddd"` directive ahead of each mapped statement of a named operation (`weaveLineDirectives`, `src/generator/dotnet/emit/entity.ts`), so a debugger steps the `.ddd` source; those directives are elided here.

## `operation` — a mutating method

`[private] operation name(params) [extern] [audited] [: ReturnType] [requires Gate] [when Guard] { body }`. A public method on the aggregate root that mutates `this`; `private operation` keeps it off the HTTP surface (callable only from another op via a bare `name(args)` call). The body runs, then the framework asserts invariants on the way out.

```ddd
context Orders {
  enum Status { Draft, Placed, Done }
  event OrderConfirmed { order: Order id, at: datetime }

  aggregate Order {
    qty: int
    status: Status
    contains lines: Line[]

    function isMutable(): bool = status == Status.Draft

    private operation recompute() {
      qty := qty + 0
    }

    operation confirm() when status == Status.Draft {
      precondition isMutable()
      recompute()
      precondition lines.count > 0
      status := Status.Placed
      emit OrderConfirmed { order: id, at: now() }
    }

    entity Line { amount: money }
  }
}
```

The body becomes a method whose statements emit in order, opened by the `when` gate and capped by the invariant assertion.

::: tabs backend
== node
```ts
// domain/order.ts
private recompute(): void {
  this._qty = this._qty + 0;
  this._assertInvariants();
}
public confirm(): void {
  if (!(this._status === Status.Draft)) throw new DisallowedError("operation 'confirm' is not allowed in the current state of Order.");
  if (!(this.isMutable())) throw new DomainError("Precondition failed: isMutable()");
  this.recompute();
  if (!(this._lines.length > 0)) throw new DomainError("Precondition failed: lines.count > 0");
  this._status = Status.Placed;
  this._events.push({ type: "OrderConfirmed", order: this._id, at: new Date() });
  this._assertInvariants();
}
```
== dotnet
```csharp
// Domain/Orders/Order.cs
public void Confirm()
{
    if (!(this.Status == Status.Draft)) throw new DisallowedException("operation 'confirm' is not allowed in the current state of Order.");
    if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
    this.Recompute();
    if (!(this.Lines.Count > 0)) throw new DomainException("Precondition failed: lines.count > 0");
    Status = Status.Placed;
    _domainEvents.Add(new OrderConfirmed(Order: this.Id, At: DateTime.UtcNow));
    AssertInvariants();
}
```
== java
```java
// features/orders/Order.java
public void confirm() {
    if (!(this.status == Status.Draft)) throw new DisallowedException("operation 'confirm' is not allowed in the current state of Order.");
    if (!(this.isMutable())) throw new DomainException("Precondition failed: isMutable()");
    this.recompute();
    if (!(this.lines.size() > 0)) throw new DomainException("Precondition failed: lines.count > 0");
    this.status = Status.Placed;
    this._domainEvents.add(new OrderConfirmed(this.id, Instant.now()));
    this._assertInvariants();
}
```
== python
```python
# app/domain/order.py
def confirm(self) -> None:
    if not (self._status == Status.Draft):
        raise DisallowedError("operation 'confirm' is not allowed in the current state of Order.")
    if not (self._is_mutable()):
        raise DomainError("Precondition failed: isMutable()")
    self._recompute()
    if not (len(self._lines) > 0):
        raise DomainError("Precondition failed: lines.count > 0")
    self._status = Status.Placed
    self._events.append(OrderConfirmed(order=self._id, at=datetime.now(UTC)))
    self._assert_invariants()
```
== elixir
```elixir
# lib/ex_api/orders.ex — a context function: guards are a `with` chain, the
# assignments rebuild the struct, the persist goes through a forced changeset,
# and the event is broadcast over Phoenix.PubSub after the save.
def confirm_order(%ExApi.Orders.Order{} = record, params) when is_map(params) do
  with :ok <- ensure(record.status == :Draft, {:disallowed, "operation 'confirm' is not allowed in the current state of Order."}),
       :ok <- ensure(is_mutable(record), {:precondition_failed, "Precondition failed: isMutable()"}),
       :ok <- ensure(Enum.count(record.lines) > 0, {:precondition_failed, "Precondition failed: lines.count > 0"}) do
    _ = nil  # vanilla: bare call to 'recompute' (no callable target); record unchanged
    record = %{record | status: :Placed}
    changeset =
      record
      |> Ecto.Changeset.change(%{})
      |> Ecto.Changeset.force_change(:status, record.status)
      |> Ecto.Changeset.optimistic_lock(:version)
      # |> ExApi.Orders.OrderChangeset.validate_invariants()  ← only when the
      #    aggregate carries a RESIDUAL invariant (cross-field, or messaged);
      #    a single-field rule rides a native Ecto `validate_*` instead.

    case ExApi.Orders.OrderRepository.persist_change(changeset) do
      {:ok, saved} ->
        loom_event_0 = %ExApi.Orders.Events.OrderConfirmed{order: record.id, at: DateTime.utc_now()}
        Phoenix.PubSub.broadcast(ExApi.PubSub, "events", loom_event_0)
        {:ok, saved}
      {:error, reason} -> {:error, reason}
    end
  end
end
```
::: end

A `private operation` is invoked from another op as a bare call — `recompute()` lowers to `this.recompute()` (TS/.NET/Java), `self._recompute()` (Python). **Honest gap:** the Elixir context function renders that call as the `_ = nil  # … bare call to 'recompute' (no callable target)` line above — the private body does not run on Phoenix.

Modifiers: `extern` emits only the gates and hands the business decision to a user-registered handler — its body may contain nothing but `precondition` statements (`loom.extern-body-not-precondition`), and it can't be `private` (`loom.extern-on-private-operation`); see [Externs](21-externs.md). `audited` records an audit row around the call on all five backends (a context hosted elsewhere is `loom.audited-backend-unsupported`); an `audited` operation that also declares a return type is refused on **node** (`loom.audited-returning-operation-unsupported` — the Hono route emits only the void 204 handler for that combination). See [Capabilities](11-capabilities-filters-stamps.md) for `auditable`.

## Guards — `requires` (403) vs `when` (409) vs `precondition` (422)

Three distinct gates, three distinct HTTP failures. They type identically (each is a `bool` expression) but lower to different throws so the route layer maps them to different statuses — the same three codes on every backend.

| Clause | Means | Throws | HTTP |
|---|---|---|---|
| `requires Expr` (header or body) | the caller is authorized | `ForbiddenError` / `ForbiddenException` / `{:error, {:forbidden, _}}` | **403** Forbidden |
| `when Expr` (header) | the aggregate is in a state that admits this op | `DisallowedError` / `DisallowedException` / `{:disallowed, _}` | **409** Disallowed |
| `precondition Expr` (body) | domain validity of the arguments/state | `DomainError` / `DomainException` / `{:precondition_failed, _}` | **422** Unprocessable Entity |

```ddd
aggregate Order {
  subtotal: money
  status: Status
  operation addLine(price: money, isStaff: bool) requires isStaff {
    precondition price > money("0.00")
    subtotal := subtotal + price
  }
}
```

`requires` may be written on the header (`operation addLine(...) requires isStaff { … }`) or as the first statement(s) of the body — the header form lowers to a synthetic leading `requires` statement, so the two are indistinguishable after phase ⑤. A `precondition` may carry `message "…"` to replace the derived `Precondition failed: <source>` text. Evaluation order at the call site is **requires → when → body**, so a 403 wins over a 409 wins over a 422.

**Where each gate runs.** `when` is a property of the **domain method**: every backend emits the predicate as the first line of the generated operation, so every caller evaluates it (the route, a workflow step, a handler). The **leading run of `requires`** is deliberately *hoisted* out of the entity to the calling handler (`src/ir/util/op-gates.ts`), because authorization needs a principal the domain layer does not carry; a `requires` further down the body stays where it is. The hoisted gate, one level up on each backend:

::: tabs backend
== node
```ts
// http/order.routes.ts — inside the POST /{id}/add_line handler
const aggregate = await repo.getById(Ids.OrderId(id));
if (!(body.isStaff)) throw new ForbiddenError("Forbidden: isStaff");
aggregate.addLine(body.price, body.isStaff);
```
== dotnet
```csharp
// Application/Orders/Commands/AddLineHandler.cs
var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)
    ?? throw new AggregateNotFoundException($"Order {command.Id} not found");
if (!(command.IsStaff)) throw new ForbiddenException("Forbidden: isStaff");
aggregate.AddLine(command.Price, command.IsStaff);
await _repo.SaveAsync(aggregate, cancellationToken);
```
== java
```java
// features/orders/OrderService.java
var isStaff = request.isStaff();
if (!(isStaff)) throw new ForbiddenException("Forbidden: isStaff");
aggregate.addLine(price, isStaff);
```
== python
```python
# app/http/order_routes.py — inside add_line_order
if not (body.isStaff):
    raise ForbiddenError("Forbidden: isStaff")
```
== elixir
```elixir
# lib/ex_api/orders.ex — the context function's `with` chain
with :ok <- ensure(is_staff, {:forbidden, "Forbidden: isStaff"}),
     :ok <- ensure(Decimal.compare(price, Decimal.new("0.00")) == :gt, {:precondition_failed, "Precondition failed: price > money(\"0.00\")"}) do
```
::: end

The route layer turns each failure into RFC-7807 `application/problem+json`. On the Hono backend the `app.onError` handler checks `ForbiddenError` **before** `DomainError`; the same ladder is `DomainExceptionFilter` (.NET), `ApiExceptionAdvice` (Java), `app/http/problem.py` (Python), and the controller's `{:error, {:forbidden | :disallowed | :precondition_failed, detail}}` clauses (Elixir):

```ts
// http/ledgerApi-routes.ts — the generated `app.onError` ladder (node).
// Every routed sub-app carries the same ladder; the root `http/index.ts` copy
// adds structured logging + a `recordDomainFault(...)` metric per arm.
if (err instanceof ForbiddenError)         return problem(403, "Forbidden", err.message);
if (err instanceof DisallowedError)        return problem(409, "Disallowed", err.message);
if (err instanceof DomainError)            return problem(422, "Unprocessable Entity", err.message);
if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);
if (err instanceof ConcurrencyError)       return problem(409, "Conflict", err.message);
```

A `requires` that reads `currentUser` needs a deployable that binds a verified principal (`loom.guard-principal-without-auth`); see [Auth](17-auth.md#requires--the-authorization-gate-http-403).

### `when` also auto-exposes `GET /{id}/can_<op>`

A `when`-gated operation gets a free, side-effect-free companion route returning `{ allowed }` so a UI can enable/disable the action without invoking it (the canCommand pattern), on all five backends (`can_confirmOrder` / `CanConfirmQuery` / `canConfirm` / `can_confirm_order` / `can_confirm_order/1`). For `operation confirm() when status == Status.Draft`:

```ts
// http/order.routes.ts — auto-emitted alongside the confirm route
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/can_confirm",
    tags: ["orders"],
    operationId: "can_confirmOrder",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: z.object({ allowed: z.boolean() }) } } },
      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const aggregate = await repo.getById(Ids.OrderId(id));
    return c.json({ allowed: aggregate.status === Status.Draft }, 200);
  },
);
```

The mutating route evaluates the same predicate post-load before the body runs; false there throws `DisallowedError` → 409. See [`../criterion.md`](../criterion.md) for `when`'s relationship to reusable criteria.

## `let` & `emit`

`let name = Expr` binds a local; `emit Event { field: value, … }` records a domain event (`EmitField`s are `name: value` pairs; a missing or ill-typed field is reported at the construction site, and the event must be declared in the same context). Field names re-quote and re-case per backend; emit-field order is normalized to the event's declared field order on positional-constructor backends (Java/.NET).

```ddd
operation addLine(price: money) {
  let next = subtotal + price
  subtotal := next
  emit LinePriced { order: id, total: next }
}
```

::: tabs backend
== node
```ts
const next = this._subtotal.plus(price);
this._subtotal = next;
this._events.push({ type: "LinePriced", order: this._id, total: next });
```
== dotnet
```csharp
var next = this.Subtotal + price;
Subtotal = next;
_domainEvents.Add(new LinePriced(Order: this.Id, Total: next));
```
== java
```java
var next = this.subtotal.add(price);
this.subtotal = next;
this._domainEvents.add(new LinePriced(this.id, next));
```
== python
```python
next = self._subtotal + price
self._subtotal = next
self._events.append(LinePriced(order=self._id, total=next))
```
== elixir
```elixir
next = Decimal.add(record.subtotal, price)
record = %{record | subtotal: next}
# … force_change(:subtotal, record.subtotal) + persist, then:
loom_event_0 = %ExApi.Orders.Events.LinePriced{order: record.id, total: next}
Phoenix.PubSub.broadcast(ExApi.PubSub, "events", loom_event_0)
```
::: end

On an event-sourced aggregate (`persistedAs: eventLog`), `emit` does **double duty** — it records the event *and* folds it immediately via `_apply`, so the in-memory aggregate reflects the transition before the command returns. There, command bodies may *only* `emit`; the state change lives in the `apply` block (below). The event-sourced `emit` becomes `{ const __ev: Events.DomainEvent = { type: "Deposited", … }; this._events.push(__ev); this._apply(__ev); }` (node), `{ var __ev = new Deposited(…); _domainEvents.Add(__ev); _Apply(__ev); }` (.NET), the same three-step block on Java, and `__ev = Deposited(…)` / `self._events.append(__ev)` / `self._apply(__ev)` on Python.

## Assignment — `:=`, `+=`, `-=`

`target := Expr` is scalar assignment; `target += Expr` / `target -= Expr` are collection append / remove (`add` / `remove` in the IR). The target is an `LValue` — a bare field name or a dotted path (`draft.zip`), never `this.`-prefixed. Assigning to a `derived` member is an error (`Cannot assign to derived property …`). A numeric/decimal literal flowing into a `money` target is elaborated to the precise money constructor at lowering (`subtotal := 0.50` → `money("0.50")`).

```ddd
aggregate Order {
  status: Status
  notes: string[]

  operation addNote() {
    status := Status.Placed     // scalar
    notes  += "line"            // collection append
    notes  -= "draft"           // collection remove
  }
}
```

::: tabs backend
== node
```ts
this._status = Status.Placed;
this._notes.push("line");
{ const idx = this._notes.findIndex((e) => e === ("draft")); if (idx >= 0) this._notes.splice(idx, 1); }
```
== dotnet
```csharp
Status = Status.Placed;
Notes.Add("line");
Notes.Remove("draft");
```
== java
```java
this.status = Status.Placed;
this.notes.add("line");
this.notes.remove("draft");
```
== python
```python
self._status = Status.Placed
self._notes.append("line")
__rm = "draft"
if __rm in self._notes:
    self._notes.remove(__rm)
```
== elixir
```elixir
# the struct is rebuilt, then every touched field is force_change'd onto the changeset
record = %{record | status: :Placed}
record = %{record | notes: (record.notes || []) ++ ["line"]}
record = %{record | notes: List.delete(record.notes || [], "draft")}
changeset =
  record
  |> Ecto.Changeset.change(%{})
  |> Ecto.Changeset.force_change(:status, record.status)
  |> Ecto.Changeset.force_change(:notes, record.notes)
  |> Ecto.Changeset.optimistic_lock(:version)
```
::: end

`+=` / `-=` on a `contains` collection append/remove an entity part; on an `X id[]` reference collection they attach/detach a target id (the join-table row is written on save).

## `create` / `destroy` — lifecycle actions

`create [name](params) [audited] { body }` is the factory marker: an **unnamed** `create(...)` makes the aggregate constructible over HTTP (`POST /<aggs>` + a static factory whose input is **derived from the field set**, not from the parameter list); `destroy [name][(params)] [audited] { body }` is the terminator (`DELETE /{id}`). Neither is ever `private` or `extern`. The `crudish` capability injects the canonical pair plus an `update`. Two gates are distinct: the **domain factory** `Agg.create(...)` is emitted for every *constructible* aggregate — one that declares a create, or whose every invariant is satisfiable from the create input (`isConstructible`, `src/ir/enrich/wire-projection.ts`) — and is parameterized over the create-input field set, while the **REST** `POST /<aggs>` appears only when a canonical `create` is actually declared (by hand or by `crudish`). Field defaults do not decide either: a default only makes that field optional *input*.

On a **state-based** aggregate the braces are a contract, not a body: no backend renders `canonicalCreate.statements` / `canonicalDestroy.statements`, so the validator refuses any statement that would silently vanish (`loom.lifecycle-body-dropped`, an error): a `precondition`, an `emit`, a `+=`/`-=`, a call, or an assignment whose value the emitted factory does not already reproduce. Two assignments *are* reproduced and therefore admitted — `field := <same-named param>` (the field-derived input supplies it) and `field := <literal>` when the field declares that same literal default. A **named** `create open(...)` / `destroy close(...)` on a state-based aggregate reaches no emitter at all and is refused whole (`loom.named-lifecycle-dropped`) — with one exception: on an **event-sourced** aggregate the single `create` is canonical whether or not it is named, so `create open(owner: string) { emit Opened { … } }` is emitted and ungated. Reading the identity as the explicit `this.id` inside a `create` body is `loom.this-id-in-create`; a bare `id` is not gated, and is what the event-sourced `create` above emits.

A `requires` **is** rendered for the canonical pair (every backend evaluates it at its own chokepoint and denies with 403). Note the spelling: `Create`/`Destroy` have no header `requires` clause in the grammar — `create(name: string) requires … { }` is a parse error — so a lifecycle guard is written as the first *statement* of the body. What it may read is narrow: a `create` guard may read `currentUser` only; a `destroy` guard may read `currentUser` and `this` — never a parameter (`loom.lifecycle-guard-unreadable`). On an event-sourced aggregate a `create` guard cannot be enforced at all (`loom.lifecycle-guard-event-sourced`) — gate the operation that issues the create instead.

```ddd
aggregate Wallet {
  name: string
  balance: int
  create(name: string) {
    name := name          // admitted — a no-op restatement of the wire contract
  }
  destroy { }
}
```

::: tabs backend
== node
```ts
// domain/wallet.ts — the factory is synthesised from the field set
static create(input: { name: string; balance: number }): Wallet {
  return new Wallet({ id: Ids.newWalletId(), name: input.name, balance: input.balance, version: 0 });
}
// http/wallet.routes.ts — POST / (operationId createWallet) …
const created = Wallet.create({ name: body.name, balance: body.balance });
await repo.save(created);
return c.json({ id: created.id as string }, 201);
// … and DELETE /{id} (operationId destroyWallet) — the delete is wrapped in a
// try/catch that turns a PG 23503 FK violation into a 409 problem+json
await repo.getById(Ids.WalletId(id));
try {
  await repo.delete(Ids.WalletId(id));
} catch (err) { /* … 23503 → 409 "Wallet is still referenced and cannot be deleted." */ }
return c.body(null, 204);
```
== dotnet
```csharp
// Domain/Wallets/Wallet.cs
public static Wallet Create(string name, int balance) { var e = new Wallet(); /* … */ e.AssertInvariants(); return e; }
// Application/Wallets/Commands/DestroyWalletHandler.cs
public async ValueTask<Unit> Handle(DestroyWalletCommand command, CancellationToken cancellationToken)
{
    var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)
        ?? throw new AggregateNotFoundException($"Wallet {command.Id} not found");
    await _repo.DeleteAsync(aggregate, cancellationToken);
    return Unit.Value;
}
```
::: end

Java (`Wallet.create(...)` behind `WalletService.createWallet` + a `@DeleteMapping` route), Python (a `Wallet.create(...)` classmethod + `DELETE /{id}`) and Elixir (`defdelegate create_wallet(attrs), to: WalletRepository, as: :insert`, plus `destroy_wallet!/1`) follow the same shape. The **event-sourced** `create` is the exception: its body is rendered — see `apply` next.

## `apply(e: Event)` — the event-sourcing fold

On a `persistedAs: eventLog` aggregate, `apply(e: SomeEvent) { body }` is the fold that turns an emitted event into state. Applier bodies are **pure folds** — assignments and `let` only: an `emit` is `loom.applier-emits`, a guard is `loom.applier-guard`, a call is `loom.applier-impure-call`. Every emitted event needs an applier (`loom.emitted-event-no-applier` / `loom.emitted-event-unhandled`). The command bodies decide and `emit`; the appliers own the actual state transition. (`apply` lowers to its own `ApplyIR` and never joins `agg.operations`.)

```ddd
aggregate Account persistedAs: eventLog {
  owner: string
  balance: int

  create open(owner: string) {
    emit Opened { account: id, owner: owner }
  }

  operation deposit(amount: int) {
    precondition amount > 0
    emit Deposited { account: id, amount: amount }
  }

  apply(e: Opened) {
    owner := e.owner
    balance := 0
  }
  apply(e: Deposited) { balance := balance + e.amount }
}
```

Each applier becomes a private `_apply<Event>` method; a `_apply` dispatcher switches on the event; a `_fromEvents` rehydrator folds a stream from an empty shell on load.

::: tabs backend
== node
```ts
// domain/account.ts
private _applyOpened(e: Events.Opened): void {
  this._owner = e.owner;
  this._balance = 0;
}
private _applyDeposited(e: Events.Deposited): void {
  this._balance = this._balance + e.amount;
}
private _apply(ev: Events.DomainEvent): void {
  switch (ev.type) {
    case "Opened":
      this._applyOpened(ev as Events.Opened);
      break;
    case "Deposited":
      this._applyDeposited(ev as Events.Deposited);
      break;
  }
}
static _fromEvents(id: Ids.AccountId, events: Events.DomainEvent[]): Account {
  const inst = Account._rehydrate({ id } as unknown as { id: Ids.AccountId; owner: string; balance: number });
  for (const ev of events) inst._apply(ev);
  return inst;
}
```
== dotnet
```csharp
// Domain/Accounts/Account.cs
private void _ApplyOpened(Opened e)
{
    Owner = e.Owner;
    Balance = 0;
}
private void _ApplyDeposited(Deposited e)
{
    Balance = this.Balance + e.Amount;
}
private void _Apply(IDomainEvent ev)
{
    switch (ev)
    {
        case Opened e: _ApplyOpened(e); break;
        case Deposited e: _ApplyDeposited(e); break;
    }
}
public static Account _FromEvents(AccountId id, IReadOnlyList<IDomainEvent> events) { /* fold from an empty shell */ }
```
== java
```java
// features/accounts/Account.java — a sealed-interface switch
private void _applyOpened(Opened e) {
    this.owner = e.owner();
    this.balance = 0;
}
private void _applyDeposited(Deposited e) {
    this.balance = this.balance + e.amount();
}
void _apply(DomainEvent ev) {
    switch (ev) {
        case Opened e -> _applyOpened(e);
        case Deposited e -> _applyDeposited(e);
        default -> { }
    }
}
public static Account _fromEvents(AccountId id, List<DomainEvent> events) {
    var e = new Account();
    e.id = id;
    for (var ev : events) e._apply(ev);
    e._assertInvariants();
    return e;
}
```
== python
```python
# app/domain/account.py — isinstance ladder
def _apply_opened(self, e: Opened) -> None:
    self._owner = e.owner
    self._balance = 0

def _apply_deposited(self, e: Deposited) -> None:
    self._balance = self._balance + e.amount

def _apply(self, ev: DomainEvent) -> None:
    if isinstance(ev, Opened):
        self._apply_opened(ev)
    elif isinstance(ev, Deposited):
        self._apply_deposited(ev)
```
== elixir
```elixir
# lib/ex_api/accounts/account_fold.ex — one apply_event/2 clause per applier
def apply_event(state, %ExApi.Accounts.Events.Opened{} = e) do
  state = %{state | owner: e.owner}
  state = %{state | balance: 0}
  state
end

def apply_event(state, %ExApi.Accounts.Events.Deposited{} = e) do
  state = %{state | balance: state.balance + e.amount}
  state
end

def apply_event(_state, ev) do
  raise ArgumentError, "no applier for event #{inspect(ev.__struct__)}"
end
```
::: end

The full runnable example is [`examples/event-sourcing.ddd`](../../examples/event-sourcing.ddd). See [`../workflow.md`](../workflow.md) §"Member forms" for the applier discipline and how the event log persists.

## `return` — the exception-less outcome

`operation foo(): X or Error { … return … }` declares an `or`-union return; instead of throwing, the body returns a designed-in outcome that the route translates — an error variant to an RFC-7807 status, a success variant to 200. Each `return` is tagged at lowering with the variant whose structural shape matches the returned value. An `error` with no stdlib status and no `httpStatus <Error> -> <code>` line on the serving `api` defaults to **500** and warns (`loom.unmapped-error-status`).

```ddd
context Orders {
  error NotAllowed { reason: string }
  aggregate Order {
    status: Status
    operation place(): Order or NotAllowed {
      precondition status == Status.Draft
      return NotAllowed { reason: "already placed" }
    }
  }
}
```

::: tabs backend
== node
```ts
// domain/order.ts — record variant flattens beside the `type` tag on the wire
public place(): ({ type: "Order"; id: string; /* …the Order wire shape… */ } | { type: "NotAllowed"; reason: string }) {
  if (!(this._status === Status.Draft)) throw new DomainError("Precondition failed: status == Status.Draft");
  return { type: "NotAllowed", ...(({ reason: "already placed" })) };
}
```
== dotnet
```csharp
// Domain/Orders/Order.cs — constructs the union variant record <Union>_<Tag>(…)
public OrderOrNotAllowed Place()
{
    if (!(this.Status == Status.Draft)) throw new DomainException("Precondition failed: status == Status.Draft");
    return new OrderOrNotAllowed_NotAllowed("already placed");
}
```
== java
```java
// features/orders/Order.java — variant record, args ordered by the variant's declared fields
public OrderOrNotAllowed place() {
    if (!(this.status == Status.Draft)) throw new DomainException("Precondition failed: status == Status.Draft");
    return new OrderOrNotAllowed_NotAllowed("already placed");
}
```
== python
```python
# app/domain/order.py — a dict carrying the wire keys
def place(self) -> dict[str, object]:
    if not (self._status == Status.Draft):
        raise DomainError("Precondition failed: status == Status.Draft")
    return {"type": "NotAllowed", **{"reason": "already placed"}}
```
== elixir
```elixir
# lib/ex_api/orders.ex — the value is the last expression; an error variant is an {:error, tag, fields} tuple
def place_order(%ExApi.Orders.Order{} = record, params) when is_map(params) do
  with :ok <- ensure(record.status == :Draft, {:precondition_failed, "Precondition failed: status == Status.Draft"}) do
    {:error, "NotAllowed", %{reason: "already placed"}}
  end
end
```
::: end

A record variant flattens its fields beside `type` on the wire; a scalar variant wraps a `value`; a `none` variant is the bare `{ type: … }`. See [Payloads & unions](09-payloads-and-unions.md) for the union wire shape and `httpStatus` mapping.

## `match` — the effect-form variant match

`match SUBJECT { Variant [b] => stmt | { stmts }, …, else => … }` (`MatchStmt` / `VariantStmtArm`) is the **statement** twin of the variant-match expression: its arms run statements rather than yield a value, and each arm may bind the narrowed variant. It lowers to the `variant-match` StmtIR kind, which is **frontend-only** — the shared statement dispatcher throws if one ever reaches a backend body, and in practice it can't: the only admitted call subject is `await <api>.<Agg>.<op>(args)`, the async remote command of a page or component `action`. Every arm of an `or`-union must be covered or an `else` supplied.

```ddd
ui Console {
  api Orders: OrdersApi
  page OrderPage(id: Order id) {
    route: "/orders/:id"
    state { message: string = "" }
    action place() {
      match await Orders.Order.place() {
        Order o      => { message := "placed" }
        NotAllowed e => { message := e.reason }
      }
    }
    body: Stack { Text { message }, Button { "Place", onClick: place } }
  }
}
```

The `await` is the **effect marker**. A bare `Orders.Order.place()` in an action body is `loom.missing-effect-marker` (an error — every remote mutating command is awaited and its result matched); the same call inside a render-tree lambda is `loom.effect-in-lambda`; an instance op needs a `:id` route param in scope (`loom.instance-effect-needs-route-id`); the call's arguments must match the operation signature (`loom.match-await-arg-mismatch` / `loom.match-await-arg-type`). A context-local `error` resolves in an arm only when the page's `api X: Y` handle binds the context that owns it.

::: tabs frontend
== react
```tsx
// src/pages/order_page.tsx — the awaited mutation, the ProblemDetails → variant
// re-tagging, and one switch case per arm
const orderPlace = usePlaceOrder(id ?? "");
const place = async () => { {
  let result: PlaceOrderResponse;
  try {
    result = await orderPlace.mutateAsync({});
  } catch (e) {
    if (e instanceof ApiError) {
      result = { ...(e.body as Record<string, unknown>), type: "NotAllowed" } as PlaceOrderResponse;
    } else {
      throw e;
    }
  }
  switch (result.type) {
    case "Order": {
      const o = result;
      setMessage("placed");
      break;
    }
    case "NotAllowed": {
      const e = result;
      setMessage(e.reason);
      break;
    }
  }
} };
```
::: end

Vue / Svelte / Angular / Feliz / Flutter emit the same try-match shape through their own reactivity primitives; Phoenix LiveView renders each variant as a `case` clause on the context function's `{:ok, _}` / `{:error, "Tag", _}` result. See [`../actions.md`](../actions.md) for the full contract and [UI pages](15-ui-pages-structure.md#state--derived--action) for `action` itself.

## Handler bodies — `commandHandler` / `queryHandler`

`[extern] commandHandler Name(params) [: Return] { … }` and `[extern] queryHandler Name(params): Return { … }` are context-level, application-layer handlers — a single-aggregate workflow `handle` lifted out, routable from an `api { route POST "/…" -> Ctx.Name }` body. Their body is the **workflow vocabulary** (`lower-workflow.ts`, see [Workflows](13-workflows.md#body-vocabulary)): `let x = Repo.getById(id)` / a single non-nullable `find`, an operation call on the binding, `Repo.delete(x)`, `precondition` / `requires`, `emit`, `return`. A loaded aggregate is saved automatically when an operation was invoked on it — you don't write the save. Gates: a non-`extern` handler needs a body (`loom.handler-missing-body`) and an `extern` one must be bodyless `;` (`loom.extern-handler-has-body`); a parameter may not be named `id` (`loom.handler-param-reserved-id`); a nullable load has no null-handling vocabulary (`loom.handler-load-nullable-unsupported` — use `getById`); a `queryHandler` may not mutate (`loom.query-handler-saves`) and a `commandHandler` touches one aggregate (`loom.command-handler-multi-aggregate`).

```ddd
context Accounts {
  aggregate Wallet {
    name: string
    operation rename(label: string) { name := label }
  }
  repository Wallets for Wallet { }
  commandHandler RenameWallet(walletId: Wallet id, name: string): Wallet {
    let w = Wallets.getById(walletId)
    w.rename(name)
    return w
  }
}
api LedgerApi from Core {
  route POST "/wallets/{walletId}/rename" -> Accounts.RenameWallet
}
```

::: tabs backend
== node
```ts
// http/ledgerApi-routes.ts — the routed handler body, save implied by the op-call
const w = await wallets.getById(walletId);
w.rename(name);
await wallets.save(w);
return httpCtx.json(wallets.toWire(w) as z.infer<typeof WalletResponse>, 200);
```
== dotnet
```csharp
// Application/Wallets/Commands/RenameWalletHandler.cs
public async ValueTask<Wallet> Handle(RenameWalletCommand command, CancellationToken cancellationToken)
{
    var w = await _wallets.GetByIdAsync(command.WalletId, cancellationToken)
        ?? throw new AggregateNotFoundException($"Wallet {command.WalletId} not found");
    w.Rename(command.Name);
    await _wallets.SaveAsync(w, cancellationToken);
    return w;
}
```
== java
```java
// application/workflows/RenameWalletHandler.java
public Wallet handle(WalletId walletId, String name) {
    var w = walletsRepository.getById(walletId);
    w.rename(name);
    walletsRepository.save(w);
    return w;
}
```
== python
```python
# app/application/rename_wallet.py
async def rename_wallet(session: AsyncSession, wallet_id: WalletId, name: str) -> dict[str, object]:
    wallets = WalletRepository(session, NoopDomainEventDispatcher())
    w = await wallets.get_by_id(wallet_id)
    w.rename(name)
    await wallets.save(w)
    return wallets.to_wire(w)
```
== elixir
```elixir
# lib/ex_api/accounts/handlers/rename_wallet.ex — the context's own operation
# function persists, so the handler only chains load → op
def run(params) when is_map(params) do
  %{"wallet_id" => wallet_id, "name" => name} = params
  with {:ok, w} <- Context.get_wallet(wallet_id),
       {:ok, _} <- Context.rename_wallet(w, %{"label" => name}) do
    {:ok, w}
  end
end
```
::: end

An `extern` handler keeps the routed dispatch but calls a scaffold-once, user-owned implementation file — see [Externs](21-externs.md) and [`../extern.md`](../extern.md#extern-application-layer-handlers-commandhandler--queryhandler). The scaffold macros `scaffoldApi` / `scaffoldHandlers` unfold this layer for you ([Macros](22-macros.md)).

## `for` & `if let` — workflow bodies only

`for x in xs { … }` and `if let x = Repo.find(C) { … } else { … }` parse via the same `Statement` rule but are meaningful only inside `workflow` (and handler) bodies — there they lower (`lower-workflow.ts`) to the `for-each` / `if-let` `WorkflowStmtIR` kinds with per-iteration / per-branch repository saves. The iterable is a `ForIterable` (a name plus optional postfix suffixes), so `for n in notes` parses but `for n in [1, 2]` does not.

The aggregate-body lowerer (`lower-stmt.ts`) has **no arm for either**, and nothing gates them there: an `operation touch() { for n in notes { owner := n } }` validates clean (`0 error(s), 0 warning(s)`) and the node backend then emits

```ts
public touch(): void {
  this.<unknown>();
  this._assertInvariants();
}
```

— source that does not compile. Don't write one there; they're covered in [Workflows](13-workflows.md).
