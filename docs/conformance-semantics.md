# Loom — Runtime-Semantics Conformance

> **Status:** v1 (2026-07-04). Seeded from the #1620–#1660 wire-parity sweep.
> The rule registry is machine-readable at
> [`test/conformance/semantics-rules.ts`](../test/conformance/semantics-rules.ts)
> and pinned by `test/conformance/semantics-rules.test.ts`. This doc is the
> human-readable companion — when the two disagree, the registry (and the code
> it points at) wins.

## Why this exists — the gap the structural gate can't see

Loom already has a **structural** cross-backend contract:
[`docs/conformance.md`](conformance.md) diffs every backend's emitted **OpenAPI
spec** (operations, operationIds, schema names, field names, required sets,
enum value-sets, path-param types, RFC 7807 error *shape*) and asserts
drop-in-client equality. `wire-spec.json` (`src/system/wire-spec.ts`) is its
per-aggregate companion.

That contract is **structural, and deliberately casing-tolerant** — it compares
the *shape* of the spec, not the *values a running backend actually returns*.
So an entire class of drift sails straight through it:

> #1620, in the fixer's own words: *"Two runtime bugs the showcase 5-backend
> behavioral run surfaced on the vanilla Phoenix backend — **the OpenAPI
> spec-diff was blind to both.**"*

The evidence that this is the repo's dominant live bug-source: **~40% of the
last 50 commits are `fix:`, and the majority are Elixir wire-parity chases**
(#1620, #1622, #1626, #1628, #1632, #1633, #1636, #1639, #1660 …) — code that
compiled green, passed the structural parity gate, and **failed on a runtime
round-trip**. Each was found late (nightly docker `conformance-full`, or by
hand), not per-PR, because the only per-PR behavioral round-trip runs for
**Hono/node** (`test/behavioral/`, single-backend by construction).

This document names those runtime guarantees as **RS-rules** so that:

1. Each past fix becomes a *named, provenance-linked* contract clause, not
   tribal knowledge buried in a commit.
2. The next regression is **"RS-N violated,"** reviewable against a spec,
   instead of a fresh archaeology dig.
3. There is a single target for the enforcement work
   (`A6.2` — a second backend in the per-PR behavioral tier), so the rules move
   from *documented* to *gated*.

**Scope boundary.** `conformance.md` owns the **spec** (what a client binds
against). This doc owns the **runtime values** (what a booted backend actually
sends and accepts over that spec). A rule belongs here only if a structural
spec-diff cannot catch its violation.

## How a rule is enforced (the tiers)

| Tier | Mechanism | Runs | Catches |
|---|---|---|---|
| **T0 static** | assert a property of *emitted source* across all 5 backends (`test/conformance/*`) | per-PR, no docker | rules whose violation is visible in generated code |
| **T1 behavioral (node)** | boot the Hono deployable on PGlite, round-trip (`test/behavioral/`) | per-PR, no docker | any runtime rule — but only proves **node** |
| **T2 behavioral (Nth backend)** | **`A6.2` — landed for Python** (`test/behavioral/run-python.mjs` + `behavioral-e2e-python.yml`): boots the generated FastAPI backend on a `services: postgres` sidecar and HTTP-dispatches the same emitted api e2e | per-PR (path-filtered) | the actual cross-backend drift the RS-rules describe (RS-1/4/6/7/8 on Python) |
| **T3 full** | 5-backend docker round-trip (`conformance-full.yml`) | nightly / label | everything — but too slow to be the per-PR net |

The RS-rules below tag each with the **lowest tier that can gate it today**.
The strategic goal of `A6.2` is to pull the T2 column into per-PR range so the
casing/casting/association rules stop landing on `main` before they're caught.

---

## The rules (v1)

Each rule: the guarantee, the `.ddd` trigger, the observable wire behavior,
the conforming backends, and the fix that established it.

### RS-1 · Wire keys are camelCase, both directions
- **Guarantee.** Response bodies serialize field keys in **camelCase**
  (`commitSha`, `startedAt`, `externalId`). Inbound request bodies are
  **accepted in camelCase** and normalized to the backend's storage casing
  *before* persistence — a multi-word field must never be silently dropped.
- **Trigger.** Any aggregate with a multi-word field (`commitSha: string`) on
  create/update.
- **Observable.** `POST {"commitSha":"…"}` persists `commit_sha` and reads back
  `{"commitSha":"…"}`. A backend that casts snake atoms against verbatim
  camelCase keys drops the field → spurious `422 validate_required`.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1620 (elixir `__normalize_keys/1` in `base_changeset`),
  #1632 (nested relational changesets), #1636 (document schemaless changeset).
  Elixir was the last to conform; the JS/EF/JPA/Pydantic layers were camelCase
  natively. Tier: **T1** (single-word fields hid this on node — needs a
  multi-word round-trip).

### RS-2 · Enum values use declared casing on the wire
- **Guarantee.** An enum value declared `Passed` serializes and casts as
  `"Passed"` — never a backend-idiomatic re-casing (`passed`, `PASSED`).
- **Trigger.** `enum BuildState = Passed | Failed`; a field of that type on a
  create body.
- **Observable.** `POST {"buildState":"Passed"}` → `201`, reads back
  `"Passed"`. A backend that snake-cases enum storage values returns
  `422 "is invalid"`.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1622 (Ecto.Enum was snake-casing `:passed` vs the declared
  `"Passed"`). Tier: **T0** — gated per-PR by
  [`test/conformance/enum-casing-parity.test.ts`](../test/conformance/enum-casing-parity.test.ts)
  (the emitted enum definition fixes the wire value, so no boot is needed).

### RS-3 · No persistence-internal columns leak to the wire
- **Guarantee.** Framework/storage bookkeeping — `inserted_at`/`updated_at`,
  soft-delete flags, internal jsonb envelopes — never appears in a response
  unless it is a **declared** field. The response key-set equals `wireShape`.
- **Trigger.** Any read of a `softDeletable`/`auditable` aggregate, or any
  backend whose ORM auto-stamps timestamps.
- **Observable.** `GET` returns exactly the `wireShape` keys — no
  `inserted_at`, no `updated_at`.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** §14 sweep, #1628 (`wireShape`-driven serializer replacing a
  `Map.from_struct` leak). Tier: **T0** — gated per-PR by
  [`test/conformance/wire-no-leak-parity.test.ts`](../test/conformance/wire-no-leak-parity.test.ts)
  (asserts the framework-timestamp leak signature is absent at each backend's
  wire-serialization site).

### RS-4 · Declared temporal fields round-trip
- **Guarantee.** A declared `createdAt`/temporal field submitted on create is
  **cast and persisted**, not dropped or clobbered by an ORM auto-value, and
  reads back equal.
- **Trigger.** An aggregate declaring `createdAt: instant` with an explicit
  create.
- **Observable.** `POST {"createdAt":"2026-01-01T00:00:00Z"}` reads back the
  same instant, in the canonical `…00Z` wire form (trailing zero fractional
  seconds trimmed) across every backend.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1626 (cast declared `createdAt` + preload insert
  associations); RST-9 (canonicalize the .NET instant wire form — trailing zero
  fractional seconds trimmed to `…00Z`, matching node/python/java). Tier: **T1**.

### RS-5 · Union-variant absence match is a presence check everywhere
- **Guarantee.** A union-find variant `match` against an absent/nullable
  subject lowers to a **nullable-subject presence ternary**
  (`subjectShape:"absence"`) on all five backends — not a type-tag comparison
  that only one backend's representation supports.
- **Trigger.** `find one X or absent` feeding a `match { X => … | absent => … }`.
- **Observable.** The absent arm is taken when the row is missing, identically
  across backends.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1631 (S2: absence match → nullable-subject ternary +
  per-backend `absenceCheck` leaf). Tier: **T0** — already gated per-PR by the
  pre-existing
  [`test/conformance/union-find-absence-parity.test.ts`](../test/conformance/union-find-absence-parity.test.ts),
  which anchors each backend's absence-check leaf (`result == null`, `is None`,
  …) and the 404 ProblemDetails mapping across all five.

### RS-6 · Boolean create defaults materialize at the wire boundary
- **Guarantee.** A field declared `active: bool = true`, **omitted** on create,
  arrives `true` — the default is applied at the wire projection, not left to a
  zero-value `false`/`null`.
- **Trigger.** `active: bool = true`; a create body omitting `active`.
- **Observable.** `POST {}` (no `active`) reads back `{"active":true}`.
- **Conforms.** node, **python**, **java** (dotnet/elixir still targets).
- **Provenance.** July full-code-review finding B14; Java closed by RST-10. Tier:
  **T1** — gated per-PR on node and python (A6.2) and on Java via the behavioral
  tier. The python behavioral gate **found and closed** a real parity bug here:
  the FastAPI create model hardcoded `active: bool = False` (the zero value)
  instead of the declared default; fixed by rendering the field's lowered
  `default` expr in the create request field (`routes-builder.ts`). Java (RST-10)
  hit the same class — the Spring create record made the defaulted field a
  required primitive and 400ed on an omitted key; fixed by boxing the create-DTO
  component and materializing the declared default in the request→domain mapping
  (`emit/dto.ts` + `emit/service.ts`).

### RS-7 · Value-object subfields survive a jsonb round-trip
- **Guarantee.** A value object stored inline as jsonb rehydrates so that
  subfield reads and wire serialization neither crash nor drop — the VO reads
  back with all subfields.
- **Trigger.** `valueobject Money { amount: decimal, currency: string }` as an
  aggregate field on a jsonb-storing backend.
- **Observable.** `GET` returns the nested `{"amount":…,"currency":…}`; a
  subsequent op reading `self.price.amount` does not raise.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1660 (VO subfield reads + wire serialization crash on
  jsonb-loaded VOs). Tier: **T1**.

### RS-8 · Associations persist and preload on round-trip
- **Guarantee.** Nested relational parts and `X id[]` ref-collections mutated
  via an op (`lines += …`, `members += t`) **persist through the association**
  (preload / `put_assoc` / cascade), and read back — no in-memory projection
  that silently omits the join write.
- **Trigger.** An op mutating a containment or ref-collection.
- **Observable.** After the op, `GET` nests the added child / lists the added id.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** §11c, #1626 (preload insert associations), DEBT-03 tail
  (vanilla returning-op `put_assoc`). Tier: **T1**.

### RS-9 · Error bodies converge on RFC 7807 with the 400/422 split
- **Guarantee.** Validation failures return `application/problem+json` (RFC
  7807); a malformed/unparseable body is `400`, a well-formed body failing a
  domain invariant is `422`. The *wire shape* of the problem body is identical
  across backends (per-field errors in the same envelope).
- **Trigger.** A create violating an invariant vs a create with a malformed body.
- **Observable.** Same status + same problem-body shape on every backend.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1620 (hardened changeset-error renderer), the two-tier
  400/422 model dispositioned in `generated-code-review-2026-06-30.md`. Tier:
  **T1** (structural envelope is T0 via the spec; the 400-vs-422 *routing* is
  runtime).

### RS-10 · Rehydration trusts the store — invariants guard transitions only
- **Guarantee.** Reading a persisted row never re-runs the aggregate's
  invariants: reconstituted state was valid when stored, and invariants gate
  *transitions* (`create` + every mutating operation), not loads. Tightening
  an invariant must not make pre-existing rows unreadable — the fix-it path
  (load → repair via an operation) stays open.
- **Trigger.** An aggregate with an invariant; a stored row that predates a
  tightened invariant is read back (`GET`/`findAll`), then repaired.
- **Observable.** The read returns the row (no 500); `create` with the same
  state and a mutator leaving the invariant violated both still fail.
- **Conforms.** node, dotnet, java, python, elixir. node and python construct
  domain objects on load, so their repositories hydrate through the
  non-asserting `_rehydrate` (the asserting `_create` stays the domain-side
  construction path — in-op part builds use it); .NET/Java materialize via
  EF/JPA and elixir loads Ecto structs, which never ran invariants on load.
- **Provenance.** `generated-code-ddd-review-2026-07.md` §S6. Tier: **T0** —
  gated statically per-PR by
  `test/conformance/rehydration-trust-parity.test.ts`.

### RS-11 · A created `versioned` aggregate reads back at version 1
- **Guarantee.** A freshly-created `versioned` aggregate reads back with
  `version` = **1** — the canonical value, fixed by the capability declaration
  `version: int token = 1` (`src/macros/prelude.ts`), mirrored to
  `version INTEGER NOT NULL DEFAULT 1`.
- **Trigger.** A `versioned` aggregate created via `POST`, then read.
- **Observable.** Every backend now reads back `1`. node stamps `version = 1`
  in its versioned save; elixir carries the Ecto `field :version, :integer,
  default: 1`; dotnet/java/python originally seeded `0` — a `token` field is
  dropped from the create body, so the ORM inserted the persistence-layer zero
  and the DB `DEFAULT 1` never fired. The fix seeds the field's `= 1` IR default
  in each domain `create` factory (`constructionSeededDefaults`,
  `src/generator/_frontend/server-default.ts`), which is persistence-agnostic —
  every create path flows through the factory (EF/Dapper/document, JPA
  `@Version` keeps the non-unsaved value, SQLAlchemy inserts `aggregate.version`).
  (A cautionary case: the differential found the *divergence*, but the oracle
  came from the spec — the `= 1` declaration — not the three-backend majority.)
- **Conforms.** node, dotnet, java, python, elixir. (dotnet/java/python fixed +
  runtime round-trip verified — created `versioned` aggregate reads back
  `version: 1` on a real postgres boot.)
- **Provenance.** M-T9.11 differential (run 30277275068, PR #2220);
  `src/macros/prelude.ts` `versioned = 1`. Fixed by M-T6.11. Tier:
  **behavioral**.

### RS-12 · Money wire scale is consistent across backends
- **Guarantee.** A money-typed field serializes at a FIXED scale of **4**
  decimal places on every backend's wire — the canonical `NUMERIC(19,4)` money
  storage scale (`MONEY_WIRE_SCALE`, `src/generator/money-scale.ts`). `12.5`,
  `12.50`, and `12` all read back as `"12.5000"`, `"12.5000"`, `"12.0000"`.
- **Trigger.** A money field on the wire — stored (`subtotal`) OR derived
  (`derived floor: money = money("0.00")` → `"0.0000"`).
- **Observable / decision.** Owner decision (2026-07-27, refined 2026-07-28
  from a live 5-backend probe): **fixed scale 4**, not "preserve the submitted
  scale." The backends could not agree on a value scale — node's decimal.js
  `.toString()` normalizes trailing zeros (`"12.5"`), dotnet/java echoed the
  as-parsed scale (`"12.50"`), python's `NUMERIC(19,4)` quantized stored money
  to `"12.5000"` but a DERIVED money still stringified at its literal scale
  (`"0.00"`) — and node *cannot* echo a submitted scale at all (decimal.js
  normalizes at parse time). A fixed scale is the only representable consistent
  choice, and 4 (the storage scale) is the lossless one. Each backend now
  formats money to 4 dp at the wire boundary: node `.toFixed(4)`, .NET
  `ToString("F4")`, Java `setScale(4, HALF_UP).toPlainString()`, Python
  `quantize(Decimal("1e-4"), ROUND_HALF_UP)`, Elixir `Decimal.round(d, 4)` (the
  `__money_round/1` wire helper). This subsumes the `seqTag` derived-money
  candidate: a money value carries scale 4 in every wire context.
- **Conforms.** node, dotnet, java, python, elixir. (node/python/java/dotnet
  runtime round-trip verified byte-identical on a real postgres boot — stored
  and derived money both read back at 4 dp; elixir verified by emission.)
- **Provenance.** M-T9.11 differential (run 30277275068, PR #2220); owner
  decision. Fixed by M-T6.11. Tier: **behavioral**.

### RS-13 · A create `POST` returns the id envelope, not the whole aggregate
- **Guarantee.** A create `POST /api/<plural>` answers `201` with the id
  envelope `{"id": …}` — nothing else. That envelope is what every backend's
  emitted OpenAPI declares for the create response.
- **Trigger.** Any aggregate created via `POST /api/<plural>`.
- **Observable.** Every backend returns `{"id":…}`. **Elixir used to return the
  FULL aggregate** (`{"id":…,"owner":"alice","balance":0}`), on every create, in
  every shared system — so a client written against the declared create response
  could read fields on Elixir it cannot read on the other four. The OpenAPI
  spec-diff was blind to it by construction: the *specs* agreed — only the bytes
  differed. The majority and the oracle happened to coincide, but the oracle was
  not the vote: Elixir over-returned against **its own published contract**, so
  the emitted spec settled it without appeal to the other four. Confirmed at the
  source — the emitted `Create<Agg>Response` schema declares
  `properties: %{ id: … }` (`openapi-emit.ts`) while the controller's
  `create_result/2` answered `201` with `json(serialize(record))`.
- **Fix.** The three Elixir create actions (`api-emit.ts` ×2 — audited and plain
  — plus `eventsourced-emit.ts`) now answer `%{"id" => record.id}`. The
  string-keyed map matches the serializer's own `"id" => …` entry, so the id's
  wire form is identical on the create and read paths.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found by the M-T9.11 slice-(c) per-PR wire-golden gate on its
  first five-backend run (`test/behavioral/wire-golden/{ledger,payments,sales,
  shapes}.json`); fixed in the same PR, so the waiver is gone and the gate
  enforces the envelope unconditionally. Tier: **behavioral**.

### RS-14 · `version` increments on every persisted mutation, document shapes included
- **Guarantee.** A `versioned` aggregate reads back `version: 2` after one
  post-create mutation — `1` at create (RS-11), `+1` per persisted mutation —
  **regardless of `shape:`**.
- **Trigger.** A `versioned` aggregate with `shape: document` (jsonb-stored):
  create, invoke an operation, read back.
- **Observable.** Every backend now reads back `2`. Historically each of three
  dropped the bump on a **different** shape — document `Cart` / embedded
  `Wishlist` / plain `Order` (canonically 2 / 2 / 3) read back **1 / 2 / 3** on
  dotnet+java and **2 / 1 / 1** on elixir — which is exactly why this survived
  every existing gate: the behavioral tiers assert *locally* (each backend
  passes its own emitted asserts), and no test author thought to assert
  `version` after an operation. The **`dapper` adapter incremented correctly**
  throughout — same .NET emitters, raw Npgsql with hand-rolled document SQL —
  which localized the dotnet/java half to the EF/JPA mapping rather than the
  wire emitters.
- **Fix.** *dotnet* — the document `SaveAsync` resolves the next version FIRST
  and stamps it into the serialized snapshot (`ToSnapshot() with { Version = … }`),
  so `data.version` and the row column can no longer disagree. *java* — the
  document upsert writes the incremented counter back into the blob:
  `jsonb_set(excluded.data, '{version}', to_jsonb(<t>.version + 1))`. *elixir* —
  the relational/embedded operation persist path bumps `version` the way the
  document path already did. (Each is guarded on the `versioned` capability; the
  relational .NET/Java paths needed nothing, since there the bumped column IS
  the wire value.)
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found by the M-T9.11 slice-(c) per-PR wire-golden gate
  (`test/behavioral/wire-golden/shapes.json` seq #3, `GET /api/carts/{id}`);
  fixed in the same PR, so the waiver is gone and the gate enforces it
  unconditionally on all five backends. Note RS-11 covered version at **create**
  only — this is the **increment** path, and it is shape-dependent. Tier:
  **behavioral**.

### RS-15 · A domain-floor rejection is **422**, not 400
- **Guarantee.** A request that parses and typechecks but is rejected by the
  domain — a false `precondition`, a tripped aggregate-level `invariant`, any
  `DomainError`-class throw the wire validator cannot express — answers
  **422 Unprocessable Entity** with an RFC 7807 body titled
  `"Unprocessable Entity"`, on every backend. **400 is reserved for genuinely
  malformed input** (an unparseable body, a missing multipart field).
- **Trigger.** An `operation` with a `precondition` invoked in a state that
  fails it; or an `invariant` that no Zod/DataAnnotations/Pydantic refine can
  mirror, tripped on write.
- **Why 422 and not 400.** RFC 9110 §15.5.21 defines 422 as "the request was
  well-formed but was unable to be followed due to semantic errors" — which is
  exactly the domain floor. §15.5.1's 400 is "the server cannot or will not
  process the request due to something that is perceived to be a client error
  (e.g., malformed request syntax)". A precondition failure is not a syntax
  problem: the payload parsed, every field typechecked, and the server
  understood it completely. Elixir already answered 422 here via a coherent
  denial ladder (`when` → 409, `requires` → 403, `precondition` → 422), and
  that ladder — not the four-backend majority — turned out to be the right
  side. RS-11 is the standing reminder that a majority can be the wrong answer;
  this rule is the second time it paid off.
- **What this does NOT collapse.** 422 is now shared by the wire-validation
  tier and the domain floor, but the two stay distinguishable: a wire-tier
  rejection carries the §3.2 `errors[]` per-field extension, the domain floor
  does not. The status was never the discriminator; the extension is.
- **Known residual divergence — the `detail` wording.** node/dotnet/java/python
  send `"Precondition failed: <the predicate source>"`; elixir's *typed-denial*
  path (`{:error, :precondition_failed}`) sends a generic
  `"A precondition failed"`, because the atom carries no message. (Elixir's
  raise/rescue path already forwards the specific message.) The status, title,
  `type` and `instance` agree on all five; only `detail` differs. Tracked
  separately — the fix threads the predicate source through the denial tuple.
  Until it lands, the golden's error-envelope coverage stays limited to the
  fields that do agree.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Opened by the M-T9.11 wire-golden gate while extending its
  coverage (the four-vs-one status split), decided by the owner in favour of
  the RFC-idiomatic side, and closed in the same change that flipped the four
  runtime mappings + their OpenAPI declarations. Tier: **behavioral**.

### RS-16 · The RFC 7807 `type` member is always present
- **Guarantee.** Every error response carries all five RFC 7807 members —
  `type`, `title`, `status`, `detail`, `instance` — with `type` never omitted.
  Its **value** depends on the kind of error: a **framework** problem (the
  domain floor, wire validation, aggregate-not-found) carries `"about:blank"`;
  a **declared `error` payload** carries its derived `/errors/<kebab-name>` URI
  (`errorTypeUri` in `src/util/error-defaults.ts` — `NotFound` →
  `"/errors/not-found"`). Both forms must be present and identical on all five.
- **Trigger.** Any error response on any backend serving an api: a tripped
  `precondition`, a wire-validation failure, a framework 404, a declared
  `error` variant.
- **Why absence is still a divergence.** RFC 9457 §3.1 says a missing `type` is
  equivalent to `about:blank`, so omitting it is *legal*. It is still a wire
  break: a client reading `body.type` gets a string on four backends and
  `undefined` on the fifth, and any equality check across backends fails.
- **The framework trap.** Java was the outlier for a framework reason, not an
  emitter oversight. `ProblemDetail.forStatus(...)` *does* install
  `about:blank`, but Spring's `ProblemDetailJacksonMixin` annotates `getType()`
  `@JsonInclude(NON_DEFAULT)` — so the default value is dropped during
  serialization and never reaches the wire. No emitted-string assertion could
  have caught this: the generated Java looks correct, and only a booted
  response shows the missing key. The fix writes `type` through `setProperty`,
  which serializes via the mixin's `@JsonAnyGetter`; the still-suppressed
  `getType()` is exactly why that cannot produce a duplicate key.
- **`instance` needed no help.** Spring's message converter fills a null
  `instance` with the request URI on the way out, so it already matched.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found by the M-T9.11 wire-golden gate at
  `test/behavioral/wire-golden/wire-contract.json` seq #7, the first moment any
  golden contained an error body — which RS-15 had just made possible. A rule
  that existed for months and was invisible until the gate's coverage reached
  it. Verified on a real booted Spring app, not an emitted-string assertion.
  Tier: **behavioral**.

### RS-17 · A `when` state-gate rejection names the operation it refused
- **Guarantee.** An `operation … when <pred>` invoked in a state the predicate
  refuses answers **409** with title `"Disallowed"` and the occurrence-specific
  detail `operation '<op>' is not allowed in the current state of <Agg>.` on
  every backend.
- **Trigger.** The 409 rung of the denial ladder.
- **Why the title is the error NAME, not `"Conflict"`.** `errorTitle`
  (`src/util/error-defaults.ts`) derives a 7807 title by humanising the **error
  name**, falling back to the status reason phrase only when there is no named
  error — and `Disallowed` is a blessed stdlib name in `STDLIB_ERROR_STATUS`.
  The *sibling* 409 rungs, `UniquenessConflict` and `ConcurrencyConflict`, are
  the ones correctly titled `"Conflict"`; conflating them is exactly the mistake
  to avoid here (and the one an over-broad `not.toContain('409, "Conflict"')`
  assertion made on the first attempt — it failed four correct backends).
- **Two independent divergences, and the split was not the one first recorded.**
  - **`detail`** — elixir alone sent the fixed sentence
    `Operation not allowed in the current state`, because `:disallowed` was a
    bare atom carrying no message. Same shape and same fix as RS-15: the reason
    is now a `{:disallowed, msg}` tuple built at the **producer**. That is also
    why the event-sourced `command_error/2` clause being *shared* across an
    aggregate's commands never mattered — it only binds the detail. The first
    draft of this rule called that the hard part; it wasn't.
  - **`title`** — elixir **and python** sent `"Conflict"`. The first draft
    recorded a 4-vs-1 split with python on the conforming side; that was
    inferred from python's (correct) *detail* and never checked against its
    title. It is **3-vs-2**. Worth recording: on one small rule, the cheap
    inference was wrong twice.
- **Not fixed here.** Elixir hardcodes the `409` literal where the other four
  resolve it through `resolveErrorStatus("Disallowed", …)`, so an
  `httpStatus Disallowed -> N` override moves four backends and not the fifth.
  That is the ladder-routing gap — mission **M-T5.20**.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-07-30 while extending the M-T9.11 golden set to the
  corpus feature cases — by **reading a freshly-minted golden** (`state-gate`),
  before booting a second backend. No run would have failed: the gate's coverage
  had not reached this case. The finding came from treating a golden as an
  answer key to be reviewed rather than a file to be committed. Tier:
  **behavioral**.

### RS-18 · A provenanced field's lineage rides the wire as `<field>_provenance`
- **Guarantee.** A GET on an aggregate with a `provenanced` field carries the
  lineage under the co-located **snake_case** key `<field>_provenance` (e.g.
  `total_provenance`), never a camelCase `<field>Provenance`.
- **Trigger.** Any read of an aggregate declaring `provenanced` (see
  [`provenance.md`](provenance.md)).
- **The one deliberate non-camelCase key.** Every other wire key is camelCase
  (`unitPrice`, `amountDue`, `createdAt`). This one mirrors its backing jsonb
  column, is the key `provenance.md` documents, and — decisively — is what the
  **scaffolded frontend reads**: the generated React detail page emits
  `data.<field>_provenance` verbatim (`scaffold/_body-builders.ts`).
- **Why it mattered.** Java emitted `totalProvenance` — its DTO record
  component name went straight onto the wire. A 4-vs-1 split in which, unusually,
  the **majority was right**. And the consequence was not cosmetic: the camelCase
  key **silently blanked the provenance "?" disclosure** on every generated UI
  pointed at a Java backend. No error anywhere — the frontend simply reads a key
  the backend never sends. This is the failure mode the differential exists for:
  both halves compile, both look correct in isolation, and only comparing the
  actual bytes reveals it.
- **The fix.** `@JsonProperty("<field>_provenance")` on the record component, so
  Java keeps an idiomatic component name and the wire key matches. Verified on a
  **real booted Spring app**, not an emitted-string assertion — the entire
  failure mode is a name that *looks* right in the source.
- **Warning for future sweeps.** A "normalise the wire to camelCase" change must
  treat this key as a deliberate exception, or it will re-break the frontend.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-07-30 by **reading** the freshly-minted
  `provenance` golden during the M-T9.11 coverage expansion — one key out of
  camelCase in an otherwise camelCase body. Confirmed by generating all five
  backends and diffing the emitted key. Tier: **behavioral**.

---

## Adding a rule

When a cross-backend runtime bug is fixed:

1. Add an `RS-N` entry to `test/conformance/semantics-rules.ts` (id, title,
   `.ddd` trigger sketch, conforming backends, provenance PR, lowest gating
   tier).
2. Add the human clause here, mirroring the registry.
3. If the rule is **T0-gateable**, add the static assertion in
   `test/conformance/`. If **T1/T2**, add the round-trip to
   `test/behavioral/corpus.json` (and, once `A6.2` lands, it gates the Nth
   backend too).
4. `semantics-rules.test.ts` fails until the registry entry is well-formed and
   its `backends` are a subset of the five — so a rule can't be added as prose
   only.
5. Regenerate the committed spec mirror:
   `UPDATE_SEMANTICS_SPEC=1 npx vitest run test/conformance/semantics-spec-sync.test.ts`
   and commit `test/conformance/semantics-spec.json` — `semantics-spec-sync.test.ts`
   gates the drift.

## Roadmap

> **Claimable follow-up tickets** (parallel-agent-ready — RS-9 gating, more
> backends, the diffable spec artifact, corpus breadth) are enumerated in
> [`plans/runtime-semantics-tier-followups.md`](old/plans/runtime-semantics-tier-followups.md).

- **v1 (this doc):** the registry + well-formedness gate + the T0-tier rules
  gated statically across all five backends — **RS-2** (`enum-casing-parity`),
  **RS-3** (`wire-no-leak-parity`), and **RS-5** (the pre-existing
  `union-find-absence-parity`). *(here)* Every rule assertable from emitted
  source is now gated per-PR; the remainder (RS-1/4/6/7/8/9) are behavioral and
  wait on A6.2.
- **A6.2 (Python api tier LANDED):** `run-python.mjs` + `behavioral-e2e-python.yml`
  boot the generated FastAPI backend on a `services: postgres` sidecar and
  HTTP-dispatch the emitted api e2e — the T2 column is now per-PR for
  **RS-1/4/6/7/8** on Python. On day one it surfaced a real codegen bug (a
  cross-aggregate operation-param id type — `ProductId` — omitted from the
  emitted FastAPI route imports); **that fix has landed** (the route import
  collector now draws candidates from every context aggregate), and the
  association round-trip (RS-8) is back in the fixture. Next: a second backend
  (.NET/Java) on the same seam, then the unit tier.
- **v2 (diffable spec artifact — LANDED):** the registry is mirrored to a
  committed, diffable JSON spec at
  [`test/conformance/semantics-spec.json`](../test/conformance/semantics-spec.json)
  (the `wire-spec.json` / `langium-generated` "derived file + CI drift gate"
  precedent) so a contract change surfaces as a reviewable JSON diff. The
  registry is a **global toolchain contract**, not a per-generated-system fact,
  so the mirror lives here — it is **not** emitted into each system's `.loom/`
  bundle. The JSON is derived by `serializeSemanticsSpec()` in
  `semantics-rules.ts` and pinned by `semantics-spec-sync.test.ts`; regenerate
  after editing the registry with
  `UPDATE_SEMANTICS_SPEC=1 npx vitest run test/conformance/semantics-spec-sync.test.ts`
  and commit the result. Still open: wire each RS-rule to a live round-trip
  assertion in the harness.
