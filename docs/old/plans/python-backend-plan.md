# Python backend — FastAPI + SQLAlchemy 2 generator (implementation plan)

> Status: **SHIPPED** — all slices landed (see the progress table). This is the executable
> slice plan for adding Python as the fourth domain-logic backend (after
> Hono, .NET, Elixir/Phoenix). It instantiates the
> [`platform-expansion-roadmap.md`](platform-expansion-roadmap.md) Phase E
> sketch and follows the shape of
> [`docs/old/proposals/java-backend.md`](../proposals/java-backend.md). Slices
> are executed **in order, one commit (or a few) per slice**, keeping
> `npm test` green at every boundary.

## Decisions pinned (with the user, 2026-06-10)

| Decision | Choice |
|---|---|
| Framework | **FastAPI** (uvicorn ASGI) |
| Persistence | **SQLAlchemy 2** typed declarative + **asyncpg**, Postgres |
| DTO layer | **Pydantic v2** (camelCase wire aliases, models named for OpenAPI parity) |
| Concurrency | **Async end-to-end** — `async def` handlers, `AsyncSession` repos; `render-stmt` threads `await` exactly as TS/.NET do |
| Parity yardstick | **Full .NET/Hono-level parity** — everything in the `docs/generators.md` matrix, including event sourcing, workflows/sagas, views, criteria/retrievals, inheritance (TPC+TPH), auth gate, observability, seeding |
| Generated-project toolchain | **uv** (pyproject.toml), **ruff** (lint+format), **mypy --strict** (CI type gate), Python **3.12** |
| Platform name | `platform: python` — canonical language-ecosystem name per D-NODE-PLATFORM / D-ELIXIR-PLATFORM; `fastapi` accepted as an alias desugaring to `python` (mirrors `hono` → `node`). Version pin: `python@v1`. |
| Home | **In-tree** (the default for new backends): `src/platform/python.ts` + `src/generator/python/`, registered with a synthesised manifest like dotnet/elixir |
| Migrations | `MigrationsIR` → **Alembic** `versions/*.py` whose bodies are `op.execute("""<sql>""")` over the shared `src/generator/sql-pg.ts` renderer (bit-identical Postgres DDL with Hono/.NET); applied at boot |
| Default port | **8000** (uvicorn convention); health at `/health`, compose healthcheck at `/ready` |
| Legacy single-context CLI mode | **Not added** (`generate ts`/`generate dotnet` are legacy); Python is system-mode only, like Elixir |

## Architectural constraints (what we do NOT build)

Per `experience_gathered.md` §13 and the roadmap invariant:

- **No new IR, no new phase, no re-resolution.** The backend consumes
  `EnrichedLoomModel` directly — `wireShape`, `refKind`, `callKind`,
  `receiverType`/`memberType`, `isCollectionOp` are already resolved.
- **No template engine.** Procedural emission via `lines(...)` from
  `src/util/code-builder.ts`, like every other backend emitter.
- **No 4th expression dispatcher.** `render-expr.ts` is a leaf-only
  `ExprTarget` table (`PY_TARGET`) plugged into `renderExprWith` in
  `src/generator/_expr/target.ts`. The interface makes every arm a
  compile error until filled.
- **No migration derivation.** Phase ⑨'s `migrations-builder.ts` hands us
  `MigrationStep[]`; we only translate to Alembic syntax via `sql-pg.ts`.
- **Browser-safe.** `src/generator/python/` must not touch Node-only APIs
  so the playground gets the backend for free (same rule every generator
  already obeys).
- **CI gate ships with the platform** (roadmap policy) — the build
  workflow lands as soon as a generated project exists (Slice 2), not at
  the end.

## Generated project shape (target)

For a deployable `api` hosting `Order` (with parts) and `Product`:

```
api/
├── pyproject.toml              # uv; pinned deps: fastapi, uvicorn, sqlalchemy[asyncio],
│                               # asyncpg, pydantic, alembic, simplejson (+ dev: mypy, ruff, pytest)
├── Dockerfile                  # python:3.12-slim + uv; uvicorn entrypoint
├── .dockerignore
├── certs/.gitkeep              # proxy-CA escape hatch (parity with other backends)
├── alembic.ini
├── migrations/
│   ├── env.py
│   └── versions/0001_initial.py    # op.execute over sql-pg.ts DDL
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI app: CORS, /health, /ready, routers, custom JSON response,
│   │                           # boot-time `alembic upgrade head`, observability catalog envelope
│   ├── settings.py             # DATABASE_URL from env
│   ├── domain/
│   │   ├── ids.py              # NewType-branded str ids
│   │   ├── value_objects.py    # enums (StrEnum) + VO classes with invariant ctors
│   │   ├── events.py           # frozen dataclasses + dispatcher protocol + Noop dispatcher
│   │   ├── errors.py           # DomainError, AggregateNotFoundError
│   │   ├── order.py            # aggregate root + part classes (snake_case attrs)
│   │   └── product.py
│   ├── db/
│   │   ├── engine.py           # async engine + session factory
│   │   ├── schema.py           # SQLAlchemy declarative models, pg enums, join tables
│   │   └── repositories/
│   │       ├── order_repository.py   # find_by_id / get_by_id / save (diff-sync) / all / finds / to_wire
│   │       └── product_repository.py
│   └── http/
│       ├── order_routes.py     # APIRouter + Pydantic request/response models
│       └── product_routes.py
└── tests/
    └── test_order.py           # pytest from `test "name" { … }` blocks (when present)
```

Wire-parity invariants (the conformance gates enforce these):

- **camelCase JSON** — Pydantic `alias_generator=to_camel`,
  `populate_by_name=True`; Python attributes stay snake_case.
- **Decimals are JSON numbers** (not strings) with full precision — a
  custom `LoomJSONResponse` serialises `Decimal` as a raw number
  (simplejson `use_decimal=True` or equivalent encoder). Domain math uses
  `decimal.Decimal` (the `money` story, parity with decimal.js).
- **Datetimes** serialise as UTC ISO-8601 with `Z` suffix, byte-matching
  what the normalised conformance diff expects from Hono/.NET.
- **OpenAPI component names** match the other backends' schema names
  (`OrderResponse`, `CreateOrderRequest`, …) — Pydantic model names are
  chosen for this, and the parity diff runs through the existing
  `test/_helpers/openapi-normalize.ts`.
- **Routes**: `POST /<plural>`, `GET /<plural>`, `GET /<plural>/{id}`,
  `POST /<plural>/{id}/<snake_op>`, `GET /<plural>/<snake_find>`;
  `DomainError` → 400, `AggregateNotFoundError` → 404.

## Effort anchors

| Backend | Generator LOC | Files |
|---|---|---|
| typescript (+ hono/v4 platform) | ~10.2k | 43 |
| dotnet | ~13.5k | 47 |
| elixir | ~16.1k | 53 |

Python at full parity should land in the **10–13k LOC, ~40 file** range
plus ~25–35 test files. The fiddly parts (budget extra debugging time):
wire-shape conformance (Decimal/datetime/OpenAPI naming), the 17-arm
`ExprTarget` (collection ops → comprehensions, `match` → expression-safe
rendering since Python's `match` is a statement), and async `save`
diff-sync semantics under SQLAlchemy.

---

## Progress (updated as slices land)

| Slice | State | Notes |
|---|---|---|
| S1 platform wiring | ✅ | `python` + `fastapi` alias, registry `python@v1` |
| S2 shell + CI gate | ✅ | `python-build.yml`, `LOOM_PYTHON_BUILD` (uv sync + ruff + mypy --strict + pytest) |
| S4 renderers | ✅ | landed before S3 (the primitives emitters consume them) |
| S3 domain primitives | ✅ | ids / StrEnum / VO / events / errors |
| S5 aggregates + tests | ✅ | full behavior + pytest emission |
| S6 persistence | ✅ | schema.py + async repos; verified against live Postgres |
| S7 HTTP layer | ✅ | DTOs, routers, RFC 7807 (+422 errors[]); verified live |
| S8 finds | ✅ | predicate lowering incl. EXISTS membership; verified live |
| S9 migrations | ✅ | shared sql-pg DDL + tracked boot runner (Alembic dropped — runtime-migrator pattern); schema-qualified UUID models |
| S11 criteria/retrievals/views | ✅ | incl. full-form binds + follows; verified live |
| S12 payloads/unions/paged | ✅ | PagedResult carrier, union finds, exception-less ops; envelope rides with S15 |
| S13 inheritance | ✅ | TPH shared table + kind scoping, TPC, base readers; verified live |
| S14 event sourcing | ✅ | stream table + appliers fold + ES create; verified live; document shape stays gated |
| S15a command workflows | ✅ | POST /workflows/<wf>, one-transaction-per-request (repos flush, session dependency commits); verified live |
| S15b sagas/dispatcher | ✅ | `app/dispatch.py` InProcessDispatcher (create = load-or-allocate, on = route-or-drop + `event_unrouted`), saga-state SQLAlchemy models + migrations, routes/views/workflows repos take `make_dispatcher(session)`; choreography chain verified live (place → saga row + Tracked shipment in one tx); durable-channel outbox tier stays a follow-up |
| S16a auth gate | ✅ | User dataclass + verifier registry + middleware (bypass list parity), trailing `current_user` threading (ops/finds/workflows + gated op-calls), 403 declared on guarded routes, synthetic test actor; verified live (401/403/204 + row-level `mine` scoping) |
| S16b seeds | ✅ | app/db/seed.py — domain-create path (invariants run) + schema-qualified raw INSERTs, __loom_seed ship-once marker, LOOM_SEED gating, lifespan runs seeds after migrations + `python -m app.db.seed`; verified live (3 datasets once, re-boot no-op) |
| S16c extern ops | ✅ | check_<op> precondition gate + controlled mutation surface (setters/raise_event/assert_invariants), `<agg>_handlers.py` typed registry + dev-stubs + lifespan verify, route dispatch with ExternHandlerError→500; verified live.  Resource verb clients (objectStore/queue/api) deferred — showcase doesn't exercise them (follow-up with Hono parity) |
| S17 observability | ✅ | app/obs/ (CatalogFormatter flat-JSON envelope + log facade + request-bracket middleware with x-request-id correlation), lifecycle bracket in lifespan, health_ok debug, fault warns in problem handlers, event_unrouted on the catalog stream; `test:obs-python` + LOOM_OBS_E2E_PYTHON e2e (LOOM_OBS_PG_URL override) + python-obs-e2e.yml; passed live.  `--trace` domain instrumentation (invariant/precondition_evaluated) deferred — follow-up with Hono parity |
| **S10 conformance** | ✅ | pythonApi joined showcase.ddd + the e2e 4-way OpenAPI parity matrix (6 pairs) + the guarded-workflow-403 runtime check.  Parity work: ProblemDetails component + install_openapi post-processor (problem+json re-keying, auto-422 pruning), full per-route error matrix from openapi-errors.ts, `<X>ListResponse`/`<View>Response` RootModel array components, uuid-format id params, request-model required-set alignment (optional→None, bool→False default), dev-stub auth verifier (admin, EMPTY permissions).  hono↔python diffSpecs verified CLEAN offline against live servers; dotnet/phoenix pairs gate in conformance-parity.yml (docker). |
| S18 fullstack embed | ✅ | `ui:` on a python deployable embeds the React SPA (dotnet parity): routers under /api/*, ClientApp/ generation (apiBaseUrl /api), wwwroot FileResponse fallback for client-side routing, multi-stage Dockerfile; verified live (index/fallback/assets//api CRUD/health) |
| S19 docs/examples/scaffold | ✅ | generators.md Python section, platforms.md registry row, CLAUDE.md (stack list, test:python/test:obs-python, CI surface, `ddd new`), roadmap Phase E → SHIPPED, `ddd new --platform python` starter (port 8000, validated), playground browser-safety confirmed (no node: imports).  showcase's pythonApi + the 9-fixture LOOM_PYTHON_BUILD corpus stand in for a dedicated example |

## Slices

Every slice ends with: `npm test` green, Biome clean, committed and
pushed. Slices that grow the generated surface also extend the byte-level
generator fixture tests as they go.

### S1 — Platform wiring skeleton

Make `platform: python` parse, validate, resolve, and compose — emitting
nothing yet.

- `src/language/ddd.langium`: add `'python' | 'fastapi'` to the
  `Platform` rule; `npm run langium:generate`; commit regenerated files.
- `src/ir/types/loom-ir.ts`: `Platform` += `"python"`.
- `src/platform/registry.ts`: `LEGACY_PLATFORM_ALIASES.fastapi = "python"`;
  `BUILTIN_PLATFORM_LATEST.python = "v1"`; in-tree `DiscoveredBackend`
  with synthesised manifest (`family: "python"`, `loomVersion: "v1"`).
- `src/platform/python.ts`: `PlatformSurface` impl — `defaultPort: 8000`,
  `needsDb: true`, `mountsUi: false`, `isFrontend: false`,
  `hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS`,
  `reservedRepositoryFindNames` (`findById`/`getById`/`all`… mirror Hono),
  `composeService` (env `DATABASE_URL=postgres://…/<slug>`, `dependsOnDb`,
  `healthPath: "/ready"`, `internalPort: 8000`); `emitProject` returns an
  empty map for now.
- `src/language/validators/deployable.ts` (`checkDeployable`) + lowering
  platform qualification (`lower-platform.ts`) accept `python`/`fastapi`
  and qualify to `python@v1`.
- **Tests**: parsing test, negative validator test, registry resolution
  (`python`, `fastapi`, `python@v1`), compose-stanza test.

### S2 — Project shell + build gate (CI lands here)

- `src/generator/python/index.ts` orchestrator
  (`generatePythonForContexts(...) → Map<path, content>`) emitting:
  `pyproject.toml` (dep pins in `src/generator/python/pins.ts`, mirroring
  `src/platform/hono/v4/pins.ts`), `Dockerfile`, `.dockerignore`,
  `certs/.gitkeep`, `app/main.py` (CORS, `/health`, `/ready`),
  `app/settings.py`, `app/db/engine.py`, `alembic.ini`,
  `migrations/env.py`.
- Wire into `src/system/index.ts` flow via the surface (should be
  automatic through the registry).
- **Opt-in build suite**: `test/e2e/generated-python-build.test.ts`
  gated on `LOOM_PYTHON_BUILD=1` — generates projects for the example
  corpus, runs `uv sync` + `ruff check` + `mypy --strict` (+ `pytest`
  when test files exist). `package.json` script `test:python`.
- **CI**: `.github/workflows/python-build.yml` (Python 3.12 + uv setup),
  mirroring `dotnet-build.yml`.
- **Tests**: orchestrator file-map test, `--dry-run` plan test.

### S3 — Domain primitives

- `src/generator/python/emit/ids.ts` (NewType ids),
  `emit/value-objects.ts` (StrEnum enums + VO classes with invariant
  ctors, `Decimal` for money), `emit/events.ts` (frozen dataclasses +
  dispatcher Protocol + Noop), `emit/errors.ts`.
- Re-quote strings with `JSON.stringify`-equivalent escaping (the STRING
  terminal strips delimiters); all casing via `src/util/naming.ts` +
  a small `py-naming.ts` helper (snake_case attrs, module names).
- **Tests**: one emit test per module.

### S4 — Expression + statement renderers

The per-language core; everything after this consumes it.

- `src/generator/python/render-expr.ts`: `PY_TARGET: ExprTarget` leaf
  table for `renderExprWith` — operators (`&&`→`and`, `!`→`not`, `??`→
  Python equivalent), naming (snake_case + `self.` for `this-prop`),
  Decimal money arithmetic, collection ops (`map`/`filter`/`any`/`all` →
  comprehensions / `any()`/`all()`), `refColl.contains` membership,
  regex via `re`, `refKind` roles, `callKind` call syntax (keyword args
  where the other backends use named DTO fields).
- `src/generator/python/render-stmt.ts`: flat StmtIR dispatch (let,
  assign, if, for-each, emit, precondition→raise, return…), threading
  `await` on repo/workflow calls. `match` renders expression-safe
  (conditional expressions / early-return), since Python `match` is a
  statement.
- **Tests**: `render-expr-kinds.test.ts` covering every `ExprIR.kind`
  arm (the TS/.NET suites are the template) + a `render-stmt` suite.

### S5 — Aggregate emission

- `src/generator/python/emit/aggregate.ts`: one module per aggregate —
  root + part classes, private ctor for rehydration, `create(...)`
  classmethod factory, public/private methods per operation,
  preconditions (`raise DomainError`), `_assert_invariants()` after every
  mutator, `@property` per derived, private method per `function`,
  `_events` + `pull_events()`, parts with `_parent_id`.
- `inspect` stringification hook: `__repr__` delegating to the lowered
  `inspect` derived, honouring `sensitive(...)` redaction (parity with
  TS `Symbol.for("nodejs.util.inspect.custom")` semantics).
- `emit/tests.ts`: `test "name" { … }` blocks → `tests/test_<agg>.py`
  pytest functions.
- **Tests**: generator fixture tests per shape (fields, ops, invariants,
  derived, parts, events).

### S6 — Persistence + repositories

- `emit/schema.ts`: SQLAlchemy 2 typed declarative models — table per
  root and per part (`parent_id` FK), VO fields flattened to prefixed
  columns, `sqlalchemy.Enum` per enum, join table per `X id[]` field
  (composite PK + `ordinal` + reverse index, same DDL as Hono).
- `repository-builder.ts`: async repo per aggregate —
  `find_by_id`/`get_by_id` (root + parts in one transaction), `save`
  (upsert root, diff-sync part collections **and** join tables,
  drain events through the dispatcher), `all()`, `to_wire()` (reads
  `agg.wireShape` directly).
- Realization axes: `adapters()` / `adapterDefaults()` on the surface —
  `persistence: { state: "sqlalchemy" }` (real), `style: "layered"`,
  `layout: byFeature | byLayer` (mirror Hono's minimal menu; no stub
  second persistence in v1).
- **Tests**: schema emit, repo save/diff-sync, association/join-table
  tests (port the Hono test shapes).

### S7 — HTTP layer + Pydantic DTOs

- `emit/dto.ts`: Pydantic models from `wireShape` — `<Agg>Response`,
  `<Part>Response`, `<Vo>Response`/`Request`, `Create<Agg>Request`,
  per-op `<Op>Request`, list responses; camelCase aliases; the
  `LoomJSONResponse` Decimal/datetime serialisation.
- `routes-builder.ts`: `APIRouter` per aggregate with the five route
  shapes; exception handlers mapping `DomainError`→400,
  `AggregateNotFoundError`→404; `app/main.py` grows router includes +
  `/openapi.json` config (FastAPI native).
- **Gate**: `LOOM_PYTHON_BUILD` corpus still green under `mypy --strict`.

### S8 — Finds + where-predicate lowering

- `repository-find-builder.ts` + `find-predicate.ts`: typed find-filter
  `ExprIR` → SQLAlchemy expressions over the queryable subset
  (comparisons, `and_`/`or_`/`not_`, bare-bool columns, VO sub-columns,
  `currentUser.<field>`, enum values, `refColl.contains(x)` join-table
  subquery via `exists()`); paramless finds convention-match columns;
  query-param DTOs on the route.
- **Tests**: predicate lowering suite mirroring
  `repository-find-predicate` tests.

### S9 — Migrations

- `emit/migrations.ts`: per-deployable `MigrationsIR[]` slice → Alembic
  `versions/<version>_<name>.py` with `op.execute()` bodies rendered by
  the shared `src/generator/sql-pg.ts` (bit-identical DDL with
  Hono/.NET); deterministic revision ids chained via `down_revision`.
- Boot-time apply in `main.py` startup (programmatic
  `alembic upgrade head` equivalent), parity with `db.Database.Migrate()`
  / Drizzle's runtime migrator.
- **Tests**: migrations-emit suite (initial + delta against a snapshot),
  mirroring the .NET/Hono migration tests.

### S10 — System e2e + wire/OpenAPI conformance ⟵ first hard parity gate

- Add Python to the OpenAPI parity fetch matrix in `test/e2e/e2e.test.ts`
  (spec at `http://localhost:8000/openapi.json`) and to the conformance
  suites (`test/conformance/paged-wire-parity.test.ts`,
  `union-wire-parity.test.ts` — these grow `platform: python` cases as
  the payload work in S12 lands); extend `conformance-parity.yml` /
  `conformance-full.yml`.
- Boot a Python deployable inside the `LOOM_E2E=1` docker-compose stack;
  `/health` + DSL e2e suite (the generated vitest+fetch e2e needs **no**
  Python-side work — it targets the HTTP surface).
- Fix every divergence found (Decimal/datetime/casing/error envelopes).
- **Exit**: `showcase.ddd`-class example passes the behavioral suite
  against Hono and .NET; OpenAPI parity diff empty. (Roadmap Phase E
  exit criterion.)

### S11 — Criteria, retrievals, views

- Criterion inline use-sites (already free via S4/S8 inlining); reified
  criteria as module-level predicate functions shared by `find` +
  `retrieval` (the Hono `<name>Criterion` pattern).
- `retrieval` → `run_<name>(args, page)` repo method with `order_by` /
  `limit`/`offset` paging.
- `view X = Agg where …` → read-only route + query (port
  `view-routes-builder.ts` / `view-emit.ts` shape).
- **Tests**: one suite per construct, ported from Hono/.NET shapes.

### S12 — Payload records, carriers, unions

- payload/command/query/response/error records; `paged`/`envelope`
  carriers; discriminated unions (`A or B`, `payload Foo = A | B`,
  `T option`) → Pydantic discriminated unions on the tagged `type` field.
- **Tests**: payload emit suite; the S10 conformance suites
  (`paged-wire-parity`, `union-wire-parity`) gain their Python rows here.

### S13 — Inheritance (TPC + TPH)

- TPC (`ownTable`): standalone table per concrete; read-only base reader
  unioning concretes; base discriminated-union wire type.
- TPH (`sharedTable`, default): one shared table + `kind` discriminator +
  nullable per-concrete columns (SQLAlchemy single-table inheritance or
  explicit-filter models — pick whichever yields the shared DDL);
  `<Base> id` refs + polymorphic `find all <Base>`.
- **Tests**: port the dotnet/hono TPC/TPH suites.

### S14 — Event sourcing + document persistence

- `persistedAs(eventLog)`: `<agg>_events` stream table, `_apply_<event>`
  methods + `_from_events` rehydrator + dispatch, repo fold-on-load /
  append-on-save (fold-from-zero MVP, identical contract to Hono).
- `persistedAs(document)`: JSONB document repo (port
  `repository-document-builder.ts` shape).
- Add `python` to `EVENT_SOURCING_BACKENDS`
  (`src/ir/validate/checks/system-checks.ts`) — full parity means no
  gate error.
- **Tests**: event-sourced repo + document repo suites;
  `examples/event-sourcing.ddd` / `document.ddd` in the build corpus.

### S15 — Workflows + sagas

- HTTP-triggered workflows: `run` endpoint + transactional body
  (factory-let, op-call, repo-let, expr-let, for-each, precondition,
  emit) over one `AsyncSession` transaction.
- Event-triggered: per-context dispatcher routing event dataclasses to
  `on(...)` / event-create handlers; correlation-keyed workflow-state
  table (`<Wf>State` model) with load-or-allocate / route-or-drop +
  `event_unrouted` log — port `workflow-builder.ts` +
  `workflow-state-emit.ts` semantics.
- **Tests**: workflow emit suites + an e2e saga case.

### S16 — Auth gate, seeding, extern hooks

- `auth-emit.ts`: the `emitAuthGate` surface hook (policy evaluator +
  per-route guard), porting the Hono/.NET pattern; `currentUser.<field>`
  binding in predicates (S8) connects here.
- `emit/seed.ts`: `seed { … }` → idempotent seeding script run at boot.
- `extern-builder.ts`: extern function escape hatch (user-implemented
  module the generated code imports; see `docs/extern.md`).
- **Tests**: one suite each.

### S17 — Observability

- Catalog envelope on stdout at boot + (under `emitTrace`) domain
  instrumentation events — port `observability-builder.ts` semantics.
- `test/e2e/observability-events-python.test.ts` gated on
  `LOOM_OBS_E2E_PYTHON=1` (postgres sidecar via docker, like .NET's);
  `package.json` script `test:obs-python`; CI `python-obs-e2e.yml`.

### S18 — Static SPA hosting (dotnet embed parity)

- Serve a built React bundle from the Python deployable via FastAPI
  `StaticFiles` when the deployable hosts a UI — parity with .NET's
  `wwwroot` / Hono's static-middleware embed. Verify against the
  `embed-react-phoenix.test.ts` pattern first; mirror the compose story.
- This is the lowest-risk-to-defer slice: if calibration shows the
  `hosts:` machinery needs non-Python work, it gets a follow-up note
  instead of blocking the plan.

### S19 — Docs, examples, scaffolding, playground

- `docs/generators.md`: Python backend section (file map + per-aggregate
  detail) + matrix column note; `docs/platforms.md` registry row;
  `CLAUDE.md` updates (backend count, test scripts, CI surface);
  `docs/old/plans/platform-expansion-roadmap.md` Phase E → shipped.
- `examples/`: a `storefront-python`-style example; add Python cases to
  the build-corpus lists.
- `bin/cli.js new --platform python` template; `ddd new` README.
- Playground: confirm browser-safety (no Node APIs) so the backend
  appears in the web playground for free; add a playground example.

---

## CI summary (end state)

| Workflow | Gate |
|---|---|
| `python-build.yml` (S2) | `uv sync` + `ruff check` + `mypy --strict` (+ `pytest`) against generated projects for the example corpus |
| `python-obs-e2e.yml` (S17) | boots generated backend + postgres sidecar, asserts catalog envelope |
| `conformance-parity.yml` / `conformance-full.yml` (S10/S12) | OpenAPI + wire-shape parity incl. Python |
| `test.yml` | all new vitest suites (fast ones) run in the default suite |

New opt-in env vars: `LOOM_PYTHON_BUILD`, `LOOM_OBS_E2E_PYTHON`;
scripts: `test:python`, `test:obs-python`.

## Known risks / fiddly bits

1. **Decimal-as-JSON-number with full precision** — Pydantic v2
   serialises `Decimal` to string by default; the custom response class
   must emit raw numbers without float round-tripping. Resolved in S7,
   *proven* in S10. Fallback if simplejson is unpalatable: a
   `RawNumber` encoder shim.
2. **Datetime format byte-parity** (`Z`-suffixed UTC, fractional-second
   width) — settled empirically against the normalised conformance diff
   in S10.
3. **OpenAPI component naming** — FastAPI derives names from Pydantic
   class names; collisions across aggregates must be avoided the same
   way Hono's `.openapi("Foo")` names are chosen.
4. **`match` in expression position** — Python's `match` is a statement;
   the renderer uses conditional expressions / hoisted helpers. The
   `ExprTarget` seam already isolates this per the PR #843 design.
5. **mypy --strict on generated code** — strict mode on emitted code is
   the same bar `/warnaserror` sets for .NET; expect a slice or two of
   annotation tightening. The S2 gate catches it early and continuously.
6. **Async save diff-sync** — SQLAlchemy `AsyncSession` + relationship
   loading needs explicit `selectinload`; the repo emitter avoids lazy
   loading entirely (explicit queries, like the Drizzle repo does).

## Cross-references

- [`docs/old/plans/platform-expansion-roadmap.md`](platform-expansion-roadmap.md) — Phase E sketch this plan executes.
- [`docs/old/proposals/java-backend.md`](../proposals/java-backend.md) — the sibling backend plan whose shape this follows.
- [`docs/platforms.md`](../../platforms.md) — `PlatformSurface` contract + registry.
- [`docs/generators.md`](../../generators.md) — the parity matrix this plan targets.
- `src/generator/_expr/target.ts` — the `ExprTarget` seam (S4).
- `src/system/migrations-builder.ts` + `src/generator/sql-pg.ts` — shared migration derivation + SQL rendering (S9).
