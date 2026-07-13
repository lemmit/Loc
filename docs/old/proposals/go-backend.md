# Go backend — net/http (Chi) + sqlc/GORM generator

> Status: **PROPOSED (vision / not scheduled).** Captures the design and
> effort shape for a domain-logic backend in Go, the largest backend
> ecosystem Loom does not yet target. **No grammar/IR change** — purely
> additive codegen on the `PlatformSurface` contract. Builds on
> [`docs/platforms.md`](../../platforms.md) (the surface contract) and
> [`docs/generators.md`](../../generators.md) (per-backend feature matrix).
> Sibling of [`java-backend.md`](./java-backend.md) (since **shipped**
> — its ~6–9-week parity estimate proved out, a useful calibration for
> the numbers below) and [`php-backend.md`](./php-backend.md) — the
> three "new domain-logic backend" studies.

## TL;DR

Add a **Go** backend — `net/http` with the **Chi** router, **sqlc** (or
GORM) over **Postgres** — in-tree at `src/platform/go.ts` +
`src/generator/go/`, implementing `PlatformSurface`. It reads the
platform-neutral `EnrichedLoomModel` directly: no new IR, no new lowering
phase, no language change. The yardstick is the existing backends
(TS/Hono ≈ 7.2k LOC / 28 files; .NET ≈ 13.7k LOC / 48 files): Go lands in
the **~7–9k LOC** band — closer to Hono than .NET, because Go's
explicitness produces more lines per concept but it skips an ORM-heavy
mapping layer if `sqlc` is chosen.

**Effort: ~5–8 engineer-weeks** for parity with Hono, or **~2.5–3.5
weeks** for a walking skeleton (structs + repos + REST + Postgres passing
the build and wire-conformance gates, deferring workflows/views/auth/
observability).

The hard part is already done once in the IR. A backend writes
**emitters, not a compiler**. Specifically *not* required:

- **No re-resolution** — every IR node carries `refKind` (9), `callKind`
  (4), `receiverType` / `memberType`, `isCollectionOp`. The Go renderers
  dispatch on these.
- **No migration derivation** — `MigrationsIR` is derived once in phase ⑨
  (`migrations-builder.ts`, shared). Go only translates `MigrationStep[]`
  → golang-migrate `.sql` files (it can reuse `sql-pg.ts` almost verbatim,
  since the target is Postgres).
- **No new IR, no new phase** — `language/` and `ir/` are untouched.

## Why Go

It is the dominant language of the **"small services wired into a
`docker compose` stack"** shape that `ddd generate system` already
produces — exactly Loom's output topology — yet no current backend
represents it. The four shipped/in-flight backends cover the JS runtime
(Hono), the .NET/JVM enterprise tier (.NET, +Java), the BEAM (Phoenix),
and the scripting tier (+Python). Go is the one major backend culture
with nothing in the matrix, and it is over-represented in the
greenfield-microservice market Loom is pitched at. A Go target exercises
the IR's platform-neutrality claim against a language with **no classes,
no exceptions, and value semantics** — the most structurally distinct
backend yet, and therefore the strongest evidence the IR is truly
neutral.

## Framework choices

| Axis | Choice | Rationale |
|---|---|---|
| Web / routing | **Chi** (`go-chi/chi`) | `net/http`-native, middleware-friendly, the conventional choice for a REST service; affects only the route-table emit shape. `gorilla/mux` or stdlib `http.ServeMux` (Go 1.22 routing) are config flips. |
| Persistence (default) | **sqlc** (typed SQL → Go) | Closest to the IR's "typed find-filter `ExprIR` → query" model; generated query funcs are byte-stable and review-friendly. The `efcore`/`drizzle`-role adapter. |
| Persistence (alt) | **GORM** | The familiar ORM choice; emit as the `dapper`/`mikroorm`-role second adapter, stubbed v1. |
| DB | **Postgres** | Same sidecar story as .NET/Hono (`composeService`); `MigrationsIR` → golang-migrate, reusing `sql-pg.ts`. |
| Build | **Go modules** (`go.mod`) | One templated `go.mod` + `go.sum`; mirrors `stacks/v*` for the dependency manifest. No build-tool fork (Gradle/Maven, npm/pnpm) to choose. |

## The three structural pivots (where Go diverges)

These are the parts a Go target must decide before writing emitters —
they are the language-specific judgement calls the shared IR can't make:

1. **Errors as values, not exceptions.** Every backend so far throws.
   Go's `if err != nil { return …, err }` convention means
   `render-stmt.ts` for operation / invariant / apply bodies needs an
   **error-propagation strategy** chosen up front. This aligns *with*,
   not against, [`exception-less.md`](./exception-less.md): Go's
   `(T, error)` return is the natural carrier for A4's typed `or`-union
   returns — Go is to `exception-less` what vanilla Ecto's
   `{:ok, _} | {:error, _}` is on Phoenix
   ([`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md)).
   If Go lands after A4, it inherits the union-return shape for free; if
   before, it carries a thin idiomatic error tower the A4 work later
   tightens.
2. **No classes — structs + funcs + interfaces.** Aggregates become
   structs; operations become methods on those structs (or package-level
   funcs); value objects become small structs with constructor funcs;
   ids become typed string/uuid wrappers. The `value-object-ctor` vs
   `private-operation` dispatch in `render-expr.ts` resolves to func
   calls, not `new`. Collection ops (`map`/`filter`/`any`/`all`) render
   to **explicit `for` loops** (pre-generics idiom) or `slices`/`maps`
   stdlib generics (Go 1.21+) — the main per-language decision in the
   expression renderer.
3. **Context is threaded, not ambient.** The other backends carry the
   execution-context / `RequestContext` backbone in an *ambient* slot
   (`AsyncLocalStorage`, `Activity.Current`, the BEAM process
   dictionary). Go's idiom is the opposite — an explicit `context.Context`
   passed as the first parameter of every call — and that is a *lowering*
   decision, not just a middleware one: the compiler must thread a `ctx`
   parameter through every generated call site
   (`render-stmt`/`render-expr` call emission), so a Go backend is the
   **explicit-threading** realization class of
   [`execution-context.md`](./execution-context.md). Decide the
   `ctx`-threading convention up front, alongside the error strategy — it
   touches the same statement/expression emitters. Until the
   execution-context backbone lands, `ctx` is plumbed as a thin carrier
   (request id / cancellation only).

## What gets written (anchored to Hono ≈ 7.2k / .NET ≈ 13.7k LOC)

| Piece | Reference | Go estimate |
|---|---|---|
| `PlatformSurface` impl (`src/platform/go.ts`) | dotnet 139 | ~150 |
| Orchestrator (`index.ts`) | dotnet 676 | ~650 |
| Struct / model emit (aggregates, parts, VOs) | entity+efcore ~720 | ~600 |
| Repository emit (sqlc queries + Go wrappers) | repository 508 | ~700 |
| REST API emit (Chi handlers + router) | api 489 | ~550 |
| Bootstrap (`main.go` + server/DI wiring) | program 597 | ~450 |
| DTOs / JSON mapping (struct tags) | dto+mapping ~450 | ~400 |
| **`render-expr.ts`** (17 ExprIR variants, leaf-only `GO_TARGET`) | 405 | ~450 |
| **`render-stmt.ts`** (9 StmtIR variants + err-propagation) | 131 | ~250 |
| ids / value-objects / enums / events | ~150 | ~200 |
| Migration emit (`MigrationStep[]` → golang-migrate, reuse `sql-pg.ts`) | 75 | ~150 |
| Validators emit (request validation) | validator-emit 405 | ~350 |
| Join structs (M:N) | join-entities 117 | ~120 |
| Adapters (sqlc/GORM persistence, layout) | ~625 | ~450 |
| Grammar + validator wiring (`'go'` platform) | small | ~50 |
| Build manifest (`go.mod` templates, like `stacks/v*`) | — | ~120 |
| **Subtotal** | | **~5,600–7,500** |

### The fiddly parts

1. **`render-expr.ts` collection ops** — `for`-loops vs `slices`/`maps`
   generics is the headline judgement call; pick one and be consistent so
   the output reads hand-written.
2. **Wire-shape conformance** — `conformance-parity.yml` is a per-PR
   gate: Go's JSON output must be byte-compatible with the other backends
   for the same `.ddd`. Go's `encoding/json` + struct tags (`json:"…"`,
   `omitempty`) is where most debugging time goes; consume `agg.wireShape`
   directly and never hand-case field names (`naming.ts`).
3. **Nil vs zero-value** — Go has no `null`; optional/`T option` fields
   map to pointers (`*T`) or `sql.Null*`. The `wireShape` optional flag
   drives this; pin the convention once.

## The leaf-only target — one table, not a fourth dispatcher

The expression renderer is a leaf-only `ExprTarget` since #843
([`render-expr-target-unification.md`](./render-expr-target-unification.md)):
Go supplies a `GO_TARGET` table for the eight divergence axes (operators,
naming, money arithmetic, collection ops, `refColl.contains`, regex,
`ref` role, `callKind`) — the 17-arm dispatch + recursion are already
shared in `src/generator/_expr/target.ts`. A Go backend writes **one
target table, not a fourth hand-rolled dispatcher** — this is the
architectural payoff the unification PR front-loaded.

## Tests & CI

Matching Hono means **~9–12 new test files** (generator,
access-modifiers, datasource-schema, migrations-emit, wire-conformance,
~3 adapter tests, e2e build + observability) plus **new CI workflows**
mirroring `hono-build.yml` and `hono-obs-e2e.yml`:

- `go-build.yml` — `go build ./...` + `go vet` (treat-vet-as-error) in a
  Go container; `golangci-lint` optional gate.
- `go-obs-e2e.yml` — boot the backend, assert the observability catalog
  envelope on stdout.

Standing up the Go Docker toolchain and getting the build + `go vet`
green is realistically **~1 week on its own** (lighter than the JDK
toolchain — Go's build is fast and dependency-light).

## Phasing

1. **Skeleton (wk 1–2)** — `PlatformSurface` + `'go'` grammar/validator
   wiring + struct/repo/REST/bootstrap for one simple aggregate;
   `composeService` + Postgres; boot *something*.
2. **Renderers (wk 2–3.5)** — full `render-expr`/`render-stmt` with the
   error-propagation strategy, migrations, request validation, JSON
   mapping → pass `conformance-parity` and `go-build`.
3. **Parity features (wk 3.5–6)** — workflows, views, auth, observability
   e2e, the GORM adapter stub.
4. **Hardening (wk 6–8)** — edge cases across `examples/*.ddd`, CI
   shards, docs rows in `platforms.md` / `generators.md`.

## Decisions to pin before starting

- Chi vs stdlib `net/http` (Go 1.22) vs Gin/Echo (→ route emit). **Chi.**
- sqlc vs GORM as the default persistence (→ cheapest, most review-stable
  port). **sqlc.**
- Error model: thin idiomatic tower now, or wait for `exception-less` A4
  union returns (→ `render-stmt` shape). **Land after A4 if scheduling
  allows; otherwise thin tower, retightened by A4.**
- Collection ops: `for`-loops vs `slices`/`maps` generics. **Generics
  (Go 1.21+ baseline).**
- Optional fields: `*T` pointers vs `sql.Null*`. **Pointers at the wire
  boundary** (cleanest `omitempty` JSON), `sql.Null*` only inside repo.

## Cross-references

- [`docs/platforms.md`](../../platforms.md) — `PlatformSurface` contract,
  `family@version` pinning, in-tree vs out-of-tree backend homes.
- [`docs/generators.md`](../../generators.md) — per-backend feature matrix
  (add a Go column).
- [`render-expr-target-unification.md`](./render-expr-target-unification.md)
  — the `ExprTarget` seam Go plugs a `GO_TARGET` table into.
- [`exception-less.md`](./exception-less.md) — A4's `or`-union returns;
  Go's `(T, error)` is the natural carrier (the Phoenix-vanilla parallel).
- [`execution-context.md`](./execution-context.md) — the scope-frame
  backbone; Go is its **explicit-threading** realization class
  (`context.Context`), the third structural pivot above.
- [`java-backend.md`](./java-backend.md) /
  [`php-backend.md`](./php-backend.md) — sibling new-backend studies.
