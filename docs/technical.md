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

## Layer ④ — Wire-shape derivation (shared)

**File**: `src/generator/wire-shape.ts`.

**Inputs**: an `AggregateIR` / `EntityPartIR` / `ValueObjectIR` plus
its enclosing `BoundedContextIR`.

**Outputs**: `WireField[]` — the canonical, ordered list of fields
that appear on the network for that entity:

```ts
interface WireField {
  name: string;                      // JSON key
  type: TypeIR;                      // domain-typed value
  optional: boolean;
  source: "id" | "property" | "containment" | "derived";
}
```

**Order is the contract**: `id` first, then declared properties in
declaration order, then containments (collections rendered as
`array<entity>`, singles as `entity`), then derived values.  Every
backend's response-DTO emitter walks the same list, so:

- Hono `routes-builder` → `<Agg>Response = z.object({ ... })` zod schema
- Hono `repository-builder` → `repo.toWire(root)` JS object literal
- .NET `dto-mapping` → `<Agg>Response(...)` C# record + projection
  expression
- React `api-builder` → matching response Zod schema

If they all agree on the WireField list (because they all call the
same function), drift between backends becomes structurally
impossible.

**Non-responsibilities**
- No language-specific rendering — each generator turns `WireField`
  into Zod / C# / TS source on its own.
- No knowledge of which platform consumes the shape.

---

## Layer ⑤ — Per-platform shaping

Each platform has the same module shape (in `src/generator/<platform>/`):

| File | Role |
| --- | --- |
| `index.ts` | Orchestrator — `generate<Platform>ForContexts(contexts, ...) → Map<path, content>`. |
| `templates/*.tpl.ts` | Handlebars templates for regular-shaped emissions (id classes, value-object classes, common errors, etc.). |
| `*-builder.ts` | Procedural builders for content with too much per-aggregate variation to template cleanly (Hono routes, Hono repositories, React pages, React page-objects). |
| `render-expr.ts` / `render-stmt.ts` | Recursive `ExprIR → string` / `StmtIR → string` renderers (only on platforms that execute domain logic — TS and .NET, not React). |
| `hb.ts` | Per-platform Handlebars instance with helpers (`pascal`, `camel`, `snake`, `plural`, `csType`, `tsType`, `csParams`, etc.). |

### Templates vs procedural builders — when to use which

Two heuristics, applied per file:

- **Regular structure** (class shape, namespace, member layout):
  use a Handlebars template.  Easy to read, easy to extend, the
  templating language naturally expresses iteration over fields /
  ops / parts.
- **Per-aggregate logic varies heavily**: emit as procedural
  builder.  Examples: Hono's `findById` (load root, load every
  child collection, hydrate parts, instantiate root), Hono's
  `save` (upsert root, diff-sync contained collections, dispatch
  events), the React detail page (per-aggregate field display +
  per-op modal forms).

The .NET backend is mostly templates because EF Core's tracker
handles the diff-sync at runtime, so the repository is much
smaller than Hono's.

The React backend is **all procedural** — JSX is rich enough that
Handlebars produces unreadable output.

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
| `api-builder.ts` | Per-aggregate API module: Zod schemas (request + response, walked via `wireFieldsForAggregate`) + React Query hooks (one per route). |
| `pages-builder.ts` | List / New / Detail page TSX, plus part-table rendering and operation-modal scaffolding. |
| `form-helpers.ts` | Mantine input set computation (precise import lines), per-type input rendering (TextInput / NumberInput / Switch / Select / Fieldset / native datetime), initial-value generation. |
| `page-objects-builder.ts` | Per-aggregate Playwright page-object class — keyed off the `data-testid` attributes pages-builder sprinkles. |

The React side has no `render-expr.ts` / `render-stmt.ts`: the
frontend doesn't run domain logic, only consumes the wire shape.

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

- `generator/typescript/` — Hono.  Templates for regular shapes;
  procedural builders where per-aggregate variation is high.
- `generator/dotnet/` — .NET.  Mostly templates because EF
  absorbs the per-aggregate diff at runtime.
- `generator/react/` — React frontend.  All procedural — the JSX
  grammar is rich enough that templates produce unreadable output.

The shape:

1. Create `generator/<backend>/index.ts` exporting
   `generate<Backend>ForContexts(contexts, ...) → Map<path, content>`.
2. For domain-logic-running backends, implement `render-expr.ts`
   (`renderXxxExpr(e: ExprIR): string`) and `render-stmt.ts`
   (`renderXxxStatements(stmts: StmtIR[]): string`), honouring
   `refKind` / `callKind` / `isCollectionOp` tags.  React skips
   these — the frontend doesn't run domain logic.
3. Add procedural builders or `templates/*.tpl.ts` files for each
   generated construct.  Templating-vs-builder decision: regular
   structure → template; per-aggregate variation → builder.
4. If the backend serves a wire shape, derive its DTOs from
   `wireFieldsForAggregate` / `wireFieldsForPart` in
   `src/generator/wire-shape.ts` so it stays in sync with peers.
5. Wire the new backend into `cli/main.ts` (`generate <backend>`
   sub-command) and `system/index.ts`'s deployable switch.
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
from each iteration — Langium gotchas, Handlebars escaping, IR
design trade-offs, refactor notes, the Mantine + Playwright
findings.  Worth a read before making non-trivial changes.
