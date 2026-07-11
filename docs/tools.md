# Loom — Tools & Workflow

This document covers the CLI, the `.loomignore` escape hatch, watch
mode, the dev/test loop with Docker, the Playwright UI suite, the
cross-platform OpenAPI parity check, and how migrations interact with
the native database tooling (Drizzle Kit and EF Core migrations).

- For language syntax see [`language.md`](language.md).
- For per-platform feature reference (what each backend emits, file
  by file) see [`generators.md`](generators.md).
- For architecture (AST → IR → templates) see
  [`technical.md`](technical.md).
- For licensing see [the LICENSE file](../LICENSE) — Loom is
  source-available under FSL-1.1 with an Apache-2.0 future license.

---

## CLI

The `ddd` binary lives at `bin/cli.js` and exposes these sub-commands:

```bash
ddd new <name> [--platform …] [--template …]      # scaffold a starter project
ddd parse <file.ddd>                              # parse + validate
ddd generate ts <file.ddd> -o <outdir>            # emit a single TypeScript project (legacy)
ddd generate dotnet <file.ddd> -o <outdir>        # emit a single .NET project (legacy)
ddd generate system <file.ddd> -o <outdir>        # emit every deployable + docker-compose.yml
ddd verify <file.ddd> --results <results.json>    # join test results onto the requirements graph
ddd snapshot <file.ddd> -o <outdir>               # capture provenance rule snapshots
ddd patch <file.ddd> --patches <patches.json>     # apply node-addressed model patches
ddd trace <logfile>                               # translate a runtime stack-trace back to .ddd source
ddd breakpoints <file.ddd> --line <n>             # resolve a .ddd source line to the generated file:line(s) — the reverse of `trace`
```

`generate system` additionally accepts `--sourcemap`, which also emits
`.loom/sourcemap.json` (construct- and statement-granular `.ddd` ↔ generated-line
origins). `ddd trace <logfile>` reads that file to rewrite a backend stack-trace so
each frame points at the `.ddd` line it was generated from — the debugging companion
to the source map. For Node/V8 frames (the only dialect whose frames carry a column),
the column selects the expression-level `targetCol` region containing it and the
annotation prints the exact `.ddd` `path:line:col` of that sub-expression; every other
format (and any column matching no region) keeps the line-granular `path:line`.
See [`loom-artifacts.md`](loom-artifacts.md).

`ddd breakpoints <file.ddd> --line <n>` is the reverse lookup: given a
`.ddd` source line, it prints every generated `file:line` that line produced
(narrowest construct first — a line can host nested constructs, e.g. an
aggregate declaration and a narrower operation inside it), sourced from the
same `.loom/sourcemap.json` (`--map`/`-o, --out` follow the identical
discovery rule as `trace`). A line with no mapping prints an informative
message and still exits 0 — a future editor/DAP integration's primitive for
translating "set a breakpoint on this `.ddd` line" into the real
backend-native breakpoint(s) to arm. See
[`docs/plans/dap-node-debug.md`](plans/dap-node-debug.md).

### `patch` — apply node-addressed model patches

`ddd patch <file.ddd> --patches <patches.json>` applies a list of
node-addressed model patches (the protocol from
[`proposals/ai-authoring-loop.md`](proposals/ai-authoring-loop.md) §4 —
the same patch shape that `parse --json` / `generate --json`
diagnostics carry in their `fixHint`). `--patches -` reads the JSON
from stdin; the file may be a bare array or `{ "patches": [...] }`.

By default the **patched source is printed to stdout** so the command
composes (`ddd patch m.ddd --patches p.json > m2.ddd`); `--json` emits
the structured `PatchResult` instead. Exits non-zero if any patch fails
to apply.

### `new` — scaffold a starter project

`ddd new <name>` is the on-ramp: it writes a small, **already-valid**
starter into `./<name>/` (or `--out <dir>`) so a newcomer goes from
nothing to an editable model without hand-assembling `system` /
`deployable` / `dataSource` wiring.

```bash
ddd new acme                                   # hono backend + React (mantine), crud template
ddd new acme --platform dotnet --design shadcn # .NET backend + React (shadcn)
ddd new acme --platform elixir                 # Phoenix LiveView fullstack (ashPhoenix)
ddd new acme --platform elixir --design mui    # Phoenix backend + a React (mui) frontend
ddd new acme --platform java                   # Spring Boot backend + React (mantine)
ddd new acme --platform python                 # FastAPI backend + React (mantine)
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--platform <hono\|dotnet\|elixir\|java>` | `hono` | Backend platform (ports: hono 3000, dotnet 8080, elixir 4000, java 8081). Prints a hint listing the alternatives when defaulted. |
| `--template <blank\|crud>` | `crud` | `blank` = one aggregate; `crud` = two aggregates with a repository `find`. |
| `--design <mantine\|shadcn\|mui\|chakra\|ashPhoenix>` | `mantine` (`ashPhoenix` for elixir) | Frontend. A React pack scaffolds a separate React deployable; `ashPhoenix` makes Phoenix a single LiveView fullstack. `ashPhoenix` is only valid with `--platform elixir`. |
| `-o, --out <dir>` | `./<name>` | Output directory. |
| `--force` | off | Scaffold into an existing, non-empty directory. |

It writes exactly three files — `main.ddd`, `README.md` (the run steps),
and a commented `.loomignore` — and **validates the rendered model
in-memory before writing anything**, so a starter is never emitted in a
broken state. It does not emit the project tree; the README walks you
through `ddd generate system main.ddd -o .` and `docker compose up`.

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

### Multi-file projects

`generate system` accepts an entry file (conventionally `main.ddd`)
that may declare per-file `import "./path"` statements at the top.
The CLI walks the import graph transitively, registers every
reachable document with the Langium workspace, and produces a single
project from the merged model.  See
[`language.md`](language.md#multi-file-projects-import-and-root-level-shared-types)
for the language surface; the original design rationale is preserved
at [`plans/multi-file-source.md`](plans/multi-file-source.md).

`generate ts` / `generate dotnet` remain single-file: they read just
the file you point them at, no import-graph walking.

Each deployable's folder name is a lowercase slug derived from the
deployable's name (e.g. `catalogWeb` → `catalog_web`); inside the
project the .NET namespace and `.csproj` keep the capitalised form.

### Common options

| Flag | Applies to | Effect |
| --- | --- | --- |
| `-o, --out <dir>` | every `generate`, `verify`, `snapshot` | Output directory.  Created if missing.  Required on `generate system`, `generate ts`, `generate dotnet`, and `snapshot`; optional on `verify` (defaults to the `.ddd` file's directory). |
| `-w, --watch` | every `generate` | Re-run the generator whenever the source `.ddd` file changes (see [Watch mode](#watch-mode) below). |
| `--dry-run` | every `generate`, `snapshot` | List every path that would be written (plus any paths skipped via `.loomignore`).  Writes nothing. |
| `--trace` | every `generate` | Emit trace-level domain instrumentation (`value_computed`, `precondition_evaluated`, …) into the generated project.  Off by default — see [`observability.md`](observability.md). |
| `--allow-destructive` | `generate system` | Permit destructive delta migrations (column/table drops, and NOT-NULL column adds without a default on an existing table).  Off by default a destructive delta aborts with a `loom.migration-destructive` error — see [`migrations.md`](migrations.md) § Destructive changes. |

`ddd parse` exits non-zero if the source has errors.  `ddd generate`
runs validation first and refuses to emit if there are any errors.

### `verify` and `snapshot`

`ddd verify` joins a JSON of test results onto the requirements graph
built from `requirement` / `solution` / `testCase` declarations, writes
`.loom/verification.json` + `.loom/verification.md` under `--out`, and
sets a non-zero exit code if `--require-all` is set and any requirement
remains unverified, or if `--min <pct>` is set and the verified
percentage is below it.  `--json` also prints the verification JSON to
stdout.  See [`traceability.md`](traceability.md) for the artefact
format.

`ddd snapshot` captures one immutable `<ts>-<guid>.loomsnap.json` per
system under `<out>/.loom/snapshots/`, recording the current provenance
rules for every `provenanced` field.  Run it as an explicit prebuild
step whenever your provenance rules change; the generated runtime
loads the latest snapshot at startup so live writes preserve full
history.  See [`language.md`](language.md) for the `provenanced`
keyword.

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

Loom **owns migration generation** end-to-end via a snapshot-and-diff
pipeline.  Each `generate system` run compares the current source
against a checked-in baseline at
`.loom/snapshots/<Subdomain>.snapshot.json`, derives a platform-neutral
`MigrationsIR` (`src/ir/types/migrations-ir.ts`), and the per-backend
emitters translate that into a single dated migration file per
backend.  Subsequent regens emit only the delta — adding a property
produces one `ALTER TABLE … ADD COLUMN …` per backend.  See
[`generators.md` § Migrations](generators.md) for the per-platform
output table and the runtime application path.

The user-facing workflow is **regenerate, then run**:

```bash
ddd generate system ./model.ddd -o ./out   # emits SQL/migrations alongside the rest
cd out
docker compose up                          # backends apply migrations at boot
```

There is no separate `db:generate` / `dotnet ef migrations add` step
— Loom owns the diff.  Every DB backend self-applies on boot:

| Backend | Files emitted | Applied by |
|---|---|---|
| Hono (Drizzle) | `<deployable>/db/migrations/<ts>_<name>.sql` + `db/migrations/meta/_journal.json` | `drizzle-orm/node-postgres/migrator`'s `migrate()` called from `index.ts` at startup; `npm run db:migrate` also wired for out-of-band runs. |
| .NET (EF Core) | `<deployable>/Infrastructure/Persistence/Migrations/<Ts>_<Name>.cs` with `b.Sql(...)` raw-SQL `Up` / `Down` bodies | `db.Database.Migrate()` in `Program.cs` at startup (idempotent — EF's `__EFMigrationsHistory` table tracks what's been applied). |
| Phoenix (Ecto) | `<deployable>/priv/repo/migrations/<ts>_<name>.exs` Ecto migrations | `mix ecto.migrate` from the entrypoint script; `mix ecto.setup` on first boot. |
| Python (SQLAlchemy) | `<deployable>/migrations/<version>_<module>_<name>.sql` raw-SQL files | `run_migrations()` from the FastAPI lifespan applies pending files in order, tracking applied tags in a `__loom_migrations` table (the Drizzle-runtime-migrator pattern). |
| Java (Spring/Flyway) | `<deployable>/src/main/resources/db/migration/V<version>.<n>__<Module>_<Name>.sql` Flyway scripts | Flyway runs them on Spring Boot startup (tracked in `flyway_schema_history`). |

The `.loom/snapshots/<Subdomain>.snapshot.json` files are
repo-checked-in baselines — committing them is what gives the next
regen something to diff against.  `ddd snapshot` (a separate
command, for provenance) does NOT touch them; those are governed by
`src/system/snapshot.ts` and rewritten on every `generate system`.

### Renames

Column / table renames are not detected — they emit as drop+add,
which destroys data.  Until a `@migration(rename: "old")` annotation
ships, hand-edit the dated migration file to a single
`RENAME COLUMN` (or equivalent) before committing the regen.

### Cross-backend data migrations

Out of scope for Loom.  When you need to populate a column or
transform values, write it in whichever backend's native form —
raw SQL inside the Drizzle `.sql` migration or an EF `Migration.Up`
body.  Loom doesn't try to translate between them.

---

## Docker

Every backend ships with a multi-stage `Dockerfile` and a
`.dockerignore`.  Build and run with the standard commands; verified
end-to-end against `docker build` and `docker run`.  The TypeScript and
.NET images are walked through below as representatives; the Python,
Java, and Phoenix images follow the same multi-stage shape.

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

Build stage uses `mcr.microsoft.com/dotnet/sdk:10.0`, runtime uses
`mcr.microsoft.com/dotnet/aspnet:10.0`.  ASP.NET Core listens on port
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

Compose is the inner-loop story.  For a cluster, `ddd generate system
--k8s` *additionally* emits a Helm chart (`helm/`) plus the raw manifests
it renders to (`k8s/`) alongside the compose file — see
[`kubernetes.md`](kubernetes.md).  Loom still does **not** generate CI
pipelines (image build/push remains a project-init concern).

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

## Compiling generated backends in Docker

The opt-in per-backend build suites (`test:dotnet`, `test:java`,
`test:phoenix`, `test:python`, plus their `obs-*` / `auth-e2e-*`
siblings) emit a project from a fixture and compile it with the real
toolchain.  Two of them run the toolchain **inside Docker** rather than
on the host:

| Suite | Toolchain | Runs in |
|---|---|---|
| `test:java` | JDK 21 + Gradle | host (no container) |
| `test:dotnet` | .NET SDK 8 | host (no container) |
| `test:phoenix` | `mix` (Elixir/Ecto) | **`hexpm/elixir` container** |
| `test:python` | `uv` + ruff + mypy + pytest | host |

A managed remote/sandbox environment usually ships the Docker **client**
but not a running daemon — start one with `dockerd` (root /
passwordless-sudo) before any Docker-backed suite, e.g. `sudo dockerd
>/tmp/dockerd.log 2>&1 &`.  Image pulls from Docker Hub / `mcr.microsoft.com`
work through the standard egress.  An agent verifying a backend change
can generate a project (`node bin/cli.js generate system <f.ddd> -o out`)
and compile it directly: Gradle/.NET on the host, or
`docker run … hexpm/elixir … 'mix deps.get && mix compile'` for Phoenix.

### `LOOM_HEX_MIRROR` — Elixir builds behind a fingerprinting proxy

Some egress proxies allowlist by the **client's TLS fingerprint**: the
system OpenSSL fingerprint (curl, .NET, Gradle, Python's stdlib `ssl`)
is accepted, but **Erlang/OTP's `:ssl` is rejected with a bare HTTP 503**
even though the CA is trusted and SNI is correct.  That makes
`mix local.hex` / `mix deps.get` fail inside the Elixir container, which
otherwise blocks every Dockerised Phoenix build — the daemon, the image
pull, and `ddd generate system` all succeed; only Hex's network calls
fail.

Set `LOOM_HEX_MIRROR=1` to work around it.  `test/e2e/support/hex-mirror.ts`
starts a loopback TLS-terminating mirror (`scripts/hex-mirror.py`, stdlib
Python only) that re-originates hex.pm traffic with the accepted
fingerprint, and runs the build container with
`--network host --add-host {builds,repo,hex}.hex.pm:127.0.0.1`, the mirror
CA mounted, and `HEX_CACERTS_PATH` pointed at it (Hex uses its own CA
bundle, not the OS store).  Bytes pass through verbatim, so Hex's registry
signature and tarball checksums still verify.

```bash
# Phoenix build behind a TLS-fingerprinting proxy (needs python3 + openssl
# on the host and the privilege to bind :443):
LOOM_PHOENIX_BUILD=1 LOOM_HEX_MIRROR=1 npx vitest run \
  test/e2e/generated-phoenix-build.test.ts -t "paged.ddd"
```

Unset (the default, and every CI runner with direct hex.pm access) the
flag is a no-op and the suite runs `docker run` exactly as before.

### Java images behind a fingerprinting proxy — build the jar on the host

The generated Java deployable's Dockerfile is a two-stage build whose first
stage runs Gradle *inside* the `gradle` image.  Behind the same
fingerprint-allowlisting proxy, that stage fails the way Erlang does: the
in-container JVM's TLS fingerprint is rejected (bare 503 / connection reset
resolving the Spring Boot plugin), while the **host** Gradle — same
repositories, same proxy — resolves everything (pass the proxy to the JVM via
`JAVA_TOOL_OPTIONS="-Dhttps.proxyHost=… -Dhttps.proxyPort=…"` if it isn't
picked up from the environment).

The recipe that works everywhere: **build the bootJar on the host, containerise
only the jar.**

```bash
cd out/<java-deployable>
gradle bootJar                                  # host JDK 21 + Gradle
cp build/libs/app.jar app.jar                   # .dockerignore excludes build/,
                                                # so copy the jar INTO the context
cat > Dockerfile.local <<'EOF'
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY app.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
EOF
docker build -f Dockerfile.local -t <service> .
```

Point the service at the local image (edit the compose service's `image:` /
drop its `build:`) and the rest of the stack boots normally.  This is a
sandbox-only workaround, not a generator concern — CI runners and normal dev
machines run the in-container Gradle stage as-is.

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
    ├── <System>.ui.spec.ts         # auto-generated from `test e2e "..." against <react-deployable>` blocks (when present)
    └── pages/
        ├── order.ts                # OrderListPage / OrderNewPage / OrderDetailPage
        └── product.ts
```

The DSL `test e2e "..." against <react-deployable> { … }` form lowers
to a Playwright spec (`<System>.ui.spec.ts`) routing every
`ui.<aggregate>.<verb>(...)` call through the page objects above —
see [`language.md`](language.md#ui-e2e-tests-against-a-react-deployable).

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

When the same subdomain is hosted on more than one deployable across
different platforms (Hono, .NET, Phoenix, Python, Java — all five are
diffed), the e2e additionally diffs their OpenAPI specs across every
backend pair to catch generator drift. Each backend self-describes via
its framework-native OpenAPI emitter (Java's springdoc spec is brought
to parity by an `OpenApiContractCustomizer` document filter):

Every backend serves the spec at the **aligned** path `/openapi.json` (root):

| Platform | Library              | Endpoint        |
| -------- | -------------------- | --------------- |
| .NET     | Swashbuckle.AspNetCore | `/openapi.json` |
| Hono     | `@hono/zod-openapi`    | `/openapi.json` |
| Phoenix  | OpenApiSpex           | `/openapi.json` |
| Python   | FastAPI               | `/openapi.json` |
| Java     | springdoc            | `/openapi.json` |

Interactive UIs (FastAPI's `/docs` + `/redoc`, springdoc's `/swagger-ui.html`)
are gated by `LOOM_OPENAPI_UI` (default on; the k8s chart sets it `false` to
keep an unauthenticated API explorer off production). The `/openapi.json` spec
stays available regardless.

The check fetches each diffed backend's spec, runs
`diffSpecs(ref, other) → ParityDiff` (pure helper in
`test/_helpers/openapi-normalize.ts`) for every backend pair over the
five diffed backends — ten pairs (`hono ↔ dotnet`, `hono ↔ phoenix`,
`dotnet ↔ phoenix`, `hono ↔ python`, `dotnet ↔ python`,
`phoenix ↔ python`, `hono ↔ java`, `dotnet ↔ java`, `python ↔ java`,
`phoenix ↔ java`) — and reports any divergence across the dimensions:
ops sets, response cardinality, schemas sets, per-schema
field/required-set drift, per-property type/format, path-param types,
query params, request- and response-body schema refs, operationIds,
enum value-sets, and error responses.

The CI workflow (`.github/workflows/conformance-parity.yml`) runs in
**strict mode** (`LOOM_E2E_STRICT_PARITY=1`): each divergence is a hard
`expect(...).toBe(...)` assertion. Local `npm run test:e2e` defaults to
report-only — the divergence list logs as `console.warn` but the test
passes either way.

Why framework-native rather than emitting OpenAPI from the IR:

- Drift you *want* to catch (typo in a controller, wrong status
  code, schema mismatch) only shows up if the spec is derived from
  what the framework actually serves.  An IR-based spec would agree
  with itself even when the running code disagrees.
- Both libraries are well-supported in their ecosystems, so the
  generator's output looks like normal hand-written code rather than
  carrying a bespoke OpenAPI emitter.

For the full dimension reference, how to read a divergence report,
and the checklist for adding a tenth dimension, see
[`conformance.md`](conformance.md).
