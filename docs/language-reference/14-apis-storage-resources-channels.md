# 14. APIs, storage, resources & channels

The infrastructure surface that sits *between* the pure domain and the deployment topology: the `api` contract a subdomain exposes, the physical `storage` instances a system declares, the `resource` bindings that wire a context's data needs to that storage, and the `channel` / `channelSource` pair that realises event pub/sub. Reach for this chapter when you're deciding *what store backs which context*, *how a backend connects to it*, and *how carried events leave the process*.

> **Grammar:** `Api`, `ApiStatus`, `Route`, `HttpMethod`, `HandlerRef`, `CommandHandler` / `QueryHandler`, `Storage`, `StorageType`, `ConnectionSource`, `Resource`, `DataSourceKind`, `IndexSpec`, `Channel`, `ChannelSource` · **Validators:** `checkDataSource` / `checkChannels` (`src/language/validators/{datasource,channel}.ts`), `api-checks.ts` / `system-checks.ts` · **Codes:** `loom.route-handler-unresolved`, `loom.duplicate-handler`, `loom.command-handler-multi-aggregate`, `loom.query-handler-saves`, `loom.handler-*`, `loom.resource-index-*`, `loom.resource-api-*`, `loom.remote-api-op-unsupported`, `loom.file-field-needs-object-storage`, `loom.channelsource-*`, `loom.channel-key-missing-field`, `loom.deployable-channel-unrelated`, `loom.channel-consumer-unwired`, `loom.relay-target-not-subscribed` · **Docs:** [`../resources.md`](../resources.md), [`../channels.md`](../channels.md), [`../architecture.md`](../architecture.md)

The model is a three-link chain — *storage* is the physical instance, *resource* is the configured binding, and the context's data *need* is derived from its aggregates, never authored:

```
storage    physical store / service     storage primarySql { type: postgres }
  ↑ use:
resource   the configured binding        resource ordersState { for: Orders, kind: state, use: primarySql }
  ↑ dataSources:
deployable wires the resources it hosts  deployable api { … dataSources: [ordersState] }
```

Everything below is verbatim from two `generate system` runs over scratch models: an infrastructure `system Shop` (an `Orders` context on node + a `Shipping` context on python, with postgres / localDisk / rabbitmq / smtp storages and a cross-service api binding), and a route/handler model emitted once per backend (node / dotnet / python / java / elixir).

## `api`

```
Api:        'api' name=ID withClause=WithClause? ('from' source=[Subdomain:ID])?
                ('{' ('urlStyle' ':' ('literal'|'resource'))? ApiStatus* Route* '}')?
ApiStatus:  'httpStatus' error=ID '->' code=INT
Route:      'route' method=HttpMethod path=STRING '->' target=HandlerRef
HttpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
HandlerRef: context=[BoundedContext:ID] '.' handler=ID
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

### `route` — the explicit transport binding

Derived CRUD covers the aggregate surface; a `route` binds **one explicit path** to a context-level `commandHandler` / `queryHandler` (chapter 3, [`commandHandler` / `queryHandler`](03-domain-modeling.md#commandhandler--queryhandler)). `HandlerRef` is `<Context>.<Handler>` — an unknown context or handler name is `loom.route-handler-unresolved`.

```ddd
context Orders {
  command PlaceOrderCommand { code: string }
  commandHandler PlaceOrder(cmd: PlaceOrderCommand): Order id {
    let order = Order.create({ code: cmd.code, status: "Draft" })
    return order.id
  }
  queryHandler GetOrder(orderId: Order id): Order { let order = Orders.getById(orderId)  return order }
  extern queryHandler GetQuote(sku: string): string;
}

api OrdersApi from Sales {
  route POST "/orders/place"          -> Orders.PlaceOrder
  route GET  "/orders/{orderId}/view" -> Orders.GetOrder
  route GET  "/quotes/{sku}"          -> Orders.GetQuote     // extern → scaffolded impl file
}
```

Routes emit only on a deployable that **`serves:` that api** (the derived `/api/<plural>` CRUD mounts either way). A `{brace}` path segment binds a same-named handler parameter as a path param; every other parameter is bound from a JSON request body — **including on `GET`** (`route GET "/orders/by-code" -> C.FindByCode` with a `code: string` parameter emits a GET whose request schema is a JSON body on node and `[FromBody]` on .NET). Model a filtered read as `POST`, or take the value in the path, if a GET body is unacceptable to your clients.

::: tabs backend
== node
```ts
// http/ordersApi-routes.ts — mounted at app.route("/api", ordersApiRoutes(db, events))
createRoute({
  method: "post", path: "/orders/place", tags: ["OrdersApi"], operationId: "ordersPlaceOrder",
  request: { body: { content: { "application/json": { schema: z.object({ code: z.string() }) } } } },
  // …
});
async (httpCtx) => {
  const body = httpCtx.req.valid("json");
  const cmd = { code: body.code };
  const orders = new OrderRepository(db, events);
  const order = Order.create({ code: cmd.code, status: "Draft" });
  await orders.save(order);
  return httpCtx.json(order.id as unknown, 200);
}
// the extern handler dispatches to a scaffold-once, user-owned module
const result = await getQuoteImpl(sku);
```
== dotnet
```csharp
// Api/OrdersApiRoutesController.cs — one action per route, each a Mediator send
public sealed record PlaceOrderBody(string Code);

[HttpPost("/orders/place")]
public async Task<IActionResult> PlaceOrder([FromBody] PlaceOrderBody body)
    => Ok(await _mediator.Send(new PlaceOrderCommand(body.Code)));

[HttpGet("/orders/{orderId}/view")]
public async Task<IActionResult> GetOrder(Guid orderId)
{
    var result = await _mediator.Send(new GetOrderQuery(new OrderId(orderId)));
    return Ok(new OrderResponse(result.Id.Value, result.Code, result.Status, result.Version));
}
```
== python
```python
# app/http/orders_api_routes.py
@router.post("/orders/place", operation_id="placeOrder")
async def place_order_route(body: PlaceOrderBody, session: SessionDep) -> dict[str, object]: ...

@router.get("/orders/{order_id}/view", operation_id="getOrder")
async def get_order_route(order_id: UuidStr, session: SessionDep) -> dict[str, object]: ...
```
== java
```java
// api/OrdersApiRoutesController.java
@PostMapping("/orders/place")
public ResponseEntity<?> placeOrder(@RequestBody PlaceOrderBody body) { … }

@GetMapping("/orders/{orderId}/view")
public ResponseEntity<?> getOrder(@PathVariable UUID orderId) { … }
```
== elixir
```elixir
# lib/d_elixir_web/router.ex
post "/orders/place", DElixirWeb.OrdersApiRoutesController, :place_order
get "/orders/:order_id/view", DElixirWeb.OrdersApiRoutesController, :get_order
get "/quotes/:sku", DElixirWeb.OrdersApiRoutesController, :get_quote
```
::: end

Handler gates (all `src/ir/validate/checks/api-checks.ts` unless noted): a `queryHandler` may not mutate (`loom.query-handler-saves`); a `commandHandler` touches one aggregate (`loom.command-handler-multi-aggregate`); a handler parameter may not be named `id` (`loom.handler-param-reserved-id`); a nullable load has no null-handling vocabulary in a handler body (`loom.handler-load-nullable-unsupported` — use `getById`); a non-`extern` handler needs a body and an `extern` one must be bodyless (`loom.handler-missing-body` / `loom.extern-handler-has-body`); and a handler name may not collide with another handler *or a workflow `handle`* in the same context (`loom.duplicate-handler`, `src/language/validators/duplicates.ts`) — the route reference `<Context>.<Name>` would be ambiguous. A route that names a **workflow `handle`** resolves in the validator but emits nothing today ([Workflows](13-workflows.md#create--handle--starters--continuations)).

`urlStyle` only changes the **route segment of custom operations** — `op.routeSlug` is `op.name` under `literal` and `plural(op.name)` under `resource` (`src/platform/hono/v4/routes-builder.ts`, enriched per-subdomain in `enrichments.ts`). The base CRUD paths above are identical either way; the operationId, request DTO names, and extern-handler keys always stay keyed on the op name.

`httpStatus <Error> -> <Code>` overrides the HTTP status the RFC-7807 ProblemDetails translator emits for an exception-less operation returning that `error` variant. It only surfaces on an operation that actually returns the named error (`operation cancel(): Order or NotFound`); with no such operation it emits nothing, and the validator (`structural-checks.ts`) warns when a returned custom error has neither a stdlib default nor an `httpStatus` mapping (it would default to 500). The per-error → status map carries into every backend's error translator (`errorStatuses` in the IR; consumed by the .NET `[ProducesResponseType]`, Python `errors.py`, Java/Hono ProblemDetails emitters).

### `serves:` and the OpenAPI document

`serves: OrdersApi` on a backend deployable mounts that api's explicit routes and pins its contract identity. It does **not** gate the spec document: every backend publishes its own OpenAPI 3.1 spec at `GET /openapi.json` whether or not a `serves:` clause exists (Hono `app.doc`, Swashbuckle with the document name pinned to `/openapi.json`, FastAPI, springdoc's `api-docs.path`, and a Phoenix `OpenapiController`). Python and Java additionally serve a Swagger UI (`/docs`, `springdoc.swagger-ui`), both gated by `LOOM_OPENAPI_UI`.

## `storage`

```
Storage:     'storage' name=LooseName '{' ('type' ':' StorageType) ('instance' ':' …)? ('connection' ':' ConnectionSource)? ('config' ':' '{' … '}')? '}'
StorageType: postgres | mysql | sqlite | inMemory | redis | elastic | meilisearch | kafka | clickhouse | bigquery | s3 | localDisk | rabbitmq | nats | restApi | smtp | ses | sendgrid
```

A `storage` is a **physical store or service** — a typed, reusable slot (one postgres can back several deployables). `type:` names a built-in sourceType; the `config { k: v }` map carries vendor parameters validated per sourceType against the registry's config schema (`src/util/source-types.ts`): an unknown key is a warning, a wrong-typed value is an error, a missing required key (e.g. `s3` needs `bucket`) is an error.

```ddd
storage primarySql { type: postgres }
storage blobs      { type: s3, config: { bucket: "app-files", region: "eu-central-1" } }
```

Each `storage` whose type needs a dev backing service becomes a **compose sidecar** (`renderStorageSidecars`, `src/system/index.ts`). The relational stores instead share the single stack `db` postgres service (see [Systems & topology](02-systems-and-topology.md)):

| storage type | sidecar | when |
|---|---|---|
| `s3` | `minio/minio:latest` + a named data volume | always |
| `smtp` | `axllent/mailpit:latest` (SMTP :1025, web inbox :8025) | always — `ses` / `sendgrid` are SaaS, no sidecar |
| `redis` | `valkey/valkey:8-alpine` with `--requirepass` | only when it backs a `channelSource` a deployable wires; a cache-only redis emits nothing |
| `rabbitmq` | `rabbitmq:4-management-alpine` + a mounted `broker-init/` definitions file (vhost + per-deployable user) | when wired as a channel transport; an unwired one falls back to plain `rabbitmq:3-management` |
| `kafka` | `apache/kafka:4.1.0`, single-node KRaft, SASL/PLAIN on the client listener | only when wired as a channel transport |
| `localDisk` | none — the object store is a directory in the container (`<RESOURCE>_URL_DIR`) | — |
| everything else | none | — |

```yaml
# docker-compose.yml — an s3 storage and an smtp storage, from `generate system`
  blobs:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - blobs-data:/data
  mailer:
    image: axllent/mailpit:latest
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: 1
      MP_SMTP_AUTH_ALLOW_INSECURE: 1
volumes:
  pgdata: {}
  blobs-data: {}
```

> **Generator support is narrower than the grammar.** Only `postgres` / `inMemory` have full backend codegen, plus `s3` and `localDisk` (object-store clients), `rabbitmq` and `kafka` (queue / channel transports), `redis` (broadcast channel transport), `restApi` (http api client) and `smtp` / `ses` / `sendgrid` (mailer clients). `mysql` / `sqlite` bind the relational kinds in the registry, but every shipped SQL emitter targets Postgres — a `state` binding on either still generates Postgres wiring; `nats`, `elastic`, `meilisearch`, `clickhouse` and `bigquery` parse and validate but bind no kind and emit nothing — an honest forward-compat gap. (`nats` is *not* a channel transport: `CHANNEL_COMPATIBILITY` in `src/util/channels.ts` lists only `inMemory` / `redis` / `rabbitmq` / `kafka`.)

### Connection sources

```
ConnectionSource: service(ID) | env(STRING) | secret(ID) | literal(STRING)
```

A `storage` may pin **where its connection string comes from** with `connection:` — a compose service handle, an env var, a named secret, or an inline literal:

```ddd
storage primarySql { type: postgres, connection: env("DATABASE_URL") }
```

The four forms lower to a `ConnectionSourceIR` (`kind: service | env | secret | literal`) on the storage. **Honest gap, and the compiler says so:** the IR carries `connection` but no backend emitter consumes it — the generated compose env still uses the per-deployable derived `DATABASE_URL` shown in [Systems & topology](02-systems-and-topology.md), and the k8s/Helm secret wiring is derived from the compose service host rather than from the source you named. Declaring the clause raises **`loom.reserved-not-emitted`** (a warning, printed by both `ddd parse` and `ddd generate system`), so this is not prose you have to find — the clause parses, validates, is recorded for the artefacts, and tells you it does not yet override the generated wiring. Draining it is [M-T7.9](../new-plan/T7-deployment-ops.md), which deletes that warning in the same change.

## `resource`

```
Resource:       'resource' name=LooseName '{' ('for' ':' [BoundedContext])? ('kind' ':' DataSourceKind)?
                    ('use' ':' [ResourceTarget])? … ('index' ':' '[' IndexSpec+ ']')? ('config' ':' '{' … '}')? '}'
DataSourceKind: state | eventLog | snapshot | cache | replica | objectStore | queue | api | mailer
IndexSpec:      entity=ID '.' ( columns+=LooseName | '(' columns+=LooseName (',' columns+=LooseName)* ')' )
```

`use:` resolves to a `ResourceTarget` — a `storage`, **or an `api` declared in this same system** (the typed in-system client, below).

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

`checkDataSource` rejects a `kind` on a storage whose `type` can't serve it (an uncoded validator error — the message is built inline in `src/language/validators/datasource.ts`, not from the `loom.*` catalog). The matrix (from the sourceType registry):

| kind | role | compatible storage types |
|---|---|---|
| `state` | primary state store | postgres, mysql, sqlite, inMemory |
| `eventLog` | event stream | postgres, mysql, sqlite, inMemory, kafka |
| `snapshot` | event-sourced snapshot | postgres, mysql, sqlite, inMemory |
| `cache` | derived cache | redis, inMemory |
| `replica` | read replica | postgres, mysql, sqlite |
| `objectStore` | blob storage | s3, localDisk |
| `queue` | message queue | rabbitmq |
| `api` | external HTTP API | restApi |
| `mailer` | outbound email | smtp, ses, sendgrid |

```ddd
resource bad { for: Orders, kind: state, use: blobs }
// error  resource 'bad' kind 'state' is incompatible with storage 'blobs'
//        of type 's3'.  kind 'state' requires a storage of type
//        inMemory, mysql, postgres, or sqlite.
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
| `index` | manual performance indexes, `[Entity.col, Entity.(a, b)]` | `kind: state` only (`loom.resource-index-non-state`); unknown entity / column is `loom.resource-index-unknown-entity` / `-unknown-column` |
| `config` | vendor parameters, validated against the sourceType's config schema | per sourceType (`loom.config-key-unknown`, …) |

### Manual indexes

An index is infrastructure, not a domain fact, so it lives on the binding and names its entity explicitly (an aggregate **or** one of its contained parts — each has its own table). Always non-unique: uniqueness is the domain `unique (...)` invariant ([Invariants](07-invariants-derived-functions.md)).

```ddd
resource ordersState {
  for: Orders, kind: state, use: primary, schema: "orders"
  index: [Order.code, Order.(status, code)]
}
```

```sql
-- orders_svc/db/migrations/20260101000000_sales_initial.sql
CREATE INDEX "orders_code_idx" ON "orders"."orders" ("code");
CREATE INDEX "orders_status_code_idx" ON "orders"."orders" ("status", "code");
```

### `use: <Api>` — the typed in-system client

Bind an `api` instead of a `storage` on a `kind: api` resource and the caller gets a **typed** client for a sibling deployable — named operations, derived request/response types, and a compose address derived from the servers' service slug + port (no `baseUrl` is authored). Binding an api on any other kind is `loom.resource-api-target-kind`; the api must be served by exactly one backend deployable (`loom.resource-api-unserved` / `loom.resource-api-ambiguous-server`), and a deployable may not wire a resource pointing at an api it serves itself (`loom.resource-api-self-call` — call the context in-process). An operation the caller's platform emits no client for is `loom.remote-api-op-unsupported`; the untyped `get` / `post` verbs over a `storage restApi` binding are the escape hatch.

```ddd
resource orders { for: Shipping, kind: api, use: OrdersApi }
```

```python
# ship_svc/app/resources/api_clients.py — generated typed client
_orders_base_url = os.environ.get("ORDERS_URL", "http://localhost:3000")

async def orders_create_order(body: object) -> OrderCreated:
    async with httpx.AsyncClient(base_url=_orders_base_url) as client:
        res = await client.request("POST", "/api/orders", json=body)
```

```yaml
# docker-compose.yml — the address is derived, and startup ordered after the callee
  ship_svc:
    environment:
      ORDERS_URL: "http://orders_svc:3000"
    depends_on:
      orders_svc: { condition: service_healthy }
```

### `File` fields need an object store

The `File` primitive is [chapter 4](04-type-system.md#file--a-stored-object-reference); the binding it needs is here. A deployable hosting a `File`-bearing aggregate must wire a `kind: objectStore` resource or it is `loom.file-field-needs-object-storage`. With one wired, the backend emits the store client plus the root-mounted upload/download routes:

```ts
// orders_svc/http/index.ts
app.post("/files", async (c) => { /* multipart → ordersFiles$putBytes(key, bytes, contentType) */ });
app.get("/files/:key", async (c) => { /* → ordersFiles$getBytes(key) */ });

// orders_svc/resources/localDisk.ts — the `type: localDisk` client
export const ordersFilesDir = process.env.ORDERS_FILES_URL_DIR ?? path.join(process.cwd(), "data", "ordersFiles");
```

The `state` resource above drives the schema-migration owner and the connection wiring for its backend; the `objectStore` / `queue` / `api` / `mailer` kinds are *consumed* from workflow bodies via an ambient handle and a closed per-kind verb vocabulary (`files.put(…)`, `jobs.enqueue(…)`, `api.get(…)`, `mail.send(to, subject, body)`) — that surface is documented in [`../resources.md`](../resources.md) ("Consuming a resource from a workflow"); see also [Workflows](13-workflows.md).

### The `.loom/datasources.md` artefact

`generate system` emits a derived routing table — every resource's context → storage mapping, plus an unused-storage audit:

```md
### ordersSvc — `platform: node`

| Context | Kind | Resource | Storage | Storage type | Schema | TablePrefix |
| --- | --- | --- | --- | --- | --- | --- |
| Orders | mailer | mail | mailer | smtp | n/a | — |
| Orders | objectStore | ordersFiles | uploads | localDisk | n/a | — |
| Orders | state | ordersState | primary | postgres | orders | — |

## Per storage

| Storage | Type | Used by |
| --- | --- | --- |
| primary | postgres | ordersSvc → Orders (state); shipSvc → Shipping (state) |
| bus | rabbitmq | _unused_ |
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

`checkChannels` rejects a binding whose storage type can't realise the channel's `delivery / retention` profile. Two matrices drive it — what a transport *could* realise, and what a shipped driver *does*:

| delivery / retention | compatible storage types (`CHANNEL_COMPATIBILITY`) | of those, shipped drivers (`SHIPPED_COMBOS`) |
|---|---|---|
| `broadcast` / `ephemeral` | inMemory, redis | redis (plus in-process `inMemory`) |
| `broadcast` / `log` | kafka | kafka |
| `queue` / `ephemeral` | redis, rabbitmq | rabbitmq |
| `queue` / `work` | rabbitmq, kafka | rabbitmq, kafka |

Three codes gate a binding, in order: a storage that is no transport at all is `loom.channelsource-transport-invalid`; a transport that can't realise the profile is `loom.channelsource-incompatible`; a combination the matrix allows but **no shipped driver realises** (e.g. `queue`/`ephemeral` on redis) is `loom.channelsource-not-yet-shipped` — without that gate the generator would silently fall back to in-process dispatch and quietly break the delivery guarantee.

### Wiring a binding onto a deployable

A `channelSource` is inert until a deployable lists it: `channels: [lifecycleBus]` provisions the broker, the per-deployable credentials, and the consumer group. The gates:

| Code | Raised when |
|---|---|
| `loom.channelsource-unbound` | no deployable's `channels:` lists the binding — declared but inert, events stay on in-process dispatch |
| `loom.deployable-channel-unrelated` | a deployable lists a binding whose channel it neither produces (it doesn't host the owning context) nor consumes — the wiring routes nothing |
| `loom.channel-consumer-unwired` | a deployable *consumes* a carried event but doesn't list the binding another deployable put on the broker — once traffic rides the broker it would silently receive nothing |
| `loom.relay-target-not-subscribed` | a ui subscribes to a channel whose relay backend neither hosts the owning context nor binds the channel |

```ddd
storage bus { type: rabbitmq }
channelSource lifecycleBus { for: Lifecycle, use: bus }

deployable ordersSvc { platform: node   contexts: [Orders]   channels: [lifecycleBus] … }
deployable shipSvc   { platform: python contexts: [Shipping] channels: [lifecycleBus] … }
```

```yaml
# docker-compose.yml — the wired rabbitmq storage becomes a provisioned broker
  ordersSvc:  # (service `orders_svc`)
    environment:
      LOOM_CHANNEL_LIFECYCLE_BUS_URL: "amqp://orders_svc:loom-dev-bus-orders_svc@bus:5672/loom"
  bus:
    image: rabbitmq:4-management-alpine
    volumes:
      - ./broker-init/bus.conf:/etc/rabbitmq/conf.d/10-loom.conf:ro
      - ./broker-init/bus-definitions.json:/etc/rabbitmq/loom-definitions.json:ro
```

See [`../channels.md`](../channels.md) for the CloudEvents envelope, the per-broker topology, the outbox relay and broker auth.

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

**Rooms + policy-derived routing (v1 — all SSE backends).** In a **tenant-owned** context the wire scopes delivery by the tenant `DataKey` (`currentUser.tenantId`, the equality part of the `tenantOwned` read filter `this.tenantId == currentUser.tenantId`) instead of broadcasting to all. The relay's connection registry becomes `Map<tenant, Set<Subscriber>>`: a connection joins its own tenant room from the **verified principal** at connect (never a client-supplied room), and a tenant-scoped event (one whose payload references a `tenantOwned` aggregate) is routed to the **emitter's tenant room only — never cross-tenant**. When the tenant can't be derived at publish (an event dispatched outside a request — outbox drain / timer), delivery degrades to a **refetch ticket** (`{ type, <id fields> }`, no payload) so nothing privileged over-delivers; the authorised read is always the gate. A context with **no** `tenantOwned` aggregate keeps the byte-identical v1 broadcast wire. Rooms ship on **every** SSE backend — node/Hono, .NET, Java, and Python all key subscribers by tenant from the same shared `realtimeRoomPlan` derivation; Phoenix/LiveView re-renders server-side through the authorised read, so raw payloads never cross the boundary there either. A UI whose target backend can't relay a subscribed channel (it neither hosts the channel's context nor binds it) is rejected with `loom.relay-target-not-subscribed`.

### The `.loom/asyncapi.yaml` artefact

The channel surface is also published as an AsyncAPI 3.0 document — the messaging analogue of the OpenAPI spec the api emits:

```yaml
asyncapi: 3.0.0
info:
  title: "Shop channels"
  version: 0.0.0
channels:
  "Orders.Lifecycle":
    address: "Orders.Lifecycle"
    messages:
      "OrderPlaced":
        name: "OrderPlaced"
    x-loom:
      delivery: queue
      retention: work
      key: "order"
      transport: "bus"                              # the channelSource's bound storage
      transportStatus: "declared, not provisioned"  # until a deployable lists it in `channels:`
      wiredBy: ["ordersSvc", "shipSvc"]
```

A UI subscribes to a context's broadcast channel with a `channel <Handle>: <Context>.<Channel>` parameter on its `ui` block (`UiChannelParam`); the frontend then refetches through its authorised reads when an event arrives. See [`../resources.md`](../resources.md) for the broader infra model.
