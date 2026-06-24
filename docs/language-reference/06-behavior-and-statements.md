# 6. Behavior & statements

How an aggregate changes state: the four action members — `operation` (a mutating method), `create` / `destroy` (lifecycle factory / terminator), and the event-sourcing `apply` fold — plus the statement vocabulary their bodies share (`precondition`, `requires`, `let`, `emit`, `return`, and the assignment family `:=` / `+=` / `-=`). Reach for it when you need a domain method that validates, mutates, raises an event, or returns a typed outcome.

> **Grammar:** `Operation`, `Create`, `Destroy`, `Apply`, `Statement` (`PreconditionStmt`, `RequiresStmt`, `LetStmt`, `EmitStmt`, `ReturnStmt`, `AssignOrCallStmt`; `ForStmt` / `IfLetStmt` are workflow-body only — see [Workflows](13-workflows.md)) · **Lowering:** [`src/ir/lower/lower-stmt.ts`](../../src/ir/lower/lower-stmt.ts), `lower-members.ts` · **Docs:** [`../language.md`](../language.md), [`../workflow.md`](../workflow.md)

Every body lowers through one shared `lowerStatement`, so an `operation`, a `create`, a `destroy`, and an `apply` all draw from the same statement set; the **kind tag** (not the body syntax) carries the lifecycle asymmetry. Each backend's `render-stmt.ts` turns the lowered `StmtIR` into source — the per-tab output below is exactly what those emitters produce.

> **Output sourcing.** The `dotnet` tabs are excerpted byte-for-byte from the committed baseline fixture (`test/fixtures/baseline-output/`, captured from `examples/acme.ddd`). The remaining backend tabs are transcribed from the deterministic per-backend `render-stmt.ts` / aggregate emitters (the statement renderers are pure string templating — no hidden state), cross-checked against the `dotnet` baseline. Where a backend's emitted shape genuinely differs (Elixir's Ecto changesets, Python's `dict` union returns), that divergence is the content.

## `operation` — a mutating method

`operation name(params) [extern] [audited] [: ReturnType] [when Guard] { body }`. A public method on the aggregate root that mutates `this`; `private operation` keeps it off the HTTP surface (callable only from another op via a bare `name(args)` call). The body runs, then the framework asserts invariants on the way out.

```ddd
context Orders {
  enum OrderStatus { Draft, Confirmed }
  event OrderConfirmed { order: Order id, at: datetime }

  aggregate Order with crudish {
    customerId: string
    status: OrderStatus
    contains lines: OrderLine[]

    invariant lines.count > 0 when status == Confirmed
    function isMutable(): bool = status == Draft

    operation confirm() {
      precondition isMutable()
      precondition lines.count > 0
      status := Confirmed
      emit OrderConfirmed { order: id, at: now() }
    }

    entity OrderLine { productId: Product id, quantity: int }
  }
}
```

The body becomes a method whose statements emit in order, capped by the invariant assertion.

::: tabs backend
== dotnet
```csharp
// Domain/Orders/Order.cs
public void Confirm()
{
    if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
    if (!(this.Lines.Count > 0)) throw new DomainException("Precondition failed: lines.count > 0");
    Status = OrderStatus.Confirmed;
    _domainEvents.Add(new OrderConfirmed(Order: this.Id, At: DateTime.UtcNow));
    AssertInvariants();
}
```
== node
```ts
// domain/order.ts
public confirm(): void {
    if (!(this.isMutable())) throw new DomainError("Precondition failed: isMutable()");
    if (!(this._lines.length > 0)) throw new DomainError("Precondition failed: lines.count > 0");
    this._status = OrderStatus.Confirmed;
    this._events.push({ type: "OrderConfirmed", order: this.id, at: new Date() });
    this._assertInvariants();
}
```
== java
```java
// Order.java
public void confirm() {
    if (!(this.isMutable())) throw new DomainException("Precondition failed: isMutable()");
    if (!(this.lines.size() > 0)) throw new DomainException("Precondition failed: lines.count > 0");
    this.status = OrderStatus.Confirmed;
    this._domainEvents.add(new OrderConfirmed(this.id, java.time.OffsetDateTime.now()));
    assertInvariants();
}
```
== python
```python
# domain/order.py
def confirm(self) -> None:
    if not (self._is_mutable()):
        raise DomainError("Precondition failed: isMutable()")
    if not (len(self._lines) > 0):
        raise DomainError("Precondition failed: lines.count > 0")
    self._status = OrderStatus.Confirmed
    self._events.append(OrderConfirmed(order=self.id, at=now()))
    self._assert_invariants()
```
== elixir
```elixir
# Context function body — statements fold onto an Ecto.Changeset,
# preconditions raise, the assignment becomes put_change, and the
# event is broadcast over Phoenix.PubSub.
if not (is_mutable(record)), do: raise(ArgumentError, "Precondition failed: isMutable()")
if not (length(record.lines) > 0), do: raise(ArgumentError, "Precondition failed: lines.count > 0")
changeset = Ecto.Changeset.put_change(changeset, :status, :confirmed)
Phoenix.PubSub.broadcast(Orders.PubSub, "events", %Orders.Events.OrderConfirmed{order: record.id, at: DateTime.utc_now()})
```
::: end

Modifiers: `extern` emits a `check<Op>(...)` that runs only the preconditions and hands the business decision to a user-registered handler (see [Extern](../extern.md)); `audited` records an audit entry around the call (see [`../capabilities.md`](../capabilities.md)). A `private operation` is invoked from another op as a bare call — `recompute()` lowers to `this.recompute()` (TS/.NET/Java), `self._recompute()` (Python).

## Guards — `precondition` (400) vs `requires` (403) vs `when` (409)

Three distinct gates, three distinct HTTP failures. They type identically (each is a `bool` expression) but lower to different throws so the route layer maps them to different statuses.

| Clause | Means | Throws | HTTP |
|---|---|---|---|
| `precondition Expr` | domain validity of the arguments/state | `DomainError` / `DomainException` | **400** Bad Request |
| `requires Expr` | the caller is authorized | `ForbiddenError` / `ForbiddenException` | **403** Forbidden |
| `when Expr` (op header) | the aggregate is in a state that admits this op | `DisallowedError` | **409** Conflict |

```ddd
aggregate Order ids guid {
  status: Status
  operation addLine(price: money, isStaff: bool) when status == Status.Draft {
    requires isStaff
    precondition price > money("0.00")
    // …
  }
}
```

`precondition` and `requires` are body statements; `when` is on the operation header. The body order is `requires` → `precondition` → rest, so a 403 wins over a 400 when both would fail.

::: tabs backend
== dotnet
```csharp
// Domain/Orders/Order.cs — body statements
if (!(isStaff)) throw new ForbiddenException("Forbidden: isStaff");
if (!(price > Money.Parse("0.00"))) throw new DomainException("Precondition failed: price > money(\"0.00\")");
```
== node
```ts
// domain/order.ts — body statements
if (!(isStaff)) throw new ForbiddenError("Forbidden: isStaff");
if (!(price.gt(new Decimal("0.00")))) throw new DomainError("Precondition failed: price > money(\"0.00\")");
```
== java
```java
// Order.java — body statements
if (!(isStaff)) throw new ForbiddenException("Forbidden: isStaff");
if (!(price.compareTo(new java.math.BigDecimal("0.00")) > 0)) throw new DomainException("Precondition failed: price > money(\"0.00\")");
```
== python
```python
# domain/order.py — body statements
if not (is_staff):
    raise ForbiddenError("Forbidden: isStaff")
if not (price > Decimal("0.00")):
    raise DomainError("Precondition failed: price > money(\"0.00\")")
```
== elixir
```elixir
# Context function — both raise ArgumentError; the controller maps the message
if not (is_staff), do: raise(ArgumentError, "Forbidden: isStaff")
if not (Decimal.compare(price, Decimal.new("0.00")) == :gt), do: raise(ArgumentError, "Precondition failed: price > money(\"0.00\")")
```
::: end

The route layer turns each throw into RFC-7807 `application/problem+json`. On the Hono backend the `app.onError` handler checks `ForbiddenError` **before** `DomainError` (so 403 wins over 400) and `DisallowedError` maps to 409:

```ts
// http/routes/orders.ts — generated onError
if (err instanceof ForbiddenError)        return problem(403, "Forbidden", err.message);
if (err instanceof DisallowedError)       return problem(409, "Disallowed", err.message);
if (err instanceof DomainError)           return problem(400, "Bad Request", err.message);
if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);
```

### `when` also auto-exposes `GET /{id}/can_<op>`

A `when`-gated operation gets a free, side-effect-free companion route returning `{ allowed }` so a UI can enable/disable the action without invoking it (the canCommand pattern). For `operation addLine(...) when status == Status.Draft`:

```ts
// http/routes/orders.ts — auto-emitted alongside the addLine route
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/can_add_line",
    tags: ["orders"],
    operationId: "ordersCanAddLine",
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

The same predicate is also evaluated inside the mutating route before the body runs; false there throws `DisallowedError` → 409. See [`../criterion.md`](../criterion.md) for `when`'s relationship to reusable criteria.

## `let` & `emit`

`let name = Expr` binds a local; `emit Event { field: value, … }` records a domain event. Field names re-quote and re-case per backend; emit-field order is normalized to the event's declared field order on positional-constructor backends (Java/.NET).

```ddd
operation addLine(price: money) {
  let next = subtotal + price
  subtotal := next
  emit LinePriced { order: id, total: next }
}
```

::: tabs backend
== dotnet
```csharp
var next = Subtotal + price;
Subtotal = next;
_domainEvents.Add(new LinePriced(Order: this.Id, Total: next));
```
== node
```ts
const next = this._subtotal.plus(price);
this._subtotal = next;
this._events.push({ type: "LinePriced", order: this.id, total: next });
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
self._events.append(LinePriced(order=self.id, total=next))
```
== elixir
```elixir
next = Decimal.add(record.subtotal, price)
changeset = Ecto.Changeset.put_change(changeset, :subtotal, next)
Phoenix.PubSub.broadcast(Orders.PubSub, "events", %Orders.Events.LinePriced{order: record.id, total: next})
```
::: end

On an event-sourced aggregate (`persistedAs(eventLog)`), `emit` does **double duty** — it records the event *and* folds it immediately via `_apply`, so the in-memory aggregate reflects the transition before the command returns. There, command bodies may *only* `emit`; the state change lives in the `apply` block (next section). On the Hono/.NET backends the event-sourced `emit` becomes `{ const __ev = …; this._events.push(__ev); this._apply(__ev); }` / `{ var __ev = …; _domainEvents.Add(__ev); _Apply(__ev); }`.

## Assignment — `:=`, `+=`, `-=`

`target := Expr` is scalar assignment; `target += Expr` / `target -= Expr` are collection append / remove. A numeric/decimal literal flowing into a `money` target is elaborated to the precise money constructor at lowering (`subtotal := 0.50` → `money("0.50")`).

```ddd
aggregate Order ids guid {
  status: Status
  notes: string[]
  contains lines: OrderLine[]

  operation addNote(text: string) {
    status := Status.Placed     // scalar
    notes  += text              // collection append
    notes  -= "draft"           // collection remove
  }
}
```

::: tabs backend
== dotnet
```csharp
Status = Status.Placed;
_notes.Add(text);
_notes.Remove("draft");
```
== node
```ts
this._status = Status.Placed;
this._notes.push(text);
{ const idx = this._notes.findIndex((e) => e === ("draft")); if (idx >= 0) this._notes.splice(idx, 1); }
```
== java
```java
this.status = Status.Placed;
this.notes.add(text);
this.notes.remove("draft");
```
== python
```python
self._status = Status.Placed
self._notes.append(text)
__rm = "draft"
if __rm in self._notes:
    self._notes.remove(__rm)
```
== elixir
```elixir
# Ecto: scalar → put_change; collection ops → put_assoc on the loaded list
changeset = Ecto.Changeset.put_change(changeset, :status, :placed)
changeset = Ecto.Changeset.put_assoc(changeset, :notes, record.notes ++ [text])
changeset = Ecto.Changeset.put_assoc(changeset, :notes, record.notes -- ["draft"])
```
::: end

`+=` / `-=` on a `contains` collection append/remove an entity part; on an `Id<T>[]` reference collection they attach/detach a target id (Elixir uses `manage_relationship` with `type: :append` / `:remove` and `use_identities: [:id]`).

## `create` / `destroy` — lifecycle actions

`create [name](params) { body }` is a factory: the body populates a pre-bound fresh `this`, and the framework owns allocate-id → persist → return. An **unnamed** `create(...)` is the aggregate's canonical creator (routed to the bare collection `POST`); a **named** `create quote(...)` is an additional factory. `destroy [name][(params)] { body }` is the terminator — the instance is loaded by id, the body runs (cleanup / soft-delete state), then the framework removes it; a body that throws aborts removal. Both accept `audited`. Neither is ever `private` or `extern`.

```ddd
aggregate Order ids guid {
  status: Status
  subtotal: money

  create(buyer: string) {
    status := Status.Draft
    subtotal := money("0.00")
  }

  destroy {
    status := Status.Cancelled
  }
}
```

The create body's statements run inside the static factory; `destroy`'s run before removal.

::: tabs backend
== dotnet
```csharp
// canonical create — static factory, body populates the fresh instance
public static Order Create(string buyer)
{
    var e = new Order();
    e.Status = Status.Draft;
    e.Subtotal = Money.Parse("0.00");
    e.AssertInvariants();
    return e;
}

// destroy body runs before the repository removes the row
public void Destroy()
{
    Status = Status.Cancelled;
}
```
== node
```ts
// canonical create — static factory
static create(input: { buyer: string }): Order {
    const e = new Order(/* … */);
    e._status = Status.Draft;
    e._subtotal = new Decimal("0.00");
    e._assertInvariants();
    return e;
}

destroy(): void {
    this._status = Status.Cancelled;
}
```
::: end

> Honest gap: the Java / Python / Elixir lifecycle-action emitters follow the same precondition/assignment statement rendering shown above (identical `render-stmt.ts` output), wrapped in each backend's factory shape; they are not re-excerpted here to avoid transcribing the surrounding boilerplate that isn't statement output.

## `apply(e: Event)` — the event-sourcing fold

On a `persistedAs(eventLog)` aggregate, `apply(e: SomeEvent) { body }` is the fold that turns an emitted event into state. Applier bodies are **pure folds** — assignments and derivations only, no `emit` and no side-effecting calls. The command bodies decide and `emit`; the appliers own the actual state transition. (`apply` lowers to its own `ApplyIR` and never joins `agg.operations`.)

```ddd
aggregate Account ids guid persistedAs(eventLog) {
  owner: string
  balance: int

  create open(owner: string) {
    emit Opened { account: id, owner: owner }
  }

  operation deposit(amount: int) {
    precondition amount > 0
    emit Deposited { account: id, amount: amount }
  }

  apply(e: Opened)    { owner := e.owner; balance := 0 }
  apply(e: Deposited) { balance := balance + e.amount }
}
```

Each applier becomes a private `_apply<Event>` method; a `_apply` dispatcher switches on the event tag; a `_fromEvents` rehydrator folds a stream from an empty shell on load.

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
    const inst = Account._create({ id } as unknown as Account.State);
    for (const ev of events) inst._apply(ev);
    return inst;
}
```
== dotnet
```csharp
// Domain/Accounts/Account.cs — one _Apply<Event> per applier + a dispatcher
private void _ApplyOpened(Opened e)
{
    Owner = e.Owner;
    Balance = 0;
}

private void _ApplyDeposited(Deposited e)
{
    Balance = Balance + e.Amount;
}

private void _Apply(IDomainEvent ev)
{
    switch (ev)
    {
        case Opened e: _ApplyOpened(e); break;
        case Deposited e: _ApplyDeposited(e); break;
    }
}
```
::: end

The full runnable example is [`examples/event-sourcing.ddd`](../../examples/event-sourcing.ddd). See [`../workflow.md`](../workflow.md) §"Member forms" for the applier discipline and how the event log persists.

## `return` — the exception-less outcome

`operation foo(): X or Error { … return … }` declares an `or`-union return; instead of throwing, the body returns a designed-in outcome that the route translates — an error variant to an RFC-7807 status, a success variant to 200. Each `return` is tagged at lowering with the variant whose structural shape matches the returned value.

```ddd
context Orders {
  error NotAllowed { reason: string }
  aggregate Order ids guid {
    status: Status
    operation place(): Order or NotAllowed {
      precondition status == Status.Draft
      return NotAllowed { reason: "already placed" }
    }
  }
}
```

::: tabs backend
== dotnet
```csharp
// Domain/Orders/Order.cs — constructs the union variant record <Union>_<Tag>(…)
public OrderOrNotAllowed Place()
{
    if (!(this.Status == Status.Draft)) throw new DomainException("Precondition failed: status == Status.Draft");
    return new OrderOrNotAllowed_NotAllowed(reason: "already placed");
}
```
== node
```ts
// domain/order.ts — record variant flattens beside the `type` tag on the wire
place(): OrderOrNotAllowed {
    if (!(this._status === Status.Draft)) throw new DomainError("Precondition failed: status == Status.Draft");
    return { type: "NotAllowed", reason: "already placed" };
}
```
== java
```java
// Order.java — variant record, args ordered by the variant's declared fields
public OrderOrNotAllowed place() {
    if (!(this.status == Status.Draft)) throw new DomainException("Precondition failed: status == Status.Draft");
    return new OrderOrNotAllowed_NotAllowed("already placed");
}
```
== python
```python
# domain/order.py — dict carrying the same wire keys (variant classes pending)
def place(self) -> object:
    if not (self._status == Status.Draft):
        raise DomainError("Precondition failed: status == Status.Draft")
    return {"type": "NotAllowed", "reason": "already placed"}
```
== elixir
```elixir
# Elixir has no `return` — the value is the last expression of the body.
if not (record.status == :draft), do: raise(ArgumentError, "Precondition failed: status == Status.Draft")
%Orders.Events.NotAllowed{reason: "already placed"}
```
::: end

A record variant flattens its fields beside `type` on the wire; a scalar variant wraps a `value`; a `none` variant is the bare `{ type: … }`. See [Payloads & unions](09-payloads-and-unions.md) for the union wire shape and [`../language.md`](../language.md) §"Exception-less returns".

## `for` & `if let` — workflow bodies only

`for x in xs { … }` and `if let x = Repo.find(C) { … } else { … }` parse via the same `Statement` rule but are meaningful only inside `workflow` bodies — there they lower (`lower-workflow.ts`) to `for-each` / `if-let` IR with per-iteration / per-branch repository saves. The aggregate-body lowerer (`lower-stmt.ts`) has no arm for them, so they have no effect in an `operation` / `create` / `destroy` / `apply` body. They're covered in [Workflows](13-workflows.md).
