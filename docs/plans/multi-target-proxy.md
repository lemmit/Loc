# Multi-target frontends — same-origin proxy story

> **Status:** design proposal for review. No code yet. Sibling of
> `backend-packages.md` (gateway platforms reuse the out-of-tree
> package story).

## The problem

A UI deployable today targets **one** backend
(`src/language/ddd.langium:124` —
`('targets' ':' targets=[Deployable:LooseName] ','?)?`). Enrichment
walks that single ref to inherit `moduleNames`
(`src/ir/enrich/enrichments.ts`), and the generated React API client
is built against that one base URL.

But the DSL already lets a `ui` block declare **multiple api
parameters**, and the deployable's `UiComposeBinding` already binds
each parameter to a different backend
(`src/language/ddd.langium:156`):

```ddd
ui WebApp {
  api Sales:   SalesApi
  api Billing: BillingApi
  ...
}

deployable webApp {
  platform: react,
  targets:  salesApi,                     // ← only one
  ui:       WebApp {
    Sales:   salesApi,                    // ← bound at compose
    Billing: billingApi,                  // ← bound at compose
  },
}
```

The binding model is already plural. The transport model is not.
That leaves the user with three bad options at run time:

1. **Per-backend CORS** — every backend opens CORS for the UI's
   origin. Preflight on every cross-origin request; auth cookies
   need `SameSite=None`+`Secure` everywhere; the browser bundle
   has to know every backend's URL; service topology leaks.
2. **One backend wins** — `targets: salesApi` only, `BillingApi`
   gets reached through Sales by hand. Couples backends to each
   other for no domain reason.
3. **Hand-rolled proxy** outside Loom — defeats the point.

The standard industry answer is **same-origin reverse proxy**: the
SPA only ever sees `/api/<module>/*`, and *something* in front of
or alongside the static-file server fans out to the right backend.
The "something" depends on where the SPA is hosted.

## What Loom already has

Worth being explicit, because half the answer is "use what's
there":

- **`UiComposeBinding`** — per-api-parameter backend binding at
  the deployable site. The map `apiParam → backendDeployable`
  already exists in the AST, validated by
  `src/ir/validate/validate.ts` (`serves:` check).
- **`mountsUi` on `PlatformSurface`** —
  `src/platform/surface.ts:86`. `react: true`,
  `dotnet: true` (Slice: dual-mode),
  `phoenix-live-view: true`, `hono/v4: false`. So whether the SPA
  is **standalone** (its own compose service) vs **mounted into a
  backend** is already a typed property of the host platform.
- **`moduleNames` enrichment** — every backend deployable already
  has a resolved list of modules it owns. The cross-backend
  collision check (two proxied backends both claiming module
  `Billing`) falls out for free.

What's missing:

- `targets:` (single ref) is the wrong shape — it conflates two
  unrelated things (where the SPA's API client points + which
  backend's modules we inherit) and only handles one target. It
  goes away; `ui: WebApp { Foo: fooApi }` already names every
  backend a UI binds to.
- No IR field for "this deployable re-serves these other
  deployables' apis at same-origin paths."
- No `PlatformSurface` hook for emitting reverse-proxy config.
- No first-class platform for "this deployable is a pure
  gateway" — Caddy/nginx/Ocelot don't fit `serves` / `mountsUi`.

## The design — `proxy:` plus gateway platforms

Two ideas, both small, that compose.

### Idea 1 — `proxy:` is a list of deployables

`proxy: [billingApi, inventoryApi]` says: *"this deployable
re-serves the listed deployables' apis at `/api/<module>/*` on
its own origin."* No family/worker knob — the host platform
decides the implementation. Power-user override (e.g. `proxy: {
targets: [...], worker: ocelot }`) is a future extension, not
v1.

| Host platform | Realization of `proxy:` |
|---|---|
| `dotnet` | **YARP** (`Yarp.ReverseProxy`) — routes loaded from `appsettings`, registered via `MapReverseProxy()`. |
| `hono` | `app.all('/api/billing/*', c => fetch(...))` — single handler per target. |
| `phoenixLiveView` | `ReverseProxyPlug` block on the Endpoint. |
| `react` | **Illegal.** React is pure static; validator error directing the user to a gateway or a mounted host. |

`proxy:` on a backend that already `serves:` something layers
cleanly: the deployable serves its own modules in-process and
proxies the rest.

### Idea 2 — Gateway platforms (`caddy`, `nginx`, `traefik`, `ocelot`)

These join `Platform` as **restricted-kind** platforms. A gateway
platform:

- **only** legalises `proxy:` (and `port:`),
- forbids `contexts:`, `serves:`, `ui:`, `dataSources:`,
- emits a config file native to its family (`Caddyfile`,
  `nginx.conf`, traefik labels, `ocelot.json`) + a compose
  service from a stock image (`caddy:2-alpine`,
  `nginxinc/nginx-unprivileged`, …).

Choosing a gateway is choosing a `platform:`, like everything
else. No hidden sub-knob, no second registry, no surprise
defaults.

The .NET shop that wants Ocelot writes `platform: ocelot`. The
team that wants Caddy writes `platform: caddy`. Both compose the
same way.

### Combining them — three shapes that fall out

#### Shape A — Backend host mounts SPA + proxies siblings

```
                ┌────────────────────────────┐
   browser ───▶ │ acmeHost (dotnet)           │
                │  /                          │ → static SPA
                │  /api/sales/*               │ → handled in-proc
                │  /api/billing/*             │ ──▶ billingApi (hono)
                │  /api/inventory/*           │ ──▶ inventoryApi (phoenix)
                └────────────────────────────┘
```

The hosting backend `serves:` its own modules, mounts the SPA via
`ui:`, and `proxy:`-fans-out the rest. In-process; no sidecar.

#### Shape B — Standalone gateway in front of N services

```
                ┌────────────────────────────┐
   browser ───▶ │ gateway (caddy)             │
                │  /             ──▶ webApp:3000    (static SPA)
                │  /api/sales/*  ──▶ salesApi:3001
                │  /api/billing/*──▶ billingApi:3002
                └────────────────────────────┘
```

The gateway is a deployable in its own right with `platform:
caddy` (or nginx/traefik/ocelot). The react deployable stays
purely static. The SPA itself only ever sees the gateway's
origin.

#### Shape C — Pure static react, single backend (or CORS)

The simplest case: `platform: react` deployable bound to one
backend via `ui: WebApp { Sales: salesApi }`. No `proxy:`
anywhere — there's nothing to fan out. If the SPA needs to talk
to >1 backend without a gateway or mounted host, the user opens
CORS on each backend explicitly. Validator gives a hint when
this shape appears with multiple UI bindings: *"this SPA reaches
multiple backends; consider a gateway deployable, mounting in a
backend, or set CORS explicitly on each backend."*

## Grammar surface

Minimal diff to `src/language/ddd.langium`. `targets:` is
removed; `proxy:` is added; the `Platform` enum gains the
gateway families.

```diff
  Deployable:
      'deployable' name=LooseName '{'
          ('platform' ':' platform=Platform ','?)
          ...
-         ('targets' ':' targets=[Deployable:LooseName] ','?)?
+         ('proxy' ':' '[' proxy+=[Deployable:LooseName]
+                          (',' proxy+=[Deployable:LooseName])* ','? ']' ','?)?
          ...
      '}';

  Platform returns string:
      'hono' | 'dotnet' | 'react' | 'phoenixLiveView'
+   | 'caddy' | 'nginx' | 'traefik' | 'ocelot';
```

Singular sugar (`proxy: api`) is added as a grammar alternation
once the list form lands; not shown in the diff.

`Platform` joining the gateway families is what makes the out-of-
tree package story carry over from `backend-packages.md`. A shop
can ship `packages/proxy-yarp-v1/` carrying
`loom: { kind: "gateway", family: "yarp", ... }` and target it by
`platform: yarp@v1`, same shape as a backend.

## Validator additions

In `src/language/validators/deployable.ts` and
`src/ir/validate/validate.ts`:

| Code | Rule |
|---|---|
| `loom.proxy-on-static` | `proxy:` set on `platform: react` (or any platform with `kind === 'static'` in the surface — to be defined). |
| `loom.proxy-module-collision` | Two entries in `proxy:` claim the same module name. |
| `loom.proxy-not-backend-or-static` | An entry in `proxy:` is itself a gateway (gateways proxying gateways is allowed but suspicious — start as a warning). |
| `loom.ui-binding-not-proxied` | A `UiComposeBinding.source` isn't the host itself, not in `proxy:`, and the host isn't a gateway exposing it. (Probably: derive instead of require — see open question.) |
| `loom.gateway-no-domain-slots` | `platform: caddy/nginx/…` deployable has `contexts:`, `serves:`, `ui:`, or `dataSources:`. |
| `loom.spa-fanout-no-gateway` | Warning. `platform: react` deployable's `ui:` binds >1 distinct source deployable and no gateway fronts it. |

The "kind" distinction between **application platform** (today's
hono/dotnet/phoenix/react) and **gateway platform** (new) is best
expressed as a `PlatformSurface.kind` discriminator rather than a
hard-coded set name in the validator — see the contract diff.

## IR shape

One enrichment field per non-static deployable, added in phase ⑥
(`src/ir/enrich/enrichments.ts`):

```ts
// On EnrichedDeployableIR
readonly proxyRoutes?: {
  readonly mode: 'mounted-in-host' | 'gateway';
  readonly routes: readonly {
    readonly prefix:  string;               // "/api/billing" or "/"
    readonly target:  string;               // compose service name
    readonly port:    number;
    readonly module?: string;               // present for api routes
  }[];
};
```

Derivation rules:

- `mode = 'gateway'` when host `PlatformSurface.kind === 'gateway'`;
  otherwise `'mounted-in-host'` (and only present when `proxy:` is
  non-empty).
- For each `target ∈ proxy[]`:
  - If the target is a backend, for each
    `module ∈ target.moduleNames` emit
    `{ prefix: '/api/' + kebab(module), target, port, module }`.
  - If the target is a frontend (only legal on gateway hosts),
    emit a single root catch-all route `{ prefix: '/', target,
    port }`. This is how a gateway proxies the static SPA itself.
- The host's *own* modules don't get a proxy route — they're
  served in-process (for `mounted-in-host` mode only).
- Order of `routes` is significant: api prefixes before the root
  catch-all. Enrichment guarantees the sort.

The compose builder reads `proxyRoutes` and either:

- **`mounted-in-host`** → delegates to the host's
  `PlatformSurface.emitProxyMounts(routes)`.
- **`gateway`** → calls the gateway's
  `PlatformSurface.emitProject({ routes, listenPort })`.

## `PlatformSurface` contract diff

Two additions to `src/platform/surface.ts`:

```ts
export interface PlatformSurface {
  // ...existing...

  /**
   * Discriminator. Existing surfaces are 'application'; gateway
   * platforms are 'gateway'. Drives validator rules — gateways
   * can't `serves:` / `ui:` / `contexts:`.
   */
  readonly kind: 'application' | 'gateway';

  /**
   * Optional. Called once per application host whose deployable
   * has a non-empty `proxy:`. The host emits same-origin
   * reverse-proxy routes for every listed target using its
   * platform-native idiom. No-op for gateways (they use
   * emitProject).
   */
  readonly emitProxyMounts?: (
    routes: readonly ProxyRoute[],
    ctx: HostEmitCtx,
  ) => void;
}
```

Gateway surfaces implement the existing `emitProject` /
`composeService` interface — they don't need a separate
`ProxySurface` type. `emitProject` for a gateway takes the
routes (lifted from `proxyRoutes` via the orchestrator) and
emits a single config file + asset directory. `composeService`
returns a compose entry referencing the family's stock image.

Registration mirrors `backend-packages.md`. In-tree gateways
land in `src/platform/<family>.ts`, register in
`src/platform/registry.ts`. Out-of-tree gateways land in
`packages/proxy-<family>-v<N>/` with
`loom: { kind: "gateway", family, loomVersion, core }`;
`fs-discovery.ts` already iterates packages — teach it the
`"gateway"` kind alongside `"backend"`.

---

## Examples

These are the deliverable — what users actually write.

### Example 1 — Standalone gateway, two backends, react SPA

The bread-and-butter case. SPA is purely static. A Caddy
deployable fronts both the SPA and two backend APIs.

```ddd
system Storefront {

  module Billing   { aggregate Invoice  { id: InvoiceId  amount: Money } }
  module Inventory { aggregate Stock    { id: StockId    onHand: Int   } }

  ui WebApp {
    api Billing:   BillingApi
    api Inventory: InventoryApi
    page list Invoice
    page list Stock
  }

  deployable billingApi {
    platform: hono,            contexts: [Billing],   port: 3001
  }
  deployable inventoryApi {
    platform: phoenixLiveView, contexts: [Inventory], port: 3002
  }
  deployable webApp {
    platform: react,
    ui:       WebApp {
      Billing:   billingApi,
      Inventory: inventoryApi,
    },
    port: 3000,
  }

  deployable gateway {
    platform: caddy,
    proxy:    [webApp, billingApi, inventoryApi],
    port: 80,
  }
}
```

What gets generated:

- React bundle calls `/api/billing/*` and `/api/inventory/*`
  same-origin — no CORS, no per-service base URLs in the JS.
- `gateway/Caddyfile`:
  ```caddy
  :80 {
    handle /api/billing/*    { reverse_proxy billingApi:3001 }
    handle /api/inventory/*  { reverse_proxy inventoryApi:3002 }
    handle                   { reverse_proxy webApp:3000 }
  }
  ```
- `docker-compose.yml`: `gateway` service uses `caddy:2-alpine`
  with the Caddyfile mounted at `/etc/caddy/Caddyfile`. Public
  port maps to `gateway`; the other services bind to the docker
  network only.

### Example 2 — Mounted shape: .NET host serves SPA + proxies a Hono sibling

Mixed stack. The dotnet deployable serves Sales itself, mounts
the SPA, and proxies `/api/marketing/*` to a Hono service. No
gateway deployable — YARP runs inside the .NET process.

```ddd
system Acme {

  module Sales     { aggregate Order    { id: OrderId    total: Money } }
  module Marketing { aggregate Campaign { id: CampaignId name: String } }

  ui WebApp {
    api Sales:     SalesApi
    api Marketing: MarketingApi
    page list Order
    page list Campaign
  }

  deployable marketingApi {
    platform: hono, contexts: [Marketing], port: 4001
  }

  deployable acmeHost {
    platform: dotnet,                         // mountsUi: true, kind: application
    contexts: [Sales],                        // serves Sales in-proc
    proxy:    [marketingApi],                 // proxies Marketing
    ui:       WebApp {
      Sales:     acmeHost,                    // ← host serves itself
      Marketing: marketingApi,
    },
    port: 5000,
  }
}
```

What gets generated (`acmeHost/appsettings.Production.json`):

```jsonc
{
  "ReverseProxy": {
    "Routes": {
      "marketing": {
        "ClusterId": "marketingApi",
        "Match": { "Path": "/api/marketing/{**catch-all}" }
      }
    },
    "Clusters": {
      "marketingApi": {
        "Destinations": {
          "primary": { "Address": "http://marketingApi:4001/" }
        }
      }
    }
  }
}
```

And in `Program.cs`,
`builder.Services.AddReverseProxy().LoadFromConfig(...)` plus
`app.MapReverseProxy()` — emitted by the dotnet
`PlatformSurface.emitProxyMounts` hook.

### Example 3 — .NET shop wants Ocelot as the gateway

Same shape as Example 1, but a .NET-shop team chooses Ocelot
instead of Caddy. Just a platform swap — no other DSL change.

```ddd
  deployable gateway {
    platform: ocelot,
    proxy:    [webApp, billingApi, inventoryApi],
    port: 80,
  }
```

Generated `gateway/ocelot.json`:

```jsonc
{
  "Routes": [
    {
      "DownstreamPathTemplate":   "/{everything}",
      "DownstreamScheme":         "http",
      "DownstreamHostAndPorts":   [{ "Host": "billingApi", "Port": 3001 }],
      "UpstreamPathTemplate":     "/api/billing/{everything}",
      "UpstreamHttpMethod":       [ "Get", "Post", "Put", "Delete" ]
    },
    {
      "DownstreamPathTemplate":   "/{everything}",
      "DownstreamScheme":         "http",
      "DownstreamHostAndPorts":   [{ "Host": "inventoryApi", "Port": 3002 }],
      "UpstreamPathTemplate":     "/api/inventory/{everything}",
      "UpstreamHttpMethod":       [ "Get", "Post", "Put", "Delete" ]
    },
    {
      "DownstreamPathTemplate":   "/{everything}",
      "DownstreamScheme":         "http",
      "DownstreamHostAndPorts":   [{ "Host": "webApp",     "Port": 3000 }],
      "UpstreamPathTemplate":     "/{everything}",
      "UpstreamHttpMethod":       [ "Get", "Post", "Put", "Delete" ]
    }
  ]
}
```

Plus a generated ASP.NET host project for the Ocelot binary
(small, just `UseOcelot()`); the gateway's `composeService`
points compose at that built image.

### Example 4 — Out-of-tree gateway package

A shop ships its own hardened nginx config as a Loom gateway.
They publish `@acme/proxy-nginx-hardened-v1` carrying:

```jsonc
// packages/proxy-nginx-hardened-v1/package.json
{
  "name": "@acme/proxy-nginx-hardened",
  "loom": {
    "kind": "gateway",
    "family": "nginx-hardened",
    "loomVersion": "1.0",
    "core": "^0.x"
  }
}
```

Users pin it the same way they'd pin a backend version:

```ddd
  deployable gateway {
    platform: nginx-hardened@v1,
    proxy:    [webApp, billingApi, inventoryApi],
    port: 80,
  }
```

No grammar change beyond the `family[@version]` parse already
used by `parseBuiltinPlatformRef` — `platform:` already accepts
this shape today.

### Example 5 — Pure static react, multiple backends, explicit CORS

Sometimes you want the SPA to talk straight to every backend
(small project, multi-tenant SaaS edge cache, etc.). No gateway,
no mounted host. The validator warns; you opt in by setting CORS
on each backend explicitly:

```ddd
  deployable salesApi {
    platform: hono, contexts: [Sales],
    cors: { allowOrigin: "https://app.acme.test" }, port: 3001
  }
  deployable marketingApi {
    platform: hono, contexts: [Marketing],
    cors: { allowOrigin: "https://app.acme.test" }, port: 3002
  }

  deployable webApp {
    platform: react,
    ui:       WebApp { Sales: salesApi, Marketing: marketingApi },
    port: 3000,
    // No proxy. SPA bundle gets per-backend base URLs at build.
  }
```

The `cors:` slot itself is out of scope for this plan but is the
natural companion — left here to show the explicit opt-in shape.

---

## Open questions

1. **Derive `proxy:` from `UiComposeBinding`, or keep both?**
   Deriving eliminates redundancy: if `ui: WebApp { Sales:
   salesApi, Billing: billingApi }` already lists every backend
   the SPA reaches, the host's `proxy:` is exactly
   `[salesApi, billingApi] − {self}`. Probably: derive when
   omitted, allow explicit, error on conflict. Decide before
   grammar lands.
2. **Gateway proxying a frontend deployable** (Example 1's
   `proxy: [webApp, ...]`). Routing the root `/` catch-all to a
   react bundle is sensible, but it asks the gateway to know
   "frontend = catch-all root, backend = `/api/<module>/*`."
   Worth a validator rule: at most one frontend per gateway
   `proxy:` list, and it always wins the catch-all slot.
3. **HTTPS at the gateway.** Caddy's killer feature is automatic
   TLS, but generated docker-compose shouldn't depend on ACME at
   dev-time. Default: HTTP-only in compose; TLS via a future
   deployable-level slot (out of scope here).
4. **WebSockets / SSE passthrough.** All gateway families
   support it with different config. Probably emit pass-through
   only when an `event` stream / `live` page is present in any
   proxied module — the route table already knows.
5. **Two-stage SPA boot (config endpoint).** Today the react
   bundle bakes its API base URL at build time. With a gateway,
   the answer is always "/api/..." same-origin, so this gets
   simpler. Worth documenting as a side benefit.

## Sequencing

If this lands, the suggested slice order keeps each step small:

0. **Delete `targets:` from grammar and IR.** Inheritance of
   `moduleNames` moves to be derived from `UiComposeBinding`
   sources. Existing examples (`web/src/examples/storefront-*`,
   `examples/acme.ddd`) migrate to UI-binding only. This is a
   pure cleanup — no new feature, just removes the redundant
   slot. Should be its own PR.
1. **Add `proxy:` (list) on application-platform deployables.**
   No gateway platforms yet. Validator: `proxy:` illegal on
   `react`. Enrichment derives `proxyRoutes` with
   `mode: 'mounted-in-host'`.
2. **`emitProxyMounts` on the hono surface** (smallest hop —
   `app.all + fetch`). Ship one e2e under `LOOM_E2E=1`.
3. **`emitProxyMounts` on the dotnet surface** (YARP).
4. **`emitProxyMounts` on the phoenix surface**
   (`ReverseProxyPlug`).
5. **Add `kind: "gateway"` to `PlatformSurface`**, register
   `caddy` as the first gateway platform. Switch one example to
   Shape B.
6. **Second gateway family — `nginx`** — to prove the kind is
   pluggable. Then `traefik`, then `ocelot`.
7. **Wire the out-of-tree `kind: "gateway"` resolver** in
   `fs-discovery.ts` once we have two in-tree families to
   pattern off.

Each step keeps `npm test` green and only one CI matrix cell
(`LOOM_E2E`, `LOOM_DOTNET_BUILD`, etc.) changes scope at a time.
