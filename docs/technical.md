# Loom — Technical Reference

How the compiler is laid out, why each layer exists, what it owns,
and where to make changes when extending the language or adding a
backend.

For language semantics see [`language.md`](language.md); for the
per-platform feature matrix see [`generators.md`](generators.md);
for usage / Docker / Playwright workflow see
[`tools.md`](tools.md).

---

## Pipeline at a glance

The compiler is **ten distinct phases**. The previous summary collapsed
several into "Lowering" — they're broken out below because conflating
them was costing readers an accurate mental model.

```
   .ddd source text
         │
         ▼   ① Parse (Langium-generated lexer + parser)
   Raw AST                             ─ tokens → CST → typed AST,
                                         cross-references NOT yet
                                         linked
         │
         ▼   ② AST macro expansion          src/macros/expander.ts
   AST'                                ─ `with auditable(...)`,
                                         `with softDeletable(...)`,
                                         `with scaffold(...)` etc.
                                         splice synthesised members
                                         into host declarations BEFORE
                                         scope is computed, so they
                                         participate in linking and
                                         validation.
         │
         ▼   ③ Scope + Link (Langium linker + src/language/ddd-scope.ts)
   AST''                               ─ every `Reference<X>` populated;
                                         cross-aggregate part refs must
                                         use `X id` (enforced here).
         │
         ▼   ④ AST validation               src/language/validators/
   AST'' + diagnostics                 ─ semantic checks on the linked
                                         AST; CLI aborts non-zero on
                                         errors.
         │
         ▼   ⑤ Lowering (AST → Loom IR)     src/ir/lower/lower.ts +
   Loom IR (LoomModel)                       src/ir/lower/lower-expr.ts
                                                (+ lower.ts's per-kind
                                                sibling lowerers)
                                       ─ TWO intertwined sub-passes
                                         all driven by `lowerModel`:
                                         (5a) structural walk,
                                         (5b) expression / name-resolution
                                              walk.
                                       ─ Small post-passes then classify
                                         each page via `classifyPage`
                                         (no stamped origin) and apply
                                         side effects (emit-path, detail
                                         `id` param, non-constructible
                                         drops).  Scaffold pages already
                                         carry their full body from the
                                         macro — no sentinel expansion.
                                       ─ Output: a LoomModel per file.
                                         Multi-file projects merge here
                                         via `mergeLoomModels`.
         │
         ▼   ⑥ Enrichment                   src/ir/enrich/enrichments.ts
   Loom IR'                            ─ ONE pure pass derives wireShape,
                                         auto-findAll, associations, and
                                         react `targets:` module
                                         inheritance. Idempotent.
         │
         ▼   ⑦ IR validation                src/ir/validate/validate.ts
   Loom IR' + LoomDiagnostic[]         ─ cross-aggregate / multi-file
                                         checks that need the fully-
                                         resolved IR.
         │
         ▼   ⑧ Per-platform code generation src/generator/<platform>/
   Map<path, content> per deployable   ─ each backend reads `IR.wireShape`
                                         directly. Backends that execute
                                         domain logic also walk ExprIR /
                                         StmtIR via render-expr.ts /
                                         render-stmt.ts. The five
                                         domain-logic backends (TS, .NET,
                                         Phoenix, Python, Java) walk those;
                                         all frontends skip them —
                                         frontends don't run domain logic.
                                       ─ INVOKED BY phase ⑨; not a
                                         standalone driver.
         │
         ▼   ⑨ System composition +         src/system/index.ts +
        migration derivation                src/system/migrations-builder.ts
   Map<path, content> for the system   ─ the orchestrator runs
                                         `buildMigrations(sys, snapshots)`
                                         (IR diff → MigrationsIR[]), then
                                         invokes each platform's emitter
                                         with the IR + the relevant
                                         migrations slice, then stitches
                                         outputs into a docker-compose
                                         tree (db-init/, e2e/, per-
                                         deployable services).
         │
         ▼   ⑩ Output writing (.loomignore) src/cli/main.ts
   Files on disk
```

**There is no target-backend IR.** Every backend consumes `LoomModel`
directly. The only secondary IR is `MigrationsIR`, derived once in
phase ⑨ and shared by every backend that has a database. This is the
architectural payoff: name resolution, member typing, call-kind
classification, and inline scaffold expansion all happen exactly once
(in phase ⑤). Backends never re-resolve.

The pipeline is one-directional. Each phase reads only from the phase
above and produces output the next phase consumes — no back-edges, no
shared mutable state. This is enforced by file structure: `language/`
knows nothing about `ir/`, `ir/` knows nothing about `generator/`,
`generator/<platform>/` knows nothing about other platforms, and
`system/` composes everything from above. The rule is now **mechanically
guarded**, not just convention: `test/platform/pipeline-layering.test.ts`
fails on any *value* (runtime) backward-edge across the
`language → ir → generator → system` chain (type-only imports of the
shared IR vocabulary are exempt), and
`test/platform/backend-packages-layering.test.ts` guards the
`generator → platform` (shared → versioned-package) edge.

---

## Phase ① — Parse

**Files**
- `src/language/ddd.langium` — single source-of-truth grammar.
- `src/language/generated/` — output of `langium generate`: parser,
  AST types, reflection metadata, scope-provider hooks.
- `src/language/ddd-module.ts` — Langium DI wiring.
- `src/language/main.ts` — LSP server entry.

**Inputs**
- Raw `.ddd` text via Langium's `LangiumDocuments` service.

**Outputs**
- A raw `Model` AST node. Cross-references are **not** populated yet
  (that's phase ③ after macro expansion).
- Parse / lex diagnostics on `doc.diagnostics` (severity-tagged).

**Responsibilities**
- Tokenize the source per the grammar's terminals (`STRING`, `INT`,
  `DECIMAL`, `ID`, comment / whitespace skips).
- Build the CST and convert to the typed AST.

**Non-responsibilities**
- No macro expansion — that's phase ②.
- No linking yet — that's phase ③.
- No type checking — that's phase ④.

## Phase ② — AST macro expansion

**Files**
- `src/macros/expander.ts` — the expander itself; runs at
  `DocumentState.IndexedContent` (before scope computation).
- `src/macros/registry.ts` — process-global macro registry.
- `src/macros/api/` — the `defineMacro(...)` authoring API.
- `src/macros/stdlib/` — stdlib macros: `scaffold` (+ `scaffoldModule`
  / `scaffoldContext` / `scaffoldAggregate` / `scaffoldView` /
  `scaffoldWorkflow`), `audit` (+ `auditable` / `auditedByDefault`),
  `softDelete` (+ `softDeletable` / `softDeleteByDefault`), `crudish`.
- Wired by `bootMacros(shared)` in `src/language/ddd-module.ts`, which
  loads the stdlib once and registers the `DocumentState.IndexedContent`
  listener for the expander.

**Inputs**
- Raw AST from phase ① with `with X(...)` clauses present on
  aggregates / contexts / ui modules.

**Outputs**
- AST' with macro-synthesised members (Properties, Operations,
  Aggregates, Pages, etc.) spliced into their host declarations.
- Macro diagnostics drained via the validator in phase ④.

**Responsibilities**
- Look up each `with X(...)` invocation in the macro registry,
  validate its arguments, invoke `expand(...)` inside an origin
  context, and splice the returned AST nodes into the host.
- Run *before* scope computation so the synthesised members
  participate in scoping and validation.

**Non-responsibilities**
- The macro expander does NOT lower or interpret IR. It is purely
  an AST → AST' rewrite. Macros that need IR-level introspection
  (e.g. `with crudish(...)`) inspect the host AST, not the IR.

**Relationship to the capability surface.** The `audit` /
`softDelete` / etc. macros don't emit a parallel machinery — they
expand into ordinary `filter` / `stamp` / `implements` AST nodes
(the capability source surface described in
[`docs/capabilities.md`](capabilities.md)).  The lowerer's
`lowerContext` pass then propagates the context-scope capability
declarations onto each aggregate.  Anything a macro can produce, a
user can hand-write — and vice versa.

## Phase ③ — Scope + Link

**Files**
- `src/language/ddd-scope.ts` — custom scope provider.

**Inputs**
- AST' from phase ②.

**Outputs**
- AST'' — every cross-reference (`X id`, `partType`, `aggregate`, etc.)
  has its `.ref` populated.

**Responsibilities**
- Run cross-reference linking — the scope provider tells Langium
  which names are visible at each `[Foo:ID]` site.
- For containment partTypes, the custom scope provider restricts
  the candidate set to entity parts declared in the same aggregate
  (cross-aggregate part references must use `X id`).

**Non-responsibilities**
- No semantic shaping — the AST still mirrors the grammar 1:1.
- No name resolution inside expressions (bare-name identifiers in
  expressions are resolved in phase ⑤b, not here).
- No IR construction.

**Contract for downstream layers**
- An AST node that came back from `getOrCreateDocument` has been
  through linking; `node.someRef.ref` is non-null iff the reference
  resolved.  Validators / IR lowering can treat `?.ref?.name` as
  the source of truth for cross-reference identity.
- AST nodes carry `$cstNode` with the source text — used downstream
  for error messages (`cstText(node)`).

**Key grammar conventions**
- Statements use a discriminator field (`AssignOrCallStmt.op`)
  rather than `{infer Subtype.field=current}` actions inside an
  alternation, which produces a recursive AST type.
- The `STRING` terminal strips outer quotes; consumers re-quote
  via `JSON.stringify` when emitting.
- `LValue` is flat (`head: string` plus `tail: string[]`) instead
  of recursive — flat lists are easier for both validator and IR
  to walk.
- `Expression` is a declared `type` union of every expression-node
  subtype.  Without that declaration, `LambdaOrExpr returns
  Expression` fails to type-check.

---

## Phase ④ — AST validation

**Files**
- `src/language/ddd-validator.ts` — thin dispatcher (~360 LOC) that
  wires Langium's `ValidationRegistry` to the themed check modules.
- `src/language/validators/` — the per-theme checks themselves
  (`deployable.ts`, `auth.ts`, `criterion.ts`, `composition.ts`, …),
  barrelled through `validators/index.ts`.  The previous ~2.5k-LOC
  monolith was split here; `ddd-validator.ts` owns no check logic.
- `src/language/type-system.ts` — `DddType` + AST-walk helpers
  (`typeOf`, `lookupRootMember`, `stepInto`, `findFunction`,
  `findOperation`, etc.).

**Inputs**
- Linked AST from phase ③ (after macro expansion + linking).

**Outputs**
- Diagnostic entries on `doc.diagnostics` (errors and warnings).
- Zero side effects — read-only walk over the AST.

**Responsibilities**
- **Type-correctness**: invariants and preconditions must be
  `bool`; derived expressions must match their declared type;
  `emit` payloads must match the event's declared field set;
  collection ops only on collection-typed receivers.
- **Mutability**: assignment LHS must be a non-derived property
  reachable from the root; `+= / -=` requires a collection LHS.
- **Structural**: operations and `test` blocks only on aggregate
  roots, not parts; `contains` only inside aggregates.
- **Reference scoping**: `X id` resolves to a known target; a
  `react` deployable's `targets:` resolves to a non-react
  deployable in the same system; non-react deployables can't have
  a `targets:` field.
- **Runtime guards**: assignment to a derived property is rejected
  (silent no-op at runtime would be confusing).

**Non-responsibilities**
- No fixing / suggesting — surfaces errors only.
- No transformation of the AST.
- No side-effects on the document.

**Contract for downstream**
- The validator runs before lowering — by the time IR is built,
  the AST is known to be semantically valid.  Lowering can rely on
  invariants like "every type ref resolves" and "every emit field
  exists on the event".  This is why the IR can use non-null types
  in many places: malformed input would have errored out earlier.

---

## Phase ⑤ — Lowering (AST → Loom IR)

The IR is **platform-neutral, fully resolved**: every name carries
its `refKind`, every member access carries its `receiverType` and
`memberType`, every method-call is flagged `isCollectionOp`, and
every find filter is a fully-typed `ExprIR`.  Backends consume the
IR; they never touch the AST.

This is the most important architectural decision in Loom: **resolve
everything before the templating layer**.  An earlier prototype
walked the AST directly inside backends and re-implemented name
resolution per language; the divergent re-implementations were
painful to keep in sync.  The IR collapses this to a single source
of truth.

The lowering layer is split into **three** cooperating modules,
driven end-to-end by `lowerModel(model: Model): LoomModel`. Each
sub-pass runs once per `lowerModel` call:

### Phase ⑤a — Structure layer

**File**: `src/ir/lower/lower.ts` (~1.3k lines) — a thin **orchestrator**.
The per-declaration-kind lowerers were extracted into sibling leaf modules
it imports (the graph is acyclic — leaves never import `lower.ts`):
`lower-platform.ts` (design/platform qualification), `lower-requirements.ts`,
`lower-capabilities.ts` (filter/stamp/implements collection),
`lower-members.ts` (shared `lowerField` / `lowerDerived` / `lowerInvariant` /
`lowerFunction` / `lowerContainment` + `lowerOperation` / `lowerCreate` /
`lowerDestroy` / `lowerApply` action bodies), `lower-view.ts`,
`lower-deployment.ts`, `lower-ui.ts`, `lower-workflow.ts`. The public exports
(`lowerModel` / `lowerProject` / `mergeLoomModels`) stay in `lower.ts`.

**Responsibilities** — top-down structural walk (functions below live across
`lower.ts` + the sibling modules, but compose into one `lowerModel` pass):

```
lowerModel
  └─ lowerSystem
       ├─ lowerContext              (loose contexts under a system)
       ├─ Module → lowerContext
       ├─ lowerDeployable
       └─ TestE2E → lowerE2E
  └─ lowerContext                   (top-level / legacy)
       ├─ lowerEnum
       ├─ lowerValueObject
       ├─ lowerEvent
       ├─ lowerAggregate
       │    ├─ lowerEntityPart
       │    ├─ lowerField / lowerContainment / lowerDerived
       │    ├─ lowerInvariant
       │    ├─ lowerFunction
       │    ├─ lowerOperation
       │    └─ lowerTest            (per-aggregate test blocks)
       └─ lowerRepository
```

Each `lower*` function consumes one AST kind and returns the
matching IR shape.  The structure layer never reaches inside an
expression — it delegates every expression / statement subtree to
phase ⑤b.

It performs **in-lowering side-effects** before returning: the scaffold
post-passes drop non-constructible create surfaces and call
`applyPageSideEffects(built)` (conventional emit-path + detail `id` param),
each classifying pages on demand via `classifyPage` — no stamped origin, no
sentinel expansion. Auto-`findAll`, react `targets:` module inheritance, and
the rest of the cross-cutting derivations now live in **phase ⑥
(enrichment)**, not in the structure layer.

### Phase ⑤b — Expression layer

**File**: `src/ir/lower/lower-expr.ts` (~1650 lines).

**Responsibilities** — name resolution + member typing + IR
expression / statement construction:

| Function | What it does |
| --- | --- |
| `lowerExpr` | AST `Expression` → `ExprIR`, recursive over every node kind. |
| `lowerStatement` | AST `Statement` → `StmtIR` (precondition / let / assign / add / remove / emit / call / expression). |
| `lowerType` / `lowerBase` | AST `TypeRef` → `TypeIR` (primitive / id / enum / valueobject / entity / array / optional). |
| `resolveNameRef` | Bare identifier → `RefIR` with the right `refKind` (param / let / lambda / this-prop / this-vo-prop / this-derived / helper-fn / enum-value / unknown). |
| `resolveCallKind` | Free call name → `CallKind` (function / value-object-ctor / private-operation / free). |
| `inferExprType` | Best-effort type inference for an AST expression — used to inform IR nodes (`receiverType`, let-binding type, etc.). |
| `binaryResultType` | Result type for a binary expression, including `int → long → decimal` numeric widening for arithmetic. |
| `memberType` / `memberOnEntity` / `memberOnValueObject` | `T.member` typing — handles primitives, entities, value objects, collection ops, and the `string.length` shortcut. |
| `findEntityByName` / `findValueObjectByName` / `findFunctionInEnv` / `findOperationInEnv` | Look-ups that run against the env (parts → aggregate → ctx). |
| `pathType` / `stepInto` | Type a multi-segment LValue path (for assign / add / remove). |
| `ancestorAggregate` | AST → enclosing aggregate (used for cross-cutting `X id` value-type resolution). |
| `cstText` | AST → original source text, for diagnostics + invariant `source` fields. |

**Env**: a single immutable record carries the lowering scope:
`ctx?` (bounded context), `aggregate? / part? / valueObject?` (for
`this.X` resolution and member typing), and `locals` (parameter /
let-binding / lambda-parameter types).  Helpers like
`withLocal(env, name, kind, type)` return a *new* env, never
mutating.

**Dependency direction**: `lower.ts` imports from `lower-expr.ts`;
`lower-expr.ts` imports nothing from `lower.ts`.  Type lowering
lives in the expression layer because expressions reference types
(via `memberType`); the structure layer pulls `lowerType` in via
the same import direction.

### Post-lowering scaffold passes

**File**: `src/ir/lower/lower.ts` (tail of `lowerSystem(...)`).

There is **no inline-primitive expansion sub-pass** any more. Every scaffold
page — the per-aggregate list/new/detail, the workflow/view pages, *and* the
`Home` / `WorkflowsIndex` / `ViewsIndex` dashboards — carries its full
walker-stdlib body directly from the `with scaffold(...)` macro
(`src/macros/stdlib/scaffold/_body-builders.ts`), so the LoomModel returned by
`lowerModel(...)` already has complete page bodies and no sentinels.

What remains are small post-passes that classify each page on demand — from its
role-scoped `name` + `area` via `classifyPage` (`src/ir/util/page-kind.ts`),
**no stamped `origin`/`source`** — and apply side effects:
- drop the scaffolded `New` page (and the list "New" button) for a
  non-constructible aggregate;
- set the conventional `emitPath` for area-less scaffold pages and synthesise
  the `id` route param on aggregate-/instance-detail pages.

`src/ir/lower/walker-primitive-expander.ts` is now just `buildExpandContext` —
the per-UI index of served aggregates / workflows / views these passes (and the
generators) classify against.

---

## Loom IR shape

Defined in `src/ir/types/loom-ir.ts`.  The whole IR is a tree of immutable
records; no graphs, no cycles.

**Top-level**:

```ts
interface LoomModel {
  systems: SystemIR[];                  // explicit system blocks
  contexts: BoundedContextIR[];         // legacy single-deployable mode
}

interface SystemIR {
  name: string;
  modules: ModuleIR[];
  deployables: DeployableIR[];
  e2eTests: TestE2EIR[];
}
```

**Per-aggregate / per-part**:

```ts
interface AggregateIR {
  name: string;
  idValueType: "guid" | "int" | "long" | "string";
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  operations: OperationIR[];           // root-only
  parts: EntityPartIR[];
  tests: TestIR[];                     // root-only
}
```

**Expressions** — tagged union of:

```
literal | this | id | ref | member | method-call | call |
lambda | new | object | paren | unary | binary | ternary
```

Each carries enough context for backends to render without
re-running inference: a `ref` carries `refKind` and `type?`; a
`member` carries both `receiverType` and `memberType`; a
`method-call` is flagged `isCollectionOp` when applicable; a
`call` carries its `callKind`.

**Statements**:

```
precondition | let | assign | add | remove | emit | call | expression
```

`assign / add / remove` carry the typed `target: PathIR` plus the
`targetType` / `elementType` so backends can pick the right
mutator without re-walking the env.

---

## Phase ⑥ — IR enrichment (wire-shape, auto-finds, associations, react inheritance, migrations ownership)

**File**: `src/ir/enrich/enrichments.ts`.

After lowering returns a faithful AST projection, `enrichLoomModel(loom)`
runs a single pure pass that populates everything cross-cutting
the IR consumers need.  Five derivations, in order:

1. **Wire-shape on every aggregate / part / value object.**  The
   canonical, ordered list of fields that appear on the wire for
   that entity, attached as `agg.wireShape` / `part.wireShape` /
   `vo.wireShape`:

   ```ts
   interface WireField {
     name: string;                      // JSON key
     type: TypeIR;                      // domain-typed value
     optional: boolean;
     source: "id" | "property" | "containment" | "derived";
   }
   ```

   **Order is the contract**: `id` first, then declared properties
   in declaration order, then containments (collections rendered as
   `array<entity>`, singles as `entity`), then derived values.  Every
   backend's response-DTO emitter reads `agg.wireShape` directly:

   - Hono `routes-builder` → `<Agg>Response = z.object({ ... })` zod schema
   - Hono `repository-builder` → `repo.toWire(root)` JS object literal
   - .NET `dto-mapping` → `<Agg>Response(...)` C# record + projection
   - React `api-builder` → matching response Zod schema

   They all consume the same field list, so drift between backends
   is structurally impossible.

2. **Auto-`findAll` on every aggregate's repository.**  Backends
   can rely on every aggregate having an `all()` find without
   defensive checks.

3. **Associations on every aggregate.**  One `AssociationIR` per
   field whose type is a reference collection (`X id[]`), carrying
   the platform-neutral join-table metadata that relational backends
   consume:

   ```ts
   interface AssociationIR {
     fieldName: string;        // "party"
     ownerAgg: string;         // "Trainer"
     targetAgg: string;        // "Pokemon"
     valueType: IdValueType;   // matches the target's id value type
     joinTable: string;        // "trainer_party"
     ownerFk: string;          // "trainer_id"
     targetFk: string;         // "pokemon_id"
   }
   ```

   `joinTable` is `snake(owner)_snake(field)` (distinct per field,
   even when several fields target the same aggregate); FK names are
   `snake(agg)_id` and disambiguate to `owner_id` / `target_id` for
   the self-referential case.  Attached as `agg.associations`.  The
   TS/Hono schema and repository emitters read this; .NET / Phoenix
   emitters could too without re-deriving.

4. **React deployable `moduleNames` ← target deployable's
   modules.**  A `react` deployable doesn't list modules; it
   inherits its target backend's module set, propagated here so
   downstream layers see the resolved set.

5. **Per-module `migrationsOwner`.**  For every module, picks the
   single backend deployable responsible for emitting schema
   migrations against it (`assignMigrationsOwner` —
   `enrichments.ts:124`).  Consumed in phase ⑨ by
   `buildMigrations(...)` to decide which deployable's output map
   receives the per-module migration file.

**Idempotent** — `enrich(enrich(m))` deep-equals `enrich(m)`.
Asserted by `test/ir/enrichments.test.ts` ("enrichLoomModel is
idempotent").

**Output is a branded `EnrichedLoomModel`.** Downstream
(validator, system orchestrator, generators) takes
`EnrichedLoomModel` / `EnrichedBoundedContextIR` /
`EnrichedAggregateIR` at the call site, so passing an un-enriched
IR is a compile error rather than a `wireShape!` non-null cast at
the consumer.

**Non-responsibilities**
- No mutation of the input — returns a new model.  The pre-
  enrichment IR is read-only.
- No language-specific rendering — each generator turns
  `WireField` / `findAll` / `moduleNames` into source on its own.
- No knowledge of which platform consumes the shape.

A separate JSON Schema artifact, `<outdir>/.loom/wire-spec.json`,
is built from `wireShape` by `src/system/wire-spec.ts` and emitted
alongside every system.  Diffable, language-agnostic, useful for
spotting wire-contract changes between regens without booting any
backend.

---

## Phase ⑦ — IR validation

**File**: `src/ir/validate/validate.ts` (~220 lines) — a thin
`validateLoomModel` orchestrator that fans out to per-theme check
leaves under `src/ir/validate/checks/` (`system-checks` /
`query-checks` / `test-checks` / `workflow-checks` /
`structural-checks`, plus `shared.ts` helpers and `diagnostic.ts`
for the `LoomDiagnostic` type).  `firstNonQueryableNode` +
`LoomDiagnostic` are re-exported from `validate.ts`, so its public
surface is unchanged.  Alongside sits
`src/ir/validate/invariant-classify.ts` (~420 lines) — invariant
*wire-boundary* classification + single-field shape detection
consumed by backend emitters (Zod refines, FluentValidation
rules).  Not run by the validator itself; the file co-locates with
validate.ts because both are pure IR analyses.

**Inputs**
- Enriched `LoomModel` from phase ⑥.

**Outputs**
- `LoomDiagnostic[]` (severity-tagged).  The CLI driver
  (`src/cli/main.ts`) calls `validateLoomModel(loom)` after
  enrichment and bails non-zero on any `severity: "error"`.

**Why two validation phases?** Phase ④ runs against the AST and
catches everything that can be expressed in terms of grammar
shape, declared types, and Langium references. Phase ⑦ runs
against the **fully-resolved, multi-file, enriched IR** and
catches things that need that context:

- Cross-aggregate consistency that crosses Langium document
  boundaries (a property typed `Order id` referencing an `Order`
  declared in a different file).
- Checks that depend on enrichment output (e.g., wire-shape
  derived field ordering, association metadata).
- Workspace-wide uniqueness (root VOs, enums, systems, contexts),
  find-name collisions across aggregates in a context, react ID
  references, queryable `where` filters, workflow / view / auth
  / current-user / permission consistency.

**Non-responsibilities**
- No mutation of the IR — pure read.
- No platform-aware checks — IR validation is platform-neutral.

---

## Phase ⑧ — Per-platform code generation

Invoked by phase ⑨ (system orchestration); not a standalone driver
in the system-mode pipeline.

Each platform has the same module shape (in `src/generator/<platform>/`):

| File | Role |
| --- | --- |
| `index.ts` | Orchestrator — `generate<Platform>ForContexts(contexts, ...) → Map<path, content>`. |
| `emit/*.ts` (TS/.NET) or `*-emit.ts` (Phoenix) | Procedural emitters (`render<Thing>(...)`) for regular-shaped fragments — id classes, value-object classes, events, common errors, etc.  Plain TypeScript functions building strings via `lines(...)` from `src/util/code-builder.ts`. |
| `*-builder.ts` | Procedural builders for content with too much per-aggregate variation to keep small (Hono routes, Hono repositories, React pages, React page-objects). |
| `render-expr.ts` / `render-stmt.ts` | `ExprIR → string` / `StmtIR → string` renderers (only on platforms that execute domain logic — TS, .NET, Phoenix LiveView, Python, and Java, not the frontends).  `render-expr.ts` is a leaf-only `ExprTarget` table; the recursive dispatch lives in the shared `_expr/` subdir (below).  `render-stmt.ts` stays per-backend. |

### Shared generator subdirs

Several `_`-prefixed subdirs under `src/generator/` hold logic
consumed by multiple platforms.  The four principal ones:

| Subdir | Consumed by | What it owns |
|---|---|---|
| `_packs/` | the JSX/markup frontends (react, vue, svelte, angular) + the Phoenix HEEx path | Design-pack discovery + loader.  `loader-fs.ts` / `loader-vfs.ts` are the FS / browser-VFS backends.  (The pack-identity metadata — `BUILTIN_PACK_FORMATS` / `BUILTIN_PACK_LATEST` + the `parseBuiltinDesignRef` parser — lives in [`src/util/builtin-formats.ts`](../src/util/builtin-formats.ts): language validators and IR lowering consume it too, so it sits at the foundational `util/` layer.)  See [`design-packs.md`](design-packs.md). |
| `_expr/` | every domain-logic backend (TS, .NET, Phoenix, Python, Java) | `target.ts` defines the `ExprTarget` interface (the eight leaf-divergence axes — operators, naming, money arithmetic, collection ops, `refColl.contains` membership, regex, `ref` role, `callKind` call syntax) and `renderExprWith(e, target, ctx)`, which owns the 17-arm `ExprIR.kind` dispatch + all recursion.  Each backend's `render-expr.ts` supplies only the leaf table (`TS_TARGET` / `CS_TARGET` / `ELIXIR_TARGET` / `PY_TARGET` / `JAVA_TARGET`).  Expression-side analogue of `WalkerTarget`; already five backends — a 6th domain-logic backend writes one target, not a 6th dispatcher. |
| `_walker/` | the JSX/markup frontends (react, vue, svelte, angular) + a parallel HEEx engine (phoenixLiveView) | `target.ts` defines the `WalkerTarget` interface that captures the framework-shaped seams (state read/write, navigation, API call lowering, `match` rendering).  The four JSX/markup targets are implemented and consumed: `react/walker/tsx-target.ts`, `vue/walker/vue-target.ts`, `svelte/walker/svelte-target.ts`, and `angular/walker/angular-target.ts` all drive the shared `walker-core.ts`; Phoenix/HEEx runs a parallel engine via `elixir/heex-target.ts` (its output topology diverges). |
| `_obs/` | hono, dotnet, phoenixLiveView, python | Observability catalog + per-backend renderers.  `log-events.ts` defines the envelope schema; `render-<platform>.ts` emits the per-backend instrumentation (hono / dotnet / phoenix; python wires the shared catalog from its own `emit/obs.ts`).  Java emits an equivalent catalog-JSON channel without sharing this subdir.  See [`observability.md`](observability.md). |

Four more carry narrower shared seams: `_frontend/` (framework-neutral
frontend pieces shared across the JSX/markup frontends — zod schema
emission, menu derivation, form helpers, Playwright page objects, the
e2e harness, the smoke spec), `_workflow/` (the shared workflow
statement-target seam), `_payload/` (discriminated-union wire encoding),
and `_adapters/` (the per-resource/persistence/layout/runtime surface
seams the backends plug into).

### All-procedural emission

The Loom v2 refactor dropped Handlebars in Phase 4.  Every file is
now built procedurally on top of one primitive in
`src/util/code-builder.ts`:

- `lines(...parts)` — joins strings / arrays / `null` / `undefined`
  / `false` with `\n`, dropping nullish entries.  Used everywhere
  whitespace-controlled emission would have lived in a template.

The platform separation that used to be templated (`templates/*.tpl.ts`
+ `hb.ts`) is now: each `emit/*.ts` file is a plain TypeScript
module exporting `render<Thing>(args)` functions.  No runtime
parsing, no SafeString escaping, no helper registration — the type
checker validates every data flow from the IR to the rendered string.

### Hono backend (`src/platform/hono/v4/` + `v5/` + `src/generator/typescript/`)

The Hono backend is split between *versioned* packages under
`src/platform/hono/` (each owns its package shell + dep pin set) and a
*shared* TypeScript emitter library (`src/generator/typescript/` — the
per-aggregate procedural builders every Hono version reuses).  Two
versions ship today: `v4/` (zod 3 / TS 5) and `v5/` (zod 4 / TS 6).
Bareword `platform: node` resolves to **v5** (the default lane,
`honoV5Platform` in `src/platform/registry.ts`); v4 stays loadable via
the pinned `platform: node@v4`.

`v5/` is deliberately tiny — `index.ts` + `pins.ts` only.  The zod 3→4 /
TS 5→6 jump touches no emitter logic, so v5 just feeds its new pin set
through `makeHonoPlatform(...)` imported from `v4/index.ts` and reuses
the whole shell + emitter table below.  The table's `platform/hono/v4/`
files are therefore the active shell for both versions.

| File | Owns |
| --- | --- |
| `platform/hono/v4/index.ts` | `PlatformSurface` adapter — `emitProject`, `composeService`, `needsDb`, `defaultPort`. |
| `platform/hono/v4/emit.ts` | Project shell + per-context orchestration: package.json, tsconfig, Dockerfile, certs/ dir, route mount, calls into the shared emitters below. |
| `platform/hono/v4/pins.ts` | Dependency version pins owned by this Hono major (hono / zod / drizzle / pg / pino + dev deps). |
| `platform/hono/v4/routes-builder.ts` | OpenAPIHono router per aggregate — full Zod schemas via wire-shape, routes for create / get-by-id / find-all / per-op / per-find, domain-error handler. |
| `platform/hono/v4/view-routes-builder.ts` | OpenAPIHono router per declared view. |
| `platform/hono/v4/workflow-builder.ts` | OpenAPIHono router + handler per declared workflow. |
| `platform/hono/v4/auth-emit.ts` | JWT verifier hook + middleware when any deployable declares `auth: required`. |
| `platform/hono/v4/observability-builder.ts` | Wires the `_obs/render-hono` instrumentation into the per-aggregate routes. |
| `generator/typescript/emit.ts` | Top-level barrel called from `platform/hono/v4/emit.ts`. |
| `generator/typescript/emit/ids.ts` | Branded id types + smart constructors. |
| `generator/typescript/emit/value-objects.ts` | Enums + value-object classes. |
| `generator/typescript/emit/events.ts` | Domain-event union + dispatcher. |
| `generator/typescript/emit/aggregate.ts` | Aggregate / part class shape. |
| `generator/typescript/emit/schema.ts` | Drizzle `pgTable` / `pgEnum` declarations. |
| `generator/typescript/emit/routes.ts` | `http/index.ts` composer (CORS + sub-router mount + `/openapi.json`). |
| `generator/typescript/emit/tests.ts` | Per-aggregate vitest spec when `test` blocks present. |
| `generator/typescript/emit/migrations.ts` | Per-module Drizzle SQL migration file from the `MigrationsIR` slice. |
| `generator/typescript/repository-builder.ts` | Per-aggregate repository — find-by-id (load + hydrate), get-by-id (throws), save (upsert + diff-sync + dispatch), find-all + user finds (with Drizzle `where`-clause lowering), `toWire` serializer. |
| `generator/typescript/repository-imports-builder.ts` | Imports the per-aggregate repository needs (drizzle ops, id types, etc.). |
| `generator/typescript/extern-builder.ts` | Generated handler stubs for `extern` operations. |
| `generator/typescript/zod-refine.ts` | Shared helpers for emitting Zod `refine` chains from wire-translatable invariants. |
| `generator/typescript/render-expr.ts` / `render-stmt.ts` | IR → idiomatic TS for invariants / preconditions / op bodies. |

### .NET backend (`src/generator/dotnet/`)

| File | Owns |
| --- | --- |
| `index.ts` | Project shell + per-aggregate emission orchestration. |
| `emit/ids.ts` | `record struct OrderId(Guid Value)` + `New()`. |
| `emit/enums-vos.ts` | C# enums + value-object records. |
| `emit/events.ts` | `IDomainEvent` + per-event records. |
| `emit/common.ts` | `DomainException`, `AggregateNotFoundException`, `IDomainEventDispatcher`, `NoopDomainEventDispatcher`. |
| `emit/entity.ts` | Aggregate / part class shape. |
| `emit/repository.ts` | Repository interface + EF-backed implementation. |
| `emit/efcore.ts` | `AppDbContext` + `IEntityTypeConfiguration<T>` per aggregate. |
| `emit/cqrs.ts` | Command + Query records, handler scaffolds. |
| `emit/dto.ts` | Request + Response record headers (params come from `dto-mapping`). |
| `emit/api.ts` | `[ApiController]` + `[Route]` controller per aggregate, plus `DomainExceptionFilter`. |
| `emit/program.ts` | Hosting entry: DbContext, Mediator, Swashbuckle, CORS, camelCase JSON, `EnsureCreated`, `/health`. |
| `emit/tests.ts` | xUnit project + per-aggregate test class. |
| `dto-mapping.ts` | Wire ↔ domain conversion: `wireType`, `wireToCommandArgument`, `projectToResponse`, `projectEntityExpr`, `aggregateResponseParams`, `entityResponseParams`.  Walks `wireFieldsForAggregate` so the DTOs line up with every other backend. |
| `cqrs-emit.ts` | Per-aggregate orchestration: emits Request / Response DTO files, Command + Handler per public op, Query + Handler per find, controller. |
| `find-emit.ts` | Repository find-method bodies (LINQ predicate from convention or from a `where` filter). |
| `auth-emit.ts` | JWT bearer auth + `[Authorize]` filter wiring when any deployable declares `auth: required`. |
| `validator-emit.ts` | `AbstractValidator<TRequest>` FluentValidation rules from wire-translatable invariants. |
| `view-emit.ts` | Controller + handler per declared view. |
| `workflow-emit.ts` | Controller + handler per declared workflow. |
| `emit.ts` | Top-level barrel that `index.ts` invokes per context. |
| `render-expr.ts` / `render-stmt.ts` | IR → idiomatic C#, with a `thisName` context (e.g., `x` for find filters' `.Where(x => …)`). |

### React frontend (`src/generator/react/`)

| File | Owns |
| --- | --- |
| `index.ts` | Project shell (Vite, package.json, tsconfig, index.html, Dockerfile, certs/ dir, App.tsx with router, main.tsx with providers, e2e/ suite shell). |
| `api-builder.ts` | Per-aggregate API module: Zod schemas (request + response, walked via `wireFieldsForAggregate`) + React Query hooks (one per route, plus one `use<Op><Agg>` mutation hook per public operation). |
| `body-walker.ts` | The **single** page-codegen path.  Walks a page's `body:` `ExprIR` and emits TSX by dispatching every walker-stdlib primitive (`Stack`/`Table`/`QueryView`/`CreateForm`/`Modal`/`KeyValueRow`/…) through the active design pack's `primitive-*` templates.  No archetype renderers — `page <Name> { body: … }` and scaffolded pages share this one walker. |
| `form-helpers.ts` | Per-type form-input dispatch (`prepareFormFieldVM`/`renderFormField`): text/number/switch/select/fieldset/datetime, RHF `register` vs `Controller`, initial-value generation, `X id` → `useAll<Target>()` picker injection.  Shared by `CreateForm { of: }`, `WorkflowForm { runs: }`, and operation-modal forms. |
| `pages-emitter.ts` | Page shell: wraps the walker's body TSX with `useForm`/mutation-hook/`useParams`/import declarations the body recorded on the walk context. |
| `page-objects-builder.ts` / `walker-page-objects.ts` | Per-aggregate Playwright page-object class — keyed off the `data-testid` strings every primitive threads through (`testid:` named arg). |
| `layouts-emitter.ts` | Per-layout shell (`<Outlet/>` wrappers, header/footer, sidebar slots). |
| `menu-emitter.ts` | Sidebar / nav menu from `menu:` declarations + scaffold defaults. |
| `view-builder.ts` | Per-view page module. |
| `workflow-builder.ts` | Per-workflow page module. |
| `walker/tsx-target.ts` | `WalkerTarget` implementation for TSX — state read/write, navigation, API call lowering, `match` rendering.  Imported by `body-walker.ts`. |
| `walker/api-hooks.ts` / `context.ts` / `icons.ts` / `import-lines.ts` / `page-shell.ts` | Walker helpers — TanStack Query hook import collection, walk-context plumbing, design-pack icon resolution, deduped import lines, page-shell wrapping. |
| `walker/primitives/` | Per-primitive TSX dispatch entries (`Stack`, `Table`, `CreateForm`, `QueryView`, `Modal`, `KeyValueRow`, etc.) called from `body-walker.ts`. |
| `templating/` | Procedural TSX assembly helpers shared across the walker. |

The React side has no `render-expr.ts` / `render-stmt.ts`: the
frontend doesn't run domain logic, only consumes the wire shape.
Page bodies route through `body-walker.ts`, which dispatches every
walker-stdlib primitive into the active design pack's templates.
(A legacy `pages-builder.ts` archetype renderer that this section
previously mentioned no longer exists in tree.)

The other four frontends mirror this layout, each driving the shared
`_walker/walker-core.ts` through its own `WalkerTarget`:
`src/generator/vue/` (Vue 3 / vue-query, packs `vuetify` / `shadcnVue`),
`src/generator/svelte/` (SvelteKit static SPA, packs `shadcnSvelte` /
`flowbite`), `src/generator/angular/` (standalone Angular SPA, pack
`angularMaterial`), and `src/generator/feliz/` (Feliz F#/Fable/Elmish
SPA via `dotnet fable` + vite, daisyUI pack).  The three JSX/markup
frontends, like React, emit no `render-expr.ts` / `render-stmt.ts` —
they consume the wire shape only; Feliz is the exception, supplying its
own F# expression leaves (`FS_LEAVES`) because its embedded language is
F#, not JS.

### Scaffold expansion (compile-time sugar, not a codegen path)

`scaffold` is **not** a parallel renderer.  It is a two-stage
compile-time rewrite that lowers a domain selector into ordinary
walker-stdlib pages a user could have hand-written:

```
ui { scaffold modules: Sales }
        │
        ▼  phase ② macro expansion            src/macros/stdlib/scaffold/
   The `scaffold` macro (and its sub-macros scaffoldModule /
   scaffoldContext / scaffoldAggregate / scaffoldView /
   scaffoldWorkflow) synthesise `Page` AST nodes (name, route, menu)
   whose body is the FULL walker-stdlib tree, built directly as Langium
   AST by the scaffolders in
   `src/macros/stdlib/scaffold/_body-builders.ts` (Stack / Breadcrumbs /
   QueryView / Table / CreateForm …).  This includes the three per-UI
   dashboards — `scaffoldHome` / `scaffoldWorkflowsIndex` /
   `scaffoldViewsIndex` build `Stack { Heading, Card per … }` from the
   gathered inventory, so EVERY scaffold page body is unfoldable real
   `.ddd` source.  There is no sentinel and no later expansion pass.
        │
        ▼  phase ⑧ — the ordinary body-walker renders it through the
                    active design pack
```

The macro scaffolders are the contract for *what a scaffolded page
contains*.  Per page kind (`classifyPage`):

| Kind | Synthesised body |
| --- | --- |
| `aggregate-list` | `Stack { Breadcrumbs, Toolbar { Heading, Button "New" }, QueryView { of: api.Agg.all, …, data: Paper { Table { Column per non-collection field } } } }` |
| `aggregate-new` | `Stack { Breadcrumbs, Heading, Card { CreateForm { of: Agg } } }` |
| `aggregate-detail` | `Stack { Breadcrumbs, Heading, QueryView { of: api.Agg.byId(id), single: true, data:` → `Card { Stack { KeyValueRow per scalar field } }` **+ one `Modal { trigger: Button, OperationForm { data.<op> } }` per public operation + one `Card { Heading, Table }` per `contains` collection (related-entity list)** ` } }` |
| `workflow-form` | `Stack { Breadcrumbs, Heading, Card { WorkflowForm { runs: wf } } }` |
| `view-list` | `Stack { Heading, QueryView { of: Views.<name>, data: Paper { Table } } }` |
| `home` / `workflows-index` / `views-index` | `Stack { Heading, Stack { Card per aggregate/workflow/view } }` |

Because the output is plain walker stdlib, every scaffolded feature
is reachable from an explicit `page <Name> { body: … }` —
`examples/acme-order-explicit.ddd` is the hand-written equivalent of
`scaffold aggregates: Order` and is asserted byte-equivalent in CI.

---

## Phase ⑨ — System orchestration (multi-deployable)

**Files**: `src/system/index.ts` (orchestrator entry),
`src/system/e2e-render.ts`, `src/system/ui-e2e-render.ts`,
`src/system/wire-spec.ts` (writes `.loom/wire-spec.json` from
`IR.wireShape`), and `src/system/migrations-builder.ts` (derives
`MigrationsIR[]` from an IR snapshot diff).  The `system/` layer
also emits the rest of the `.loom/` artefact bundle through
sibling modules — see [`loom-artifacts.md`](loom-artifacts.md) for
the full inventory (mermaid views, LikeC4 model, traceability,
verification, provenance snapshots).

**Inputs**: `LoomModel.systems[]` (each carries modules,
deployables, and e2e tests) plus an optional `SnapshotStore` of
previously-emitted IR snapshots for migration diffing.

**Platform dispatch.** Each `deployable.platform` IR value resolves
through `src/platform/registry.ts` to a `PlatformSurface` —
`platformFor(name)` for barewords, `parseBuiltinPlatformRef` for
pinned `family@version` strings (e.g. `node@v4`).  Backend discovery
goes through an injectable seam (`setBackendSource`) so the playground
can back resolution with a VFS instead of `fs` / `node_modules` —
phase ⑨ is otherwise agnostic to whether a backend is in-tree or an
installed package.  See [`platforms.md`](platforms.md) for the
registry shape.

**Outputs**: a flat tree of files:

```
<outdir>/
├── docker-compose.yml         # postgres + every deployable + healthchecks
├── db-init/
│   └── 00-create-databases.sql # one DB per backend deployable
├── <deployable-1>/             # full per-platform project (phase ⑧)
├── <deployable-2>/
├── ...
└── e2e/                        # vitest+fetch DSL e2e (when `test e2e` against a backend)
    ├── package.json
    ├── tsconfig.json
    └── <System>.e2e.test.ts
```

UI specs (`test e2e ... against <react-deployable>`) land **inside**
the targeted react deployable's `e2e/` folder, next to its
auto-generated page objects:

```
web_app/e2e/<System>.ui.spec.ts
```

**Responsibilities**
- **Migration derivation** — call `buildMigrations(sys, snapshots)`
  first. It builds per-module `SchemaSnapshot`s from the IR, diffs
  each against the previous snapshot (`diffSchema`), and produces
  `MigrationsIR[]` with one entry per backend deployable that owns
  schema. The migrations slice is then passed to each backend
  emitter so it can write its own migrations file (Drizzle / EF Core
  / Ecto). `MigrationsIR` is the only secondary IR in the compiler.
- Per-deployable file routing — call the right backend's
  `generate*ForContexts(contexts, ...)` with the modules each
  deployable declares (and the target's modules for react
  deployables) plus its migrations slice.
- `docker-compose.yml` with a `db` service, per-deployable services
  (depends_on / env / healthcheck per platform), and a `pgdata`
  volume.
- `db-init/00-create-databases.sql` — one `CREATE DATABASE` per
  backend deployable so EF Core's `EnsureCreated` doesn't race
  against peer backends sharing the same db.
- `.loom/wire-spec.json` — JSON Schema derived from `IR.wireShape`
  by `wire-spec.ts`. Diffable, language-agnostic; useful for
  spotting wire-contract changes between regens.
- E2E test routing: api tests → vitest+fetch file at
  `<outdir>/e2e/`; UI tests → Playwright spec at
  `<react-deployable>/e2e/<System>.ui.spec.ts`.

**Test e2e lowering** (`src/system/e2e-render.ts` / `ui-e2e-render.ts`)

A `test e2e "name" against <deployable>` block lowers to typed
calls.  Per-call dispatch:

| DSL form (api) | Lowered to (vitest+fetch) |
| --- | --- |
| `api.<aggregate>.create({...})` | `__post(\`${base}/<plural>\`, {...})` |
| `api.<aggregate>.getById(idExpr)` | `__get(\`${base}/<plural>/${idExpr}.id\`)` (`.id` auto-appended for known let-bindings) |
| `api.<aggregate>.<op>(idExpr, body?)` | `__post(\`${base}/<plural>/${idExpr}.id/<op_snake>\`, body ?? {})` |
| `api.<aggregate>.<find>(args)` | `__getQuery(\`${base}/<plural>/<find_snake>\`, args)` |

| DSL form (ui — target is react) | Lowered to (Playwright via page objects) |
| --- | --- |
| `ui.<aggregate>.create({...})` | `<Agg>ListPage.goto() → create() → fill({...}) → submit()`, returning `{ id }`. |
| `ui.<aggregate>.getById(idExpr)` | `<Agg>DetailPage.goto(idExpr.id)` plus eager `field("…")` reads + `<containment>.length` accessors. |
| `ui.<aggregate>.<op>(idExpr, body?)` | `<Agg>DetailPage.goto(idExpr.id) → <op>(body ?? {})`. |

`expect(<x>).<matcher>(…)` lowers to the native matcher;
`expect(<call>).toThrow()` becomes
`await expect(async () => { <call>; }).rejects.toThrow()` (and
`toThrow(<status>)` adds a `/→ <status>\b/` matcher).

The UI / api split is determined automatically from the target
deployable's platform — no DSL keyword required.  This is why the
DSL grammar has a single `test e2e` form rather than e.g. a
reserved `'ui'` modifier (which would shadow the body's
`ui.X.Y(...)` identifiers).

**Non-responsibilities**
- The system layer doesn't generate domain code — it only routes
  and composes outputs from phase ⑧.
- It doesn't decide platform-internal details (CORS, JSON casing,
  database schema) — those live with the per-platform generators.

---

## Phase ⑩ — Output writing

**File**: `src/cli/main.ts`.

**Inputs**: a `Map<path, content>` from phase ⑧ (legacy single-context
mode: `generate ts` / `generate dotnet`) or phase ⑨ (system mode:
`generate system`).

**Outputs**: files on disk under the user-specified `--out` directory.

**Responsibilities**
1. Parse + validate the input `.ddd`; abort on errors with
   non-zero exit code.
2. Call the appropriate orchestrator entry point.
3. Load `.loomignore` from the output directory (gitignore syntax
   via the `ignore` npm package).
4. Iterate the map in sorted-path order.  For each path: check the
   ignore matcher and either write or skip.
5. If `--dry-run`, print the plan with `write` / `skip` annotations
   without touching the filesystem.

**Non-responsibilities**
- Migration directories (`db/migrations/`,
  `Infrastructure/Persistence/Migrations/`) are never in the
  generated map, so they're safe by construction.  The output
  layer doesn't need a special exclusion rule.

---

## Cross-cutting helpers

- `src/util/naming.ts` — `pascal` / `camel` / `snake` / `plural`.
  Used by every generator's templates and builders.  Plural rules
  are conservative ("y" → "ies", "s/x/z/ch/sh" → "+es", else "+s").

---

## End-to-end transformation example

Walk-through for the DSL line:

```ddd
operation confirm() {
    precondition isMutable()
    precondition lines.count > 0
    status := Confirmed
    emit OrderConfirmed { order: id, at: now() }
}
```

Inside `aggregate Order { ..., contains lines: OrderLine[], ... }`.

**After phases ①–③ (parse + macro expansion + link):**

```
Operation:
  name: "confirm"
  body: [
    PreconditionStmt(expr: CallExpr(callee: NameRef("isMutable"))),
    PreconditionStmt(expr: BinaryExpr(
      left: MemberAccess(receiver: NameRef("lines"), member: "count"),
      op: ">", right: IntLit(0))),
    AssignOrCallStmt(target: LValue("status"), op: ":=",
      value: NameRef("Confirmed")),
    EmitStmt(event.ref → OrderConfirmed,
      fields: [
        { name: "order", value: IdRef },
        { name: "at",    value: NowExpr }
      ]),
  ]
```

**After phase ④ (AST validation):**

- `isMutable` is a known `function` declared on `Order` — OK.
- `lines.count > 0` → `count` is the collection-op on `OrderLine[]`
  returning `int`, comparison returns `bool` — OK.
- `status := Confirmed` → `status` is `OrderStatus`, `Confirmed`
  is an enum value of that type — OK.
- `emit OrderConfirmed { order, at }` matches the declared event
  shape — OK.

**After phase ⑤ (lowering):**

```
OperationIR:
  name: "confirm"
  visibility: "public"
  params: []
  statements: [
    { kind: "precondition", source: "isMutable()",
      expr: { kind: "call", callKind: "function",
        name: "isMutable", args: [] } },
    { kind: "precondition", source: "lines.count > 0",
      expr: { kind: "binary", op: ">",
        left: { kind: "member",
          receiver: { kind: "ref", name: "lines",
            refKind: "this-prop",
            type: { kind: "array", element: { kind: "entity",
              name: "OrderLine" } } },
          member: "count",
          receiverType: { kind: "array", element: ... },
          memberType: { kind: "primitive", name: "int" } },
        right: { kind: "literal", lit: "int", value: "0" } } },
    { kind: "assign",
      target: { segments: ["status"] },
      targetType: { kind: "enum", name: "OrderStatus" },
      value: { kind: "ref", name: "Confirmed",
        refKind: "enum-value", enumName: "OrderStatus",
        type: { kind: "enum", name: "OrderStatus" } } },
    { kind: "emit", eventName: "OrderConfirmed",
      fields: [
        { name: "order", value: { kind: "id" } },
        { name: "at",    value: { kind: "literal", lit: "now",
          value: "now" } } ] },
  ]
```

Notice **every** name is tagged.  `lines` carries `refKind:
"this-prop"` and a typed `array<entity>`; `Confirmed` carries
`refKind: "enum-value"` and its `enumName`.  Backends never have
to re-resolve.

**After phase ⑧ (TypeScript backend):**

```typescript
public confirm(): void {
  if (!this.isMutable()) {
    throw new DomainError("Precondition failed: isMutable()");
  }
  if (!(this._lines.length > 0)) {
    throw new DomainError("Precondition failed: lines.count > 0");
  }
  this._status = OrderStatus.Confirmed;
  this._events.push({
    type: "OrderConfirmed",
    order: this._id,
    at: new Date(),
  });
  this.assertInvariants();
}
```

`render-stmt.ts` walks each statement:
- `precondition` → `if (!cond) throw new DomainError(<source>)`
- `assign` of an enum → `this._<name> = <Enum>.<Value>`
- `emit` → `this._events.push({ type: <evName>, ...fields })`
- After the last statement, every mutator appends
  `this.assertInvariants()` (added by the aggregate template, not
  the renderer).

`render-expr.ts` (a leaf table over the shared `_expr/target.ts`
dispatch) walks each expression:
- `call { callKind: "function" }` → `this.<name>(<args>)`
- `member { ..., isCollectionOp: false }` on `array.count` →
  `this._lines.length` (the renderer knows `count` on a collection
  IR maps to JS `.length`).
- `id` (the implicit identity) → `this._id`.
- `literal { lit: "now" }` → `new Date()`.
- `ref { refKind: "enum-value", enumName: "OrderStatus", name:
  "Confirmed" }` → `OrderStatus.Confirmed`.

**After phase ⑧ (.NET backend):**

```csharp
public void Confirm()
{
    if (!(this.IsMutable())) throw new DomainException("Precondition failed: isMutable()");
    if (!(this.Lines.Count > 0)) throw new DomainException("Precondition failed: lines.count > 0");
    Status = OrderStatus.Confirmed;
    _domainEvents.Add(new OrderConfirmed(Order: this.Id, At: DateTime.UtcNow));
    AssertInvariants();
}
```

Same IR, different rendering rules: `count` becomes `.Count` (C#
collection), `now()` becomes `DateTime.UtcNow`, `_events.push`
becomes `_domainEvents.Add`, the event constructor uses named
arguments.

The fact that both backends produce idiomatic code from the same
IR is the payoff for fully resolving everything in phase ⑤.

---

## How to extend

### Adding a language feature

Rough recipe:

1. **Grammar** — add the syntax in `ddd.langium`; run
   `npm run langium:generate` to regenerate the parser + AST types.
2. **AST scope / validation** — if the new node introduces names
   or has type constraints, update `ddd-scope.ts` / the relevant
   themed module under `src/language/validators/` / `type-system.ts`.
3. **IR** — add the IR node in `loom-ir.ts`; lower it in the
   relevant `lower/` module — the matching per-kind sibling
   (`lower-members.ts`, `lower-workflow.ts`, …) wired into the
   `lower.ts` orchestrator, or `lower-expr.ts` (expression /
   statement / type).
4. **Renderers** — extend `render-expr.ts` / `render-stmt.ts` for
   each backend that emits domain logic (TS, .NET, Phoenix, Python, Java).
5. **Emitters / builders** — add or extend the relevant `emit/*.ts`
   (TS/.NET) or `*-emit.ts` (Phoenix) files, or `*-builder.ts` modules.
6. **Orchestrator** — wire up new file emission in
   `generator/<backend>/index.ts` if a new file appears.
7. **Tests** — at least one parsing test, one validator test
   (negative case), one generator test per backend that emits the
   feature.
8. **Examples** — extend an existing `.ddd` to exercise the
   feature end-to-end; verify with `npx vitest run` and
   `LOOM_TS_BUILD=1 npx vitest run test/e2e/generated-build.test.ts`.

### Adding a new backend

Many precedents in tree — five backends (`generator/typescript/`,
`generator/dotnet/`, `generator/elixir/`, `generator/java/`,
`generator/python/`) and five frontends (`generator/react/`,
`generator/vue/`, `generator/svelte/`, `generator/angular/`,
`generator/feliz/` — F#/Fable).  A few worth reading first:

- `generator/typescript/` — Hono.  Procedural emitters for fixed
  shapes (`emit/*.ts`); larger procedural builders (`*-builder.ts`)
  where per-aggregate variation is high.
- `generator/dotnet/` — .NET.  Same split as Hono; EF Core absorbs
  the per-aggregate diff at runtime so the repository builder is
  smaller than its Hono counterpart.
- `generator/react/` — React frontend.  All `*-builder.ts` — JSX
  is procedural across the board.

The shape:

1. Implement the platform's `PlatformSurface` (`src/platform/surface.ts`)
   in `src/platform/<backend>.ts` exposing `emitProject(...)`,
   `composeService(...)`, `needsDb`, `defaultPort`.  Internally,
   that adapter usually wraps a `generate<Backend>ForContexts(contexts, ...) → Map<path, content>`
   in `generator/<backend>/index.ts`.
2. Register the new platform in `src/platform/registry.ts`.
3. For domain-logic-running backends, implement an `ExprTarget` leaf
   table (the shared `renderExprWith` in `_expr/target.ts` owns the
   dispatch + recursion) wrapped by a thin `renderXxxExpr(e: ExprIR):
   string`, plus `render-stmt.ts`
   (`renderXxxStatements(stmts: StmtIR[]): string`), honouring
   `refKind` / `callKind` / `isCollectionOp` tags.  React skips
   these — the frontend doesn't run domain logic.
4. Add procedural emitters in `emit/*.ts` (or `*-emit.ts` on Phoenix)
   and/or larger `*-builder.ts` files using `src/util/code-builder.ts`'s
   `lines` helper.  Rule of thumb: small, regularly-shaped emissions
   go in `emit/`; per-aggregate complexity goes in builders.
5. If the backend serves a wire shape, read `agg.wireShape` /
   `part.wireShape` / `vo.wireShape` directly from the IR — they
   are populated by `enrichLoomModel` in `src/ir/enrich/enrichments.ts`,
   not recomputed per backend.
6. If the platform needs a new value in `Platform`, also extend
   `language/ddd.langium`'s `Platform` rule, `ir/loom-ir.ts`'s
   `Platform` type, and `checkDeployable` in
   `language/validators/deployable.ts` — see the `'react'` addition
   for the pattern.

Most of the work is the builders / templates — the IR already
carries everything needed for code generation.

---

## Tests

The vitest suite under `test/` covers each phase. The directory
layout mirrors the pipeline:

| Suite (current path) | Phase(s) covered |
| --- | --- |
| `test/language/parsing.test.ts` | ① parse |
| `test/macro/expansion.test.ts`, `test/macro/scaffold-equivalence.test.ts` | ② AST macro expansion |
| `test/language/validation.test.ts` (and the sensitivity / money / type-system tests) | ③ link + ④ AST validation |
| `test/ir/lower.test.ts`, `test/ir/page-ir.test.ts`, `test/ir/properties.test.ts`, … | ⑤ lowering |
| `test/ir/enrichments.test.ts`, `test/ir/wire-shape.test.ts`, `test/ir/wire-spec.test.ts` | ⑥ enrichment |
| `test/ir/multifile-validate.test.ts`, `test/ir/invariant-classify.test.ts` | ⑦ IR validation |
| `test/system/architecture-*.test.ts`, `test/system/deployable-composition.test.ts`, `test/system/traceability.test.ts` | ⑨ system orchestration |
| `test/generator/*` (per backend, ~409 files) | ⑧ per-platform output |
| `test/cli/*.test.ts` | ⑩ output writing (`.loomignore`, `--dry-run`) |
| `test/generator/walker-*.test.ts` (~44 files) | ⑧ body-walker primitives |
| `LOOM_TS_BUILD=1 npm run test:tsc` | ⑧ regression — generated TS compiles under strict tsc |
| `LOOM_E2E=1 npm run test:e2e` | full pipeline + content-shape OpenAPI parity + Playwright UI suite |

Generated projects' own type-checking and unit tests serve as the
integration layer: a `.ddd` with `test` blocks produces a vitest
suite that exercises the value-object invariants and operation
preconditions.

The opt-in `LOOM_E2E=1` suite goes one layer further: it boots
the generated docker-compose stack, polls `/health` per deployable,
runs the generated DSL e2e suite against the live system, runs
the auto-generated Playwright UI suite, and — when the same module
is hosted on both platforms — diffs the .NET (Swashbuckle) and
Hono (`@hono/zod-openapi`) OpenAPI specs for `(method, path)`
parity AND for response-schema field-set parity.  Framework-native
OpenAPI emission is the deliberate choice: an IR-derived spec
would always agree with itself even when the running code
disagreed.

---

## Lessons captured

The `experience_gathered.md` at the repo root accumulates lessons
from each iteration — Langium gotchas, IR design trade-offs,
refactor notes (including the v2 architecture lessons), the
Mantine + Playwright findings.  Worth a read before making
non-trivial changes.
