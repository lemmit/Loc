# Implementation plan — aggregate inheritance, payload transport, exception-less flow

> Status: implementation plan. Operationalises three sibling
> proposals into one delivery stream:
>
> - [`aggregate-inheritance.md`](./aggregate-inheritance.md) — state
>   layer; abstract aggregates with `shared` / `own` storage.
> - [`payload-transport-layer.md`](./payload-transport-layer.md) —
>   transport layer; `payload` keyword, carrier-bounded generics,
>   tagged unions.
> - [`exception-less.md`](./exception-less.md) — `Option<T>` /
>   `Result<T, E>` as native carriers, `?` propagation, `on wire`
>   status mapping, find-variant re-shape.
>
> Read all three before starting. This doc covers ordering,
> coordination points, risk management, and decision pins.

## TL;DR — the delivery story

Three proposals; one type-system unification. They sequence in the
order:

```
aggregate-inheritance (state)   ─── independent ───→ shippable any time
                                          │
payload-transport-layer (transport) ──────┴─→ depends on nothing in inheritance, but
                                              shares the validator type-checker work
                                                  │
exception-less ────────────────────────────────────┴─→ depends strictly on payload Phase 3+4
```

**Recommended global order**:

1. **Payload transport Phase 1+2** (the keyword + the auto-synthesised
   wire payloads). No user-facing change; pure naming win. Lands before
   anything else.
2. **Aggregate inheritance** in parallel (independent). Ships when
   ready; no cross-blocking.
3. **Payload Phase 3+4** (carrier-bounded generics + tagged unions).
   The type-system lift.
4. **Exception-less A1+A2+A3** (Option/Result + `?` + `on wire`). The
   minimum coherent ship for the exception-less story.
5. **Exception-less A4** (find-variant re-shape + coordinated fixture
   re-baseline). The user-visible turning point.
6. **Payload Phase 5** (`validate for X` / `authorize for X`) + 
   **Exception-less A5/A6** (parse / external API / validators as
   Result). These ship together since A6 depends on Payload Phase 5.
7. **Exception-less A7a** (carrier stdlib helpers). Polish; can
   trickle out per-helper after the rest is in.

Total estimated effort, sized in working weeks for a single
focused implementer: **18–24 weeks** for everything through A7a.
See per-phase estimates below.

## Dependency graph (precise)

```
Phase                                  | Depends on              | Blocks
-------------------------------------- | ----------------------- | -------------------------
P1: payload keyword + sugars            | (nothing)               | P2, P3
P2: <Agg>Wire auto-synthesis            | P1                      | P3 (cleanly), A1
P3: carrier generics                    | P1, P2                  | P4, A1
P4: tagged unions + exhaustive match    | P3                      | A1
P5: validate for X / authorize for X    | P1                      | A6
I1: abstract aggregate keyword          | (nothing)               | I2, I3
I2: shared storage strategy             | I1                      | I3 (some interactions)
I3: own storage strategy                | I1                      | (parallel with I2)
I4: per-concrete override + TPT pattern | I1, I2, I3              | (none)
A1: Option/Result + two-regime line     | P3, P4                  | A2, A3, A4, A5, A6, A7
A2: ? propagation operator              | A1                      | A4, A5 (ergonomically)
A3: on wire { ... } + errorStatusMap    | A1                      | A4
A4: find-variant re-shape               | A1, A3                  | A5 (some find call sites)
A5: parse + external API as Result      | A1, A2                  | (none)
A6: validate for X returns Result       | A1, A2, P5              | (none)
A7a: carrier stdlib helpers             | A1                      | (none)
A7b: user-declared carrier generics     | A1, A4 (DEFERRED)       | (deferred to v2)
```

Letters: **P** = payload-transport-layer, **I** = aggregate-inheritance,
**A** = exception-less (A for "antierror"? "application"? — just a
label).

## Phase-by-phase plan

### Track 1 — Payload transport (foundation)

#### P1 — payload keyword + five sugar keywords (~1.5 weeks)

**Scope**: introduce `payload Foo { ... }` keyword. Treat existing
`event` / `command` / `query` / `response` as sugar that auto-upgrade
to `extends payload` in IR enrichment. Add new `error` sugar keyword
with `on wire <Status>` clause. No user .ddd file changes required
for the existing four; `error` is new surface.

**Deliverables**:
- Grammar: `payload` rule + `error` rule + `OnWireClause` (status
  integer) in `src/language/ddd.langium`.
- IR: `PayloadDeclIR` node with `kind: 'payload' | 'event' |
  'command' | 'query' | 'response' | 'error'` and
  `wireStatus?: HttpStatus` on `error`-kind nodes (in
  `src/ir/loom-ir.ts`).
- Enrichment: `src/ir/enrichments.ts` upgrade pass for the existing
  four sugars; pass-through for `error`.
- Backends: no emission change yet (existing four sugars still emit
  as today; `error` payloads emit as a sealed record / typed map +
  the `wireStatus` is captured for P-phase-3 / A-phase-3 consumers).
- Tests: parsing for `payload`, `error <Name> { ... } on wire 404`;
  one negative test (`error` without `on wire` → warning).

**Exit criteria**: `npm test` green; existing examples unchanged
(no `error` declarations yet in user code).

#### P2 — `<Agg>Wire` auto-synthesis (~1 week)

**Scope**: every aggregate gets an auto-synthesised
`<AggName>Wire` payload visible in the type system. No emission
change in user-facing generated code.

**Deliverables**:
- Enrichment: extend the existing `wireShape` enrichment to also
  expose a `PayloadDeclIR` with name `<Agg>Wire`.
- Validator: allow `response: CustomerWire`, `Page<CustomerWire>` etc. in operation/find return positions.
- Tests: one IR test asserting the auto-derived payload exists; one
  generator test confirming emitted code unchanged.

**Exit criteria**: green tests + fixture-byte-identical against
existing examples.

#### P3 — carrier-bounded generics + ML-postfix syntax (~3 weeks)

**Scope**: bounded type parameters on payload declarations using
**parens at declaration sites** and **ML-postfix at use sites**
(consistent with `Customer id` from #477; no angle brackets).
Aggregate-as-carrier projection rule. Variant-name-tagged identity
pinned. Stdlib `page` / `envelope` payloads declared.

**Deliverables**:
- Grammar:
  - Declaration: `payload Foo(T: carrier, U: carrier) { ... }`
    (parens, not angle brackets).
  - Use: ML-postfix in `TypeRef` positions (`customer page`,
    `event envelope`). No angle brackets anywhere in the language.
- IR: `PayloadGenericIR`, `TypeParamIR`, `TypeArgIR`,
  carrier-bound check.
- Type system: bounded substitution at lowering.
  `src/ir/lower-expr.ts` resolves generic instantiations to concrete
  IR nodes during the lowering pass (no runtime generics in the IR).
- Scoping: `ddd-scope.ts` resolves type-parameter references.
- Validator: `loom.bound-not-met` (T must be a carrier),
  `loom.unresolved-type-param`.
- Stdlib: `src/stdlib/payloads/page.ddd`, `envelope.ddd`.
- Backends:
  - TS: emit generic functions / types — trivial.
  - .NET: per-instantiation record emission. New file pattern
    `<carrier>_<T>.cs` (e.g., `Page_CustomerWire.cs`); per-emit
    namespacing.
  - Phoenix: typespecs only (`@type page_customer_wire :: %{...}`).
  - React: TS generics — trivial.
- Wire spec: `src/system/wire-spec.ts` emits one entry per used
  instantiation.
- Tests: parsing tests for both declaration-parens and use-postfix
  syntax; bound-check negative tests; one generator/backend test
  asserting `int page` lowers correctly.

**Critical decision pins needed before P3 lands**:
- Carrier bound name. **Recommended `carrier`.** See D1.
- Postfix vs prefix at use sites. **Recommended postfix
  (`customer page`).** See D14.

**Exit criteria**: `int page`, `customer_wire page`,
`event envelope` declared and used; each backend builds them.

#### P4 — tagged unions (named + anonymous `or`) + exhaustive `match` (~3 weeks)

**Scope**: discriminated unions on payloads in two forms — **named**
(`payload Foo = A | B | C`) and **anonymous `or`** (`A or B or C`
inline in type positions). `kind` discriminator on the wire.
Exhaustiveness check in `match`.

**Deliverables**:
- Grammar:
  - Named: `payload Foo = A | B | C` (pipe-separated variants on a
    `payload` declaration).
  - Anonymous: `A or B or C` in any `TypeRef` position (return
    types, field types, etc.). `or` is associative; precedence sits
    below postfix type constructors (so `string or int option`
    parses as `string or (int option)`).
- IR: `PayloadUnionIR { variants: PayloadDeclIR[] }` (named);
  anonymous unions lower to the same IR shape at the use site
  (no anonymous-union declaration node needed; just an inline
  ref-set).
- Type system: union typing, narrowing on `kind`. Variant
  duplicate check (`loom.union-duplicate-variant`).
- Validator: exhaustiveness for `match` over a union (named or
  anonymous); `loom.match-not-exhaustive`.
- Backends:
  - TS: discriminated union of tagged objects with `kind` literal
    (both forms lower identically).
  - .NET: sealed-record hierarchy with `[JsonDerivedType]`.
  - Phoenix: tagged unions via Ash's `tagged_unions` feature.
- Tests: parsing (both forms); exhaustiveness; per-backend emission
  tests asserting both forms produce identical lowered shapes.

**Critical decision pins needed before P4 lands**:
- Discriminator field name. **Recommended `kind`.** See D2.
- Anonymous `or` precedence vs postfix type constructors. **Recommended
  postfix tighter.** See D15.

**Exit criteria**: both `payload Foo = A | B` (named) and `A or B`
(anonymous inline) parse, type-check, and round-trip through every
backend with identical lowered output.

#### P5 — `validate for X` / `authorize for X` (~2 weeks)

**Scope**: cross-cutting rules targeting payload types.

**Deliverables**:
- Grammar: `validate for X { ... }`, `authorize for X { ... }` rules.
- IR: `ValidateForIR`, `AuthorizeForIR`.
- Lowering: insert checks at every operation that uses payloads of
  type X.
- Backends: per-backend insertion of validation/authorisation
  blocks at operation entry.

**Note**: A6 (exception-less validate-as-Result) depends on P5.
P5 ships standalone too — its initial form can still throw on
violation, with A6 re-targeting it later. Or P5 ships *with* Result
return shape from day one if A1-A2 are already in. Sequence guide
below.

### Track 2 — Aggregate inheritance (state)

Independent of payload work. Can ship in any order relative to
Track 1.

#### I1 — abstract aggregate keyword (~1 week)

**Scope**: `abstract aggregate Party { ... }` declaration. Validator
rejects instantiation attempts.

**Deliverables**:
- Grammar: `abstract` modifier on `AggregateDecl`.
- IR: `isAbstract: boolean` on `AggregateIR`.
- Validator: reject `repository Parties for Party` (where Party
  abstract); reject `Party.new(...)`.
- Backends: no emission for abstract aggregates beyond the type
  signature (no table, no repo, no routes).

#### I2 — `shared` storage strategy (~3 weeks)

**Scope**: TPH-style storage; one table per abstract base, with
concrete-discriminator column.

**Deliverables**:
- Grammar: `extends Party shared` on `AggregateDecl`.
- IR: `extendsAbstract: { kind: 'shared'; base: AbstractAggregateRef }`.
- Backends:
  - TS / Drizzle: shared base table; CTE for type-discrimination.
  - .NET / EF: TPH built-in; `[Discriminator]`.
  - Phoenix / Ash: shared table; resource-level filter.
- Validator: `Party id` references across concrete variants resolve
  correctly; `loom.cross-strategy-ref` checks.

#### I3 — `own` storage strategy (~2 weeks)

**Scope**: TPC-style storage; per-concrete tables, no base table.

Mostly parallel to I2; many of the same backend touches but different
emission shapes.

#### I4 — per-concrete override + TPT pattern docs (~1 week)

**Scope**: validator constraints for mixed-strategy hierarchies;
TPT-shape pattern documented via existing `contains` primitive (#477).
No new IR.

### Track 3 — Exception-less flow

#### A1 — stdlib `error` payloads + `none` / `option` + two-regime line (~2 weeks)

**Dependencies**: P3, P4 must be in (and P1's `error` keyword).

**Scope**: declare the `none` unit type and `option` carrier sugar
in `src/stdlib/payloads/`. Declare stdlib `error` payloads
(`NotFound`, `ParseError`, `ApiError` variants, `ValidationError`).
Validator enforces no-throw outside aggregate operation bodies (the
two-regime line). **No `Result<T, E>` or `Option<T>` named wrapper
types** — operations declare returns as `T or <Error>...` or
`T option` directly.

**Deliverables**:
- Stdlib:
  - `src/stdlib/payloads/none.ddd` — declare `none` unit type
    (with implicit `on wire 404` for return-position lowering).
  - `src/stdlib/payloads/option.ddd` — declare `option` as
    `payload option(T: carrier) = some(T) | none` (sugar for
    `T or none`).
  - `src/stdlib/payloads/errors.ddd` — `NotFound`, `ParseError`,
    `TransportFailure`, `UnexpectedStatus`, `DeserializeError`,
    `ValidationError` all declared as `error` payloads with their
    `on wire <Status>` clauses.
  - `src/stdlib/payloads/api_error.ddd` — convenience named union
    `payload ApiError = TransportFailure | UnexpectedStatus |
    DeserializeError`.
- Toolchain bootstrap: parse stdlib at startup; expose pre-declared
  types to user programs without explicit imports.
- Validator: `loom.throw-outside-domain` diagnostic. Walk operation
  bodies; reject `raise` / `throw`-shaped lowering unless enclosing
  context is an aggregate operation. (Phase-controlled: warning in
  A1, error after A4.)
- Backends:
  - TS: stdlib payloads emit as plain types in a generated
    `__loom_stdlib__.ts`. `some(T)` / `none` lower to tagged
    objects with `kind` literal.
  - .NET: per-instantiation sealed records; `none` is a singleton
    record.
  - Phoenix: typespec module + position-driven lowering — `option`
    is `T | nil` inside Elixir runtime, tagged on the wire (see
    exception-less.md "Per-backend lowering" decision).
- Wire spec: stdlib payload entries; each `error`'s `wireStatus`.
- Tests: parsing tests for declaring `: int option`, `: X or NotFound`
  as return types; negative throw-outside-domain test;
  `string option` desugar to `string or none`.

#### A2 — `?` propagation operator (~2 weeks)

**Dependencies**: A1.

**Scope**: postfix `?` on expressions of `or`-union or `option`
type. Error-variant dispatch. Per-backend lowering.

**Deliverables**:
- Grammar: postfix `?` in `Expression` rule with disambiguation
  from ternary `?:` (see exception-less.md "Grammar — `?`
  disambiguation" for the lookahead rule). Tokeniser update so the
  LSP highlights it distinctly from the type-suffix `?`.
- IR: `PropagateExprIR { inner, errorVariants, successVariants }`.
  The variant partition computed at lowering time from the
  operand's type and each variant's `error`-marker.
- Validator: enclosing-fn return type check; variant-subset rule
  (error variants of operand ⊆ error variants of enclosing return);
  `loom.propagate-bad-scope`, `loom.propagate-incompatible-error`.
- Backends:
  - TS: `const __r = expr; if (isErrorVariant(__r)) return __r;
    const x = __r;`. `isErrorVariant` is a small generated helper
    checking `kind` against the error-variant set.
  - .NET: per-project propagation helper with `IDomainError` marker
    interface implemented by every `error` record.
  - Phoenix: collapse multiple `?` in one body into one `with` block.
- Tests: per-violation scope tests; per-backend lowering tests;
  one end-to-end test threading three `?` calls.

#### A3 — per-`error` `wireStatus` enrichment + route emitters (~1.5 weeks)

**Dependencies**: A1.

**Scope**: per-error wire-status enrichment (the `on wire <Status>`
clause is parsed in P1; this phase consumes it). Each backend's
route emitter dispatches success vs error variants and emits the
appropriate status / body shape.

**Deliverables**:
- IR: `wireStatus: HttpStatus` on `error`-kind `PayloadDeclIR`
  (populated in P1; consumed here).
- Enrichment: pure pass; computes effective status for every
  `error` payload (default 500 if `on wire` clause absent).
- Backends:
  - TS Hono: route handler emits `if (isErrorVariant(result))
    return c.json(result, statusFor(result.kind)); return c.json(result, 200);`.
    Success body is the variant data directly (no `kind`
    envelope); error body is the variant data with the lifted
    status.
  - .NET: controller returns `ActionResult<T>`; switches on
    `result.kind` to pick `NotFound()` / `Conflict()` / `Ok(result)`.
  - Phoenix: action returns the value; route handler maps
    `%{kind: ...}` to `conn |> put_status(...) |> json(...)`.
- Validator: `loom.unmapped-err-variant` warning when an `error`
  payload has no `on wire`.
- Tests: per-backend emission tests asserting the status dispatch;
  one end-to-end test with an `error` variant returning a 4xx; one
  test asserting success bodies have NO `kind` envelope.

#### A4 — find-variant re-shape (~1 week, +2-3 days fixture re-baseline)

**Dependencies**: A1, A3.

**Scope**: return-type-driven find shape. `: X` → `X or NotFound`,
`: X?` → `X option` (= `X or none`), `: X[]` and `: X page`
unchanged.

**Deliverables**:
- IR: `src/ir/lower.ts` find-decl lowering wraps the declared
  return type into the appropriate carrier per the table.
- Backends: each repository builder returns the `or`-union shape
  directly (no Ok/Err wrappers); each route emitter deletes the
  try/catch for `NotFoundException` (A3 now covers it via
  per-variant status dispatch).
- Examples: every `examples/*.ddd` and `web/src/examples/*.ddd`
  audited; find call sites updated to use `?` where needed.
- Fixtures: **coordinated re-baseline** of `test/fixtures/`.
  Capture script: `scripts/capture-baseline-fixture.mjs`. Single
  PR.
- Validator upgrade: `loom.throw-outside-domain` becomes ERROR
  (was warning in A1).
- Tests: one e2e per backend asserting a `: X` find returns a 404
  on missing.

**Risk**: this is the big coordinated migration. **One PR**, no
splits. Block A5–A7 until A4 lands.

#### A5 — parse intrinsics + external API as `or`-returning (~1.5 weeks)

**Dependencies**: A1, A2.

**Scope**: parse and external API calls return `T or <Error>`.
Throwing helpers retired.

**Deliverables**:
- IR: `parse X from Y` expression lowers to `X or ParseError`.
- API client lowering: `call api Foo.bar(x)` lowers to a fetch
  returning `T or ApiError` (where `ApiError` is the stdlib named
  union of TransportFailure | UnexpectedStatus | DeserializeError).
  Macro-wrapped throwing helpers retired.
- Backends: per-backend update.
- Tests: per-backend.

#### A6 — `validate for X` returns `or`-union (~1.5 weeks)

**Dependencies**: A1, A2, P5.

**Scope**: validator bodies return `X or ValidationError[]` with
accumulated errors via the `combine` helper.

**Deliverables**:
- Lowering: `validate for X { ... }` emits a function returning
  `X or ValidationError[]`.
- Per-backend: invocation sites use `?` to propagate.
- Tests: multi-rule accumulation tests.

#### A7a — carrier stdlib helpers (~2 weeks; trickle-out OK)

**Dependencies**: A1.

**Scope**: per-instantiation monomorphic helpers (`.map`, `.flatMap`,
`.orElse`, `.orError`, `.mapErr`, `.combine`, plus cross-carrier
`Option.transpose`).

**Deliverables**:
- Per-backend code-gen for the helper set per used instantiation.
- TS: generic functions (free).
- .NET: per-instantiation static class.
- Phoenix: module function per instantiation; many collapse into
  Elixir stdlib calls.
- IR recognition: `opt.map(field)` lowers to `CarrierMapIR` rather
  than a general function call.
- Tests: per-helper, per-backend.

#### A7b — user-declarable carrier generics (DEFERRED)

Tracked here for completeness. Not v1.

## Coordinated migration moments

Three points in the plan where multiple proposals' work *must* land
together. Each gets its own PR but the PR must be self-contained
and pass CI:

### M1 — P3 + P4 together (carrier generics + tagged unions, both forms)

Reason: anonymous `or` unions are the first real consumer of
generics in real use, and `option` (= `T or none`) depends on
both. Shipping P3 without P4 leaves the type system half-built;
shipping P4 without P3 means no useful unions can be declared
(named or anonymous). **One PR, ~6 weeks total work; or two PRs
landing on the same release cut.**

### M2 — A1 + A2 + A3 together (minimum coherent ship)

Reason: without all three, authors can't declare typed errors
(A1), can't compose error-returning calls ergonomically (A2), or
can't return errors to HTTP (A3). Any subset is unusable in
practice. **One PR or three tightly-coupled stack PRs.**

### M3 — A4 alone but coordinated

Reason: every example .ddd, every backend repository builder, every
route emitter, every fixture changes. **One PR; no splits; don't try
to land it piecemeal across two release cuts.** Expect the PR to be
large (probably +2000/-2000 lines) and the fixture re-baseline to be
mechanical.

## Risk management

### Risk: parser ambiguity on `?`

Mitigation: pinned lookahead rule in exception-less.md §"Grammar —
`?` disambiguation". Implementing agent must update the Monaco
tokeniser AND the LSP grammar simultaneously when A2 lands.

### Risk: .NET per-instantiation explosion

A per-instantiation emission strategy for generics can produce many
files in projects with broad type use. Mitigation: deduplicate at
emission time via a `Map<InstantiationKey, EmittedSpec>` so each
unique instantiation emits once even if used in many places.
Estimate file count for the `examples/acme.ddd` showcase before A4
to validate the strategy scales.

### Risk: fixture re-baseline disturbs other work

A4 re-baselines every fixture. If A4 lands while other PRs are in
flight against the same fixtures, conflict resolution is mechanical
but tedious. Mitigation: schedule A4 during a quiet week and call a
fixture freeze 1 day before; merge any pending fixture-touching PRs
first.

### Risk: Phoenix lowering inconsistency

Pinned: `option` lowers to `T | nil` inside Elixir runtime, tagged
on the wire boundary. `or` unions with errors lower to either the
success value or the error map directly inside runtime; the wire
encoding uses status-code dispatch + body-as-variant-data on HTTP,
or tagged JSON on non-HTTP carriers. Mitigation: explicit codec at
the wire boundary per backend; one test per backend asserting wire
round-trip is identical.

### Risk: backwards compatibility breaks user code

A4 changes the return type of every find. Authors with deployed
projects need a migration path. Mitigation:
- Ship a codemod that converts existing find call sites: `let x =
  repo.find(y)` → `let x = repo.find(y)?` inside operation bodies.
- Or document the explicit `.unwrap()` for authors who want to
  preserve throwing behaviour at the call site.

### Risk: opt-in adoption stalls

If A1-A3 ship but authors don't migrate from throws, the two-regime
benefit is diluted. Mitigation:
- A4 forces migration on finds (most common throw source).
- A5 forces migration on parse / API calls.
- A6 forces migration on validators.
- Once A4-A6 are in, throws genuinely only fire from aggregate
  invariants. The validator's `loom.throw-outside-domain` ERROR
  upgrade after A4 catches regressions.

## Open decisions to pin before each phase

Most carry the doc's recommended answer; flagged below in
priority order.

| # | Question | Recommended | Block phase | Source doc |
|---|----------|-------------|-------------|------------|
| D1 | Carrier bound name (`carrier` / `value` / `data`) | **`carrier`** | P3 | payload-transport-layer.md |
| D2 | Discriminator field name for unions (`kind` / `type` / `_type`) | **`kind`** | P4 | payload-transport-layer.md |
| D3 | Variant-name-tagged vs structural identity for unions | **Variant-name-tagged** (pinned) | P4 | payload-transport-layer.md |
| D4 | Aggregate-in-carrier semantics (handle-in-process / wire-at-boundary) | **Handle-in-process, wire-at-boundary** (pinned) | A1 | payload-transport-layer.md |
| D5 | Should `Optional<T>` merge with `T option`? | **Yes; drop Optional entirely; PATCH semantics from `command` keyword + position-driven encoding** (pinned) | A1 | partial-update.md |
| D6 | `?` vs `try` propagation operator | **`?`** | A2 | exception-less.md |
| D7 | Default error type when `find: X` (no `?`) | **`NotFound` only in v1; per-aggregate override is v2** | A4 | exception-less.md |
| D8 | Default for an `error` payload with no `on wire` clause | **Warning, 500 fallback** (not error) | P1 / A3 | exception-less.md |
| D9 | Naming for `option`'s empty variant | **`none` (lowercase, lean)** vs `nothing`/`unit`/`void`/`nil` | A1 | exception-less.md |
| D10 | Two-regime enforcement strictness over time | **Warning A1–A3, ERROR after A4** | A1 → A4 | exception-less.md |
| D11 | Phoenix `option` runtime lowering (`T \| nil` vs `{:some, _} \| :none`) | **`T \| nil` runtime, tagged on wire** (pinned) | A1 | exception-less.md |
| D12 | Anonymous `or` vs named union — which to use where | **Anonymous for one-off return types; named for reusable catalogues. Guidance, not rule.** | P4 | payload-transport-layer.md |
| D13 | Aggregate-inheritance storage strategy default (`shared` vs `own`) | (held by aggregate-inheritance.md) | I2/I3 | aggregate-inheritance.md |
| D14 | Use-site syntax for parameterised payloads (postfix `customer page` vs prefix `page customer`) | **Postfix (ML)** (pinned; consistent with `Customer id` from #477; no angle brackets anywhere) | P3 | payload-transport-layer.md |
| D15 | Anonymous `or` precedence relative to postfix type constructors | **Postfix binds tighter than `or`** so `string or int option` parses as `string or (int option)`. Parens for the other reading. | P4 | payload-transport-layer.md |
| D16 | Success-body shape on HTTP 200 for `or` unions returning a primitive | **Bare value for primitives, payload-as-object for payloads; never the `kind` envelope on success path (status IS the discriminator)** | A3 | exception-less.md |
| D17 | Should `error` be a sugar keyword or `payload Foo extends error`? | **Sugar keyword (`error Foo { ... } on wire <Status>`)** (pinned) | P1 | payload-transport-layer.md |

**Workflow**: before starting each phase the implementing agent
should explicitly confirm the relevant decisions with the
maintainer (or accept the recommendation if not overridden). Don't
proceed past D1-D4 (and D14-D15 which influence grammar shape)
without a maintainer sign-off; the rest can take the recommended
answer.

## Test / CI gates per phase

Per CLAUDE.md, Loom has tiered test suites. Each phase needs:

- **Always (default `npm test`)**: parsing, validator, IR,
  generator unit tests for the phase's changes.
- **P3, P4, A1**: `LOOM_TS_BUILD=1`, `LOOM_REACT_BUILD=1`,
  `LOOM_DOTNET_BUILD=1`, `LOOM_PHOENIX_BUILD=1` — full multi-backend
  build gate. The structural lift in P3/P4 and the new stdlib in A1
  touch every backend's emission; we must catch backend drift.
- **A3, A4**: `LOOM_E2E=1` — full docker-compose stack + Playwright
  + OpenAPI parity. A3 changes status codes; A4 changes route
  shapes; both need end-to-end verification.
- **A5**: same gates as A4 for the API client / parse intrinsic
  changes.

Add new CI workflows where missing:
- `phoenix-build.yml` already exists.
- Carrier-stdlib coverage in `test.yml` for A7a.

## File-level changes summary

For the implementing agent:

| Area | Files most often touched |
|---|---|
| Grammar | `src/language/ddd.langium`, `src/language/ddd-scope.ts`, `src/language/ddd-validator.ts` |
| Generated parser | `src/language/generated/*` (regenerate via `npm run langium:generate` after every grammar change; gitignored — see CLAUDE.md) |
| IR | `src/ir/loom-ir.ts`, `src/ir/lower.ts`, `src/ir/lower-expr.ts`, `src/ir/enrichments.ts`, `src/ir/scaffold-expander.ts` |
| Type system | `src/language/type-system.ts` |
| TS backend | `src/generator/ts/index.ts`, `src/generator/ts/emit/*.ts`, `src/generator/ts/render-expr.ts`, `src/generator/ts/render-stmt.ts` |
| .NET backend | `src/generator/dotnet/index.ts`, emit files, render files |
| Phoenix backend | `src/generator/phoenix/index.ts`, `*-emit.ts`, `*-builder.ts`, render files |
| React backend | `src/generator/react/index.ts`, `body-walker.ts`, walker tests |
| System orchestrator | `src/system/wire-spec.ts` (carrier instantiation entries), `src/system/index.ts` |
| Stdlib | New: `src/stdlib/payloads/none.ddd`, `option.ddd`, `errors.ddd`, `api_error.ddd`, `page.ddd`, `envelope.ddd` |
| Examples | `examples/*.ddd`, `web/src/examples/*.ddd` (audit after A4) |
| Fixtures | `test/fixtures/*` (full re-baseline at A4) |
| CI | `.github/workflows/*.yml` (add carrier-stdlib gates) |

## Estimation rollup

| Track | Sum of phase weeks | Notes |
|---|---|---|
| Payload transport (P1–P5) | 10 | P3+P4 are the bulk (~6 of 10) |
| Aggregate inheritance (I1–I4) | 7 | Independent track; can run parallel |
| Exception-less (A1–A7a) | 11.5 | A1+A2+A3 stack together (~5.5); A4 is the migration spike |
| **Total** | **~28.5 weeks of focused work** | Parallel work can compress to ~18-22 calendar weeks |

Parallelism: a second implementer can take Track 2 (aggregate
inheritance) while the first is on Track 1. Track 3 must wait for
P3+P4 (M1).

## Definition of done for the whole effort

The three proposals are "done" when:

- [ ] Every existing example .ddd compiles and emits byte-identical
      output for the parts unchanged by the migration; updated
      portions emit the expected new shapes.
- [ ] `npm test` green, all `LOOM_*_BUILD=1` gates green.
- [ ] `LOOM_E2E=1` green against `examples/acme.ddd` and the
      playground showcase examples.
- [ ] Validator rejects throws outside aggregate operation bodies
      (`loom.throw-outside-domain` upgraded to ERROR).
- [ ] No remaining `try`/`catch` in generated route layer for
      domain-level errors (only at platform boundaries — DB
      transport, framework middleware).
- [ ] `docs/language.md`, `docs/generators.md`, `docs/technical.md`
      updated for the new surface.
- [ ] At least one fully-worked end-to-end example in `examples/`
      using `option`, anonymous `or` unions, `?`, `error` payloads
      with `on wire`, and an inheriting aggregate hierarchy.
- [ ] Catalog event sourcing updated: `not_found` events sourced
      from `NotFound`-variant encoding (not exception capture);
      `domain_error` sourced only from aggregate-invariant throws.
- [ ] Migration guide for downstream users (`docs/migrate-to-v1.md`
      or similar).

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  transport-layer source proposal.
- [`exception-less.md`](./exception-less.md) — exception-less source
  proposal.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — state-layer
  source proposal.
- [`partial-update.md`](./partial-update.md) — PATCH-style pattern
  using `command` + `option`-typed fields. Supersedes the v0
  `optional-and-partial-update.md`. D5 in the decisions table pins
  the merge.
- [`observability.md`](./observability.md) — catalog event sourcing
  shifts after A4-A6; envelope shape preserved.
- [`policies-supplementary-note.md`](./policies-supplementary-note.md)
  — `authorize for X` (P5) intersects the policy DSL work; see
  reconciliation notes there.
- CLAUDE.md — build & test commands, repository layout, conventions
  (use `lines(...)` from `src/util/code-builder.ts` for procedural
  emission; pluralisation/casing via `src/util/naming.ts`).
- `experience_gathered.md` — gotchas log; read before non-trivial
  work.
