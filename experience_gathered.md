# Loom — Experience Gathered

Lessons captured while bootstrapping the Loom DDD DSL (Langium → Loom IR →
procedural builders → TypeScript / .NET). Written for whoever picks this
up next.

---

## 1. Langium grammar gotchas

### `{infer X.field=current}` does NOT do what you think
Inside an alternation following a previously-parsed property:

```langium
AssignOrCallStmt:
    target=LValue (
        {infer AssignStmt.target=current} ':=' value=Expression
        ...
    );
```

`current` here is the **entire AssignOrCallStmt being built so far**, not
the LValue you just parsed. The result is `AssignStmt.target =
AssignOrCallStmt`, which generates a circular AST type that fails type-check.
**Fix**: use a discriminator field instead of inferring subtypes, or split
the rule so the action sits between the parsed value and the rule body:

```langium
AssignOrCallStmt: target=LValue (op=':='|'+='|'-=' value=Expression)?;
```

### Recursive vs flat list rules
`a.b.c.d` can be modeled as a recursive `LValue` with a `parent` pointer or
as a flat `head=ID ('.' tail+=ID)*`. Recursive looks elegant in the grammar
but the resulting AST is awkward to walk. **Flat-list is almost always the
right choice** unless you have actual nesting semantics.

### Type unions need to be declared
If multiple rules use `infers Expression` and any other rule says `returns
Expression`, Langium needs `Expression` to be declared via either a
`type` alias or `interface`. Missing declarations fail with `The type
'Expression' is not explicitly declared and must be inferred.`

### `STRING` terminal strips its delimiters
Langium's default behavior: the matched text is stored, but quotes are
stripped from the AST value. So `"USD"` in source → `USD` (3 chars) in
`StringLit.value`. **Always re-quote when emitting** (`JSON.stringify` or
equivalent).

### `langium/lsp` ≠ `langium`
`Module` and `inject` live in `langium`, not in `langium/lsp`. The
`createDefaultModule`, `LangiumServices`, etc. live in `langium/lsp`. Get
the imports wrong and you'll get cryptic runtime DI failures.

### `Array.filter(typeGuard)` and union-of-arrays
When a property is typed as `T1[] | T2[]` (e.g., aggregate `members` vs.
entity-part `members`), TypeScript's `filter` does **not** narrow the
result, even with a type guard. Cast through a single element-typed
intermediate, e.g.
`(entity.members as readonly { $type: string }[]).filter(isProperty)`.

### Cross-references and scoping
Default scoping makes every top-level type globally visible. For
aggregate-local entity parts (`entity X { … }` only resolvable inside its
owning `aggregate`), you need a custom `ScopeProvider` that returns an
empty scope for cross-aggregate part references.

---

## 2. Handlebars gotchas

### Triple-stash collisions (`}}}`)
Handlebars sees `}}}` as the close of a triple-stash unescaped expression
`{{{ … }}}`. So:

```hbs
{{#each values}}    {{this}},
{{/each}}}    ← BUG: parsed as malformed }}}
```

**Always put a newline or space between `{{/each}}` (or `{{/if}}`) and a
literal `}`.** Cost me roughly an hour of debug.

### HTML escaping bites the .NET backend hardest
`{{csType type}}` with output `List<Order>` becomes `List&lt;Order&gt;` in
the generated `.cs` file because Handlebars HTML-escapes by default. Fix:
either return `new hb.SafeString(...)` from the helper, or use triple-stash
`{{{csType type}}}` at every call site. **The TS backend mostly dodges
this because TS types don't use angle brackets**, but `Promise<T>`,
`List<T>`, `IRequestHandler<T, U>` etc. on the .NET side are all hit.

### Helper composition with `(concat ...)`
Handlebars sub-expressions need explicit helper registration:

```ts
hb.registerHelper("concat", (...args) => args.slice(0, -1).join(""));
```

The last argument is the helper options object; slice it off.

### Block helpers and context
Inside `{{#each items}}`, `this` is the current item, `@last`/`@first`
exist, and `../foo` reaches the parent context. `{{#with obj}}` rebinds
context but obscures lookups; prefer property access.

---

## 3. IR design (the key win)

### Resolve everything before the templating layer
The first cut had string-builders walking the Langium AST directly. They
re-implemented name resolution per backend, which doubled bugs and
diverged. Introducing `Loom IR` with fully-resolved expressions
(`refKind: "this-prop" | "enum-value" | "helper-fn" | …`,
`callKind: "function" | "value-object-ctor" | …`) made the per-backend
expression renderers a 100-line pure function each.

### Carry receiver types on member access
`{ kind: "member", receiver, member, receiverType, memberType }` lets the
backend choose `.length` vs `.Count` vs `.length()` without re-running
type inference. **If you don't carry it, every backend will reinvent the
type system.**

### Distinguish ref kinds for property access
`this-prop` (entity, private `_field`) vs `this-vo-prop` (value object,
public `readonly field`) vs `this-derived` (computed getter) — all map
to different output. Without explicit tagging, you'll silently emit
`this._amount` against value objects that store `amount` publicly.

### Lambda parameters
Without full type inference, lambda parameter types in the IR are
approximate. That's fine because lambdas only appear inside collection-op
arguments and the *body's* type is what informs surrounding context. Don't
over-engineer this until you need polymorphic lambdas.

### Inlined vs deduplicated emit
Each backend independently reconstructs the list of public operations,
required fields, etc. Keeping these as small projection helpers in the
backend (rather than baking them into IR) keeps the IR truly neutral.

---

## 4. Code-gen architecture

### Templates handle structure, code handles expressions
A template like ENTITY_TPL is fine for class shape and member layout.
Recursive-tree code (expressions, statements) renders far better in pure
TypeScript via a `renderExpr(e: ExprIR): string` function exposed as a
Handlebars helper. **Never try to recurse expressions in `.hbs`.**

### Naming conventions live in helpers
`pascal`, `camel`, `snake`, `plural` — register them all, use them
consistently. Hard-coding casing in templates produces drift.

### One template per output file, mostly
Avoid mega-templates that try to render the whole project. One template
per logical unit (entity, repository, controller, etc.) plus a small
orchestrator function in the backend's `index.ts` is clearest.

### `as never` is technical debt, mark it
Quick way to silence TS / C# strictness on emitted boundaries (e.g., body
parsers casting to branded types). **Track every `as never`, fix
incrementally.**

---

## 5. Validation strategy

### Validate semantically, not syntactically
The grammar says `precondition Expression` — but the validator must also
check the expression is `bool`. Without that check, the user gets type
errors at codegen time (or worse, runtime). Always pair grammar with
type-system validation.

### Walk env explicitly
Build an `Env` with parameters / let-bindings / `this`-target /
aggregate-context, and pass it through. Don't rely on Langium's scope
provider for expression-time symbol resolution — scopes are designed for
cross-references, not type checking.

### CST text gives you free error messages
For invariants and preconditions, embed the original source text in the
generated `throw new DomainError("Invariant violated: lines.count > 0")`.
The CST is on every node:

```ts
const cst = (expr as { $cstNode?: { text?: string } }).$cstNode;
return cst?.text ?? "<expr>";
```

---

## 6. Workflow that worked

1. Get the grammar parsing first.
2. Add a single example `.ddd` and validate it parses and validates.
3. Build the IR types and lowering.
4. Build the smallest possible backend that produces *one* file (e.g.,
   the entity class) end-to-end. **Compile that output with `tsc
   --noEmit`** before moving on.
5. Then add repositories, schema, routes, etc. one at a time.

Skipping step 4 produces unverifiable backends. Type-checking the
generated output is the real test.

---

## 7. DDD-specific design decisions

- **Implicit identity (`Id<X>`)**: declaring `aggregate Order` is enough;
  no `id OrderId` line. Massively cuts boilerplate at the cost of one
  more thing (the implicit `id` field) the user must remember.
- **Entities only as parts**: bakes the DDD invariant into the grammar.
- **`function` (pure) + `private operation` (mutating)** : two helpers,
  cleanly separated. Same idiom emerges in hand-written code; codifying
  it pays off.
- **First-class `precondition`**: better than encoding via `if (!cond)
  throw`. Keeps domain intent visible.
- **`emit` as a statement, events drained by repository**: standard
  outbox pattern, easy to plug into.

---

## 8. Things to skip / not bother with

- Trying to reuse Langium's expression grammar — it's not generic enough.
- Generating a full migration tool — defer to Drizzle Kit / EF migrations.
- Templating *every* small file (csproj, package.json) via Handlebars —
  inline string literals are fine for one-shots.
- Compiling generated .NET in CI without dotnet SDK — gracefully skip with
  a clear log message; don't fake-pass the test.

---

## 9. Second-iteration findings (after the first end-to-end pass)

### Handlebars HTML escaping bites the .NET backend hardest
Generic types like `List<T>` and `Task<T>` get HTML-encoded into
`List&lt;T&gt;` if helpers return raw strings.  **Wrap every helper that
emits source-shaped strings in `new hb.SafeString(...)`**, especially
type renderers.  TypeScript dodges this because TS types rarely use
angle brackets, but C# uses them everywhere.

### Namespace-vs-class collisions
A namespace like `Sales.Domain.Order` next to a class `Order` in the
same scope confuses C# resolution at use sites.  Rename per-aggregate
namespaces to the **plural** form (`Sales.Domain.Orders`) to avoid the
clash without changing the grammar.

### Positional records skip invariant enforcement
`record Money(decimal Amount, string Currency)` doesn't run a body block
on `new Money(...)` — only on `new Money()`.  Use **explicit
constructors with init-only properties** for value objects so invariants
fire on every construction.

### Mediator (not MediatR) for new .NET projects
MediatR went paid in late 2024.  Use
[Mediator](https://github.com/martinothamar/Mediator) (MIT,
source-generated): same `IRequest<T>` + handlers, plus semantic
`ICommand` / `IQuery` aliases.  Note the handler signature returns
`ValueTask<T>` and void commands return `ValueTask<Unit>` (return
`Unit.Value` from the body).

### Request / Response DTOs at the controller boundary
Controllers shouldn't bind to internal Command records — that leaks
`Id<X>` record-structs and value-object types into the wire format and
forces consumers to know domain shape.  Generate **flat primitive DTOs**
(`CreateOrderRequest`, `OrderResponse`) and have controllers map them
to commands and queries before dispatching via Mediator.  Query
handlers then project domain → Response inline.

### Repository correctness has two layers
- **TS / Drizzle** is hand-rolled: project domain → row, diff-sync
  contained children (insert/update/delete by id), wrap in transaction,
  dispatch drained events.  Templates can't express this cleanly — emit
  it as code-built strings instead.
- **.NET / EF Core** rides on the change tracker: `GetByIdAsync` returns
  the *tracked* aggregate (with `OwnsMany` auto-included), `SaveAsync`
  attaches detached aggregates and lets EF observe mutations on tracked
  ones.  Far less generation needed.

### Drizzle value-object inlining
Express a `unitPrice: Money` field as `unit_price_amount` and
`unit_price_currency` columns.  Schema-time code expansion + matching
projections in the repository make this transparent to the rest of the
generator.

### Code-built vs. template
**Templates win for class shape, code wins for projection logic.**  The
TS repository's `findById` / `save` / find-query bodies have too much
per-aggregate variance to express in Handlebars.  Build them in plain
TypeScript and let templates handle the surrounding structural file.

### Find-query DSL: keep it expressive
Adding a single `where Expression` clause to `find` declarations lets
users write real predicates (`where this.customerId == forCustomer &&
this.status == Open`) that lower cleanly to LINQ in .NET.  Drizzle
doesn't support arbitrary lambda predicates compiled to SQL — emit a
TODO comment with the rendered TS expression so the user can hand-port
to Drizzle operators.

### Validator type system needs aggregate properties in scope
For invariants like `transactions.all(t => t.amount.amount > 0)` to
type-check, the validator's `Env` must populate the aggregate's
properties / derived / contains as locally-resolvable bindings.
Without that, name resolution returns `unknown` for every property
access, and the type checker can't catch real mistakes.

### Lambda type inference is contextual
Lambda parameter types only need to be known when the lambda is the
argument to a collection op.  Wire receiver-element type into the
lambda's local env at type-check time (not in the IR per se), and the
body validates correctly.

### Test DSL: `expectThrows <expression>`, not `<statement>`
Statements like `:=`, `+=`, `emit` only make sense inside an aggregate
operation, not in free-standing tests.  Use `expectThrows <expression>`
so users naturally write `expectThrows Money(-1, "USD")` and the
expression renderer (`new Money(-1, "USD")`) just works.

### Templates split → small, single-purpose modules
Once the scope crossed ~500 lines per template-file, lookups and edits
got painful.  Splitting into per-construct modules
(`templates/ids.tpl.ts`, `templates/value-objects.tpl.ts`, …) and
re-exporting from a thin barrel made the layout explorable again
without touching call sites.  Same Handlebars instance lives in a
shared `hb.ts` so helpers register exactly once.

### CLI watch mode: trivial and worth it
`fs.watch` + 100ms debounce + re-run the generator.  Roughly 20 lines
of code, immediate quality-of-life win during development.

### Always type-check the generated output
Every change to the generators should run `tsc --noEmit` against a
freshly-emitted project.  A single wrong helper or missing import is
invisible until you compile what you produced.

---

## 10. Third-iteration findings (system mode + React + Playwright)

### Per-deployable databases — the EnsureCreated trap
Two .NET deployables sharing one Postgres database silently break.
EF Core's `EnsureCreated` is all-or-nothing per database: whichever
backend boots first creates only its tables; the second sees existing
tables and skips ALL creation, leaving its own tables missing.  Fix
is per-deployable databases via a `db-init/00-create-databases.sql`
init script.  Generic lesson: any "create-if-not-exists" tool that
checks at the database level instead of the table level needs DB
isolation when multiple consumers share infrastructure.

### Wire-shape symmetry pays off only if you enforce it
Both backends had full DTOs in their respective Request/Response
records, but Hono's response handlers used to just return `{ id }`,
not the full projection.  The OpenAPI cross-check passed because it
only diffed `(method, path)` — the divergent shapes were invisible.
Lesson: a contract test is only as useful as the dimensions it
covers.  Now every per-aggregate response goes through a shared wire-
shape derivation (TS via `repository.toWire`, .NET via
`<Agg>Mapper.ToDto`), and content-shape parity is in scope for the
diff.

### The framework-native OpenAPI choice
Both backends emit OpenAPI via their own framework's introspection
(Swashbuckle on .NET, `@hono/zod-openapi` on Hono) rather than from
the IR.  This means the spec describes what's actually served — a
typo in a controller, a status code drift, a schema rename surfaces
in the diff.  An IR-derived spec would always agree with itself even
when the running code disagreed.

### Datetime on the wire — pick one shape and own it
Naive ISO strings (`"2024-01-01T00:00"`) sent to .NET parse as
`DateTimeKind.Unspecified`, and Npgsql refuses to write them to
`timestamp with time zone`.  Three sane options: always send Z-
suffixed UTC; receive as `string` and parse with `AssumeUniversal |
AdjustToUniversal`; or use `DateTimeOffset` everywhere.  We picked
the second — wire is `string` on both backends (matches Hono
naturally) and handlers normalize to UTC on the way in.  Responses
emit ISO via `ToUniversalTime().ToString("o")`.  Generic lesson:
when two backends serve the same shape, harmonize the wire even if
it costs a parse on the receiving side — the alternative is silent
divergence.

### Mantine Form + Mantine Select: spread doesn't work
`<Select {...form.getInputProps("status")} />` looks idiomatic but
silently breaks: `getInputProps` returns an event-based `onChange`
(`(e) => …`), Mantine `<Select>` calls `onChange(value, option)`,
and the form never sees the change.  Solution: explicit binding
(`value={form.values.status} onChange={(v) => form.setFieldValue(...)}`).
Also `allowDeselect={false}` so the page-object's "click selected
option" doesn't toggle the value back to null.

### Page-object idiom: typed input + chained returns
Auto-generated page objects work best when:
1. `fill(input: Partial<<Op>Request>)` accepts the same shape the
   API hooks consume — same Zod schema, same TS type.
2. Methods return `this` (or the next page) so tests chain top-down.
3. Selectors come from data-testids the generator sprinkles, NOT
   text matchers — text changes break tests; testids are stable.
4. The `submit()` method waits for the next page's testid to appear
   rather than `waitForURL(/regex/)` — the URL pattern often matches
   the source page too (e.g., `/orders/new` matches
   `/orders/[^/]+`).

### Don't switch to native HTML to make tests easier
First instinct when Mantine `<Select>` was hard to drive from
Playwright: swap to `<NativeSelect>` (which Playwright's
`selectOption()` handles trivially).  Right answer per the user:
make the page object handle the idiomatic component instead.  The
generator's job is to emit Mantine; the page-object's job is to
know how to drive Mantine.

### Elegant escape hatches over regex Dockerfile-rewriting
First version of the proxy-CA injection ran a regex over each
Dockerfile after generation, splicing in `COPY *.crt /usr/local/...`
lines.  Second version puts `COPY certs/` + `update-ca-certificates`
into the generated Dockerfile unconditionally and emits an empty
`certs/.gitkeep` per deployable.  Sandboxed envs drop their CAs
into `certs/`; unsandboxed envs ignore the empty dir.  Generic
lesson: generation-time invariants beat post-generation rewrites.

---

## 13. v2 architecture lessons

The v2 refactor (six landed phases) took roughly the structure
v1 *should* have started from.  Honest retrospective on what
stuck, what we'd do differently next time, and what we
deliberately left undone.

### What stuck

**Read-only IR + a separate enrichment pass (Phase 1).**  The
single biggest leverage move.  v1 had two hidden side-effects in
`lower.ts` (auto-`findAll` injection, react `moduleNames` copy)
that downstream code learned to expect by reading the test
suite, not the lowering signature.  Pulling them into a pure
`enrichLoomModel(loom)` made the IR contract honest: lowering
gives you a faithful AST projection; enrichment computes
derivations; consumers consume.  Every later phase rested on
this.

**Wire-shape as a first-class IR field.**  v1 had a shared
`wireFieldsForAggregate(agg, ctx)` walk called by four backends.
Adding a fifth meant remembering to call it.  Promoting it to
`agg.wireShape` populated by the enrichment pass made the field
*type-required* downstream — forgetting it is a TypeScript
error, not a silent drift.  Same trick works for any cross-
cutting derivation that more than one backend needs.

**Public surface contract for backends, internals stay
idiomatic (Phase 3).**  The original Phase 3 plan called for a
unified `Platform` interface with `emitDomain`/`emitWire`/etc.
The user vetoed: idiomatic emission is the *whole point*.  Hono
emits builders.  .NET emits CQRS handlers + EF configurations.
React emits procedural JSX.  These shapes drift in step with
their target ecosystems on purpose.  The right abstraction was
*not* internal homogenisation — it was a tiny `PlatformSurface`
contract (`emitProject`, `composeService`, `needsDb`,
`defaultPort`) that the system orchestrator dispatches over.
General lesson: when planning a refactor, ask "is this drift
accidental or principled?" before flattening it.

**Procedural emission everywhere (Phase 4).**  Dropping
Handlebars was less about runtime cost and more about *typed
data flow*.  Every `{{var}}` in a template was implicitly an
`any` cast — type-correct only by convention.  Procedural
builders mean the type checker validates the data contract
between the IR and the rendered string.  ~1700 lines of
templates → procedural code; output byte-identical across all
examples; zero type errors masked by template substitution.

**JSON wire-spec artifact (Phase 5).**  `<outdir>/.loom/wire-
spec.json` turned out to be the diff-friendly artifact users
actually want.  `git diff` between regens shows wire-contract
changes at a glance — no need to boot backends, run a contract
check, or eyeball generated code.

**IR-level validation before generation (Phases 2 + 6).**
v1 surfaced `api.unknownX.create()` as a thrown Error from the
e2e renderer at generate-time, and TODO comments in generated
SQL when a `where` clause couldn't lower.  Both pulled forward
to `validateLoomModel`: now you get a structured diagnostic
with `severity`, `message`, and `source` *before* generation
runs.  General pattern: anything that can be a parse-time error
should be a parse-time error; anything that can be an IR-level
diagnostic should be an IR-level diagnostic; only true bugs
should ever throw.

### What we'd do differently next time

**Start with snapshot tests, not string-match unit tests.**
Phase 4's template migration would have been *much* easier if
every backend had a snapshot test from day one.  String-match
asserts pass on coincidence; snapshot tests pass on identity.
Migrating ~1700 lines of templates to procedural builders meant
chasing dozens of subtle whitespace differences against `diff
-r` against a captured baseline.  A snapshot suite would have
turned that into `npm run test:update-snapshots` + review.

**Don't mix grammar split + IR validation in one phase.**  The
original Phase 6 plan had us splitting `Expression` into
`QueryExpr` + `DomainExpr` in the grammar.  We landed only the
IR-validator half: same end-result for users (early diagnostic
on non-queryable `where` clauses, no TODO comments in generated
code), without the breaking grammar change or the parser
regeneration churn.  When validation can do the job, prefer
validation over grammar.  Grammar changes are a tax on every
existing `.ddd` source; validation changes are localised.

**Plan refactors phase-by-phase with verification gates from
the start.**  Each of the six phases was independently shippable
with `npm test` + `LOOM_TS_BUILD=1` + `LOOM_E2E=1` all green.
That discipline meant a mistake in any phase only invalidated
*that* phase, not later work.  Worth the up-front cost of
defining the gates before starting.

**Capture a baseline before every refactor.**  `git stash &&
node bin/cli.js generate <…> -o /tmp/baseline-$phase && git
stash pop` was the most useful single command of the refactor.
Pre-migration baselines + `diff -r` after each change is the
fastest possible signal that a change is observably equivalent
or not.

### What we left for v3

- **Subquery support in `where` clauses.**  v2 rejects
  `where this.lines.count > 0` with a clear error.  v3 could
  lift the restriction by emitting `EXISTS (SELECT ... FROM
  child WHERE parent_id = …)` from the Drizzle backend.  Not
  a small change — needs the IR walker, the validator, and the
  Drizzle lowerer all to agree on which queryable shapes are
  legal.
- **More platforms.**  The `PlatformSurface` contract makes
  Spring Boot / FastAPI / Angular tractable, but each is its
  own real project.  Out of scope for v2.
- **Auth / authz, rate limiting, tracing.**  These belong in
  `.loomignore`-pinned customisations, not in the core
  generator.  The generator's job is to scaffold; per-app
  cross-cutting concerns are the consumer's job.
- **Snapshot tests across the full output tree.**  We landed a
  snapshot test for the wire-spec artifact only (Phase 5
  closed the highest-leverage piece).  A future pass could add
  full-output snapshots for sales / banking / inventory / acme
  × every platform, replacing most of the current string-match
  generator tests.

## Traceability artifacts (Slice 12)

- **Keyword stealing is the dominant constraint.**  The first cut made
  the requirement props (`type`, `status`, `priority`) and the enum-like
  values (`UserStory`, `Draft`, …) grammar keywords.  That stole
  `status` (used as a field name in scores of example aggregates) and
  enum values like `Draft` — 152 tests went red instantly.  Fix: a
  permissive prop-bag (`RequirementProp: name=RequirementPropKey ':'
  value=Expression`) with semantic validation in `ddd-validator.ts`,
  exactly the `ThemeProp` / `PageMenuMeta` pattern.  `RequirementPropKey`
  admits the *already-existing* keywords (`type`, `title`) explicitly and
  lets everything else through `ID` — so no new keyword is minted.
- **Ticket ids need a terminal, not a datatype rule.**  `US-001` cannot
  be `ID ('-' INT)*`: `INT returns number`, so the datatype rule
  reassembles `US-001` as `US-1` (leading zeros lost; `US-001` and
  `US-01` collide).  A dedicated `TRACE_ID` terminal preserves the
  literal text.  Shape it to *require* a trailing `-<digits>* group so
  it never captures `price-discount` (ends in letters → stays
  arithmetic); the only residual collision is `name-<digits>` written
  with no spaces, which Loom's house style never does.  Declare it
  before `ID` for longest-match priority.
- **Qualified-name cross-references = scope work, not grammar work.**
  `entitles`/`covers` use `[Targetable:QualifiedName]`.  Resolution
  comes from exporting every `Targetable` under its dotted name in
  `DddScopeComputation.computeExports` (`qualifiedNameOf` walks
  containers up to, but excluding, the enclosing `system`).  The default
  scope provider then resolves the dotted reference text against those
  exports — no custom `getScope` branch needed.  Lowering reads the
  `kind` off the resolved node's `$type` and the qualified name off
  `ref.$refText`, so backends never re-resolve.
- **The docs are a derived view, like the Mermaid diagrams.**  They live
  in `src/system/traceability.ts`, are emitted once at the output root
  (model-global), and read only the precomputed `TraceabilityIR` from
  `enrichLoomModel` — never recomputing coverage.
