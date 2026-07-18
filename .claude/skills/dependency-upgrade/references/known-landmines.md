# Known upgrade landmines

Each entry is a real failure that a previous bump hit. The point of the list is
that the next bump *checks* it instead of rediscovering it. If a bump matches an
entry, apply the fix. If it hits a new boot-time/API breakage not here, **add an
entry** so the cost is paid once.

Format: symptom → cause → fix → where it's pinned / who found it.

---

## 1. Postgres major bump moves PGDATA and the volume mount

- **Symptom:** the generated `db` container refuses to start. Log:
  `PostgreSQL data in /var/lib/postgresql/data (unused mount/volume)`, or the
  named `pgdata` volume comes up empty / data "disappears" across `up`. The
  backend then can't connect (ECONNREFUSED / the stack never goes healthy).
- **Cause:** `postgres:18` (vs 16) moved the default `PGDATA` to
  `/var/lib/postgresql/18/docker` and moved the declared `VOLUME` to
  `/var/lib/postgresql` (was `.../data`). Mounting the old `/data` path makes the
  18 image refuse to boot (docker-library/postgres#1259).
- **Fix (already in tree — replicate the *pattern* on the next PG major):** in
  `renderDockerCompose` (`src/system/index.ts`, ~line 403) the compose pins
  `PGDATA: /var/lib/postgresql/data` back to the legacy path **and** mounts the
  volume at `- pgdata:/var/lib/postgresql` (NOT `.../data`). A bump to PG19+ must
  re-verify both: the env pin and the mount target.
- **Found by:** #1423 (PG16→18; the image-tag-only narrow diff that
  `conformance-parity`'s path filter skipped, then failed on `main`). **This is
  the canonical "force the compose-boot gate" case — verify with
  `generated-stack-verifier` or a hand `docker compose up`, never trust a green
  compile.**

## 2. Spring Boot 4 drops Flyway auto-configuration

- **Symptom:** Java backend boots but the schema is never created —
  `relation "..." does not exist` at the first query; `findAll` 500s. Compiles
  and `gradle bootJar`s green.
- **Cause:** Spring Boot 4 no longer auto-configures Flyway from `flyway-core` on
  the classpath alone. The migration wiring silently no-ops. (Jackson 3 rode in
  with the same major and shifts `com.fasterxml.jackson.*` behavior — watch the
  document/event-store JSON columns.)
- **Fix:** emit the `spring-boot-starter-flyway` starter **plus**
  `org.flywaydb:flyway-database-postgresql` when migrations exist — exactly what
  `renderGradleBuild` now does (`src/generator/java/emit/program.ts`, the
  `options.flyway` branch). A future Spring Boot major: re-check the Flyway
  starter name and the auto-config story before trusting the compile gate.
- **Found by:** #1427 (Spring Boot 4.1 + Jackson 3). Caught only by booting the
  Java compose stack and migrating — the `java-build.yml` compile gate is blind
  to it.

## 3. Erlang/OTP can't reach hex.pm behind a TLS-fingerprinting proxy

- **Symptom:** `mix local.hex` / `mix deps.get` fails inside the Elixir build
  container with a bare **HTTP 503** — even though the CA is trusted, SNI is
  correct, and `openssl s_client` from the *same container* returns 200. Blocks
  every Dockerised Phoenix build / `test:phoenix`. The daemon, the image pull,
  and `ddd generate system` all succeed; only Hex's network calls fail.
- **Cause:** the egress proxy allowlists by the client's **TLS fingerprint**.
  System OpenSSL (curl, .NET, Gradle, Python stdlib `ssl`) is accepted; Erlang/
  OTP's `:ssl` presents a different fingerprint and is rejected.
- **Fix:** set **`LOOM_HEX_MIRROR=1`**. `test/e2e/support/hex-mirror.ts` +
  `scripts/hex-mirror.py` start a loopback TLS-terminating mirror Erlang can talk
  to (clean localhost TLS, gateway never in that hop), re-originating to hex.pm
  with Python's accepted fingerprint; runs the container with
  `--network host --add-host {builds,repo,hex}.hex.pm:127.0.0.1`, the mirror CA
  mounted, and `HEX_CACERTS_PATH` pointed at it (Hex uses its **own** CA bundle,
  not the OS store — without this it rejects the mirror cert as "Unknown CA").
  Bytes pass through verbatim so registry signature + tarball checksums still
  verify. Needs `python3` + `openssl` and the privilege to bind `:443`. Unset
  (CI runners with direct hex.pm), it's a no-op.
  ```bash
  LOOM_PHOENIX_VANILLA_BUILD=1 LOOM_HEX_MIRROR=1 npm run test:phoenix
  ```
- **Found by:** `experience_gathered.md` §14; documented in `docs/tools.md`
  ("`LOOM_HEX_MIRROR` — Elixir builds behind a fingerprinting proxy") and
  CLAUDE.md. Relevant for any Phoenix/Ecto/OTP bump verified in this sandbox.

## 4. TypeScript 6 breaks `@types/node` global resolution on the Node-only islands

- **Symptom:** after bumping the **toolchain** TypeScript to 6, `tsc -b` reports
  ~49 errors about missing Node globals (`process`, `Buffer`, `__dirname`, etc.)
  concentrated in `src/cli/`, `src/mcp/`, and `src/language/main.ts` — code
  unrelated to whatever dep pulled TS 6 in.
- **Cause:** TS 6 changed how `@types/node` globals resolve across the Node-only
  islands (the modules that legitimately use Node APIs while the rest of the
  toolchain stays browser-safe).
- **Fix:** **keep TS 6 in its own dedicated PR** — never fold it into a Langium
  bump or a feature PR (it generates noise that masks the real diff). Resolve the
  `@types/node` resolution at the island boundary as its own unit of work.
  Langium 4 needs only TS ≥ 5.8, so pair Langium 4 with **TS 5.9**, and schedule
  TS 6 separately after.
- **Found by:** #1463 (deferred from the #1430 Langium bump for exactly this
  reason). **Status: landed** — root `package.json` is now `typescript ~6.0.0`
  and the islands resolve clean. This entry stays as the diagnostic for the
  *next* TS major (TS 7): re-isolate it to its own PR, expect the island-boundary
  noise. Note: **every** generated stack (`v1`/`v3`/`sv1`/`vue1`/`ng1`) also pins
  TS 6 in its `.hbs` — a *different* surface (B), gated by the generated-build
  matrix, independent of the toolchain TS version.

## 5. Langium 3.3 → 4.x API renames

- **Symptom:** after bumping `langium` (and `langium-cli`), `tsc -b` fails across
  `src/language/` — scope provider, LSP providers, exports indexer no longer
  type-check; and `langium-generated.yml` may flag drift if you forgot to
  regenerate.
- **Cause:** Langium 4 renamed/reshaped several APIs the toolchain leans on:
  - `computeExports` → **`collectExportedSymbols`**
  - `findDeclaration` → **`findDeclarations`** (now plural)
  - the **hover provider returns a raw string** (return-shape change)
  - `Reference.ref` is now **required** (not optional)
  - `copyAstNode`'s ref-builder gained an `origReference` parameter
  - `vscode-languageserver` bumped alongside, with subpath imports `/node`,
    `/browser`
- **Fix:** bump `langium` + `langium-cli` + `vscode-languageserver` + TS 5.9 in
  **one** PR. Then `npm run langium:generate` and commit
  `src/language/generated/` (eyeball the AST/reflection diff). Walk the breaks in
  `src/language/{ddd-module,ddd-scope}.ts`, `validators/*`, `lsp/*`, and the
  `langium/test` helpers in `test/language/lsp/*`. The custom scope provider
  (`ddd-scope.ts`) is the highest-risk file — Loom's cross-aggregate constraint
  rides on it. **Gate: full `npm test` + `langium-generated.yml` determinism must
  stay green.** When it lands, `npm audit` should reach ~0 (drops the
  chevrotain→lodash chain that has no patched version).
- **Found by:** #1430; backlog in `docs/old/proposals/dependency-upgrades.md` and the
  root-toolchain row of `docs/audits/stack-versions-audit.md`. **Status: landed**
  — root is `langium ~4.3.0` / `langium-cli ~4.3.0` / `vscode-languageserver
  ~10.0.0`, and the renames are live (`collectExportedSymbols` in
  `ddd-scope.ts:186`/`263`; `findDeclarations(leaf)[0]` in
  `lsp/ddd-references.ts:77` + `lsp/ddd-rename.ts:68`;
  `getAstNodeHoverContent → string | undefined` in `lsp/ddd-hover.ts:64`). Keep
  this entry as the map for the **Langium 4.x → 5** bump. (Stale residue: a
  comment at `ddd-scope.ts:100` still says `computeExports` — comment only.)

---

## Swashbuckle.AspNetCore 9.0.0+ → Microsoft.OpenApi 2.0 rewrites the emitted filters

- **Symptom:** bumping `Swashbuckle.AspNetCore` past 8.1.4 fails the generated
  .NET build with `CS0234` (`Microsoft.OpenApi.Models` / `Microsoft.OpenApi.Any`
  namespaces gone) and `CS0535` on the three emitted filters
  (`ProblemDetailsResponsesFilter`, `ListResponseWrapperFilter`,
  `RequiredFromCtorParamFilter` in `src/generator/dotnet/emit/api.ts`) —
  `ISchemaFilter.Apply` now takes `IOpenApiSchema`, not `OpenApiSchema`.
- **Cause:** Swashbuckle **9.0.0** moved to **Microsoft.OpenApi 2.0**. That is a
  breaking rewrite of the object model the filters build by hand: `OpenApiSchema.
  Type` went from `string` to the `JsonSchemaType` flags enum, `Nullable` folded
  into it, and `OpenApiReference` + `ReferenceType.Schema` became
  `OpenApiSchemaReference`.
- **Fix:** port all three filters to the 2.0 object model — `OpenApiSchema.Type`
  string → the `JsonSchemaType` flags enum (`Nullable = true` → `| JsonSchemaType.
  Null`, which the 3.0 writer serializes back to `nullable: true`);
  `new OpenApiSchema { Reference = new OpenApiReference { ... } }` → a distinct
  `new OpenApiSchemaReference(id, hostDoc)` node; `ISchemaFilter.Apply` takes
  `IOpenApiSchema` (cast to the concrete `OpenApiSchema` to mutate
  `Required`/`Properties`); property maps are keyed by `IOpenApiSchema`. Then
  **boot the backend and diff `/openapi.json` against the pre-bump spec** —
  these filters exist to keep the .NET spec byte-aligned with Hono/Phoenix, so a
  shape drift is a parity regression, not just a compile break.
- **Status: migrated** (Swashbuckle **10.2.3**, 2026-07-18). Output stays
  OpenAPI 3.0.4; the diff vs 8.1.4 is a single benign root `tags: []` array that
  the parity gate (`test/e2e/e2e.test.ts`) does not compare. Keep this entry as
  the map for the **Microsoft.OpenApi 3.x** bump.
- **Found by:** the 2026-07-18 .NET currency refresh.

## Mediator (martinothamar) 2 → 3 changes the pipeline signature and rejects handler-less notifications

- **Symptom:** bumping `Mediator.SourceGenerator` / `Mediator.Abstractions` to
  3.x fails the generated .NET build with `MSG0005: MediatorGenerator found
  message without any registered handler` on every domain event, plus `CS0535`
  on `ValidationBehavior` (`IPipelineBehavior.Handle` no longer matches).
- **Cause:** Mediator 3.0 (a) changed the `IPipelineBehavior<TRequest,
  TResponse>.Handle(...)` / `MessageHandlerDelegate` signature, and (b) made a
  notification with **no** registered handler a hard source-generator error —
  but Loom emits domain-event `INotification`s that nothing subscribes to by
  design.
- **Fix:** reorder the emitted `IPipelineBehavior.Handle` params to
  `(TMessage message, MessageHandlerDelegate<TMessage, TResponse> next,
  CancellationToken cancellationToken)` — the delegate call `next(message,
  cancellationToken)` is unchanged — in `ValidationBehavior` (`validator-emit.ts`)
  and both `ExecutionContextBehavior` variants (`emit/domain-log.ts`). For
  MSG0005: it is a **warning** by default (only `/warnaserror` promotes it), and
  the handler-less events are intentional (outbox / event log / external
  consumers), so add `MSG0005` to the csproj `<NoWarn>` list.
- **Status: migrated** (Mediator **3.0.2**, 2026-07-18). Compiles clean under
  `/warnaserror` across the whole `test:dotnet` fixture set incl. the
  event-sourcing example. Keep as the map for **Mediator 4**.
- **Found by:** the 2026-07-18 .NET currency refresh.

## EF Core `.Relational` floats to the transitive floor in the sibling Tests project

- **Symptom:** the generated `<Ns>.Tests` project fails `dotnet build` with
  `MSB3277: conflicts between different versions of
  Microsoft.EntityFrameworkCore.Relational` (e.g. 10.0.4 vs 10.0.10), even though
  the main backend builds clean.
- **Cause:** the main csproj pins the EF Core *base* package but gets `.Relational`
  lifted to the base version only via `.Design`/`.Tools`, which are
  `PrivateAssets=all` — so that lift does **not** flow across the `ProjectReference`
  to the Tests project, where `.Relational` falls back to the transitive floor of
  `Npgsql.EntityFrameworkCore.PostgreSQL` + `Ardalis.Specification.EntityFramework
  Core`.
- **Fix:** pin `Microsoft.EntityFrameworkCore.Relational` **explicitly** (non-private)
  at the base version in `renderCsproj` / `efcore-persistence.ts`, so it flows to
  Tests. Landed in the 2026-07-18 refresh. Re-check the pin whenever the EF Core
  base version moves.
- **Found by:** the 2026-07-18 .NET currency refresh (the emitted Tests project is
  not CI-gated, so this stayed latent).

---

## Watch-list (no incident yet, but check on the relevant major)

- **Node 24 / Vite 8 / Elixir 1.18** (#1422 currency batch) — base-image and
  build-tool majors; verify the generated stack still boots and `vite build`s.
- **Python 3.13** (#1424) — `requires-python >=3.13` in `python/pins.ts` and
  `python:3.13-slim` base image; re-check ruff/mypy/pytest floors move together.
- **drizzle-orm** (pre-1.0, every minor is breaking) — bump `drizzle-orm` +
  `drizzle-kit` together in the **active** hono pins (`hono/v5/pins.ts` is the
  default; `v4/pins.ts` is the legacy lane); run `LOOM_TS_BUILD=1`.
- **Loose ranges to tighten opportunistically:** `postgrex` was historically
  `">= 0.0.0"` (now `~> 0.20`); never re-loosen a Hex/npm range to a bare
  any-version on a bump.
- **The zod 3→4 / TS 6 / vitest 4 cross-major set already forked into
  `hono@v5`** — that's the *resolution* of the deferral, not a pending item.
  Bareword `platform: node` resolves to **v5** (zod 4 / TS 6); `node@v4` stays
  pinnable (zod 3 / TS 5). Honor the package boundary: a within-major dep bump
  edits the relevant version's `pins.ts`; a fresh cross-major set is a new
  package version, not an in-place edit. The two pins.ts files **drift on
  purpose** — don't "sync" them.
