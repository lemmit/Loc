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

Loom does **not** generate k8s manifests or CI pipelines — those are
project-init concerns, not derived from the `.ddd` source.
