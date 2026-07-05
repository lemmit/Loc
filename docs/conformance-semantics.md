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
  same instant.
- **Conforms.** node, dotnet, java, python, elixir.
- **Provenance.** #1626 (cast declared `createdAt` + preload insert
  associations). Tier: **T1**.

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
- **Conforms.** node, **python** (dotnet/java/elixir still targets).
- **Provenance.** July full-code-review finding B14. Tier: **T1** — gated per-PR
  on node and python (A6.2). The python behavioral gate **found and closed** a
  real parity bug here: the FastAPI create model hardcoded `active: bool = False`
  (the zero value) instead of the declared default; fixed by rendering the
  field's lowered `default` expr in the create request field
  (`routes-builder.ts`).

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
> [`plans/runtime-semantics-tier-followups.md`](plans/runtime-semantics-tier-followups.md).

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
