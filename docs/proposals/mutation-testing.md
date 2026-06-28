# Mutation Testing in Loom — Solution Proposal

> Status: **proposal / not yet implemented**. This document is a design and
> delivery plan, not a description of existing behaviour. It supersedes the
> informal concept note that motivated it.
>
> Refreshed 2026-06-28: paths + backend count updated to the post-refactor tree
> (five logic backends; the expression renderers now share one `renderExprWith`
> dispatcher). Added §9 (mutation as the verification gate + trigger model), the
> structural-mutation tier note (§4.A), and the `extern` guarantee-hole
> limitation (§3).

## 1. Thesis

Conventional mutation-testing tools are slow because they mutate *blindly* —
every statement in the codebase is a candidate, the vast majority of which is
boilerplate (DTOs, mappers, routing, persistence). The result is thousands of
mutants, most of them either trivially killed or equivalent, and runtimes in
the minutes-to-hours range.

Loom does not have this problem, because **Loom already knows which code is
domain logic and which is boilerplate.** The Loom IR is a fully-resolved,
platform-neutral model in which business rules are first-class nodes
(`InvariantIR`, `precondition`/`requires` statements, `DerivedIR`,
`FunctionIR`), structurally separate from the generated scaffolding. We can
therefore instrument *only* the logic worth mutating, across all five
logic-executing backends, from a single IR-level transform — and get the
"~90% fewer mutants" benefit by construction rather than by heuristic.

This proposal describes how to add that capability while respecting Loom's
one-directional pipeline and, critically, its byte-identical-output contract.

## 2. How this maps onto Loom's architecture

| Concern | Where it lives today | What we exploit |
|---|---|---|
| Domain conditions | `InvariantIR`, `StmtIR` `precondition`/`requires`, `DerivedIR`, `FunctionIR.body` (all in `src/ir/types/loom-ir.ts`) | These are the *only* nodes we instrument. Boilerplate templates never touch them. |
| Expression model | `ExprIR` union, `BinOp`, `LiteralKind` (`src/ir/types/loom-ir.ts`) | Fully resolved — every node carries `refKind`/`memberType`/`op`. Lets us mutate and prune type-soundly. |
| Rendering | the shared dispatcher `renderExprWith` + per-backend `ExprTarget` leaf tables (`src/generator/_expr/target.ts`; `TS_TARGET`/`CS_TARGET`/`ELIXIR_TARGET`/`PY_TARGET`/`JAVA_TARGET`) | **One** injection point, not one-per-backend: the 17-arm `ExprIR.kind` dispatch lives once in `renderExprWith`, so a mutated `ExprIR` renders for free in every backend's syntax. Post-refactor this is *more* centralized than this proposal originally assumed — there are no longer separate per-backend `render-expr` dispatchers to hook. |
| Derivations | `enrichLoomModel` (`src/ir/enrich/enrichments.ts`) — one pure, idempotent pass | The natural home for assigning stable mutation IDs. |
| Backend dispatch | `PlatformSurface` (`src/platform/surface.ts`), registry (`src/platform/registry.ts`) | The seam for a gated "instrumented" emit mode. |

Three structural facts drive the entire design:

1. **One transform feeds five backends.** Mutating `ExprIR` and re-rendering
   through the shared `renderExprWith` dispatcher means we never write
   backend-specific mutation logic. TS, C#, Elixir, Python, and Java mutants are
   produced byte-correctly by code that already exists.
2. **The fixture contract is sacred.** Loom's CI gates on byte-identical
   generated output (`test/fixtures/`, the React-build matrix, the `tsc`
   suites). Instrumentation *must* be a separate, opt-in emit mode; the default
   path must remain byte-for-byte unchanged or every fixture and the production
   codegen break.
3. **"Full-stack" means the logic backends only.** The frontends (React, Vue,
   Svelte, Angular) consume wire shapes and run no domain logic, so they have no
   `ExprTarget`. Mutation applies to the five logic backends — TS/Hono, .NET,
   Phoenix LiveView, Python/FastAPI, Java/Spring. The frontends are out of scope.

## 3. Non-goals / constraints

- **No change to default output.** Instrumented emission is gated behind an
  explicit flag / platform-surface variant. Fixtures never exercise it.
- **React is excluded** — no domain logic to mutate there.
- **The e2e suite is not the fast loop.** It boots Docker and is not pure; the
  fast in-memory loop targets the generated unit suite only. E2e can still be
  used for mutants only reachable through stateful operations.
- **No new DSL surface required for v1.** We instrument what the IR already
  classifies. A future `@no-mutate` style annotation is possible but not
  needed to ship.
- **`extern` bodies are unmutatable — a guarantee hole, not just a skip.**
  `operation … extern` and `function … extern` bodies are hand-written and live
  off the IR, so mutation cannot instrument them. A requirement whose domain
  logic sits behind an extern is therefore *un-gateable*: its tests can be green
  and toothless and mutation will never know. This is the mutation-side
  statement of the ports/adapters boundary — keep verifiable domain logic inside
  the DSL precisely so the gate can see it, and treat every extern as a spot
  where the VERIFIED verdict (§9) silently weakens. Worth surfacing in the
  report ("N requirements depend on extern logic the gate cannot check").

## 4. Design

### 4.A Instrumentation surface — what we mutate

Exactly the nodes the IR already marks as domain logic:

- `InvariantIR.expr` (and `.guard` when present) — on aggregates, entity
  parts, and value objects.
- `StmtIR` of kind `precondition` and `requires`.
- `DerivedIR.expr` — computed predicates (`isActive`, `canApprove`, …).
- `FunctionIR.body` — pure boolean/arith functions.

We do **not** mutate identity/structure: `id`, `this`, `new`/`object` field
names, `argNames`, `enumName`, or refs resolving to `current-user`.

**Scope note — mutation ⊋ expression mutation.** v1 mutates *expressions*
(`ExprIR`). Some of the highest-teeth mutants are *structural deletions* that no
`ExprIR → ExprIR[]` operator can reach; they are deferred to a future
**structural-mutation tier**:

- remove an `InvariantIR` / `precondition` / `requires` *entirely* (not merely
  weaken its operator);
- drop an `emit EventName {…}` statement — state still changes, no event fires;
- drop a capability `stamp` or `filter` — the audit column goes unset, or the
  soft-delete filter is removed and tombstoned rows leak into `findAll`;
- skip a workflow ordering rule / state transition.

The capability deletions matter most: `stamp`/`filter` are exactly the
cross-cutting rules a happy-path test routinely never asserts, so a survivor
there is high-signal. They are out of v1 scope but should be *designed for* —
the IDs, runner, and verdict wiring are mutation-kind-agnostic; only the
operator surface widens.

### 4.B Stable mutation IDs

Each mutable expression position gets a deterministic ID derived from its
structural path, e.g.:

```
<context>.<aggregate>.<member-kind>.<member-name>.<expr-path>.<opcode>
# e.g. sales.Order.invariant.0.cond.left.ROR_GE
```

Determinism matters for two reasons: the baseline (coverage) build and the
mutation build must agree on IDs, and the runner maps mutants → covering tests
by ID. IDs are assigned in a dedicated enrichment sub-pass (`enrichments.ts`),
keeping the rest of the pipeline unaware of them.

### 4.C IR-level mutation operators: `mutate(e: ExprIR) → ExprIR[]`

A pure module in `src/ir/` (knowing nothing about backends or the runner)
turns one expression into its first-order mutants.

**Operator catalogue** (mapped to Loom's actual `BinOp`/`unary.op`):

| Class | Applies to | Mutation |
|---|---|---|
| Relational (ROR) | `binary` `< <= > >= == !=` | swap within the relational set |
| Logical connector (LCR) | `binary` `&& \|\|` | `&&` ↔ `\|\|` |
| Arithmetic (AOR) | `binary` `+ - * / %` | swap within the arithmetic set (guard `/`,`%` against constant-0) |
| Conditional negation (COR) | whole boolean expr | wrap in `{kind:"unary",op:"!"}` |
| Unary removal | `unary` `!`/`-` | drop the operator, return `operand` |
| Connective drop | `binary` `&&`/`\|\|` | replace with `left` only, then `right` only (2 mutants) |
| Boundary shift | numeric `literal` in a comparison | `v → v+1`, `v → v-1` |
| Boolean literal | `literal` `bool` | `true` ↔ `false` |

`ternary` and `match` are handled by the recursion (their `cond`/arm
conditions are ordinary boolean expressions), not special-cased.

**Recursion — single-fault guarantee:**

```
mutate(e) = [ ...localMutants(e),        // mutate e's own node
              ...childMutants(e) ]        // recurse; rebuild e with ONE child swapped
```

`childMutants` walks each child position, calls `mutate` on it, and for each
returned child-mutant rebuilds an otherwise-identical copy of `e`. Every output
tree therefore differs from the original in exactly one node — the definition
of a first-order mutant, and what keeps "surviving mutant ⇒ real test gap"
honest.

**Tiering** — a predicate passed to `localMutants` selecting which operator
classes fire, to reconcile mutant strength with the speed budget:

- **Tier 1 `smoke`** — COR + LCR only (≈ the original concept note's model).
- **Tier 2 `standard`** (default) — + ROR + boundary shift + connective drop.
- **Tier 3 `thorough`** — + AOR + unary removal + literal flips.

Tier is driven off metadata we already have: a server-only invariant
(`InvariantIR.scope === "server-only"`) warrants Tier 3; a display-only derived
predicate can stay Tier 1.

**Type-directed pruning** — reject before emit, using the resolution info on
each node:

- Operator/type mismatch (don't apply ROR/AOR unless operands are ordered
  numerics — readable from `ref.type` / `member.memberType`). Prevents dead
  mutants that wouldn't compile in C#/TS.
- Provably equivalent (`x+0`/`x-0`, `x*1`, double negation) — kills the classic
  equivalent-mutant tax structurally.
- Constant-divisor hazards (no synthesized `/0` or `%0`).

The pruner is pure and unit-testable against IR fixtures with no codegen
involved.

### 4.D Gated emit mode

The render context gains an optional instrumentation hook; when active and the
current expression is a registered mutation point, the renderer wraps it:

```ts
// TS
FrameworkMutator.execute(id, meta, () => <original>, () => <mutant>)
```
```csharp
// .NET
FrameworkMutator.Execute(id, meta, () => <original>, () => <mutant>);
```
```elixir
# Phoenix / Elixir
FrameworkMutator.execute(id, meta, fn -> <original> end, fn -> <mutant> end)
```

Both branches are produced by the *same* renderer call applied to the original
vs. the mutated `ExprIR`. The mode is selected via a `PlatformSurface` variant
/ CLI flag and is never reached by the fixture suite, so default output stays
byte-identical.

### 4.E Core runtime framework (per backend)

A small singleton emitted only in instrumented builds:

- **TS** — static `coverage: Map<string,number>` + `activeMutantId` flag;
  `execute` records a hit, returns `mutatedFn()` iff active, else
  `originalFn()`.
- **.NET** — same, but `activeMutantId` is `AsyncLocal<string?>` and coverage
  is a `ConcurrentDictionary` for thread/async isolation under parallel test
  runs.
- **Phoenix** — process-dictionary or a small `Agent`/`GenServer` for the
  active-id and coverage, respecting BEAM process isolation.
- **Python** — module-level active-id via `contextvars.ContextVar` (async-safe)
  + a coverage dict; emitted only in instrumented builds.
- **Java** — `ThreadLocal<String>` active-id + a `ConcurrentHashMap` coverage
  map, same isolation rationale as .NET.

### 4.F The test runner — the hard part, told honestly

The concept note compresses the runner into one paragraph; it is in fact the
bulk of the work. Three real obstacles:

1. **The coverage map is the wrong shape.** A global `Map<mutantId,count>`
   tells you nothing about *which test* exercised a mutant. To scope re-runs we
   need the inverse, `Map<testId, Set<mutantId>>`, captured by hooking each
   framework's per-test lifecycle (snapshot fired IDs in `afterEach`). One
   integration per logic backend's test framework.
2. **Warm re-runs fight the runners' process model.** "Seconds, not minutes"
   requires one warm process re-running test *subsets* with `activeMutantId`
   flipped. Spawning a fresh `vitest` / `dotnet test` / `mix test` per mutant
   reintroduces startup cost and kills the speed claim. Programmatic in-process
   subset execution is exactly what these runners are not built for (vitest
   Node API with effort; xUnit via VSTest-host/reflection; ExUnit programmatic
   entry).
3. **Loops change the safety story.** Loom has no loop construct *today*
   (verified against `ddd.langium` and `StmtIR`), but `foreach`-style iteration
   is planned. Once it lands, a mutated loop guard (`<` → `<=`, connective
   flips) can produce a non-terminating mutant. In-process warm re-runs then
   **require** a per-test timeout/watchdog. This must be designed in now, not
   retrofitted — treat the "no loops ⇒ no watchdog" assumption as expired.

**What makes it tractable in Loom specifically:**

- Generated unit tests are **pure** — the IR validator forbids mutating
  statements in test bodies, so warm in-process re-runs are safe in a way
  arbitrary user suites are not.
- **We generate the coverage harness too** — the `afterEach` snapshot is part
  of test emission, not a retrofit onto unknown code.
- **A static scope is free — and finer than aggregate.** The traceability graph
  already indexes `testsByCodeElement[qualifiedName] → tests`
  (`src/system/traceability.ts`), so a mutant at `Sales.Order.positiveTotal`
  maps to exactly the tests covering *that node*, not all `Order` tests. Reuse
  that existing index — there is no need to build a separate aggregate-level
  partition, node-level scope is a strictly larger constant-factor win, and it
  needs *no* runtime coverage map at all.

**Staging — scoping is an optimization, not a correctness prerequisite:**

1. **Full-suite per mutant (no scoping).** One warm process, run the whole
   generated unit suite per mutant. Zero coverage infrastructure; for small
   per-aggregate suites this may already be fast enough. Proves correctness.
2. **Static node-scoping.** Partition by the existing
   `testsByCodeElement` index (node-level, finer than aggregate). Free, large
   constant-factor win — reuses `traceability.ts`, builds nothing new.
3. **Runtime per-test coverage scoping.** Only if (1)+(2) are too slow. This is
   the genuinely hard piece (the `Map<testId,Set<mutantId>>` + warm subset
   re-runs across the five frameworks) — and by this staging it is a deferred
   optimization, never a blocker.

The watchdog/timeout from obstacle 3 is needed from stage 1 onward once loops
exist, independently of scoping.

**Coverage floor — separate the two failure modes for free.** A mutant on a node
with *zero* covering tests in `testsByCodeElement` is a *guaranteed* survivor —
don't spend a warm-process run on it. Report it as **untested** (a coverage
gap), kept distinct from **tested-but-survived** (a *toothless* test — the
higher-signal case). Coverage finds the never-touched; mutation finds the
touched-but-not-constrained. The gate cares about the second; the floor lets you
skip the first cheaply, and the two map onto different verify verdicts (§9).

## 5. Pipeline placement

Respecting the one-directional layering:

- `src/ir/mutation-operators.ts` — pure `ExprIR → ExprIR[]` + pruning. Knows
  nothing of backends or the runner.
- `src/ir/enrich/enrichments.ts` — new sub-pass assigning deterministic
  mutation IDs. Stays pure/idempotent.
- `src/generator/_expr/target.ts` — gated wrapping at the single shared
  `renderExprWith` injection point; no mutation logic lives here.
- `src/platform/` — the instrumented emit-mode variant.
- A new top-level runner package/CLI command — the only Node-runtime piece;
  consumes generated tests + coverage, owns the warm-process loop.

## 6. Phased delivery

| Phase | Scope | Depends on | Rough effort |
|---|---|---|---|
| 0 | Spike: hand-write one instrumented `Order` in TS + a throwaway driver flipping `activeMutantId`. De-risk the runner. | — | 0.5–1 d |
| 1 | IR types + deterministic IDs (enrichment sub-pass). Backward-compatible, absent in default builds. | — | 0.5 d |
| 2 | `mutation-operators.ts`: catalogue + recursion + tiering + type-directed pruning, unit-tested against IR fixtures. | 1 | 1–1.5 d |
| 3 | Gated renderer wrapping for TS first; assert default output byte-identical. | 1,2 | 0.5–1 d |
| 4 | Core `FrameworkMutator` runtime (TS), emitted only in instrumented mode. | 3 | 0.5 d |
| 5 | Runner stage 1 (full-suite, warm vitest process) + watchdog. End-to-end kill/survive report for TS. | 3,4 | 2–3 d |
| 6 | Runner stage 2 (static aggregate-scoping). | 5 | 0.5–1 d |
| 7 | Port runtime + runner to .NET, Phoenix, Python, Java. The renderer hook is shared (§2), so only the per-framework runtime + runner repeat. | 3–6 | 2–3 d each |
| 8 | (Optional) Runner stage 3: runtime per-test coverage scoping. | 5 | open-ended |

Codegen-side (1–4) is genuinely small because the hooks are centralized and the
IR is typed. Phases 5 and 8 are where the open-ended effort lives.

## 7. Risks & open questions

- **Mutant volume vs. speed.** Even Tier 2 over a real aggregate yields dozens
  of mutants per operation; the speed promise depends on scoping (static is
  free, runtime is hard).
- **Equivalent mutants.** Structural pruning catches the obvious ones;
  semantically-equivalent survivors will still appear and need a suppression
  list.
- **Loops (incoming).** Must land the watchdog with stage-1 runner; revisit
  operator set for loop-guard mutations when iteration is added to the DSL.
- **Five frameworks.** Each runner integration (vitest / xUnit / ExUnit /
  pytest / JUnit) is independent work; budget accordingly. TS/Hono first — the
  `test/behavioral/` harness already boots the generated Hono backend on PGlite
  in-process and runs the DSL-emitted suites, so the stage-1 runner has a warm
  in-process host to build on rather than starting from zero.
- **Test purity assumption.** Holds for generated unit tests today (validator
  enforced); if test-body rules ever relax, warm re-runs need re-evaluation.

## 8. Testing the feature itself

- Pure unit tests for `mutate()` and the pruner against `ExprIR` fixtures (no
  codegen).
- Renderer tests asserting (a) default output unchanged byte-for-byte, (b)
  instrumented output well-formed per backend.
- An integration test: generate an instrumented sample, run the stage-1 runner,
  assert known-good tests kill all mutants and a deliberately weak test leaves a
  known mutant alive.

## 9. Mutation as the verification gate (why this exists)

Everything above describes how to *produce* a kill/survive report. This section
says what the report is *for* — and it is the reason mutation is worth building
at all, not a QA nicety.

**The problem mutation solves: circular self-certification.** In an agentic
workflow the same actor authors the `.ddd` *and* its `test` declarations. When
one actor writes both the claim and its proof, "the tests pass" and "the work is
correct" quietly stop being the same statement. `ddd verify` already catches
*missing* tests (a requirement with no executable test → `UNTESTED`, never
`VERIFIED`). It cannot catch *toothless* tests: a test that is green and
constrains nothing. A green, even 100%-covered suite of assertion-light tests
certifies nothing — and nothing in Loom today can tell, because the lying signal
*is* the green suite. Mutation is the only adversarial check on the proof
itself. **It is the non-circular half of the verification story.**

### 9.A Wiring: mutation downgrades the DoD verdict

`verify` (`src/verify/verification.ts`, pure `computeVerification`) stamps each
requirement `VERIFIED / FAILING / UNVERIFIED / UNTESTED` by joining test results
onto the traceability graph. Mutation extends — does not replace — that join:

> **A requirement is `VERIFIED` ⟺ its covering tests pass *and* the mutants of
> the nodes those tests cover all die.**

A surviving mutant on a node in `testsByCodeElement` covered by requirement R's
tests downgrades R out of `VERIFIED`. Concretely, add a verdict between
`VERIFIED` and `FAILING`:

- **`VERIFIED`** — tests pass, covered-node mutants all killed (genuinely
  pinned).
- **`VERIFIED_WEAK`** (new) — tests pass, but ≥1 covered-node mutant survived.
  The requirement is green-but-toothless; the report names the surviving mutant
  and the exact node (`Sales.Order.positiveTotal` boundary untested).
- **`UNTESTED`** — unchanged (no covering test; the coverage floor of §4.F).

This is a small change because the inputs already exist: `verify` has the
verdict model and the `testsByCodeElement` / `testsByRequirement` indices; the
runner supplies the per-node survivor set. `computeVerification` stays pure, so
the playground's **Tests** panel gets the weak-verdict badge for free.

### 9.B Triggers — not a batch job, a gate

The report is consumed at three points, in increasing value:

1. **Requirement-close (the primary trigger).** When an agent asserts a
   requirement is done, mutate the nodes that requirement's tests cover; any
   survivor blocks `VERIFIED` (→ `VERIFIED_WEAK`). This is what makes `verify`
   non-circular and is the trigger that turns mutation from "a slow CI job" into
   "the gate." Gate on it with a `ddd verify --no-weak` style flag (fail the
   exit code on any `VERIFIED_WEAK`), mirroring `--require-all`.
2. **Delta-scoped inner loop.** After an edit, mutate only the nodes a model
   diff flags as changed (path-keyed `LoomModel` diff → changed `qualifiedName`s
   → their `testsByCodeElement` tests). Fast per-edit "is what I just changed
   actually pinned?" feedback, scoped to the blast radius.
3. **Batch / CI.** Mutate every observable node for the global teeth report.
   This is the only mode the rest of this proposal assumed; it is the *least*
   load-bearing of the three.

### 9.C What it does not cover (honest boundary)

The gate is exactly as strong as the IR is observable. Two holes, both already
noted, restated here so the verdict is not over-trusted:

- **`extern` logic (§3).** Off-IR, unmutatable. A requirement whose logic lives
  behind an extern can be `VERIFIED` while its real behaviour is unchecked.
  Surface the count; do not let it read as green.
- **Structural rules not yet mutated (§4.A).** Capability `stamp`/`filter`,
  `emit`, whole-invariant removal are out of v1's expression-only operator set,
  so a `VERIFIED` verdict does not yet attest those. The verdict should state
  its own scope ("expression-level teeth"), widening as the structural tier
  lands.
