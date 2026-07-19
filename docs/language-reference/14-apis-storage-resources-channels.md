# 14. APIs, storage, resources & channels

The infrastructure surface that sits *between* the pure domain and the deployment topology: the `api` contract a subdomain exposes, the physical `storage` instances a system declares, the `resource` bindings that wire a context's data needs to that storage, and the `channel` / `channelSource` pair that realises event pub/sub. Reach for this chapter when you're deciding *what store backs which context*, *how a backend connects to it*, and *how carried events leave the process*.

> **Grammar:** `Api`, `ApiStatus`, `Storage`, `StorageType`, `ConnectionSource`, `Resource`, `DataSourceKind`, `Channel`, `ChannelSource` · **Validators:** `checkDataSource` / `checkChannels` (`src/language/validators/{datasource,channel}.ts`), `loom.kind-incompatible`, `loom.channelsource-incompatible`, `loom.channel-key-missing-field` · **Docs:** [`../resources.md`](../resources.md), [`../architecture.md`](../architecture.md), [`../auth.md`](../auth.md)

The model is a three-link chain — *storage* is the physical instance, *resource* is the configured binding, and the context's data *need* is derived from its aggregates, never authored:

```
storage    physical store / service     storage primarySql { type: postgres }
  ↑ use:
resource   the configured binding        resource ordersState { for: Orders, kind: state, use: primarySql }
  ↑ dataSources:
deployable wires the resources it hosts  deployable api { … dataSources: [ordersState] }
```

Everything below was generated from one scratch `system Shop` (one `Orders` context, one `node` backend) via `node bin/cli.js generate system infra.ddd -o out`; the compose, route, and artefact excerpts are verbatim from that run.

## `api`

```
Api:       'api' name=ID 'from' source=[Subdomain:ID] ('{' ('urlStyle' ':' …)? ApiStatus* '}')?
ApiStatus: 'httpStatus' error=ID '->' code=INT
```

An `api` is a **derived contract**, not a hand-written one — it names a *subdomain*, and the operation/query/create/destroy declarations inside that subdomain's aggregates become its HTTP surface. The block is optional; the bare `api OrdersApi from Sales` form derives everything. A backend deployable exposes a contract with `serves: OrdersApi`.

```ddd
api OrdersApi from Sales {
  urlStyle: resource     // route segments use the plural noun (default: literal → the op name)
  httpStatus NotFound -> 404 // map an `error NotFound` variant to 404 (default for unmapped: 500)
}
```

The contract mounts under `/api/<aggregate-plural>`; CRUD routes are derived from the aggregate's wire shape:

::: tabs backend
== node
```ts
// http/index.ts — the api's aggregates each mount a sub-router under /api
app.route("/api/orders", orderRoutes(new OrderRepository(db, events)));
app.route("/api/realtime", realtimeRoutes());   // present only when a channel is declared

// http/order.routes.ts — derived CRUD, one createRoute() per operation
createRoute({ method: "post", path: "/",      operationId: "createOrder", /* … */ });
createRoute({ method: "get",  path: "/{id}",  operationId: "getOrder",    /* … */ });
createRoute({ method: "get",  path: "/",      operationId: "listOrders",  /* … */ });
```
::: end

`urlStyle` only changes the **route segment of custom operations** — `op.routeSlug` is `op.name` under `literal` and `plural(op.name)` under `resource` (`src/platform/hono/v4/routes-builder.ts`, enriched per-subdomain in `enrichments.ts`). The base CRUD paths above are identical either way; the operationId, request DTO names, and extern-handler keys always stay keyed on the op name.

`httpStatus <Error> -> <Code>` overrides the HTTP status the RFC-7807 ProblemDetails translator emits for an exception-less operation returning that `error` variant. It only surfaces on an operation that actually returns the named error (`operation cancel(): Order or NotFound`); with no such operation it emits nothing, and the validator (`structural-checks.ts`) warns when a returned custom error has neither a stdlib default nor an `httpStatus` mapping (it would default to 500). The per-error → status map carries into every backend's error translator (`errorStatuses` in the IR; consumed by the .NET `[ProducesResponseType]`, Python `errors.py`, Java/Hono ProblemDetails emitters).

## `storage`

```
Storage:     'storage' name=LooseName '{' ('type' ':' StorageType) ('instance' ':' …)? ('connection' ':' ConnectionSource)? ('config' ':' '{' … '}')? '}'
StorageType: postgres | mysql | sqlite | inMemory | redis | elastic | meilisearch | kafka | clickhouse | bigquery | s3 | rabbitmq | nats | restApi | smtp | ses | sendgrid
```

A `storage` is a **physical store or service** — a typed, reusable slot (one postgres can back several deployables). `type:` names a built-in sourceType; the `config { k: v }` map carries vendor parameters validated per sourceType against the registry's config schema (`src/util/source-types.ts`): an unknown key is a warning, a wrong-typed value is an error, a missing required key (e.g. `s3` needs `bucket`) is an error.

```ddd
storage primarySql { type: postgres }
storage blobs      { type: s3, config: { bucket: "app-files", region: "eu-central-1" } }
```

Each `storage` whose type needs a dev backing service becomes a **compose sidecar** — but only for the kinds that have one: `s3` → MinIO, `rabbitmq` → RabbitMQ. The relational stores share the single stack `db` postgres service (see [Systems & topology](02-systems-and-topology.md)); `redis` / `kafka` / `nats` etc. parse and validate but emit **no** sidecar yet.

```yaml
# docker-compose.yml — the s3 storage `blobs` becomes a MinIO sidecar
  blobs:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - blobs-data:/data
volumes:
  pgdata: {}
  blobs-data: {}
```

> **Generator support is narrower than the grammar.** Only `postgres` / `inMemory` have full backend codegen, plus `s3` / `rabbitmq` (the object-store / queue clients), `restApi` (http api client), `smtp` / `ses` / `sendgrid` (the mailer clients), and `redis` / `nats` (channel transports). The remaining `StorageType` values parse and validate but emit nothing — an honest forward-compat gap.

### Connection sources

```
ConnectionSource: service(ID) | env(STRING) | secret(ID) | literal(STRING)
```

A `storage` may pin **where its connection string comes from** with `connection:` — a compose service handle, an env var, a named secret, or an inline literal:

```ddd
storage primarySql { type: postgres, connection: env("DATABASE_URL") }
```

The four forms lower to a `ConnectionSourceIR` (`kind: service | env | secret | literal`) on the storage. **Honest gap:** as of this writing the IR carries `connection` but no backend emitter consumes it — the generated compose env still uses the per-deployable derived `DATABASE_URL` shown in [Systems & topology](02-systems-and-topology.md). The clause parses, validates, and is recorded for the artefacts; it does not yet override the generated wiring.

## `resource`

```
Resource:       'resource' name=LooseName '{' ('for' ':' [BoundedContext]) ('kind' ':' DataSourceKind) ('use' ':' [Storage]) … '}'
DataSourceKind: state | eventLog | snapshot | cache | replica | objectStore | queue | api | mailer
```

A `resource` (formerly `dataSource` — the deployable's `dataSources:` *clause* keeps the old name) is the **configured binding**: it says context `for:` needs data of role `kind:`, served by storage `use:`. A backend deployable lists the resources it wires under `dataSources:`.

```ddd
resource ordersState {
  for: Orders
  kind: state
  use: primarySql
  schema: "orders"            // relational-only: postgres schema namespace
  isolationLevel: serializable
}
```

### The kind ↔ storage matrix

`checkDataSource` (`loom.kind-incompatible`) rejects a `kind` on a storage whose `type` can't serve it. The matrix (from the sourceType registry):

| kind | role | compatible storage types |
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

```ddd
resource bad { for: Orders, kind: state, use: blobs }
// error  loom: resource 'bad' kind 'state' is incompatible with storage 'blobs'
//        of type 's3'.  kind 'state' requires a storage of type
//        postgres, mysql, sqlite, or inMemory.
```

### The knobs and their guards

Each optional knob is gated to the kinds / storage types where it's meaningful (all `checkDataSource`):

| knob | meaning | guard |
|---|---|---|
| `schema` / `tablePrefix` | relational namespace / table-name prefix | relational storage only |
| `keyPrefix` | key-value namespace | redis / inMemory only |
| `ttl` | cache expiry (seconds) | `kind: cache` only |
| `every` / `retain` | snapshot cadence / retention | `kind: eventLog` or `snapshot` |
| `isolationLevel` | `readUncommitted` … `serializable` | relational, non-`cache` |
| `readonly` | read-only binding | — |
| `shape` | `relational` \| `embedded` \| `document` saving shape | — |

The `state` resource above drives the schema-migration owner and the connection wiring for its backend; the `objectStore` / `queue` / `api` / `mailer` kinds are *consumed* from workflow bodies via an ambient handle and a closed per-kind verb vocabulary (`files.put(…)`, `jobs.enqueue(…)`, `api.get(…)`, `mail.send(to, subject, body)`) — that surface is documented in [`../resources.md`](../resources.md) ("Consuming a resource from a workflow"); see also [Workflows](13-workflows.md).

### The `.loom/datasources.md` artefact

`generate system` emits a derived routing table — every resource's context → storage mapping, plus an unused-storage audit:

```md
### apiNode — `platform: node`
| Context | Kind  | Resource     | Storage    | Storage type | Schema | TablePrefix |
| ------- | ----- | ------------ | ---------- | ------------ | ------ | ----------- |
| Orders  | state | ordersState  | primarySql | postgres     | orders | —           |

## Per storage
| Storage    | Type     | Used by                       |
| ---------- | -------- | ----------------------------- |
| primarySql | postgres | apiNode → Orders (state)      |
| bus        | redis    | _unused_                      |
```

## `channel` & `channelSource`

```
Channel:       'channel' name=ID '{' ('carries' ':' [EventDecl]+) ('delivery' ':' …)? ('retention' ':' …)? ('key' ':' …)? '}'
ChannelSource: 'channelSource' name=LooseName '{' ('for' ':' channel=ID) ('use' ':' [Storage])? '}'
ChannelDelivery:  broadcast | queue
ChannelRetention: ephemeral | log | work
```

A `channel` (declared *inside a context*) is the **publisher contract**: which events it `carries:`, the `delivery:` semantics (`broadcast` fan-out vs `queue` competing-consumers), the `retention:` profile (`ephemeral` / `log` / `work`), and an optional partition `key:` (which must be a field of *every* carried event — `loom.channel-key-missing-field`). A `channelSource` (system-level) is its **physical binding** — the messaging twin of `resource`, mapping the channel `for:` to a `storage` that realises it.

```ddd
context Orders {
  event OrderPlaced { orderId: string, total: money }
  event OrderShipped { orderId: string }
  channel Lifecycle {
    carries: OrderPlaced, OrderShipped
    delivery: broadcast
    retention: ephemeral
    key: orderId
  }
}

storage bus { type: redis }
channelSource lifecycleBus { for: Lifecycle, use: bus }
```

### Transport compatibility

`checkChannels` (`loom.channelsource-incompatible`) rejects a binding whose storage type can't realise the channel's `delivery / retention` profile:

| delivery / retention | compatible storage types |
|---|---|
| `broadcast` / `ephemeral` | inMemory, redis, nats |
| `broadcast` / `log` | kafka, nats |
| `queue` / `ephemeral` | redis, rabbitmq, nats |
| `queue` / `work` | redis, rabbitmq, kafka, nats |

A `delivery: broadcast` channel emits a **realtime SSE wire** on the backend — events carried by the channel stream to connected browsers at `GET /api/realtime/events`. This is platform-internal infra (the wire format, SSE vs WebSocket, is derived from the consumer's platform — never stated in the `.ddd`):

::: tabs backend
== node
```ts
// http/realtime.ts — the carried event set becomes the UI-observable allow-list
export const REALTIME_EVENT_TYPES: ReadonlySet<string> = new Set(["OrderPlaced", "OrderShipped"]);

// realtimeTee wraps the event dispatcher so every dispatched carried event
// also reaches the SSE wire; the endpoint is one long-lived stream per browser.
export function realtimeRoutes(): OpenAPIHono { /* app.get("/events", streamSSE(…)) */ }
```
::: end

### The `.loom/asyncapi.yaml` artefact

The channel surface is also published as an AsyncAPI 3.0 document — the messaging analogue of the OpenAPI spec the api emits:

```yaml
asyncapi: 3.0.0
info: { title: "Shop channels", version: 0.0.0 }
channels:
  "Orders.Lifecycle":
    address: "Orders.Lifecycle"
    messages:
      "OrderPlaced":  { name: "OrderPlaced" }
      "OrderShipped": { name: "OrderShipped" }
    x-loom:
      delivery: broadcast
      retention: ephemeral
      key: "orderId"
      transport: "bus"     # the channelSource's bound storage
```

A UI subscribes to a context's broadcast channel with a `channel <Handle>: <Context>.<Channel>` parameter on its `ui` block (`UiChannelParam`); the frontend then refetches through its authorised reads when an event arrives. See [`../resources.md`](../resources.md) for the broader infra model.
