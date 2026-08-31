# Schemathesis contract fuzzing — findings register (2026-08)

**Subject:** every generated backend, fuzzed against its **own emitted
`/openapi.json`** (M-T9.21). F1–F13 came from the first leg (**node/Hono**);
F14–F26 from the **python / dotnet / java** legs added when the harness became a
matrix — see [Cross-backend legs](#cross-backend-legs-2026-08-24) below.
**Harness:** `test/behavioral/run-schemathesis.mjs` (node) and
`test/behavioral/run-schemathesis-backend.mjs <backend>` (the booted legs) over
the shared `schemathesis-core.mjs` — `npm run test:schemathesis{,-python,-java,-dotnet,-elixir}`.
**Fixtures:** `web/src/examples/storefront-system.ddd` (29 operations) and
`web/src/examples/sales-system.ddd` (18 operations), booted on PGlite in-process
and served on a real port; the cross-backend legs generate the SAME two with the
deployable re-platformed and boot them against a postgres sidecar.
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

**F1 and F7 landed on the node/Hono emitter (2026-08-16)** — a body-carrying
route now refuses a non-JSON `Content-Type` with the declared `415`, and the
request validators no longer coerce in a JSON body. Their waivers (W1, W5, W7)
are deleted.

**F6 and F8 landed (2026-08-18, PR #2612)** — every route that PARSES a request
part declares the `422` it answers (shared matrix, so all five backends move
together), and a wrong verb on a static sub-path answers `405` + `Allow` instead
of the sibling `/{id}` validator's `422`. Their waivers (W4, W9) are deleted.

**F5 landed on node, .NET and java (2026-08-18, PR #2615)** — a string
`.length` bound counts Unicode code points on every backend, matching the
`minLength`/`maxLength` the emitted JSON Schema publishes. Its waiver (W6) is
deleted and a deterministic astral-character case is pinned in the wire golden.

**F10 and F13 landed on all five backends (2026-08-23, PR #2648)** — the
not-found rung is published from the READ that produces it rather than from the
route's shape, so a workflow whose body loads and a non-optional `find` route
both declare the 404 they answer — and .NET (500) and elixir (`200 null`) now
ANSWER it, where they had each diverged in their own direction. W10 is deleted;
F13 never had a waiver
(the fuzzer never reached it — it was found by hand under F10).

---

## Class: server error (500)

### F1 — a request whose `Content-Type` is not `application/json` skips body validation entirely, then 500s
**Status: FIXED (2026-08-16, PR #2566).** A body-carrying Hono handler now
calls `requireJsonContentType(c)` (emitted into `http/problem-details.ts`)
before it reads the validated body. The guard mirrors hono's OWN `jsonRegex`
(bar two redundant escapes), so it passes exactly when the zod validator ran — a wider test would
wave through a body that was never validated, which is the fault itself. It
throws `HTTPException(415)`, which the routers' existing `HTTPException` arm
renders as the same `application/problem+json` body every framework fault uses:

```
curl -X POST http://host/api/products                           → 415 {"title":"Unsupported Media Type","detail":"Content-Type must be application/json"}
curl -X POST -H 'Content-Type: text/plain' -d '<valid json>'    → 415 (same)
curl -X POST -H 'Content-Type: application/json' -d '{}'        → 422 (unchanged)
curl -X POST -H 'Content-Type: application/json'                → 400 Malformed JSON (unchanged)
```

`415` is DECLARED, not just answered: `errorStatuses` in
`src/ir/util/openapi-errors.ts` adds it to the `create` / `operation` /
`workflow` arms, so all five backends publish it together and
`conformance-parity` stays balanced (Hono's hand-rolled workflow + explicit-
handler response sets carry the matching line). The other four already answer
415 at the framework layer (ASP.NET model binding, Spring, `Plug.Parsers`) —
**except python**, where FastAPI falls through to a 422 on a foreign
content-type; making that leg answer 415 too is the remaining follow-up.
Waivers W1 and W5 deleted.

**Waiver:** ~~W1~~ · **Severity: high** — every body-carrying route (create, named
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
**Status: FIXED (2026-08-18, PR #2615)** on node, .NET and java — python was
already correct, elixir counts graphemes (residual, below). **Waiver W6 is
deleted.**

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

**The fix.** A `.ddd` string `.length` — and every `len-*` bound derived from
it — is defined as a count of **Unicode code points**, the unit the published
`minLength`/`maxLength` already used. The per-language snippets live in one
place, `src/generator/_expr/code-point.ts`, and are consumed by BOTH the domain
rule renderer and the wire-boundary validator emitter of each backend, so the
two cannot drift:

| backend | before | after |
|---|---|---|
| node/Hono | `z.string().min/.max/.length` + `s.length` | `.refine((s) => [...s].length …)` + `[...s].length` |
| .NET | `.MinimumLength/.MaximumLength/.Length` + `s.Length` | `.Must(v => v == null \|\| v.EnumerateRunes().Count() …)` + `s.EnumerateRunes().Count()` |
| java | `s.length()` | `s.codePointCount(0, s.length())` |
| python | `Field(min_length=…)` + `len(s)` | unchanged — already code points |
| elixir | `String.length/1`, `validate_length` | unchanged — graphemes (residual, below) |

zod cannot describe a `.refine` to the OpenAPI emitter, so the Hono routes
re-attach the declaration with `.openapi({ minLength, maxLength })`
(`openapiLengthMeta`, `src/generator/zod-refine.ts`) — the published bound is
identical to before, and now matches what the server enforces:

```ts
// before
currency: z.string().length(3),
// after
currency: z.string().refine((s) => [...s].length === 3).openapi({ minLength: 3, maxLength: 3 }),
```

**Residual — elixir counts GRAPHEMES, not code points.** `String.length/1` and
Ecto's `validate_length/3` both count grapheme clusters, and Ecto offers no
`:codepoints` count, so moving it means hand-rolling Ecto's error tuples and
changing its default message text. Graphemes and code points agree on every
astral character — the case that broke the other three, and the one the pinned
runtime case below exercises — and diverge only on combining sequences
(`"e\u0301"`: 1 grapheme, 2 code points), which nothing in the corpus reaches.
Left as a signed residual rather than silently ignored.

**Residual — Angular reactive forms.** `src/generator/angular/form-validators.ts`
still emits `Validators.minLength/maxLength`, which count UTF-16 code units.
That is client-side pre-flight only (the server is authoritative and now
correct), and Angular ships no code-point length validator.

**Pinned deterministic case (the waiver's stated exit).** W6 was `intermittent`
because reproducing it needed the fuzzer to persist an astral value AND read
that row back in the same run. `test/fixtures/corpus/validation-messages.ddd`
now pins both directions in the behavioral tier — recorded in the wire golden,
so all five backend legs gate on it per-PR:

* `"😀X"` — 3 UTF-16 code units, 2 code points — must be **denied** by
  `label.length >= 3` (the messaged/refine carrier), 422 with its authored text;
* nine astral characters — 18 code units, 9 code points — must be **admitted**
  by `label.length <= 16` (the message-less native-chain carrier) and round-trip
  unmangled.

---

## Class: contract gap

### F6 — every read/delete route answers 422, and the emitted spec declares it nowhere
**Status: FIXED (2026-08-18, PR #2612).** `422` is no longer the body tier's
private status: the shared matrix (`src/ir/util/openapi-errors.ts`) declares it
on `getById` and `destroy` — both always parse a `{id}` — and the find arms get
it from `findValidatesRequest` in `src/ir/util/api-surface.ts`, which is TRUE
when the find declares params or its return is paged (a paged `all` parses
`?page=` even with nothing declared). Because it is one table read by all five
backends, `conformance-parity` stays balanced by construction; Hono's two
hand-rolled `{id}` reads (the audit-history route and the workflow-instance
by-id route, both of which render against `errorStatuses("getById")` on the
other backends) carry the matching line.

The predicate is not a guess about the route — it is the SAME expression Hono
gates its query validator on. `emitFindRoute`'s `hasQuery` now calls
`findValidatesRequest`, so a find cannot grow the validator that ANSWERS the 422
without growing the declaration, or the reverse:

```
curl 'http://host/api/customers?pageSize=0'  → 422, declared          (was: declared 200 alone)
curl  http://host/api/customers/0            → 422, declared          (was: declared 200, 404)
curl -X DELETE http://host/api/customers/0   → 422, declared          (was: declared 204, 404, 409)
```

A param-less, un-paged find (`find recent(): Product[]`) parses nothing and
still declares nothing — the flag is route-shape-derived, not blanket. Waiver W4
deleted.

**Honest remainder, exactly as F1's 415 carried one.** The DECLARATION now agrees
on all five backends, and node/python ANSWER it (hono's shared `defaultHook`,
FastAPI's request validation). The other three answer their framework's own code
for a malformed `{id}` — `[ApiController]` model-binding gives 400, Spring's
`MethodArgumentTypeMismatchException` gives 400 — so on those the declared 422
is currently wider than what they send, and the 400 they DO send is itself
undeclared: F6's own shape, one backend over. Converging the runtime answer is
the follow-up, and it is the right order — the parity gate diffs the specs, so
the shared declaration has to move as one PR before any single backend's runtime
arm can be changed without manufacturing a spec divergence.

**Waiver:** ~~W4~~ · **Severity: medium** · ~17 operations per fixture — the single
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

**Fix shape (as landed):** emit `422` on every operation whose parameters are
validated, on all five backends (spec-only change, but `conformance-parity`
diffs the specs, so it has to land together).

### F7 — declared `type`/`format` are not honoured: the wire validators coerce
**Status: FIXED (2026-08-16, PR #2566).** The single `REQUEST_PRIMITIVE` table
in the Hono routes-builder split into `QUERY_PRIMITIVE` (still coercing — a
query-string value genuinely arrives as a string, so the coercion IS the parse)
and `BODY_PRIMITIVE` (strict — a JSON body carries real types, which is the
argument the bool arm already made). A body `int`/`long` is `z.number().int()`,
`decimal` is `z.number()`, and `datetime` is
`z.string().datetime({ offset: true, local: true }).transform((s: string) => new Date(s))`,
which still publishes `{"type":"string","format":"date-time"}` and still hands
the domain layer a `Date`. `local: true` is not slack — the generated
frontends render a datetime field as `<input type="datetime-local">` and send
its unqualified `2024-01-01T00:00` value verbatim, so without it every datetime
form submission would 422. Path parameters keep their own coercion
(`pathParamZod`), which is correct for the same reason query does.

```
-d '{"customerId":"<uuid>","status":"Draft","placedAt":false}'  → 422 /placedAt "expected string, received boolean"
-d '{"sku":"B","price":{"amount":false,"currency":"USD"}}'      → 422 /price/amount "expected number, received boolean"
-d '{"sku":"C","price":{"amount":"12","currency":"USD"}}'       → 422 /price/amount "expected number, received string"
-d '{… ,"placedAt":"nonsense"}'                                 → 422 /placedAt "Invalid ISO datetime"
```

That last line closes the second-order defect too — the coercion artefact
`"Invalid input: expected date, received Date"` is gone. One side effect worth
knowing: zod-to-openapi marks every COERCED field `nullable: true` (a coercing
schema does accept `null`), so dropping the coercion also drops a spurious
`nullable` from the published request/response schemas. Waiver W7 deleted.

**Waiver:** ~~W7~~ · **Severity: medium**

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
**Status: FIXED (2026-08-18, PR #2612).** Each aggregate router now opens with a
one-segment guard middleware listing its STATIC sub-paths and the methods each
serves (`{ by_email: ["GET"], prepare: ["GET"] }`, emitted by
`staticSubpathMethods` / `emitStaticSubpathMethodGuard` in
`src/platform/hono/v4/routes-builder.ts`):

```
curl -X DELETE http://host/api/customers/by_email
→ 405 application/problem+json, allow: GET      (was: 422 {"pointer":"/id","message":"Invalid UUID"})
curl -X GET    http://host/api/customers/by_email  → 200/404 (unchanged)
```

It has to be a MIDDLEWARE and it has to be first: `@hono/zod-openapi` runs the
`{id}` param validator as part of the matched route's own handler chain, so any
check inside the `/{id}` handlers is already too late — the 422 has been sent.
Registered with `app.use`, i.e. under hono's `ALL` method, which the root
router's `allowedFor` probe skips by construction — so `app.notFound`'s 405 arm
(#2485) answers exactly what it answered before for every other path, and the
two mechanisms do not overlap. It also fixes the `Allow` those paths used to
get: `POST /api/customers/by_email` reached `notFound`, whose probe matched the
sibling `/{id}` routes and advertised `GET, DELETE` on a path that serves only
`GET`.

Only ONE-segment statics need it. `/{id}/history` and `/{id}/can_<op>` are two
segments, so nothing shadows them and a wrong verb there already falls through
to the root 405 arm. Waiver W9 deleted.

**Waiver:** ~~W9~~ · **Severity: low** · the #2485 shape, one layer down.

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

## Uncovered when F1/F7's waivers were deleted (2026-08-16)

W1/W5/W7 were BROAD rules (`^POST /api/`, `^POST `). While they stood, every
other POST-side root cause landed inside them and was reported as waived. The
two below are not new defects and not regressions of the F1/F7 fix — they are
what the same runs were already producing underneath it. They get their own
narrow rules so the next deletion can't hide a third one.

### F10 — a workflow that loads an aggregate answers 404, and the workflow route declares none
**Status: FIXED (2026-08-23, PR #2648).** The rung is declared on all five
backends when — and only when — the body can raise it. W10 is deleted.
**Severity: medium** — every workflow whose body reads an
aggregate by a client-supplied id.

```
curl -X POST -H 'Content-Type: application/json' \
  -d '{"customerId":"<unused uuid>", …}' http://host/api/workflows/checkout
→ 404   # `Customers.getById(customerId)` → AggregateNotFoundError → onError
```

but `errorStatuses("workflow")` declared `400`, `415`, `422` (+`403` when
guarded) and no `404`. This is F6's shape on the workflow arm: a status the
route really sends, published nowhere, so every generated client is blind to
it. Unlike the read routes, the 404 is CONDITIONAL — a workflow whose body
touches no repository cannot send it — so the honest fix needs a
"body reads an aggregate" predicate rather than an unconditional `404` on the
kind, and declaring it unconditionally would trade this contract lie for its
mirror image (a declared status the route can never send).

`workflowCanAnswerNotFound` (`src/ir/types/loom-ir.ts`) is that predicate,
threaded into the shared table as `opts.readsAggregate` by all five backends.
It is true for exactly two producers: a `repo-let` (validator-constrained to a
single non-optional aggregate, so the emitted method can only report an empty
result by throwing) and a NAMED read inside an expression — the `reading`
domain-service tier, whose read port this workflow threads. `repo-run` /
`findAll` return arrays, `if-let` handles the empty case explicitly, and a
criterion `find` renders as `[0] ?? null`: none of those can throw.

> **The waiver did not go stale — the fuzzer stopped reaching it.** W10 failed
> the nightly as a stale rule on 2026-08-21/22/23 while the `workflow` arm still
> had no 404. The seed is pinned, but Schemathesis derives its cases FROM the
> spec, and this one needs a body whose id resolves to nothing in a run whose
> earlier cases shaped the table — so a spec change reshuffles whether it is
> generated at all. The ratchet's staleness half asks a question; it does not
> answer one. `schemathesis-waivers.json` now says so, and a finding with this
> data dependency carries `intermittent` (W11/W12 do; W10 should have).

### F13 — a non-optional declared `find` route answers an undeclared 404 too
**Status: FIXED (2026-08-23, PR #2648)**, in the same commit as F10 and by the
same one-line reasoning: the rung is a fact about the read.
**Waiver:** none — the fuzzer never reached it (neither fixture declares a
non-optional `find`) · **Severity: medium** — found by hand while root-causing
F10, and it is the SAME defect one route class over.

```
find byRef(r: string): Wallet where this.ownerRef == r     # non-optional
→ GET /api/wallets/by_ref?r=nope   answers 404
```

but `errorStatuses("findSingle")` declares `{200, 422}`. The emitted repository
method throws `AggregateNotFoundError` on an empty result set (it has no other
option — the declared return type is non-optional), and the aggregate router's
`onError` renders that as a 404. An OPTIONAL find declares its 404 (the absent
variant rides that status by design); the NON-optional one, which reaches the
same status by throwing, declares nothing.

`findSingle` now declares the rung exactly as `findOptional` does — and forcing
that question surfaced a RUNTIME half nobody had asked about. All five backends
agree on the happy path and split four ways on a miss:

| backend | answered on an absent row |
|---|---|
| node | 404 — the repository method throws the shared carrier |
| java | 404 — the controller null-checks and throws |
| python | 404 — the route null-checks and raises |
| **.NET** | **500** — EF `FirstAsync` throws `InvalidOperationException("Sequence contains no elements")`, which no filter arm matches (and on `persistence: dapper`, it did not compile at all) |
| **elixir** | **200** with a `null` body — not a valid `<Agg>Response`, so it violates the 200 schema it publishes |

There is a third .NET path: `persistence: dapper` builds its own method bodies
rather than riding the EF terminal, and returned a bare `null` from a declared
`Task<Agg>` — which is not a runtime bug but a COMPILE one. `dotnet build
/warnaserror` (the `dotnet-build` gate) rejects it with CS8603, so
`persistence: dapper` paired with a non-optional find has never compiled; no
fixture in that matrix pairs the two. Verified by building the emitted project
in `mcr.microsoft.com/dotnet/sdk:10.0`: FAILED before, `0 Warning(s) 0 Error(s)`
after, for the efcore, dapper and `shape: document` adapters alike.

All of it is corrected with the declaration, or it would have been a second lie
on two backends. The split was invisible to every existing gate: the wire
differential GETs collection endpoints, and no corpus case reads a single find
that misses. Elixir's emitter had even recorded the reason it kept `json(conn,
nil)` — "`findSingle` declares no error status" — which is exactly the premise
this finding removes.

Together with F10 this names the root cause under both: the shared table
publishes the not-found rung from the ROUTE SHAPE (does the path carry an
`{id}`?), while the rung's real producer is the READ — every repository read
returning a non-optional aggregate throws when the row is absent. Shape and
read agree for `getById`/`destroy`/`operation`, and diverge in exactly the two
places a non-optional read happens without a path id: a non-optional `find`
route, and a workflow body that reads.

### F11 — an `int` field declares no range, and a value inside the declared range overflows the column
**Waiver:** W11 (server error) + W12 (its status-conformance consequence), both
`intermittent` · **Severity: high** — any body carrying an `int`.

Intermittent because reaching the column needs two things in one run: an
out-of-int32 `qty` *and* a path `{id}` that resolves to a row the fuzzer made
earlier (a random uuid 404s first). It reproduced on the discovery run and not
on the next, which is why the two rules are exempt from the staleness half of
the ratchet — same shape as W6, and it graduates the same way (a pinned
deterministic case).

```
curl -X POST -H 'Content-Type: application/json' \
  -d '{"productId":"<uuid>","qty":9543751572142}' http://host/api/orders/<id>/add_line
→ 500   # value out of range for type integer
```

The wire validator says `z.number().int()` and the spec says
`{"type":"integer"}` — neither carries a bound — while the column behind it is
Postgres `int4`. So the fuzzer obeys the published contract exactly and still
reaches a server error. Same family as F7 (declared vs enforced), one level
down: F7 was the declared TYPE not being honoured, this is the declared RANGE
not existing. The fix is to declare and enforce int32 for `int` (int64 for
`long`) — a spec change, so all five backends together, and `.NET`/`Java`
already type-bound their side while python/elixir do not.

**Re-verified 2026-08-31 (Wave 1b `wire-openapi` packet) and deliberately NOT
taken there — with the size measured rather than asserted.** The premise holds:
`int` still publishes an unbounded `{"type":"integer"}`. What the re-check adds
is why this keeps being deferred (#2648, #2664, and now a third time), so the
next agent does not re-discover it: **there is no shared choke point.** Each
backend derives its integer schema separately — elixir from its own literal
table (`elixir/vanilla/openapi-emit.ts:849/865`), .NET/java/python by
REFLECTION over the annotated wire types (Swashbuckle / springdoc / FastAPI, so
the bound has to come from a `[Range]` / `@Min@Max` / `Field(ge=,le=)` the
validator emitters attach), node from zod via `_frontend/zod-schemas.ts`. So
"declare int32" is five emitter changes plus the shared zod one, and the two
waivers can only be DELETED once a booted schemathesis leg passes — a runtime
tier, not a unit one. That is a mission, and it should be claimed as one rather
than ridden along with a contract-shaped packet.

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

## Cross-backend legs (2026-08-24)

The harness became a five-cell matrix: `run-schemathesis.mjs` keeps the
in-process PGlite boot for node, `run-schemathesis-backend.mjs <backend>` boots
the other four as real processes against a postgres sidecar, and everything
after "the server is listening" is the shared `schemathesis-core.mjs`. Waiver
rules gained a `backends` list, because each leg is its own process against its
own database and staleness cannot be pooled across them.

**What the other backends answered.** The node leg is *clean* — 11 findings, all
attributed to W8/W10/W11/W12. It is clean because F1, F5, F7 and F8 were fixed
**on the Hono emitter only**. Feeding each backend its own contract is what turns
that into a visible per-backend answer sheet:

| Leg | Findings | Root causes | Verdict with the new rules |
|---|---|---|---|
| node | 11 | (F9, F10, F11) | clean |
| python | 22 | F16, F17 (=F7 unfixed here), F18 (=F8 unfixed here), F9, F10 | clean |
| dotnet | 10 + 1 case unfuzzable | F14, F19, F20, F21, F22, F9 | clean |
| java | 103 | F19, F21, F23, F24, F25, F26, F18, F9, F10, F11 | clean |
| elixir | — | F15 | discovery cell (see below) |

Three of the four new legs reproduce a finding the node emitter has *already
fixed*. That is the headline: a per-backend fix reads as "closed" in this
register while three backends still answer the old way, and no gate said so
until each backend was fuzzed against its own published contract.

### F14 — .NET: `GET /openapi.json` 500s when two contexts emit the same request DTO name
**Status: FIXED (2026-08-30, PR #2686).**
**Waiver:** none — it was a *case skip* (`SKIP.dotnet["storefront-system"]` in
`run-schemathesis-backend.mjs`), because there was no contract to fuzz; the skip
is drained with the fix and `SKIP.dotnet` is now empty.
**Severity: high** · the published contract is unavailable, not merely wrong.

```
curl http://host/openapi.json → 500
Swashbuckle.AspNetCore.SwaggerGen.SwaggerGeneratorException:
  Failed to generate schema for type - Api.Application.Products.Requests.CreateProductRequest
  ---> System.InvalidOperationException: Can't use schemaId "$MoneyRequest" for type
       "$Api.Application.Products.Requests.MoneyRequest".
       The same schemaId is already used for type "$Api.Application.Orders.Requests.MoneyRequest"
```

The .NET emitter writes a per-aggregate request namespace, so a value object used
by two aggregates produces two CLR types with the same short name. Swashbuckle's
default `schemaId` selector is the short name, and a collision is fatal to the
whole document. `storefront-system` has `Money` on both `Product` and `Wallet`,
so its spec endpoint 500s; `sales-system` uses `Money` in one namespace and is
fine — which is exactly why no existing gate caught it.

**The fix is narrower than "qualify every id".** The axis is the NAMESPACE, not
the context: the emitter writes one `Application.<Aggregates>.Requests` /
`.Responses` per AGGREGATE, so `storefront-system` reproduces it inside a single
context (`Money` on `Product`, `Wallet`, `Order`, plus the workflow request
namespace — seven colliding CLR types, not two). Namespace-qualifying every
schema id would close the crash and break something else: the other four
backends publish SHORT component names, and that shape is what
`.loom/wire-spec.json` and conformance-parity compare. So
`src/generator/dotnet/schema-ids.ts` derives the colliding short names from the
project's own emitted DTO files at EMIT time and `Program.cs` maps only those
(`ProductsMoneyRequest` / `OrdersMoneyRequest` / …), keeping the `Paged<>` arm
first and the bare `return t.Name;` fallback for everything else — a
collision-free project emits byte-identical output.

### F15 — elixir: no `/openapi.json` at all unless the deployable declares `serves:`
**Waiver:** none — the elixir leg runs a *different fixture* for this reason
(`ELIXIR_CASES`). **Severity: high** · a whole backend can publish no contract.

**Status: FIXED (2026-08-30, PR #2687).** `serves:` no longer decides whether
the document exists — only what it is CALLED. `emitOpenApiSpec`
(`src/generator/elixir/vanilla/openapi-emit.ts`) dropped the early return and
falls back to the app name for the spec module (`ApiWeb.Api.ApiSpec`,
`lib/api_web/api/api_spec.ex`) when the deployable declares no api, so a
`contexts:`-only deployable publishes the same route-derived document the other
four backends publish. Nothing else moved: every path and schema in that module
was already derived from the hosted contexts, and a deployable that DOES declare
`serves:` emits byte-identical output (differenced emission-to-emission in
`test/generator/elixir/vanilla-openapi-no-serves.test.ts`).

`ELIXIR_CASES` still runs `web/src/examples/storefront-elixir.ddd` — collapsing
it back into `SHARED_CASES` is a follow-up, because pointing the leg at the two
shared fixtures fuzzes a contract elixir has never published and is a discovery
run, not a no-op.

**Repro (pre-fix).** `emitOpenApiSpec` returned early when `deployable.serves`
was empty, so a deployable declared with `contexts:` alone emitted no spec
module, no `OpenapiController` and no `/openapi.json` route. The other four
backends publish a document derived from the routes either way. Both shared
fixtures declare `contexts:` only, so on elixir there was literally nothing to
fuzz them against; the leg therefore runs
`web/src/examples/storefront-elixir.ddd`, which does declare an `api`.

### F16 — python: a create referencing a well-formed uuid that does not exist 500s
**Waiver:** W20 (+ W21) · **Severity: high**

```
curl -X POST http://host/api/orders \
  -d '{"customerId":"e3e70682-c209-1cac-a29f-6fbed82c07cd","placedAt":0,"status":"Draft"}'
→ 500
asyncpg.exceptions.ForeignKeyViolationError: insert or update on table "orders"
  violates foreign key constraint "orders_customer_id_fkey"
```

F2's successor. F2 was the *malformed* reference, fixed on all five in #2555 by
publishing and enforcing `format: uuid`; this is the well-formed one, which no
amount of wire validation can catch — a uuid is only wrong because the row is
absent. Nothing between the SQLAlchemy repository and the router maps
`IntegrityError`, so it escapes as 500 and, being undeclared, also trips
`status_code_conformance`. The node leg does not reproduce it: the PGlite DDL the
behavioral harness synthesises carries no foreign keys, so node's clean result
here is an artefact of the harness, not of the emitter — worth fixing in
`synthDDL` so the two legs ask the same question.

### F17 — python: F7 (declared `type` not honoured) is still open
**Waiver:** W22 · **Severity: medium**

```
curl -X POST http://host/api/products \
  -d '{"sku":"0","price":{"amount":false,"currency":"000"}}' → 201
```

`Money.amount` publishes `{"type":"number","minimum":0}`. Python's `bool` is an
`int` subclass and pydantic's lax mode coerces it, so a body the published
contract rejects is accepted. F7's fix landed on the Hono emitter only
(2026-08-16) — same defect, same declared schema, different answer.

### F18 — python + java: F8 (wrong verb on a static sub-path) is still open
**Waiver:** W23 (python), W33 (java) · **Severity: low**

```
curl -X DELETE http://host/api/customers/by_email
→ 422 {"pointer":"/id","message":"Expected UUID."}      (honest answer: 405)
```

F8's fix is a hono middleware (`emitStaticSubpathMethodGuard`,
`src/platform/hono/v4/routes-builder.ts`) with no counterpart on the other
backends: FastAPI and Spring both match `DELETE /api/customers/{id}` with
`id="by_email"` and answer the identifier validator's 422.

### F19 — dotnet + java: a malformed declared `date-time` reaches the domain layer
**Waiver:** W24/W25 (dotnet), W29/W30 (java) · **Severity: high**

```
curl -X POST http://host/api/orders -d '{"customerId":"…","placedAt":"","status":"Draft"}'
→ 500   System.FormatException: String '' was not recognized as a valid DateTime.   (.NET)
→ 500   java.time.format.DateTimeParseException: Text '' could not be parsed at index 0  (java)
```

The field publishes `{"type":"string","format":"date-time"}`, and both backends
parse it inside the domain constructor rather than refusing it at the wire
boundary. F7's family — declared but unenforced — on the two statically typed
backends.

### F20 — dotnet: a NUL character in a declared string reaches Postgres
**Waiver:** W24/W25 · **Severity: medium**

```
curl -X POST http://host/api/customers -d '{"email":" ","name":""}' → 500
asyncpg/Npgsql: CharacterNotInRepertoireError (22021) — invalid byte sequence
```

` ` is a legal JSON string character and an illegal Postgres `text` byte.
Nothing on the write path rejects it, so the driver's error escapes as a 500. The
same generated body also reproduces F21 (see below) when the NUL half happens not
to be generated, which is why W27/W28 are marked `intermittent`.

### F21 — dotnet + java: `minLength` is published and enforced nowhere
**Waiver:** W27/W28 (dotnet), W34 (java) · **Severity: medium**

```
curl -X POST http://host/api/customers -d '{"name":"","email":"a@b.c"}'  → 201
curl     http://host/api/customers                                       → 200, and the
  response violates the API's OWN schema: "" is shorter than 1 character
```

One defect with two halves. `name` carries `minLength: 1` in both the request and
the response schema; .NET and java enforce it in neither, so the write is
accepted and the *read* then violates the published contract. Enforcing the
declared bound on the write closes both.

### F22 — dotnet: a bodyless operation POST answers 415 before the path parameter is looked at
**Waiver:** W26 · **Severity: low**

```
curl -X POST 'http://host/api/orders/%C2%A8/confirm'   → 415
```

ASP.NET's media-type check fires before model binding, so a request with a
malformed `{id}` AND no body is answered by the one thing the contract says least
about. 415 is not in the set of statuses that count as a rejection, so the fuzzer
reads it as "schema-violating request accepted". The honest answer is the
declared 422 for the unparseable identifier (or 400 for the absent body).

### F23 — java: a required body field arriving as JSON `null` NPEs in the domain layer
**Waiver:** W29/W30 · **Severity: high**

```
curl -X POST http://host/api/products -d '{"sku":null,"price":{"amount":1,"currency":"USD"}}'
→ 500   java.lang.NullPointerException: Cannot invoke "String.codePoints()" because "sku" is null
```

Also observed as `"amount" is null` and `"qty" is null`. The field is `required`
in the published request schema; the Spring binder maps a JSON `null` to a Java
`null` and hands it straight to the invariant check. Same family as F19 — the
declared shape is published and never enforced.

### F24 — java: an adversarial query string 500s a paged find
**Waiver:** none — the CI leg never generates this case · **Severity: medium**

**Status: OPEN, but NOT reproduced by the schemathesis leg** (2026-08-30). W31 was
retired here because it had matched **nothing on every java run since the leg landed** —
the 08-29 nightly (`38580cd`) and the 08-30 dispatch (`20a6745`) produce byte-identical
attribution tables, `— W31` in both, so the leg failed on `STALE WAIVER W31` rather than
on any finding. A waiver for a case the fuzzer does not produce is permanently stale and
holds the leg permanently red.

Retiring it is **not** a claim that F24 is fixed, and the staleness is **not** evidence
that it is — the W10 episode (#2648) is the standing reminder that the ratchet's
staleness half asks a question rather than answering one. Three things say the hazard is
still live:

- `JAVA_PAGED_QUERY_PARAMS` (`src/generator/java/emit/common.ts`) still binds `sort` and
  `dir` as **unvalidated `String`** with defaults, while `page`/`pageSize` next to them
  carry `@Min`/`@Max`. The repro above targets `sort`/`dir` precisely.
- `#2667` is the only java-generator change since the register landed and it touches
  `entity` / `query-projection-reads` / `service` / `render-jpql` — nothing on the
  query-parameter binding path.
- The GET route class **is** fuzzed: W32 (`status_code_conformance` on the same
  `^GET /api/`) matched ×10 in both runs. Only the *server-error* check comes back empty,
  so this is the fuzzer not generating the adversarial query string — not the route
  going unvisited.

So F24 needs a **targeted regression test** (validate `sort` against the aggregate's
sortable fields, and `dir` against `asc`/`desc`), not a fuzzer waiver. Until that lands
the finding stays open here with no rule attached.

```
curl 'http://host/api/products?sort=%22&dir=%C3%9D5%03&…' → 500
```

The query-parameter binder's twin of F23 (Tomcat additionally rejects some
chunks before the app sees them). Kept as its own rule because the fix is on the
other side of the request — the query binder, not the body binder.

### F25 — java: the paged bounds answer 400, and no read route declares one
**Waiver:** W32 · **Severity: low**

```
curl 'http://host/api/products?pageSize=0' → 400   (the shared matrix declares 422)
```

#2555 gave `page`/`pageSize` declared, enforced upper bounds on every backend.
Java enforces them with a status its own spec does not publish — the F6 shape,
one route family over.

### F26 — java: every 405 omits the `Allow` header
**Waiver:** W33 · **Severity: medium**

```
curl -X QUERY http://host/api/customers
→ 405 {"title":"Method Not Allowed",…}   with NO Allow header
```

RFC 9110 makes `Allow` a MUST on 405. It fires on every operation, `/health` and
`/ready` included, which is why W33's pattern is unscoped: the defect is in the
one shared error mapper, not in any route. The #2500 class one layer over — that
was a 401 without `WWW-Authenticate`.

### The elixir leg
It ships as a **discovery cell**: the matrix runs it, but `continue-on-error`
keeps its verdict off the workflow's, because its waiver register is empty. The
elixir toolchain could not be exercised locally when the matrix landed (the hex
image was unreachable from the sandbox), and seeding rules by guesswork is worse
than none — a wrong rule fails the leg from either direction. The first nightly
produces the finding set (`LOOM_SCHEMATHESIS_UPDATE=1` writes `observed.json`);
turning it into root-cause rules and deleting the `discovery: true` matrix entry
is the follow-up. F15 above is what is already known about that leg.

---

## Follow-up slices

1. **Seed the elixir leg and drop its `continue-on-error`** — the one cell of the
   matrix whose rules are not yet written (see "The elixir leg" above), plus F15,
   which is why it cannot run the shared fixtures at all.
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
