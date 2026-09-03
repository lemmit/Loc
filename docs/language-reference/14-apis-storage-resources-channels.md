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

Everything below was generated from one scratch `system Shop` (one `Orders` context, one `node` backend) via `node bin/cli.js generate system infra.ddd -o out`; the compose, route, and artefact excerpts are verbatim from that run.

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

### `serves:` and the OpenAPI document

`serves: OrdersApi` on a backend deployable mounts that api's explicit routes and pins its contract identity. It does **not** gate the spec document: every backend publishes its own OpenAPI 3.1 spec at `GET /openapi.json` whether or not a `serves:` clause exists (Hono `app.doc`, Swashbuckle with the document name pinned to `/openapi.json`, FastAPI, springdoc's `api-docs.path`, and a Phoenix `OpenapiController`). Python additionally serves Swagger UI at `/docs` unless `LOOM_OPENAPI_UI=false`.

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

The four forms lower to a `ConnectionSourceIR` (`kind: service | env | secret | literal`) on the storage. **Honest gap, and the compiler says so:** the IR carries `connection` but no backend emitter consumes it — the generated compose env still uses the per-deployable derived `DATABASE_URL` shown in [Systems & topology](02-systems-and-topology.md), and the k8s/Helm secret wiring is derived from the compose service host rather than from the source you named. Declaring the clause raises **`loom.reserved-not-emitted`** (a warning, printed by both `ddd parse` and `ddd generate system`), so this is not prose you have to find — the clause parses, validates, is recorded for the artefacts, and tells you it does not yet override the generated wiring. Draining it is [M-T7.9](../new-plan/T7-deployment-ops.md), which deletes that warning in the same change.

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

**Rooms + policy-derived routing (v1 — all SSE backends).** In a **tenant-owned** context the wire scopes delivery by the tenant `DataKey` (`currentUser.tenantId`, the equality part of the `tenantOwned` read filter `this.tenantId == currentUser.tenantId`) instead of broadcasting to all. The relay's connection registry becomes `Map<tenant, Set<Subscriber>>`: a connection joins its own tenant room from the **verified principal** at connect (never a client-supplied room), and a tenant-scoped event (one whose payload references a `tenantOwned` aggregate) is routed to the **emitter's tenant room only — never cross-tenant**. When the tenant can't be derived at publish (an event dispatched outside a request — outbox drain / timer), delivery degrades to a **refetch ticket** (`{ type, <id fields> }`, no payload) so nothing privileged over-delivers; the authorised read is always the gate. A context with **no** `tenantOwned` aggregate keeps the byte-identical v1 broadcast wire. Rooms ship on **every** SSE backend — node/Hono, .NET, Java, and Python all key subscribers by tenant from the same shared `realtimeRoomPlan` derivation; Phoenix/LiveView re-renders server-side through the authorised read, so raw payloads never cross the boundary there either. A UI whose target backend can't relay a subscribed channel (it neither hosts the channel's context nor binds it) is rejected with `loom.relay-target-not-subscribed`.

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
