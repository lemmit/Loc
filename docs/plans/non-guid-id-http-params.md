# Non-guid ids at the HTTP boundary — param typing gaps

**Status:** workflow-instance `{id}` params derive from the correlation id value
type on every backend (shipped). Aggregate-level non-guid ids are supported
end-to-end on .NET / Java / Elixir; on **Hono / Python they are gated by a hard
validator** (`loom.non-guid-aggregate-id-unsupported`) until the backends are
filled in — an honest error instead of a silently-broken app (below).

The grammar admits `aggregate X ids guid|int|long|string`, and the storage
layer honours it everywhere (migrations `idColumnType`, Drizzle
`integer("id")`, EF/JPA key types, wire-spec `"type":"integer"` — B13).  The
HTTP layer does not:

| Surface | .NET | Java | Hono | Python | Phoenix |
|---|---|---|---|---|---|
| aggregate `/{id}` param | ✅ `csIdValueClrType` | ✅ `javaValueTypeForId` | ⛔ gated (validator) | ⛔ gated (validator) | ✅ `OPENAPI_ID_VALUE` |
| aggregate id column + wire DTO | ✅ | ✅ | ⛔ gated (validator) | ⛔ gated (validator) | ✅ |
| workflow `/instances/{id}` param | ✅ | ✅ | ✅ | ✅ | ✅ (`OPENAPI_ID_VALUE`) |

## The aggregate-level gap — gated, not silently broken

A non-guid aggregate id (`ids int|long|string`) works end-to-end on **.NET /
Java / Elixir** — verified by generating each: integer PK column, an int-typed
id value class, an `integer` wire-DTO id field, and an `integer` `/{id}`
path-param. On **Hono and Python it silently mis-emits a broken app**, in more
places than just the param:

- **Hono** — the branded `XId` type is hardcoded `string` (`randomUUID()`
  minted into an `integer("id")` column on create), the Response/create-response
  id field is `z.string()`, and every `/{id}`, `DELETE /{id}`,
  `POST /{id}/<op>`, `GET /{id}/can_<op>` param is `z.string().uuid()` (a valid
  `GET /tickets/42` → **422 before the handler runs**). 5 param sites in
  `src/platform/hono/v4/routes-builder.ts` plus the id brand, the DTO id field,
  `toWire`, and `findById`.
- **Python** — the schema PK column is `Uuid(as_uuid=False)` regardless of
  `idValueType` (so the *migration* is wrong, not just the HTTP layer), the
  Response id is `str`, and the param is uuid-format `ID_PARAM`.

Because the branded-id-is-`string` (Hono) and uuid-PK (Python) assumptions are
baked deep into those backends, the real fix is a cross-cutting slice, not a
param tweak — and nothing in the conformance corpus exercises it (all examples
use guid ids), so the parity gate never caught it.

**Interim resolution (shipped):** `validateNonGuidAggregateIdSupport`
(`src/ir/validate/checks/system-checks.ts`) raises a hard
`loom.non-guid-aggregate-id-unsupported` when a `node` / `python` deployable
hosts an aggregate with a non-guid id — a diagnosed error pointing at the three
supported backends, instead of a silently-broken app. The
`platformSupportsNonGuidAggregateId` capability table
(`src/language/validators/data/platform-rules.ts`) is the seam: filling in the
Hono / Python emitters (per the parity rule below) and adding the family to that
set lifts the gate.

## Parity rule (established by this slice)

The `{id}` path-param schema derives from the id's `IdValueType`, matching
what the aggregate controllers on .NET/Java already do:

| valueType | OpenAPI param | .NET bind | Java bind | Hono zod | Python |
|---|---|---|---|---|---|
| `guid` | `string` + `format: uuid` | `Guid` | `UUID` | `z.string().uuid()` | uuid-format `str` |
| `int` | `integer` | `int` | `int` | `z.coerce.number().int()` | `int` |
| `long` | `integer` | `long` | `long` | `z.coerce.number().int()` | `int` |
| `string` | `string` | `string` | `String` | `z.string()` | `str` |

Note: `format` granularity (`int32`/`int64`) still differs between springdoc
/Swashbuckle (`int32`) and zod-openapi/FastAPI (none) for `int` — acceptable
until the corpus exercises a non-guid id, at which point the parity harness
will pin the exact rule.
