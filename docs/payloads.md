# Payloads, generic carriers, and discriminated unions

Loom's **transport layer** — the structured data that crosses a boundary
(HTTP, queue, internal call) rather than living as durable aggregate state.
This is the reference for what *ships today*; the design rationale and the
phased roadmap live in
[`proposals/payload-transport-layer.md`](proposals/payload-transport-layer.md).

Aggregates are nominal state machines; **payloads are structurally-typed
records**. The two ladders coexist: reach for an `aggregate` when you have
durable, identified state with behaviour; reach for a payload when you have a
shape that flows across a wire.

---

## 1. Payloads

A payload is a flat record of properties. Five keywords declare one; they share
the same structural wire contract and differ only in documented intent:

```
payload  Address  { line1: string  city: string  postcode: string }
command  PlaceOrder { customer: Customer id  total: money }
query    OrderSearch { region: string  since: datetime }
response OrderSummary { id: Order id  total: money }
error    OutOfStock { sku: string }
```

`event` is the sixth member of the family — it keeps its own legacy
declaration surface but is unified into the same payload view at the IR layer.

Payload names share one namespace per context with value objects and events;
duplicates and empty/repeated field names are rejected (`loom.*` payload
checks). Payloads are offered as a **type** only where a transport record makes
sense — today that is a workflow `create` / `handle` parameter, a generic
carrier argument, a union variant, and (auto-synthesized) the per-aggregate
`<Agg>Wire`. They are **not** admissible as a stored aggregate field type.

### `<Agg>Wire` — the auto-synthesized wire shape

Every aggregate, part, and value object carries a canonical, ordered
`wireShape` (id → declared properties → containments → derived), synthesized
once in enrichment. Every backend's DTO emitter walks the *same* list, so the
JSON an aggregate takes on the network is identical across Hono, .NET, React,
and Phoenix by construction — not by coincidence. This is the shape a union
variant or a carrier argument projects through when it names an aggregate.

---

## 2. Generic carriers — `paged` and `envelope`

Two **carrier-bounded generic payloads** are built in. They are instantiated
with **ML-postfix** syntax — the carrier keyword follows its type argument:

```
repository Orders for Order {
  find recent(): Order paged                 # paged(Order)
  find latest(): OrderPlaced envelope        # envelope(OrderPlaced)
}
```

The argument must be a **carrier**: a primitive, an `X id`, an enum, a value
object, or an aggregate/entity (which projects through its `<Agg>Wire`). A
carrier may appear only in a **transport position** — a repository find's
return type or a payload field — never as a stored property. v1 ships only this
closed, blessed set (`loom.generic-*` codes guard the rules).

### Pinned wire shapes

```
paged(T)    → { items: T[]; page: int; pageSize: int; total: int; totalPages: int }
envelope(T) → { id: string; ts: datetime; body: T }
```

`paged` is **1-based** (`page` starts at 1) and offset-based; `totalPages` is
included so clients don't recompute it. A paged find auto-gains `page` /
`pageSize` query controls (defaults `1` / `20`). The shape is the *uniform
backend-exchange guarantee*: no backend serializes its framework-native paging
type (EF, `Ash.Page.Offset`, …) — each maps to this one DTO.

| Backend | `paged` emission |
|---|---|
| Hono / React | `z.object({ items: …, page, pageSize, total, totalPages })` |
| .NET | `Paged<T>` record (`Domain.Common`); repo `CountAsync` + `Skip`/`Take` |
| Phoenix / Ash | offset-pagination read action; controller maps `%Ash.Page.Offset{}` to the envelope |

---

## 3. Discriminated unions

A union is a value that is **one of several distinct variants**, tagged on the
wire so a consumer can branch. Two surfaces, one IR shape:

**Anonymous `or`** — inline in any type position, no declaration:

```
repository Orders for Order {
  find recent(): Order or Cancel
}
```

**Named `payload Foo = A | B`** — declared up front, reusable, identity by name:

```
payload OrderEvent = OrderPlaced | OrderCancelled | OrderShipped
```

`A or B or C` and `payload F = A | B | C` produce the same tagged wire. Identity
differs: an anonymous union is **structural on its variant set** (associative-
commutative — `A or B` ≡ `B or A`); a named union is **nominal** (by its name).

### `option` — the third blessed postfix carrier

```
find findByCode(code: string): Order option       # Order or none
```

`T option` is sugar for the 2-variant union `union[T, none]` — it flows through
the same union machinery. (`option` is distinct from `T?`/`optional`, which is
a nullable field rather than a tagged variant.)

### The tagged wire

Every variant serializes as an object with a **`type` discriminator** plus its
data:

- a **record variant** (an aggregate → its `<Agg>Wire`, or a payload/event →
  its fields) flattens its fields alongside `type`:
  `{ "type": "Order", "id": …, "code": …, "region": … }`;
- a **scalar variant** (primitive / `id`) carries a single `value` field;
- the **`none`** unit is bare: `{ "type": "none" }`.

The variant **tag** is the variant type's name (`Order`, `Cancel`, `none`, …).
All four backends derive this shape from one resolver, so the wire is identical
by construction:

| Backend | union emission |
|---|---|
| Hono / React | `z.discriminatedUnion("type", [ z.object({ type: z.literal("Order"), … }), … ])` |
| .NET | `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` base + one `[JsonDerivedType(typeof(V), "Tag")]` record per variant |
| Phoenix / Ash | controller `tag_<union>/1` — one struct-pattern clause per variant → `%{type: "Tag", …}` |

### Precedence

Postfix carriers and the array / optional markers bind **tighter** than `or`:

```
string or int option   ≡  string or (int option)
A or B[]               ≡  A or (B[])
```

### Position

An **inline `or`** union (like a carrier) is a transport shape — it may appear
only as a repository find return type or a payload field
(`loom.union-position`). A **named** union is referenced by its name and so is
unaffected.

---

## 4. Validation rules

| Code | Rejects |
|---|---|
| `loom.union-duplicate-variant` | A repeated variant (`string or string`, `payload F = A \| A`) — the discriminator must be unambiguous. |
| `loom.union-variant-not-carrier` | A `slot` variant — every variant must be a carrier type. |
| `loom.union-position` | An inline `or` union outside a find return / payload field. |
| `loom.generic-arg-not-carrier` | A non-carrier or nested carrier argument to `paged` / `envelope`. |
| `loom.generic-position` | A generic carrier outside a transport position. |
| `loom.generic-carrier-unsupported` / `loom.union-unsupported` | A carrier / union served by a backend that doesn't emit it yet — a platform-aware gate. All four backends now emit both, so these are dormant safety nets for a future backend. |

---

## 5. Producer-side boundary

A union's *wire contract* — its DTO/schema and the tagged serialization — is
fully generated. **Selecting which variant a given call yields** (e.g. a `find`
that returns `Order` in one case and `Cancel` in another) is producer-side
domain logic. Today a union-returning find emits the schema + a serialization
seam but leaves the variant selection to a generated stub the developer fills
(a throwing handler/method on each backend). First-class typed *operation
returns* (`placeOrder(): OrderId or NotFound`) and their RFC-7807 ProblemDetails
translation are the
[`exception-less`](proposals/exception-less.md) track that P3 + P4 unblock.

## What's deferred

- **`match` over a union** with exhaustiveness checking + per-backend narrowing
  (`switch(x.type)` / C# pattern match / Elixir `case`) — the consumer side.
- **Operation returns** of unions (exception-less) and **`option` PATCH**
  semantics ([`partial-update`](proposals/partial-update.md)).
- **User-declared generic payloads** beyond the blessed `paged` / `envelope` /
  `option` set.
- **Multi-arg generics** and row polymorphism over payloads.
