# Loom — Technical Reference

How the compiler is laid out, why the layers exist, and where to make
changes when extending the language or adding a backend.

For language semantics see [`language.md`](language.md); for usage and
the migration story see [`tools.md`](tools.md).

---

## Pipeline at a glance

```
   .ddd source
        │
        ▼      Langium parser & linker
   Loom AST           (concrete syntax tree, references resolved)
        │
        ▼      Validator
   Loom AST + diagnostics
        │
        ▼      Lowering: name resolution, type inference, semantic shaping
   Loom IR            (platform-neutral, fully resolved)
        │
        ▼      Per-backend orchestrator (legacy)
        │      OR system orchestrator (multi-deployable)
   Per-backend / per-deployable file map (path → contents)
        │
        ▼      .loomignore filter + writes
   Generated project(s) on disk
```

For sources that declare a `system { … module … deployable … }`, the
**system orchestrator** (`src/system/index.ts`) calls each backend's
`generate*ForContexts` entry point once per deployable, scoping the
output to the deployable's module subset, and writes everything to a
flat tree:

```
<outdir>/
   <deployable-1>/      # full per-deployable project
   <deployable-2>/
   docker-compose.yml   # at the system root
```

Legacy bare `context` sources still use the per-backend `generate*`
entry points and produce a single project — no system orchestrator
involvement.

Each stage owns a clearly-bounded transformation.  Type information
flows downstream: by the time the IR reaches a backend, every name
reference already carries its `refKind` (parameter / let / lambda /
this-prop / this-vo-prop / this-derived / helper-fn / enum-value), every
member access carries its `receiverType`, and every collection op is
flagged.

---

## Source layout

```
src/
  language/
    ddd.langium          # grammar source
    ddd-module.ts        # Langium DI wiring
    ddd-scope.ts         # custom scoping (parts visible only inside their aggregate)
    ddd-validator.ts     # semantic validation
    type-system.ts       # DddType + expression typing + AST-walk helpers
    main.ts              # LSP server entry
    generated/           # `langium generate` output (parser, AST types)
  ir/
    loom-ir.ts           # platform-neutral IR types
    lower.ts             # AST → IR
  generator/
    typescript/
      hb.ts                  # shared Handlebars instance + helpers
      render-expr.ts         # ExprIR → TS source
      render-stmt.ts         # StmtIR → TS source
      repository-builder.ts  # code-built repository module incl. toWire serializer
      routes-builder.ts      # OpenAPIHono routes + full wire-shape Zod schemas
      templates/
        ids.tpl.ts
        value-objects.tpl.ts
        events.tpl.ts
        aggregate.tpl.ts
        routes.tpl.ts        # http/index.ts (CORS, sub-router composition, /openapi.json)
        schema.tpl.ts        # Drizzle pgTable / pgEnum
        tests.tpl.ts
      templates.ts           # barrel re-export
      index.ts               # orchestrator
    dotnet/
      hb.ts              # shared Handlebars instance + helpers
      render-expr.ts     # ExprIR → C# source (with `thisName` context)
      render-stmt.ts     # StmtIR → C# source
      dto-mapping.ts     # wire ↔ domain conversion: wireType, projectToResponse, wireToCommandArgument
      cqrs-emit.ts       # per-aggregate Commands / Queries / Handlers / DTOs
      find-emit.ts       # repository find-method bodies
      templates/
        ids.tpl.ts
        enums-vos.tpl.ts
        events.tpl.ts
        common.tpl.ts
        entity.tpl.ts
        repository.tpl.ts
        efcore.tpl.ts
        cqrs.tpl.ts
        dto.tpl.ts
        api.tpl.ts
        program.tpl.ts   # hosting entry: CORS, camelCase JSON, EnsureCreated, Swashbuckle
        tests.tpl.ts
      templates.ts
      index.ts
    react/
      hb.ts                  # (placeholder for future template helpers)
      api-builder.ts         # per-aggregate Zod schemas + React Query hooks
      pages-builder.ts       # per-aggregate List / New / Detail pages + data-testid sprinkling
      page-objects-builder.ts # per-aggregate Playwright page objects
      index.ts               # orchestrator + project shell (Vite, package.json, Dockerfile)
  cli/main.ts                # ddd parse / ddd generate {ts|dotnet|system}
  system/
    index.ts                 # multi-deployable orchestrator: per-deployable file routing,
                             # docker-compose.yml, db-init/, env-per-platform
    e2e-render.ts            # `test e2e` block lowering to a vitest+fetch spec file
  util/naming.ts             # pascal / camel / snake / plural
test/                    # vitest suites
examples/                # sample .ddd inputs
docs/                    # this directory
bin/cli.js               # bin shim (loads compiled out/cli/main.js)
```

---

## Stage 1 — Parsing & linking (Langium)

`src/language/ddd.langium` is the single source of truth for syntax.
`langium generate` (run via `npm run langium:generate`) produces:

- `src/language/generated/grammar.ts` — Chevrotain parser.
- `src/language/generated/ast.ts` — TypeScript types for every AST node.
- `src/language/generated/module.ts` — DI registrations.

A few grammar conventions worth knowing:

- Statements use a discriminator field (`AssignOrCallStmt.op`) rather
  than `{infer Subtype.field=current}` actions inside an alternation.
  Inferring subtypes that way produces a recursive AST type because
  `current` refers to the surrounding rule, not to a previously-parsed
  property.
- The `STRING` terminal strips outer quotes from the matched text, so
  string-literal values in the AST are already unquoted.  Consumers
  that emit them must JSON-stringify (or otherwise re-quote).
- `LValue` is flat (`head: string` plus `tail: string[]`) instead of
  recursive, because flat lists are easier for the validator and IR
  to walk.
- `Expression` is a declared `type` union of every expression-node
  subtype.  Without that declaration `LambdaOrExpr returns Expression`
  fails to type-check.

### Custom scoping

`ddd-scope.ts` overrides `Containment.partType` lookup so a
`contains lines: OrderLine[]` reference can only resolve to a part
declared in the same aggregate.  Cross-aggregate access has to go via
`Id<X>`.  All other cross-references use Langium's default scope.

---

## Stage 2 — Validation

`ddd-validator.ts` walks the linked AST after parsing.  It uses
`type-system.ts` for type inference and AST-walk helpers
(`lookupRootMember`, `stepInto`, `findFunction`, `findOperation`).

The validator catches:

- Non-`bool` invariants and preconditions.
- Type mismatches in assignments, derived expressions, find-query
  filters, emit payloads.
- Assignments to derived properties.
- Cross-aggregate `contains` (a structural error the scope provider
  also catches; the validator emits a friendlier message).
- Operations / `test` blocks declared outside an aggregate root.

The type system in `type-system.ts` is small but expressive:

- `DddType` is a tagged union (`primitive` / `id` / `enum` /
  `valueobject` / `entity` / `aggregate` / `array` / `optional` /
  `unknown`).
- `typeOf(expr, env)` typechecks an expression in an `Env`.
- The `Env` carries the aggregate / part / value-object the
  expression sits inside, plus name → type bindings for parameters,
  let-bindings, and lambda parameters.
- Aggregate properties are pre-bound into the env when type-checking
  invariants and operation bodies, so bare property references
  resolve correctly.
- Lambda parameter typing is contextual: when the receiver of a
  collection op is `T[]`, the lambda parameter is bound to `T`.

---

## Stage 3 — Lowering to Loom IR

`src/ir/loom-ir.ts` defines a **platform-neutral** IR — nothing about
TypeScript, C#, Drizzle, or EF leaks in.

`src/ir/lower.ts` walks the AST and emits the IR.  By the end of
lowering:

- Every `ref` carries a `refKind` enum so backends don't reinvent name
  resolution.
- Every `call` carries a `callKind` (`function` / `value-object-ctor` /
  `private-operation` / `free`).
- Every `member-access` carries the `receiverType` and `memberType` so
  backends can pick `.length` vs `.Count` without re-running type
  inference.
- Every `method-call` is flagged `isCollectionOp` when applicable.
- Lambda parameter scoping is applied — by the time a backend sees a
  ref inside a lambda body, it's already tagged `lambda`.

This is the most important architectural decision in Loom: **resolve
everything before the templating layer**.  The first cut had backends
walking the AST directly and re-implementing name resolution; merging
two divergent re-implementations was painful.  The IR collapses this
to a single source of truth.

---

## Stage 4 — Per-backend rendering

Each backend has the same shape:

- A shared **Handlebars instance** with helpers (`pascal`, `camel`,
  `snake`, `plural`, type renderers wrapped in `SafeString`,
  `escapeStr`, `concat`).
- A directory of **templates** (`templates/*.tpl.ts`), one per
  generated construct (ids, value objects, events, entity, repository,
  routes / controllers, …).
- Two **expression renderers** (`render-expr.ts`, `render-stmt.ts`)
  that consume IR nodes recursively and emit source.  Templates use
  these via Handlebars helpers; never via inline recursion.
- An **orchestrator** (`index.ts`) that walks the IR and writes a
  `Map<path, content>`.

### Why templates *and* code-built modules?

Two heuristics:

- If the file's structure is regular (class shape, namespace, member
  layout), use a Handlebars template.  Easy to read, easy to extend.
- If the file's logic varies heavily per-aggregate — for example the
  TS repository's `findById` (load root, load every child collection,
  hydrate parts, instantiate root), or `save` (upsert root, diff-sync
  contained collections, dispatch events) — emit it as a code-built
  string in TypeScript.  Trying to express that in Handlebars produces
  a tangle of conditionals.

The .NET backend is mostly templates because EF Core's tracker handles
the diff-sync at runtime, so the repository file is much smaller.

The React backend has no templates at all — every file is built
procedurally because the JSX is rich enough that templating produces
unreadable output.  Three builders own the per-aggregate emission:

- `api-builder.ts` — Zod schemas + React Query hooks (one module per
  aggregate; same wire shape the backends serve).
- `pages-builder.ts` — List / New / Detail pages.  Sprinkles
  `data-testid` on every interactive element so page objects key off
  stable selectors.  Operations on the detail page open a Mantine
  modal whose form is bound to the matching `<Op>Request` schema.
- `page-objects-builder.ts` — Playwright page-object class per page,
  emitted into `<deployable>/e2e/pages/<aggregate>.ts`.  Methods
  reflect the IR: `fill(input: Partial<Create<Agg>Request>)`, one
  method per public operation typed against `<Op>Request`,
  `<containment>Count()` per master-detail collection, and a
  `field<K extends keyof <Agg>Response>(name: K)` reader.

### Wire-shape: cross-platform symmetry

Backends and frontend agree on the JSON shape for each aggregate, so
the cross-platform OpenAPI cross-check stays meaningful and the React
generator's response Zod schemas mirror what every backend serves.
The shape is built around four invariants:

- Identity is `id: string` (the underlying Guid/int/long/string is
  always rendered as a string on the wire, so brands round-trip
  through forms).
- Every non-derived field appears.  Derived values appear too —
  computed server-side, returned alongside.
- `contains` parts render as nested objects (or arrays of objects),
  not flattened columns.  Master-detail data drops directly into
  `<Table>` rows.
- Value objects render as nested objects (`{ amount, currency }`).
  Decimal values cross the wire as JSON numbers; datetimes as ISO
  strings.

The Hono path projects through `repository.toWire(root)` (emitted by
`repository-builder.ts`); the .NET path projects through
`<Agg>Mapper.ToDto(...)` (emitted by `cqrs-emit.ts` via
`dto-mapping.ts`).  Both produce identical JSON for identical state.

### Auto-included `findAll`

Lowering injects an `all(): T[]` find into every aggregate's
repository (creating one if no `repository` block is declared).
Backends emit `GET /<plural>` for it; the React frontend uses it for
the list page.  User-declared `find all(...)` overrides the implicit
one.

### CORS + camelCase JSON (for cross-platform cohesion)

The .NET `Program.cs` template configures
`JsonSerializerOptions.PropertyNamingPolicy = CamelCase` so its wire
matches Hono's natural casing.  Both backends enable permissive CORS
(`AllowAnyOrigin / AllowAnyHeader / AllowAnyMethod` in .NET,
`app.use("*", cors())` in Hono) so a generated React frontend on a
different port reaches them in dev compose without preflight pain.
Production hardening is a `.loomignore` override on `Program.cs` /
`http/index.ts`.

### Proxy-CA escape hatch (`certs/`)

Each generated deployable contains a `certs/.gitkeep` placeholder, and
each Dockerfile unconditionally `COPY certs/`s into
`/usr/local/share/ca-certificates/` and either runs
`update-ca-certificates` (.NET) or sets
`NODE_EXTRA_CA_CERTS / NPM_CONFIG_CAFILE` (Node).  Drop your proxy's
`*.crt` files into `<deployable>/certs/` before
`docker compose build` — empty `certs/` is a no-op, so unsandboxed
environments aren't affected.

### Handlebars gotchas worth knowing

- `}}}` is parsed as triple-stash close.  `{{/each}}` followed
  immediately by a literal `}` looks like one — always put a newline
  or space between them.
- HTML escaping is on by default.  Helpers that emit raw source
  (`csType`, `tsType`, `csParams`) wrap their result in
  `new hb.SafeString(...)` so generic syntax like `List<T>` survives.
- `(concat a b c)` works as a sub-expression because `concat` is
  registered as a helper that joins all args except the trailing
  options object.

---

## Stage 5 — Output write

`src/cli/main.ts`:

1. Parses + validates the input `.ddd`; aborts on errors.
2. Calls the backend orchestrator to get a `Map<path, contents>`.
3. Loads `.loomignore` from the output directory (gitignore syntax via
   the `ignore` npm package).
4. Iterates the map in sorted-path order; for each path checks the
   ignore matcher and either writes or skips.
5. If `--dry-run`, prints the plan with `write` / `skip` annotations
   without touching the filesystem.

Migrations directories (`db/migrations/`,
`Infrastructure/Persistence/Migrations/`) are never in the generated
map, so they're safe by construction.

---

## Adding a language feature

Rough recipe:

1. **Grammar** — add the syntax in `ddd.langium`; run
   `npm run langium:generate`.
2. **AST scope / validation** — if the new node introduces names or
   has type constraints, update `ddd-scope.ts` / `ddd-validator.ts` /
   `type-system.ts`.
3. **IR** — add the IR node in `loom-ir.ts`; lower it in `lower.ts`.
4. **Renderers** — extend `render-expr.ts` / `render-stmt.ts` for
   each backend.
5. **Templates** — add or extend the relevant `templates/*.tpl.ts`
   files.
6. **Orchestrator** — wire up the new emission in
   `generator/{typescript,dotnet}/index.ts` if a new file appears.
7. **Tests** — at least one parsing test, one validator test (negative
   case), one generator test per backend.
8. **Examples** — extend an existing `.ddd` to exercise the feature
   end-to-end.

---

## Adding a new backend

Two precedents in tree:

- `generator/typescript/` — Hono backend.  Templates for the regular
  per-aggregate shapes; procedural builders for `routes-builder.ts`
  (where OpenAPI annotations make templates noisy) and
  `repository-builder.ts` (where `findById` / `save` / `toWire` vary
  too much per aggregate to template cleanly).
- `generator/dotnet/` — .NET backend.  Mostly templates because EF's
  change-tracker absorbs the per-aggregate variance.
- `generator/react/` — React frontend.  All procedural — the JSX +
  TSX grammar is rich enough that templates produce unreadable
  output.

The shape:

1. Create `generator/<backend>/index.ts` with a
   `generate<Backend>ForContexts(contexts, ...) → Map<path, content>`
   entry.
2. Add procedural builders or `templates/*.tpl.ts` files for each
   generated construct.  Templating-vs-builder decision: regular
   structure → template; per-aggregate variation → builder.
3. If the backend executes domain logic, implement `render-expr.ts`
   (`renderXxxExpr(e: ExprIR): string`) and `render-stmt.ts`
   (`renderXxxStatements(stmts: StmtIR[]): string`), honouring
   `refKind` / `callKind` / `isCollectionOp` tags.  React skips
   these — the frontend doesn't run domain logic, only consumes the
   wire shape.
4. Wire the new backend into `cli/main.ts` (`generate <backend>`
   sub-command) and into `system/index.ts`'s deployable switch.
5. If the platform needs a new value in `Platform`, also extend
   `language/ddd.langium`'s `Platform` rule, `ir/loom-ir.ts`'s
   `Platform` type, and `language/ddd-validator.ts`'s
   `checkDeployable` — see the `'react'` addition for the pattern.

Most of the work is the builders / templates — the IR already
carries everything needed for code generation.

---

## Tests

The vitest suite in `test/` covers:

- Parsing and validation of every example file.
- Negative validation (non-bool invariants/preconditions, derived
  assignment, emit shape mismatches).
- Generator emission and structure (file set + key matchers).
- CLI behaviour (`.loomignore`, `--dry-run`, project-shell file
  absence).
- System mode: per-deployable file routing, docker-compose wiring,
  per-deployable database isolation, and the cross-platform OpenAPI
  parity diff (when the same module is hosted on both backends).

Generated projects' own type-checking and unit tests serve as the
integration layer: a `.ddd` with `test` blocks produces a vitest
suite that exercises the value-object invariants and operation
preconditions.

The opt-in `LOOM_E2E=1` suite (`test/e2e.test.ts`) goes one layer
further: it boots the generated docker-compose stack, polls
`/health` per deployable, runs the generated DSL e2e suite against
the live system, and — when the same module is hosted on both
platforms — diffs the .NET (Swashbuckle) and Hono
(`@hono/zod-openapi`) OpenAPI specs for `(method, path)` parity.
Framework-native OpenAPI emission is the deliberate choice: an
IR-derived spec would always agree with itself even when the
running code disagrees.

---

## Lessons captured

The `experience_gathered.md` at the repo root accumulates lessons from
each iteration — Langium gotchas, Handlebars escaping, IR design
trade-offs, refactor notes.  Worth a read before making non-trivial
changes.
