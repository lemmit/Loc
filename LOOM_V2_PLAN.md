# Loom v2 — Query-Based Compiler: Step-by-Step Plan

Status: design plan. This document is the canonical, step-ordered plan for
rewriting the Loom toolchain from a one-shot push pipeline into a
demand-driven, memoized, incremental query engine (Salsa / rust-analyzer
model), with a functional emission layer and first-class semantic macros.

It supersedes ad-hoc notes. Read top to bottom; phases are ordered by
dependency. Every phase ships, stays green, and is byte-identical to v1 at
its boundary.

---

## 0. Principles (non-negotiable)

1. **Synchronous query model.** Queries are sync pure functions. No
   `async`/Promise in the query model — concurrent `await` corrupts
   dependency tracking (the shared call-stack gets attributed to the wrong
   parent). Salsa/rust-analyzer are sync for this exact reason.
2. **Key on stable IDs, never on serialized content.** A query's cache key
   is `(queryId, StableId-args)`. Never `JSON.stringify(astNode)` —
   Langium nodes have cyclic back-refs and content-keying kills reuse.
3. **Structural query values; strings only at the sink.** Query outputs are
   `Doc` / `EmittedUnit` with cheap structural equality so the engine can do
   early cutoff. Pretty-printing to strings happens once, at the file writer.
4. **Engine is a standalone library.** The query runtime imports nothing
   from Loom. Queries depend on the engine; the engine never depends on
   queries.
5. **Differential correctness.** Until v1 is retired, v1 is the oracle.
   Every ported query is tested against v1 output. Byte-identical generated
   output is the contract at every phase boundary.
6. **Extension = registration, not pipeline surgery.** New IR kinds,
   backends, design packs, and macros plug in by registering queries /
   inserting into input tables. No central switch statements.
7. **Functional emission.** No mutable accumulators, no lateral closure
   reach. Emitters are `(db, key) -> EmittedUnit`; accumulators (imports,
   decls, diagnostics) are returned values combined by a monoid.

---

## 1. The query engine library (`packages/query/`)

A domain-free, ~300-line core. Built first, TDD, 100% behavioral coverage.

### 1.1 Public surface

```ts
type QueryId = string;                 // e.g. "ir.aggregate"
type StableId = string;                // opaque, from IdentityStrategy

interface Db {
  // read a derived query (memoized)
  query<A extends StableId[], R>(id: QueryId, args: A, fn: () => R): R;
  // input cells (revisioned, the only mutable surface)
  setInput<R>(id: QueryId, args: StableId[], value: R): void;
  getInput<R>(id: QueryId, args: StableId[]): R;
}

// ergonomic wrapper — keep the prototype's elegance, fix its semantics
function createQuery<A extends StableId[], R>(
  id: QueryId,                         // EXPLICIT, stable id (NOT fn.name)
  fn: (db: Db, ...args: A) => R,
): (db: Db, ...args: A) => R;
```

### 1.2 Semantics the engine MUST implement (and the prototype got wrong)

- **Sync evaluation** with a per-evaluation call stack for dependency
  capture. No async.
- **In-progress marker + cycle policy.** A key being computed is marked;
  re-entry is a detected cycle, resolved by a registered policy
  (error by default; fixpoint opt-in per query family).
- **Transitive invalidation via reverse-deps.** Inputs change → walk the
  reverse-dependency closure. No substring/`includes` matching.
- **Early cutoff (red/green).** On input change, re-run the directly
  dependent query; if its value is structurally equal to the cached value,
  do NOT invalidate its dependents. This is where most incrementality lives.
- **Revisions + durability tiers.** Bump a global revision on input change;
  durability lets rarely-changing inputs (design packs, CLI flags) skip
  validation walks.
- **No name inference.** `createQuery` takes an explicit `QueryId`. `fn.name`
  is unsafe under Vite minification (`web/` bundles the toolchain) and
  collides across same-named functions.

### 1.3 Engine test matrix (100% behavioral, TDD)

- cache hit returns identical memo; miss computes once
- nested query records correct parent→child edges
- transitive invalidation invalidates the full cone and nothing outside it
- early cutoff: unchanged value stops propagation; changed value propagates
- cycle: re-entry triggers the policy (error and fixpoint variants)
- durability: high-durability input skips re-validation when untouched
- determinism: same inputs across runs → identical dep graph

Engine ships as an independently versioned package with zero Loom imports.

---

## 2. Identity (`D1`) — interface + oracle first, strategy swappable

Identity is the highest-risk decision, so we make it **non-crucial** by
hiding it behind a strategy and validating with an oracle test before
committing to any concrete scheme.

### 2.1 Interface

```ts
interface IdentityStrategy {
  idOf(node: AstNode): StableId;       // stable across reparses
}
```

All queries key on `StableId`. No query ever sees the strategy internals.

### 2.2 The oracle test (write BEFORE choosing a strategy)

Property test, strategy-agnostic:
1. Parse a system → record `idOf` for every entity.
2. Mutate an **unrelated** node; reparse.
3. Assert: every untouched entity's `StableId` is unchanged; mutated
   entities' IDs changed as expected.

Run this against whichever strategy is plugged in. It is the continuous
validator for D1.

### 2.3 Strategy ladder (swap without touching queries)

- `FqnStrategy` (start here): `system.module.aggregate.prop` for named
  entities.
- `FqnPlusStructuralStrategy`: + deterministic positional path for anonymous
  nodes (`...invariant[2].expr.lhs`).
- `FqnPlusStructuralPlusHygieneStrategy`: + `(macroSiteId, expansionStep)`
  tag for macro-introduced nodes (needed for Phase 5).

Because identity is behind the interface and guarded by the oracle, a wrong
early guess costs a strategy swap, not a rewrite.

---

## 3. Emission substrate (`D3`/`D5`) — `Doc` + `EmittedUnit`

Built fresh as the v2 emission layer (NOT retrofitted into v1 — see Phase
ordering rationale in §9).

```ts
type Doc =                            // Wadler/Leijen pretty-printer ADT
  | { k: 'text'; s: string }
  | { k: 'line' }
  | { k: 'nest'; n: number; d: Doc }
  | { k: 'concat'; a: Doc; b: Doc }
  | { k: 'group'; d: Doc };

interface EmittedUnit {               // a Writer-monoid value
  body: Doc;
  imports: Imports;                   // monoid: union
  decls: Decls;                       // monoid: ordered union
  diagnostics: Diagnostic[];          // monoid: concat
}
const empty: EmittedUnit;
const combine: (a: EmittedUnit, b: EmittedUnit) => EmittedUnit;
```

Rules:
- Every emitter is `(db, key) -> EmittedUnit`. No `Block` mutation, no
  closed-over import sets, no lateral peeking — lateral context becomes an
  explicit `db.query(...)` call.
- `Doc` has cheap structural equality → drives engine early cutoff.
- Strings are produced ONCE, at the file-writer sink.

---

## 4. Parser seam (`D4`) — Langium as parser only, services reimplemented

v1's language services are weak; this is the chance to do them right.

- Keep Langium **only** as the parser. Wrap behind two input queries:
  `parse.ast(fileId)`, `parse.linked(systemId)`. Nothing else touches
  Langium services.
- Reimplement scoping, typing, diagnostics, completion, hover, definition as
  first-class queries (`sema.*`, `lsp.*`). Better than v1:
  - stable diagnostic codes + quickfix payloads
  - go-to-def / find-refs / rename ride the engine's reverse-dep graph
    (find-refs is nearly free — it IS the reverse-dep set)
  - incremental: unchanged spans are O(1) cache hits
- This isolation keeps a future parser swap (true syntactic extensibility,
  if ever a product goal) confined to these two queries.

### Grammar extensibility note

Syntactic extension is orthogonal to the query engine (parsing is the input
edge). Strategy: keep the core grammar mostly fixed and add **one** uniform
"open form" (an attributed block) that **macros** interpret. This delivers
most practical extensibility with zero parser churn and composes with the
macro layer (Phase 5). Reserve a composable/runtime parser for a future
where user-defined syntax is a headline feature.

---

## 5. Query taxonomy + modularity

~250 queries, grouped into namespaced families (the `QueryId` prefix mirrors
the file tree, ~10-25 queries each — digestible one family at a time):

| Family | Queries (examples) |
|---|---|
| `input.*` | `sourceText`, `sourceFiles`, `cliFlags`, `designPackTree`, `macroDefs`, `backendRegistry` |
| `parse.*` | `ast`, `linked` (Langium-wrapped) |
| `sema.*` | `scopeAt`, `resolveRef`, `typeOf`, `memberType`, `callKind`, ~15 validator rules |
| `lsp.*` | `hover`, `completion`, `definition`, `references`, `rename` |
| `macro.*` | `nameAt`, `expand`, `astAt` (see-through) |
| `ir.*` | ~65: `aggregate`, `valueObject`, `page`, `event`, `expr`, `stmt`, ... |
| `enrich.*` | `wireShape`, `autoFindAll`, `reactInheritedModules`, `wireSpecJson` |
| `emit.react.*` / `emit.ts.*` / `emit.dotnet.*` / `emit.phoenix.*` | per-thing `-> EmittedUnit` (~120 total) |
| `compose.*` | `dockerCompose`, `viteConfig`, `dockerfile`, `e2eProject` |
| `output.*` | `platformFiles(deployId)`, `allOutputFiles(sysId) -> Map<path, queryKey>` |

Extensibility rules baked in:
- The "for each backend / design pack" loops are themselves registry queries
  (`input.backendRegistry`, `input.designPacks`) → adding one is an input
  insert, no central edit.
- `macro.astAt` resolves expansions transparently → validation/lowering/
  emission never special-case macro sites.

Sinks (`writeTree`, `runCompose`) are effectful and live OUTSIDE the graph.

---

## 6. Testing strategy (TDD throughout)

- **Engine**: 100% behavioral coverage (§1.3). Pure, deterministic.
- **Identity**: the oracle property test (§2.2) runs in CI against the active
  strategy.
- **Queries**: unit + **differential vs v1** (v1 is the oracle until
  retired). Differential and property tests are weighted ABOVE raw line
  coverage — coverage proves a query ran, not that it matches v1.
- **Generated output**: existing `test/fixtures/` byte-for-byte snapshots are
  the cross-phase contract. Enforce deterministic (sorted) iteration first
  so order noise never masks a real regression.
- **LSP**: query-level tests for hover/def/refs/rename; differential against
  v1 diagnostics during Phase 8.

---

## 7. Phases (each ships green + byte-identical at its boundary)

### Phase 0 — In-place prep (do now, no architecture bet)
- Enforce deterministic/sorted iteration across all v1 emitters.
- Re-baseline `test/fixtures/` once.
- (Do NOT retrofit Doc/EmittedUnit into v1 — built fresh later.)
- **Exit:** v1 output deterministic; fixtures stable.

### Phase 1 — Engine library (§1)
- Build `packages/query/` TDD to 100%. Zero Loom imports.
- **Exit:** engine green and standalone.

### Phase 2 — Identity (§2)
- Define `IdentityStrategy` + write the oracle test.
- Implement `FqnStrategy`; pass the oracle.
- **Exit:** stable IDs validated by reparse-identity property test.

### Phase 3 — Semantic queries behind Langium (§4)
- Wrap parse as `parse.*`. Reimplement `sema.*` as queries.
- Differential-test diagnostics against v1's validator (run both, assert
  equal).
- **Exit:** front-end semantics query-based; diagnostics match v1.

### Phase 4 — Lowering + enrichment as queries (§5 `ir.*`/`enrich.*`)
- Port `lower.ts`/`lower-expr.ts` (~68 fns) and `enrichments.ts` (~14 fns).
- Differential-test IR deep-equality against v1.
- Backends still run v1 push emitters fed from query IR.
- **Exit:** front half query-based; IR matches v1.

### Phase 5 — Macros (§4 grammar note, §5 `macro.*`)
- Add the uniform "open form" to the grammar (the one grammar edit).
- Implement `macro.expand` (semantic — may call `sema.typeOf`/`sema.scopeAt`),
  hygiene via the Phase 2 strategy ladder, `macro.astAt` see-through.
- Ship one built-in macro as the worked example (e.g. a `crud` expander).
- **Exit:** semantic, hygienic macros; downstream sees expansions
  transparently.

### Phase 6 — Functional emission, one backend at a time (§3)
- Build `Doc`/`EmittedUnit`. Convert backends in incrementality-value order:
  **React** (biggest closure-reach offender: `body-walker.ts` ~3.6k lines),
  then TS/Hono, then .NET, then Phoenix.
- Each backend: differential vs v1 fixtures → flip sink to fold
  `EmittedUnit` → delete the v1 emitter.
- **Exit (per backend):** that backend's output query-based + byte-identical.

### Phase 7 — Composition + sinks + retire v1 (§5 `compose.*`/`output.*`)
- Port `system/` composition to queries.
- Writer becomes `output.allOutputFiles`; watch/playground re-emit only
  invalidated entries.
- `wire-spec.json` drift = `db@rev1.wireSpecJson` vs `db@rev2.wireSpecJson`.
- Remove the v1 pipeline.
- **Exit:** fully query-based; v1 deleted.

### Phase 8 — LSP on the graph (§4 `lsp.*`)
- Cut `src/language/lsp/` over to `lsp.*` queries; add find-refs/rename via
  reverse-deps.
- **Exit:** incremental editor services; the headline UX win realized.

> Note: Phase 3 already delivers a large LSP latency improvement; Phase 8 is
> the full feature build-out. Claim the early win in Phase 3.

---

## 8. Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Identity scheme wrong → no reuse | 2 | Interface + oracle test; swappable strategy ladder |
| Async dep-tracking corruption | 1 | Synchronous engine, by design |
| Cold-run (CI) 5-20% slower | all | Accept; gate on wall-clock budget; win is the edit loop |
| Fixture churn from eval order | 0 | Sorted iteration first; re-baseline once |
| String over-invalidation | 3,6 | `Doc`/`EmittedUnit` values; stringify at sink only |
| Retained-memo memory growth | 7 | Durability tiers + eviction in batch mode |
| Langium push/pull impedance | 3 | Langium = parser only; everything else is our queries |
| Macro hygiene bugs | 5 | Scope-set hygiene on stable IDs; macro version key in inputs |
| Backend conversion drift | 6 | Differential fixtures per backend; one backend at a time |
| `fn.name` collisions under Vite | 1 | Explicit `QueryId`, never name inference |

---

## 9. Rationale for two ordering choices

- **Phase 0 split (in-place determinism, but Doc/EmittedUnit built fresh).**
  Retrofitting v1 emitters to Doc and then again to queries is double work;
  build the functional substrate once, in Phase 6. But determinism must land
  in place first because it protects the differential-testing contract the
  whole migration leans on.
- **React converted first in Phase 6.** It is both the highest-value
  incrementality surface (playground/editor) and the worst closure-reach
  offender, so it exercises the `EmittedUnit` monoid hardest and earliest.

---

## 10. Start-now, low-regret items

1. Phase 0 determinism + fixture re-baseline (pure upside).
2. Phase 1 engine library spike (standalone, TDD — no Loom coupling to risk).
3. Phase 2 identity oracle test (the make-or-break decision, de-risked to a
   swappable strategy validated by one property test).
