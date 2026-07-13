# Vanilla Phoenix foundation — research notes (Phase A grounding)

> Status: **historical (de-Ash effort landed, 2026).** Steps 1–4 of the de-Ash
> effort have landed — the Ash foundation is **removed**: `platform: elixir` now
> generates Phoenix LiveView on plain Ecto/Phoenix, `foundation: vanilla` is the
> default and only valid value, and `foundation: ash` is a validation error (the
> `foundation:` knob stays). These notes are retained as the implementation record:
> the "current `foundation: ash` emitters" they sweep were the **pre-removal**
> starting point the vanilla emit was ported from, and the ash byte-targets below
> were the parity oracle the port matched before Ash was deleted.
>
> Companion to [`vanilla-foundation-tdd-plan.md`](./vanilla-foundation-tdd-plan.md).
> Distilled from three read-only sweeps of the (then-current) `foundation: ash`
> emitters; these were the **verified byte-exact targets** the Phase A parity /
> structure tests asserted against. Source files cited inline.

## 1. Error → ProblemDetails contract (slices 1–4)

Every error response across all backends: **`Content-Type:
application/problem+json`** + **`x-request-id`** header (echoed from the request;
*not* in the body, so the body stays byte-identical). Body is RFC-7807:

```json
{ "type": "about:blank", "title": "<reason>", "status": <code>,
  "detail": "<message>", "instance": "<request path>", "errors": [<only on 422>] }
```

| status | title | detail | `errors[]` |
|---|---|---|---|
| 400 | `Bad Request` | domain message | — |
| 403 | `Forbidden` | reason | — |
| 404 | `Not Found` | message / `"not_found"` | — |
| 422 | `Validation failed` | `One or more fields are invalid.` | yes |

**422 `errors[]` element = `{ pointer, message }`** (RFC-7807 §3.2). `pointer` is
RFC-6901: `""` for a root error, else `"/" + segments.join("/")` where each
segment is **camelCased** (atom/string) or stringified (int index), with `~`→`~0`
and `/`→`~1` escaping; segments = `error.path ++ (error.field || error.fields)`.
Source: `phoenix-live-view/problem-details-emit.ts` (`render_error`,
`pointer_of`, `segment_to_string`, `escape_segment`, `camelize`).

**Vanilla divergence (the only parts that change):**
- The `ProblemDetails` *module* (`problem_response` / `validation_error_response`)
  is largely **foundation-agnostic** — reuse it.
- The **controller** uses per-variant `with`-block dispatch, not the ash
  `Plug.ErrorHandler` rescue tower (`api-emit.ts handle_errors`).
- Validation errors come from an **`Ecto.Changeset`** (`changeset.errors` =
  `[{field, {msg, opts}}]` + nested via `traverse_errors`), not
  `Ash.Error.Invalid.errors` — map both to the identical `{pointer, message}`.
- Cross-backend reference (must match): Hono `defaultHook` (`emit.ts`), .NET
  `ProblemDetails` filter (`emit/api.ts`) — same envelope + `errors[]` shape, so
  the parity normaliser (`test/_helpers/openapi-normalize.ts`) stays green.

## 2. `TypeIR` → Ecto schema / migration / wire (slices 1–3)

**The migration is the source of truth.** Vanilla Ecto schema field names + types
**must match the columns `MigrationsIR` derives** (`system/migrations-builder.ts`
+ `phoenix-live-view/migrations-emit.ts`) — do not invent a fresh mapping; read
the column shape and mirror it. The existing precedent to reuse/extend lives in
`phoenix-live-view/dispatch-emit.ts` (`ectoIdType`, `ectoStateFieldType`).

| `TypeIR` | Ecto field | DB column | wire JSON |
|---|---|---|---|
| `id` guid | `:binary_id` (FK/saga) / `uuid_primary_key` (PK) | uuid | string |
| `id` string / int/long | `:string` / `:integer` | text / int·bigint | string / int |
| primitive int/long | `:integer` | int / bigint | int |
| decimal / money | `:decimal` | decimal | **string** (Jason) |
| string | `:string` | text | string |
| bool | `:boolean` | bool | bool (omittable on create → `false`) |
| datetime | `:utc_datetime` | datetime | ISO-8601 string |
| guid (prim) | `:uuid` | uuid | string |
| json | `:map` | json | object |
| enum | `:string` | text | **member-name string** |
| valueobject | flattened `<vo>_<sub>` columns (relational) **or** `:map` (embedded) | per leaf / json | nested object |
| `X id` (relationship) | FK column `<field>_id` | id type | string |
| `Id[]` (ref collection) | **join table** (`owner_fk`,`target_fk`) | — | id array |
| `optional T` | `T` + `null: true` | nullable | `T \| null` |

**Naming:** PK `id` (saga PK = the correlation field, not `id`); part→parent FK
`<owner>_id` (cascade); cross-agg FK `<field>_id` (restrict); join `owner_fk` /
`target_fk`. **Wire JSON** is camelCase via the `JasonCamelCase` encoder
(`jason-camel-emit.ts`); field set = `forApiRead(wireShape)`.

⚠ **Gotcha — timestamps:** the ash Phoenix wire atom list includes
`:inserted_at`/`:updated_at`. Whether the cross-backend wire shape carries them
is a **parity-sensitive detail** — pin it with the parity test first and match
whatever ash currently emits; don't assume.

## 3. `render-expr` / `render-stmt` divergence (slice 0/1 seam)

Verdict: **one `foundation?: "ash" | "vanilla"` flag on `RenderCtx`, NOT a
separate target table.** The 17-arm `ExprIR.kind` dispatch is 100% shared; the
divergence is shallow and localized (mirrors the existing `filterArgs` flag).

| # | site | ash | vanilla |
|---|---|---|---|
| A1 | `render-expr.ts` enum-value (~198) | `:atom` | `"string"` (member name) |
| A2 | `render-expr.ts` param under `filterArgs` (~185) | `^arg(:n)` | `^n` (bare pin) |
| A3 | `render-expr.ts` `.contains` (~242–276) | `exists(rel, id == …)` | Ecto `subquery(from …)` — **shape-level, needs `ctx.agg`**; punt to an emitter helper |
| A4 | `this.<prop>` (~190) | `record.field` | same — no change |
| A5 | `render-stmt.ts` assign/add/remove (52,64,70,79,82) | `Ash.Changeset.change_attribute` / `manage_relationship` | `Ecto.Changeset.change` / `put_assoc` |
| A6 | `repository-emit.ts:227`, `view-emit.ts:148,173` | `filter expr(…)` / `Ash.Query.filter(…)` | inline `where:` in `from` — **caller-side** (emitter), renderer unchanged |

`render-stmt.ts` `emit` (PubSub) and `call` arms are foundation-agnostic (module
paths compose from `contextModule`).

⚠ **Gotchas:** A3 (contains) is the one shape-level case — keep it out of the
generic renderer, give the vanilla emitter a join-aware helper. Confirm vanilla
enum columns are always `:string` (matches A1). Exclude `inserted_at`/`updated_at`
from changeset casts (managed by Ecto) — parity will catch leaks.

## Implication for the slice plan

- **Slice 0/1** lands the `RenderCtx.foundation` flag + the A1/A2/A5 branches +
  the A6 caller-side `where:` wrapping — that's the whole expr seam, settled once
  (this is what blocked the Phoenix workflow view).
- **Slice 1–3** read migration columns as the schema source of truth; structure
  tests assert field/column names against `MigrationsIR`.
- **Slice 4** reuses the `ProblemDetails` module; only the controller dispatch +
  Ecto-changeset error extraction are new.
- A3 (`contains`) and embedded-VO `:map` columns are the trickiest — schedule
  them in the enums/VOs/relationships slice with their own parity entries.
