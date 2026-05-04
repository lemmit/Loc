# Loom — Tools & Workflow

This document covers the CLI, the `.loomignore` escape hatch, watch
mode, and how migrations interact with the native database tooling
(Drizzle Kit and EF Core migrations).

For language syntax see [`language.md`](language.md); for architecture
see [`technical.md`](technical.md).

---

## CLI

The `ddd` binary lives at `bin/cli.js` and exposes three sub-commands:

```bash
ddd parse <file.ddd>                              # parse + validate
ddd generate ts <file.ddd> -o <outdir>            # emit a single TypeScript project
ddd generate dotnet <file.ddd> -o <outdir>        # emit a single .NET project
ddd generate system <file.ddd> -o <outdir>        # emit every deployable + docker-compose.yml
```

`generate ts` / `generate dotnet` work on **legacy** sources (bare
`context` declarations) and produce a single project for the chosen
platform.  `generate system` works on sources that declare one or more
`system { … }` blocks and produces a multi-project tree:

```
<outdir>/
    <deployable-1>/        # full per-deployable project
    <deployable-2>/
    docker-compose.yml     # at the system root
```

Each deployable's folder name is a lowercase slug derived from the
deployable's name (e.g. `catalogWeb` → `catalog_web`); inside the
project the .NET namespace and `.csproj` keep the capitalised form.

### Common options

| Flag | Applies to | Effect |
| --- | --- | --- |
| `-o, --out <dir>` | `generate ts`, `generate dotnet` | Output directory.  Created if missing. |
| `-w, --watch` | `generate ts`, `generate dotnet` | Re-run the generator whenever the source `.ddd` file changes. |
| `--dry-run` | `generate ts`, `generate dotnet` | List every path that would be written, plus any paths skipped via `.loomignore`.  Writes nothing. |

`ddd parse` exits non-zero if the source has errors.  `ddd generate`
runs validation first and refuses to emit if there are any errors.

---

## `.loomignore`

The contract is intentionally simple: **every file Loom generates is
overwritten on every run**.  When a user wants Loom to leave a file
alone, they pin it in a `.loomignore` at the output-directory root.

The file uses gitignore syntax (parsed by the `ignore` npm package), so
the rules will feel familiar:

```gitignore
# Pin our hand-tuned hosting entry
Program.cs
/index.ts          # only the root index.ts (anchored)

# Ignore an entire generated folder of legacy aggregates
Domain/Legacy/

# Re-include something previously excluded
!Domain/Legacy/keep-this.cs
```

Patterns match against forward-slash-normalised paths relative to the
output directory.  Anchor with a leading `/` to match only the root;
otherwise `index.ts` matches every `index.ts` at any depth.

### Why no "seed" or "first-run" magic?

Two reasons:

1. **No surprises across regens.**  If `package.json` is generated, it
   is always generated; if it is pinned, it is always pinned.  No
   "the first time it was written, the second time it wasn't" mode.
2. **Git already handles merging.**  When a user introduces a
   customisation they want to keep, they pin the file and commit.
   When they want Loom to take over again, they remove the pin and
   resolve any merge conflict normally.

### What to pin and what not to

Pin when you've made a change you want to survive regeneration:

- `Program.cs` — adding middleware, custom DI registrations, telemetry.
- `index.ts` (TS root) — adding Hono middleware, custom routes outside
  Loom's per-aggregate `*.routes.ts`.
- `package.json` / `*.csproj` — adding application-level dependencies
  beyond what Loom emits.
- `tsconfig.json` — adjusting compiler options.
- `drizzle.config.ts` — alternate connection-string source, custom
  migration directory.

Don't pin Loom's domain artefacts (`domain/*`, `db/schema.ts`,
`Infrastructure/Persistence/Configurations/*`, controllers, repository
implementations, command/query handlers).  Those are auto-derived from
the `.ddd` source — pinning them defeats the point of the generator.

### Discovering the pin set

`ddd generate ... --dry-run` prints, for every generated path,
whether it would be `write`-en or `skip`-ped via `.loomignore`:

```
  write                domain/order.ts  (4.3 KB)
  skip (.loomignore)   Program.cs  (1.0 KB)
  write                Sales.csproj  (1.2 KB)
Would write 17 file(s) in ./out, skipped 1 via .loomignore
```

---

## Watch mode

Useful during model design — every save of the `.ddd` file triggers a
regen:

```bash
ddd generate ts examples/sales.ddd -o ./out --watch
```

Implementation note: `fs.watch` with a 100ms debounce.  No fancy
incremental regeneration — the whole project is regenerated on every
change, then `.loomignore` filters out pinned files.  Fast enough for
sub-second feedback on real-world models.

---

## Migrations workflow

Loom does **not** own migration history — that's deferred to the
native tools (Drizzle Kit and EF Core), which are battle-tested for
schema diffs, FKs, indexes, custom SQL, and conflict handling.  The
generated projects ship pre-wired so this is a single command.

Loom never writes to `db/migrations/` (TS) or
`Infrastructure/Persistence/Migrations/` (.NET), so user-authored
migrations are immune to regeneration regardless of `.loomignore`.

### TypeScript / Drizzle

After `ddd generate ts ... -o ./out`:

```bash
cd out
npm install
npm run db:generate    # diff db/schema.ts vs. snapshot, emit SQL into db/migrations/
npm run db:migrate     # apply pending migrations to DATABASE_URL
npm run dev            # start the Hono server
```

Subsequent edits to the `.ddd` source:

```bash
ddd generate ts ./model.ddd -o ./out   # regenerates db/schema.ts
cd out
npm run db:generate                    # diff against the snapshot
npm run db:migrate                     # apply
```

`npm run db:push` is also available for prototype workflows where you
don't want migration files yet — it diffs the live database directly
against the schema and applies changes in-place.

### .NET / EF Core

After `ddd generate dotnet ... -o ./out`:

```bash
cd out
dotnet restore
dotnet ef migrations add Initial \
    -s . -p . \
    -o Infrastructure/Persistence/Migrations
dotnet ef database update
dotnet run
```

Subsequent edits:

```bash
ddd generate dotnet ./model.ddd -o ./out   # regenerates EF configurations
cd out
dotnet ef migrations add <Description>
dotnet ef database update
```

The generated `.csproj` references `Microsoft.EntityFrameworkCore.Tools`
with `PrivateAssets="all"` so the `dotnet ef` command works
out-of-the-box.

### Renames

Both Drizzle Kit and EF Core detect renames heuristically; both will
prompt you to confirm.  Loom doesn't currently emit explicit rename
hints — if a rename is misdetected as a drop+add, you can hand-edit
the migration before applying.

### Cross-backend data migrations

Out of scope for Loom.  When you need to write a data migration
(populate a column, transform values, etc.), write it in whichever
backend's native form — Drizzle SQL or an EF `Migration.Up` body.
Loom doesn't try to translate between them.

---

## Docker

Both backends ship with a multi-stage `Dockerfile` and a
`.dockerignore`.  Build and run with the standard commands; verified
end-to-end against `docker build` and `docker run`.

### TypeScript

```bash
cd ./out                                # the generator's output dir
docker build -t my-sales:latest .
docker run --rm -p 3000:3000 \
    -e DATABASE_URL="postgres://user:pw@host:5432/db" \
    my-sales:latest
```

The image uses `node:22-alpine` for both build and runtime stages.
Build runs `npm install` + `npm run build`; runtime starts
`node out/index.js` on port 3000.

### .NET

```bash
cd ./out
docker build -t my-sales:latest .
docker run --rm -p 8080:8080 \
    -e ConnectionStrings__Default="Host=db;Port=5432;Database=postgres;Username=postgres;Password=postgres" \
    my-sales:latest
```

Build stage uses `mcr.microsoft.com/dotnet/sdk:8.0`, runtime uses
`mcr.microsoft.com/dotnet/aspnet:8.0`.  ASP.NET Core listens on port
8080 (`ASPNETCORE_URLS=http://+:8080`).

### Customising

Both Dockerfiles are intentionally minimal — they assume a single-
service deployment.  For health checks beyond `/health`, multi-arch
builds, sidecar containers, BuildKit secrets, or alternate base
images, pin the `Dockerfile` in `.loomignore` and edit freely.

### `/health`

Every generated deployable mounts a `/health` endpoint that returns
`{"status":"ok"}` (port 3000 on Hono, 8080 on .NET).  It's used by
the compose healthchecks below and is the natural target for any
external smoke test.

### `docker-compose.yml` (system mode)

`ddd generate system` emits a `docker-compose.yml` at the output
root that wires every deployable to a postgres service, with a
healthcheck on `/health` per deployable:

```bash
cd ./out                # the generator's output dir
docker compose build    # builds each deployable's Dockerfile
docker compose up -d    # starts postgres + every deployable
curl http://localhost:8080/health   # → {"status":"ok"} once api is healthy
docker compose down
```

The compose file is a generated artefact — pin it via `.loomignore`
if you customise it, since regenerating would otherwise overwrite
your changes.

#### Per-deployable databases

Each deployable owns its own postgres database, isolated from peers
sharing the same `db` service.  This is necessary because EF Core's
`EnsureCreated` is all-or-nothing per database: with two .NET
deployables on a shared DB, whichever boots first creates only its
own subset of tables, and the second deployable sees existing tables
and creates nothing — silently leaving its own tables missing.

`ddd generate system` emits `db-init/00-create-databases.sql` with
one `CREATE DATABASE <slug>;` per deployable.  Postgres mounts the
directory as `/docker-entrypoint-initdb.d/`, which runs once on the
first boot of an empty `pgdata` volume.  Each deployable's
connection string is then scoped to its own database
(`Database=api`, `Database=catalog_api`, etc.).

To start fresh after schema changes that EF Core's `EnsureCreated`
won't pick up (it only creates; it never alters), drop the volume:

```bash
docker compose down -v && docker compose up -d
```

For production, use the per-backend migration tools instead of the
init script + `EnsureCreated` combo (see *Migrations workflow*
above).

Loom does **not** generate k8s manifests or CI pipelines — those are
project-init concerns, not derived from the `.ddd` source.

---

## End-to-end test

Loom ships an opt-in vitest e2e (`test/e2e.test.ts`) that exercises
the whole pipeline against a real Docker daemon:

1. Generates the `examples/acme.ddd` system to a temp directory.
2. Runs `docker compose build` on the resulting tree.
3. Runs `docker compose up -d` (postgres + both deployables).
4. Polls `/health` on every deployable's port until each returns
   `{"status":"ok"}`.
5. `docker compose down -v` + cleans the temp directory.

Roughly 90 seconds end-to-end with cached base images.  Stays out of
the default `npm test` so the unit / generator suite remains fast:

```bash
npm test         # unit + parser + generator + CLI tests, ~5s
npm run test:e2e # the full Docker smoke, ~90s
```

The e2e is gated on `LOOM_E2E=1` *and* `docker ps` succeeding, so it
silently skips on any machine without Docker access.

In sandboxed environments where the docker daemon's outbound HTTPS
goes through a TLS-rewriting proxy, set `LOOM_E2E_CA_DIR` to the
directory holding the proxy's `*.crt` files; the test will splice
them into each generated Dockerfile before building.  In a normal
environment this variable is unnecessary.

### Generated DSL-level e2e suite

When the source declares `test e2e` blocks (see
[`language.md`](language.md)), `ddd generate system` emits a
ready-to-run vitest project at `<outdir>/e2e/`.  The Loom e2e itself
runs that suite against the live compose stack as a follow-on step,
proving the DSL → fetch lowering reaches the live API:

```bash
# After `docker compose up -d` from the system root:
cd ./out/e2e
npm install && npm test
```

Endpoints default to `http://localhost:<port>` for each deployable.
Override per environment via `E2E_<DEPLOYABLE>_BASE` (e.g.
`E2E_API_BASE=https://staging.example.com`).

### React frontend deployable

A `platform: react` deployable produces a Vite-built SPA with React,
React Query, Zod, and Mantine.  It points at another deployable
(`targets: <name>`); the API base URL is baked from the target's
port at generation time.  Modules are inherited from the target so
the frontend's pages match the backend's surface exactly.

Per aggregate the generator emits three pages:

| Route                  | What it does                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `/<plural>`            | Mantine `<Table>` of every record from `useAll<Agg>()`; row links to detail; create button.   |
| `/<plural>/:id`        | Card with primitive / VO fields, sub-tables for contained parts, one button per public op.    |
| `/<plural>/new`        | Mantine `useForm` over `Create<Agg>Request`, validated by Zod; submit calls `useCreate<Agg>`. |

Public operations on the detail page open a Mantine modal with a
form for the operation's params; on submit, the matching mutation
hook fires and React Query invalidates the affected queries so the
page reflects the new state.

Forms use `@mantine/form` + `mantine-form-zod-resolver`; success and
error from mutations surface via `@mantine/notifications`.

The generated app is a regular Vite project — `npm install && npm
run build && npm run preview` builds and serves a production bundle.

### Playwright UI tests (page objects per aggregate)

Every React deployable ships a Playwright suite under `<deployable>/e2e/`:

```
<deployable>/
├── src/                            # the app
└── e2e/
    ├── package.json                # @playwright/test (kept out of the runtime image)
    ├── playwright.config.ts        # baseURL = http://localhost:<port>, override via E2E_BASE_URL
    ├── smoke.spec.ts               # auto-generated: every list page loads
    └── pages/
        ├── order.ts                # OrderListPage / OrderNewPage / OrderDetailPage
        └── product.ts
```

Page-object classes are derived directly from the IR.  Per aggregate:

- `<Agg>ListPage` — `goto()`, `create()`, `row(id)`, `open(id)`
- `<Agg>NewPage` — `goto()`, `fill(input: Partial<Create<Agg>Request>)`, `submit() → <Agg>DetailPage`
- `<Agg>DetailPage` — `goto()`, `field(name)`, `<part>Count()`, plus one method per public DSL operation typed against `<Op>Request`

A user-written test reads top-down:

```ts
import { OrderListPage } from "./pages/order.js";
import { ProductListPage } from "./pages/product.js";

test("create order, add line, confirm", async ({ page }) => {
  const prod = await new ProductListPage(page).goto()
    .then((p) => p.create())
    .then((p) => p.fill({ sku: "W-1", price: { amount: 5, currency: "USD" } }))
    .then((p) => p.submit());

  const ord = await new OrderListPage(page).goto()
    .then((p) => p.create())
    .then((p) => p.fill({ customerId: "cust", status: "Draft", placedAt: "2024-01-01T00:00" }))
    .then((p) => p.submit());

  await ord.addLine({ productId: prod.id, qty: 3 });
  await ord.confirm();
  await ord.goto();
  expect(await ord.field("status")).toBe("Confirmed");
});
```

The selectors come from stable `data-testid` attributes the React generator
sprinkles on every interactive element:

| Element                      | testid pattern                                  |
| ---------------------------- | ----------------------------------------------- |
| List page root               | `<plural>-list`                                 |
| List "Create" button         | `<plural>-list-create`                          |
| List row                     | `<plural>-row-<id>`                             |
| List row link to detail      | `<plural>-row-<id>-link`                        |
| List cell                    | `<plural>-row-<id>-<field>`                     |
| New page root                | `<plural>-new`                                  |
| New form input               | `<plural>-new-input-<field>` (nested for VOs)   |
| New "Create" submit          | `<plural>-new-submit`                           |
| Detail page root             | `<plural>-detail`                               |
| Detail field display         | `<plural>-detail-<field>`                       |
| Operation button             | `<plural>-op-<opName>`                          |
| Operation modal form         | `<plural>-op-<opName>-form`                     |
| Operation modal input        | `<plural>-op-<opName>-input-<field>`            |
| Operation modal submit       | `<plural>-op-<opName>-submit`                   |
| Contained-part subtable      | `<plural>-detail-<containment>`                 |
| Contained-part row           | `<plural>-detail-<containment>-row-<id>`        |

To run against the live compose stack:

```bash
docker compose up -d
cd <deployable>/e2e
npm install
npx playwright install --with-deps chromium
npx playwright test
```

### Proxy CAs (sandboxed builds)

Each generated deployable contains an empty `certs/` directory (with a
`.gitkeep` placeholder).  Drop your proxy's `*.crt` files into
`<deployable>/certs/` before `docker compose build` and the build
trusts them — the Dockerfile already declares the necessary `COPY` and
`update-ca-certificates`/`NODE_EXTRA_CA_CERTS` lines.  An empty
`certs/` is a no-op, so this costs nothing in environments that don't
need it.

The opt-in `LOOM_E2E_CA_DIR` environment variable (used by
`test/e2e.test.ts`) just copies the host's CAs into each deployable's
`certs/` for you; no Dockerfile rewriting.

### Cross-platform OpenAPI parity check

When the same module is hosted on more than one deployable across
different platforms (e.g. `Catalog` served by both a .NET and a Hono
deployable), the e2e additionally diffs the two OpenAPI specs to
catch generator drift.  Both backends self-describe via their
framework-native OpenAPI emitter:

| Platform | Library              | Endpoint                        |
| -------- | -------------------- | ------------------------------- |
| .NET     | Swashbuckle.AspNetCore | `/swagger/v1/swagger.json`    |
| Hono     | `@hono/zod-openapi`    | `/openapi.json`               |

The check fetches both, builds a `Set<"METHOD path">` from each, and
asserts equality (after normalising path templates so `{id}` and
`:id` collapse).  Infrastructure routes (`/health`, `/openapi.json`,
`/swagger/...`) are excluded from the diff so the comparison stays
focused on aggregate routes.

Why framework-native rather than emitting OpenAPI from the IR:

- Drift you *want* to catch (typo in a controller, wrong status
  code, schema mismatch) only shows up if the spec is derived from
  what the framework actually serves.  An IR-based spec would agree
  with itself even when the running code disagrees.
- Both libraries are well-supported in their ecosystems, so the
  generator's output looks like normal hand-written code rather than
  carrying a bespoke OpenAPI emitter.

If the diff fails, the test logs the offending operations so you
can see exactly which routes drifted on which platform.
