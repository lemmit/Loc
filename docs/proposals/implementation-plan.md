# Implementation plan — aggregate inheritance, payload transport, exception-less flow

> **[2026-06-20 status audit]** The 2026-06-03 refresh is itself stale: `errors[]`, reified criteria, TPH, and `or`-unions are now on FIVE backends, not 'three'/'four' (`system-checks.ts:~1230`, `structural-checks.ts:~414`).

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** The "Phoenix / Ash" emission notes below describe the removed Ash foundation; the Phoenix backend now emits plain Ecto/Phoenix.

> Status: implementation plan. Operationalises three sibling
> proposals into one delivery stream:
>
> - [`aggregate-inheritance.md`](./aggregate-inheritance.md) — state
>   layer; abstract aggregates with `shared` / `own` storage.
> - [`payload-transport-layer.md`](./payload-transport-layer.md) —
>   transport layer; `payload` keyword, carrier-bounded generics,
>   tagged unions.
> - [`exception-less.md`](./exception-less.md) — `error` payloads,
>   `option` carrier, anonymous `or` unions (no `Result<T, E>`
>   wrapper), `?` propagation, API-edge ProblemDetails translation
>   (per-api `status` mapping + stdlib defaults), find-variant
>   re-shape.
> - [`criterion.md`](./criterion.md) — `criterion` declarations
>   (parameterised predicates over T, Spring-Data / Evans style)
>   bound to parameters via `from <Criterion>(args)`, to operation
>   guards via `when <Criterion>`. Replaces an earlier
>   `specification` design that bundled query shaping. Plus
>   `Repo.findAll(criterion, sort?, page?, loads?)` as built-in
>   repository method. Plus `private workflow` modifier +
>   workflow-calls-workflow for reusable mutating orchestration.
>
> Read all of these before starting. This doc covers ordering,
> coordination points, risk management, and decision pins.

> **⚠ 2026-06-10 update — read before following the tracks below.**
> Code-verified status moved substantially past the 2026-06-03 refresh
> (see the rewritten
> [`global-implementation-plan.md`](./global-implementation-plan.md)):
>
> - **The `?` propagation operator (A2) is DROPPED** (maintainer
>   decision). Its surface-only slice (#1030) is slated for removal —
>   skip every A2 step below and do not build A-track work on `?`.
>   The **M2 milestone (A1+A2+A3 together) is retired**; much of
>   A1/A3 shipped independently (root-level `payload`/`error`
>   declarations #1024, per-error `httpStatus` mapping, RFC 7807
>   `errors[]` on all three backends).
> - **P4 unions shipped** (named + anonymous `or` on
>   node/dotnet/elixir), so the **M1 milestone (P3+P4 together) is
>   retired** too; what's left of P3 is nested carriers, plus P5.
> - **Aggregate inheritance I1–I3 shipped** (TPC everywhere; TPH on
>   all three DB backends).
> - **Reified criteria are consumed at find/retrieval use-sites on
>   all four backends**; the remaining tail is capability-`filter`
>   reification + the principal factory.
>
> The A4 find-variant re-shape (one coordinated fixture rebaseline)
> remains the live coordinated moment. Direction for the remaining
> error-story work is [`failure-taxonomy.md`](./failure-taxonomy.md).

> **Landed since this plan was written (2026-06-03 refresh)** — adjust the
> tracks below accordingly; full PR detail in
> [`global-implementation-plan.md`](./global-implementation-plan.md):
> - **Payload P3b** — `Paged<T>` carrier + paged finds on all four backends
>   (the first real consumer of the carrier-generic surface).
> - **Criterion core** — declaration + validation + compile-time inline +
>   filter-capability targeting on all SQL backends (Crit1–2 substance).
> - **Reified-criteria (.NET/EF)** — the Specification reframe (`Criterion<T>`,
>   `ToExpression`, Ardalis `Specification<T>`); D23's tail, on one backend.
> - **Aggregate inheritance I1** — abstract aggregates + `inheritanceUsing(…)`
>   surface/IR/validators (no emission yet).
> - **Event-sourcing appliers** — `apply(...)` member + Hono and **.NET/EF**
>   event-store emission (the workflow-and-applier track, parallel to this one).
>
> The IR/generator paths in the "File-level changes" table below have been
> updated for the `src-ir-phase-reveal` reorg and the `lower`/`validate`
> decompositions.

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
4. **Exception-less A1+A2+A3** (`error` keyword + `option` + `?` +
   ProblemDetails translation at the api edge). The minimum coherent
   ship for the exception-less story.
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
A3: api `status` clause + ProblemDetails | A1                     | A4
A4: find-variant re-shape               | A1, A3                  | A5 (some find call sites)
A5: parse + external API as Result      | A1, A2                  | (none)
A6: validate for X returns Result       | A1, A2, P5              | (none)
A7a: carrier stdlib helpers             | A1                      | (none)
A7b: user-declared carrier generics     | A1, A4 (DEFERRED)       | (deferred to v2)
Crit1-4: criteria + from/when + Repo.findAll | A1, A2, A6             | (none — feeds D23 resolution)
Crit5: workflow-calls-workflow + private | A1                       | (independent of Crit1-4; can land any order)
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
— pure data shape, no status clause (domain stays HTTP-blind; status
mapping is the api surface's job, A3).

**Deliverables**:
- Grammar: `payload` rule + `error` rule in `src/language/ddd.langium`.
  `error` parses like `payload` with a different `kind` tag.
- IR: `PayloadDeclIR` node with `kind: 'payload' | 'event' |
  'command' | 'query' | 'response' | 'error'` (in
  `src/ir/loom-ir.ts`). No status field on the IR.
- Enrichment: `src/ir/enrichments.ts` upgrade pass for the existing
  four sugars; pass-through for `error`.
- Backends: no emission change yet (existing four sugars still emit
  as today; `error` payloads emit as a sealed record / typed map,
  pending A3 to consume them at the api edge).
- Tests: parsing for `payload`, `error <Name> { ... }`; verify no
  status surface at this layer.

**Exit criteria**: `npm test` green; existing examples unchanged
(no `error` declarations yet in user code).

#### P2 — `<Agg>Wire` auto-synthesis (~1 week)

**Scope**: every aggregate gets an auto-synthesised
`<AggName>Wire` payload visible in the type system. No emission
change in user-facing generated code.

**Deliverables**:
- Enrichment: extend the existing `wireShape` enrichment to also
  expose a `PayloadDeclIR` with name `<Agg>Wire`.
- Validator: allow `response: CustomerWire`, `CustomerWire page`, etc. in operation/find return positions (ML-postfix per P3 syntax).
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
  - Phoenix: tagged unions (plain Ecto/Phoenix).
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
  - Phoenix: shared table; row-level filter (plain Ecto/Phoenix).
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
(`NotFound`, `ParseError`, `ApiError` variants, `ValidationError`,
`PreconditionFailed`). Validator enforces the layer-specific
failure model: aggregate operation bodies can throw on
invariant/precondition; workflow bodies prefer typed `or` returns;
aggregate operation bodies **cannot** call `Repo.<find>` /
`Repo.<getById>` / externs / `call api` (loading other aggregates
is workflow business per `docs/workflow.md`). **No `Result<T, E>`
or `Option<T>` named wrapper types** — operations / workflows
declare returns as `T or <Error>...` or `T option` directly.

**Deliverables**:
- Stdlib (`.ddd` files — pure shape, no status info):
  - `src/stdlib/payloads/none.ddd` — declare `none` unit type.
    The "404 at return position" semantic is in the generator's
    api-edge translator, not on the declaration.
  - `src/stdlib/payloads/option.ddd` — declare `option` as
    `payload option(T: carrier) = some(T) | none` (sugar for
    `T or none`).
  - `src/stdlib/payloads/errors.ddd` — `NotFound`, `ParseError`,
    `TransportFailure`, `UnexpectedStatus`, `DeserializeError`,
    `ValidationError`, `Forbidden` declared as `error` payloads. No
    status annotations. (No `PreconditionFailed` — preconditions
    throw; route maps `PreconditionViolation` exception class to
    400/500 per layer.)
  - `src/stdlib/payloads/api_error.ddd` — convenience named union
    `payload ApiError = TransportFailure | UnexpectedStatus |
    DeserializeError`.
  - `src/stdlib/payloads/problem_details.ddd` — RFC 7807
    `ProblemDetails { type: string?, title: string, status: int,
    detail: string?, instance: string? }`.
- Generator-side stdlib status table:
  `src/system/error-defaults.ts` (new). Hardcoded
  `{ NotFound: 404, ValidationError: 422, ParseError: 400,
  Forbidden: 403, TransportFailure: 502, UnexpectedStatus: 502,
  DeserializeError: 502, none: 404 }`. Plus exception-class → status
  mappings: `{ PreconditionViolation (workflow-level): 400,
  PreconditionViolation (aggregate-op): 500 with env-aware exposure,
  InvariantViolation: 500 with env-aware exposure }`. Not in any
  `.ddd`.
- Toolchain bootstrap: parse stdlib at startup; expose pre-declared
  types to user programs without explicit imports.
- Validator — layer-specific rules:
  - `loom.aggregate-cannot-orchestrate` (ERROR): aggregate
    operation bodies cannot contain `Repo.<find>` / `Repo.<getById>` /
    extern / `call api` expressions. Loading other aggregates is
    workflow-only.
  - `loom.workflow-prefers-error` (WARNING; phase-controlled —
    informational in A1-A3, suggested in A4+): workflow bodies
    should prefer typed `or` returns over throws for expected
    failures.
- Workflow `precondition` lowering: `precondition Expr` stays
  throw-based (today's behaviour); throws `PreconditionViolation`
  tagged with workflow-level origin. The route's ProblemDetails
  translator (A3) maps workflow-level `PreconditionViolation` → 400
  with rule text in `detail`; aggregate-op-level
  `PreconditionViolation` → 500 with env-aware exposure (the api
  client shouldn't see internal contracts between workflow and
  aggregate; that's a bug from their perspective).
- Backends:
  - TS: stdlib payloads emit as plain types in a generated
    `__loom_stdlib__.ts`. `some(T)` / `none` lower to tagged
    objects with `kind` literal.
  - .NET: per-instantiation sealed records; `none` is a singleton
    record.
  - Phoenix: typespec module + position-driven lowering — `option`
    is `T | nil` inside Elixir runtime, tagged on the wire (see
    exception-less.md "Per-backend lowering" decision).
- Wire spec: stdlib payload entries. Per-api `errorStatuses`
  (added in A3) are also captured but emitted from a separate
  enrichment.
- Tests: parsing tests for declaring `: int option`,
  `: X or NotFound` as workflow / operation return types;
  `loom.aggregate-cannot-orchestrate` negative test (aggregate
  body using `Repo.getById` rejected); workflow `precondition`
  test asserting throw + 400 ProblemDetails translation;
  aggregate-op `precondition` test asserting throw + 500 with
  env-aware exposure; `string option` desugar to `string or
  none`.

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

#### A3 — API-surface `status` clause + ProblemDetails translation (~2 weeks)

**Dependencies**: A1.

**Scope**: status mapping lives in the api surface (NOT on error
declarations). Per-api `errorStatuses` enrichment merges stdlib
defaults with author-declared overrides. Each backend's route
emitter auto-generates the ProblemDetails translator.

**Deliverables**:
- Grammar (`src/language/ddd.langium`): `status <ErrorTypeRef>
  <IntegerLit>` clause inside `api Foo for Bar { ... }` blocks.
  Zero or more lines.
- IR (`src/ir/loom-ir.ts`): `errorStatuses: Map<ErrorTypeName,
  HttpStatus>` on `ApiIR`. Populated from the AST clauses.
- Enrichment (`src/ir/enrichments.ts`): per-api, merge generator-side
  stdlib defaults (`src/system/error-defaults.ts`) with the per-api
  `status` overrides. Result: a complete map for every error type
  the api can encounter.
- Backends:
  - TS Hono: helper `toProblemDetails(value, errorStatuses, instance)`
    that builds the RFC 7807 JSON object (status from map; title
    prettified; type as `/errors/<kebab>`; detail interpolated;
    extension members from error fields). Route handler matches
    on the variant: success → `c.json(value, 200)`; error variant
    → `c.json(toProblemDetails(...), pd.status)`.
  - .NET: per-api `IExceptionHandler` + per-route filter using
    the same map. Idiomatic ASP.NET Core wiring; Loom generates
    it. Aggregate-invariant throws hit the global handler →
    500 ProblemDetails with `type: "/errors/internal"`.
  - Phoenix: action returns the value; route handler dispatches
    via `ProblemDetails.from/2` and `conn |> put_status(pd.status)
    |> json(pd)`. Aggregate exceptions hit a Plug.ErrorHandler
    fallback that emits the same 500 ProblemDetails shape.
- **Env-aware 500 body** (D21). Generator emits a `buildInternalErrorBody`
  helper per backend that reads `LOOM_EXPOSE_INTERNAL_ERRORS`
  (defaulting from the native dev/prod check). Two body shapes:
  - `expose=true`: ProblemDetails + `_exception` / `_stack` /
    `_state` extension members.
  - `expose=false`: minimal ProblemDetails + correlation id in
    `detail`.
  Sensitive fields (per `sensitivity-and-compliance.md`)
  redacted in either mode. Catalog `invariant_violated` event
  carries full context regardless.
- Validator: `loom.unmapped-error-status` warning when an error
  type flows into an api but is in neither the per-api `status`
  list nor the stdlib defaults.
- Wire spec: per-api `errorStatuses` captured in
  `<outdir>/.loom/wire-spec.json` so status drift surfaces in CI
  diffs.
- Tests: parsing test for the api `status` clause; per-backend
  emission test for the ProblemDetails shape; one end-to-end test
  with a 4xx ProblemDetails body; one test asserting success
  bodies carry NO `kind` envelope and NO ProblemDetails wrapping;
  one test per backend asserting aggregate-invariant throws yield
  the 500 ProblemDetails fallback with the catalog event logged;
  **one test per backend with `LOOM_EXPOSE_INTERNAL_ERRORS=true`
  asserting `_exception`/`_stack`/`_state` are present and
  sensitive fields are redacted**; one test with
  `LOOM_EXPOSE_INTERNAL_ERRORS=false` asserting the minimal body
  shape with correlation id.

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

### Track 4 — Criteria + Repo.findAll + workflow-calls-workflow (Phase Crit)

Independent of A4 / find-variant re-shape; can land before or after.
Lands after A6 (`?` propagation + `validate for X` stable).
Resolves D23. Full spec: [`criterion.md`](./criterion.md).

#### Crit1 — Grammar + IR (~1 week)

- Grammar: `criterion <Name>(<Param>*) of <T> = <bool expr>` and
  `criterion <Name>(<Param>*) of <T> { where: <bool expr> }`
  declarations; `from <Criterion>(args)` clause on Parameter /
  CommandField; `when <expr>` clause on Operation.
- Built-in shape types: `SortClause`, `Sort`, `Page`,
  `PathExpression` (for `loads:` arg, syntax shared with
  load-specifications.md).
- IR: `CriterionDeclIR`; `FromBindingIR` on Parameter / CommandField;
  `WhenClauseIR` on Operation.

#### Crit2 — Body purity + composition (~1 week)

- Walker checks `where:` body constraints; rejects mutation,
  aggregate-op calls that mutate, `emit`, workflow calls
  (`loom.criterion-impure`), non-queryable forms
  (`loom.criterion-not-queryable`).
- Composition operators `&&` / `||` / `!` on criteria yield
  combined criterion IR.
- Cycle detection: criteria referencing each other
  (`loom.criterion-cycle`).
- `when` clause expression validator: `loom.when-references-op-param`,
  `loom.when-inline-list`.

#### Crit3 — Auto-injection at api wrappers (~1.5 weeks)

- Wrapper-synthesis lowering: per `from <Criterion>(args)` binding,
  inject load + check + `CriterionFailed` return.
- Per `when <Criterion>` clause, inject the gate before op invocation;
  on false → `Disallowed`. Auto-expose
  `GET /aggregates/<agg>/{id}/can-<op>` endpoint.
- Operation-call lowering: at every `agg.op(args)?` expansion,
  inject the `when` gate (auto-injection at every call site, not
  just api wrappers — consistency rule).
- Stdlib: `error CriterionFailed { criterion, paramName,
  id, value } (status 422)`; `error Disallowed { operation,
  aggregate, id, reason? } (status 409)`.
- OpenAPI emission: criterion constraints surface as schema
  extensions; `can-<op>` endpoints documented.

#### Crit4 — Repo.findAll per-backend (~1.5 weeks)

- Per-backend translation: criterion → SQL WHERE (per ORM); sort →
  ORDER BY; page → LIMIT/OFFSET; loads → JOINs / SELECT-includes /
  EntityGraph (uses path syntax from `load-specifications.md`).
- TS / Drizzle: typed query builder.
- .NET / EF Core: IQueryable chain.
- Phoenix: Ecto query DSL (plain Ecto/Phoenix).
- UI form-generator: auto-derives `<select>` options by executing
  the criterion against the repository at binding sites; React
  form-generator integration.
- Built-in `Repo.findAll(criterion, sort?, page?, loads?)` method on
  every repository (no explicit `find` declaration needed for
  generic list queries).

#### Crit5 — workflow-calls-workflow + `private workflow` (~1 week)

Independent of Crit1-4; can ship before or after.

- Grammar: workflow-call expression (`OtherWorkflow(args)`) in
  workflow body; `private` modifier on workflow declaration
  (reusing existing convention from `private operation` /
  `private invariant`).
- IR: `WorkflowCallStmtIR`; `isPrivate: boolean` on `WorkflowIR`.
- Validator: workflow-call cycle detection (`loom.workflow-cycle`);
  visibility check — private workflows skipped from api
  auto-exposure (`loom.private-workflow-exposed`).
- Transactional inheritance: lowering pass implements the
  caller-callee transaction shape per `criterion.md`
  §"Transactional semantics".
- Per-backend emission: workflow-calls-workflow lowers to direct
  function call (TS / Phoenix) or Mediator handler call (.NET).

**Crit total: ~6 weeks** (Crit1-4 ~5; Crit5 ~1). Independent of
A4; can ship before or after.

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
| D8 | Default for a user `error` with no `status` line in any api surface | **Warning (`loom.unmapped-error-status`), 500 ProblemDetails fallback** | A3 | exception-less.md |
| D9 | Naming for `option`'s empty variant | **`none` (lowercase, lean)** vs `nothing`/`unit`/`void`/`nil` | A1 | exception-less.md |
| D10 | Two-regime enforcement strictness over time | **Warning A1–A3, ERROR after A4** | A1 → A4 | exception-less.md |
| D11 | Phoenix `option` runtime lowering (`T \| nil` vs `{:some, _} \| :none`) | **`T \| nil` runtime, tagged JSON at the wire** (pinned) | A1 | exception-less.md |
| D12 | Anonymous `or` vs named union — which to use where | **Anonymous for one-off return types; named for reusable catalogues. Guidance, not rule.** | P4 | payload-transport-layer.md |
| D13 | Aggregate-inheritance storage strategy default (`shared` vs `own`) | (held by aggregate-inheritance.md) | I2/I3 | aggregate-inheritance.md |
| D14 | Use-site syntax for parameterised payloads (postfix `customer page` vs prefix `page customer`) | **Postfix (ML)** (pinned; consistent with `Customer id` from #477; no angle brackets anywhere) | P3 | payload-transport-layer.md |
| D15 | Anonymous `or` precedence relative to postfix type constructors | **Postfix binds tighter than `or`** so `string or int option` parses as `string or (int option)`. Parens for the other reading. | P4 | payload-transport-layer.md |
| D16 | Success-body shape on HTTP 200 for `or` unions returning a primitive | **Bare value for primitives, payload-as-object for payloads; never the `kind` envelope on success path (status IS the discriminator)** | A3 | exception-less.md |
| D17 | Should `error` be a sugar keyword or `payload Foo extends error`? | **Sugar keyword (`error Foo { ... }`, no status clause — domain stays HTTP-blind)** (pinned) | P1 | payload-transport-layer.md |
| D18 | Where status mapping lives | **In the api surface as `status <Error> <Code>` lines; stdlib defaults in the generator's `src/system/error-defaults.ts`; domain `error` declarations carry no status** (pinned) | A3 | exception-less.md |
| D19 | Per-error customisation of ProblemDetails `type` URI / `title` / `detail` template | **Deferred to v2**. v1 auto-derives all fields except `status` (which comes from the api mapping). | A3 | exception-less.md |
| D20 | Per-surface mappings beyond the api layer (UI / queue / CLI) | **Out of scope.** UI consumes ProblemDetails like any HTTP client; no language-level UI error-mapping surface. Queue / CLI deferred to v2 when those surfaces become real. | — | — |
| D21 | Env-aware 500-ProblemDetails body (dev shows internals, prod redacts) | **`LOOM_EXPOSE_INTERNAL_ERRORS` env var; defaults from each backend's native dev/prod check** (TS `NODE_ENV !== "production"`, .NET `IHostEnvironment.IsDevelopment()`, Phoenix `:dev`/`:test`). Catalog event always carries full context; sensitive fields stay redacted even in dev. | A3 | exception-less.md |
| D22 | Workflow `precondition` — typed return vs throw | **Throws** (pinned, flipped from earlier draft). Preconditions are *guards*, not designed business outcomes — bug-shaped, not user-recoverable. Route translates: aggregate-op `PreconditionViolation` → 500 (env-aware); workflow-level `PreconditionViolation` → 400 (rule text safe to surface). Designed-in business outcomes use typed `or` returns, not `precondition`. | A1 | exception-less.md |
| D23 | Cross-aggregate domain rule pattern | **Resolved**: `criterion <Name>(args) of T = <bool expr>` declarations bound to parameters via `from <Criterion>(args)` and to operation guards via `when <Criterion>`. Spring-Data / Evans style — pure predicate, composable via `&&`/`||`/`!`. Query shaping (sort, page, loads) is per-call to `Repo.findAll`, not on the criterion. See [`criterion.md`](./criterion.md). | Phase Crit | criterion.md |
| D24 | Criterion name (full vs abbreviated) | **`criterion`** (pinned). Loom doesn't abbreviate keywords (`view`, `aggregate`, `workflow` are all full). Replaces an earlier `specification` name; "criterion" aligns with Spring Data / Hibernate Criterion convention for the predicate-only construct. | Phase Crit | criterion.md |
| D25 | Bind keyword (parameter ↔ criterion) | **`from <Criterion>(args)`** (pinned). Reads as "parameter drawn from the set defined by this criterion". | Phase Crit | criterion.md |
| D26 | Criterion-mismatch error variant | **Generic stdlib `CriterionFailed { criterion, paramName, id, value }`** (default status 422; api-surface override available). Per-criterion custom error variants deferred to v2. | Phase Crit | criterion.md |
| D27 | Reusable cross-aggregate mutating orchestration | **`private workflow X { ... }`** (reuses existing `private` modifier from `private operation` / `private invariant`). Plus workflow-calls-workflow body extension. No separate `service` keyword. | Crit5 | criterion.md |
| D28 | Workflow-calls-workflow transactional semantics | **Callee inherits caller's transaction**. If caller is non-transactional, callee's own `transactional` annotation activates its own scope. No nested-savepoint magic; single-level transaction lifetime per top-level workflow call. | Crit5 | criterion.md |
| D29 | `when <predicate>` clause on aggregate operations (canCommand pattern) | **`operation X(...) when <predicate> { ... }`**. Predicate reads `self` (aggregate-implicit), `currentUser` (ambient), aggregate functions, and criteria. **Parameterless w.r.t. op parameters** (per NakedObjects' split — per-arg checks go through `from <Criterion>` on the parameters). Auto-exposed `GET /aggregates/<agg>/{id}/can-<op>` query alongside the existing POST endpoint. Stdlib `error Disallowed { operation, aggregate, id, reason? }` default status 409. | Phase Crit | criterion.md |
| D30 | Repository list query method | **Built-in `Repo.findAll(criterion, sort?, page?, loads?)`** on every repository (no explicit declaration needed for generic list queries). Solves "repository with 40 methods" via criterion composition + call-site shaping. Spring-Data analog of `JpaSpecificationExecutor.findAll(spec, pageable)`. | Crit4 | criterion.md |
| D31 | Default load semantics | **Default = whole aggregate** loaded (all own fields, all containments). Cross-aggregate references stay as ids unless `loads:` arg requests eager hydration. `loads:` is optional optimisation, not requirement. **v1 has explicit `loads` only; no inference/shape-typing/`is loaded` narrowing in v1** (v2 roadmap). | Crit4 | load-specifications.md |
| D32 | Repository finds with criteria | **Named `find <name>(args)` declarations on repositories support criterion `where` clauses + `orderBy` + `take` + `skip` + `loads`** — same vocabulary as `findAll`'s call-site args. Named finds are the **stable named** form (e.g., `Orders.latestActive(20)`); `findAll` is the **ad-hoc** form. Both compose with criteria; not substitutes. | Crit4 | criterion.md |
| D33 | `findAll` without explicit `page:` | **Warning** `loom.findAll-no-page` (not error — some legitimate use cases need full lists). Authors who want bounded reads supply `page: { offset, limit }` explicitly. | Crit4 | criterion.md |
| D34 | Evaluation order for `requires` (auth) + `when` (state) on same operation | **`requires` first → 403 if unauthorised; `when` second → 409 if state-blocked.** Auth before state-reveal — don't tell an unauthorised caller anything about state. Mirror in the `can-<op>` query. | Crit3 | criterion.md |
| D35 | `when` clause and aggregate inheritance | **Inherited from abstract operation; applies to every concrete subtype.** Predicate's `self` resolves to the concrete via standard inheritance dispatch (TPH discriminator / TPC table / TPT join). Concrete-subtype `when` override deferred to v2. | Crit3 | criterion.md |
| D36 | Sort field reference syntax | **Bare names + `asc`/`desc`** (matches `view ... where ...` declarative style + `invariant`/`derived` field-on-self convention). `[name asc, customer.tier desc]` — paths resolve against the criterion's aggregate type. Not lambda-style — lambdas are for in-body collection ops (`.where(x => ...)`), declarative clauses use bare names. | Crit1 | criterion.md |
| D37 | `Repo.find(criterion)` for single-result | **New built-in** alongside `findAll`. Returns `T or NotFound`. Distinct from id-based `getById(id)` (returns `T or NotFound` via exception-less A4) and `findById(id)` (returns `T option`). Criterion-based vs id-based; both coexist. | Crit4 | criterion.md |

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
| IR | `src/ir/types/loom-ir.ts`; `src/ir/lower/` (`lower.ts` orchestrator + per-declaration-kind leaves + `lower-expr.ts` / `lower-stmt.ts` / `lower-types.ts` + `walker-primitive-expander.ts`); `src/ir/enrich/enrichments.ts`; `src/ir/validate/` (`validate.ts` + `checks/*`) — **post the `src-ir-phase-reveal` + lower/validate decompositions** |
| Type system | `src/language/type-system.ts` |
| TS backend | `src/generator/typescript/index.ts`, `src/generator/typescript/emit/*.ts`, `render-expr.ts`, `render-stmt.ts` (note: the dir is `typescript/`, not `ts/`) |
| .NET backend | `src/generator/dotnet/index.ts`, `emit/*.ts`, `cqrs/*` (post-#869 split), render files |
| Phoenix backend | `src/generator/phoenix-live-view/index.ts`, `*-emit.ts`, `domain/*` (post-#912 split), `*-builder.ts`, render files |
| React backend | `src/generator/react/index.ts`, `body-walker.ts`, walker tests |
| System orchestrator | `src/system/wire-spec.ts` (carrier instantiation entries), `src/system/index.ts` |
| Stdlib | The stdlib home is `src/ir/stdlib/` (today `generics.ts`). New payload `.ddd` files (`none`, `option`, `errors`, `api_error`, `problem_details`, `page`, `envelope`) land here — all HTTP-blind, no status info on declarations. |
| Generator | New: `src/system/error-defaults.ts` — hardcoded stdlib status table consumed by every backend's api-edge translator. |
| Examples | `examples/*.ddd`, `web/src/examples/*.ddd` (audit after A4) |
| Fixtures | `test/fixtures/*` (full re-baseline at A4) |
| CI | `.github/workflows/*.yml` (add carrier-stdlib gates) |

## Estimation rollup

| Track | Sum of phase weeks | Notes |
|---|---|---|
| Payload transport (P1–P5) | 10 | P3+P4 are the bulk (~6 of 10) |
| Aggregate inheritance (I1–I4) | 7 | Independent track; can run parallel |
| Exception-less (A1–A7a) | 11.5 | A1+A2+A3 stack together (~5.5); A4 is the migration spike |
| Criteria (Crit1–4) + Crit5 (workflow-calls) | 6 | Independent of A4; lands after A6 |
| **Total** | **~33 weeks of focused work** | Parallel work can compress to ~20-24 calendar weeks |

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
- [ ] `docs/workflow.md` updated for the body-vocabulary additions:
      workflow-call expression (`OtherWorkflow(args)?`), `private`
      modifier on workflow declarations, `Repo.find(criterion)` /
      `Repo.findAll(criterion, ...)` built-in methods, optional
      `loads:` argument on `Repo.getById` / `findById` / `find` /
      `findAll`. Cover transactional inheritance for
      workflow-calls-workflow. Update body-vocabulary table.
- [ ] `docs/views.md` updated to note that views may use a criterion
      as their `from <Criterion>` source (additive to inline `where`).
- [ ] `docs/auth.md` updated for `requires` + `when` evaluation
      order on operations: `requires` first (403 if unauthorised),
      `when` second (409 if state-blocked).
- [ ] `docs/language.md` repository section updated for named
      `find <name>(args)` declarations gaining criterion `where`
      clauses + `orderBy` / `take` / `skip` / `loads`.
- [ ] At least one fully-worked end-to-end example in `examples/`
      using `option`, anonymous `or` unions, `?`, `error` payloads
      with api-surface `status` mappings (showing ProblemDetails
      responses), and an inheriting aggregate hierarchy.
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
