# 9. Payloads, records & unions

Loom's **transport layer** — the structurally-typed records that cross a boundary (HTTP, queue, internal call) rather than living as durable aggregate state. This chapter covers the five-keyword record family (`payload`/`command`/`query`/`response`/`error`), where a record is admitted as a type, discriminated unions in both surfaces (anonymous `A or B`, named `payload Foo = A | B`), the tagged `type` wire an operation return puts on the network, the *untagged* absence shape a union **find** uses instead, and how an `error` variant becomes an RFC-7807 ProblemDetails HTTP response. Reach for it when you need to know what JSON a union puts on the wire, why all five record keywords are interchangeable, or what status code an `error` maps to.

> **Grammar:** `PayloadDecl` (`kind=PayloadKind name=ID …`), `PayloadKind` (`payload`/`command`/`query`/`response`/`error`), `ApiStatus` (`httpStatus <Error> -> <code>`) · **Validators:** `loom.union-position`, `loom.union-duplicate-variant`, `loom.union-variant-not-carrier`, `loom.union-find-shape-unsupported`, `loom.generic-arg-not-carrier`, `loom.generic-position`, `loom.payload-name-conflict`, `loom.payload-duplicate-field`, `loom.unmapped-error-status`, `loom.reserved-structural-error-name` (dormant platform nets: `loom.union-unsupported`, `loom.generic-carrier-unsupported`) · **Docs:** [`../payloads.md`](../payloads.md), [generic carriers](04-type-system.md#generic-carriers--paged-envelope-option), [handlers](03-domain-modeling.md#commandhandler--queryhandler)

Aggregates are nominal state machines; **payloads are structurally-typed records**. The two ladders coexist — reach for an `aggregate` when you have durable, identified state with behaviour; reach for a payload when you have a shape that only flows across a wire. All examples below are generated from one scratch `system` (`Orders` context) once per backend pin; output is excerpted.

## Record forms — the five intents

A payload is a flat record of `Property` fields. Five keywords (`PayloadKind`) declare one; they share **one structural wire contract** and differ only in documented intent — `command` for a write request, `query` for a read request, `response` for a reply, `error` for a failure shape, `payload` for everything else. The grammar is identical (`kind=PayloadKind name=ID '{' fields* '}'`); the keyword is a label, not a different shape.

```ddd
payload  Address      { line1: string  city: string  postcode: string }
command  PlaceOrder   { code: string   region: string }
query    OrderSearch  { region: string }
response OrderSummary { ref: string    total: money }
error    NotFound     { resource: string }
```

`event` is the sixth member of the family — it keeps its own declaration surface but unifies into the same payload view at the IR layer. Payload names share one namespace per context with value objects and events (`loom.payload-name-conflict`); a repeated field name is `loom.payload-duplicate-field`.

### Where a record resolves as a type

A payload (named union included) is offered as a **type** only in a *transport position*: a workflow `create`/`handle` command parameter, a `commandHandler` / `queryHandler` parameter or return, a variant of an inline `or` union, or a generic-carrier argument (`Address paged`). It is **not** admissible by name as an aggregate field type, a repository `find` return, or an `operation` return — the scope provider (`src/language/ddd-scope.ts`) keeps transport records out of those positions, and the reference fails to link ("Could not resolve reference to NamedDecl named 'Address'"). An `error` still reaches an operation or find return as a **variant** of an inline union (`string or OutOfStock`), which is the shape the rest of this chapter builds on.

> **Honest gap:** a free-standing payload that no transport position references (e.g. `Address` above) materializes **no DTO** in the generated backend — it appears in neither the emitted source nor `.loom/wire-spec.json`. Records reach the wire only when something puts them on a boundary.

### Record params to handlers

The application-layer `commandHandler` / `queryHandler` pair (owned by [chapter 3](03-domain-modeling.md#commandhandler--queryhandler), bound to HTTP by `route` in [chapter 14](14-apis-storage-resources-channels.md#api)) is the place a `command` / `query` record is consumed by name — the record's fields become the request body, and the handler reads them off the parameter:

```ddd
commandHandler Place(cmd: PlaceOrder): Order id {
  let o = Order.create({ code: cmd.code, region: cmd.region })
  return o.id
}
api A from D { route POST "/place" -> Orders.Place }
```

::: tabs backend
== node
```ts
// http/a-routes.ts — the record IS the body schema; the save is implicit at exit
request: { body: { content: { "application/json": { schema: z.object({ code: z.string(), region: z.string() }) } } } },
// …
const cmd = { code: body.code, region: body.region };
const o = Order.create({ code: cmd.code, region: cmd.region });
await orders.save(o);
return httpCtx.json(o.id as unknown, 200);
```
== dotnet
```csharp
// Application/Orders/Commands/PlaceCommand.cs + PlaceHandler.cs (Mediator)
public sealed record PlaceCommand(string Code, string Region) : ICommand<OrderId>;
public async ValueTask<OrderId> Handle(PlaceCommand command, CancellationToken cancellationToken)
{
    var o = Order.Create(code: command.Code, region: command.Region);
    await _orders.SaveAsync(o, cancellationToken);
    return o.Id;
}
```
== java
```java
// application/workflows/PlaceHandler.java
public OrderId handle(String code, String region) {
    var o = Order.create(code, region);
    ordersRepository.save(o);
    return o.id();
}
```
== python
```python
# app/application/place.py
async def place(session: AsyncSession, code: str, region: str) -> OrderId:
    orders = OrderRepository(session, NoopDomainEventDispatcher())
    o = Order.create(code=code, region=region)
    await orders.save(o)
    return o.id
```
== elixir
```elixir
# lib/d/orders/handlers/place.ex
def run(params) when is_map(params) do
  %{"code" => code, "region" => region} = params
  with {:ok, o} <- Context.create_order(%{code: code, region: region}) do
    {:ok, o.id}
  end
end
```
::: end

Do not write `Orders.save(o)` in the body — the exit save is derived (`computeSaves`), and an explicit repository write verb in a handler statement is lowered as a repository **delete** (see the note in [`../workflow.md`](../workflow.md)). A record parameter always binds to the JSON body, so bind record-param handlers to `POST`/`PUT`/`PATCH` routes.

### `<Agg>Wire` — the auto-synthesized record

Every aggregate, part, and value object carries a canonical ordered `wireShape` (`id` → declared properties, including the spliced `version` token → containments → derived), synthesized once in enrichment (phase ⑥). Every backend's DTO emitter walks the *same* list, so the JSON an aggregate takes on the network is identical across all five backends by construction. This is the shape a union variant or a carrier argument projects through when it names an aggregate — `OrderResponse` below is the `Order` aggregate's wire record.

## Anonymous union — `A or B`

A union is a value that is **one of several distinct variants**. The inline form needs no declaration — write `A or B` directly in a transport position: an `operation` return, a repository `find` return (in the constrained *absence* shape — next section), or a payload field. `A or B or C` flattens to one variant set; `or` is associative-commutative, so an anonymous union is **structural on its variants** (`A or B` ≡ `B or A`). An inline `or` anywhere else (an aggregate field, say) is rejected with `loom.union-position`; a repeated variant (`A or A`) with `loom.union-duplicate-variant`; a non-carrier variant (a `slot`) with `loom.union-variant-not-carrier`.

An **operation return** is the tagged case — the producer picks the variant, so the wire carries a **`type` discriminator**. A record variant (an aggregate → its `<Agg>Wire`, a payload/event → its fields) flattens its fields alongside `type`; a scalar variant is wrapped as `{ type, value }`; the tag is the variant type's name:

```ddd
error OutOfStock { sku: string }
aggregate Order with crudish {
  code: string
  region: string
  operation reserve(sku: string): string or OutOfStock {
    return OutOfStock { sku: sku }
  }
}
```

::: tabs backend
== node
```ts
// http/order.routes.ts — z.discriminatedUnion keyed on "type"
export const stringOrOutOfStock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string() }),
  z.object({ type: z.literal("OutOfStock"), sku: z.string() }),
]).openapi("stringOrOutOfStock");
// domain/order.ts — the body returns the tagged value
public reserve(sku: string): ({ type: "string"; value: string } | { type: "OutOfStock"; sku: string }) {
  return { type: "OutOfStock", ...(({ sku: sku })) };
}
```
== dotnet
```csharp
// Application/Orders/Responses/stringOrOutOfStock.cs
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(stringOrOutOfStock_string), "string")]
[JsonDerivedType(typeof(stringOrOutOfStock_OutOfStock), "OutOfStock")]
public abstract record stringOrOutOfStock;

public sealed record stringOrOutOfStock_string([property: Required] string Value) : stringOrOutOfStock;
public sealed record stringOrOutOfStock_OutOfStock([property: Required] string Sku) : stringOrOutOfStock;
```
== java
```java
// features/orders/stringOrOutOfStockResponse.java — sealed interface + Jackson polymorphism
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = stringOrOutOfStockResponse_string.class, name = "string"),
    @JsonSubTypes.Type(value = stringOrOutOfStockResponse_OutOfStock.class, name = "OutOfStock")
})
public sealed interface stringOrOutOfStockResponse permits stringOrOutOfStockResponse_string, stringOrOutOfStockResponse_OutOfStock {}
public record stringOrOutOfStockResponse_string(String value) implements stringOrOutOfStockResponse {}
public record stringOrOutOfStockResponse_OutOfStock(String sku) implements stringOrOutOfStockResponse {}
```
== python
```python
# app/domain/order.py — a tagged dict
def reserve(self, sku: str) -> dict[str, object]:
    return {"type": "OutOfStock", **{"sku": sku}}
```
== elixir
```elixir
# lib/d_web/controllers/order_controller.ex — one clause per variant
def reserve_order_result(conn, {:ok, success}), do: json(conn, success)
def reserve_order_result(conn, {:error, "OutOfStock", data}),
  do: problem_variant(conn, 409, "/errors/out-of-stock", "Out Of Stock", data)
```
::: end

So whatever the host-language representation — a Zod discriminated union, a `JsonPolymorphic` C# base, a Jackson sealed interface, or a tagged dict — the success JSON is the same: `{ "type": "string", "value": "…" }`. The error variant does not ride the tagged wire at all: it becomes a ProblemDetails response (below).

## Union finds — the untagged exception

A repository `find` may return a union, but only in the constrained **absence** shape: exactly two variants, the repository's own aggregate plus one absent variant — `none` (spelled `Order option`) or an `error` payload carrying at most `resource: string`. Anything else is `loom.union-find-shape-unsupported`.

```ddd
error NotFound { resource: string }
repository Orders for Order {
  find byCode(code: string): Order or NotFound where this.code == code
  find maybe(code: string):  Order option     where this.code == code
}
```

This is **not** the tagged wire: the hit is returned directly as `OrderResponse` at `200`, and the miss rides its own status — an `error` variant → its mapped ProblemDetails status with `resource` filled in, `none` → a bare 404. There is no `type` discriminator and no `oneOf` in the OpenAPI schema, so a union find is wire-identical to `Order?`. All five backends agree:

::: tabs backend
== node
```ts
// http/order.routes.ts
responses: { 200: { … schema: OrderResponse }, 404: { … "application/problem+json": { schema: ProblemDetails } } },
// byCode — the error variant
const result = await repo.byCode(params.code);
if (result == null) {
  return c.json({ resource: "Order", type: "/errors/not-found", title: "Not Found", status: 404, detail: "Not Found", instance: c.req.path }, 404, { "content-type": "application/problem+json" });
}
return c.json(repo.toWire(result) as z.infer<typeof OrderResponse>, 200);
// maybe — the `none` variant
if (result == null) throw new AggregateNotFoundError("not_found");
```
== dotnet
```csharp
// Api/OrdersController.cs
public async Task<ActionResult<OrderResponse>> ByCodeOrder([FromQuery] string code)
{
    var result = await _mediator.Send(new ByCodeQuery(code));
    if (result is null)
    {
        var problem = new ProblemDetails { Status = 404, Title = "Not Found", Type = "/errors/not-found", Detail = "Not Found", Instance = HttpContext.Request.Path };
        return new ObjectResult(problem) { StatusCode = 404, ContentTypes = { "application/problem+json" } };
    }
    // …Ok(OrderResponse)
}
```
== java
```java
// features/orders/OrdersController.java
public ResponseEntity<?> byCodeOrder(@RequestParam String code) {
    var r = service.byCode(code);
    if (r == null) {
        var problem = ProblemDetail.forStatus(404);
        // title / type / detail / resource extension …
        return ResponseEntity.status(404).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem);
    }
    // …ResponseEntity.ok(OrderResponse)
}
```
== python
```python
# app/http/order_routes.py
@router.get("/by_code", response_model=OrderResponse, operation_id="byCodeOrder", responses={404: {"model": ProblemDetails, …}})
async def by_code_orders(code: str, request: Request, session: SessionDep):
    if (found := await repo.by_code(code)) is None:
        return JSONResponse(
            {"resource": "Order", "type": "/errors/not-found", "title": "Not Found", "status": 404, "detail": "Not Found", "instance": request.url.path},
            status_code=404, media_type="application/problem+json")
    return repo.to_wire(found)
```
== elixir
```elixir
# lib/d_web/controllers/order_controller.ex
def by_code(conn, params) do
  case Orders.by_code_order(params["code"]) do
    {:ok, nil} -> problem_variant(conn, 404, "/errors/not-found", "Not Found", %{resource: "Order"})
    # {:ok, record} -> json(conn, serialize(record))
  end
end
def maybe(conn, params) do
  case Orders.maybe_order(params["code"]) do
    {:ok, nil} -> ProblemDetails.problem_response(conn, 404, "Not Found", "not_found")
    # …
  end
end
```
::: end

> **Why the split.** A find's absent case is an *edge* (the row wasn't there), not a domain-modelled alternative the producer chose — so it belongs at a status code, exactly like an optional find's miss. An operation return is producer-selected variant data, so it carries the tag.

## Named union — `payload Foo = A | B`

The named form declares the variant set up front with identity **by name** (nominal — unlike the structural anonymous form). Use `=` and `|` (the `PayloadDecl` `'=' variants+=TypeAtom ('|' variants+=TypeAtom)*` arm):

```ddd
payload OrderEvent = OrderPlaced | OrderCancelled
```

It lowers to one `PayloadIR` with `variants` (no fields) and rides the same union machinery as `A or B`, so a consumer that receives it sees the identical tagged wire (`{ "type": "OrderPlaced", … }`). A repeated variant (`payload F = A | A`) is `loom.union-duplicate-variant`. Its reach is that of any payload (§[Where a record resolves](#where-a-record-resolves-as-a-type)): a named union is admitted as a **variant of an inline union** (`OrderEvent or string`) and in a **handler contract**, but not by bare name as a field type, a `find` return, or an `operation` return — those positions do not resolve it. Like any unreferenced record it emits no DTO until a transport position names it.

### `option` — `T option` is `T or none`

`T option` is the third blessed postfix carrier — sugar for the 2-variant union `union[T, none]`, flowing through the same union path (not the nullable `T?` field path). On a **find** it is the untagged absence shape above (`maybe` → 404); as a payload field or operation return the `none` unit serializes bare: `{ "type": "none" }`. The full `paged` / `envelope` / `option` carrier surface, including the discriminated `option` output across backends, lives in [The type system → generic carriers](04-type-system.md#generic-carriers--paged-envelope-option).

## `error` & `httpStatus` — exception-less ProblemDetails

A domain `error` record is **HTTP-blind** — it carries no status code. The api edge is the only place an error becomes an HTTP response, and the translation is exception-less: an operation that returns its error variant, or a union find that misses, is mapped at the controller boundary to an RFC-7807 `application/problem+json` body — no thrown exception. The status comes from a stdlib default table (`src/util/error-defaults.ts`):

| Error name | Default status | | Error name | Default status |
|---|---|---|---|---|
| `NotFound` | 404 | | `Forbidden` | 403 |
| `ParseError` | 400 | | `ValidationError` / `DomainError` | 422 |
| `TransportFailure` / `UnexpectedStatus` / `DeserializeError` | 502 | | `UniquenessConflict` / `ConcurrencyConflict` / `Disallowed` / `ReferencedInUse` | 409 |
| *(any other, user-declared)* | 500 → `loom.unmapped-error-status` | | | |

The four 409 names are the **structural-conflict built-ins** the framework raises itself (a tripped `unique (…)`, an optimistic-lock miss, a `when` state gate, an FK `RESTRICT`); declaring an `error` with one of those names shadows the framework's status and is `loom.reserved-structural-error-name`.

The RFC-7807 fields are derived from the name: `title` is the prettified name (`OutOfStock` → `"Out Of Stock"`), `type` is `/errors/<kebab-name>` (`/errors/out-of-stock`), and the error record's own fields become problem extensions. A `httpStatus <Error> -> <Code>` clause on the `api` overrides the default; a user-declared error with no stdlib match and no override falls through to 500 and warns.

```ddd
api A from D {
  httpStatus OutOfStock -> 409
}
```

For the `reserve(): string or OutOfStock` above, the error variant becomes a `409` ProblemDetails carrying `sku` as an extension — identical on every backend:

::: tabs backend
== node
```ts
// http/order.routes.ts — the reserve handler
const result = aggregate.reserve(body.sku);
await repo.save(aggregate);
if (result.type === "OutOfStock") {
  return c.json({ ...result, type: "/errors/out-of-stock", title: "Out Of Stock", status: 409, detail: "Out Of Stock", instance: c.req.path }, 409, { "content-type": "application/problem+json" });
}
return c.json(result, 200);
```
== dotnet
```csharp
// Api/OrdersController.cs
switch (result)
{
    case D.Domain.Orders.stringOrOutOfStock_string v:
        return new ObjectResult((Responses.stringOrOutOfStock)new Responses.stringOrOutOfStock_string(v.Value)) { StatusCode = 200, … };
    case D.Domain.Orders.stringOrOutOfStock_OutOfStock v:
        var problem = new ProblemDetails { Status = 409, Title = "Out Of Stock", Type = "/errors/out-of-stock", Detail = "Out Of Stock", Instance = HttpContext.Request.Path };
        // problem.Extensions["sku"] = v.Sku;
        return new ObjectResult(problem) { StatusCode = 409, ContentTypes = { "application/problem+json" } };
}
```
== java
```java
// features/orders/OrdersController.java
return switch (result) {
    case stringOrOutOfStock_string v ->
        ResponseEntity.ok((stringOrOutOfStockResponse) new stringOrOutOfStockResponse_string(v.value()));
    case stringOrOutOfStock_OutOfStock v -> {
        var problem = ProblemDetail.forStatus(409);
        // title / type / detail / sku extension …
        yield ResponseEntity.status(409).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem);
    }
};
```
== python
```python
# app/http/order_routes.py
result = found.reserve(body.sku)
if result["type"] == "OutOfStock":
    return JSONResponse(
        {**result, "type": "/errors/out-of-stock", "title": "Out Of Stock", "status": 409, "detail": "Out Of Stock", "instance": request.url.path},
        status_code=409, media_type="application/problem+json")
```
== elixir
```elixir
# lib/d_web/controllers/order_controller.ex
def reserve_order_result(conn, {:error, "OutOfStock", data}),
  do: problem_variant(conn, 409, "/errors/out-of-stock", "Out Of Stock", data)

defp problem_variant(conn, status, type, title, data) do
  # merges `data` (the error's fields) into
  # %{type: type, title: title, status: status, detail: title, instance: conn.request_path}
  |> put_resp_content_type("application/problem+json")
end
```
::: end

All five backends emit the identical `application/problem+json` body — `{ "type": "/errors/out-of-stock", "title": "Out Of Stock", "status": 409, "detail": "Out Of Stock", "sku": "…" }` — derived from one defaults table, with the error's fields carried through as problem extensions.

## Producer-side boundary

A union's *wire contract* — its DTO/schema and the tagged serialization — is fully generated and identical across backends. Who selects the variant differs by surface:

- **Union finds** are fully derived — presence → the aggregate at `200`, absence → the `none`/`error` status. No stub.
- **Operation returns** (`reserve(): string or OutOfStock`) are producer-selected: the domain body returns the variant it chose, and the route maps it to the tagged wire (success) or a ProblemDetails (error). Shipped on all five backends.

Still deferred: `match` over a union with exhaustiveness narrowing on the consumer side, `option` PATCH semantics, user-declared generics beyond `paged` / `envelope` / `option` — see [`../payloads.md`](../payloads.md) § "What's deferred".
