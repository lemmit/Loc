# Multi-target frontends — same-origin proxy story

> **Status:** approved proposal — implementation pending. Sibling
> of `../plans/backend-packages.md` (gateway platforms reuse the
> out-of-tree package story). Vocabulary scope (open question #1)
> is still genuinely open and will be re-decided during slice 6.

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
- **`->` precedent** — `link "Docs" -> "https://…"` view-link
  grammar (`ddd.langium:492`). Available for URL rewrites without
  introducing new arrow syntax.

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

## The design — `proxy { … }` block plus gateway platforms

Two ideas, both small, that compose.

### Idea 1 — `proxy { defaults, routes }` is a single block on the deployable

`proxy { routes: [billingApi, inventoryApi] }` says: *"this
deployable re-serves the listed deployables' apis at
`/api/<module>/*` on its own origin."* No family/worker knob —
the host platform decides the implementation. Defaults that
apply across routes live in `proxy.defaults { ... }`; per-route
overrides live in trailing `{ ... }` blocks on each route entry.
One subtree, no sibling slots.

| Host platform | Realization of `proxy { … }` |
|---|---|
| `dotnet` | **YARP** (`Yarp.ReverseProxy`) — routes loaded from `appsettings`, registered via `MapReverseProxy()`. |
| `hono` | `app.all('/api/billing/*', c => fetch(...))` — single handler per target. |
| `phoenixLiveView` | `ReverseProxyPlug` block on the Endpoint. |
| `react` | **Illegal.** React is pure static; validator error directing the user to a gateway or a mounted host. |

`proxy { … }` on a backend that already `serves:` something
layers cleanly: the deployable serves its own modules in-process
and proxies the rest.

### Idea 2 — Gateway platforms (`caddy`, `nginx`, `traefik`, `ocelot`)

These join `Platform` as **restricted-kind** platforms. A gateway
platform:

- **only** legalises `proxy { … }` (and `port:`),
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
`ui:`, and `proxy { … }`-fans-out the rest. In-process; no
sidecar.

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
backend via `ui: WebApp { Sales: salesApi }`. No `proxy { … }`
anywhere — there's nothing to fan out. If the SPA needs to talk
to >1 backend without a gateway or mounted host, the user opens
CORS on each backend explicitly. Validator gives a hint when
this shape appears with multiple UI bindings: *"this SPA reaches
multiple backends; consider a gateway deployable, mounting in a
backend, or set CORS explicitly on each backend."*

## Grammar surface

Minimal diff to `src/language/ddd.langium`. `targets:` is
removed; `proxy:` becomes a sub-block; the `Platform` enum
gains the gateway families.

```diff
  Deployable:
      'deployable' name=LooseName '{'
          ('platform' ':' platform=Platform ','?)
          ...
-         ('targets' ':' targets=[Deployable:LooseName] ','?)?
+         (proxy=ProxyBlock)?
          ...
      '}';

+ ProxyBlock:
+     'proxy' '{'
+         ('defaults' '{' defaults=ProxyPolicy '}')?
+         ('routes' ':' '[' routes+=ProxyRoute
+                          (',' routes+=ProxyRoute)* ','? ']')?
+     '}';
+
+ ProxyRoute:
+     target=[Deployable:LooseName]
+     ('{' policy=ProxyPolicy '}')?;
+
+ ProxyPolicy:
+     // slots from the vocabulary table; all optional
+     ('timeout'    ':' timeout=Duration  ','?)?
+     ('retry'      ':' retry=RetrySpec   ','?)?
+     ('auth'       ':' auth=AuthMode     ','?)?
+     ('rateLimit'  ':' rateLimit=Rate    ','?)?
+     ('path'       ':' rewriteFrom=STRING '->' rewriteTo=STRING ','?)?
+     ('websocket'  ':' websocket=Bool    ','?)?
+     ('headers'    '{' headers=HeadersBlock '}')?;

  Platform returns string:
      'hono' | 'dotnet' | 'react' | 'phoenixLiveView'
+   | 'caddy' | 'nginx' | 'traefik' | 'ocelot';
```

The `headers { add NAME: "v", remove NAME, forward NAME }`
sub-block reuses the verb-prefixed declaration pattern of
`permissions { decls+= … }` — verbs front each row, no
JS-flavoured dotted keys.

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
| `loom.proxy-on-static` | `proxy { … }` set on `platform: react` (or any platform with `kind === 'static'` in the surface — to be defined). |
| `loom.proxy-module-collision` | Two entries in `proxy.routes` claim the same module name. |
| `loom.proxy-not-backend-or-static` | An entry in `proxy.routes` is itself a gateway (gateways proxying gateways is allowed but suspicious — start as a warning). |
| `loom.ui-binding-not-proxied` | A `UiComposeBinding.source` isn't the host itself, not in `proxy.routes`, and the host isn't a gateway exposing it. (Probably: derive instead of require — see open question.) |
| `loom.gateway-no-domain-slots` | `platform: caddy/nginx/…` deployable has `contexts:`, `serves:`, `ui:`, or `dataSources:`. |
| `loom.spa-fanout-no-gateway` | Warning. `platform: react` deployable's `ui:` binds >1 distinct source deployable and no gateway fronts it. |
| `loom.proxy-policy-on-static` | Policy block on a route whose host is static. |
| `loom.proxy-path-rewrite-shadow` | A `path: "/x" -> "/y"` rewrite whose source overlaps another route's prefix in the same `proxy.routes` list. |
| `loom.proxy-auth-unknown` | `auth:` value isn't in the existing `AuthMode` enum. |
| `loom.proxy-rate-limit-unit` | `rateLimit:` window isn't `s`/`min`/`h`. |
| `loom.proxy-header-forward-conflict` | Header listed in both `add` and `forward` for the same route. |
| `loom.proxy-slot-unsupported` | A policy slot is used that the resolved gateway's `PlatformSurface.proxySlots` doesn't include. |

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
  readonly mode:   'mounted-in-host' | 'gateway';
  readonly routes: readonly ProxyRouteIR[];
};

type ProxyRouteIR = {
  prefix:   string;          // "/api/billing" or "/"
  target:   string;          // compose service name
  port:     number;
  module?:  string;          // present for api routes
  policy:   ProxyPolicyIR;   // empty {} when bare-ref
};

type ProxyPolicyIR = {
  timeoutMs?:  number;
  retries?:    { count: number; backoff?: 'fixed' | 'exponential' };
  auth?:       AuthMode;
  rateLimit?:  { count: number; window: 's' | 'min' | 'h' };
  pathRewrite?:{ from: string; to: string };
  headers?: {
    add?:     readonly { name: string; value: string }[];
    remove?:  readonly string[];
    forward?: readonly string[];
  };
  websocket?: boolean;
};
```

Derivation rules:

- `mode = 'gateway'` when host `PlatformSurface.kind === 'gateway'`;
  otherwise `'mounted-in-host'` (and only present when
  `proxy.routes` is non-empty).
- For each `target ∈ proxy.routes`:
  - If the target is a backend, for each
    `module ∈ target.moduleNames` emit
    `{ prefix: '/api/' + kebab(module), target, port, module }`.
  - If the target is a frontend (only legal on gateway hosts),
    emit a single root catch-all route `{ prefix: '/', target,
    port }`. This is how a gateway proxies the static SPA itself.
- The host's *own* modules don't get a proxy route — they're
  served in-process (for `mounted-in-host` mode only).
- `proxy.defaults` is merged into each route's `policy` (route
  values win on conflict), so backends never have to walk a
  default chain.
- Order of `routes` is significant: api prefixes before the root
  catch-all. Enrichment guarantees the sort.

The compose builder reads `proxyRoutes` and either:

- **`mounted-in-host`** → delegates to the host's
  `PlatformSurface.emitProxyMounts(routes)`.
- **`gateway`** → calls the gateway's
  `PlatformSurface.emitProject({ routes, listenPort })`.

## `PlatformSurface` contract diff

Three additions to `src/platform/surface.ts`:

```ts
export interface PlatformSurface {
  // ...existing...

  /** Discriminator. Existing surfaces are 'application'. */
  readonly kind: 'application' | 'gateway';

  /**
   * Vocabulary the surface claims to translate. Validator uses
   * this to give "your gateway doesn't support `rateLimit`"-
   * style diagnostics before code-gen runs.
   */
  readonly proxySlots: ReadonlySet<
    'timeout' | 'retry' | 'auth' | 'rateLimit'
    | 'path' | 'headers' | 'websocket'
  >;

  /**
   * Optional. Called once per application host whose deployable
   * has a non-empty `proxy.routes`. The host emits same-origin
   * reverse-proxy routes for every listed target using its
   * platform-native idiom.
   */
  readonly emitProxyMounts?: (
    routes: readonly ProxyRouteIR[],
    ctx:    HostEmitCtx,
  ) => void;
}
```

Gateway surfaces implement the existing `emitProject` /
`composeService` interface — they don't need a separate
`ProxySurface` type.

Registration mirrors `backend-packages.md`. In-tree gateways
land in `src/platform/<family>.ts`, register in
`src/platform/registry.ts`. Out-of-tree gateways land in
`packages/proxy-<family>-v<N>/` with
`loom: { kind: "gateway", family, loomVersion, core }`;
`fs-discovery.ts` already iterates packages — teach it the
`"gateway"` kind alongside `"backend"`.

---

## Proxy policy DSL

The route map is **free** — derived in enrichment from
`proxy.routes` + each target's `moduleNames` + `port`. The DSL
only has to express what Loom can't infer: **per-route policy**
(timeouts, auth, retries, header handling) and a small set of
cross-cutting concerns that every reverse proxy needs to express
the same way across families.

### Surface shape — one block, defaults inside, routes inside

```ddd
deployable gateway {
  platform: caddy,
  port:     80,

  proxy {
    defaults {
      timeout: 5s
      auth:    public
    }

    routes: [
      billingApi,                            // inherits defaults

      inventoryApi {
        timeout: 30s                         // long-poll endpoint
        auth:    jwt
      },

      legacyApi {
        path:    "/api/legacy" -> "/v1"      // URL rewrite
        headers {
          add     X-Source:   "gateway"
          remove  X-Internal-Trace
          forward X-Request-Id
          forward Authorization
        }
        rateLimit: 100/min
      },

      webApp,                                // root catch-all, no policy
    ]
  }
}
```

Two syntactic decisions worth flagging:

- **`->` for rewrites** matches the existing `link "Docs" ->
  "https://…"` view-link grammar. Not the lambda/match `=>`.
- **`headers { add X: "v", remove Y, forward Z }`** is a verb-
  prefixed nested block, the same shape as `permissions {
  decls+= ... }`. Keeps add/remove/forward in one place and
  avoids the JS-flavoured `headers.add:` form.

### Vocabulary

Small, fixed, platform-neutral. Each slot translates cleanly to
all four gateway families (Caddy / nginx / YARP / Ocelot) and to
the in-process backends (hono / dotnet / phoenix). Anything that
doesn't translate cleanly stays out of the typed vocabulary and
moves to the escape hatch (see below).

| Slot | Syntax | Meaning |
|---|---|---|
| `timeout` | `timeout: 5s` | Upstream request timeout. Per route. |
| `retry` | `retry: 3` *or* `retry: exponential(3)` | Retry count, optionally with a named backoff. |
| `auth` | `auth: <AuthMode>` | Reuses existing `AuthMode` enum (`public`/`jwt`/`basic`/…). Gateway terminates auth before forwarding; verified principal flows on. |
| `rateLimit` | `rateLimit: 100/min` | Throughput cap. Units: `s`/`min`/`h`. |
| `path` | `path: "/api/legacy" -> "/v1"` | URL rewrite. Quoted strings; ASCII arrow. |
| `headers { … }` | nested block; `add NAME: "value"`, `remove NAME`, `forward NAME` | Explicit header policy. |
| `websocket` | `websocket: true` | Allow WS/SSE upgrade. Default auto-detects from `event` / `live` in the proxied modules. |

### Per-platform translation — one slot end to end

`timeout: 30s` on the `inventoryApi` route compiles to:

- **Caddy** (`gateway/Caddyfile`):
  ```caddy
  handle /api/inventory/* {
    reverse_proxy inventoryApi:3002 {
      transport http { read_timeout 30s }
    }
  }
  ```
- **YARP** (`acmeHost/appsettings.json`):
  ```jsonc
  "Routes": {
    "inventory": {
      "ClusterId": "inventoryApi",
      "Match":   { "Path": "/api/inventory/{**catch-all}" },
      "Timeout": "00:00:30"
    }
  }
  ```
- **nginx** (`gateway/nginx.conf`):
  ```nginx
  location /api/inventory/ {
    proxy_pass         http://inventoryApi:3002/;
    proxy_read_timeout 30s;
  }
  ```
- **Hono** (in-process, `acmeHost/src/proxy/inventory.ts`):
  ```ts
  app.all('/api/inventory/*', async c => {
    const signal   = AbortSignal.timeout(30_000);
    const upstream = new URL(c.req.path, 'http://inventoryApi:3002');
    return fetch(upstream, { method: c.req.method, body: c.req.raw.body, signal });
  });
  ```
- **Phoenix** (`acmeHost/lib/.../endpoint.ex`):
  ```elixir
  plug ReverseProxyPlug,
    upstream:       "http://inventoryApi:3002",
    response_mode:  :stream,
    client_options: [recv_timeout: 30_000]
  ```

The IR carries `timeoutMs: 30_000`; each surface knows how to
spell it.

### Escape hatch — override files, not DSL

The typed vocabulary above intentionally captures the 80%
case. The other 20% — Caddy `@matcher` blocks, nginx
`proxy_buffer_size` tuning, YARP custom `Transforms` beyond
path/headers, OAuth token introspection, mTLS to upstreams — is
**family-specific** by definition. Rather than carry it into
the DSL as `raw <family> { … }` blocks, we lean on every gateway
family's own include / layered-config mechanism. The user drops
a sidecar file next to the generated one and the proxy merges
them at boot. **Loom never touches the override file.**

| Family | Include mechanism | Generated → emits | User edits |
|---|---|---|---|
| Caddy | `import` directive | `gateway/Caddyfile` ends with `import conf.d/*.caddy` | `gateway/conf.d/*.caddy` |
| nginx | `include` directive | `gateway/nginx.conf` ends with `include conf.d/*.conf;` | `gateway/conf.d/*.conf` |
| Traefik | file-provider directory | provider config points at `gateway/dynamic/` | `gateway/dynamic/*.yml` |
| Ocelot | `AddOcelot()` env-layering | `gateway/ocelot.json` + autoload `ocelot.user.json` | `gateway/ocelot.user.json` |
| YARP (dotnet host) | ASP.NET config layering | `acmeHost/appsettings.Generated.json` + autoload `appsettings.User.json` | `acmeHost/appsettings.User.json` |
| Hono (in-process) | conditional dynamic import | host code does `if (existsSync('./proxy.user.ts')) await import(...)` | `acmeHost/src/proxy/proxy.user.ts` |
| Phoenix (in-process) | conditional require in endpoint | endpoint conditionally imports `proxy_user.ex` | `acmeHost/lib/.../proxy_user.ex` |

Each `PlatformSurface` declares its override-file path(s) and
the include-line / autoload shim it has to emit. The generator
emits the shim; the user creates and version-controls the
override file. **Everything else falls out:**

- **Source stays portable** — the override file lives in the
  output tree, not in `.ddd`. Swapping `platform: caddy → nginx`
  changes the generated `Caddyfile` to an `nginx.conf` and
  switches which override file the user has. Their previous
  override stays in git history; switching means rewriting it
  for the new family (which is true today and not avoidable —
  the directives are different).
- **Full LSP / linting for the override** — the user is editing
  a real `.caddy` / `.conf` / `.json` / `.ts` / `.ex` file with
  whatever tooling already exists for that family. Loom doesn't
  have to host a second grammar.
- **Eject path is trivial** — delete the include line, copy the
  generated content into your own file, you own the whole thing.
  Same shape as `eject` in any scaffolding tool.
- **Per-route overrides** are family-native — Caddy users add a
  `handle /api/reports/*` block in `conf.d/`; nginx users add a
  matching `location /api/reports/`. The override file's
  directives win because they're loaded after the generated
  block (each family's standard precedence).
- **No new DSL surface** — no grammar additions, no validator
  rules for raw blocks, no IR fields for splicing, no per-family
  splice-point contract on `PlatformSurface`. The whole escape
  hatch is a generator-side convention.

The minimal v1 commits to:

1. Each `PlatformSurface` (application + gateway) defines
   `proxyOverridePath: string | string[]` and the include /
   autoload shim string it must emit.
2. Generator emits the shim **always** for any deployable that
   has a `proxy { … }` block — even when the user hasn't
   created the override file yet, so the path is documented and
   ready.
3. Override files are listed in `.loomignore` defaults so
   `ddd generate` never overwrites them.
4. `docs/tools.md` gets a per-family table of "where to put your
   overrides" mirroring the table above.

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
    platform: node,            contexts: [Billing],   port: 3001
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
    port:     80,
    proxy {
      routes: [webApp, billingApi, inventoryApi]
    }
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
    platform: node, contexts: [Marketing], port: 4001
  }

  deployable acmeHost {
    platform: dotnet,                         // mountsUi: true, kind: application
    contexts: [Sales],                        // serves Sales in-proc
    port:     5000,
    proxy {
      routes: [marketingApi]
    },
    ui:       WebApp {
      Sales:     acmeHost,                    // ← host serves itself
      Marketing: marketingApi,
    },
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
    port:     80,
    proxy {
      routes: [webApp, billingApi, inventoryApi]
    }
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
    "kind":        "gateway",
    "family":      "nginx-hardened",
    "loomVersion": "1.0",
    "core":        "^0.x"
  }
}
```

Users pin it the same way they'd pin a backend version:

```ddd
  deployable gateway {
    platform: nginx-hardened@v1,
    port:     80,
    proxy {
      routes: [webApp, billingApi, inventoryApi]
    }
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
    platform: node, contexts: [Sales],
    cors: { allowOrigin: "https://app.acme.test" }, port: 3001
  }
  deployable marketingApi {
    platform: node, contexts: [Marketing],
    cors: { allowOrigin: "https://app.acme.test" }, port: 3002
  }

  deployable webApp {
    platform: react,
    ui:       WebApp { Sales: salesApi, Marketing: marketingApi },
    port: 3000,
    // No proxy block. SPA bundle gets per-backend base URLs at build.
  }
```

The `cors:` slot itself is out of scope for this proposal but is
the natural companion — left here to show the explicit opt-in
shape.

### Example 6 — Policy in anger: long-poll, legacy URL, header forwarding

A `dotnet` host mounting the SPA, serving Sales in-process, and
proxying three sibling services — each with non-default policy.
Demonstrates per-route overrides, gateway-level defaults, the
URL rewrite arrow, and the `headers { … }` verb block.

```ddd
deployable acmeHost {
  platform: dotnet,
  contexts: [Sales],
  port:     5000,

  proxy {
    defaults {
      timeout: 5s
      auth:    jwt                            // SPA's session → forwarded
    }

    routes: [
      billingApi,                             // 5s timeout, jwt auth

      inventoryApi {
        timeout:   30s                        // long-poll endpoint
        websocket: true                       // stock-level SSE stream
      },

      legacyReportingApi {
        path: "/api/reports" -> "/v1/legacy"  // upstream still on v1
        headers {
          add     X-Tenant:    "acme"
          remove  X-Internal-Trace
          forward Authorization
          forward X-Request-Id
        }
        retry:     3
        rateLimit: 60/min                     // legacy is fragile
      },
    ]
  },

  ui: WebApp {
    Sales:     acmeHost,
    Billing:   billingApi,
    Inventory: inventoryApi,
    Reporting: legacyReportingApi,
  },
}
```

Generated `acmeHost/appsettings.Production.json` (YARP, abridged):

```jsonc
{
  "ReverseProxy": {
    "Routes": {
      "billing": {
        "ClusterId": "billingApi",
        "Match":   { "Path": "/api/billing/{**catch-all}" },
        "Timeout": "00:00:05",
        "AuthorizationPolicy": "jwt"
      },
      "inventory": {
        "ClusterId": "inventoryApi",
        "Match":   { "Path": "/api/inventory/{**catch-all}" },
        "Timeout": "00:00:30",
        "AuthorizationPolicy": "jwt"
      },
      "reporting": {
        "ClusterId": "legacyReportingApi",
        "Match":   { "Path": "/api/reports/{**catch-all}" },
        "Timeout": "00:00:05",
        "AuthorizationPolicy": "jwt",
        "RateLimiterPolicy":   "per-min-60",
        "Transforms": [
          { "PathPattern":   "/v1/legacy/{**catch-all}" },
          { "RequestHeader": "X-Tenant",         "Set":    "acme" },
          { "RequestHeader": "X-Internal-Trace", "Remove": true   },
          { "RequestHeader": "Authorization",    "Append": "{Headers.Authorization}" },
          { "RequestHeader": "X-Request-Id",     "Append": "{Headers.X-Request-Id}" }
        ]
      }
    }
  }
}
```

Same .ddd, `platform: caddy` swap → `Caddyfile`:

```caddy
:5000 {
  jwt { ... }                                  # gateway-level auth

  handle /api/billing/* {
    reverse_proxy billingApi:3001 {
      transport http { read_timeout 5s }
    }
  }

  handle /api/inventory/* {
    reverse_proxy inventoryApi:3002 {
      transport http { read_timeout 30s }
    }
  }

  handle /api/reports/* {
    rate_limit { events 60, window 1m }
    request_header X-Tenant         "acme"
    request_header -X-Internal-Trace
    uri replace /api/reports /v1/legacy
    reverse_proxy legacyReportingApi:3003 {
      transport http { read_timeout 5s }
      lb_try_duration 3s
    }
  }
}
```

Same source, two very different deployment targets. The policy
intent is preserved; the spelling isn't.

### Example 7 — Override file for nginx-specific buffer tuning

The SPA is fine on every platform, but one upstream returns
multi-megabyte JSON payloads and the team is committed to nginx.
They reach for the override-file escape hatch — no DSL change at
all.

```ddd
deployable gateway {
  platform: nginx,
  port:     80,
  proxy {
    routes: [webApp, billingApi, reportingApi { timeout: 60s }]
  }
}
```

Generator emits `gateway/nginx.conf` ending with:

```nginx
include /etc/nginx/conf.d/*.conf;
```

The team creates `gateway/conf.d/reporting-buffers.conf`:

```nginx
location /api/reporting/ {
  proxy_buffer_size       128k;
  proxy_buffers           4 256k;
  proxy_busy_buffers_size 256k;
  proxy_pass              http://reportingApi:3003/;
  proxy_read_timeout      60s;
}
```

nginx's normal precedence rules pick the more-specific block; the
team gets full nginx tooling for their override (linting,
formatting, syntax highlighting); Loom never re-runs the
override on `ddd generate`. Switching to `platform: caddy`
later: delete `conf.d/`, write `Caddyfile.d/` equivalents.
Same effort as today, but the *Loom* surface stays unchanged.

---

## Open questions

The biggest question is **whether to ship this vocabulary at
all** — and if so, how much of it. The DSL framing makes some
choices look obvious that aren't:

1. **Are we sure we want to express *all* of `timeout` / `retry`
   / `rateLimit` / `auth` / `path` / `headers` / `websocket` in
   the typed vocabulary?** Each one widens the conformance
   surface across four gateway families plus three in-process
   backends. A defensible minimal cut is **`timeout` +
   `headers` + `websocket` typed, everything else via the
   escape hatch** for v1. That's the question we explicitly
   want to revisit before code lands.
2. **Derive `proxy.routes` from `UiComposeBinding`, or keep
   both?** Deriving eliminates redundancy: if `ui: WebApp {
   Sales: salesApi, Billing: billingApi }` already lists every
   backend the SPA reaches, the host's `proxy.routes` is
   exactly `[salesApi, billingApi] − {self}`. Probably:
   derive when omitted, allow explicit, error on conflict.
3. **Gateway proxying a frontend deployable** (Example 1's
   `routes: [webApp, ...]`). Routing the root `/` catch-all to
   a react bundle is sensible, but it asks the gateway to know
   "frontend = catch-all root, backend = `/api/<module>/*`."
   Worth a validator rule: at most one frontend per gateway
   `proxy.routes` list, and it always wins the catch-all slot.
4. **HTTPS at the gateway.** Caddy's killer feature is automatic
   TLS, but generated docker-compose shouldn't depend on ACME
   at dev-time. Default: HTTP-only in compose; TLS via a future
   deployable-level slot.
5. **WebSockets / SSE passthrough auto-detection.** All gateway
   families support it with different config. Probably emit
   pass-through only when an `event` stream / `live` page is
   present in any proxied module — the route table already
   knows.
6. **Two-stage SPA boot (config endpoint).** Today the react
   bundle bakes its API base URL at build time. With a gateway,
   the answer is always "/api/..." same-origin, so this gets
   simpler. Worth documenting as a side benefit.
7. **Auth reuse vs. distinct route-level `auth:`.** Reusing the
   existing `AuthMode` enum is the obviously right surface, but
   the semantics on a proxied route are stronger: "the
   gateway/host terminates auth and forwards a verified
   principal", not "pass through and let the upstream decide."
   Decide and document this explicitly before code lands; the
   implementation work behind "terminates and forwards" is
   meaningfully larger (JWT verification key sources, principal
   propagation header conventions) than behind "passes through".
8. **`retry: 3` vs. `retry: exponential(3)`.** Bare integer is
   the 90% case; the function form is what you reach for when
   you actually care. Defer the function form until the first
   user asks.
9. **`platform: react` + a CSP `proxy.headers` block.** The SPA
   has no server-side proxy, but the static-serving step (the
   react surface's `emitProject`) could honour a `headers { add
   Content-Security-Policy: "…" }` block applied to every
   response. That's a different feature than this proposal
   addresses; worth a cross-ref but not in v1.

## Sequencing

If this lands, the suggested slice order keeps each step small:

0. **Delete `targets:` from grammar and IR.** Inheritance of
   `moduleNames` moves to be derived from `UiComposeBinding`
   sources. Existing examples (`web/src/examples/storefront-*`,
   `examples/acme.ddd`) migrate to UI-binding only. This is a
   pure cleanup — no new feature, just removes the redundant
   slot. Should be its own PR.
1. **Add `proxy { routes: [...] }` block on application-platform
   deployables.** No `defaults`, no policy, no `raw` yet — just
   the block and the route list. Validator: `proxy` illegal on
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
6. **Add `proxy.defaults { … }` + the minimal typed vocabulary**
   (`timeout`, `headers`, `websocket`). Defer `retry` /
   `rateLimit` / `auth` / `path` until the open-question
   review.
7. **Emit the override-file include shim** from every gateway
   and every mounted-host surface, with their override paths
   listed in `.loomignore`. `docs/tools.md` gains a per-family
   override-path table.
8. **Second gateway family — `nginx`** — to prove the kind is
   pluggable. Then `traefik`, then `ocelot`. Each one
   declares `proxySlots` honestly.
9. **Wire the out-of-tree `kind: "gateway"` resolver** in
   `fs-discovery.ts` once we have two in-tree families to
   pattern off.
10. **Revisit the open-question list** before adding the
    deferred typed slots (`retry`, `rateLimit`, `auth`, `path`).
    Some may stay override-file-only — that's a fine landing
    point.

Each step keeps `npm test` green and only one CI matrix cell
(`LOOM_E2E`, `LOOM_DOTNET_BUILD`, etc.) changes scope at a time.
