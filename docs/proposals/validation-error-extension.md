# Validation error extension — RFC 7807 §3.2 `errors[]` on the wire

> **[2026-06-20 status audit]** Understated — `errors[]`/`pointer` also emits on Java (`java/emit/api.ts:~339`) and Python (`python/index.ts:~820`); five backends total.

> Status: SHIPPED. All four phases delivered:
>   Phase A — Hono runtime (#782)
>   Phase B — .NET runtime (#829)
>   Phase C — Phoenix runtime (#836)
>   Phase D — OpenAPI lockstep across all three backends (this PR)
>
> Decoupled from [`exception-less.md`](./exception-less.md): pure wire-format
> extension; no language-level surface change. The wire format defined here
> is the format `exception-less.md` would emit anyway when it lands later —
> all that changes is the internal production path.

## Problem

[`frontend-acl.md`](./frontend-acl.md) Phases 1+2 (shipped on `main` as
[#769](https://github.com/lemmit/Loc/pull/769)) wired every generated React
form's submit handler through `applyServerErrors`, a runtime decoder that
expects the **RFC 7807 §3.2 `errors[]` extension**:

```json
{
  "type": "about:blank",
  "title": "Validation failed",
  "status": 422,
  "detail": "One or more fields are invalid.",
  "instance": "/products",
  "errors": [
    { "pointer": "/name",          "message": "String must contain at least 3 character(s)" },
    { "pointer": "/price/amount",  "message": "Number must be positive" }
  ]
}
```

Today, **no backend emits this shape**. Validation failures on Hono produce
`@hono/zod-openapi`'s default `{ success: false, error: { issues: [...] } }`
shape with status 400 (not even ProblemDetails). The `applied` per-field
path in the frontend ACL is therefore dormant in production — wired and
unit-tested, but never fires.

## What `exception-less.md` would do — and why we don't need to wait for it

[`exception-less.md`](./exception-less.md) reframes the whole language-level
error-flow model: aggregate operations would return `T or DomainError` carrier
unions instead of throwing; the route handler's auto-generated
`ProblemDetails` translator would emit `errors[]` as part of its per-variant
mapping; `?` propagation in workflows would thread through the union signature.

That's a substantial design + multi-backend implementation. **None of it is
required to produce the wire format the frontend already consumes.** The
wire shape is decoupled from how the backend internally arrives at it:

- Today's flow: Zod parse middleware fails → currently emits a non-ProblemDetails
  400 → **could instead emit ProblemDetails 422 with `errors[]`** by walking
  `ZodError.issues[].path`.
- Today's flow: aggregate throws `DomainError` → caught by `app.onError` →
  emits ProblemDetails 400. Stays unchanged. (Aggregate-level invariants don't
  carry per-field paths; the existing base-shape ProblemDetails is correct.)

The wire format is what matters; the implementation strategy underneath can
evolve when `exception-less.md` lands. This proposal locks the boundary
contract now so the frontend ACL goes live, then `exception-less.md` is free
to change *how* the backend produces these errors without changing what they
look like on the wire.

## Wire format specification

### Schema (OpenAPI)

```yaml
ProblemDetails:
  type: object
  properties:
    type:     { type: string, nullable: true }   # "about:blank"
    title:    { type: string, nullable: true }   # "Validation failed"
    status:   { type: integer, nullable: true }  # 422
    detail:   { type: string, nullable: true }
    instance: { type: string, nullable: true }
    errors:
      type: array
      nullable: true
      items:
        type: object
        required: [pointer, message]
        properties:
          pointer: { type: string }              # RFC 6901 JSON pointer
          message: { type: string }              # Human-readable, locale of the server
```

### Pointer encoding rules

Per RFC 6901:

- Empty pointer (`""`) means the error applies to the whole document.
- Segments are slash-separated: `/items/0/qty`.
- Numeric segments (array indices) are bare numbers, **not** quoted: `/items/0`.
- Literal `~` → `~0`; literal `/` → `~1` (within a segment).

### Status code

`422 Unprocessable Entity` for input validation failures (RFC 7807 standard
practice). `400 Bad Request` stays for non-validation client faults
(domain-rule violations carried by `DomainError`).

### Header

`x-request-id` carries the request trace id, as today. Body stays
byte-identical across backends (Hono / .NET / Phoenix).

## Per-backend mapping

### Hono (this PR — shipping)

`@hono/zod-openapi`'s `OpenAPIHono` accepts a `defaultHook` option that runs
when a route's Zod validator rejects input. The hook receives the
`ZodError` and decides the response. The frontend ACL's pointer encoder
already does the inverse mapping (`/price/amount` → `["price", "amount"]`)
in `src/lib/apply-server-errors.ts`; we mirror it on the encoding side:

```ts
new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const errors = result.error.issues.map(issue => ({
        pointer: pointerOf(issue.path),
        message: issue.message,
      }));
      return c.body(
        JSON.stringify({
          type: "about:blank",
          title: "Validation failed",
          status: 422,
          detail: "One or more fields are invalid.",
          instance: c.req.path,
          errors,
        }),
        422,
        { "content-type": "application/problem+json", "x-request-id": trace_id }
      );
    }
  }
});
```

`pointerOf` handles the RFC 6901 escapes.

**Phase A scope split — runtime vs. OpenAPI schema.** Hono's runtime body
includes the `errors[]` extension and uses status 422 *immediately* — the
frontend ACL receives the shape it expects from Phase A onward. But the
cross-backend OpenAPI parity gate (`test/_helpers/openapi-normalize.ts`)
compares both `fieldSet("ProblemDetails")` and per-operation
`errorResponses()` across all three backends, and the central matrix in
`src/ir/util/openapi-errors.ts` drives all three. Updating either while
.NET + Phoenix still emit only base 400/404 ProblemDetails would fail
parity.

So Phase A holds the OpenAPI surface byte-equal across backends while
shipping the runtime emission. Concretely:

- ✅ Runtime body carries `errors[]` + status 422 (frontend ACL works today)
- ⏸️ Zod `ProblemDetails` schema deliberately omits `errors:` from its
  `.openapi()` declaration (matches .NET + Phoenix)
- ⏸️ OpenAPI route declarations omit `422:` (matches .NET + Phoenix)
- ✅ `src/ir/util/openapi-errors.ts` matrix unchanged

The body Hono emits is *more permissive* than its OpenAPI schema admits;
strict-OpenAPI clients see the base shape and ignore the extension, while
the frontend ACL reads the body directly and gets the field-level errors.
This is forward-compatible: when Phase B + C land, the central matrix
adds 422 + the schema gains `errors:` for all three backends in lockstep,
and parity stays green.

### .NET (Phase B — shipping)

The FluentValidation arm of `Api/DomainExceptionFilter.cs` was emitting a
custom 400 envelope (`{ error, trace_id, failures: [{ field, message }] }`).
Replaced by a 422 `ProblemDetails` with the §3.2 `errors[]` extension carried
on `ProblemDetails.Extensions["errors"]` — same wire body as Hono's
`defaultHook`.

A `PointerOf` static helper on the same filter class converts
FluentValidation property paths to RFC 6901 JSON pointers:
- `Name` → `/name`
- `Price.Amount` → `/price/amount`
- `Items[0].Qty` → `/items/0/qty`
- Empty → `""` (root error)

Pascal-case segments go through `JsonNamingPolicy.CamelCase.ConvertName` so
the pointers align with the wire shape the app emits via
`PropertyNamingPolicy = CamelCase` (set globally in `Program.cs`). RFC 6901
segment escapes (`~` → `~0`, `/` → `~1`) apply inside each segment.

Same scope split as Hono: the OpenAPI `ProblemDetails` schema declaration
and the route-level 422 response keep parity with Phoenix until Phase D.
ASP.NET's framework-default `InvalidModelStateResponseFactory` is
intentionally NOT overridden — body validation goes through the FluentValidation
CQRS pipeline, which throws `ValidationException` and lands in the filter
arm above. The .NET test `does NOT touch ValidationProblemDetails` stays
pinned: forking the framework default would touch a wider API surface than
this PR needs.

### Phoenix (Phase C — shipping)

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** This section describes the original Ash-based emission (`Ash.Error.Invalid` walking) that no longer exists; on vanilla Ecto the shared `<App>Web.ProblemDetails` module walks `Ecto.Changeset` errors into the same `errors[]` wire shape instead.

`Ash.Error.Invalid` wraps per-field validation errors with path information
(`%Ash.Error.Invalid{errors: [%Ash.Error.Changes.InvalidAttribute{path: [...],
field: :amount, message: "..."}, ...]}`). Phase C ships a shared
`<App>Web.ProblemDetails` Elixir module that walks the error tree,
converts atom path segments to JSON pointers, and returns 422 with the
`errors[]` extension — same wire body as Hono and .NET.

The per-aggregate controllers `use Plug.ErrorHandler` and route raised
`Ash.Error.Invalid` exceptions to the shared `validation_error_response/2`
function. The workflows controller's existing `error_response/2` grew an
`%Ash.Error.Invalid{}` pattern-match arm that dispatches to the same
helper, plus a generic arm that dispatches to `problem_response/4` for
forbidden / generic domain errors. The previous inline `Jason.encode!` +
`put_resp_*` block in the workflows controller is gone — all RFC 7807
emission lives in the shared module.

The Ash error walker handles the common shapes:
- `path = err |> Map.get(:path, []) |> List.wrap()` — list of atoms
- `field = err |> Map.get(:field) |> List.wrap()` (or `fields` for the list form)
- Segments are concatenated: `path ++ field` → list passed to `pointer_of/1`
- atoms go through `camelize/1` (mirrors `JsonCamelCase.camelize_string/1`),
  integers stringify as bare indices, then RFC 6901 escapes apply

Same OpenAPI deferral as Hono + .NET: the route-level 422 response and
the `errors[]` schema declaration wait for Phase D so the cross-backend
parity gate stays green.

## OpenAPI parity

The cross-backend `conformance-parity.yml` workflow diffs OpenAPI specs.
This PR extends `ProblemDetails` and adds 422 routes; .NET and Phoenix
specs will lag behind Hono until their follow-ups ship. The parity test
will fail for a short window — expected, will pass once all three backends
emit the same shape.

## Forward compatibility with `exception-less.md`

When `exception-less.md` lands, route handlers will type-check their `or`-union
returns into per-variant ProblemDetails. The validation-failure variant
**emits exactly the shape this proposal defines**. The change is purely
internal: instead of a `defaultHook` catching parse failures, the parse step
returns `ValidationError[]` which the per-variant emitter formats. The wire
format is unchanged.

## Migration safety

- **No frontend change needed.** The frontend ACL was deliberately built to
  accept this shape (see `apply-server-errors.ts:18–36`).
- **No regression risk on existing flows.** `DomainError` / `AggregateNotFoundError`
  / `ForbiddenError` continue to emit base ProblemDetails (400 / 404 / 403).
  The 422 path is a new code, not a replacement.
- **Status code change for validation:** 400 → 422 for Zod failures only.
  Frontend ACL handles both — non-422 errors go to the `unhandled` outcome
  with the prior toast preserved. No frontend changes required.

## Phased delivery

- **Phase A — Hono** (shipped #782): runtime body emits 422 + `errors[]`;
  OpenAPI schema declaration deferred to keep parity with .NET + Phoenix.
- **Phase B — .NET** (shipped #829): runtime body emits 422 +
  `Extensions["errors"]`; `PointerOf` helper on `DomainExceptionFilter`
  converts FluentValidation paths to RFC 6901; same OpenAPI deferral
  as Hono.
- **Phase C — Phoenix** (shipped #836): walks `Ash.Error.Invalid`
  into the same `errors[]` shape via a shared
  `<App>Web.ProblemDetails` Elixir module that both per-aggregate
  controllers (Plug.ErrorHandler arm) and the workflows controller
  (extended `error_response/2`) call.
- **Phase D — OpenAPI lockstep** (shipping in this PR): all three
  backends grow the same OpenAPI surface in one atomic move:
    1. Central matrix `src/ir/util/openapi-errors.ts` returns
       `[400, 422]` for `create`, `[400, 404, 422]` (`+403` if guarded)
       for `operation`, `[400, 422]` (`+403` if guarded) for `workflow`.
       Adds `"Unprocessable Entity"` to `problemTitle(422)`.
    2. Hono: `ProblemDetails` Zod schema in `http/problem-details.ts`
       gains `errors: z.array(...).nullish()`. Route declarations in
       `routes-builder.ts` (create + operation) and `workflow-builder.ts`
       grow inline `422: { description: "Unprocessable Entity", ... }`
       alongside the existing 400.
    3. .NET: `ProblemDetailsResponsesFilter` extended with
       `AugmentProblemDetailsSchema` that idempotently adds an `errors`
       array property to the auto-generated Swashbuckle schema
       (matching the runtime `Extensions["errors"]` shape).
       `[ProducesResponseType(typeof(ProblemDetails), 422)]` attributes
       appear automatically via the central matrix.
    4. Phoenix: `<App>Web.Api.Schemas.ProblemDetails` OpenApiSpex schema
       module declares the `errors` array property with `pointer` +
       `message` required per element. 422 `OpenApiSpex.Response` entries
       appear automatically via the central matrix.
    5. Parity-deferred test assertions inverted across the three
       `validation-error-extension.test.ts` files. New positive
       assertions added for the .NET Swashbuckle augmentation +
       Phoenix's OpenApiSpex `errors[]` declaration + per-action 422
       OpenAPI response entries.
- **Phase E — exception-less interop** (much later): when
  `exception-less.md` lands, refactor the internal production path
  (from `defaultHook` / filter arm to per-variant typed returns).
  Wire format stays unchanged.
