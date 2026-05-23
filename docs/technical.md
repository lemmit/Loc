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

```
   .ddd source text
         │
         ▼   ① Lexer + parser + linker (Langium / Chevrotain)
   Loom AST                            ─ tokens, CST, AST nodes,
                                         cross-references resolved
         │
         ▼   ② Validator (semantic checks against the linked AST)
   Loom AST + diagnostics              ─ aborts with non-zero exit
                                         code on errors
         │
         ▼   ③ Lowering (AST → Loom IR)
   Loom IR                             ─ platform-neutral, fully
                                         resolved: every name carries
                                         a refKind, every member
                                         access carries types, every
                                         find filter is an ExprIR
         │
         ▼   ④ Wire-shape derivation (shared)
   WireField[] per aggregate / part    ─ canonical field list every
                                         backend's response DTO
                                         walks identically
         │
         ▼   ⑤ Per-platform shaping
   Map<path, content> per deployable   ─ Hono / .NET / React, plus
                                         shared helpers for ids,
                                         events, common errors
         │
         ▼   ⑥ System orchestration (multi-deployable mode)
   Map<path, content> for the system   ─ docker-compose.yml,
                                         db-init/, e2e/, ui specs,
                                         per-deployable env vars
         │
         ▼   ⑦ Output writing (.loomignore filter)
   Files on disk
```

The pipeline is one-directional.  Each layer reads only from the
layer above and produces output the next layer consumes — no
back-edges, no shared mutable state.  This is enforced by file
structure: `language/` knows nothing about `ir/`, `ir/` knows
nothing about `generator/`, `generator/<platform>/` knows nothing
about other platforms, and `system/` composes everything from above.

---

## Layer ① — Lexing, parsing, linking

**Files**
- `src/language/ddd.langium` — single source-of-truth grammar.
- `src/language/generated/` — output of `langium generate`: parser,
  AST types, reflection metadata, scope-provider hooks.
- `src/language/ddd-module.ts` — Langium DI wiring.
- `src/language/ddd-scope.ts` — custom scope provider.
- `src/language/main.ts` — LSP server entry.

**Inputs**
- Raw `.ddd` text via Langium's `LangiumDocuments` service.

**Outputs**
- A linked `Model` AST node — every cross-reference (`Id<X>`,
  `partType`, `aggregate`, etc.) has its `.ref` populated.
- Parse / lex diagnostics on `doc.diagnostics` (severity-tagged).

**Responsibilities**
- Tokenize the source per the grammar's terminals (`STRING`, `INT`,
  `DECIMAL`, `ID`, comment / whitespace skips).
- Build the CST and convert to the typed AST.
- Run cross-reference linking — the scope provider tells Langium
  which names are visible at each `[Foo:ID]` site.
- For containment partTypes, the custom scope provider restricts
  the candidate set to entity parts declared in the same aggregate
  (cross-aggregate part references must use `Id<X>`).

**Non-responsibilities** (deliberate)
- No type checking — that's Layer ②.
- No semantic shaping — the AST mirrors the grammar 1:1.
- No name resolution beyond `[Foo:ID]` scoping (e.g., bare-name
  identifiers in expressions are not resolved here).
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

## Layer ② — Validation

**Files**
- `src/language/ddd-validator.ts` — semantic checks.
- `src/language/type-system.ts` — `DddType` + AST-walk helpers
  (`typeOf`, `lookupRootMember`, `stepInto`, `findFunction`,
  `findOperation`, etc.).

**Inputs**
- Linked AST from Layer ①.

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
- **Reference scoping**: `Id<X>` resolves to a known target; a
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

## Layer ③ — Lowering (AST → Loom IR)

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

The lowering layer is split into two cooperating modules:

### Layer ③a — Structure layer

**File**: `src/ir/lower.ts` (~450 lines).

**Responsibilities** — top-down structural walk:

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
Layer ③b.

It also performs two **post-pass derivations** that depend on the
IR shape:

- **Auto-included `findAll`** — every aggregate gets an implicit
  `find all(): T[]`.  If a user already declared one of that name,
  theirs wins.  Mirrors how `findById` is implicit.
- **React `targets:` module inheritance** — a `platform: react`
  deployable's `moduleNames` is set to its target deployable's, so
  every layer that walks `moduleNames` (system file routing, the
  api-builder) sees the same module surface the backend exposes.

### Layer ③b — Expression layer

**File**: `src/ir/lower-expr.ts` (~730 lines).

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
| `widenNumeric` | `int → long → decimal` widening for arithmetic. |
| `memberType` / `memberOnEntity` / `memberOnValueObject` | `T.member` typing — handles primitives, entities, value objects, collection ops, and the `string.length` shortcut. |
| `findEntityByName` / `findValueObjectByName` / `findFunctionInEnv` / `findOperationInEnv` | Look-ups that run against the env (parts → aggregate → ctx). |
| `pathType` / `stepInto` | Type a multi-segment LValue path (for assign / add / remove). |
| `ancestorAggregate` | AST → enclosing aggregate (used for cross-cutting `Id<X>` value-type resolution). |
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

**Non-responsibilities**
- No platform-aware decisions (TS vs C# vs React).
- No string emission — produces typed IR only.
- No I/O.

---

## Loom IR shape

Defined in `src/ir/loom-ir.ts`.  The whole IR is a tree of immutable
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

## Layer ④ — IR enrichment (wire-shape, auto-finds, associations, react inheritance)

**File**: `src/ir/enrichments.ts`.

After lowering returns a faithful AST projection, `enrichLoomModel(loom)`
runs a single pure pass that populates everything cross-cutting
the IR consumers need.  Four derivations, in order:

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
   field whose type is a reference collection (`Id<X>[]`), carrying
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

**Idempotent** — `enrich(enrich(m))` deep-equals `enrich(m)`.

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

## Layer ⑤ — Per-platform shaping

Each platform has the same module shape (in `src/generator/<platform>/`):

| File | Role |
| --- | --- |
| `index.ts` | Orchestrator — `generate<Platform>ForContexts(contexts, ...) → Map<path, content>`. |
| `templates/*.tpl.ts` | Procedural emitters (`render<Thing>(...)`) for regular-shaped fragments — id classes, value-object classes, events, common errors, etc.  Despite the `.tpl.ts` filename retained from the v1 layout, every one of these files is now a plain TypeScript function building strings via `lines(...)` from `src/util/code-builder.ts`. |
| `*-builder.ts` | Procedural builders for content with too much per-aggregate variation to keep small (Hono routes, Hono repositories, React pages, React page-objects). |
| `render-expr.ts` / `render-stmt.ts` | Recursive `ExprIR → string` / `StmtIR → string` renderers (only on platforms that execute domain logic — TS and .NET, not React). |

### All-procedural emission

The Loom v2 refactor dropped Handlebars in Phase 4.  Every file is
now built procedurally on top of two primitives in
`src/util/code-builder.ts`:

- `lines(...parts)` — joins strings / arrays / `null` / `undefined`
  / `false` with `\n`, dropping nullish entries.  Used everywhere
  whitespace-controlled emission would have lived in a template.
- `Block` — a small indenting line buffer.  Available for blocks
  with non-trivial nesting; current callers all use `lines`.

The platform separation that used to be templated (`templates/*.tpl.ts`
+ `hb.ts`) is now: each `templates/*.tpl.ts` file is a plain
TypeScript module exporting `render<Thing>(args)` functions.  No
runtime parsing, no SafeString escaping, no helper registration —
the type checker validates every data flow from the IR to the
rendered string.

### Hono backend (`src/generator/typescript/`)

| File | Owns |
| --- | --- |
| `index.ts` | Project shell (package.json, tsconfig, vite-style index.ts, Dockerfile, certs/ dir). |
| `templates/ids.tpl.ts` | Branded id types + smart constructors. |
| `templates/value-objects.tpl.ts` | Enums + value-object classes. |
| `templates/events.tpl.ts` | Domain-event union + dispatcher. |
| `templates/aggregate.tpl.ts` | Aggregate / part class shape. |
| `templates/schema.tpl.ts` | Drizzle `pgTable` / `pgEnum` declarations. |
| `templates/routes.tpl.ts` | `http/index.ts` composer (CORS + sub-router mount + `/openapi.json`). |
| `templates/tests.tpl.ts` | Per-aggregate vitest spec when `test` blocks present. |
| `routes-builder.ts` | OpenAPIHono router per aggregate — full Zod schemas via wire-shape, routes for create / get-by-id / find-all / per-op / per-find, domain-error handler. |
| `repository-builder.ts` | Per-aggregate repository — find-by-id (load + hydrate), get-by-id (throws), save (upsert + diff-sync + dispatch), find-all + user finds (with Drizzle `where`-clause lowering), `toWire` serializer. |
| `render-expr.ts` / `render-stmt.ts` | IR → idiomatic TS for invariants / preconditions / op bodies. |

### .NET backend (`src/generator/dotnet/`)

| File | Owns |
| --- | --- |
| `index.ts` | Project shell + per-aggregate emission orchestration. |
| `templates/ids.tpl.ts` | `record struct OrderId(Guid Value)` + `New()`. |
| `templates/enums-vos.tpl.ts` | C# enums + value-object records. |
| `templates/events.tpl.ts` | `IDomainEvent` + per-event records. |
| `templates/common.tpl.ts` | `DomainException`, `AggregateNotFoundException`, `IDomainEventDispatcher`, `NoopDomainEventDispatcher`. |
| `templates/entity.tpl.ts` | Aggregate / part class shape. |
| `templates/repository.tpl.ts` | Repository interface + EF-backed implementation. |
| `templates/efcore.tpl.ts` | `AppDbContext` + `IEntityTypeConfiguration<T>` per aggregate. |
| `templates/cqrs.tpl.ts` | Command + Query records, handler scaffolds. |
| `templates/dto.tpl.ts` | Request + Response record headers (params come from `dto-mapping`). |
| `templates/api.tpl.ts` | `[ApiController]` + `[Route]` controller per aggregate, plus `DomainExceptionFilter`. |
| `templates/program.tpl.ts` | Hosting entry: DbContext, Mediator, Swashbuckle, CORS, camelCase JSON, `EnsureCreated`, `/health`. |
| `templates/tests.tpl.ts` | xUnit project + per-aggregate test class. |
| `dto-mapping.ts` | Wire ↔ domain conversion: `wireType`, `wireToCommandArgument`, `projectToResponse`, `projectEntityExpr`, `aggregateResponseParams`, `entityResponseParams`.  Walks `wireFieldsForAggregate` so the DTOs line up with every other backend. |
| `cqrs-emit.ts` | Per-aggregate orchestration: emits Request / Response DTO files, Command + Handler per public op, Query + Handler per find, controller. |
| `find-emit.ts` | Repository find-method bodies (LINQ predicate from convention or from a `where` filter). |
| `render-expr.ts` / `render-stmt.ts` | IR → idiomatic C#, with a `thisName` context (e.g., `x` for find filters' `.Where(x => …)`). |

### React frontend (`src/generator/react/`)

| File | Owns |
| --- | --- |
| `index.ts` | Project shell (Vite, package.json, tsconfig, index.html, Dockerfile, certs/ dir, App.tsx with router, main.tsx with providers, e2e/ suite shell). |
| `api-builder.ts` | Per-aggregate API module: Zod schemas (request + response, walked via `wireFieldsForAggregate`) + React Query hooks (one per route, plus one `use<Op><Agg>` mutation hook per public operation). |
| `body-walker.ts` | The **single** page-codegen path.  Walks a page's `body:` `ExprIR` and emits TSX by dispatching every walker-stdlib primitive (`Stack`/`Table`/`QueryView`/`Form`/`Modal`/`KeyValueRow`/…) through the active design pack's `primitive-*` templates.  No archetype renderers — `page <Name> { body: … }` and scaffolded pages share this one walker. |
| `form-helpers.ts` | Per-type form-input dispatch (`prepareFormFieldVM`/`renderFormField`): text/number/switch/select/fieldset/datetime, RHF `register` vs `Controller`, initial-value generation, `Id<X>` → `useAll<Target>()` picker injection.  Shared by `Form(of:)`, `Form(runs:)`, and operation-modal forms. |
| `pages-emitter.ts` | Page shell: wraps the walker's body TSX with `useForm`/mutation-hook/`useParams`/import declarations the body recorded on the walk context. |
| `page-objects-builder.ts` / `walker-page-objects.ts` | Per-aggregate Playwright page-object class — keyed off the `data-testid` strings every primitive threads through (`testid:` named arg). |

`pages-builder.ts` is the **deleted** legacy archetype renderer's
husk, retained only as a utility module the Phoenix LiveView
pipeline still imports; it is not on the React codegen path.

The React side has no `render-expr.ts` / `render-stmt.ts`: the
frontend doesn't run domain logic, only consumes the wire shape.

### Scaffold expansion (compile-time sugar, not a codegen path)

`scaffold` is **not** a parallel renderer.  It is a two-stage
compile-time rewrite that lowers a domain selector into ordinary
walker-stdlib pages a user could have hand-written:

```
ui { scaffold modules: Sales }
        │
        ▼  Pass 1 — AST→AST   src/language/ddd-scaffold-ast-expander.ts
   synthesised `Page` AST nodes (name, route, menu, and a
   high-level body call: List(of:) / Form(of:) / Detail(of:, by:) …)
   each tagged with a `scaffoldOrigin` discriminator
        │
        ▼  Pass 2 — IR rewrite   src/ir/scaffold-expander.ts
   `lowerSystem` → `expandScaffoldPages`: every page whose
   `scaffoldOrigin` is recognised gets its `body` replaced with the
   fully-expanded walker-stdlib `ExprIR` (`expandAggregateList`,
   `expandAggregateDetail`, `expandWorkflowForm`, …)
        │
        ▼  the ordinary body-walker renders it through the pack
```

The IR expander is the contract for *what a scaffolded page
contains*.  Per archetype:

| Origin | Synthesised body |
| --- | --- |
| `aggregate-list` | `Stack(Breadcrumbs, Toolbar(Heading, Button "New"), QueryView(of: api.Agg.all, …, data: Paper(Table(Column per non-collection field))))` |
| `aggregate-new` | `Stack(Breadcrumbs, Heading, Card(Form(of: Agg)))` |
| `aggregate-detail` | `Stack(Breadcrumbs, Heading, QueryView(of: api.Agg.byId(id), single: true, data:` → `Card(Stack(KeyValueRow per scalar field))` **+ one `Modal(trigger: Button, Form(data.<op>))` per public operation + one `Card(Heading, Table)` per `contains` collection (related-entity list)** `))` |
| `workflow-form` | `Stack(Breadcrumbs, Heading, Card(Form(runs: wf)))` |
| `view-list` | `Stack(Heading, QueryView(of: Views.<name>, data: Paper(Table)))` |
| `home` / `workflows-index` / `views-index` | `Stack(Heading, Stack(Card per aggregate/workflow/view))` |

Because the output is plain walker stdlib, every scaffolded feature
is reachable from an explicit `page <Name> { body: … }` —
`examples/acme-order-explicit.ddd` is the hand-written equivalent of
`scaffold aggregates: Order` and is asserted byte-equivalent in CI.

---

## Layer ⑥ — System orchestration (multi-deployable)

**File**: `src/system/index.ts` plus `src/system/e2e-render.ts`,
`src/system/ui-e2e-render.ts`.

**Inputs**: `LoomModel.systems[]` (each carries modules,
deployables, and e2e tests).

**Outputs**: a flat tree of files:

```
<outdir>/
├── docker-compose.yml         # postgres + every deployable + healthchecks
├── db-init/
│   └── 00-create-databases.sql # one DB per backend deployable
├── <deployable-1>/             # full per-platform project (Layer ⑤)
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
- Per-deployable file routing — call the right backend's
  `generate*ForContexts(contexts, ...)` with the modules each
  deployable declares (and the target's modules for react
  deployables).
- `docker-compose.yml` with a `db` service, per-deployable services
  (depends_on / env / healthcheck per platform), and a `pgdata`
  volume.
- `db-init/00-create-databases.sql` — one `CREATE DATABASE` per
  backend deployable so EF Core's `EnsureCreated` doesn't race
  against peer backends sharing the same db.
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

`expect <expr>` becomes `expect(<expr>).toBe(true)`;
`expectThrows <expr>` becomes
`await expect(async () => { <expr>; }).rejects.toThrow()`.

The UI / api split is determined automatically from the target
deployable's platform — no DSL keyword required.  This is why the
DSL grammar has a single `test e2e` form rather than e.g. a
reserved `'ui'` modifier (which would shadow the body's
`ui.X.Y(...)` identifiers).

**Non-responsibilities**
- The system layer doesn't generate domain code — it only routes
  and composes outputs from Layer ⑤.
- It doesn't decide platform-internal details (CORS, JSON casing,
  database schema) — those live with the per-platform generators.

---

## Layer ⑦ — Output writing

**File**: `src/cli/main.ts`.

**Inputs**: a `Map<path, content>` from Layer ⑤ (legacy mode) or
Layer ⑥ (system mode).

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

**After Layer ① (parse + link):**

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

**After Layer ② (validation):**

- `isMutable` is a known `function` declared on `Order` — OK.
- `lines.count > 0` → `count` is the collection-op on `OrderLine[]`
  returning `int`, comparison returns `bool` — OK.
- `status := Confirmed` → `status` is `OrderStatus`, `Confirmed`
  is an enum value of that type — OK.
- `emit OrderConfirmed { order, at }` matches the declared event
  shape — OK.

**After Layer ③ (lowering):**

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

**After Layer ⑤ (TypeScript backend):**

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

`render-expr.ts` walks each expression:
- `call { callKind: "function" }` → `this.<name>(<args>)`
- `member { ..., isCollectionOp: false }` on `array.count` →
  `this._lines.length` (the renderer knows `count` on a collection
  IR maps to JS `.length`).
- `id` (the implicit identity) → `this._id`.
- `literal { lit: "now" }` → `new Date()`.
- `ref { refKind: "enum-value", enumName: "OrderStatus", name:
  "Confirmed" }` → `OrderStatus.Confirmed`.

**After Layer ⑤ (.NET backend):**

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
IR is the payoff for fully resolving everything in Layer ③.

---

## How to extend

### Adding a language feature

Rough recipe:

1. **Grammar** — add the syntax in `ddd.langium`; run
   `npm run langium:generate` to regenerate the parser + AST types.
2. **AST scope / validation** — if the new node introduces names
   or has type constraints, update `ddd-scope.ts` /
   `ddd-validator.ts` / `type-system.ts`.
3. **IR** — add the IR node in `loom-ir.ts`; lower it in
   `lower.ts` (structure) or `lower-expr.ts` (expression /
   statement / type).
4. **Renderers** — extend `render-expr.ts` / `render-stmt.ts` for
   each backend that emits domain logic (TS, .NET).
5. **Templates / builders** — add or extend the relevant
   `templates/*.tpl.ts` files or `*-builder.ts` modules.
6. **Orchestrator** — wire up new file emission in
   `generator/<backend>/index.ts` if a new file appears.
7. **Tests** — at least one parsing test, one validator test
   (negative case), one generator test per backend that emits the
   feature.
8. **Examples** — extend an existing `.ddd` to exercise the
   feature end-to-end; verify with `npx vitest run` and
   `LOOM_TS_BUILD=1 npx vitest run test/generated-build.test.ts`.

### Adding a new backend

Three precedents in tree:

- `generator/typescript/` — Hono.  Procedural emitters for fixed
  shapes (`templates/*.tpl.ts`); larger procedural builders
  (`*-builder.ts`) where per-aggregate variation is high.
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
3. For domain-logic-running backends, implement `render-expr.ts`
   (`renderXxxExpr(e: ExprIR): string`) and `render-stmt.ts`
   (`renderXxxStatements(stmts: StmtIR[]): string`), honouring
   `refKind` / `callKind` / `isCollectionOp` tags.  React skips
   these — the frontend doesn't run domain logic.
4. Add procedural emitters in `templates/*.tpl.ts` and/or larger
   `*-builder.ts` files using `src/util/code-builder.ts`'s `lines`
   helper.  Rule of thumb: small, regularly-shaped emissions go in
   `templates/`; per-aggregate complexity goes in builders.
5. If the backend serves a wire shape, read `agg.wireShape` /
   `part.wireShape` / `vo.wireShape` directly from the IR — they
   are populated by `enrichLoomModel` in `src/ir/enrichments.ts`,
   not recomputed per backend.
6. If the platform needs a new value in `Platform`, also extend
   `language/ddd.langium`'s `Platform` rule, `ir/loom-ir.ts`'s
   `Platform` type, and `language/ddd-validator.ts`'s
   `checkDeployable` — see the `'react'` addition for the pattern.

Most of the work is the builders / templates — the IR already
carries everything needed for code generation.

---

## Tests

The vitest suite in `test/` covers each layer:

| Suite | Layer(s) covered |
| --- | --- |
| `parsing.test.ts` | ① parse + link |
| `validation.test.ts` | ②, plus deployable-level checks |
| `generator-ts.test.ts` / `generator-dotnet.test.ts` / `generator-react.test.ts` | ⑤ per-platform output |
| `system.test.ts` | ⑥ multi-deployable orchestration |
| `cli.test.ts` | ⑦ output writing (`.loomignore`, `--dry-run`) |
| `generated-build.test.ts` (opt-in `LOOM_TS_BUILD=1`) | ⑤ regression — generated TS compiles under strict tsc |
| `e2e.test.ts` (opt-in `LOOM_E2E=1`) | full pipeline + content-shape OpenAPI parity + Playwright UI suite |

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
