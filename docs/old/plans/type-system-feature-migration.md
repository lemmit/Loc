# Plan — Type-system feature migration & cross-backend debt clearance

> **[2026-06-20 status audit]** Substantially shipped (no longer just 'in-flight design note') — payload/command/query/response/error + named unions + option/or carriers + criterion + abstract/extends are in grammar/IR/validators/docs; `<Agg>Wire` enrichment + the `ExprTarget` unification landed. Remaining: strict-parity phase + the DBT register (esp. Phoenix provenance — note: provenance has since shipped on the elixir backend #1400). (NB: the Ash foundation has since been removed — `platform: elixir` is plain Ecto/Phoenix only; references below to an "Ash"/"vanilla" foundation split are historical.)

> Status: in-flight design note. Scopes how the type-system family of
> proposals (`docs/old/proposals/type-system-overview.md` and its five
> siblings) folds into the existing toolchain — **which existing
> features migrate, which only touch the new work, and which stay put**
> — and uses the strict cross-backend parity gate as the forcing
> function to clear the multi-backend implementation debt this work
> surfaces.
>
> This note is the *migration map*. The type-system delivery sequence
> itself (phases P / A / Crit / I) lives in
> `docs/old/proposals/implementation-plan.md`; this plan references those
> phase IDs rather than restating them.

## 0. Principles & non-goals (read first)

These pin the framing. They override any looser language in the
proposal docs.

1. **The type system is additive.** Payloads, carrier-bounded generics,
   tagged unions, the exception-less flow, and criteria are *new
   surface*. Existing aggregate code keeps compiling and emitting
   byte-identically until an author opts in.

2. **Macros are permanent and stay first-class.** The macro stdlib
   (`crudish`, `audit`, `softDelete`, `scaffold`, …) is a core Loom
   capability, not a stopgap. **No macro is deprecated or made
   "obsolete" by this work.** The proposal text in
   `payload-transport-layer.md` §"Hard parts" that calls some macros
   "obsolete" is explicitly **rejected** here — see §5.2. The type
   system *complements* macros; macros remain the answer for
   cross-cutting concerns that inject structure into aggregates
   (field injection, per-aggregate operation synthesis, scaffolding).

3. **No `api` auto-CRUD generator is built.** `crudish` remains the
   per-aggregate CRUD **operation** generator. The `api` surface
   **digests what `crudish` (or the author) adds** — it exposes the
   operations already present in `members[]`; it does not synthesize
   them. The only `crudish` change in scope is letting its *parameter
   shape* consume a synthesized `command` payload (§5.2).

4. **Parity is a forcing function — sequenced as its own phase.**
   During active development, filtering a by-design single-backend
   extension out of the parity diff (e.g. `ProvenanceLineage`) is a
   legitimate way to keep the gate green while the feature settles.
   The *strict* gate — flipping the filter off so the divergence forces
   the missing implementations onto the other backends — is scheduled
   as a **deliberate next phase**, not a same-PR requirement. Filters
   are fine in the interim; each just carries a debt-register row (§6)
   so the strict-gate phase has a worklist.

**Non-goals** (unchanged from the proposals' deferred lists): generics
on aggregates, row polymorphism, type-class abstractions, async/effect
types. Plus, specific to this plan: **no macro retirement**, **no
auto-CRUD subsystem**.

## 1. The thesis

The type-system family reshapes Loom along two parallel ladders —
**state** (`aggregate`, + abstract aggregates) and **transport**
(`payload`, + generics + unions) — and builds an exception-less flow
and a criteria layer on top. See `type-system-overview.md` for the
10-minute version.

The migration question this plan answers is narrower: **when this
lands, what happens to the features we already ship?** Three buckets:

- **Migrates** — existing surface is re-expressed in the new model
  (auto-upgraded, re-shaped, or subsumed). §3.
- **Coexists** — orthogonal features that don't move, but share code
  seams the migration touches and must not regress. §4.
- **Integration seams** — the specific places where a "coexisting"
  feature and the new work meet, needing deliberate handling. §5.

And one cross-cutting workstream the migration *creates the leverage
for*: clearing the per-backend implementation debt, gated by parity.
§6.

## 2. What migrates INTO the type system

Each row is an existing capability that becomes a special case of the
new model. All are author-invisible auto-upgrades **except** where
noted.

| Existing feature | Becomes | How / phase | Author change? |
|---|---|---|---|
| `event` / `command` / `query` / `response` keywords | `payload` subtypes (`extends payload`) | Auto-upgrade in IR enrichment (`payload-transport-layer.md:199`). Phase **P1**. | None |
| Implicit `wireShape` (per-aggregate DTO, `enrich/enrichments.ts`) | Explicit, referenceable `<Agg>Wire` **payload** | Phase **P2**. Emission unchanged; the shape gains a name. | None |
| `find` returns (`: X` implicit-nullable, `: X?`) | `X or NotFound` / `X option` | Phase **A4** — the one coordinated PR; re-baselines fixtures (`exception-less.md:830`). | Yes (forced) |
| Throws (`not found`, validation, parse) | Typed `or`-union returns + `?` propagation | Phases **A1–A6**. | Yes (forced) |
| Proposed `Optional<T>` | `T option` carrier | Subsumed (`payload-transport-layer.md:380`). | N/A (never shipped) |
| Earlier `specification` draft | `criterion` + `from`/`when` + `Repo.findAll` | Phase **Crit1–4** (`criterion.md:37`). | N/A (never shipped) |
| `validate` / `authorize` at operation sites | `validate for X` / `authorize for X` on payloads | Phase **P5**; existing op-level rules keep working. | Opt-in |

**Provenance is deliberately absent from this table.** It does not
migrate — see §4 and §5.1.

## 3. What does NOT migrate — the governance proposals coexist

`type-system-overview.md:344-347` draws the line explicitly: the
type-system family is the first six proposal docs; **the rest are
provenance/governance proposals that pre-date this work** and are not
part of it. None of these move onto the state/transport axes:

- `provenance.md` — `provenanced` field modifier + rule snapshots + traces.
- `audit-and-logging.md` — `audited` operations.
- `execution-context.md` — scope frames.
- `sensitivity-and-compliance.md` — sensitivity tagging.
- `encrypted-at-rest.md` — column encryption.
- `load-specifications.md` — aggregate load specs.
- `observability.md` — catalog envelope.
- `policies-supplementary-note.md` — auth-model intersection.

These are cross-cutting concerns attached to aggregates/operations, not
"data shapes crossing a boundary." They keep their own mechanisms.
**But** several share code seams with the migration — §5.

## 4. Why provenance specifically stays put

`provenanced` is a **stored-field modifier** (`total: int provenanced`)
that instruments each write-site with a rule snapshot + runtime trace
(`docs/provenance.md`). Nothing about it is a payload, union, generic,
or error type. It is the single most-cited "does this migrate?"
candidate, and the answer is **no** — but it has two real touchpoints
with the new work (§5.1), one of which is the leverage point for
clearing its multi-backend debt (§6).

## 5. Integration seams (must-not-regress)

The places a coexisting feature and the migration meet. Each needs a
test that pins the interaction.

### 5.1 Provenance × the statement/expression re-shape (A4–A6)

Provenance instruments write-sites by wrapping assignments with trace
capture in `src/generator/typescript/render-stmt.ts:107` (the
`withTrace` wrapper); the field/buffer/`drainProv` plumbing is in the
aggregate emit. The exception-less work (the `?` propagation operator,
the A4 find re-shape) **rewrites `render-stmt` / `render-expr`
heavily**.

- **Risk:** A4's statement re-shaping silently breaks `withTrace`
  inlining (e.g., a `:=` whose RHS is now an `or`-union expression with
  `?` propagation — the trace must capture leaf inputs *before* the
  short-circuit, and must not fire on the error arm).
- **Action:** before A4 lands, add a regression test: a `provenanced`
  field written from an operation whose body uses `?` propagation;
  assert the emitted trace capture is well-formed and the snapshot
  still content-addresses. Treat this as a gate on the A4 PR.
- **Opportunity (fold in, don't do separately):** the per-backend
  `render-expr.ts` carry a structurally identical ~17-arm dispatch over
  `ExprIR` (TS / .NET / Phoenix), diverging only in leaf emission. Since
  A4 already rewrites these files heavily, that is the cheap moment to
  unify the dispatch behind an `ExprTarget` contract (leaf emitters +
  the framework-shaped seams), mirroring the `WalkerTarget` extraction
  the body-walker already uses (`src/generator/_walker/target.ts`; PRs
  #607–#627). Extracting it *before* A4 means re-doing it; doing it as
  part of A4 is close to free. The pure `refCollectionFieldName` query
  was already hoisted to `src/ir/util/ref-collection.ts` (#793) as the
  one A4-independent slice — the rest waits for A4.

### 5.2 Provenance × wireShape, and the `managed`-on-wire option

Today `_<field>_provenance` is a **generator-internal** field
(synthesized in the TS emitter, below the IR) — so it is invisible to
`wireShape` by construction, not by an access decision.

There is a coherent, *optional* design to expose the **current**
lineage on the read wire, using existing machinery rather than a hidden
field:

- The access role `managed` (`ddd.langium:841`: "server-managed; client
  read-only") is exactly provenance's contract — server computes it,
  client never writes it, client may read it. `wireShape` already
  carries per-field `access` (`enrichments.ts:644`) and partitions the
  ordered field list into read vs write projections, so a `managed`
  field rides the read DTO and is auto-excluded from update inputs (the
  same filter `crudish`'s `writableUpdateFields` uses).
- **This is the one genuine point where provenance touches the payload
  proposal:** the lineage's type is `ProvLineage { snapshotId, target,
  inputs, computedValue }` — a structured record, i.e. a **payload**.
  Exposing it cleanly means declaring `payload ProvLineage { … }` (a
  stdlib payload) and a `<field>_provenance: ProvLineage option managed`
  member. `option` (absent until a runtime fills it) is the right shape
  given the cross-backend reality below.

**Decision (pinned for v1): keep lineage off the wire by default.**
Reasons: (a) it adds bytes to every read of a provenanced aggregate;
(b) it converts a single-backend runtime feature into an all-backends
*wire contract* (see §6 — this is the parity tension). Promote to
`ProvLineage option managed` only as a deliberate, opt-in follow-up,
*after* the multi-backend runtime debt is cleared. Tracked as **D-prov-wire**
in §9.

### 5.3 crudish — shape half only; crudish stays

`crudish` synthesizes an `update` **operation** AST node — name, one
positional param per writable field, and an assigning body
(`this.f := f`) — and splices it into the aggregate's `members[]`,
indistinguishable from a hand-written operation
(`src/macros/stdlib/crudish.macro.ts:75`; `expander.ts:59-60`). From
there it rides the ordinary operation→route pipeline (visibility gate
at `platform/hono/v4/routes-builder.ts:353`).

It has two halves; the migration touches **only the first**:

| crudish half | Migration effect |
|---|---|
| **Parameter shape** — N positional params via `writableUpdateFields`, with manual `cloneType` AST rebuilding | **Enhanced** by Phase P2 input-type synthesis: the positional list collapses to a single `command Update<Agg>` payload param, and the deferred `create`/`delete` (blocked today on "input-type synthesis") **unblock**. |
| **Operation itself** — its existence, name, assigning body, public exposure | **Untouched.** crudish remains the generator. The `api` surface digests it. No auto-CRUD subsystem. |

So crudish is **not** retired — it gets *better* (cleaner param shape,
create/delete unblocked) while remaining the mechanism. **Action:** when
P2 lands, refactor `crudish` to emit a `command`-payload param behind a
flag, keeping the positional form until every backend consumes the
payload form (parity-gated). Add `writableCreateFields`-driven `create`.

## 6. Parity as the forcing function — the debt register

The strict gate `conformance-parity.yml` (`LOOM_E2E_STRICT_PARITY=1`)
diffs nine dimensions of the OpenAPI/wire contract across Hono / .NET /
Phoenix and asserts agreement (`docs/conformance.md`;
`test/_helpers/openapi-normalize.ts`). Today it **filters** by-design
single-backend extensions (e.g. `*_provenance` schemas) to stay green.

This plan's stance is **two-phase**:

- **During dev:** filtering a by-design single-backend extension out of
  the diff is fine — it keeps the gate green while the feature settles.
- **Strict-gate phase (later):** flip the filters off so each
  divergence forces the missing implementation onto the other backends.
  This is when "Hono-only" stops being acceptable.

The register below is the worklist that makes the strict-gate phase
concrete: it keeps the debt visible so flipping a filter has a known
cost and owner, rather than silently re-greening.

### 6.1 Debt register (cross-backend gaps, with citations)

| ID | Feature | Hono | .NET | Phoenix | React | Cleared by |
|---|---|---|---|---|---|---|
| DBT-1 | **`provenanced` runtime** (trace capture + history) | ✓ full (`routes-builder.ts:80`, `render-stmt.ts:107`, `repository-save-builder.ts:160`) | ✓ full (`dotnet/render-stmt.ts` capture, `emit/provenance.ts`, `emit/repository.ts` flush, `dto-mapping.ts` wire) | ✗ parsed, no-op (`generators.md:38`) | n/a | (since shipped on the elixir backend #1400); Hono+.NET parity is wire-shape-compatible (`ProvLineage` Web-default JSON) |
| DBT-2 | **`where`-clause finds** | ✓ `lowerToDrizzle` over the queryable subset — comparisons, `&&`/`||`, `!`, bare-bool, VO sub-columns, `currentUser`, enum values, `refColl.contains` (`repository-find-builder.ts`); validator-gated by `firstNonQueryableNode` (#760) | ✓ full LINQ `.Where(…)` | ✓ Ecto `where` | ⚠ hook-only (deferred → DBT-4) | **Hono/.NET/Phoenix cleared.** Only the React list-page filter mode remains — tracked as DBT-4 |
| DBT-3 | **`X id[]` reference ordering** | ✓ `ordinal` column | ✓ `ordinal` column | ✗ unordered / set semantics (`generators.md:751`) | display-only | Elixir `ordinal` ordering, or ratify set semantics as the contract |
| DBT-4 | **React list-page filter mode** | n/a | n/a | n/a | ✗ deferred; v1 emits hook only (`generators.md:43`; `body-walker.ts:658` `unsupported expr` fallback) | Implement filter-mode walker |
| DBT-5 | **Page `requires <pred>` guard** | n/a | n/a | ⚠ v0 stub: bind-only (`generators.md:624`) | n/a | Full guard in `handle_params/3` |

> Out of scope for this plan: the .NET adapter-menu stubs
> (`dapper` / `marten` / `layered` / `byFeature`) are a pre-ship
> product-iteration concern, not type-system-adjacent debt — tracked
> wherever the .NET backend roadmap lives, not here.

> Note: `audited`-operation runtime parity (.NET/Phoenix) and the
> RFC 7807 `ProblemDetails` error body are tracked separately under the
> conformance plan (`docs/old/plans/conformance-parity-restoration.md`,
> issues #705/#706 and Group A/B). This register lists the *type-system-
> adjacent* debt; the two plans share the parity gate and should land
> their fixes without regressing each other.

### 6.2 Filter-removal triggers

Every existing exclusion in `openapi-normalize.ts` gets a tracked
removal trigger so it can't become permanent:

- `*_provenance` / `ProvenanceLineage` schemas → remove when **DBT-1**
  closes (all three backends persist lineage).
- `ProblemDetails` / `ErrorResponse` framework filter → revisit when a
  shared error envelope ships (exception-less A3 + conformance #706).

New filters added during dev should land with a register row so the
strict-gate phase inherits the full worklist — the row, not strictness,
is the in-the-meantime requirement.

## 7. Sequencing

This plan does not re-order `implementation-plan.md`; it layers the
migration-safety and debt work onto its phases.

1. **P1–P2** (payload keyword, `<Agg>Wire` synthesis): no emission
   change. Land the §5.3 `crudish` param-shape refactor *behind a flag*
   here; keep positional output until backends consume the payload form.
2. **P3–P4** (generics, unions): foundation. No existing-feature
   migration; purely additive.
3. **A1–A3** (errors, `?`, ProblemDetails): minimum coherent
   exception-less ship. **Add the §5.1 provenance×`?` regression test
   before A1.**
4. **A4** (find re-shape): the coordinated migration PR. Gate it on the
   §5.1 provenance trace test staying green. Re-baseline fixtures.
5. **A5–A6** (parse/external/`validate for`): finish the throw→typed
   migration.
6. **Crit1–5** (criteria): additive.
7. **Debt clearance (DBT-1…6):** run *in parallel* with the above as
   per-backend capacity allows, each landing with its parity-filter
   removal. **DBT-1 (provenance multi-backend) is the flagship** and the
   prerequisite for the §5.2 `ProvLineage`-on-wire follow-up.
8. **I1–I4** (aggregate inheritance): parallel track; affects the
   carrier-projection rule for abstract aggregates, not the features in
   this plan's migration table.

## 8. Risks & coordinated moments

- **A4 is the one-PR coordinated migration** (every example `.ddd`,
  every backend's find emitter). Provenance trace capture is the
  non-obvious casualty risk; §5.1 mitigates.
- **Two parallel ladders** (aggregate vs payload) risk author
  confusion. Mitigate with a "state vs transport — when to reach for
  which" section in `docs/language.md` at P1.
- **Parity tension on DBT-1:** exposing lineage on the wire (§5.2)
  *before* clearing DBT-1 would advertise a field every backend
  declares but only Hono populates. Ordering: clear DBT-1 first, then
  consider `ProvLineage option managed`.
- **crudish flag duration:** the positional→`command`-payload param
  switch must stay behind a flag until all backends consume the payload
  form, or the parity gate trips. Don't flip the default early.

## 9. Open decisions

| ID | Question | Lean |
|---|---|---|
| D-prov-wire | Expose current provenance lineage on the read wire as `ProvLineage option managed`? | **Defer**; off by default until DBT-1 closes, then opt-in. |
| D-crud-payload | When P2 lands, default `crudish` to a `command`-payload param, or keep positional with payload behind a flag? | Flag first; flip default only post-parity. |
| D-idarr-order | Ratify `X id[]` as unordered set semantics (close DBT-3 by spec), or implement Ecto ordering? | Open — needs a wire-contract call. |

## 10. Cross-references

- `docs/old/proposals/type-system-overview.md` — the family orientation.
- `docs/old/proposals/payload-transport-layer.md` — transport layer (the
  "macros become obsolete" line here is **rejected** per §0.2).
- `docs/old/proposals/exception-less.md` — A1–A7 (the throw→typed work
  that §5.1 guards provenance through).
- `docs/old/proposals/implementation-plan.md` — the canonical phase/delivery
  plan this note layers onto.
- `docs/provenance.md` — the implemented `provenanced` feature.
- `docs/old/plans/conformance-parity-restoration.md` — the sibling parity
  plan; shares the gate this plan uses as a forcing function.
- `docs/conformance.md` — the nine parity dimensions and doctrine.
</content>
</invoke>
