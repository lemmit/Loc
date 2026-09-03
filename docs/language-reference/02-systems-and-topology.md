# 2. Systems & deployment topology

The outermost shells: a `system` groups `subdomain`s and `context`s (the pure domain) and then describes how to *ship* that domain as one or more `deployable`s — each pinned to a backend or frontend platform, bound to its contexts and data sources, and composed into a single `docker compose` stack. Reach for this chapter when you're deciding what runs where, on which stack, behind which UI, and how the pieces wire together.

> **Grammar:** `System`, `SystemMember`, `Subdomain`, `BoundedContext`, `Deployable`, `UiSugarBinding` / `UiComposeBinding`, `Platform`, `Framework`, `DesignPack`, `ThemeBlock`, `TenancyDecl` · **Validators:** `checkDeployable` / `checkDeployablePlatform` / `checkDeployableRealizationAxes` (`src/language/validators/deployable.ts`) — `loom.ui-binding-unmountable-platform`, `loom.ui-framework-unhostable`, `loom.<framework>-deployable-missing-ui`, `loom.platform-knob-out-of-menu`, `loom.platform-knob-style-layout-mismatch`; `loom.top-level-domain-needs-single-system`, `loom.duplicate-theme-block` (`composition.ts`); `checkTheme` + `loom.a11y-theme-contrast` (`ui.ts`, `a11y.ts`); `loom.duplicate-host-port`, `loom.duplicate-service-slug`, `loom.channelsource-unbound`, `loom.deployable-channel-unrelated`, `loom.file-field-needs-object-storage` (`src/ir/validate/checks/system-checks.ts`); `loom.tenancy-*` (`tenancy.ts`) · **Docs:** [`../architecture.md`](../architecture.md), [`../platforms.md`](../platforms.md), [`../design-packs.md`](../design-packs.md), [`../tenancy.md`](../tenancy.md), [`../channels.md`](../channels.md)

Everything below was generated from one scratch system (`system Shop` — one `Orders` context served by five backend deployables, one per platform, plus a React, a Feliz and a Flutter frontend) via `node bin/cli.js generate system shop.ddd -o out`. The compose stanzas and directory trees are excerpted verbatim from that run.

## `system`

`'system' name=ID '{' members* '}'` — the top-level deployment grouping. Its member vocabulary (`SystemMember`) is: `subdomain`, `context`, `deployable`, `storage`, `resource`, `channelSource`, `timerSource`, `api`, `ui`, `layout`, `theme`, `user`, `auth`, `tenancy by …`, `capability`, a top-level `function`, and `test e2e`. Most of these are *also* admissible at file top level and fold into the project's single `system`; the exceptions that only parse **inside** `system { … }` are `tenancy by …` (see [Tenancy](#tenancy-by-userclaim-of-registry)) and `timerSource`.

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

**One `system` per project.** The composition validator (`src/language/validators/composition.ts`) folds every top-level `subdomain` / `context` / `deployable` / `ui` / … into the project's single system; when the import graph declares zero or more than one `system { … }` and there is anything to fold, every foldable top-level declaration is flagged with `loom.top-level-domain-needs-single-system`. This is what lets you split one-file-per-subdomain with the deployment in its own file (see [implicit-system-composition](../old/proposals/implicit-system-composition.md)). The system may be *just* a name plus deployment declarations.

A project with **no** `system` block still parses and generates per-deployable code via the legacy `generate ts` / `generate dotnet` single-file path — `generate system` emits only the root `.loom/` artefact bundle without one.

No generated tab: `system` is a container; its members emit, it does not.

## `subdomain` & `context`

```
Subdomain:      'subdomain' name=ID '{' (contexts | permissions)* '}'
BoundedContext: 'context' name=ID withClause? '{' members* '}'
```

A `subdomain` is a **logical grouping** with no code of its own — it clusters `context`s (and an optional `permissions { … }` catalogue, [Auth](17-auth.md)). A `context` is the **bounded context**: it owns the domain declarations and is the unit a deployable hosts and an api derives from.

| Lives in `subdomain` | Lives in `context` (`ContextMember`) |
|---|---|
| `context` children, `permissions { … }` | `enum`, `valueobject`, `aggregate`, `event`, `payload`/`command`/`query`/`response`/`error`, `repository`, `workflow`, `projection`, `criterion`, `retrieval`, `seed`, `channel`, `domainService`, `policy`, `commandHandler` / `queryHandler`, `filter` / `stamp` / `implements`, a hoisted `test … for <Aggregate>` |

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
    ( contexts: [...] | dataSources: [...] | channels: [...] | targets: Deployable
    | serves: Api, ... | ui: Ui | ui: Ui { Param: Deployable, ... } | hosts: [Ui...]
    | port: INT | auth: required|ui | design: DesignPack | favicon: STRING )*
  '}'
```

A `deployable` is one shippable project. `platform:` is the lead clause (and the only required one); every other clause is **order-independent**. A backend deployable lists the `contexts:` it hosts, the `dataSources:` binding those contexts to physical storage (plus `channels:` for broker-transported events — [Channels](14-apis-storage-resources-channels.md#channel--channelsource)), and the `serves:` api contracts it exposes. A frontend deployable `targets:` a backend (inheriting its module set), mounts a `ui:`, and picks a `design:` pack. `port:` is the *host* port published in compose; the container's internal port is the platform default. `auth: required` (backend) / `auth: ui` (frontend) opts into the OIDC layer ([Auth](17-auth.md)); `favicon:` copies an icon into the frontend bundle.

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

Each deployable becomes one directory under `<outdir>/` (the name slugified — `apiNode` → `api_node`) plus one `docker compose` service. Two deployables whose names slugify identically (`apiNode` + `ApiNode`) are rejected with `loom.duplicate-service-slug`; two publishing the same host `port:` with `loom.duplicate-host-port`. The orchestrator wires the database, dependency ordering, ports, CORS origins (every frontend's host URL), OTLP tracing, and (for frontends) the in-network API proxy target. Here is the compose service each platform's deployable produces in the same stack:

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
      CORS_ORIGIN: "http://localhost:3000,http://localhost:3006,http://localhost:3007"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
      OTEL_SERVICE_NAME: "api_node"
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
      CORS_ORIGIN: "http://localhost:3000,http://localhost:3006,http://localhost:3007"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
      OTEL_SERVICE_NAME: "api_dotnet"
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
      CORS_ORIGIN: "http://localhost:3000,http://localhost:3006,http://localhost:3007"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
      OTEL_SERVICE_NAME: "api_java"
    ports:
      - "3003:8080"          # container 8080 (Spring default; the host-side default is 8081)
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
      CORS_ORIGIN: "http://localhost:3000,http://localhost:3006,http://localhost:3007"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
      OTEL_SERVICE_NAME: "api_python"
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
      SECRET_KEY_BASE: "6f3454…"
      PHX_HOST: "localhost"
      PHX_SERVER: "true"
      PORT: "4000"
      LOG_LEVEL: "info"
      CORS_ORIGIN: "http://localhost:3000,http://localhost:3006,http://localhost:3007"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"
      OTEL_SERVICE_NAME: "api_elixir"
    ports:
      - "3005:4000"          # container 4000 (elixir/phoenix default)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:4000/health || exit 1"]
      # …
```
::: end

The divergence is the content: each backend speaks its own connection-string dialect (libpq URL / EF `ConnectionStrings__Default` / Spring `SPRING_DATASOURCE_*` / SQLAlchemy `+asyncpg` / Ecto URL), binds a different internal port, and Phoenix carries the extra `SECRET_KEY_BASE` / `PHX_*` runtime env. The host port is always your `port:`; the container port is the platform's listener (`src/platform/<name>.ts`). All five `depends_on: db` with a healthcheck wait because every backend `needsDb`. The stack also carries `prometheus` + `jaeger` sidecars for the [observability](20-observability-provenance.md) wire.

The frontend deployables are the exception — no DB, no `depends_on`, and they get the API proxy wiring instead:

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
== feliz
```yaml
  web_feliz:
    build: ./web_feliz
    environment:
      VITE_API_BASE_URL: "http://localhost:3001/api"
      VITE_API_PROXY_TARGET: "http://api_node:3000"
    ports:
      - "3006:3000"          # dotnet fable + vite build, served by nginx on :3000
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/ || exit 1"]
      # …
```
== flutter
```yaml
  web_flutter:
    build: ./web_flutter
    environment:
      API_BASE_URL: "http://localhost:3001/api"          # Dart --dart-define, not a Vite var
      VITE_API_PROXY_TARGET: "http://api_node:3000"
    ports:
      - "3007:3000"          # flutter build web, served by nginx on :3000
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/ || exit 1"]
      # …
```
::: end

`VITE_API_PROXY_TARGET` points at the *compose service name* of the deployable named in `targets:` — inside the compose network the backend is `api_node`, not `localhost` — so the bundle stays same-origin (the `injectsApiProxyTarget` flag on the surface drives this). Vue, Svelte and Angular deployables produce the same stanza shape as React.

The on-disk shape is idiomatic per ecosystem — each backend lays its project out the way its build tool expects:

::: tabs backend
== node
```
api_node/
  index.ts  package.json  tsconfig.json  drizzle.config.ts  tsup.config.ts  Dockerfile
  domain/            # aggregate classes, ids, value objects, events, repository ports
  db/
    schema.ts
    migrations/      # drizzle SQL + meta
    repositories/
  http/              # Hono routes
  lib/  obs/  certs/
```
== dotnet
```
api_dotnet/
  ApiDotnet.csproj  Program.cs  Dockerfile
  Api/                              # controllers, filters
  Application/Orders/{Commands,Queries,Requests,Responses}/
  Domain/{Common,Enums,Events,Ids,Orders,ValueObjects}/
  Infrastructure/{Events,Persistence,Persistence/Configurations,Repositories}/
  Middleware/  Migrations/  Observability/  Serialization/  certs/
```
== java
```
api_java/
  build.gradle.kts  settings.gradle.kts  Dockerfile
  src/main/java/com/loom/apijava/
    api/  config/
    domain/{common,enums,events,ids,valueobjects}/
    features/orders/                    # entity, repository, service, controller, DTOs
  src/main/resources/db/migration/      # Flyway SQL
```
== python
```
api_python/
  pyproject.toml  Dockerfile
  app/
    main.py  settings.py
    domain/
    db/repositories/
    http/
    obs/
  migrations/  certs/
```
== elixir
```
api_elixir/
  mix.exs  config/  rel/  Dockerfile
  lib/
    api_elixir/orders/                  # Ecto schemas / changesets / repositories
    api_elixir_web/{api,api/schemas,controllers}/
      components/ live/                 # only when the deployable mounts a `ui:`
  priv/repo/migrations/  priv/static/  certs/
```
::: end

The frontend trees are UI-shaped — pages, an API client, e2e page objects — and carry no domain or DB layer:

::: tabs frontend
== react
```
web_react/
  index.html  vite.config.ts  package.json  tsconfig.json  Dockerfile
  src/
    api/         # generated React-Query client
    pages/orders/
    lib/  locales/  theme.ts  i18n.ts
  e2e/pages/     # Playwright page objects + smoke spec
  certs/
```
== feliz
```
web_feliz/
  App.fsproj  index.html  vite.config.js  tailwind.config.js  package.json  Dockerfile
  .config/dotnet-tools.json   # fable
  src/App.fs                  # one Elmish MVU program: wire types, pages, views
  e2e/pages/
```
== flutter
```
web_flutter/
  pubspec.yaml  Makefile  Dockerfile     # make apk / ipa build the native targets
  lib/
    main.dart  config.dart  models.dart  reads.dart  i18n.dart
    pages/
  web/  test/
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
      PGDATA: /var/lib/postgresql/data
    volumes:
      - pgdata:/var/lib/postgresql
      - ./db-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
```

Each backend's connection string targets its own database (`…/api_node`, `…/api_dotnet`, …) on the shared `db` host. The whole stack comes up with `docker compose up` from the output root. Schema migrations are owned per-module by exactly one backend deployable (the enrichment pass's `migrationsOwner`), so two backends hosting the same context don't both try to create the tables.

## Backend platforms

`platform:` admits five backend families plus the six frontends and `static`. The full `Platform` rule:

```
Platform: 'dotnet' | 'node' | 'react' | 'svelte' | 'vue' | 'angular' | 'feliz' | 'flutter'
        | 'static' | 'elixir' | 'python' | 'java' | STRING;
```

The backend families and what they generate (registered in `src/platform/registry.ts`, each implementing `PlatformSurface`; the client-safe facts live in `src/platform/metadata.ts`):

| `platform:` | Stack | Container port | DB | Mounts a `ui:` |
|---|---|---|---|---|
| `node` | Hono + Drizzle + Zod (TypeScript) | 3000 | postgres | no |
| `dotnet` | ASP.NET + EF Core + Mediator (CQRS) | 8080 | postgres | embeds a SPA |
| `java` | Spring Boot + Spring Data JPA | 8080 (host default 8081) | postgres | embeds a SPA |
| `python` | FastAPI + SQLAlchemy 2 (async) | 8000 | postgres | embeds a SPA |
| `elixir` | Phoenix + Ecto, LiveView when a `ui:` is mounted — fullstack | 4000 | postgres | LiveView or a SPA |

These are the only spellings — the legacy aliases (`hono` → `node`, `fastapi` → `python`, `phoenix`/`phoenixLiveView` → `elixir`) were **retired**; writing them now fails validation as an unknown platform. A backend may pin a `family@version` via the `STRING` alternative — `platform: "node@v4"` selects the zod-3 / TS-5 Hono package (`platform: node` resolves to the default `v5`). `elixir` is dual-natured: it owns a database **and** mounts a `ui:` (Phoenix LiveView), so it is the one *fullstack* platform; `dotnet`, `java` and `python` are backend-only until the deployable declares `ui:`, at which point they embed the referenced SPA bundle under their served static root.

Per-platform output for the same `aggregate Order` is the subject of [Aggregates & domain model](03-domain-modeling.md); here the platform choice is what selects the *whole project shape* shown above.

## Frontend platforms & `targets:`

```
Framework: 'react' | 'svelte' | 'vue' | 'angular' | 'feliz' | 'flutter' | 'phoenixLiveView';
```

The frontend-only platforms are `react`, `vue`, `svelte`, `angular`, `feliz`, `flutter`, and `static` (React's UI-only alias — same Vite bundle, no separate domain). They own no server logic or database; a frontend deployable **`targets:` a backend** and renders pages against that backend's wire shape. Every frontend deployable must mount a `ui:` (or `hosts:`) — one without is rejected with the per-platform `loom.react-deployable-missing-ui` / `loom.vue-…` / `loom.svelte-…` / `loom.angular-…` / `loom.feliz-…` / `loom.flutter-deployable-missing-ui`.

```ddd
deployable webReact {
  platform: react
  targets: apiNode          // inherit apiNode's module set + proxy its /api
  ui: Web { Sales: apiNode } // bind the ui's `api Sales:` param to a backend
  design: mantine
  port: 3000
}

deployable webFeliz {
  platform: feliz           // F#/Fable/Elmish — no design pack menu, daisyUI shell
  targets: apiNode
  ui: Web { Sales: apiNode }
  port: 3006
}

deployable webFlutter {
  platform: flutter         // Dart/Riverpod — web bundle in compose, apk/ipa via Makefile
  targets: apiNode
  ui: Web { Sales: apiNode }
  port: 3007
}
```

`targets:` is **module inheritance** — a frontend has no domain code of its own, so the enrichment pass copies the target backend's `moduleNames` onto it (`src/ir/enrich/enrichments.ts` → "React `targets:` module inheritance"). The `ui: Web { … }` compose-binding maps each api parameter declared in the `ui` block (`api Sales: OrdersApi`) to the backend deployable that supplies it. Two frontend families build outside the shared Vite static pipeline: **Feliz** (`dotnet fable` → JS → `vite build`) and **Flutter** (`flutter build web`, plus native `make apk` / `make ipa` from the same Dart source, which compose does not serve).

### Which host can serve which framework

A `ui` declaration owns its framework (`ui Web { framework: vue … }`; omitted → derived from the mounting deployable's platform). The hosting deployable's platform must be able to serve it — `PlatformSurface.hostableFrameworks`:

| Host platform | Hosts |
|---|---|
| `react` / `static`, `vue`, `svelte`, `angular` | any static bundle: `react`, `static`, `vue`, `svelte`, `angular` |
| `dotnet`, `java`, `python` | the static bundles **plus** `feliz` (the backend Dockerfile runs the Fable stage) |
| `elixir` | `phoenixLiveView` (its own runtime) plus every static bundle and `feliz`, all served under `/app` |
| `feliz` | `feliz` only |
| `flutter` | `flutter` only |
| `node` | nothing — `mountsUi: false`; a `ui:`/`hosts:` on it is `loom.ui-binding-unmountable-platform` |

A mismatch (a `framework: phoenixLiveView` ui on a `react` host, say) is rejected with `loom.ui-framework-unhostable`. `phoenixLiveView` is a *framework*, not a platform — it is what an `elixir` deployable's `ui:` renders (HEEx, not a separate SPA deployable). A backend can mount several UIs at once with `hosts: [Web, Admin]`.

## Design packs

```
DesignPack: 'mantine' | 'shadcn' | 'mui' | 'chakra' | 'coreComponents' | 'daisyui'
          | 'shadcnSvelte' | 'flowbite' | 'vuetify' | 'shadcnVue'
          | 'angularMaterial' | 'primeng' | 'spartanNg' | STRING;
```

`design:` picks the template pack the UI generator renders pages against — only meaningful on a deployable that mounts a UI (ignored otherwise). Each pack is keyed to a frontend *format*; the validator cross-checks the pack against the framework the deployable renders (Rule 14 in `deployable.ts`), so `platform: react … design: vuetify` is an error ("Design pack 'vuetify' is a vue pack but framework 'react' renders tsx. Use one of: mantine, chakra, mui, shadcn."). Bareword names resolve to the current major (`BUILTIN_PACK_LATEST` in `src/util/builtin-formats.ts`); pin an older one with `design: "mantine@v7"`.

| Framework (format) | Packs (bareword → version) | Default when `design:` is omitted |
|---|---|---|
| `react` / `static` (tsx) | `mantine` (v9; v7 pinnable), `shadcn` (v4; v3), `mui` (v7; v5), `chakra` (v3; v2) | `mantine` |
| `vue` | `vuetify` (v3), `shadcnVue` (v1) | `vuetify` |
| `svelte` | `shadcnSvelte` (v1), `flowbite` (v1) | `shadcnSvelte` |
| `angular` | `angularMaterial` (v1), `primeng` (v1), `spartanNg` (v1) | `angularMaterial` |
| `phoenixLiveView` (heex) | `coreComponents` (v3), `daisyui` (v1) | `coreComponents` |
| `feliz` | no pack menu — `design:` names a daisyUI *theme* (`design: dracula`), default `corporate` | — |
| `flutter` | no pack — Material widgets rendered procedurally | — |

A `STRING` value points at a **custom pack** — a directory with a `pack.json`, resolved relative to the `.ddd` file (format-checked only by a warning, since the validator cannot read its manifest). The body walker dispatches each page primitive through the active pack's templates under `designs/`; see [`../design-packs.md`](../design-packs.md) for the authoring contract.

## Realization axes

`platform:` can carry an optional `{ … }` block that decomposes the platform bundle into **two orthogonal realization axes** — finer control over *how* a backend realizes its layers, without changing the platform:

```ddd
deployable apiDotnet {
  platform: dotnet {
    persistence: dapper          // data layer
    directoryLayout: byFeature   // on-disk shape
  }
  contexts: [Orders]
  // …
}
```

The two axes: `persistence`, `directoryLayout`. The bare `platform: dotnet` form is unchanged — the block is additive and every axis is optional, defaulting to the platform's primary value. Axis *values* are validated against a per-platform menu (`src/platform/adapter-metadata.ts`, read by `src/language/validators/data/platform-rules.ts`), not the grammar:

| Backend | `persistence:` | `directoryLayout:` (default) |
|---|---|---|
| `node` | `drizzle` (default), `mikroorm` | `byLayer` (default), `byFeature` |
| `dotnet` | `efcore` (default), `dapper` | `byLayer` (default), `byFeature` |
| `java` | `jpa` | `byLayer`, `byFeature` (default) |
| `elixir` | `ecto` | `byFeature` |
| `python` | no adapter menu — any axis is rejected | — |

An out-of-menu value is `loom.platform-knob-out-of-menu` (`'persistence: efcore' on deployable 'apiNode' is not available on platform 'node'. Available: 'drizzle', 'mikroorm'.`); a layout the backend's emission style can't produce is `loom.platform-knob-style-layout-mismatch`. Frontends carry **no** axes — `platform: react { persistence: drizzle }` is rejected with the same out-of-menu code (`Platform 'react' exposes no 'persistence:'`).

Only these two axes offer real per-backend choice. The former `foundation:` / `application:` / `transport:` / `runtime:` clauses were removed as inert (one fixed emission style per backend — `cqrs` on dotnet, `layered` elsewhere — is kept internally, not user-selectable); writing any of them no longer parses (`Expecting token of type '}' but found 'application'`). `platform: elixir` emits plain Ecto/Phoenix (the Ash foundation was removed).

No generated tab here — the axes select *which* emitter subtree runs (e.g. `byFeature` vs `byLayer` reorganises the directory tree shown under [`deployable`](#deployable)); the divergence is structural across whole projects, not a single excerptable line.

## `theme`

```
ThemeBlock: 'theme' '{' (name=LooseName ':' value=STRING)* '}'
```

A system-level design-token block — framework-agnostic visual identity consumed by every frontend deployable in the system. At most one `theme { … }` per project (`loom.duplicate-theme-block`). Token names and value rules are pinned by `checkTheme`:

| Token | Validation |
|---|---|
| `primary` `secondary` `accent` `success` `warning` `error` `neutral` | CSS hex (`#RGB` / `#RRGGBB` / `#RRGGBBAA`) — named colours / `rgb()` / CSS vars rejected; a colour no text colour clears WCAG-AA on warns `loom.a11y-theme-contrast` |
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

The tokens are intentionally framework-neutral: one shared preparer (`src/generator/_frontend/theme-preparer.ts`) fills defaults and derives 10-shade ramps, and each pack renders them its own way — Mantine's `createTheme` (React), `src/theme.ts` (Vue), a CSS-custom-property sheet (Svelte, Angular `src/styles.css`, Phoenix `priv/static/assets/theme.css`). Feliz and Flutter do not read `theme` (Feliz takes a daisyUI theme name from `design:`; Flutter seeds Material 3 from a fixed colour).

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
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
  // headings + per-component defaultProps (radius: "md") follow …
});
```
== angular
```css
/* src/styles.css — base resets + the tokens projected from `theme { … }` */
body {
  margin: 0;
  font-family: Inter, system-ui, sans-serif;
}
:root {
  --loom-primary: #2563eb;
  --loom-accent: #ffb98a;
}
```
::: end

The Phoenix `theme.css` carries the same ramp as CSS custom properties (`--color-brand-0 … --color-brand-9`, `--color-primary: var(--color-brand-6)`, a `--color-neutral-*` ramp). The shade ramp is *derived* from the single `primary` hex — your colour lands at shade 6 (the `primaryShade.light` index), with lighter tints above and darker shades below. Omit `theme` entirely and the pack's built-in defaults apply (indigo `#4f46e5`, `md`, Inter).

## `tenancy by user.<claim> of <Registry>`

```
TenancyDecl: 'tenancy' 'by' 'user' '.' claim=[UserField] 'of' registry=[Aggregate];
```

A system-level declaration (a `SystemMember` **only** — it does not parse at file top level) naming which `user { … }` claim partitions the data and which aggregate is the tenant registry. Both halves are real cross-references: the claim resolves against the system's `user { … }` fields, the registry against the aggregates. At most one per system (`loom.tenancy-duplicate`); the claim must be a `string` (`loom.tenant-owned-claim-type`). Per-aggregate participation is then declared on each aggregate — `with tenantOwned` (stamped + filtered), `with tenantRegistry` (the registry tree), or the `crossTenant` header marker (shared reference data that opts out) — and every aggregate in a tenant system must take an explicit stance (`loom.tenancy-stance-unmarked`).

```ddd
system Shop {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Org
  subdomain Sales {
    context Orders {
      aggregate Org with tenantRegistry { name: string }
      aggregate Order with tenantOwned  { reference: string }
      aggregate Plan crossTenant        { name: string }
      // repositories …
    }
  }
  // storage / resource / an `auth: required` deployable …
}
```

The generated filters, stamps, hierarchical `dataKey` scoping, and the `loom.tenancy-*` / `loom.policy-*` gate catalogue are covered in [`../tenancy.md`](../tenancy.md) and [Capabilities, filters & stamps](11-capabilities-filters-stamps.md).
