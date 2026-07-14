# 9. Payloads, records & unions

Loom's **transport layer** — the structurally-typed records that cross a boundary (HTTP, queue, internal call) rather than living as durable aggregate state. This chapter covers the five-keyword record family (`payload`/`command`/`query`/`response`/`error`), discriminated unions in both surfaces (anonymous `A or B`, named `payload Foo = A | B`), the tagged `type` wire they all share, and how an `error` variant becomes an RFC-7807 ProblemDetails HTTP response. Reach for it when you need to know what JSON a union puts on the wire, why all five record keywords are interchangeable, or what status code an `error` maps to.

> **Grammar:** `PayloadDecl` (`kind=PayloadKind name=ID …`), `PayloadKind` (`payload`/`command`/`query`/`response`/`error`), `ApiStatus` (`httpStatus`) · **Validators:** `loom.union-duplicate-variant`, `loom.union-variant-not-carrier`, `loom.union-position`, `loom.generic-arg-not-carrier`, `loom.generic-position`, `loom.unmapped-error-status` · **Docs:** [`../payloads.md`](../payloads.md), [generic carriers](04-type-system.md#generic-carriers--paged-envelope-option)

Aggregates are nominal state machines; **payloads are structurally-typed records**. The two ladders coexist — reach for an `aggregate` when you have durable, identified state with behaviour; reach for a payload when you have a shape that only flows across a wire. All examples below are generated from one scratch `system` with a backend deployable per platform (`node` / `java` / `python`) plus the `.NET` single-context fixture `examples/union-dotnet.ddd`; output is excerpted.

## Record forms — the five intents

A payload is a flat record of `Property` fields. Five keywords (`PayloadKind`) declare one; they share **one structural wire contract** and differ only in documented intent — `command` for a write request, `query` for a read request, `response` for a reply, `error` for a failure shape, `payload` for everything else. The grammar is identical (`kind=PayloadKind name=ID '{' fields* '}'`); the keyword is a label, not a different shape.

```ddd
payload  Address      { line1: string  city: string  postcode: string }
command  PlaceOrder   { code: string   region: string }
query    OrderSearch  { region: string }
response OrderSummary { ref: string    total: money }
error    NotFound     { resource: string }
```

`event` is the sixth member of the family — it keeps its own legacy declaration surface but unifies into the same payload view at the IR layer. Payload names share one namespace per context with value objects and events; duplicates and empty/repeated field names are rejected (`loom.*` payload checks).

A payload is offered as a **type** only where a transport record makes sense — a workflow `create`/`handle` parameter, a generic-carrier argument, a union variant, and the auto-synthesized per-aggregate `<Agg>Wire`. It is **not** admissible as a stored aggregate-property type.

> **Honest gap:** a free-standing payload that no transport position references (e.g. `Address` above, declared but never used in a find return, union, or workflow parameter) materializes **no DTO** in the generated backend — it appears in neither the emitted source nor `.loom/wire-spec.json`. Records reach the wire only when something puts them on a boundary. The sections below all reference their records (the `error` flows through the `recent` find's union), so they emit.

### `<Agg>Wire` — the auto-synthesized record

Every aggregate, part, and value object carries a canonical ordered `wireShape` (`id` → declared properties → containments → derived), synthesized once in enrichment (phase ⑥). Every backend's DTO emitter walks the *same* list, so the JSON an aggregate takes on the network is identical across all five backends by construction. This is the shape a union variant or a carrier argument projects through when it names an aggregate — `OrderResponse` below is the `Order` aggregate's wire record.

## Anonymous union — `A or B`

A union is a value that is **one of several distinct variants**, tagged on the wire so a consumer can branch. The inline form needs no declaration — write `A or B` directly in a transport position (a repository find return type or a payload field):

```ddd
aggregate Order ids guid {
  code: string
  region: string
}
error NotFound { resource: string }
repository Orders for Order {
  find recent(): Order or NotFound
}
```

`A or B or C` flattens to one variant set; `or` is associative-commutative, so an anonymous union is **structural on its variants** (`A or B` ≡ `B or A`). An inline `or` outside a find-return / payload-field position is rejected with `loom.union-position`; a repeated variant (`A or A`) with `loom.union-duplicate-variant`; a non-carrier variant (a `slot`) with `loom.union-variant-not-carrier`.

The union lowers to one DTO with a **`type` discriminator** — a record variant (an aggregate → its `<Agg>Wire`, a payload/event → its fields) flattens its fields alongside `type`; the tag is the variant type's name:

::: tabs backend
== node
```ts
// http/order.routes.ts — z.discriminatedUnion keyed on "type"
export const OrderOrNotFound = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Order"), id: z.string(), code: z.string(), region: z.string() }),
  z.object({ type: z.literal("NotFound"), resource: z.string() }),
]).openapi("OrderOrNotFound");
```
== dotnet
```csharp
// Application/Orders/Responses/OrderOrNotFound.cs
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(OrderOrNotFound_Order), "Order")]
[JsonDerivedType(typeof(OrderOrNotFound_NotFound), "NotFound")]
public abstract record OrderOrNotFound;

public sealed record OrderOrNotFound_Order([property: Required] Guid Id, [property: Required] string Code, [property: Required] string Region) : OrderOrNotFound;
public sealed record OrderOrNotFound_NotFound([property: Required] string Resource) : OrderOrNotFound;
```
== java
```java
// features/orders/OrderOrNotFoundResponse.java — sealed interface + Jackson polymorphism
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = OrderOrNotFoundResponse_Order.class, name = "Order"),
    @JsonSubTypes.Type(value = OrderOrNotFoundResponse_NotFound.class, name = "NotFound"),
})
public sealed interface OrderOrNotFoundResponse
    permits OrderOrNotFoundResponse_Order, OrderOrNotFoundResponse_NotFound {}

// OrderOrNotFoundResponse_Order.java
public record OrderOrNotFoundResponse_Order(UUID id, String code, String region) implements OrderOrNotFoundResponse {}
// OrderOrNotFoundResponse_NotFound.java
public record OrderOrNotFoundResponse_NotFound(String resource) implements OrderOrNotFoundResponse {}
```
== python
```python
# app/http/order_routes.py — the find tags the wire object inline with "type"
@router.get("/recent", response_model=None, operation_id="recentOrder")
async def recent_orders(request: Request, session: SessionDep) -> dict[str, object] | JSONResponse:
    repo = ...
    if (found := await repo.recent()) is None:
        return JSONResponse({...}, status_code=404, media_type="application/problem+json")  # NotFound variant
    return {"type": "Order", **repo.to_wire(found)}
```
::: end

So whatever the host-language representation — a Zod discriminated union, a `JsonPolymorphic` C# base, a Jackson sealed interface, or a tagged dict — the JSON is the same: `{ "type": "Order", "id": …, "code": …, "region": … }` or `{ "type": "NotFound", "resource": … }`. The shape is derived from one resolver, not coincidence.

## Named union — `payload Foo = A | B`

The named form declares the variant set up front, reusable, with identity **by name** (nominal — unlike the structural anonymous form). Use `=` and `|` (the `PayloadDecl` `'=' variants+=TypeAtom ('|' variants+=TypeAtom)*` arm):

```ddd
payload OrderEvent = OrderPlaced | OrderCancelled | OrderShipped
```

`payload F = A | B | C` produces the **same tagged wire** as `A or B or C` — both flow through one union machinery, so the discriminated DTO above is exactly what a named union emits too. The difference is referencing: a named union is named (`OrderEvent`) and so may appear anywhere a type is admitted by name, whereas an inline `or` is position-restricted. A repeated variant (`payload F = A | A`) is rejected with `loom.union-duplicate-variant`.

### `option` — `T option` is `T or none`

`T option` is the third blessed postfix carrier — sugar for the 2-variant union `union[T, none]`, flowing through the same union path (not the nullable `T?` field path). The `none` unit serializes bare: `{ "type": "none" }`. The full `paged` / `envelope` / `option` carrier surface, including the discriminated `option` output across backends, lives in [The type system → generic carriers](04-type-system.md#generic-carriers--paged-envelope-option).

## `error` & httpStatus — exception-less ProblemDetails

A domain `error` record is **HTTP-blind** — it carries no status code. The api edge is the only place an error becomes an HTTP response, and the translation is exception-less: a union-returning find that yields an error variant is mapped at the controller boundary to an RFC-7807 `application/problem+json` body, with no thrown exception. The status comes from a stdlib default table (`src/util/error-defaults.ts`):

| Error name | Default status | | Error name | Default status |
|---|---|---|---|---|
| `NotFound` | 404 | | `Forbidden` | 403 |
| `ValidationError` | 422 | | `TransportFailure` / `UnexpectedStatus` / `DeserializeError` | 502 |
| `ParseError` | 400 | | *(any other, user-declared)* | 500 |

The RFC-7807 fields are derived from the name: `title` is the prettified name (`NotFound` → `"Not Found"`), `type` is `/errors/<kebab-name>` (`/errors/not-found`), and the error record's own fields become problem extensions. A `httpStatus <Error> -> <Code>` clause on an `api` overrides the default for that error; a user-declared error with no stdlib match and no `httpStatus` override falls through to 500 and warns (`loom.unmapped-error-status`).

For the `find recent(): Order or NotFound` above, the `NotFound` variant translates to a `404` ProblemDetails — the found row becomes the tagged `Order`, absence becomes the error response:

::: tabs backend
== node
```ts
// http/order.routes.ts — the recent handler; absence → 404 problem+json, presence → tagged Order
const result = await repo.recent();
if (!result) {
  return c.json(
    { resource: "Order", type: "/errors/not-found", title: "Not Found", status: 404, detail: "Not Found", instance: c.req.path },
    404, { "content-type": "application/problem+json" },
  );
}
return c.json({ type: "Order", ...(repo.toWire(result) as Record<string, unknown>) } as z.infer<typeof OrderOrNotFound>, 200);
// route 404 response advertised: content: { "application/problem+json": { schema: ProblemDetails } }
```
== dotnet
```csharp
// Api/OrdersController.cs
[HttpGet("recent")]
[ProducesResponseType(typeof(OrderOrNotFound), 200)]
[ProducesResponseType(typeof(ProblemDetails), 404)]
public async Task<ActionResult<OrderOrNotFound>> RecentOrder()
{
    var result = await _mediator.Send(new RecentQuery());
    if (result is OrderOrNotFound_NotFound)
    {
        var problem = new ProblemDetails { Status = 404, Title = "Not Found", Type = "/errors/not-found", Detail = "Not Found" };
        problem.Extensions["resource"] = "Order";
        return new ObjectResult(problem) { StatusCode = 404, ContentTypes = { "application/problem+json" } };
    }
    return Ok(result);
}
```
== java
```java
// features/orders/OrdersController.java
@GetMapping("/recent")
public ResponseEntity<?> recentOrder() {
    var r = service.recent();
    if (r == null) {
        var problem = ProblemDetail.forStatus(404);
        problem.setTitle("Not Found");
        problem.setType(URI.create("/errors/not-found"));
        problem.setDetail("Not Found");
        problem.setProperty("resource", "Order");
        return ResponseEntity.status(404).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem);
    }
    return ResponseEntity.ok((OrderOrNotFoundResponse) new OrderOrNotFoundResponse_Order(r.id(), r.code(), r.region()));
}
```
== python
```python
# app/http/order_routes.py
if (found := await repo.recent()) is None:
    return JSONResponse(
        {"resource": "Order", "type": "/errors/not-found", "title": "Not Found", "status": 404, "detail": "Not Found", "instance": request.url.path},
        status_code=404,
        media_type="application/problem+json",
    )
return {"type": "Order", **repo.to_wire(found)}
```
::: end

All four backends emit the identical 404 `application/problem+json` body — `{ "type": "/errors/not-found", "title": "Not Found", "status": 404, "detail": "Not Found", "resource": "Order" }` — derived from one defaults table, with the `resource` field carried through as a problem extension.

## Producer-side boundary

A union's *wire contract* — its DTO/schema and the tagged serialization — is fully generated and identical across backends. **Selecting which variant a given call yields** is producer-side domain logic: a union-returning find emits the schema plus a serialization seam but leaves variant selection to a generated stub the developer fills. First-class typed *operation returns* (`placeOrder(): OrderId or NotFound`) and `match`-over-a-union exhaustiveness narrowing on the consumer side are tracked in [`../payloads.md`](../payloads.md) ("What's deferred") and the [`exception-less`](../old/proposals/exception-less.md) proposal.
