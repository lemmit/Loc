# Schemathesis contract fuzzing — findings register (2026-08)

**Subject:** the generated **node/Hono** backend, fuzzed against its **own emitted
`/openapi.json`** (M-T9.21, first leg).
**Harness:** `test/behavioral/run-schemathesis.mjs` — `npm run test:schemathesis`.
**Fixtures:** `web/src/examples/storefront-system.ddd` (29 operations) and
`web/src/examples/sales-system.ddd` (18 operations), booted on PGlite in-process
and served on a real port.
**Checks:** `not_a_server_error`, `response_schema_conformance`,
`status_code_conformance`, `content_type_conformance`, `unsupported_method`,
`negative_data_rejection`. Seed pinned, Hypothesis example database off.

**Result: 65–71 findings per run, resolving to 9 root causes** — 4 of them
server errors (500), 1 a response that violates the server's own published
schema, 3 contract gaps, 1 by design. Every root cause below was re-confirmed by
hand with `curl` against a booted server, not read off the fuzzer's summary.

> **Scope note — no emitter is fixed in the PR that adds this suite.** Every
> finding here is a *cross-backend* contract question (what SHOULD a Loom
> backend answer for an absent body, a non-UUID reference, an undeclared 422),
> and fixing one on node alone would manufacture exactly the silent per-backend
> divergence the M-T9.11 wire differential exists to catch. Each is therefore
> written up as a follow-up that lands on all five backends together. The
> waivers in `test/behavioral/schemathesis-waivers.json` ratchet, so a fix must
> delete its rule and strike its entry here in the same PR.

**Fixed since:** F2, F3 and F4 landed on all five backends in PR #2555
(2026-08-14) — reference fields are uuid-validated and publish `format: uuid`,
and the paged `page`/`pageSize` controls carry declared, enforced upper bounds.
Their waivers (W2, W3) are deleted and W1/W5 are narrowed to F1.

---

## Class: server error (500)

### F1 — a request whose `Content-Type` is not `application/json` skips body validation entirely, then 500s
**Waiver:** W1 · **Severity: high** — every body-carrying route (create, named
operation, workflow) on every generated Hono service.

```
curl -X POST http://host/api/products
→ 500 {"type":"about:blank","title":"Internal Server Error","status":500,"detail":"internal"}
```

With the correct content type the same route behaves correctly:

```
curl -X POST -H 'Content-Type: application/json' -d '{}'        → 422 (field-level errors)
curl -X POST -H 'Content-Type: application/json' -d '{not json' → 400 Malformed JSON in request body
curl -X POST -H 'Content-Type: application/json'                → 400 Malformed JSON in request body
curl -X POST -H 'Content-Type: text/plain' -d '<valid json>'    → 500
```

**Root cause:** Hono's zod validator only runs when the request's content type
matches, so an absent or foreign `Content-Type` **skips validation silently**;
`c.req.valid("json")` is then `undefined` and the handler dereferences it. The
app's own error log names it: `TypeError: Cannot read properties of undefined
(reading 'amount')`.

**Fix shape (all five backends):** answer `415 Unsupported Media Type` (RFC 9110
§15.5.16) — or the already-declared `400` if the spec is not to change — before
the handler runs. Note the choice is a contract decision: `415` also has to be
added to the emitted OpenAPI responses on every backend, or `status_code_conformance`
simply trades one finding for another.

### F2 — a non-UUID `X id` reference in a request body reaches Postgres and 500s
**Status: FIXED (2026-08-14, PR #2555).** `zodFor`'s `id` arm in the Hono
routes-builder now emits `z.string().uuid()` for a guid-valued reference (the
`int`/`long`/`string`-keyed forms keep the bare string), so a malformed
reference gets the backend's standard 422 and the emitted spec carries
`format: uuid`. The Python sibling emits a shared `UuidStr`
(`StringConstraints` + `WithJsonSchema({type: string, format: uuid})`) → 422.
.NET (`Guid`), Java (`UUID`) and Phoenix (`:binary_id` cast) already
type-validated and already published `format: uuid`, so the change lands the
same contract on all five. Waiver W1 narrowed to F1.

```
curl -X POST -H 'Content-Type: application/json' \
  -d '{"customerId": "", "status": "Draft", "placedAt": false}' http://host/api/orders
→ 500

# same request with a real UUID → 201
```

**Root cause:** an `X id` reference field lowers to a bare `z.string()` — no
`.uuid()` — and the emitted schema declares it as bare `{"type": "string"}` with
no `format: uuid`. The value travels to Postgres, whose `invalid input syntax
for type uuid` escapes as a 500.

**The backend disagrees with itself:** the *same* identifier in a path parameter
IS uuid-validated and answers 422 (`{"pointer":"/id","message":"Invalid UUID"}`).
So one surface rejects what the other 500s on.

**Fix shape:** validate reference fields as UUIDs and declare `format: uuid` in
the emitted spec, on all five backends at once (the spec half is diffed by
`conformance-parity`).

### F3 — the query-parameter twin of F2: a find-by-reference route 500s on a non-UUID
**Status: FIXED (2026-08-14, PR #2555).** Falls out of the F2 fix on node — the
same `zodFor` renders body fields and query parameters — and on Python, where
`requestPyType` annotates find parameters with the same `UuidStr`. Waiver W2
deleted.

```
curl 'http://host/api/wallets/by_owner?owner='        → 500
curl 'http://host/api/wallets/open_by_owner?owner='   → 500
```

Same root cause as F2 on the query-parameter surface: `{"schema": {"type":
"string"}, "required": true, "name": "owner", "in": "query"}` — no `format:
uuid`, no runtime check. This is the #2442 shape (malformed claim → 500 instead
of a clean empty/4xx result).

### F4 — `page × pageSize` overflows the SQL `OFFSET` and 500s
**Status: FIXED (2026-08-14, PR #2555).** `PAGED_MAX_PAGE` (1 000 000) and
`PAGED_MAX_PAGE_SIZE` (500) join the existing `PAGED_DEFAULT_*` pair in
`src/ir/stdlib/generics.ts` and are declared AND enforced by all five paged-read
param builders: zod `.max(...)` (node), FastAPI `Query(ge=1, le=…)` (python),
`[Range(1, …)]` (.NET), `@Min`/`@Max` (Java — Spring 6.1+ method validation
applies them without a class-level `@Validated`), and `page_param/4` +
`minimum`/`maximum` on the OpenApiSpex parameter (Phoenix). The pair is chosen
so the derived offset stays inside a 32-bit int on the backends that compute it
in `int`. Waiver W3 deleted; W5 narrowed to F1.

```
curl 'http://host/api/products?pageSize=1075098&page=9272203203533'  → 500

# either parameter alone is fine:
curl 'http://host/api/products?page=9272203203533'  → 200
curl 'http://host/api/products?pageSize=1075098'    → 200
```

**Root cause:** the paged read computes `offset = (page - 1) * pageSize`; the
emitted spec declares `minimum: 1` and **no maximum** on either, so an
in-contract pair overflows Postgres's bigint `OFFSET`.

**Fix shape:** declare and enforce an upper bound on `pageSize` (and clamp the
computed offset), on all five backends.

---

## Class: response violates the server's own schema

### F5 — `minLength`/`maxLength` are enforced in UTF-16 code units but declared in code points
**Waiver:** W6 (declared `intermittent` — see below) · **Severity: medium**

```
curl -X POST -H 'Content-Type: application/json' \
  -d '{"sku":"A","price":{"amount":1,"currency":"𖕩j"}}' http://host/api/products
→ 201

curl http://host/api/products
→ 200 {"items":[{... "price":{"amount":1,"currency":"𖕩j"} ...}]}
```

which schemathesis then rejects against the spec the same server published:

```
"𖕩j" is shorter than 3 characters
Schema at /components/schemas/Money/properties/currency: {"minLength":3,"maxLength":3,"type":"string"}
```

**Root cause:** `"𖕩j"` is **3 UTF-16 code units** (the astral character is a
surrogate pair) but **2 code points**. zod's `.min(3)/.max(3)` count code units;
JSON Schema `minLength`/`maxLength` count code points. The value is therefore
simultaneously valid on the way in and invalid on the way out — the write side
persists data the read side cannot legally serve.

**Fix shape:** count code points (`[...s].length`) in the emitted length
refinements. Applies to every `minLength`/`maxLength`-carrying wire field, and
the same question exists on the other four backends (Java/.NET count UTF-16
too; Python counts code points — so this one is *already* a live cross-backend
divergence worth a differential case).

**Why W6 is `intermittent`:** reproducing it needs the fuzzer to both persist an
astral-character value AND read that row back within the same run, so its
absence from a given run is not evidence of a fix. It is exempt from the
staleness half of the ratchet only; it still absorbs its findings. Graduating it
to a pinned deterministic case is the follow-up that removes the exemption.

---

## Class: contract gap

### F6 — every read/delete route answers 422, and the emitted spec declares it nowhere
**Waiver:** W4 · **Severity: medium** · ~17 operations per fixture — the single
highest-count finding.

```
curl 'http://host/api/customers?pageSize=0'  → 422 {"pointer":"/pageSize","message":"Too small: expected number to be >=1"}
curl  http://host/api/customers/0            → 422 {"pointer":"/id","message":"Invalid UUID"}
curl -X DELETE http://host/api/customers/0   → 422
```

but the emitted OpenAPI declares only:

| operation | declared responses |
|---|---|
| `GET /api/customers` | `200` |
| `GET /api/customers/{id}` | `200`, `404` |
| `DELETE /api/customers/{id}` | `204`, `404`, `409` |

Every read and delete route validates its path/query parameters and can answer
422; no read or delete route says so. Any client generated from this spec is
blind to a status it will routinely receive — the #2472 shape (real responses
outside the published contract).

**Fix shape:** emit `422` on every operation whose parameters are validated, on
all five backends (spec-only change, but `conformance-parity` diffs the specs,
so it has to land together).

### F7 — declared `type`/`format` are not honoured: the wire validators coerce
**Waiver:** W7 · **Severity: medium**

```
# placedAt is declared {"type":"string","format":"date-time"} and required
curl -X POST -H 'Content-Type: application/json' \
  -d '{"customerId":"<uuid>","status":"Draft","placedAt":false}' http://host/api/orders
→ 201                                  # `new Date(false)` → the epoch

# price.amount is declared {"type":"number","minimum":0}
curl ... -d '{"sku":"B","price":{"amount":false,"currency":"USD"}}' → 201
```

Declared **bounds** are honoured — `{"amount":-5}` against `minimum: 0`
correctly answers `422 Too small` — and a genuinely unparseable string is
rejected. It is the declared **type** that is not: the emitted validators
coerce, so a boolean is accepted wherever a date-time or a number is declared.

En route, a second-order defect: the 422 that *is* produced for a bad date
carries the nonsense message `"Invalid input: expected date, received Date"` —
a zod-coercion artefact that reaches the user through the validation catalog.

### F8 — a wrong verb on a static sub-path is swallowed by the sibling `/{id}` route
**Waiver:** W9 · **Severity: low** · the #2485 shape, one layer down.

```
curl -X PUT    http://host/api/products            → 405 Method Not Allowed   ✅ (the #2485 fix holds)
curl -X DELETE http://host/api/customers/by_email  → 422 {"pointer":"/id","message":"Invalid UUID"}   ❌
```

`/api/customers/by_email` is a **static** find-by path with only a `GET`. A
`DELETE` against it matches `DELETE /api/customers/{id}` with `id="by_email"`
and is answered as a malformed identifier, when the honest answer is `405` —
the path has no `DELETE`. So the framework-404/405 contract that #2485 fixed
for undeclared verbs on a declared path still has a hole where a literal
segment can be read as a parameter.

---

## Class: by design (recorded, not filtered)

### F9 — an unknown query parameter is accepted
**Waiver:** W8 (`kind: by-design`)

```
curl 'http://host/api/customers?pageSize=20&x-schemathesis-unknown-property=42' → 200
```

Schemathesis counts an unrecognised query parameter as a schema-violating
request that the API accepted. Ignoring unknown query parameters is ordinary
HTTP behaviour and deliberate here. Recorded as an explicit waiver rather than
dropped from the check set, so the decision stays visible.

---

## Follow-up slices

1. **The other four backend legs** — python / java / dotnet / elixir, each over
   that backend's existing obs-e2e boot recipe (a real process + postgres
   sidecar instead of this leg's in-process PGlite). Feeding each backend its
   own spec is what turns these 9 findings into a per-backend answer sheet.
2. **F1–F8 as cross-backend fixes**, one per root cause, each landing on all
   five backends with a wire-golden case so the answer stops being per-backend
   folklore.
3. **The `stateful` phase**, disabled here: its findings are labelled "Stateful
   tests" rather than by operation, so they cannot be keyed into a waiver rule
   yet. It found a 500 on the first exploratory run, so it is worth the key
   design.
4. **OIDC fixtures** — the runner refuses a deployable with an `auth {}` block
   because the bearer material would have to be handed to schemathesis. That is
   where the #2261/#2442 malformed-token class lives, so it is the highest-value
   extension of this leg.
