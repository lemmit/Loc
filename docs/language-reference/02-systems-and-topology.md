# 2. Systems & deployment topology

The outermost shells: a `system` groups `subdomain`s and `context`s (the pure domain) and then describes how to *ship* that domain as one or more `deployable`s — each pinned to a backend or frontend platform, bound to its contexts and data sources, and composed into a single `docker compose` stack. Reach for this chapter when you're deciding what runs where, on which stack, behind which UI, and how the pieces wire together.

> **Grammar:** `System`, `Subdomain`, `BoundedContext`, `Deployable`, `Platform`, `Framework`, `DesignPack`, `ThemeBlock` · **Validators:** `checkDeployable` / `checkDeployablePlatform` (`src/language/validators/deployable.ts`), `checkTheme` (`src/language/validators/ui.ts`), `loom.platform-knob-*` · **Docs:** [`../architecture.md`](../architecture.md), [`../platforms.md`](../platforms.md)

Everything below was generated from one scratch system (`system Shop` — one `Orders` context served by six deployables, one per platform plus a React frontend) via `node bin/cli.js generate system shop.ddd -o out`. The compose stanzas and directory trees are excerpted verbatim from that run.

## `system`

`'system' name=ID '{' members* '}'` — the top-level deployment grouping. It holds the deployment vocabulary (`deployable`, `storage`, `resource`, `api`, `ui`, `theme`, `user`, `auth`) and may nest `subdomain`s and `context`s, or leave them as top-level declarations in any file that composes into the project.

```ddd
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { reference: string, total: money }
    }
  }
  // … apis, storage, deployables …
}
```

**Exactly one `system` per project.** The composition validator requires a single `system { … }` across the whole import graph; a second one (in any reachable file) is a hard error. The system may be *just* a name plus deployment declarations — `subdomain` / `context` can live as top-level members and fold in (see [implicit-system-composition](../old/proposals/implicit-system-composition.md)), which is what lets you split one-file-per-subdomain with the deployment in its own file.

A project with **no** `system` block still parses and generates per-deployable code via the legacy `generate ts` / `generate dotnet` single-file path — but `generate system` (the multi-deployable + compose path) emits nothing without one.

No generated tab: `system` is a container; its members emit, it does not.

## `subdomain` & `context`

```
Subdomain:      'subdomain' name=ID '{' (contexts | permissions)* '}'
BoundedContext: 'context' name=ID withClause? '{' members* '}'
```

A `subdomain` is a **logical grouping** with no code of its own — it clusters `context`s (and an optional `permissions { … }` catalogue). A `context` is the **bounded context**: it owns the domain declarations and is the unit a deployable hosts and an api derives from.

| Lives in `subdomain` | Lives in `context` |
|---|---|
| `context` children, `permissions { … }` | `enum`, `valueobject`, `aggregate`, `event`, `payload`, `repository`, `workflow`, `view`, `criterion`, `seed`, `channel`, `service` |

```ddd
subdomain Sales {
  context Orders {
    enum Status { Pending, Shipped }
    aggregate Order {
      reference: string
      total: money
      status: Status
    }
  }
}
```

The split matters for the deployment layer: deployables reference **contexts** (`contexts: [Orders]`), and an `api … from Sales` derives its contract from a **subdomain**. A `context` name must be unique across the whole project; cross-context aggregate references must spell out `X id` (a bare type ref only resolves within the same context).

No generated tab on its own — the domain inside a context is the subject of [Aggregates & domain model](03-domain-modeling.md). What this chapter shows is how that context is *shipped*.

## `deployable`

```
Deployable:
  'deployable' name=LooseName '{'
    'platform' ':' Platform ('{' realization-axes '}')?
    ( contexts: [...] | dataSources: [...] | targets: Deployable | serves: [Api...]
    | ui: Ui | hosts: [Ui...] | port: INT | auth: AuthMode | design: DesignPack | favicon: STRING )*
  '}'
```

A `deployable` is one shippable project. `platform:` is the lead clause (and the only required one); every other clause is **order-independent**. A backend deployable lists the `contexts:` it hosts, the `dataSources:` binding those contexts to physical storage, and the `serves:` api contracts it exposes. A frontend deployable `targets:` a backend (inheriting its module set), mounts a `ui:`, and picks a `design:` pack. `port:` is the *host* port published in compose; the container's internal port is the platform default.

```ddd
deployable apiNode {
  platform: node
  contexts: [Orders]
  dataSources: [ordersState]
  serves: OrdersApi
  port: 3001
}

deployable webReact {
  platform: react
  targets: apiNode
  ui: Web { Sales: apiNode }
  design: mantine
  port: 3000
}
```

> Deployable names are `LooseName` — identifiers, **not** kebab-case. `api-node` parses as `api` then `-node` and fails; write `apiNode`.

Each deployable becomes one directory under `<outdir>/` (the name slugified — `apiNode` → `api_node`) plus one `docker compose` service. The orchestrator wires the database, dependency ordering, ports, and (for frontends) the in-network API proxy target. Here is the compose service each platform's deployable produces in the same stack:

::: tabs backend
== node
```yaml
  api_node:
    build: ./api_node
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: "postgres://postgres:postgres@db:5432/api_node"
      LOG_LEVEL: "info"
    ports:
      - "3001:3000"          # host 3001 → container 3000 (node default)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/ready || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 10
```
== dotnet
```yaml
  api_dotnet:
    build: ./api_dotnet
    depends_on:
      db:
        condition: service_healthy
    environment:
      ConnectionStrings__Default: "Host=db;Port=5432;Database=api_dotnet;Username=postgres;Password=postgres"
      LOG_LEVEL: "info"
    ports:
      - "3002:8080"          # container 8080 (dotnet default)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/ready || exit 1"]
      # …
```
== java
```yaml
  api_java:
    build: ./api_java
    depends_on:
      db:
        condition: service_healthy
    environment:
      SPRING_DATASOURCE_URL: "jdbc:postgresql://db:5432/api_java"
      SPRING_DATASOURCE_USERNAME: "postgres"
      SPRING_DATASOURCE_PASSWORD: "postgres"
    ports:
      - "3003:8080"          # container 8080 (java default)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/ready || exit 1"]
      # …
```
== python
```yaml
  api_python:
    build: ./api_python
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: "postgresql+asyncpg://postgres:postgres@db:5432/api_python"
      LOG_LEVEL: "info"
    ports:
      - "3004:8000"          # container 8000 (python default)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8000/ready || exit 1"]
      # …
```
== elixir
```yaml
  api_elixir:
    build: ./api_elixir
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: "ecto://postgres:postgres@db:5432/api_elixir"
      SECRET_KEY_BASE: "loom-dev-secret-replace-in-production-…"
      PHX_HOST: "localhost"
      PHX_SERVER: "true"
      PORT: "4000"
      LOG_LEVEL: "info"
    ports:
      - "3005:4000"          # container 4000 (elixir/phoenix default)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:4000/health || exit 1"]
      # …
```
::: end

The divergence is the content: each backend speaks its own connection-string dialect (libpq URL / EF `ConnectionStrings__Default` / Spring `SPRING_DATASOURCE_*` / SQLAlchemy `+asyncpg` / Ecto URL), binds a different internal port, and Phoenix carries the extra `SECRET_KEY_BASE` / `PHX_*` runtime env. The host port is always your `port:`; the container port is the platform's `defaultPort` (`src/platform/surface.ts` → each surface's `defaultPort`). All five `depends_on: db` with a healthcheck wait because every backend `needsDb`.

The frontend deployable is the exception — no DB, no `depends_on`, and it gets the API proxy wiring instead:

::: tabs frontend
== react
```yaml
  web_react:
    build: ./web_react
    environment:
      VITE_API_BASE_URL: "http://localhost:3001/api"
      VITE_API_PROXY_TARGET: "http://api_node:3000"   # in-network → targets: apiNode
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/ || exit 1"]
      # …
```
::: end

`VITE_API_PROXY_TARGET` points at the *compose service name* of the deployable named in `targets:` — inside the compose network the backend is `api_node`, not `localhost` — so the bundle stays same-origin (the `injectsApiProxyTarget` flag on the surface drives this).

The on-disk shape is idiomatic per ecosystem — each backend lays its project out the way its build tool expects:

::: tabs backend
== node
```
api_node/
  index.ts  package.json  tsconfig.json  drizzle.config.ts  tsup.config.ts
  domain/            # aggregate classes, value objects, events
  db/
    migrations/      # drizzle SQL + meta
    repositories/
  http/              # Hono routes
  lib/  obs/  certs/
```
== dotnet
```
api_dotnet/
  Api/                              # Program.cs, endpoint mapping
  Application/Orders/{Commands,Queries,Requests,Responses}/
  Domain/{Common,Enums,Events,Ids,Orders,ValueObjects}/
  Infrastructure/{Events,Persistence,Persistence/Configurations,Repositories}/
  Middleware/  Migrations/  certs/
```
== java
```
api_java/
  build.gradle.kts  settings.gradle.kts
  src/main/java/com/loom/apijava/
    api/  config/
    domain/{common,enums,events,ids,valueobjects}/
    features/orders/
  src/main/resources/db/migration/      # Flyway SQL
```
== python
```
api_python/
  app/
    domain/
    db/repositories/
    http/
    obs/
  migrations/  certs/
```
== elixir
```
api_elixir/
  mix.exs  config/  rel/
  lib/
    api_elixir/orders/                  # Ecto schemas / domain
    api_elixir_web/{api,api/schemas,components,controllers}/
  priv/repo/migrations/  priv/static/  certs/
```
::: end

The React frontend's tree is UI-shaped — pages, an API client, e2e page objects — and carries no domain or DB layer:

::: tabs frontend
== react
```
web_react/
  index.html  vite.config.ts  package.json  tsconfig.json
  src/
    api/         # generated React-Query client
    pages/orders/
    lib/  theme.ts
  e2e/pages/     # Playwright page objects
  certs/
```
::: end

### The composed stack

`generate system` emits one `docker-compose.yml` at the output root that ties the deployables together with a **single shared `db`** postgres service. Every backend that `needsDb` gets its *own database* inside that one postgres instance — created by a generated `db-init/` script the `db` service runs on first boot:

```sql
-- db-init/00-create-databases.sql (auto-generated)
CREATE DATABASE api_node;
CREATE DATABASE api_dotnet;
CREATE DATABASE api_java;
CREATE DATABASE api_python;
CREATE DATABASE api_elixir;
```

```yaml
# docker-compose.yml — the shared db service the backends depend_on
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: postgres
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - pgdata:/var/lib/postgresql
      - ./db-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
```

Each backend's connection string targets its own database (`…/api_node`, `…/api_dotnet`, …) on the shared `db` host. The whole stack comes up with `docker compose up` from the output root. Schema migrations are owned per-module by exactly one backend deployable (the enrichment pass's `migrationsOwner`), so two backends hosting the same context don't both try to create the tables.

## Backend platforms

`platform:` admits five backend families plus the frontends and `static`. The full `Platform` rule:

```
Platform: 'dotnet' | 'node' | 'react' | 'svelte' | 'vue' | 'angular' | 'static' | 'elixir' | 'python' | 'java' | STRING;
```

The backend families and what they generate (registered in `src/platform/registry.ts`, each implementing `PlatformSurface`):

| `platform:` | Stack | Internal port | DB |
|---|---|---|---|
| `node` | Hono + Drizzle + Zod (TypeScript) | 3000 | postgres |
| `dotnet` | ASP.NET + EF Core + Mediator (CQRS) | 8080 | postgres |
| `java` | Spring Boot + Spring Data JPA | 8080 | postgres |
| `python` | FastAPI + SQLAlchemy 2 (async) | 8000 | postgres |
| `elixir` | Phoenix LiveView + Ecto — fullstack | 4000 | postgres |

These are the only spellings — the legacy aliases (`hono` → `node`, `fastapi` → `python`, `phoenix`/`phoenixLiveView` → `elixir`) were **retired**; writing them now fails validation as an unknown platform. A backend may pin a `family@version` via the `STRING` alternative — `platform: "node@v4"` selects the zod-3 / TS-5 Hono package (`platform: node` resolves to the default version). `elixir` is dual-natured: it owns a database **and** mounts a `ui:` (Phoenix LiveView), so it is the one *fullstack* platform; `dotnet` and `java` are backend-only but embed a React SPA when the deployable declares `ui:`.

Per-platform output for the same `aggregate Order` is the subject of [Aggregates & domain model](03-domain-modeling.md); here the platform choice is what selects the *whole project shape* shown above.

## Frontend platforms & `targets:`

```
Framework: 'react' | 'svelte' | 'vue' | 'angular' | 'phoenixLiveView';
```

The frontend-only platforms are `react`, `svelte`, `vue`, `angular`, and `static` (React's UI-only alias — same Vite bundle, no separate domain). They own no server logic or database; a frontend deployable **`targets:` a backend** and renders pages against that backend's wire shape.

```ddd
deployable webReact {
  platform: react
  targets: apiNode          // inherit apiNode's module set + proxy its /api
  ui: Web { Sales: apiNode } // bind the ui's `api Sales:` param to a backend
  design: mantine
  port: 3000
}
```

`targets:` is **module inheritance** — a frontend has no domain code of its own, so the enrichment pass copies the target backend's `moduleNames` onto it (`src/ir/enrich/enrichments.ts` → "React `targets:` module inheritance"). The `ui: Web { … }` compose-binding maps each api parameter declared in the `ui` block (`api Sales: OrdersApi`) to the backend deployable that supplies it; the validator checks that backend actually `serves:` the named contract.

`phoenixLiveView` is a *framework*, not a platform — it is the framework an `elixir` deployable's `ui:` mounts (HEEx, not a separate SPA deployable). A backend platform can also `hosts:` a static-bundle framework: which frameworks a host can serve is governed by `PlatformSurface.hostableFrameworks` (a static-asset host serves any of `react`/`static`/`svelte`/`vue`/`angular`; a runtime-coupled framework like LiveView runs only on its own runtime). An incompatible mount is rejected with a `loom.*` host-compatibility diagnostic.

The generated frontend project (React, above) is a Vite SPA: `src/pages/`, a generated React-Query `src/api/` client, and Playwright `e2e/pages/` page objects.

## Design packs

```
DesignPack: 'mantine' | 'shadcn' | 'mui' | 'chakra' | 'ashPhoenix'
          | 'shadcnSvelte' | 'flowbite' | 'vuetify' | 'shadcnVue'
          | 'angularMaterial' | 'primeng' | 'spartanNg' | STRING;
```

`design:` picks the template pack the UI generator renders pages against — only meaningful on a deployable that mounts a UI (ignored otherwise). Each pack is keyed to a frontend *format*; the validator cross-checks the pack against the deployable's framework, so a Vue pack on a React frontend is an error.

| Framework | Packs | Default |
|---|---|---|
| `react` (tsx) | `mantine`, `shadcn`, `mui`, `chakra` | `mantine` |
| `vue` | `vuetify`, `shadcnVue` | `vuetify` |
| `svelte` | `shadcnSvelte`, `flowbite` | — |
| `angular` | `angularMaterial`, `primeng`, `spartanNg` | — |
| `phoenixLiveView` (heex) | `ashPhoenix` | `ashPhoenix` |

A `STRING` value points at a **custom pack** — a directory with a `pack.json`, resolved relative to the `.ddd` file. The body walker dispatches each page primitive through the active pack's templates under `designs/`; see [`../design-packs.md`](../design-packs.md) for the authoring contract.

## Realization axes

`platform:` can carry an optional `{ … }` block that decomposes the platform bundle into six **orthogonal realization axes** — finer control over *how* a backend realizes its layers, without changing the platform:

```ddd
deployable apiDotnet {
  platform: dotnet {
    application: serviceLayer    // architectural style
    persistence: efCore          // data layer
    directoryLayout: byFeature   // on-disk shape
  }
  contexts: [Orders]
  // …
}
```

The two axes (grammar order): `persistence`, `directoryLayout`. The bare `platform: dotnet` form is unchanged — the block is additive and every axis is optional, defaulting to the platform's primary value. Axis *values* are validated against a per-platform menu (`src/language/validators/data/platform-rules.ts`), not the grammar:

- **`persistence`** — data layer (`elixir` admits `ecto`; `dotnet` admits `efcore`/`dapper`; `node` admits `drizzle`/`mikroorm`; each backend lists its own).
- **`directoryLayout`** — `byLayer` vs `byFeature` on-disk shape; must be one the backend's emission style supports (the R3 layout check otherwise).

Only these two axes offer real per-backend choice. The other realization knobs were removed as inert/theater: `foundation:` (single value `vanilla` everywhere), `application:`/style (a single fixed emission style per backend — `cqrs` on dotnet, `layered` elsewhere — kept internally, not user-selectable), and `transport:`/`runtime:` (name-only registries no emitter read). Writing any of those clauses no longer parses.

Frontends carry **no** axes (empty menu — any axis written on a `react`/`vue`/… deployable is rejected). `platform: elixir` emits plain Ecto/Phoenix (the Ash foundation was removed).

No generated tab here — the axes select *which* emitter subtree runs (e.g. `byFeature` vs `byLayer` reorganises the directory tree shown under [`deployable`](#deployable)); the divergence is structural across whole projects, not a single excerptable line.

## `theme`

```
ThemeBlock: 'theme' '{' (name=LooseName ':' value=STRING)* '}'
```

A system-level design-token block — framework-agnostic visual identity consumed by every frontend deployable in the system. At most one `theme { … }` per project (`loom.duplicate-theme-block`). Token names and value rules are pinned by `checkTheme`:

| Token | Validation |
|---|---|
| `primary` `secondary` `accent` `success` `warning` `error` `neutral` | CSS hex (`#RGB` / `#RRGGBB` / `#RRGGBBAA`) — named colours / `rgb()` / CSS vars rejected |
| `radius` | `none` \| `sm` \| `md` \| `lg` \| `xl` |
| `colorScheme` | `light` \| `dark` \| `auto` |
| `fontFamily` `fontFamilyMono` | free-form string |

```ddd
theme {
  primary: "#2563eb"
  neutral: "#64748b"
  radius: "md"
  fontFamily: "Inter, system-ui, sans-serif"
}
```

The tokens are intentionally framework-neutral so the same source feeds every pack's theme emitter. Today the Mantine (React) pack consumes them — `primary`/`neutral` become generated 10-shade `MantineColorsTuple` ramps, `radius`/`fontFamily` flow straight through:

::: tabs frontend
== react
```ts
// src/theme.ts — generated, do not edit by hand
const brand: MantineColorsTuple = [
  "#eef2fc", "#cfdbf7", "#b0c4f1", "#89aaf4", "#6793f1",
  "#467bee", "#2563eb", "#1144b6", "#0a2b72", "#07132c",   // #2563eb at shade 6
];
const neutral: MantineColorsTuple = [ "#f3f5f6", /* … */ "#16191d" ];

export const theme = createTheme({
  primaryColor: "brand",
  primaryShade: { light: 6, dark: 5 },
  colors: { brand, gray: neutral },
  defaultRadius: "md",
  fontFamily: "Inter, system-ui, sans-serif",
  // headings + per-component defaultProps (radius: "md") follow …
});
```
::: end

The shade ramp is *derived* from the single `primary` hex — your colour lands at shade 6 (the `primaryShade.light` index), with lighter tints above and darker shades below. Omit `theme` entirely and the pack's built-in defaults apply.

