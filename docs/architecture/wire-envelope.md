# Wire envelope — the four response shapes

> **Pins [D-ENVELOPE](../decisions.md#d-envelope--the-wire-envelope-rule).**
> Status: design pinned. The bare-entity and `Paged<T>` shapes overlap
> existing emit; ProblemDetails arrives with exception-less (A3);
> event-frame with workflow-and-applier.

## The rule

Every HTTP response a Loom backend emits is **exactly one of four
shapes**, chosen by what is being returned — never a free-form
envelope, and never a discriminated wrapper on the success path.

| # | Shape | When | Body |
|---|---|---|---|
| 1 | **Bare value** | success, single entity / payload / primitive | the `wireShape` object, or the bare scalar for a primitive return |
| 2 | **`Paged<T>`** | success, a list | `{ items: T[], page: { offset, limit, total } }` |
| 3 | **ProblemDetails** | any error | RFC 7807 object |
| 4 | **Event-frame** | event stream / SSE / queue payload | `{ kind, occurredAt, correlationId, data }` |

The HTTP **status code is the discriminator** between success (1/2) and
error (3). This is [D16](../old/proposals/implementation-plan.md): an `or`
union that resolves to a success value serialises as the bare value
(shape 1) or `Paged<T>` (shape 2); it **never** wraps success in a
`{ kind: "ok", value: … }` envelope. The client reads 2xx → parse as
the entity/page; 4xx/5xx → parse as ProblemDetails. The `kind`
discriminator from `payload-transport-layer.md` (D2) lives **inside**
payload bodies for tagged unions, not at the envelope level.

## 1 — Bare value

The aggregate/payload `wireShape` (the enriched ordered field list every
backend's DTO emitter already consumes), serialised as a JSON object.
Primitive returns (e.g. a `count` query → `int`) serialise as the bare
JSON scalar, not `{ value: 5 }`. No envelope.

## 2 — `Paged<T>` (pagination-design-note.md)

```jsonc
{ "items": [ /* T wireShape */ ], "page": { "offset": 0, "limit": 25, "total": 142 } }
```

Every list-returning operation returns `Paged<T>` by default. An
aggregate or query marked `unpaged` (small reference lists — the
`Country` case) returns a bare `T[]` (a degenerate shape-1 array), not a
`Paged<T>` with a synthetic page block. The `page` object's defaults
(offset 0, limit 25) are pinned in `pagination-design-note.md`.

## 3 — ProblemDetails (exception-less.md)

[RFC 7807](https://www.rfc-editor.org/rfc/rfc7807) application/problem+json:

```jsonc
{
  "type":   "https://errors.loom/<error-slug>",  // auto-derived from the error name
  "title":  "Already cancelled",                  // auto-derived; i18n via RequestContext.locale
  "status": 409,                                   // from the api-surface `status` mapping (D18)
  "detail": "…",                                   // optional, env-aware (D21)
  "instance": "/orders/42"                          // request path
}
```

- The domain `error` declaration is **HTTP-blind** (D17) — it carries no
  status. The api surface's `status <Error> <Code>` lines map error →
  code (D18); stdlib defaults fill unmapped errors with a warning
  (`loom.unmapped-error-status`) and a 500 fallback (D8).
- `detail` is env-aware (D21): full internals in dev
  (`LOOM_EXPOSE_INTERNAL_ERRORS` / native dev check), redacted in prod;
  sensitive fields stay redacted even in dev (modifier-propagation).
- `title` renders through the i18n catalog keyed by error name, using
  `RequestContext.locale`.

## 4 — Event-frame (workflow-and-applier.md / observability.md)

Domain events crossing a wire (SSE, websocket, queue) are framed:

```jsonc
{ "kind": "OrderPlaced", "occurredAt": "…", "correlationId": "…", "data": { /* event wireShape */ } }
```

`kind` = the event/variant name (same tagging rule as payload unions,
D3). `correlationId` is lifted from `RequestContext` so a consumer can
stitch the event back onto the originating flow. This is distinct from
the success-path rule: event frames are **not** request/response success
bodies, so the `kind` tag is legitimately at the top level here.

## Why status-as-discriminator (not a uniform envelope)

A uniform `{ ok, value | error }` envelope is the obvious alternative.
It is rejected because:

- It forces every client — including hand-written ones and `curl` — to
  unwrap before reading, defeating "conventional REST" (the same reason
  lifecycle-operations rejects the Restful Objects URL idiom).
- HTTP **already** has the success/error discriminator: the status
  line. Duplicating it in the body is redundant and lets the two
  disagree.
- ProblemDetails is a published standard with framework support on all
  three backends; a bespoke envelope is not.

## Backend obligations

| Backend | Bare/Paged | ProblemDetails |
|---|---|---|
| Hono | `c.json(dto)` / `c.json(paged)` | `c.json(problem, status)` with `content-type: application/problem+json` |
| .NET | `Ok(dto)` / `Ok(paged)` | `Results.Problem(...)` (native) |
| Phoenix | `json(conn, dto)` | `put_status` + problem view |

The OpenAPI parity gate (`conformance-parity.yml`) asserts all backends
declare the same four shapes per operation.
