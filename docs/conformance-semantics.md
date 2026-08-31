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
  The guarantee covers the faults the **framework** raises too — an unknown
  path, a verb a path does not serve, an unreadable body. Those never reach an
  emitted arm, which is exactly why they drifted: measured on booted backends,
  `PUT` against a POST-only route answered `404 text/plain` (node), `405
  application/json` (python), `405` with *no body* (dotnet), `500
  problem+json` (java) and `404 application/json` (elixir) — five shapes,
  three statuses, and one backend calling a client's typo a server fault.
  Each backend now routes framework faults through the same responder its
  domain arms use.
- **Trigger.** A create violating an invariant, a create with a malformed body,
  and a request the framework refuses before any handler runs.
- **Observable.** Same status + same problem-body shape (`type: about:blank`,
  `application/problem+json`) on every backend, whichever layer refused.
- **Conforms.** node, dotnet, java, python, elixir.
- **A wrong verb is `405` everywhere, with `Allow`.** This was briefly recorded
  here as a known divergence — node and elixir answering `404` because "hono and
  phoenix route on (method, path) as one key, with no method-not-allowed concept
  to hook". That premise was wrong. Both routers expose the lookup:
  `app.router.match(method, path)` on hono, `Phoenix.Router.route_info/4` on
  phoenix. Neither was unable to tell a method mismatch from a missing path;
  neither was asked. Both now probe the other verbs on a miss and answer `405`
  with an `Allow` header, which is the machine-readable half of RFC 9110
  §15.5.6 — a caller learns to fix the verb rather than the URL.
- **Provenance.** #1620 (hardened changeset-error renderer), the two-tier
  400/422 model dispositioned in `generated-code-review-2026-06-30.md`. Tier:
  **T1** (structural envelope is T0 via the spec; the 400-vs-422 *routing* is
  runtime). The framework half is gated per-PR twice over:
  `test/conformance/framework-error-contract-parity.test.ts` pins the SEAM each
  backend installs, and the M-T9.11 wire golden now carries three
  **framework-fault probes** per case — a wrong verb, an unknown path, an
  unreadable body — issued through each runner's dispatch chokepoint, so the
  RESPONSE is compared byte-for-byte on five booted backends. The static gate
  existed because the emitted suites only request what the API serves; the
  probes remove that limitation rather than work around it.

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
  every create path flows through the factory (EF/Dapper/document, JPA, SQLAlchemy
  `aggregate.version`). Java's `version` was mapped `@Version` at the time, which
  keeps the factory's non-unsaved value; RS-20 later made it a plain column driven
  by an explicit guarded bump, and a create — matching no row — still carries the
  factory's `1`.
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
- **Trigger.** A money field on the wire — stored (`subtotal`), derived
  (`derived floor: money = money("0.00")` → `"0.0000"`), OR **aggregated**
  (a query-time projection's `sum`/`max`/`min` over a money column, and the
  zero it reads over an empty table → `"0.0000"`, not `"0"`).
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
- **Later gap (#2549).** "Every wire context" did not hold on the PROJECTION
  path: a projection's SQL aggregate was serialized as it came back, so money
  echoed the scale its rows were STORED at (`"40.00"`) — while the same
  declared field read through its aggregate's own route sent `"40.0000"`. It
  reached elixir, java AND .NET; node and python passed only incidentally,
  because each writes money at 4dp and so read its own scale back. The
  empty-table zero was a bare `"0"` on all five, oracle included. Each backend
  now formats a money aggregate through the same renderer listed above; pinned
  at runtime by the `projection-aggregation` / `projection-groupby` wire
  goldens and structurally by
  `test/generator/projection-aggregate-money-scale.test.ts`.

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
- **A fourth shape, found later: INHERITED aggregates on java.** The rule is
  also `inheritanceUsing:`-dependent, and java failed it for every subtype of an
  abstract aggregate — `version` froze at the create factory's `1` and never
  moved (`payments` credit card / bank account, `tph` car / truck: canonically
  `2`, java `1`). One cause, and it is not Hibernate semantics this time
  (unlike RS-20): the `version` token field is declared once, on the **base**,
  and the concrete-entity emitter skips inherited fields — so the counter's
  mapping had to be emitted by `renderAbstractBase`, which had no such arm. At
  the time that mapping was `@Version`; `renderEntity`'s arm even carried the
  comment *"a TPH/TPC base carries it once"*, an intent the base builder never
  implemented, so it was emitted **nowhere** and the column was a plain
  `@Column`. Beyond the wire value this left the whole hierarchy's
  optimistic-concurrency guard **inert** — no `WHERE version = ?` CAS, so a lost
  update between two writers was silent. **Fixed** (java `emit/entity.ts`);
  gated structurally for TPH *and* TPC, with the negative that the concrete must
  not redeclare it (`generator-java-concurrency-conflict.test.ts`), and
  re-verified by booting `payments` / `tph` / `inheritance` against Postgres in
  `gradle:9-jdk25`. (RS-20 later removed `@Version` from java altogether — the
  base now carries the plain column plus the `_applyVersion` mutator the
  repository's guarded bump writes through, and the same structural gate covers
  it.)
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found by the M-T9.11 slice-(c) per-PR wire-golden gate
  (`test/behavioral/wire-golden/shapes.json` seq #3, `GET /api/carts/{id}`);
  fixed in the same PR, so the waiver is gone and the gate enforces it
  unconditionally on all five backends. Note RS-11 covered version at **create**
  only — this is the **increment** path, and it is shape-dependent. The
  inherited-shape half above was found by the caller census's `update` drain
  (#2438) — the first callers ever put on `POST /api/<aggs>/{id}/update`, which
  is the only route that mutates a `crudish` aggregate without a domain
  operation, and therefore the only one that reaches an inherited aggregate
  whose subtypes declare no operations at all. Tier: **behavioral**.

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
  camelCase in an otherwise camelCase body. Fixed on java, then **the rule was
  briefly recorded as all-five conforming — and it was 3-of-5.** The check that
  cleared dotnet grepped *generated text* for `total_provenance` and matched the
  **EF column mapping**, not the wire DTO; only booting dotnet (2026-07-31)
  showed it sending `totalProvenance` too. A generated-source grep is not a wire
  observation — that is the standing lesson, and it is why the loop's boot step
  is not optional.

  **The same grep misled twice.** Elixir stayed in `conforms` on that same
  evidence until its first real boot (2026-08-01), which showed vanilla omitting
  the key **entirely** — its REST serializer projects `wireShape`, and the
  provenance sidecar is not a `wireShape` member on *any* backend (node appends
  it separately, after the shape). So the rule was 3-of-5 twice over, cleared
  twice by the same non-observation. Fixed by appending the sidecar in
  `wire-serialize.ts` exactly as node does. Tier: **behavioral**.

### RS-19 · A declared `error` variant's fields ride the problem body
- **Guarantee.** An operation returning `T or <Error>` that selects the error
  variant answers with the RFC 7807 envelope **plus the payload's declared
  fields** as extension members: `error NotFound { resource: string }` puts
  `"resource": "OR1"` alongside `type`/`title`/`status`/`detail`.
- **Trigger.** `operation reject(): string or NotFound { return NotFound { resource: code } }`
  — see [`payloads.md`](payloads.md).
- **Why it hid.** Java emitted the arm's status, title, type and detail and then
  dropped the payload entirely, so a client got a 404 with the right *shape* and
  **no data**. A `toThrow(404)` assertion passes on all five backends — the
  status is right; only the body differs. The emitted OpenAPI for the union
  already declared the fields, so this was a spec violation too.
- **A near miss worth noting.** Java's *sibling* arm — the find-absence 404 —
  already set `resource`. The two arms were written independently, which is why
  `union-find-absence` passed while `operation-returns` failed on the same
  release.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-07-30 by the M-T9.11 gate on the newly-minted
  `operation-returns` golden (java leg). Fixed in java by projecting the arm's
  declared fields through `setProperty`. **dotnet had the same bug** — its arm
  discarded the variant entirely (`case <Union>_<Tag> _:`), so it could project
  nothing — and that only surfaced when the dotnet leg was actually run
  (2026-07-31), after the rule had already been recorded as all-five conforming.
  Both verified on booted apps. Tier: **behavioral**.

### RS-20 · `version` counts persisted mutations, not entity-graph dirtiness
- **Guarantee.** `version` is `1` at create and `+1` per persisted mutation,
  **independent of which part of the aggregate graph changed** (RS-11 + RS-14)
  **and of whether any column value actually differs**. A command that ran and
  was persisted bumps the counter; that is what "optimistic concurrency token"
  means here.
- **Trigger.** A `versioned` aggregate whose mutation touches only a **child**
  (a single `contains`), whose create also writes a **value-object collection**,
  or whose command re-assigns a value the row already holds.
- **Observable — java diverged in every direction, from one cause.**

  | case | canonical | java (before) |
  |---|---|---|
  | `single-containment` — `ship` mutates the contained child | `2` | **`1`** (bump missed) |
  | `value-collections` — create writes a VO collection | `1` | **`2`** (extra bump) |
  | `saga` — an idempotent `markTracked()` re-assign | `3` | **`2`** (bump missed) |

  Java mapped `version` to JPA `@Version`, and Hibernate bumps that from the
  dirtiness of the **root entity's own state**. A change confined to a child or
  collection doesn't mark the root dirty; neither does re-assigning an unchanged
  value; a second flush that writes the collection during create does. The other
  four backends set the counter explicitly at the persist site, so they count
  *commands* the way the capability declares.
- **Relationship to RS-14.** This is RS-14's family — "the increment is
  shape-dependent and inverted between backends" — in shapes RS-14's fixture set
  never reached. RS-14 lists java as conforming; that holds for the shapes it
  measured (document/embedded) and not for these. This rule names the gap rather
  than rewriting RS-14's history.
- **Fix (java).** `@Version` is gone from both entity arms (flat and the TPH/TPC
  abstract base) — `version` is a plain `@Column` — and the counter is driven
  from the repository `save`, the same place node and elixir drive theirs:

  ```java
  @Modifying(flushAutomatically = true, clearAutomatically = false)
  @Query("update Order e set e.version = e.version + 1 where e.id = :id and e.version = :expected")
  int bumpVersion(@Param("id") OrderId id, @Param("expected") int expected);
  ```
  ```java
  var __expectedVersion = aggregate.version();
  if (jpa.bumpVersion(aggregate.id(), __expectedVersion) == 1) {
      aggregate._applyVersion(__expectedVersion + 1);   // reflect it onto the live instance
  } else if (jpa.existsById(aggregate.id())) {
      throw new ObjectOptimisticLockingFailureException(Order.class, aggregate.id().value());
  }
  var saved = jpa.save(aggregate);
  ```

  One row affected == this command bumped, whatever it touched. **Zero** rows on
  a row that exists == another writer moved it inside the load→save window —
  the same `ObjectOptimisticLockingFailureException` the `If-Match` guard raises,
  so the 409 semantics are unchanged (the write-time CAS is now this guard rather
  than Hibernate's). Zero rows with no such row == a **create**: the factory
  already seeded `1` and the insert carries it. The five RS-20 waivers were
  deleted in the same change.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-07-30 by the M-T9.11 gate on the newly-minted
  `single-containment` and `value-collections` goldens; the idempotent-command
  face surfaced later on `saga`. Fixed in java by the command-driven guarded
  bump above. Tier: **behavioral**.

### RS-21 · A union response carries its `type` discriminator
- **Guarantee.** An operation returning `T or <Error>` that selects a **success**
  variant answers 200 with the tagged form — `{"type":"string","value":"OR1"}` —
  using the discriminator named by `_payload/union-wire.ts`, the single source of
  truth for the tagged-wire shape. A typed client narrows on `type`; without it
  the union is unreadable.
- **Trigger.** `operation accept(): string or NotFound`.
- **Why it hid.** dotnet's DTO carried the right attribute the whole time —
  `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]`. But
  System.Text.Json only **writes** the discriminator when it serializes through
  the **base** type, and `Ok(object)` leaves `ObjectResult.DeclaredType` null, so
  STJ used the runtime type and the tag vanished. The `(Union)` cast in the
  emitted source does not survive the boxing. **The code reads correct and the
  wire is not** — no static gate can see this; only a booted round-trip can.
- **Fix.** An explicit `ObjectResult { DeclaredType = typeof(<Union>) }`.
- **Then elixir broke the same rule, for the opposite reason.** One leg later
  (2026-08-01) the vanilla Phoenix backend shipped a bare `"OR1"`. The pairing is
  the interesting part: the *same* guarantee failed once because a framework
  silently declined to write the tag and once because the emitter never produced
  it. Vanilla carries a returning op's outcome as a **tuple** —
  `{:ok, value} | {:error, tag, data}` — and only the *error* arm ever put its
  tag in the tuple; the controller `json/2`s the success value straight through,
  so there was no later seam that *could* have added it. Fixed at the producer,
  from the `variantTag` / `variantShape` the IR already carries on the `return`
  statement (the same two fields the TS backend reads).
- **Two shapes remain unimplemented everywhere.** The **aggregate** success
  variant — `operation adjust(): Item or NotFound` falling through, or ending in
  `return this` — has **no conforming oracle**. Node's emitted domain method for
  the fall-through has no `return` at all (the route `c.json`s `undefined`), and
  its `return this` renders `{ type, ...this }`, which spreads the domain
  class's *private* `_`-prefixed fields. Vanilla is deliberately left untagged
  there rather than guessing at a contract no shipped backend implements. The
  `Conforms` line below is therefore scoped to the shapes that have an oracle:
  scalar, record literal, and `none`.
- **Conforms.** node, dotnet, java, python, elixir — for the scalar / record /
  `none` variants. The aggregate variant is an open gap on all five.
- **Provenance.** Found 2026-07-31 by the M-T9.11 gate on `operation-returns`
  (dotnet leg); violated again 2026-08-01 on the elixir leg's first real boot.
  Tier: **behavioral**.

### RS-22 · The RFC 7807 envelope is exactly five members plus declared extensions
- **Guarantee.** An error body carries `type`, `title`, `status`, `detail` and
  `instance` (the request path) — and **nothing a framework adds on its own**.
  `instance` is never null; no `traceId`/correlation member rides the body,
  because trace correlation is deliberately an **`x-request-id` header** so the
  envelope stays byte-identical across backends. Only a declared error payload's
  own fields (RS-19) may extend it.
- **Trigger.** Any error response — framework problem or declared `error`.
- **Why it hid.** dotnet diverged **both ways at once** — `instance` null *and*
  an extra `traceId` — because those arms called `ControllerBase.Problem(...)`,
  which routes through `ProblemDetailsFactory`: the factory fills neither
  `instance` nor the content type, and injects `traceId` off the ambient
  Activity. The app's *own* exception filter already hand-built the envelope for
  exactly this reason; the union arms and the find-absence arm were simply the
  sites nobody had converted.
- **Why it is a rule and not just a fix note.** "The framework helper adds a
  member nobody else sends" is invisible to every static gate — the emitted
  source names none of it. This is the same class as RS-16 (java) and RS-21
  (dotnet): a wire shape decided by a framework rather than by the emitter.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-07-31 by the M-T9.11 gate on `operation-returns`
  and `union-find-absence` (dotnet leg). Tier: **behavioral**.

### RS-23 · An absent collection is `[]` on every **persistence adapter**
- **Guarantee.** An optional collection (`surcharges: Money[]?`) that was never
  written reads back as `[]` — on **every** `persistence:` adapter, not just the
  default one.
- **Trigger.** The same `.ddd`, the same backend, a different `persistence:`
  clause: `dapper` (.NET) or `mikroorm` (node).
- **Why RS-8 wasn't enough.** RS-8 already says a collection is `[]`, never
  null — but it was only ever *proven* on the default adapters, and they get it
  right **by accident of storage topology**: EF Core maps the collection to an
  `OwnsMany` child table and Drizzle to a join, and an empty child set
  materializes as an empty list. Both alternative adapters store it as **one
  nullable jsonb column** and faithfully round-trip SQL NULL. Two adapters, one
  class:
  - **dapper** — the row→domain hydrate emitted `is null ? (List<T>?)null`.
  - **mikroorm** — the shared `deserializeField` optional arm short-circuited on
    null *before* the array arm's `?? []` could apply.

  Fixed on the **read** in both, not the write, so rows already stored as NULL
  are repaired rather than only newly-written ones.
- **The generalisable lesson.** A persistence adapter is a **wire-visible**
  choice, not an internal one. Any rule proven only on the default adapter is
  proven on exactly one storage topology — which is why the `dapper` and
  `mikroorm` legs carry the goldens too, and why "the backend is correct" is not
  the same claim as "every adapter of that backend is correct".
- **Conforms.** node, dotnet, java, python, elixir (all adapters).
- **Provenance.** Found 2026-07-31 by the M-T9.11 gate once the expanded golden
  set reached the dapper + mikroorm legs. Tier: **behavioral**.

### RS-24 · A plain `decimal` is a JSON **number**; only `money` is a string
- **Guarantee.** A `decimal` field serializes as a JSON number (`9.99`, `5`) —
  and as the **same** number every other backend sends: the wire width is an
  IEEE-754 double (≤17 significant digits), whatever the backend computes in.
  This is the deliberate counterpart to [RS-12](#rs-12--money-wire-scale-is-consistent-across-backends),
  where `money` is a fixed-scale **string** (`"19.5000"`) so no float rounding can
  touch a monetary amount. The two types differ on the wire, and a backend must
  not collapse them into one.
- **Trigger.** Any GET returning an aggregate — or a nested value object — with
  a `decimal` field.
- **Why it hid.** Nothing in the vanilla emitter ever *chose* a string. Jason's
  `Decimal` encoder emits a JSON string, so every `%Decimal{}` that reached the
  serializer un-transformed shipped quoted. That is exactly right for money
  (RS-12 wants the string, and `__money_round/1` leaves the value a `Decimal`)
  and exactly wrong for a plain decimal. **The same accident produced the correct
  answer for one type and the wrong one for the other** — which is why reading
  the emitter, where both types look equally untouched, would never have found
  it. It was root-caused by running `Jason.encode!/1` against the real library.
- **The fix.** A `__decimal_num/1` helper (`Decimal.to_float/1`) applied to
  plain-decimal wire entries — property, *derived*, and `decimal[]` element
  alike. `to_float` reproduces the **oracle** exactly rather than merely
  narrowing the gap: node's value is a float64 to begin with.
- **The narrowing half.** "A JSON number" was never the whole rule — it is the
  *same* number. A backend whose domain type is wider than a double has to
  narrow at the **wire boundary**, response direction only:
  - **.NET** (#2563 / #2575): a response `decimal` is a `double`. `System.Decimal`
    carries ~15 significant digits, so a non-terminating `avg` shipped
    `2.33333333333333` where the oracle shipped `2.3333333333333335`.
  - **Java** (M-T6.46, amending this rule): the domain type is `BigDecimal` and a
    `derived` division renders through `MathContext.DECIMAL128`, so an
    un-narrowed response shipped up to **34** significant digits. Java's
    conformance here was **partial** until then — the wire *was* a JSON number,
    but only the projection `avg` arm was double-parity, and only by the
    provider's accident of typing an average as a `Double`; sums, per-row and
    derived reads all shipped exact digits.
  - The **request** direction deliberately stays on the wide type in both:
    a `double` request field turns an out-of-range **400** into a conversion
    **500**. A client may send more precision than it reads back.
- **Why the differential could not see the java half.** The wire-golden
  comparator JSON-parses both bodies before diffing (`test/_helpers/wire-record.ts`),
  which collapses every JSON number to a JS double. *Deficient* precision changes
  the parsed double and fails; **excess** precision parses to the identical double
  and can never fail. `WIRE_WAIVERS` is empty, and no golden moved when java was
  fixed. See the audit's F16 → **M-T9.37**.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-08-01 by the M-T9.11 gate on the elixir leg
  (`value-collections` `$.lineItems[*].amount`); extended to .NET by #2563/#2575;
  amended 2026-08-24 for java by the numeric-types audit
  ([F9](audits/numeric-types-audit-2026-08-23.md), register #2644) → M-T6.46.
  Tier: **behavioral** (the java half is pinned statically by
  `test/generator/java/java-decimal-wire.test.ts`, since the behavioral gate is
  blind to it).

### RS-25 · `internal` / `secret` fields never reach the read wire
- **Guarantee.** A field declared `internal` (domain-only state) or `secret`
  (never disclosed) is **absent from the response body** — not null, absent.
  `forApiRead` is the read-boundary projection over `wireShape`, and every read
  surface applies it.
- **Trigger.** A GET on an aggregate carrying an `internal` field — for example
  the `tenantId` / `dataKey` that the `tenantOwned` capability injects
  ([`tenancy.md`](tenancy.md)).
- **Why it mattered.** The vanilla REST serializer projected the **raw**
  `wireShape` and never applied `forApiRead`, so a multi-tenant aggregate shipped
  its tenant key to every client on every GET, and a `secret` field would have
  leaked the same way.
- **Why it is more than a stray field.** The *same backend's* OpenAPI emitter
  **did** apply `forApiRead` — so the served spec promised a body the running
  server did not send. Spec and runtime disagreed **inside one deployable**, and
  a spec-diff gate compares specs: it can only ever see the half that was
  already right. That gap is the premise of this whole tier.
- **The fix.** `forApiRead` at both vanilla read boundaries — the REST
  serializer and the returning-op success body. Deliberately **not** applied to
  `eventsourced-emit.ts`'s `structFields`, which names the *in-memory struct's*
  fields: the domain needs its internal state.
- **Relation to [RS-3](#rs-3--no-persistence-internal-columns-leak-to-the-wire).**
  RS-3 is about *framework* bookkeeping leaking (`inserted_at`, soft-delete
  flags). This one is about *declared* fields whose access modifier says they
  stay behind the boundary. Same symptom, different mechanism — and RS-3's
  "the response key-set equals `wireShape`" should be read as
  `forApiRead(wireShape)`.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-08-01 by the M-T9.11 gate on the elixir leg
  (`tenancy-owned` `$.tenantId`). Tier: **behavioral**.

### RS-26 · An omitted UPDATE field is a client error, never a silent default
- **Guarantee.** A field omitted from a full-replacement `PUT` is **rejected** as
  missing required input. It is not silently set to a zero value, and the create
  default is **not** re-applied.
- **Trigger.** `active: bool = true`; a PUT body omitting `active`.
- **Observable.** `PUT` without `"active"` is rejected — it does **not** store
  `active=false`.
- **Relation to [RS-6](#rs-6--boolean-create-defaults-materialize-at-the-wire-boundary).**
  The exact inverse, and the half that eats data. RS-6 says an omitted *create*
  bool materializes its declared default. A default is a **construction** rule,
  so on update — where nothing is constructed — "absent" cannot mean "the
  default"; it can only mean a required field is missing.
- **Why it mattered.** The emitted `UpdateItemRequest` carried
  `active: z.coerce.boolean().default(false)` against a model declaring
  `active: bool = true`. A PUT omitting `active` flipped a stored `true` to
  `false` — not even the declared default, because the value came from a
  hardcoded implicit-bool rule rather than the model. The rule was a
  **create-input** rule (`hasImplicitDefault`) that leaked into every request
  body through one shared helper, so it hit every operation's bool parameter,
  not just `update`.
- **Prior art.** This is the proto3 lesson: a wire-level default makes "absent"
  indistinguishable from "the default value", which breaks partial and
  full-replacement updates alike. proto3 dropped custom field defaults for
  exactly this reason and had to re-add explicit field presence in 3.15.
- **The split.** 1-vs-4 with the **minority correct** — the inverse of RS-15's
  shape. Node's `.default(false)` was added deliberately to match .NET
  model-binding and Phoenix, so four backends agreed and the agreement was
  wrong.
- **Conforms.** node, dotnet, java, python, elixir — and **no two backends
  needed the same fix**, which is the case for numbering the rule rather than
  patching one emitter: node scoped `zodFor` to a `create-body` context; python
  gave `requestFieldDecl` a slot; elixir's runtime *already* conformed and only
  its **spec** disagreed (`@update_required` listed every bool while the
  OpenApiSpex schema did not — RS-25's divergence inverted); java had **both**
  halves wrong (primitive record components let Jackson supply `0`/`false` for
  an omitted key while `RequiredSet` claimed the field required) and needed
  boxing + `@NotNull`; and .NET could not express it with `[Required]` at all —
  that attribute tests for **null**, and an omitted value type binds to
  `0`/`false`, so presence had to become a *deserialization* question via
  `[property: JsonRequired]`.
- **The coercion is a default.** The node fix took two rounds, and the second is
  the reusable lesson: `.default(false)` was only the *visible* half.
  `z.coerce.boolean()` is `Boolean(input)` and `Boolean(undefined) === false`,
  so the coercion **is** a wire default — removing the `.default(` changed
  nothing. The first version of the static gate keyed on the *absence* of
  `.default(`, so it passed a backend that still had the bug; the divergence
  surfaced only in the 5-way OpenAPI parity run, because `zod-to-openapi`
  derives `required[]` from `schema.isOptional()` — literally "does it accept
  `undefined`". Body bools are now uncoerced `z.boolean()` (JSON carries real
  booleans; only query params, which are strings, keep the coercion), and the
  gate asks the behavioural question instead of the spelling one.
- **A gate can read the wrong artifact.** The Elixir regression later the same
  day is the twin lesson. `isRequiredUpdateInput` tested the implicit-`bool`
  rule and never reached the explicit default, so `active: bool = true` came
  back omittable and `@update_required` stopped listing it — while the
  OpenApiSpex schema still advertised the field as required. Elixir **promised
  what it did not enforce.** The gate missed it because its Elixir arm read
  `update_item_request.ex` (the schema, which *documents*) and not
  `item_changeset.ex` (`validate_required/2`, which *enforces*). Where a backend
  splits "what the server says" from "what the server checks" across two files,
  a conformance gate owes an assertion to each; otherwise it certifies the
  promise, not the behaviour. The predicate is now `!isNullable(f)` — a default
  of **either** kind is a construction rule, so neither relaxes a
  full-replacement update — and the fixture gained a bare `flag: bool`, the case
  that separates the create seam from the update seam.
- **Provenance.** Found 2026-08-01 reconciling where `= default` belongs (domain
  vs wire boundary); node fixed by scoping the implicit-bool rule to a
  `create-body` context in `routes-builder.ts`, then by uncoercing body bools.
  Tier: **static** — `create-input-default-parity.test.ts` asserts the rule on
  all five, and keeps an empty `UPDATE_BOOL_WAIVED` map as the ratchet so a
  regression is recorded rather than the assertion relaxed.
### RS-28 · An unrecognised error term is a sanitized **500**, never a 400 that echoes it
- **Guarantee.** A fault that matches no declared `error` variant, no
  wire-validation failure and no denial rung answers **500 "Internal Server
  Error"** with `detail` = the fixed string `"internal"`. Two claims, both
  wire-visible:
  - **Status.** An error the server did not model is a *server* fault. 4xx tells
    the caller to fix a request that was never the problem.
  - **Detail.** The term is **never** rendered into the body. A serialized
    internal value leaks struct names, module paths, and sometimes the failing
    value itself, to an unauthenticated caller.
- **Modelled faults are unaffected.** A declared `error` payload, a
  wire-validation failure, and each denial rung (403 / 409 / 422) keep their own
  status and their occurrence-specific `detail`. This rule governs only the arm
  none of them matched.
- **Trigger.** A hand-written `extern` handler returning an unmodelled error, an
  unexpected fault escaping a workflow's `run`, or — the case both of those
  presuppose away — **a fault raised anywhere else in the app**, on a system that
  declares neither. That last one is the reason each backend needs an
  APP-GLOBAL handler and not only per-route arms: `app.onError` (hono),
  `DomainExceptionFilter` (.NET), `ApiExceptionAdvice` (java),
  `install_error_handlers` (python), `<App>Web.FaultHandler` (elixir). A rule
  checked only on the paths a fixture reaches is checked on the paths that were
  already fine — see M-T6.30, where elixir's arm existed solely inside the
  workflow/extern `respond/2` dispatchers, so the most common system shape
  (CRUD, no workflow) emitted none at all and answered an HTML debug page in dev
  and the exception's own message as `detail` in prod.
- **Why it hid.** Elixir answered `400` and `inspect/1`'d the term straight into
  `detail`. It survived RS-15's 400 → 422 sweep *precisely because it is not the
  domain floor*: RS-15 moved the rejections the domain **makes**, and this is the
  rejection **nobody made**. And no system in the shared behavioural corpus
  reaches this arm — every error those fixtures produce is modelled — so all five
  M-T9.11 legs were green with the divergence in place. An arm no fixture reaches
  is exactly the arm that needs a *name*.
- **A second, smaller divergence on the same arm — and how it was found.** The
  fix's own report proposed this rule as all-five-conforming. That list was
  **inferred**. Checking it showed node/.NET/java emit the literal `"internal"`
  while **python** emits `"An unexpected error occurred."`. Python has no *leak*
  — its string is fixed and reflects nothing — so it isn't the defect the rule
  was minted for; it simply isn't byte-identical, and byte-identity is the entire
  premise of the M-T9.11 golden. Listed as a **target** until python moves.
- **The habit this rule family keeps failing at.** This is the **third** time an
  all-five `conforms` was asserted from reading rather than checking (RS-18
  twice, RS-19 once). Enumerate the other backends' emitted literal *before*
  writing the list, every time.
- **Conforms.** node, dotnet, java, elixir. **Targets:** python.
- **Provenance.** Found 2026-07-29 by grepping the vanilla Phoenix denial
  protocol's edges after #2300 centralised it (M-T6.24). Python divergence found
  2026-08-01 by verifying the proposed `conforms` list instead of accepting it.
  The third trigger above (and elixir's floor for it) landed 2026-08-23 with
  M-T6.30, gated per-file on a plain-CRUD fixture in
  `test/conformance/internal-fault-parity.test.ts` and witnessed on a booted
  Phoenix app. Tier: **static** — promote to behavioral once a fixture reaches
  the arm.

### RS-27 · A 404-**by-id** carries the sentence `"<Aggregate> <id> not found"`
- **Guarantee.** When a read addressed **by id** finds nothing, the RFC 9457
  body's `detail` is the sentence `"<Aggregate> <id> not found"` — the
  aggregate's PascalCase name, the requested id, the words "not found" — on
  every backend. Not a machine token, not a framework default.
- **Trigger.** `GET /api/<aggs>/{id}`, or `GET /api/<aggs>/{id}/history`, for an
  id that does not exist.
- **Scope.** *By id.* The 404 an **optional find** answers
  (`find byCode(...): Order option` with no match) is a different class and
  keeps the `"not_found"` token — node and python already agree there, and the
  rule deliberately does not touch its `detail`.
  > **Correction (2026-08-05).** "node and python already agree there" was read,
  > at the time, as *everyone* agreeing there — and no test drove that path, so
  > nothing checked. The caller census drain wrote the first callers for an
  > `option` find (`corpus/union-find-absence`'s `maybeFirst`) and an optional
  > find (`corpus/inheritance`'s `byEmail`), and **java answered an EMPTY body**
  > on both: `ResponseEntity.notFound().build()`, Spring's own bare 404, which
  > never reaches the `@RestControllerAdvice`. That is not an RS-27 `detail`
  > question — it is a straight [RS-22](#rs-22--the-rfc-7807-envelope-is-exactly-five-members-plus-declared-extensions)
  > violation (no envelope at all), and it is *this rule's own lesson* — "don't
  > hand-roll a 404" — at two arms nobody had converted, in the very controller
  > whose `error`-variant branch built a real ProblemDetail three lines away.
  > Fixed by throwing `AggregateNotFoundException("not_found")` so both arms land
  > in the shared producer (`emit/common.ts` → `JAVA_FIND_ABSENCE_THROW`);
  > `generator-java-api.test.ts` pins it, mutation-proven, with a list-find
  > scope guard. The `detail` token itself is unchanged and still out of scope.
  >
  > **And the same again on .NET, hours later (2026-08-05).** The dapper
  > behavioural leg then reported **28 wire divergences, all one bug**: both
  > .NET find-absence arms `return NotFound();` — ASP.NET's own bare 404, which
  > never reaches `DomainExceptionFilter` and is rendered by
  > `ProblemDetailsFactory` instead. Four wrong members at once, on every
  > declared-find miss across five cases (`by_sku`, `by_reference` ×2,
  > `by_code`, `by_email`, `maybe_first`): `type` = the rfc9110 §15.5.5 URI
  > rather than `about:blank`, `detail` = null rather than the token,
  > `instance` = null rather than the request path, plus an injected `traceId`.
  > RS-22 names that factory behaviour *exactly* and still listed dotnet as
  > conforming — because the arms nobody had converted were the arms nobody had
  > CALLED. The controller emitter is **shared** between the EF and Dapper
  > adapters (its only `usingDapper` branch is the destroy FK catch — the two
  > controllers are otherwise byte-identical), so the EF leg carried it
  > identically; the dapper leg simply reported first. Fixed the same way
  > (`emit/common.ts` → `dotnetFindAbsenceThrow`), pinned in
  > `union-emit.test.ts` with the same list-find scope guard, and both legs
  > re-booted to 0 divergences on all five cases.
  >
  > **And elixir, the same day, with TWO spellings at once.** Its `T?` arm sent
  > `"<Aggregate> not found"` — a sentence that *reads* like this rule's by-id
  > form but carries no id — and its `T option` arm sent `"Not Found"` (its
  > `problem_variant/5` helper sets `detail: title`). Nine of the elixir leg's
  > eleven wire divergences were those two arms, across `union-find-absence`,
  > `inheritance`, `provenance`, `audited` and `wire-contract`. Both now call
  > `ProblemDetails.problem_response(conn, 404, "Not Found", "not_found")` —
  > the same shared producer the by-id read already used.
  >
  > **Four backends, one rule, four separate discoveries** — and in each the
  > defect sat beside a *correct* sibling arm in the same file: java's
  > `error`-variant branch built a real ProblemDetail three lines from the empty
  > one; .NET's did the same; elixir's two arms disagreed with *each other*.
  > That is the shape to look for when adding a route class: not "is the
  > producer right", but "does **every** arm reach it". Only node and python —
  > the two that never hand-rolled a find 404 — were right from the start, which
  > is the rule restated: the arms that were wrong are exactly the arms that
  > answered locally instead of reaching the producer.
  >
  > **And a fifth discovery, at the two read sites nobody had counted
  > (2026-08-11, M-T6.31 / [#2520](https://github.com/lemmit/Loc/pull/2520)).**
  > The four corrections above all concern the aggregate's own routes. Two more
  > by-KEY reads exist — the **projection show**
  > (`GET /api/projections/<p>/{key}`) and the **workflow-instance show**
  > (`…/instances/{id}`) — and on those, .NET was still `return NotFound();` at
  > six arms (projection EF + Dapper, instance ES/state × EF/Dapper) and java
  > still `ResponseEntity.notFound().build()` at three. Same bug, same
  > "correct sibling arm in the same file" shape, one route class further out;
  > **RS-22 listed both backends as conforming the whole time**, because no
  > golden reached those routes either. Elixir added a third variant of its own:
  > its instance 404 said `"<Wf> instance <id> not found"` where node and python
  > said `"<Wf> <id> not found"`. All nine arms now raise the shared carrier and
  > the sentence is byte-identical on all five. Gated statically per SITE
  > (`test/conformance/absent-read-envelope-parity.test.ts`) and at runtime by an
  > **absent-read probe** appended to the wire-golden dispatch — the structural
  > cause of the whole five-part story is that the emitted `test e2e` DSL has no
  > verb for "read a key that isn't there", so the probe manufactures one from
  > the URLs each tier already requested.
  >
  > **And a sixth, at the last by-key read of all (2026-08-23, M-T6.39 /
  > [#2645](https://github.com/lemmit/Loc/pull/2645)).** `GET /files/{key}` —
  > the root file-download route over a bound `objectStore` — was the one
  > absent-read site outside all five discoveries above, and it was wrong on
  > **all five backends at once**: node/python/elixir answered
  > `{"error":"not found"}` as plain `application/json`, dotnet/java answered
  > bodiless. The bodiless pair is the subtler half — neither stays empty on the
  > wire, because `UseStatusCodePages` and the servlet container fill a bodiless
  > 4xx with the FRAMEWORK-miss problem, whose `detail` reads `no route for GET
  > /files/<key>`. That sentence is false: the route exists, the OBJECT does
  > not, so a client cannot tell a mistyped URL from a deleted upload. All five
  > now reach their one producer with `File <key> not found` — .NET through a
  > new static responder on `DomainExceptionFilter`, because the route is a
  > MINIMAL API and an `IExceptionFilter` never sees a throw from one. Same
  > gating shape as the fifth discovery: a per-SITE pin
  > (`test/conformance/files-absent-object-envelope-parity.test.ts`) plus an
  > absent-FILE probe on the wire-golden dispatch. The reason it survived the
  > 2026-08-11 sweep is the same reason RS-22 listed .NET and java as conforming
  > through all of the above — **no golden reached the route**, and none could:
  > the routes are emitted only for a system with BOTH a `File` field and an
  > `objectStore`, and no corpus fixture had one until `file-download.ddd`.
- **The real rule: don't hand-roll a 404.** This was not five backends inventing
  five strings. **Two agreed out of the box**, because on each the message comes
  from one shared producer — the repository's `getById`
  (`python/repository-builder.ts`) or Phoenix's
  `ProblemDetails.not_found_response/3`. The **three** outliers were precisely
  the three routes that **bypassed** their own producer, and in every case it
  was the by-id **READ** — the one place `findById` returns `null` and tempts a
  local answer, while the writes were already correct:
  - **node** probed with `repo.findById` and raised its own
    `AggregateNotFoundError("not_found")` — no aggregate, no id. The *same
    service's* `DELETE` route already answered the sentence, because it loads
    through `repo.getById`. One service, two answers.
  - **.NET** returned `NotFound()`, ASP.NET's own bare 404, so it never reached
    `DomainExceptionFilter`'s `AggregateNotFoundException` arm that every other
    .NET 404 goes through. That also put this one route outside
    [RS-22](#rs-22--the-rfc-7807-envelope-is-exactly-five-members-plus-declared-extensions)
    — the factory omits `instance` and injects `traceId` — an unmeasured hole in
    an existing rule, closed by the same fix.
  - **java** returned `ResponseEntity.notFound().build()` — Spring's own bare
    404, an **empty body** — because the service read ended `.orElse(null)`
    while every java write path loads through `repository.getById`, which
    throws.
- **Why it survived so long.** Two independent blind spots, both of which
  generalize:
  1. **No caller.** Nothing in the repo had *ever* driven a `GET /<aggs>/{id}`
     404. It surfaced from the API-operation caller census
     (`test/ir/api-caller-census.test.ts`): draining the `destroy`/`all` pins
     needed a "the row is really gone" assertion, and that assertion was the
     first request of its kind any wire golden ever recorded.
  2. **Unbaselinable.** Even with a test, no golden could have held the field:
     the sentence embeds a per-run uuid, and `WIRE_NORMALIZE` templated only
     *path-shaped* strings — so `detail` differed on every run of every backend.
     **A field that cannot be recorded cannot be gated.** Generalizing the
     rewrite to a uuid embedded *anywhere* in a string
     (`test/_helpers/wire-record.ts`) is what makes this rule enforceable at all.
- **And a third, about the verification.** java's bypass was **missed on the
  first pass**: the emitter survey read the *repository* (which emits the
  sentence) and stopped there. The first parity pin then encoded the same
  mistake — a `.java`-wide `toContain` of the message, which the repository
  satisfies. So "java emits the sentence" was literally **true** while the route
  answered `""`, and the pin stayed green until a booted leg failed. **A 404 is
  a property of the route, so only a route-scoped assertion can pin it**; the
  per-file scoping in `not-found-by-id-detail-parity.test.ts` exists for that
  reason, and is mutation-proven per backend.
- **Conforms.** node, dotnet, java, python, elixir. **python and elixir** needed
  no change — and that is now *checked at the route*, not read: elixir's
  `show/2` and history action call `ProblemDetails.not_found_response/3`
  directly, python's route calls `repo.get_by_id`, which raises.
- **Provenance.** Found 2026-08-04 by the M-T9.11 golden gate on the python leg
  of `corpus/core-domain`, immediately after the caller-census drain added the
  first-ever getById-404 caller: `$.detail` — golden `"not_found"` vs python
  `"Order <uuid> not found"`. Fixed on node
  (`src/platform/hono/v4/routes-builder.ts`, getById + history) and .NET
  (`src/generator/dotnet/emit/api.ts`, throw instead of `NotFound()`); **java
  followed on the behavioural-java leg of PR #2429** (`emit/service.ts`
  `.orElseThrow(...)` + `emit/api.ts` `ResponseEntity.ok(...)`, with the five
  message sites unified behind `javaNotFoundThrow` in `emit/common.ts`).
  Runtime-verified on node, python and java — all three match the golden
  byte-for-byte on `core-domain`.
  Tier: **behavioral** — the wire golden now holds `"Order {id} not found"`, so
  every behavioral leg gates it per-PR.
### RS-29 · The wire-validation rung is `Validation failed`, distinct from the domain floor
- **Guarantee.** A 422 raised by **wire validation** — a malformed body, a
  missing required field, a boundary-expressible `invariant` — carries title
  **`"Validation failed"`**, detail **`"One or more fields are invalid."`**, and
  the `errors[]` pointer array.
- **Why the title is deliberately *not* the reason phrase.** The **domain floor**
  also answers 422 ([RS-15](#rs-15--the-domain-floor-is-422-not-400)), and its
  title *is* `"Unprocessable Entity"`. Both rungs are 422, so status alone cannot
  separate them: `title` plus `errors[]` is the only thing telling a client
  *"your JSON is malformed"* from *"your request was understood and refused"*.
  A backend that titles the validation rung with the status reason phrase
  **collapses the two rungs into one**.
- **Trigger.** Any `POST` with a body the wire schema rejects.
- **The split.** 4-vs-1, python the outlier — `"Unprocessable Entity"` /
  `"Request validation failed."` against the other four's `"Validation failed"` /
  `"One or more fields are invalid."`. **Both halves of the body differed.**
- **Where it sat is the point.** Wire validation is the **highest-traffic error
  path in any API** — every malformed request hits it — and it was invisible to
  every gate. The M-T9.11 golden cannot see it because only **4 of the 31
  goldens record an error body at all** — and the single 422 among them
  (`wire-contract`) is the **domain floor**, i.e. the *other* rung.
  `conformance-parity` is no help either: it compares declared response
  *shapes*, not the values inside them.
- **How it was found.** The M-T9.25 census probe, on its **first run**:
  enumerate every 7807 arm each backend emits, then diff them. That probe exists
  because the two bugs before it were both *intra*-backend — a router that
  ignored an override, and `mergeContexts` dropping the override maps — a backend
  disagreeing with **itself**, which no compare-to-another-backend gate can see.
  This one turned out to be cross-backend, surfaced by the same sweep.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-08-01; confirmed by **generating all five and
  reading the emitted arm**, not by grepping the emitter. Pinned by
  `test/conformance/problem-arm-census.test.ts`, verified to fail on all three
  assertions with the fix reverted. Tier: **static** — promote to behavioral the
  moment a golden records a 4xx.

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

### Claim the NUMBER before you build

The registry is append-only with a monotonic counter and **no reservation
mechanism**, so two agents minting rules in parallel collide every time — and
`RS-26` was minted twice on 2026-08-03 by two branches that were both correct.
The `id` contract ("never renumbered") settles *who* moves — whichever landed
on `main` first keeps the number — but the loser then renames across every
citing file, which on that occasion was 23 of them.

**So: state the id you are taking in your draft PR title/body before you write
the rule**, the same way CLAUDE.md has you claim the work itself. Read the open
drafts first; if one already claims your number, take the next.

If you do have to renumber, note that applying `26→27, 27→28, 28→29` as a
left-to-right sweep **double-bumps** anything already advanced during conflict
resolution. Verify with a uniqueness check over the emitted ids rather than by
reading the diff:

```bash
grep -o 'id: "RS-[0-9]*"' test/conformance/semantics-rules.ts | sort | uniq -d
```

### Make the fixture able to falsify the rule

A rule is only as good as the data its fixture carries. **RS-30** (declared-error
extension members are camelCase) sat undetected because the one golden recording
a declared-error body used `error NotFound { resource: string }` — and
`resource` is the same string in snake_case and camelCase. Before trusting a new
gate, ask what its fixture would have to look like for the rule to *fail*:

| rule about | fixture must carry |
|---|---|
| casing | a **multi-word** field name |
| defaults | a value that differs from the type's zero value |
| an override being honoured | a **non-default** override — default emission cannot distinguish "resolved to the default" from "hardcoded" |
| an error arm | the path the rule's own `trigger` sentence names, not just the fall-through arm |

And verify the gate by reverting **the emitter line**, not by stashing the
working tree: if the fix is already committed, `git stash push -- src/` reverts
nothing and the test passes vacuously.

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

### RS-30 · A declared error's fields are camelCase extension members on the problem body
- **Guarantee.** When an operation or find declared `T or SomeError` returns the
  error variant, each field of `SomeError` reaches the RFC 7807 body as a §3.2
  extension member spelled in **camelCase** — the same casing every other wire
  key uses. snake_case there is a wire break: a client reading `minAmount` off
  four backends gets `undefined` from the fifth.
- **Trigger.** `error PriceTooLow { minAmount: int, … }` returned from an
  exception-less operation. **Multi-word field names are the trigger** — with
  one-word names the rule is untestable.
- **The split.** 4-vs-1, elixir the outlier: `%{min_amount:, offered_amount:,
  currency_code:}` against the other four's `minAmount` / `offeredAmount` /
  `currencyCode`. Elixir built the extension map by rendering the error record
  through the shared `object` expression leaf, which snakes names — *correctly*,
  because every other object literal in elixir is a domain-side Ecto map. The
  fix keys the map off the declared field names and renders only the **values**
  through the leaf.
- **The one casing divergence in the whole sweep.** At the six mainstream wire
  sites — read DTO, create input, paged carrier, projection read,
  workflow-instance read, nested parts and value objects — all five backends
  agree, camelCase, in identical `wireShape` order. That is `wireShape` doing
  exactly what it exists for. This site is the one that doesn't consult it.
- **Why it was invisible, and the transferable half.** The only golden recording
  a declared-error body (`operation-returns.json`) uses
  `error NotFound { resource: string }` — a **single-word** field, where snake
  and camel are the same string. **A fixture with one-word names cannot test a
  casing rule**, however many backends it runs on. (Secondarily:
  `conformance-parity` compares declared response *shapes*, and extension
  members aren't in the declared `ProblemDetails` component.)
- **It was also intra-backend**, which is the sharper half — elixir's own
  emitted OpenApiSpex schema declares `minAmount`/`offeredAmount`/`currencyCode`,
  so the spec the app published and the body it sent disagreed with each other
  inside one generated project.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Found 2026-08-02 by the M-T9.25 casing/absence census sweep;
  confirmed by generating all five from a deliberately multi-word error record
  and reading the emitted body. Fixed in
  `src/generator/elixir/vanilla/operation-returns-emit.ts` (atom keys, matching
  the base map `problem_variant/5` merges into, so a field named `type` cannot
  duplicate in the JSON). Pinned by
  `test/conformance/error-extension-casing.test.ts`, verified to fail two of its
  three assertions with the fix reverted. Tier: **static** — widening
  `union-find-absence.ddd`'s error payload to a multi-word field would promote
  it at no new CI boot cost, and is the highest-yield single golden change
  available.

---

### RS-31 · A string `.length` bound counts Unicode code points, not the host's native string length
- **Guarantee.** `s.length` on a string — in an invariant, a precondition, or a
  plain domain read — is a count of **Unicode code points**. `"😀X"` is **2**,
  not 3: the emoji is one code point and two UTF-16 code units. This is the
  unit the emitted JSON Schema already publishes as `minLength`/`maxLength`, so
  the bound a backend *enforces* and the bound it *advertises* are the same
  number.
- **Trigger.** Any `len-*` bound (`code.length >= 3`, `label.length <= 16`,
  `currency.length == 3`) fed a value containing an astral character.
- **The split.** 3-vs-1-vs-1 before the fix: JS `s.length`, C# `s.Length` and
  Java `s.length()` count UTF-16 **code units**; python's `len` counts **code
  points**; elixir's `String.length/1` counts **graphemes**. The three
  code-unit backends accepted a value their own published `maxLength`/
  `minLength` forbade — the write side persisted data the read side could not
  legally serve.
- **Both carriers, or neither.** A message-less single-field bound rides each
  backend's *native validator chain* (zod `.min`/`.max`, FluentValidation
  `.MinimumLength`, …); a messaged rule and the domain floor ride the
  *expression renderer*. They are separate code paths, so fixing one leaves the
  other wrong — which is why the pinned case exercises both directions.
- **The declaration survives.** zod cannot describe a `.refine` to the OpenAPI
  emitter, so the Hono routes re-attach `.openapi({ minLength, maxLength })`.
  The published bound is byte-identical to before; only what the server
  enforces changed.
- **Elixir is a signed residual, not a conformer.** Graphemes agree with code
  points on every astral character (so it passes the pinned case) and diverge
  only on combining sequences (`"e\u0301"` — one grapheme, two code points),
  which nothing in the corpus reaches. Ecto's `validate_length/3` has no
  `:codepoints` count, so closing it means hand-rolling Ecto's error tuples —
  a unit of its own.
- **Conforms.** node, dotnet, java, python. **Residual:** elixir.
- **Provenance.** Found 2026-08-06 by the M-T9.21 schemathesis leg (finding F5,
  waiver W6). Fixed via one shared definition,
  `src/generator/_expr/code-point.ts`, consumed by both the domain rule
  renderer and the wire-boundary validator emitter of each backend. Pinned in
  `test/fixtures/corpus/validation-messages.ddd` and recorded in
  `wire-golden/validation-messages.json` — a 2-code-point label DENIED by
  `>= 3`, a 9-code-point / 18-code-unit label ADMITTED by `<= 16` and
  round-tripped — verified to fail with each half of the fix reverted
  independently. Statically pinned per backend by
  `test/generator/string-length-code-points.test.ts`. Tier: **behavioral**.

### RS-32 · A malformed path `{id}` answers the declared 422, not a framework default
- **Guarantee.** `GET /api/orders/not-a-uuid` — a path `{id}` that will not
  parse — answers **422** with the same §3.2 `errors[]` envelope the body tier
  emits (`pointer: "/id"`), on every backend. It is a **client** fault, and
  reporting it as a 500 tells the caller to retry a request that can never
  succeed.
- **Why it is not a judgement call.** Every backend already *publishes* the 422:
  the per-operation error matrix (`src/ir/util/openapi-errors.ts`) says "a path
  `{id}` is parsed as a uuid and a query parameter is parsed against its
  declared type, and a failure at either answers the same 422 the body tier
  does", and each emitted spec declares the parameter `format: uuid`. What
  differed was what they *answered*.
- **Trigger.** Any route binding `{id}` — `getById`, `destroy`, the canonical
  `update`, each named operation, each `can_<op>` probe, the entity-history read,
  the workflow-instance read.
- **The split.** 2-vs-3 when first measured (#2652): node's
  `z.string().uuid()` param → `defaultHook`, and .NET's `[FromRoute] Guid` →
  `InvalidModelStateResponseFactory`, both answered 422. Java raised
  `MethodArgumentTypeMismatchException`, which does not implement
  `ErrorResponse`, so the catch-all reported **500**; python bound the param as a
  bare `str` carrying a documentation-only `format: uuid`, so nothing rejected
  it and the malformed value reached the repository. **Elixir was never
  measured** in that pass: it handed the raw string to `Repo.get/2`, where a
  malformed `:binary_id` raises `Ecto.Query.CastError` out of Ecto, leaving only
  the app-global fault floor — a bare 500 with no `errors[]` and no pointer.
- **Where the guard belongs is part of the rule.** On Phoenix it is a controller
  **`plug`**, not a per-action `case`: a controller gains actions over time and a
  per-action guard is the one the next action's emitter forgets. It is opt-in per
  controller rather than living in the shared `<App>Web` `controller` quote,
  because an api's explicit `route` list may declare a `{id}` of its own that is
  not an aggregate id.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** Four backends aligned by #2652 and pinned in
  `test/generator/malformed-path-id-status.test.ts`; elixir added there in the
  W1b elixir packet (`renderPathIdCastPlug` +
  `ProblemDetails.invalid_path_id_response/2`), mutation-proven by reverting the
  plug. Tier: **generator**, with the runtime half recorded per backend.

### RS-33 · An `errors[]` pointer names the whole path to the offending field
- **Guarantee.** A 422 `errors[]` entry carries an **RFC 6901** JSON pointer to
  the field that failed, however deeply nested — `/lines/0/qty`, `/sku/code` —
  never just the top-level container it sits under, and never an empty array. It
  is what lets a frontend ACL (`applyServerErrors`) bind the denial to the form
  control that caused it.
- **Trigger.** A violation inside a containment part, a value-object collection
  row, or a value-object field.
- **The split.** 3-vs-1-vs-1. .NET's `PointerOf` converts `Items[0].Qty` to
  `/items/0/qty`, node joins the whole zod `issue.path`, python keeps every
  pydantic `loc` segment. **Java** emits `/lineTotals[0].unitPrice` — a field
  path, not a pointer. **Elixir was structurally depth-1**: the body was built
  from a flat `changeset.errors` walk into `pointer_of([field])`, and
  `Ecto.Changeset.errors` holds only the top level, so a `cast_embed` /
  `cast_assoc` child violation answered `errors: []` — a 422 naming no field at
  all.
- **A value object is a third carrier, not a nested changeset.** On Phoenix a VO
  persists as one jsonb `:map` column and is checked by `validate_change/3`, so
  there is no child changeset for the walk to find. It has to forward its own
  errors explicitly — with the inner field path *and* the authored message *and*
  the `loom_code` the i18n catalog is keyed by. Collapsing it to
  `[{field, "is invalid"}]` discarded all three.
- **Conforms.** node, dotnet, python, elixir. **Open:** java (the bracket
  spelling; `src/generator/java/emit/api.ts:678` and `:802`).
- **Provenance.** Recorded as ledger rows `F2-W-03` and
  `nested-errors-pointer-shape`; the elixir arm fixed in the W1b elixir packet
  (`collect_changeset_errors/2` + the `loom_path` opt on `validate_vo/3`),
  mutation-proven by deleting the recursion's call site — which the first version
  of the gate did **not** catch, because it asserted the helper clauses existed
  rather than that they were called. Tier: **generator**; the runtime half wants
  a wire-golden fixture carrying a VO-collection violation, which no golden
  records today (only 4 of 31 record any error body).
