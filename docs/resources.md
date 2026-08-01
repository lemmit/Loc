# Resources & source types

How a Loom system declares the infrastructure its domain needs — relational
stores, event logs, caches, object stores, queues, and external APIs — and how
workflows consume them. This is the **shipped** reference; the design rationale
lives in [`proposals/resource-model-and-source-types.md`](old/proposals/resource-model-and-source-types.md)
and [`proposals/workflow-resource-consumption.md`](old/proposals/workflow-resource-consumption.md).

## The model in one screen

```
storage     physical instance / service — `storage files { type: s3, config: { … } }`
  ↑ use:
resource    the configured binding — `resource X { for: Ctx, kind, use: storage }`
  ↑ (implicit)
need        what the context requires (kind + capabilities) — derived, never authored
sourceType  built-in technology descriptor (postgres, s3, rabbitmq, …) — platform-internal
            per kind it declares: capabilities + interfaces
kind        semantic role:  state | eventLog | snapshot | cache | replica
                            | objectStore | queue | api | mailer
capability  refines a kind (crud, blob, signedUrl, enqueue, …) — registry data
interface   access mode (sql / rest / amqp / sdk) — selected per kind, derived
```

`storage` and `resource` are the only user-authored declarations. `sourceType`
is a platform-internal registry (`src/util/source-types.ts`), never written in
`.ddd`. `need`, `capability`, and `interface` are derived/internal — only `kind`
surfaces, on `resource`.

## `storage` — a physical store or service

```ddd
storage primarySql { type: postgres }
storage hotCache   { type: redis }
storage files      { type: s3,       config: { region: "eu-central-1", bucket: "app-files" } }
storage jobBus     { type: rabbitmq, config: { vhost: "/" } }
storage payments   { type: restApi,  config: { baseUrl: "https://pay.example.com" } }
storage mailer     { type: smtp,     config: { from: "no-reply@app.example.com" } }
```

`type:` names the built-in **sourceType**. The `config { k: v }` map carries
vendor parameters (strings / ints / bools), validated per sourceType against
the registry's config schema:

- **unknown key** → warning (forward-compatible),
- **wrong-typed value** → error,
- **required key missing** on a `storage` → error (e.g. `s3` requires `bucket`).

Adding a new technology is two coordinated edits — a `type:` literal in the
grammar and a registry entry — and never a soft keyword.

## `resource` — the configured binding

```ddd
resource ordersDb    { for: Orders, kind: state,       use: primarySql, schema: "orders" }
resource ordersFiles { for: Orders, kind: objectStore, use: files }
resource orderJobs   { for: Orders, kind: queue,       use: jobBus }
resource payApi      { for: Orders, kind: api,         use: payments }
resource orderMail   { for: Orders, kind: mailer,      use: mailer }
```

`resource` was previously named `dataSource`; the declaration keyword is now
`resource` (the deployable's `dataSources:` clause keyword is retained for
compatibility). A backend deployable lists the resources it wires under that
clause:

```ddd
deployable api {
  platform: node
  contexts: [Orders]
  dataSources: [ordersDb, ordersFiles, orderJobs, payApi]
  port: 3000
}
```

### Kinds

The surface `kind:` keeps the fine-grained persistence values and adds the new
infrastructure roles:

| kind | role | sourceTypes |
|---|---|---|
| `state` | primary state store | postgres, mysql, sqlite, inMemory |
| `eventLog` | event stream | postgres, mysql, sqlite, inMemory, kafka |
| `snapshot` | event-sourced snapshot | postgres, mysql, sqlite, inMemory |
| `cache` | derived cache | redis, inMemory |
| `replica` | read replica | postgres, mysql, sqlite |
| `objectStore` | blob storage | s3 |
| `queue` | message queue | rabbitmq |
| `api` | external HTTP API | restApi |
| `mailer` | outbound email | smtp, ses, sendgrid |

The surface keyword is `mailer` (not `email` — a value-position `email` literal
would collide with the global keyword tokeniser); it maps to the internal infra
kind `email`. Every mailer sourceType requires a `from:` config key (`ses` also
accepts a `region:`), and `smtp` gains a **Mailpit** dev sidecar in the emitted
`docker-compose.yml` (a catch-all SMTP server with a web inbox on `:8025`).

**Credentials never live in `.ddd` source.** They ride the connection URL at
runtime: the `smtp` client reads `<RESOURCE>_URL` (default `smtp://<name>:1025`,
the auth-less dev Mailpit), and when that URL carries userinfo
(`smtp://user:pass@relay:587`) every backend authenticates — with STARTTLS when
available, or implicit TLS for `smtps://`. Provider sourceTypes read a
per-runtime key (`SENDGRID_API_KEY`; SES uses the AWS credential chain +
`<RESOURCE>_REGION`). Point `<RESOURCE>_URL` / the provider key at an env var or
secret in your deployment to send through a real relay.

The validator rejects a `kind` on an incompatible sourceType
(`loom.kind-incompatible`). The persistence kinds (`state`/`snapshot`/`replica`)
are modelled internally as capabilities under a `database` infra-kind; that
reframe stays inside the registry — the surface keeps the fine-grained names.

### Manual indexes — `index: [...]`

A `state`/`replica` resource may declare **manual performance indexes** — pure
infrastructure, never on the aggregate (uniqueness stays the domain `unique (...)`
invariant; these are non-unique). Each entry names the entity **explicitly** —
`Entity.col` is single-column, `Entity.(a, b)` composite — because the binding
knows the context's shape, so the index says which entity's table it's on (an
aggregate *or* one of its contained parts):

```ddd
resource ordersDb {
  for: Orders, kind: state, use: primarySql, schema: "orders",
  index: [Order.customerId, Order.(status, placedAt)]
}
```

These feed `manualIndexes` in the IR and land as `CREATE INDEX` in the derived
migration. The advisory lint `loom.index-suggestion` (D-INDEX-SUGGEST) flags
frequently-filtered columns that have no covering index — a hint to add one here.

## Consuming a resource from a workflow

`objectStore` / `queue` / `api` resources are *used*, not persisted to. A
workflow calls them through an **ambient handle** (the resource name, in scope
like `currentUser` / `permissions`) and a **closed per-kind verb vocabulary**:

```ddd
resource files { for: Sales, kind: objectStore, use: s3Bucket }
resource jobs  { for: Sales, kind: queue,       use: rabbit }
resource rates { for: Sales, kind: api,         use: fxApi }
resource mail  { for: Sales, kind: mailer,      use: mailServer }

workflow ArchiveOrder(order: Order id) {
  let prev = files.get("orders/" + order.id)        // objectStore
  files.put("orders/" + order.id, { id: order.id }) // json payload
  jobs.enqueue({ event: "archived", id: order.id }) // queue
  let fx = rates.get("/rate/usd")                    // api
  mail.send(order.email, "Archived", "Order " + order.id) // mailer
}
```

### Verb vocabulary

| kind | verbs (→ capability) |
|---|---|
| `objectStore` | `put(key, json)`→blob · `get(key): json?`→blob · `list(prefix): string[]`→list · `signedUrl(key): string`→signedUrl · `delete(key)`→blob |
| `queue` | `enqueue(message)`→enqueue · `publish(topic, message)`→publish |
| `api` | `get(path): json`→request · `post(path, body): json`→request |
| `mailer` | `send(to, subject, body)`→send |

The vocabulary is registry-defined (`src/ir/resource-verbs.ts`). Rules:

- **workflows only** — resource-ops are not allowed in aggregate operations;
- **capability-gated** — a verb whose capability the bound sourceType doesn't
  offer is an error (`loom.resource-unknown-verb` / the need⊆sourceType check);
- **not inside a transactional span** — an external effect can't roll back with
  the DB transaction (`loom.resource-op-in-transaction`); move it out, or use an
  outbox;
- resource-ops are async; the generated call site awaits the verb helper.

The `api` verbs (`get(path): json` / `post(path, body): json`) are
**untyped** — raw paths in, raw `json` out. That is the right shape for a
third-party API Loom knows nothing about.

When the callee is **another deployable in this same system**, don't use them:
bind the `api` instead of a `storage` and you get a typed call surface with
named operations and a derived request/response — see
[Calling another Loom service](#calling-another-loom-service--use-api) below.
The untyped verbs remain the escape hatch for spec-less external APIs. (A
typed surface over an *external* OpenAPI spec is still only proposed —
[`proposals/contract-typed-resources.md`](old/proposals/contract-typed-resources.md).)

### Interface selection

Each `(sourceType, kind)` exposes one or more access **interfaces**
(`sql`/`rest`/`amqp`/`sdk`). A default is derived per resource (native-first:
sql → amqp → sdk → rest), and a verb may override it — e.g. `signedUrl` forces
`rest` (the presigning flow) even though the object store's default is `sdk`.

## What each backend emits

The same vendor-neutral source emits idiomatic native code per backend — the
payoff of the model. Per consumed resource, a client module is emitted and the
verb call sites dispatch to it:

| kind | hono | .NET | Phoenix | Python | Java |
|---|---|---|---|---|---|
| objectStore | `@aws-sdk/client-s3` (+ presigner) | `AWSSDK.S3` | `ExAws.S3` | `boto3` (+ presigner) | `software.amazon.awssdk:s3` (+ `S3Presigner`) |
| queue | `amqplib` | `RabbitMQ.Client` v7 | `AMQP` | `aio_pika` | `com.rabbitmq:amqp-client` |
| api | `fetch` | `HttpClient` | `Req` | `httpx` | `java.net.http HttpClient` |
| mailer (`smtp`) | `nodemailer` | `MailKit` | `Swoosh` (+ `gen_smtp`) | `aiosmtplib` | Jakarta Mail (`angus-mail`) |

The `mailer` client also has `ses` (AWS SES SDK / `AmazonSES` / SendGrid-style)
and `sendgrid` (`@sendgrid/mail` etc.) sourceType variants; `smtp` is the one
with a dev sidecar.

Dev `docker-compose` gains a sidecar per object-store / queue / smtp-mailer
storage (MinIO for `s3`, `rabbitmq`, **Mailpit** for `smtp`); deployables with
no such resources are byte-identical.

## Calling another Loom service — `use: <Api>`

The two things a `resource` can bind are not symmetric:

| `use:` target | what it is | who knows the address |
|---|---|---|
| a `storage` | infrastructure Loom does **not** own — S3, RabbitMQ, someone else's REST API | only you. It rides `config: { baseUrl: … }` |
| an `api` | infrastructure Loom **does** own — a sibling deployable in this system `serves:` it | Loom. Both the address *and* the operation set are derivable from the model |

So when the callee is another Loom deployable, bind the **api**, not a storage:

```ddd
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish { code: string  status: string }
      repository Orders for Order { }
    }
    context Shipping {
      aggregate Shipment with crudish { orderCode: string  status: string }
      repository Shipments for Shipment { }
      workflow fulfil {
        create(orderId: Order id) {
          let o = orders.getOrderById(orderId)     // typed in-system call
          let s = Shipment.create({ orderCode: o.code, status: "Pending" })
        }
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: api,   use: OrdersApi }

  deployable ordersSvc {
    platform: node   contexts: [Orders]   dataSources: [ordersState]
    serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: python contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
```

No URL is written anywhere in that source. `docker compose` gets the wiring:

```yaml
  shipping_svc:
    environment:
      ORDERS_URL: "http://orders_svc:3000"
    depends_on:
      orders_svc:
        condition: service_healthy
```

and the generated client reads the same `<RESOURCE>_URL` variable — both sides
go through one helper (`resourceEnvUrlVar`), so the injected name and the read
name cannot drift.

### What gets generated

The caller gets one typed function **per operation the callee actually mounts**,
in a module of its own (`resources/api-clients.ts`, `app/resources/api_clients.py`,
`Resources/ApiClients.cs`, …):

```ts
// shipping_svc/resources/api-clients.ts  (excerpt)
export const ordersBaseUrl = process.env.ORDERS_URL ?? "http://localhost:3000";

export const OrderResponse = z.object({
  id: z.string(), code: z.string(), status: z.string(), version: z.number().int(),
});

export async function orders$getOrderById(id: string): Promise<z.infer<typeof OrderResponse>> {
  const url = new URL(`/api/orders/${encodeURIComponent(String(id))}`, ordersBaseUrl);
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new RemoteCallError("orders", "getOrderById", res.status);
  return OrderResponse.parse(await res.json());
}
```

Both halves are **derived, not written**: the path from the same operation
derivation the callee's own routes answer to, and the response schema from the
same wire-shape walk the callee serializes with. That is the difference from the
untyped `get(path): json` verbs — a hand-written `"/orders/{id}"` compiles clean
and 404s at runtime; this cannot.

The call site is checked all the way through. `let o = orders.getOrderById(id)`
binds `o` to the callee's aggregate type, so `o.code` type-checks and `o.nope`
is a compile error in your `.ddd`, not a runtime `undefined`.

### Per-backend shape

| | client module | boundary check |
|---|---|---|
| hono | `resources/api-clients.ts` | `zod.parse` |
| python | `app/resources/api_clients.py` | pydantic `model_validate` |
| .NET | `Resources/ApiClients.cs` | `JsonSerializer` + null guard |
| java | `ApiClients.java` | Jackson 3 `readValue` |
| phoenix | `<App>.Resources.ApiClients` | atom-key projection of the wire shape |

The .NET and Phoenix checks are **weaker than their siblings**, and the
difference is worth knowing: zod and pydantic raise on a missing required field;
System.Text.Json binds it to a default, and the Elixir projection lands it as
`nil`. All five reject a non-2xx status.

All five are gated at runtime, not just at compile: `api-call-e2e` boots the
generated caller and callee as separate processes **with separate databases** —
the isolation is what makes the assertions mean anything — and covers both
directions of the call (`npm run test:api-call`,
`LOOM_API_CALL_CALLER=<backend>`):

- a **read** round-trip: the caller persists a value only the callee could have
  supplied;
- a **write**: the caller creates a row through the client, verified by querying
  the *callee*, whose database the caller cannot otherwise reach;
- a **collection** read, and a `404` both raising (plain `getById`) and binding
  as a value (absence union).

### What each operation returns

The client's return type is derived from what the callee **actually sends**, which
is not always the aggregate — three of these differ from the obvious guess, and
all three were shipped wrong before a gate pinned them:

| callee operation | wire | client returns |
|---|---|---|
| `create` | `201 { id }` | the id envelope — **not** the whole entity |
| `getById`, or an operation declaring `: T` | `200` entity | the entity |
| a find declaring `T option` / `T or NotFound` | `200` entity, absence on `404` | the entity or `null`/`None`/`nil` |
| the auto `findAll`, or a `paged` find | `200 { items, page, pageSize, total, totalPages }` | the paged envelope |
| a find declaring `T[]` | `200` bare array | an array of the record |
| `destroy`, or an operation declaring **no** `: T` | `204`, no body | nothing (`void` / `None` / `:ok`) |

The last row is the one that bites: an operation without a declared return answers
`204` with an empty body, so its client returns nothing. Typing it as the
aggregate — the intuitive default — makes the client parse a schema against an
empty body and throw at runtime while compiling perfectly on both sides.

These are held by `test/ir/api-surface.test.ts`, which scrapes the emitted Hono
routes and compares, per operation, both the absolute method+path and the *shape*
of the success body against what the client parses. It is checked against the
generated source rather than against this table, so the two cannot drift.

### Rules

- The bound api must be served by **exactly one** backend deployable in the
  system — `loom.resource-api-unserved` / `loom.resource-api-ambiguous-server`
  otherwise, so a client is never generated against a guess.
- A deployable may not bind an api it serves itself
  (`loom.resource-api-self-call`) — compose rejects the `depends_on` cycle.
- `use: <Api>` is only meaningful on `kind: api`
  (`loom.resource-api-target-kind`).
- Failures raise, they do not return a sentinel. Each backend's client throws a
  status-carrying `RemoteCallError` / `RemoteCallException`.

### Absence as a value — `T or NotFound`

When the callee's find declares an **absence union** (`Order option`, `Order or
NotFound`), the caller gets the absent case as a *value* to match on rather than
an exception:

```ddd
// callee
repository Orders for Order {
  find byCode(code: string): Order option
}

// caller
workflow fulfil {
  create(code: string) {
    let o = orders.byCodeOrder(code)
    let note = match o { Order x => x.code, else => "missing" }
    let s = Shipment.create({ orderCode: note, status: "Pending" })
  }
}
```

```ts
export async function orders$byCodeOrder(code: string): Promise<z.infer<typeof OrderResponse> | null> {
  if (res.status === 404) return null;          // absence is a VALUE
  if (!res.ok) throw new RemoteCallError(…);    // everything else still fails
  return OrderResponse.parse(await res.json());
}
```

This is derivation, not a new knob. A union find already answers the success
body **directly** at 200 and rides absence on its own status, with no `type`
discriminator ([Union finds](payloads.md#union-finds--the-untagged-exception)) —
so the client returns `T | null` and the `match` narrows on presence, exactly as
it does for a *local* union find. Per backend: `| None` (python), `T?` (.NET), a
nullable record (java), `nil` (phoenix).

`getOrderById` is deliberately **unchanged**: its declared response is `Order`
with 404 among its error statuses, so absence there *is* an error. You opt in by
declaring a union find on the callee — and then the caller cannot ignore it,
because the union does not type-check as the bare aggregate.

## Custom source types (out-of-tree)

A `packages/*` package contributes a custom sourceType declaratively via its
`package.json` `loom` manifest — no plugin code runs to register the descriptor:

```json
"loom": {
  "kind": "sourceType",
  "sourceType": {
    "name": "clickhouseCloud",
    "supports": { "database": { "capabilities": ["query"], "interfaces": ["sql"] } },
    "configKeys": [{ "name": "endpoint", "type": "string", "required": true }]
  }
}
```

Registered at CLI startup (`bootSourceTypePlugins`) alongside out-of-tree
backend discovery; trusted like any installed package.

## Related

- [`architecture.md`](architecture.md) — `storage`/`resource` in the layered composition model.
- [`language.md`](language.md) — declaration grammar.
- [`generators.md`](generators.md) — per-backend emission detail.
- [`workflow.md`](workflow.md) — workflow bodies (where resource-ops live).
- [`proposals/contract-typed-resources.md`](old/proposals/contract-typed-resources.md) — proposed typed call surface over a `kind: api` resource.
