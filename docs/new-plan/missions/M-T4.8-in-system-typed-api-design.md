# M-T4.8 (slice) — In-system typed service-to-service calls

**Status:** design, signed off on the shape (surface + prerequisite + slicing).
**Mission:** [M-T4.8 — Resource-model completion](../T4-eventing-temporal.md) (`partial`, P3).
**Companions:** [`contract-typed-resources.md`](../../old/proposals/contract-typed-resources.md)
(the *foreign-spec* twin — superseded for the in-system case by this doc),
[`unfoldable-api-derivation.md`](../../old/proposals/unfoldable-api-derivation.md)
(the api-surface lift this slice finally builds),
[`resources.md`](../../resources.md) (the `storage`/`resource` model this extends).

---

## 1. The problem

Two deployables in one Loom system cannot call each other in a typed way.
The only shipped path is a `kind: api` resource bound to a hand-configured
`storage restApi`:

```ddd
storage ordersSvcApi { type: restApi, config: { baseUrl: "http://orders_svc:3000" } }
resource ordersApi   { for: Shipping, kind: api, use: ordersSvcApi }

workflow fulfil {
  create(code: string) {
    let o = ordersApi.get("/orders/" + code)     // : json
  }
}
```

Three defects, all verified by generating this system on fresh `main`:

1. **The address is hand-typed although Loom knows it.** The generated
   `docker-compose.yml` gives each service `depends_on: db` and nothing else —
   no cross-service `depends_on`, no injected URL. The author writes
   `http://orders_svc:3000`, which is `serviceSlug(deployable.name)` plus the
   fixed container port. A rename of the deployable silently breaks it.
2. **The path is unchecked.** The example above compiles clean and emits
   clean, and 404s at runtime: auto-CRUD actually mounts at
   `/api/orders/{id}`, keyed by id, not `/orders/{code}`. Nothing in the
   pipeline relates the caller's path string to the callee's routes.
3. **The response is untyped.** `get(path): json` — no field types, no
   validation at the boundary, no compile-time link to the callee's
   `wireShape`.

The asymmetry is that Loom **already derives** a cross-deployable base URL —
for frontends. `ui { targets: <backend> }` lowers to
`http://${targetSlug}:${targetPort}` in `src/system/index.ts`. Backends have
no equivalent.

## 2. What already exists (audit, fresh `main` @ `0f6932c`)

Three of the four pieces ship today; none are joined.

| Piece | Where | Serves |
|---|---|---|
| Typed call, resolved + union-returning | `src/ir/lower/lower-expr.ts` (`domainService`) — resolves by bare name across sibling contexts, emits `callKind: "domain-service"` with a structured `serviceRef`, types the result from the declared return **including `T or E` unions with `?` propagation** | in-process calls |
| Typed HTTP client derived from IR | `src/generator/_frontend/api-module.ts` — zod schemas mirroring `wireShape`, per-route calls, framework-neutral | browser SPAs |
| Derived cross-deployable address | `src/system/index.ts` (`ui targets:`) | frontend → backend |
| **The api's operation set as IR data** | **— does not exist —** | — |

### 2.1 The load-bearing gap

`ApiIR` is thin:

```ts
export interface ApiIR {
  name: string; sourceModule: string; urlStyle: "literal" | "resource";
  errorStatuses: Record<string, number>;
  routes: RouteIR[];   // explicit `route …` bindings only; "unread by backends in this slice"
}
```

The **auto-CRUD surface is not IR data.** Each backend re-derives it in its own
route builder (`src/platform/hono/v4/routes-builder.ts` is 2039 lines; the
.NET/Java/Python/Elixir siblings do the same independently), and
`.loom/wire-spec.json` carries types only, no routes. There is no single place
that knows what an `api` exposes.

The shipped Hono surface, for reference — this is what the lift must reproduce:

| Operation | Method + path (under `API_BASE_PATH = "/api"`) |
|---|---|
| create | `POST /api/<plural>/` |
| prepare | `GET /api/<plural>/prepare` |
| getById | `GET /api/<plural>/{id}` |
| destroy | `DELETE /api/<plural>/{id}` |
| operation `<op>` | `POST /api/<plural>/{id}/<op_snake>` |
| gate probe | `GET /api/<plural>/{id}/can_<op_snake>` |
| declared `find` | `GET /api/<plural>/<find path>` |
| workflow / handler / projection | per `workflow-builder.ts`, `explicit-handlers-builder.ts`, `projection-query-routes-builder.ts` |

## 3. Surface

`use:` on a `kind: api` resource accepts an **`Api`** as well as a `Storage`.
The address and base path derive from the deployable that `serves:` it; the
operation set comes from the lifted `ApiOperationIR`.

```ddd
api OrdersApi from Orders
deployable ordersSvc { platform: node contexts: [Orders] serves: OrdersApi port: 3000 }

resource orders { for: Shipping, kind: api, use: OrdersApi }

deployable shippingSvc {
  platform: node contexts: [Shipping]
  dataSources: [shippingState, orders]      // unchanged wiring
  port: 3001
}

workflow fulfil {
  create(orderId: Order id) {
    let o = orders.getById(orderId)?         // : Order or NotFound — `?` propagates
    let s = Shipment.create({ orderCode: o.code, status: "Pending" })
  }
}
```

Binding to a `storage restApi` keeps working unchanged — that stays the escape
hatch for APIs Loom doesn't own, with the untyped `get`/`post` verbs.

### 3.1 Two stances, deliberate

- **What crosses the boundary is a record, not the aggregate.** The caller
  receives `OrderWire` — data, no behaviour, no `.place()`. Handing a caller a
  foreign *aggregate* would dissolve the bounded-context boundary the model
  exists to draw, and would imply the caller can invoke domain operations it
  has no invariants for.
- **Failure is a union, not an exception.** `T or NotFound or Unavailable`,
  riding the existing exception-less `?` machinery. This is what makes the
  typing reach the failure paths rather than stopping at the happy one — a
  client that only types the 200 body is not meaningfully type-safe.

## 4. Generated output (Hono caller)

```ts
// resources/orders-client.ts
const OrderWire = z.object({
  id: z.string().uuid(), code: z.string(), status: z.string(), version: z.number().int(),
});
export type OrderWire = z.infer<typeof OrderWire>;

export async function orders$getById(id: string): Promise<Result<OrderWire, NotFound>> {
  const res = await fetch(new URL(`/api/orders/${id}`, ordersBaseUrl));
  if (res.status === 404) return err({ type: "NotFound" });
  if (!res.ok) throw new RemoteCallError("orders", "getById", res.status);
  return ok(OrderWire.parse(await res.json()));   // validated at the boundary
}
```

and in `docker-compose.yml`, derived rather than authored:

```yaml
  shipping_svc:
    depends_on:
      orders_svc:
        condition: service_healthy
    environment:
      ORDERS_URL: "http://orders_svc:3000"
```

## 5. Slices

| # | Slice | Targets |
|---|---|---|
| **0** | **`ApiOperationIR[]` lift** — derive the api's operation set in enrichment (phase ⑥): method, path, params, request/response `TypeIR`, error statuses. Single source of truth. | IR only |
| 1 | Grammar (`use:` accepts `Api`), scope/validate, lowering (`callKind: "remote-api-op"` mirroring `domain-service`), address + `depends_on` derivation in phase ⑨, **Hono caller emitter** | node |
| 2–5 | Caller emitters, one PR each, parallelizable | dotnet · java · python · elixir |

The **callee needs no change** (it already serves the routes) and the
**frontends are unaffected** (they are already clients). Target matrix is 5
backends as callers, 0 frontends.

Slice 0 is the risk. It must reproduce what five backends independently derive;
the mitigation is that `conformance-parity.yml` already diffs each backend's
served OpenAPI document, so a lift that disagrees with a backend is caught by a
gate that exists.

## 6. Gates this trips

- `langium-generated.yml` — grammar edit → regenerate + commit.
- `print-completeness.test.ts` — new grammar member needs a printer arm.
- `pipeline-layering.test.ts` — the enrichment lift must not import from
  `generator/`; the client emitter must not reach back into `system/`.
- Corpus: a new `test/fixtures/corpus/*.ddd` feature fixture + `manifest.ts`
  entry, with `COMPILE_SKIP` per not-yet-implemented backend.
- `behavioral-e2e*.yml` + the wire-differential golden — a two-service case.
- `conformance-parity.yml` — cross-checks the slice-0 lift.

## 7. Open questions

1. **Which address per emitter.** compose slug, k8s Service DNS, dev
   `localhost:<port>` — the frontend path already fans out this way
   (`VITE_PROXY_TARGET` vs `VITE_BASE_URL`). The resource client needs the same
   three-way derivation, and k8s needs a `Service` reference in `helm.ts`.
2. **Auth propagation.** Does the caller forward its `currentUser` bearer token
   to the callee, or call as a service principal? `denyByDefault` on the callee
   makes this load-bearing, not cosmetic — an unauthenticated internal call
   401s. Proposed default: forward the incoming token; a service-principal mode
   is a follow-up.
3. **Retries / timeouts.** Out of scope for this slice; the client throws
   `RemoteCallError` on non-modelled failure. Naming it here so it isn't
   mistaken for an oversight.
4. **Cycles.** `A` calling `B` calling `A` is legal at the type level but makes
   the compose `depends_on` graph cyclic. Proposal: derive `depends_on` only
   for acyclic edges and emit `loom.remote-api-cycle` as a warning, not an
   error — the runtime call is fine, only the boot ordering isn't expressible.
