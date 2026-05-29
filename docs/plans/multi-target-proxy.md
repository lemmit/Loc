# Multi-target frontends — same-origin proxy story

> **Status:** design proposal for review. No code yet. Sibling of
> `backend-packages.md` (the proxy ends up being a third
> `PlatformSurface` kind, so the package story carries over).

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
  collision check (two targeted backends both claiming module
  `Billing`) falls out for free.

What's missing:

- `targets:` is single-valued; should be a list. Or — cleaner —
  **derive it from `UiComposeBinding.bindings.source[]`** and stop
  asking the user to repeat themselves.
- No IR field for "this UI calls these backends via these route
  prefixes."
- No `PlatformSurface` hook for emitting reverse-proxy config.
- No proxy-family registry for the standalone case.

## The design — two shapes, one IR

The host platform decides which shape applies; the IR is the same.

### Shape A — UI mounted into a backend (`mountsUi: true`)

The hosting backend already terminates the browser's same-origin
requests. It serves the SPA bundle from `/` (or wherever), serves
its own contracts at `/api/<own-module>/*`, and gains
reverse-proxy routes for the *other* targeted backends:

```
                ┌────────────────────┐
   browser ───▶ │ dotnetHost          │
                │  /                  │ → static SPA
                │  /api/sales/*       │ → handled in-proc
                │  /api/billing/*     │ ──▶ billingApi (hono)
                │  /api/inventory/*   │ ──▶ inventoryApi (phoenix)
                └────────────────────┘
```

Each platform already has an idiomatic in-process proxy:

| Host | In-process proxy |
|---|---|
| `dotnet` | **YARP** (`Yarp.ReverseProxy`) — route map in `appsettings`/code, native ASP.NET middleware. |
| `hono` | `app.all('/api/billing/*', c => fetch(...))` — single handler. |
| `phoenixLiveView` | `ReverseProxyPlug` (or a thin Plug that pipes `Req`→`Finch`). |
| `react` | n/a (no server). |

No `proxy:` knob to choose — the host's `PlatformSurface` knows
its own idiom. Power users can override on the host's family slot
later (`dotnet { proxy: ocelot }`) without changing the surface
contract.

### Shape B — UI is its own deployable (host platform `react`)

The react deployable is a separate compose service that serves the
bundle. To stay same-origin, it grows a proxy responsibility — but
the SPA-server itself doesn't speak proxy. So the deployable's
compose service is **(static server + reverse proxy)**, realized
by a chosen proxy family:

```
                ┌────────────────────┐
   browser ───▶ │ webApp (react)      │
                │  caddy (or chosen)  │
                │   /              ──▶│ static SPA
                │   /api/sales/*   ──▶│──▶ salesApi (hono)
                │   /api/billing/* ──▶│──▶ billingApi (dotnet)
                └────────────────────┘
```

This is where `proxy:` becomes a real choice:

- `proxy: caddy` (default) — single-binary, terse config, can
  also serve the static bundle.
- `proxy: nginx` — incumbent.
- `proxy: traefik` — label-driven, plays well with docker swarm.
- `proxy: ocelot` — for .NET-shop developers running a separate
  gateway tier.
- `proxy: none` — opt back into raw CORS (rare, but supported).

Each `proxy: <family>` is a `PlatformSurface` of `kind: "proxy"`
— same out-of-tree story as backends (`backend-packages.md`), so
a shop can ship `packages/proxy-yarp-v1/` and target it by
`proxy: yarp@v1`.

## Grammar surface

Minimal diff to `src/language/ddd.langium`. `targets:` becomes a
list; `proxy:` is added; both are optional.

```diff
  Deployable:
      'deployable' name=LooseName '{'
          ('platform' ':' platform=Platform ','?)
          ...
-         ('targets' ':' targets=[Deployable:LooseName] ','?)?
+         ('targets' ':' '[' targets+=[Deployable:LooseName]
+                             (',' targets+=[Deployable:LooseName])* ','? ']' ','?)?
+         ('proxy'   ':' proxy=ProxyFamily ','?)?
          ...
      '}';

+ ProxyFamily returns string:
+     'caddy' | 'nginx' | 'traefik' | 'ocelot' | 'none';
```

Singular sugar (`targets: api`) stays via a grammar alternation —
not shown in the diff, but trivial:
`('targets' ':' (targets+=[Deployable] | '[' ... ']') ','?)?`.

Validator additions (`src/language/validators/deployable.ts` +
`src/ir/validate/validate.ts`):

1. `proxy:` is only valid when host platform's `mountsUi` is true
   **and** the host is `react` (i.e. shape B). On a mounted host
   it's a hard error — the in-process idiom isn't pluggable here.
2. Every `targets:` entry must be a backend deployable
   (`platform` is non-frontend).
3. `moduleNames` across `targets:` must be disjoint — two
   backends can't both own `Billing`. Suggested diagnostic code:
   `loom.proxy-module-collision`.
4. Every `UiComposeBinding.bindings.source` must appear in
   `targets:`. (Better: derive `targets:` from the bindings and
   reject explicit `targets:` when both are present. Open
   question — see below.)

## IR shape

One enrichment field per UI-hosting deployable, added in phase ⑥
(`src/ir/enrich/enrichments.ts`):

```ts
// On EnrichedDeployableIR — only when mountsUi
readonly proxyRoutes?: {
  readonly mode: 'mounted-in-host' | 'standalone';
  readonly family?: ProxyFamily;            // standalone only
  readonly routes: readonly {
    readonly prefix:  string;               // e.g. "/api/billing"
    readonly target:  string;               // service name in compose
    readonly port:    number;
    readonly module:  string;               // for traceability
  }[];
};
```

Derivation is mechanical:

- `mode` = `'mounted-in-host'` if the host's `PlatformSurface.mountsUi`
  is true and the host is *not* `react`; `'standalone'` otherwise.
- For each `target ∈ targets[]` that is *not* the host itself:
  - for each `module ∈ target.moduleNames`:
    - emit `{ prefix: '/api/' + kebab(module), target: target.serviceName, port: target.port, module }`.
- The host's *own* modules don't get a proxy route — they're
  served in-process.

The compose builder
(`src/system/compose.ts` — wherever the docker-compose YAML lives)
reads `proxyRoutes` and either:

- **mounted-in-host:** delegates to the host's
  `PlatformSurface.emitProxyMounts(routes)` — emits YARP routes
  into `appsettings.json` for .NET, adds `app.all(...)` handlers
  to the hono router, or a `ReverseProxyPlug` block to the Phoenix
  endpoint.
- **standalone:** picks the proxy family's `PlatformSurface` and
  calls `emitProject({ routes, staticRoot })` — Caddy emits a
  `Caddyfile`; nginx emits `nginx.conf`; etc.

## `PlatformSurface` contract diff

Two small additions to `src/platform/surface.ts`:

```ts
export interface PlatformSurface {
  // ...existing...

  /**
   * Optional. Called once per mounted UI host whose deployable
   * targets more than one backend. The host emits same-origin
   * reverse-proxy routes for every target other than itself.
   * Only called when `mountsUi && kind === 'backend'`.
   */
  readonly emitProxyMounts?: (
    routes: readonly ProxyRoute[],
    ctx: HostEmitCtx,
  ) => void;
}

// And a new kind:
export interface ProxySurface extends Omit<PlatformSurface, 'mountsUi'> {
  readonly kind: 'proxy';
  readonly family: 'caddy' | 'nginx' | 'traefik' | 'ocelot';
  readonly emitProject: (input: {
    routes: readonly ProxyRoute[];
    staticRoot: string;             // path inside container
    listenPort: number;
  }) => Map<string, string>;
  readonly composeService: (...) => DockerComposeService;
}
```

Registration mirrors `backend-packages.md`:
`packages/proxy-<family>-v<N>/package.json` with
`loom: { kind: "proxy", family, loomVersion, core }`.
`src/platform/fs-discovery.ts` already iterates packages; teach it
the `"proxy"` kind alongside `"backend"`.

---

## Examples

These are the deliverable — what users actually write.

### Example 1 — Standalone UI, two backends, default Caddy proxy

The bread-and-butter case. SPA hosted as its own compose service;
talks to a Hono billing API and a Phoenix inventory API. The
developer writes nothing about the proxy — Caddy is the default.

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
    platform: hono,    contexts: [Billing],   port: 3001
  }
  deployable inventoryApi {
    platform: phoenixLiveView, contexts: [Inventory], port: 3002
  }

  deployable webApp {
    platform: react,
    targets:  [billingApi, inventoryApi],     // ← plural
    ui:       WebApp {
      Billing:   billingApi,
      Inventory: inventoryApi,
    },
    port: 3000,
  }
}
```

What gets generated:

- React bundle calls `/api/billing/*` and `/api/inventory/*`
  same-origin — no CORS, no per-service base URLs in the JS.
- `webApp/Caddyfile`:
  ```caddy
  :3000 {
    handle /api/billing/*    { reverse_proxy billingApi:3001 }
    handle /api/inventory/*  { reverse_proxy inventoryApi:3002 }
    handle { root * /srv ; file_server ; try_files {path} /index.html }
  }
  ```
- `docker-compose.yml`: `webApp` service now uses the
  `caddy:2-alpine` image with the built SPA mounted at `/srv` and
  the Caddyfile mounted at `/etc/caddy/Caddyfile`.

### Example 2 — .NET host mounts the SPA + YARP-proxies a sibling Hono API

Mixed stack. The dotnet deployable serves Sales itself, mounts the
SPA, and proxies `/api/marketing/*` to a Hono service. No proxy
sidecar — YARP runs inside the .NET process.

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
    platform: dotnet,                         // mountsUi: true
    contexts: [Sales],                        // serves Sales in-proc
    targets:  [marketingApi],                 // proxies Marketing
    ui:       WebApp {
      Sales:     acmeHost,                    // ← host serves itself
      Marketing: marketingApi,
    },
    port: 5000,
    // NB: no `proxy:` slot — illegal on a mounted host (validator).
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

And in `Program.cs` the `acmeHost` project picks up
`builder.Services.AddReverseProxy().LoadFromConfig(...)` plus
`app.MapReverseProxy()` — emitted by the dotnet
`PlatformSurface.emitProxyMounts` hook.

### Example 3 — Standalone UI, .NET shop wants Ocelot

Same shape as Example 1, but the team standardises on Ocelot for
all gateways across the org. The override is a single line.

```ddd
  deployable webApp {
    platform: react,
    targets:  [billingApi, inventoryApi],
    ui:       WebApp { Billing: billingApi, Inventory: inventoryApi },
    proxy:    ocelot,                         // ← override
    port: 3000,
  }
```

Generated `webApp/ocelot.json`:

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
    }
  ]
}
```

Plus a tiny `Program.cs` Ocelot host + an nginx-or-caddy sidecar
fronting the static bundle (one Ocelot family has two flavours:
`ocelot+caddy` for static, or `ocelot-static` which serves files
itself via a small ASP.NET host — open question which we ship as
default).

### Example 4 — Out-of-tree proxy package

A shop ships its own hardened nginx config as a Loom proxy. They
publish `@acme/proxy-nginx-hardened-v1` carrying:

```jsonc
// packages/proxy-nginx-hardened-v1/package.json
{
  "name": "@acme/proxy-nginx-hardened",
  "loom": {
    "kind": "proxy",
    "family": "nginx-hardened",
    "loomVersion": "1.0",
    "core": "^0.x"
  }
}
```

Users pin it the same way they'd pin a backend version:

```ddd
  deployable webApp {
    platform: react,
    targets:  [billingApi, inventoryApi],
    ui:       WebApp { Billing: billingApi, Inventory: inventoryApi },
    proxy:    nginx-hardened@v1,
    port: 3000,
  }
```

No grammar change beyond the `family[@version]` parse already used
by `parseBuiltinPlatformRef` — the proxy slot accepts the same
shape as `platform:` does today.

### Example 5 — Opting out (`proxy: none`)

The "I know what I'm doing" escape hatch. Browser talks to each
backend directly; each backend opens CORS. Generated code emits
the per-backend base URLs into the bundle's runtime config and
adds CORS middleware to each targeted backend.

```ddd
  deployable webApp {
    platform: react,
    targets:  [publicApi],                    // single public API only
    ui:       WebApp { Public: publicApi },
    proxy:    none,
    port: 3000,
  }
```

Validator warns (not errors) when `proxy: none` is combined with
more than one target: "consider `proxy: caddy` for same-origin
fan-out; raw CORS to multiple backends is supported but rarely
what you want."

---

## Validator catalogue

New diagnostic codes (`loom.*`), all in
`src/language/validators/deployable.ts` or
`src/ir/validate/validate.ts`:

| Code | Rule |
|---|---|
| `loom.proxy-on-mounted-host` | `proxy:` set on a deployable whose host platform has `mountsUi: true` and is not `react`. |
| `loom.proxy-module-collision` | Two entries in `targets:` claim the same module name. |
| `loom.targets-not-backend` | An entry in `targets:` is itself a frontend. |
| `loom.ui-binding-not-in-targets` | A `UiComposeBinding.source` isn't listed in `targets:`. |
| `loom.proxy-none-multi-target` | Warning (not error). |

## Open questions

1. **Derive `targets:` from `UiComposeBinding`, or keep both?**
   Deriving eliminates redundancy and an entire class of
   inconsistency bugs. Keeping both lets a deployable target a
   backend that the UI doesn't (yet) bind — useful while
   evolving. Probably: derive when omitted, allow explicit, error
   on conflict. Decide before grammar lands.
2. **Where does the Caddy default sit when the UI is mounted in
   `react`-platform standalone?** I.e. does react-standalone
   *always* mean "Caddy unless overridden", or do we keep a way
   to say "plain static file server, no proxy at all" via
   `targets: []`? The latter is just shape B with zero routes —
   probably fine, but worth confirming.
3. **Ocelot's static-file story.** Ocelot can host static files
   via a thin ASP.NET wrapper, or be paired with Caddy. The
   former is one container; the latter is two. Pick a default
   for `proxy: ocelot` and document the trade.
4. **YARP version pinning.** YARP versions itself like the rest
   of the .NET ecosystem; if we pin YARP, the pin lives in the
   backend package (`packages/backend-dotnet-vN/`), not in this
   plan. Sanity-check this with `backend-packages.md`.
5. **HTTPS at the proxy.** Caddy's killer feature is automatic
   TLS, but we don't want generated docker-compose to depend on
   ACME at dev-time. Default: HTTP only in compose; TLS is a
   user opt-in via a deployable-level `tls:` slot (out of scope
   for this plan).
6. **WebSockets / SSE passthrough.** All four proxy families
   support it but with different config. Should default-emit the
   pass-through bits even when nothing in the IR declares a WS
   endpoint, or only when an `event` stream / `live` page is
   present? Probably the latter — emit only when needed, since
   the route table already knows.

## Sequencing

If this lands, the suggested slice order keeps each step small:

1. Grammar: `targets:` → list (with singular sugar); no `proxy:`
   yet. Update existing examples to the singular-list sugar form.
2. Enrichment: derive `proxyRoutes` for the mounted-host shape
   only; reject `targets:` length > 1 on `platform: react`.
3. `emitProxyMounts` on the hono surface (smallest hop —
   `app.all + fetch`). Ship one e2e under `LOOM_E2E=1`.
4. `emitProxyMounts` on the dotnet surface (YARP).
5. `emitProxyMounts` on the phoenix surface (`ReverseProxyPlug`).
6. Add `proxy:` grammar slot + `caddy` `ProxySurface`; enable
   shape B for `platform: react`. Switch one example over.
7. Second proxy family — `nginx` — to prove the kind is
   pluggable. Then `traefik`, then `ocelot`.
8. Wire the out-of-tree `kind: "proxy"` resolver in
   `fs-discovery.ts` once we have two in-tree families to
   pattern off.

Each step keeps `npm test` green and only one CI matrix cell
(`LOOM_E2E`, `LOOM_DOTNET_BUILD`, etc.) changes scope at a time.
