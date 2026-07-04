# Non-guid ids at the HTTP boundary — param typing gaps

**Status: in progress** — workflow-instance `{id}` params fixed across backends
(this slice); aggregate `/{id}` params on Hono/Python still open (below).

The grammar admits `aggregate X ids guid|int|long|string`, and the storage
layer honours it everywhere (migrations `idColumnType`, Drizzle
`integer("id")`, EF/JPA key types, wire-spec `"type":"integer"` — B13).  The
HTTP layer does not:

| Surface | .NET | Java | Hono | Python | Phoenix |
|---|---|---|---|---|---|
| aggregate `/{id}` param | ✅ `csIdValueClrType` | ✅ `javaValueTypeForId` | ❌ `z.string().uuid()` hardcoded | ❌ `ID_PARAM` uuid-format hardcoded | (spec emit unverified) |
| workflow `/instances/{id}` param | ✅ this slice | ✅ this slice | ✅ this slice | ✅ this slice | ✅ already (`OPENAPI_ID_VALUE`) |

## The open aggregate-level gap

For an `ids int` aggregate:

- **Hono** validates every `/{id}`, `DELETE /{id}`, `POST /{id}/<op>`,
  `GET /{id}/can_<op>` param as `z.string().uuid()`
  (`src/platform/hono/v4/routes-builder.ts` — 5 sites), so a valid
  `GET /tickets/42` fails request validation with **422 before the handler
  runs**, while the same request succeeds on .NET/Java.  The fix must also
  touch the handlers (`Ids.XId(id)` bind, drizzle `eq` on an integer column)
  and re-check the static-route-shadowing comment (`find byHolder` ordering
  relies on the uuid 422 today).
- **Python** declares every id param as uuid-format string
  (`routes-builder.ts` `ID_PARAM`), so the OpenAPI contract lies
  (`string:uuid` vs the wire-spec's `integer`) and the str value binds into
  an asyncpg integer column.

Neither is exercised by the current conformance corpus (all examples use
guid ids), so the parity gate stays green while the behaviour diverges —
a silent gap in parity-auditor terms.

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
