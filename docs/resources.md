# Resources & source types

How a Loom system declares the infrastructure its domain needs — relational
stores, event logs, caches, object stores, queues, and external APIs — and how
workflows consume them. This is the **shipped** reference; the design rationale
lives in [`proposals/resource-model-and-source-types.md`](proposals/resource-model-and-source-types.md)
and [`proposals/workflow-resource-consumption.md`](proposals/workflow-resource-consumption.md).

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
                            | objectStore | queue | api
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

workflow ArchiveOrder(order: Order id) {
  let prev = files.get("orders/" + order.id)        // objectStore
  files.put("orders/" + order.id, { id: order.id }) // json payload
  jobs.enqueue({ event: "archived", id: order.id }) // queue
  let fx = rates.get("/rate/usd")                    // api
}
```

### Verb vocabulary

| kind | verbs (→ capability) |
|---|---|
| `objectStore` | `put(key, json)`→blob · `get(key): json?`→blob · `list(prefix): string[]`→list · `signedUrl(key): string`→signedUrl · `delete(key)`→blob |
| `queue` | `enqueue(message)`→enqueue · `publish(topic, message)`→publish |
| `api` | `get(path): json`→request · `post(path, body): json`→request |

The vocabulary is registry-defined (`src/ir/resource-verbs.ts`). Rules:

- **workflows only** — resource-ops are not allowed in aggregate operations;
- **capability-gated** — a verb whose capability the bound sourceType doesn't
  offer is an error (`loom.resource-unknown-verb` / the need⊆sourceType check);
- **not inside a transactional span** — an external effect can't roll back with
  the DB transaction (`loom.resource-op-in-transaction`); move it out, or use an
  outbox;
- resource-ops are async; the generated call site awaits the verb helper.

The `api` verbs (`get(path): json` / `post(path, body): json`) are
**untyped** — raw paths in, raw `json` out. For a typed call surface over a
`kind: api` resource (named operations, typed request/response derived from
an OpenAPI spec), see the proposed `contract` layer in
[`proposals/contract-typed-resources.md`](proposals/contract-typed-resources.md);
the untyped verbs remain as the escape hatch for spec-less APIs.

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

Dev `docker-compose` gains a sidecar per object-store / queue storage (MinIO for
`s3`, `rabbitmq`); deployables with no such resources are byte-identical.

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
- [`proposals/contract-typed-resources.md`](proposals/contract-typed-resources.md) — proposed typed call surface over a `kind: api` resource.
