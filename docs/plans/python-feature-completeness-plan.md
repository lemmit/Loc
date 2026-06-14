# Python backend — feature-completeness follow-ups

> Status: **in progress.** The Python/FastAPI backend
> ([`python-backend-plan.md`](python-backend-plan.md)) shipped at core
> parity with Hono/.NET. This plan closes the remaining tail so python
> becomes a full peer. Slices are ordered by leverage; each ends with
> `npm test` green, Biome clean, the `LOOM_PYTHON_BUILD` corpus
> passing, and a commit/push.

## Gaps (from the validator gates + saving-shape map)

| Gap | Today | Other backends |
|---|---|---|
| Resource verb clients (`objectStore`/`queue`/`api`) | workflow `resource-call` → **runtime `NotImplementedError`** | dotnet/elixir/java ship `adapters/resource-clients.ts` |
| Saving shapes `document` + `embedded` | `PLATFORM_SAVING_SHAPES.python = ["relational"]` | node/dotnet: all 3; elixir: rel+embedded |
| Durable-channel outbox (`retention: log\|work`) | in-process (ephemeral) tier only | node has `__loom_outbox` + relay |
| `when` can-queries | python absent from `SUPPORTED_WHEN_BACKENDS` | only node+dotnet |
| `--trace` domain instrumentation | not emitted | node/dotnet (opt-in) |

(provenance/audited is gated identically on .NET — not a python-specific gap, out of scope.)

## Slices

### F1 — Resource verb clients (highest priority)

The only gap that currently *degrades to a runtime error* instead of a
clean fail-fast — restores the "never a silent downgrade" invariant.

- `src/generator/python/resource-clients.ts`: three adapters
  (`s3`/`rabbitmq`/`restApi`) emitting `app/resources/<sourceType>.py`,
  one `async def <resource_snake>_<verb>(...)` per (resource, verb) the
  deployable's workflows use — the call shape `render-expr.ts`'s
  `resource-op` case already emits (`(await sales_files_put(...))`).
- Wire into `index.ts`: collect the deployable's consumable
  dataSources, group by sourceType, emit client modules, merge client
  deps into `pyproject.toml`.
- Workflow `resourceCall` seam: replace `raise NotImplementedError`
  with the import + awaited call; thread the verb-helper imports into
  `workflows_routes.py` / `dispatch.py`.
- Libraries: objectStore → `aioboto3`, queue → `aio-pika`, api →
  `httpx` (all async, typed; fall back to a narrowly-scoped ignore if a
  stub set is hopeless under `--strict`).
- Fixture `resources.ddd` in the corpus; fast generator tests.

### F2 — Document + embedded saving shapes

Biggest *capability* delta vs node/.NET. JSONB is idiomatic for
SQLAlchemy/Postgres.

- `persistedAs(document)`: JSONB single-column repo (port
  `repository-document-builder.ts` shape) — root serialized to a
  `data jsonb` column, hydrate from it.
- `embedded` / value-collection (`VO[]`) child tables (port
  `repository-embedded-builder.ts`).
- Flip `PLATFORM_SAVING_SHAPES.python` to `["relational", "embedded",
  "document"]`.
- Fixtures `document.ddd` / `embedded.ddd` in the corpus.

### F3 — Durable-channel outbox tier

At-least-once delivery for `retention: log | work` channels.

- `__loom_outbox` table (migrations-builder already derives it) + an
  `app/db/outbox.py` relay draining undispatched rows through the
  in-process dispatcher; the durable dispatcher wraps the in-process
  one (port `createOutboxDispatcher` + `startOutboxRelay`).

### F4 — `when` can-queries (low priority)

`can-<op>` query endpoints that evaluate an operation's preconditions
without executing. Add `python` to `SUPPORTED_WHEN_BACKENDS`, emit the
`check_<op>`-style probe as a GET returning `{ allowed: bool }`.

### F5 — `--trace` domain instrumentation (low priority)

Under `emitTrace`, inject `invariant_evaluated` / `precondition_evaluated`
/ `value_computed` trace lines into the domain layer (no obs e2e asserts
this on any backend; cosmetic completeness).

## Progress

| Slice | State | Notes |
|---|---|---|
| F1 resource verbs | ✅ | `app/resources/{s3,rabbitmq,rest_api}.py` async helpers (boto3 / aio-pika / httpx), workflow+saga import-and-await wiring, deps merged into pyproject; `resources.ddd` corpus case passes uv+ruff+mypy --strict; replaced the runtime `NotImplementedError` |
| F2a document shape | ✅ | `shape(document)` → `(id, data jsonb, version)` triple, to_doc/from_doc serialisers (money/datetime/VO/enum/ref/nested-part), in-memory finds, version-bumped upsert; `PLATFORM_SAVING_SHAPES.python += document`; verified live (create→addSection→bump→read-back→find) + corpus uv/ruff/mypy --strict |
| F2b embedded shape | next | |
| F3 durable outbox | next | |
| F4 when can-queries | later | |
| F5 --trace instrumentation | later | |
